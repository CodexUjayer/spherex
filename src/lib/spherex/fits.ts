/**
 * FITS reader for SPHEREx level-2 cutout MEFs.
 *
 * A SPHEREx cutout contains (IRSA cutout service / SPHEREx archive docs):
 *   HDU1 IMAGE    calibrated surface brightness (MJy/sr), float32
 *   HDU2 FLAGS    per-pixel status bitmask (int32)
 *   HDU3 VARIANCE per-pixel variance (MJy/sr)^2, float32
 *   HDU4 ZODI     modeled zodiacal light background (MJy/sr)
 *   HDU5 PSF      PSF cube (~5 MB) — skipped by the streaming reader
 *
 * The streaming reader keeps the original early-abort optimisation but now
 * reads through the VARIANCE HDU (~500 KB instead of ~200 KB) so masking and
 * noise weighting are possible. It retries transient IRSA failures
 * (503 "Server busy", 502/504, connection resets) with backoff — the service
 * rate-limits bursts.
 *
 * FITS facts: 2880-byte logical records; 80-char cards (36 per record); END
 * terminates a header; data big-endian, padded to 2880; CRPIX etc. are kept
 * in the parent-tile frame (negative CRPIX on cutouts is normal and valid).
 */

import type { ColormapName } from "./colormaps";

const BLOCK = 2880;

/* ---------------- canonical SPHEREx L2 FLAGS bit table ----------------
 * SPHEREx Explanatory Supplement (SSDC-DP-017), Table 16. The file header
 * may override individual positions via MP_<NAME> / HIERARCH P_<NAME>
 * keywords (IPAC Firefly convention) — those take precedence when present. */
export const FLAG_BITS: Record<string, number> = {
  TRANSIENT: 0,
  OVERFLOW: 1,
  SUR_ERROR: 2,
  NONFUNC: 6,
  DICHROIC: 7,
  MISSING_DATA: 9,
  HOT: 10,
  COLD: 11,
  FULLSAMPLE: 12,
  PHANMISS: 14,
  NONLINEAR: 15,
  PERSIST: 17,
  OUTLIER: 19,
  CROSSTALK: 20,
  SOURCE: 21,
  GHOST: 22,
  GHOST_FPA: 23,
  GHOST_EXT: 24,
  STREAK: 25,
  BLOOM: 26,
  SNOWBALL: 27,
  HALO: 28,
  SATELLITE_HALO: 29,
};

/** Flags the official IRSA mosaic tool treats as bad (NaN) — Expsupp §3.4.3. */
export const BAD_FLAG_NAMES = [
  "TRANSIENT", "SUR_ERROR", "NONFUNC", "DICHROIC", "MISSING_DATA",
  "HOT", "COLD", "PHANMISS", "NONLINEAR", "PERSIST", "CROSSTALK",
  "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK", "BLOOM", "SNOWBALL",
  "HALO", "SATELLITE_HALO",
] as const;

/** Additional flags masked for difference imaging (more conservative than
 *  the mosaic policy, because saturation residuals and single-epoch outliers
 *  are exactly the artifacts that mimic transients in a two-epoch difference). */
export const DIFF_EXTRA_FLAG_NAMES = ["OVERFLOW", "OUTLIER"] as const;

export function flagMaskFromNames(
  header: Record<string, string>,
  names: readonly string[],
): number {
  let mask = 0;
  for (const name of names) {
    let bit: number | undefined;
    const mp = header[`MP_${name}`] ?? header[name];
    if (mp !== undefined) {
      const v = parseInt(mp, 10);
      if (Number.isFinite(v)) bit = v;
    }
    if (bit === undefined) bit = FLAG_BITS[name];
    if (bit !== undefined && bit >= 0 && bit < 31) mask |= 1 << bit;
  }
  return mask;
}

/* ------------------------------- parsing ------------------------------- */

export interface FitsRaster {
  data: Float32Array | Int32Array;
}

export interface FitsData {
  /** IMAGE extension, row-major, NaN = no data. */
  image: Float32Array;
  width: number;
  height: number;
  /** FLAGS extension (int32) or null. */
  flags: Int32Array | null;
  /** VARIANCE extension or null. */
  variance: Float32Array | null;
  /** ZODI extension or null. */
  zodi: Float32Array | null;
  mjdObs: number | null;
  mjdBeg: number | null;
  mjdEnd: number | null;
  mjdAvg: number | null;
  dateObs: string | null;
  xposure: number | null;
  psfFwhm: number | null;
  obsid: string | null;
  detector: number | null;
  bunit: string | null;
  /** header key/values from the IMAGE HDU (CRVAL/CRPIX/CD/PC/CDELT/SIP/MP_*) */
  header: Record<string, string>;
}

/** Parse one FITS header starting at `start`. HIERARCH cards are folded in
 *  using their long keyword (e.g. HIERARCH P_SNOWBALL = 27 -> P_SNOWBALL). */
function parseHeader(
  buf: Buffer,
  start: number,
): { kv: Record<string, string>; after: number; ended: boolean } {
  const kv: Record<string, string> = {};
  let off = start;
  let ended = false;
  while (off + BLOCK <= buf.length && !ended) {
    const blk = buf.toString("ascii", off, off + BLOCK);
    for (let i = 0; i < 36; i++) {
      const card = blk.substring(i * 80, (i + 1) * 80);
      const kw = card.substring(0, 8).trim();
      if (kw === "END") {
        ended = true;
        break;
      }
      if (kw === "HIERARCH") {
        // e.g. "HIERARCH P_SNOWBALL = 27 / comment"
        const rest = card.substring(9);
        const eq = rest.indexOf("=");
        if (eq > 0) {
          const longKw = rest.substring(0, eq).trim();
          let v = rest.substring(eq + 1).split("/")[0].trim();
          if (v.startsWith("'")) v = v.replace(/^'/, "").replace(/'$/, "").trim();
          if (longKw) kv[longKw] = v;
        }
        continue;
      }
      if (kw === "" || kw === "COMMENT" || kw === "HISTORY" || kw === "CONTINUE")
        continue;
      let vp: string;
      const body = card.substring(10);
      if (body.startsWith("'")) {
        // quoted string value: take content between the quotes (a '/' inside
        // the string is NOT a comment separator — e.g. BUNIT = 'MJy / sr')
        const end = body.indexOf("'", 1);
        vp = end > 0 ? body.substring(1, end).trim() : body.replace(/'/g, "").split("/")[0].trim();
      } else {
        vp = body.split("/")[0].trim();
      }
      kv[kw] = vp;
    }
    off += BLOCK;
  }
  return { kv, after: off, ended };
}

/** Compute the padded data size (bytes) for a header's NAXIS/BITPIX. */
function dataSize(kv: Record<string, string>): number {
  const naxis = parseInt(kv.NAXIS ?? "0", 10);
  if (!naxis) return 0;
  const bitpix = Math.abs(parseInt(kv.BITPIX ?? "8", 10));
  let n = 1;
  for (let i = 1; i <= naxis; i++) n *= parseInt(kv[`NAXIS${i}`] ?? "1", 10);
  const bytes = (n * bitpix) / 8;
  return Math.ceil(bytes / BLOCK) * BLOCK;
}

interface HduInfo {
  kv: Record<string, string>;
  dataOff: number;
  dataEnd: number; // dataOff + padded data size
}

function readHduData(
  buf: Buffer,
  hdu: HduInfo,
  kind: "f32" | "f64" | "i32" | "i16" | "u8",
): Float32Array | Int32Array | null {
  const n1 = parseInt(hdu.kv.NAXIS1 ?? "0", 10);
  const n2 = parseInt(hdu.kv.NAXIS2 ?? "0", 10);
  const bitpix = parseInt(hdu.kv.BITPIX ?? "0", 10);
  if (!n1 || !n2) return null;
  const n = n1 * n2;
  const off = hdu.dataOff;
  if (off + (n * Math.abs(bitpix)) / 8 > buf.length) return null;
  if (kind === "i32") {
    if (bitpix !== 32) return null;
    const arr = new Int32Array(n);
    for (let i = 0; i < n; i++) arr[i] = buf.readInt32BE(off + i * 4);
    return arr;
  }
  const arr = new Float32Array(n);
  if (bitpix === -32 && kind === "f32") {
    for (let i = 0; i < n; i++) arr[i] = buf.readFloatBE(off + i * 4);
  } else if (bitpix === -64 && kind === "f64") {
    for (let i = 0; i < n; i++) arr[i] = buf.readDoubleBE(off + i * 8);
  } else if (bitpix === 16 && kind === "i16") {
    for (let i = 0; i < n; i++) arr[i] = buf.readInt16BE(off + i * 2);
  } else if (bitpix === 8 && kind === "u8") {
    for (let i = 0; i < n; i++) arr[i] = buf.readUInt8(off + i);
  } else {
    return null;
  }
  return arr;
}

/** Walk the HDU chain as far as the buffer allows; return named HDUs. */
function walkHdus(buf: Buffer): { primary: HduInfo | null; byName: Map<string, HduInfo>; nextUnknownOff: number } {
  const byName = new Map<string, HduInfo>();
  let off = 0;
  let primary: HduInfo | null = null;
  let guard = 0;
  while (off + BLOCK <= buf.length && guard++ < 64) {
    const h = parseHeader(buf, off);
    if (!h.ended) break; // truncated header — wait for more / give up
    const info: HduInfo = { kv: h.kv, dataOff: h.after, dataEnd: h.after + dataSize(h.kv) };
    if (off === 0) primary = info;
    const ext = (h.kv.EXTNAME ?? "").trim().toUpperCase();
    if (ext) byName.set(ext, info);
    if (info.dataEnd > buf.length) break; // data not fully buffered yet
    off = info.dataEnd;
  }
  return { primary, byName, nextUnknownOff: off };
}

/* ------------------------------ streaming ------------------------------ */

const RETRY_STATUS = new Set([502, 503, 504, 429]);
export const RETRY_DELAYS_MS = [1500, 4000, 9000, 16000];

export class HttpRetryError extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

async function fetchWithRetry(
  url: string,
  timeoutMs: number,
  retryDelays: number[] = RETRY_DELAYS_MS,
): Promise<Response> {
  const attempts = retryDelays.length + 1;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.ok) return res;
      if (RETRY_STATUS.has(res.status) && i < attempts - 1) {
        await sleep(retryDelays[i] ?? 15000);
        continue;
      }
      throw new HttpRetryError(`IRSA returned HTTP ${res.status}`, res.status);
    } catch (e) {
      if (e instanceof HttpRetryError) throw e;
      lastErr = e;
      if (i < attempts - 1) {
        await sleep(retryDelays[i] ?? 15000);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("IRSA request failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Stream a SPHEREx cutout from IRSA, reading through the VARIANCE HDU and
 *  aborting before the ~5 MB PSF HDU. Retries transient IRSA failures
 *  (503 "Server busy" under burst load) with backoff. */
export async function streamCutout(
  cutoutUrl: string,
  timeoutMs = 60000,
  retryDelays: number[] = RETRY_DELAYS_MS,
): Promise<Buffer> {
  const res = await fetchWithRetry(cutoutUrl, timeoutMs, retryDelays);
  if (!res.body) throw new Error("IRSA returned no body");
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let needed: number | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const b = Buffer.from(value);
      chunks.push(b);
      total += b.length;
      if (needed === null && total >= 60000) {
        const buf = Buffer.concat(chunks);
        const { byName } = walkHdus(buf);
        const image = byName.get("IMAGE");
        if (image) {
          const variance = byName.get("VARIANCE");
          const flags = byName.get("FLAGS");
          const zodi = byName.get("ZODI");
          const psf = byName.get("PSF");
          // Target: data through VARIANCE (FLAG-only layouts stop at FLAGS;
          // image-only layouts stop at the next HDU / PSF start). While the
          // layout is not yet fully buffered, keep streaming (needed stays
          // null) — never abort at the IMAGE data alone.
          if (variance) {
            needed = variance.dataEnd; // header known → dataEnd is known
          } else if (flags && flags.dataEnd <= buf.length && (psf || zodi)) {
            needed = flags.dataEnd; // no VARIANCE in this file
          } else if (psf && psf.dataOff <= buf.length) {
            needed = psf.dataOff; // no FLAGS/VARIANCE — stop before PSF
          } else if (total > 2_000_000) {
            needed = image.dataEnd; // layout unrecognized — safety stop
          }
        } else if (total > 2_000_000) {
          needed = total; // no IMAGE HDU found — safety stop
        }
      }
      if (needed !== null && total >= needed) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/* ------------------------------ accessors ------------------------------ */

function numKV(kv: Record<string, string>, key: string): number | null {
  const v = kv[key];
  if (v === undefined) return null;
  const f = parseFloat(v.replace(/[Dd]/, "E"));
  return Number.isFinite(f) ? f : null;
}

/** Read the SPHEREx IMAGE (+ FLAGS/VARIANCE/ZODI) extensions from a
 *  (possibly partial, PSF-truncated) FITS buffer. */
export function readSpherexFits(buf: Buffer): FitsData {
  const { byName } = walkHdus(buf);
  const image = byName.get("IMAGE");
  if (!image) throw new Error("No IMAGE extension found in SPHEREx FITS.");
  const n1 = parseInt(image.kv.NAXIS1 ?? "0", 10);
  const n2 = parseInt(image.kv.NAXIS2 ?? "0", 10);
  if (!n1 || !n2) throw new Error("IMAGE extension has no NAXIS1/NAXIS2.");
  const img = readHduData(buf, image, "f32");
  if (!img) {
    // tolerate f64/i16/u8 images
    const alt =
      (readHduData(buf, image, "f64") ?? readHduData(buf, image, "i16") ??
        readHduData(buf, image, "u8")) as Float32Array | null;
    if (!alt) throw new Error("Unsupported IMAGE BITPIX or truncated data.");
    return finish(alt as Float32Array, n1, n2, image.kv, byName, buf);
  }
  return finish(img as Float32Array, n1, n2, image.kv, byName, buf);

  function finish(
    imageData: Float32Array,
    w: number,
    h: number,
    kv: Record<string, string>,
    by: Map<string, HduInfo>,
    b: Buffer,
  ): FitsData {
    const flagsHdu = by.get("FLAGS");
    const varHdu = by.get("VARIANCE");
    const zodiHdu = by.get("ZODI");
    const flags = flagsHdu ? (readHduData(b, flagsHdu, "i32") as Int32Array | null) : null;
    const variance = varHdu ? (readHduData(b, varHdu, "f32") as Float32Array | null) : null;
    const zodi = zodiHdu ? (readHduData(b, zodiHdu, "f32") as Float32Array | null) : null;
    return {
      image: imageData,
      width: w,
      height: h,
      flags: flags && flags.length === w * h ? flags : null,
      variance: variance && variance.length === w * h ? variance : null,
      zodi: zodi && zodi.length === w * h ? zodi : null,
      mjdObs: numKV(kv, "MJD-OBS") ?? numKV(kv, "MJD-AVG"),
      mjdBeg: numKV(kv, "MJD-BEG"),
      mjdEnd: numKV(kv, "MJD-END"),
      mjdAvg: numKV(kv, "MJD-AVG"),
      dateObs: kv.DATE_OBS ?? kv["DATE-OBS"] ?? null,
      xposure: numKV(kv, "XPOSURE") ?? numKV(kv, "EXPTIME"),
      psfFwhm: numKV(kv, "PSF_FWHM"),
      obsid: kv.OBSID ?? null,
      detector: numKV(kv, "DETECTOR"),
      bunit: kv.BUNIT ?? null,
      header: kv,
    };
  }
}

/** Convenience: build a cutout URL from the IRSA access URL + center/size. */
export function cutoutUrl(accessUrl: string, ra: number, dec: number, sizeDeg: number): string {
  const sep = accessUrl.includes("?") ? "&" : "?";
  return `${accessUrl}${sep}center=${ra},${dec}&size=${sizeDeg}`;
}

export type { ColormapName };
