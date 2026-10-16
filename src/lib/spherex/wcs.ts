/**
 * World Coordinate System (WCS) parser and transforms for SPHEREx FITS images.
 *
 * Supports the representations actually produced by the SPHEREx pipeline
 * (and the common general cases):
 *   - CD matrix, or PC matrix + CDELT (SPHEREx uses PC with CDELT = 1.0 and
 *     the real scale inside PC — a previous revision misread this as a
 *     "dummy" WCS and ignored it entirely)
 *   - CRPIX in the PARENT image frame: cutouts keep the parent WCS, so CRPIX
 *     is frequently negative or larger than the cutout. That is valid and is
 *     handled by the standard (pixel_1based − CRPIX) formulation.
 *   - TAN (gnomonic) projection with optional SIP polynomial distortion
 *     (forward A/B and inverse AP/BP), CAR and SIN projections.
 *   - RADESYS / EQUINOX are recorded; ICRS is assumed (SPHEREx L2 astrometry
 *     is tied to a proper-motion-corrected Gaia DR3 reference via the
 *     pipeline's fine astrometry, Explanatory Supplement §3.2.8).
 *
 * Conventions (validated numerically against real SPHEREx cutouts):
 *   - pixel coordinates are 0-based (x = column, y = row); FITS CRPIX is
 *     1-based, so u = (x + 1) − CRPIX1.
 *   - intermediate world coords ξ,η are degrees EAST/NORTH on the tangent
 *     plane (ξ = CD11·u' + CD12·v', η = CD21·u' + CD22·v').
 *   - SIP forward:  u' = u + A(u,v); v' = v + B(u,v)   (evaluated at u,v)
 *   - SIP inverse:  u  = u' + AP(u',v'); v = v' + BP(u',v')
 *   - Round-trip on real cutouts agrees to < 0.003 px.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export type ProjectionKind = "TAN" | "CAR" | "SIN";

export interface Wcs {
  ctype: [string, string];
  projection: ProjectionKind;
  hasSip: boolean;
  /** CD matrix in deg/pixel (PC ⊗ CDELT when PC form is used). */
  cd: [[number, number], [number, number]];
  crpix: [number, number]; // FITS 1-based
  crval: [number, number]; // degrees
  cunit: [string, string];
  lonpole: number;
  latpole: number;
  radesys: string | null;
  equinox: number | null;
  /** SIP forward coefficients A/B keyed "p,q". */
  sipA: Map<string, number>;
  sipB: Map<string, number>;
  /** SIP inverse coefficients AP/BP keyed "p,q". */
  sipAp: Map<string, number>;
  sipBp: Map<string, number>;
}

export type WcsParseStatus =
  | { ok: true; wcs: Wcs }
  | { ok: false; reason: "missing" | "incomplete" | "unsupported-projection" | "invalid"; detail?: string };

const SUPPORTED = ["TAN", "TAN-SIP", "CAR", "CAR-SIP", "SIN", "SIN-SIP"];

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  // FITS may use 'D' exponent marker
  const f = parseFloat(v.replace(/[Dd]/, "E"));
  return Number.isFinite(f) ? f : null;
}

function parseCtype(ctype: string): { proj: string; sip: boolean } | null {
  // FITS CTYPE: axis name left-justified/padded with '-' to 4 chars, then
  // '-PROJ' (+ optional '-SIP'). E.g. "RA---TAN-SIP" (RA, 2 pad) and
  // "DEC--TAN-SIP" (DEC, 1 pad) — the hyphen count varies with name length.
  const m = ctype.trim().match(/^[A-Z]+-+([A-Z]+?)(?:-SIP)?$/);
  if (!m) return null;
  return { proj: m[1], sip: ctype.includes("-SIP") };
}

function collectSip(header: Record<string, string>, prefix: "A_" | "B_" | "AP_" | "BP_"): Map<string, number> {
  const out = new Map<string, number>();
  const re = new RegExp(`^${prefix}(\\d+)_(\\d+)$`);
  for (const [k, v] of Object.entries(header)) {
    const m = k.match(re);
    if (!m) continue;
    const c = num(v);
    if (c !== null) out.set(`${m[1]},${m[2]}`, c);
  }
  return out;
}

/** Parse a WCS from a parsed FITS header (keyword -> raw string value). */
export function parseWcs(header: Record<string, string>): WcsParseStatus {
  const ctype1 = header.CTYPE1;
  const ctype2 = header.CTYPE2;
  if (!ctype1 || !ctype2) {
    return { ok: false, reason: "missing", detail: "CTYPE1/CTYPE2 absent — no celestial WCS" };
  }
  const p1 = parseCtype(ctype1);
  const p2 = parseCtype(ctype2);
  if (!p1 || !p2) {
    return { ok: false, reason: "incomplete", detail: `unparseable CTYPE (${ctype1}, ${ctype2})` };
  }
  if (!SUPPORTED.includes(p1.proj) || !SUPPORTED.includes(p2.proj) || p1.proj !== p2.proj) {
    return { ok: false, reason: "unsupported-projection", detail: `projection ${p1.proj}/${p2.proj} not supported (supported: TAN, CAR, SIN ± SIP)` };
  }
  const crval1 = num(header.CRVAL1);
  const crval2 = num(header.CRVAL2);
  const crpix1 = num(header.CRPIX1);
  const crpix2 = num(header.CRPIX2);
  if (crval1 === null || crval2 === null || crpix1 === null || crpix2 === null) {
    return { ok: false, reason: "incomplete", detail: "CRVAL/CRPIX missing" };
  }

  // CD matrix: direct CD, or PC ⊗ CDELT, or plain CDELT (diagonal).
  const cd11 = num(header.CD1_1), cd12 = num(header.CD1_2);
  const cd21 = num(header.CD2_1), cd22 = num(header.CD2_2);
  let cd: [[number, number], [number, number]];
  if (cd11 !== null && cd22 !== null) {
    cd = [[cd11, cd12 ?? 0], [cd21 ?? 0, cd22]];
  } else {
    const pc11 = num(header.PC1_1), pc12 = num(header.PC1_2);
    const pc21 = num(header.PC2_1), pc22 = num(header.PC2_2);
    const cdelt1 = num(header.CDELT1), cdelt2 = num(header.CDELT2);
    if (pc11 !== null && pc22 !== null && cdelt1 !== null && cdelt2 !== null) {
      // CD_i_j = PC_i_j * CDELT_j
      cd = [
        [(pc11 ?? 1) * cdelt1, (pc12 ?? 0) * cdelt2],
        [(pc21 ?? 0) * cdelt1, (pc22 ?? 1) * cdelt2],
      ];
    } else if (cdelt1 !== null && cdelt2 !== null) {
      cd = [[cdelt1, 0], [0, cdelt2]];
    } else {
      return { ok: false, reason: "incomplete", detail: "no CD / PC+CDELT / CDELT matrix" };
    }
  }
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) {
    return { ok: false, reason: "invalid", detail: "singular CD matrix" };
  }

  const sipA = collectSip(header, "A_");
  const sipB = collectSip(header, "B_");
  const sipAp = collectSip(header, "AP_");
  const sipBp = collectSip(header, "BP_");
  const hasSip = (p1.sip || p2.sip || sipA.size > 0) && (sipA.size > 0 || sipAp.size > 0);

  const lonpole = num(header.LONPOLE);
  const latpole = num(header.LATPOLE);
  const radesys = (header.RADESYS ?? "").trim() || null;
  const equinox = num(header.EQUINOX);

  return {
    ok: true,
    wcs: {
      ctype: [ctype1.trim(), ctype2.trim()],
      projection: p1.proj as ProjectionKind,
      hasSip,
      cd,
      crpix: [crpix1, crpix2],
      crval: [crval1, crval2],
      cunit: [(header.CUNIT1 ?? "deg").trim(), (header.CUNIT2 ?? "deg").trim()],
      lonpole: lonpole ?? 180,
      latpole: latpole ?? 90,
      radesys,
      equinox,
      sipA,
      sipB,
      sipAp,
      sipBp,
    },
  };
}

/** Parsed SIP term cache (avoids per-pixel string parsing). */
const termCache = new WeakMap<object, { p: number; q: number; c: number }[]>();
function sipTerms(coeffs: Map<string, number>): { p: number; q: number; c: number }[] {
  let t = termCache.get(coeffs);
  if (!t) {
    t = [];
    for (const [k, c] of coeffs) {
      const [p, q] = k.split(",").map(Number);
      if (Number.isFinite(p) && Number.isFinite(q)) t.push({ p, q, c });
    }
    termCache.set(coeffs, t);
  }
  return t;
}

function sipEval(coeffs: Map<string, number>, u: number, v: number): number {
  let s = 0;
  for (const t of sipTerms(coeffs)) {
    s += t.c * Math.pow(u, t.p) * Math.pow(v, t.q);
  }
  return s;
}

/* ---------------- projections (intermediate ξ,η deg east/north ↔ sky) ---------------- */

/** Gnomonic (TAN) sky→plane, returns (x_east, y_north) in RADIANS. */
function tanFwd(ra: number, dec: number, ra0: number, dec0: number): [number, number] {
  const r = ra * DEG2RAD, d = dec * DEG2RAD;
  const r0 = ra0 * DEG2RAD, d0 = dec0 * DEG2RAD;
  const cosd = Math.cos(d), sind = Math.sin(d);
  const cosd0 = Math.cos(d0), sind0 = Math.sin(d0);
  const dra = r - r0;
  const dd = sind * sind0 + cosd * cosd0 * Math.cos(dra);
  const x = (cosd * Math.sin(dra)) / dd;
  const y = (sind * cosd0 - cosd * sind0 * Math.cos(dra)) / dd;
  return [x, y];
}

/** Gnomonic (TAN) plane→sky, input (x_east, y_north) RADIANS, returns degrees. */
function tanInv(x: number, y: number, ra0: number, dec0: number): [number, number] {
  const r0 = ra0 * DEG2RAD, d0 = dec0 * DEG2RAD;
  const cosd0 = Math.cos(d0), sind0 = Math.sin(d0);
  const rho = Math.hypot(x, y);
  const c = Math.atan(rho);
  const sinc = Math.sin(c), cosc = Math.cos(c);
  const dec =
    Math.asin(cosc * sind0 + (rho > 0 ? (y * sinc * cosd0) / rho : 0));
  const ra =
    r0 + Math.atan2(x * sinc, rho * cosd0 * cosc - y * sind0 * sinc);
  return [((ra * RAD2DEG) % 360 + 360) % 360, dec * RAD2DEG];
}

/** CAR (plate carrée): ξ = (ra − ra0)cosθ0-ish linear form. Uses the simple
 *  linear equirectangular deprojection referenced to CRVAL. */
function carFwd(ra: number, dec: number, ra0: number, dec0: number): [number, number] {
  let dra = ra - ra0;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  return [dra * DEG2RAD, (dec - dec0) * DEG2RAD];
}
function carInv(x: number, y: number, ra0: number, dec0: number): [number, number] {
  const ra = ra0 + x * RAD2DEG;
  const dec = dec0 + y * RAD2DEG;
  return [((ra % 360) + 360) % 360, Math.max(-90, Math.min(90, dec))];
}

/** SIN (orthographic, LONPOLE=180 standard): x = cosδ sin(α−α0), y = sinδ cosδ0 − cosδ sinδ0. */
function sinFwd(ra: number, dec: number, ra0: number, dec0: number): [number, number] {
  const r = ra * DEG2RAD, d = dec * DEG2RAD;
  const r0 = ra0 * DEG2RAD, d0 = dec0 * DEG2RAD;
  const x = Math.cos(d) * Math.sin(r - r0);
  const y = Math.sin(d) * Math.cos(d0) - Math.cos(d) * Math.sin(d0) * Math.cos(r - r0);
  return [x, y];
}
/** Orthographic inverse: the plane coords are the E/N components of the unit
 *  vector, so n = x·E + y·N + z·n₀ with z = √(1−x²−y²). */
function sinInv(x: number, y: number, ra0: number, dec0: number): [number, number] {
  const r0 = ra0 * DEG2RAD, d0 = dec0 * DEG2RAD;
  const rho2 = x * x + y * y;
  if (rho2 > 1) return [NaN, NaN];
  const z = Math.sqrt(1 - rho2);
  const sinA0 = Math.sin(r0), cosA0 = Math.cos(r0);
  const sinD0 = Math.sin(d0), cosD0 = Math.cos(d0);
  // E = (−sinα₀, cosα₀, 0); N = (−sinδ₀cosα₀, −sinδ₀sinα₀, cosδ₀);
  // n₀ = (cosδ₀cosα₀, cosδ₀sinα₀, sinδ₀)
  const nx = -x * sinA0 - y * sinD0 * cosA0 + z * cosD0 * cosA0;
  const ny = x * cosA0 - y * sinD0 * sinA0 + z * cosD0 * sinA0;
  const nz = y * cosD0 + z * sinD0;
  const dec = Math.asin(Math.max(-1, Math.min(1, nz)));
  const ra = Math.atan2(ny, nx);
  return [((ra * RAD2DEG) % 360 + 360) % 360, dec * RAD2DEG];
}

function projFwd(w: Wcs, ra: number, dec: number): [number, number] {
  switch (w.projection) {
    case "CAR": return carFwd(ra, dec, w.crval[0], w.crval[1]);
    case "SIN": return sinFwd(ra, dec, w.crval[0], w.crval[1]);
    default: return tanFwd(ra, dec, w.crval[0], w.crval[1]);
  }
}
function projInv(w: Wcs, x: number, y: number): [number, number] {
  switch (w.projection) {
    case "CAR": return carInv(x, y, w.crval[0], w.crval[1]);
    case "SIN": return sinInv(x, y, w.crval[0], w.crval[1]);
    default: return tanInv(x, y, w.crval[0], w.crval[1]);
  }
}

/** Absolute pixel scale (arcsec/px) from |det CD|. */
export function pixelScaleArcsec(w: Wcs): number {
  return Math.sqrt(Math.abs(w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0])) * 3600;
}

/** Position angle (deg east of north) of the image +x axis. */
export function pixelAxisPa(w: Wcs): number {
  const pa = Math.atan2(w.cd[0][0], w.cd[1][0]) * RAD2DEG; // east/north comps of +x
  return ((pa % 360) + 360) % 360;
}

/** Pixel (0-based x, y) → ICRS sky (ra, dec degrees). */
export function pixToSky(w: Wcs, x: number, y: number): { ra: number; dec: number } {
  const u = x + 1 - w.crpix[0];
  const v = y + 1 - w.crpix[1];
  let uf = u, vf = v;
  if (w.hasSip) {
    uf = u + sipEval(w.sipA, u, v);
    vf = v + sipEval(w.sipB, u, v);
  }
  const xi = (w.cd[0][0] * uf + w.cd[0][1] * vf) * DEG2RAD; // rad east
  const eta = (w.cd[1][0] * uf + w.cd[1][1] * vf) * DEG2RAD; // rad north
  const [ra, dec] = projInv(w, xi, eta);
  return { ra, dec };
}

/** Sky (ra, dec degrees) → pixel (0-based x, y). NaN when off-projection. */
export function skyToPix(w: Wcs, ra: number, dec: number): { x: number; y: number } {
  const [x, y] = projFwd(w, ra, dec); // rad east/north
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: NaN, y: NaN };
  const xi = x * RAD2DEG, eta = y * RAD2DEG;
  const det = w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0];
  const uf = (w.cd[1][1] * xi - w.cd[0][1] * eta) / det;
  const vf = (-w.cd[1][0] * xi + w.cd[0][0] * eta) / det;
  let u = uf, v = vf;
  if (w.hasSip) {
    // SIP inverse: u = u' + AP(u',v')
    u = uf + sipEval(w.sipAp, uf, vf);
    v = vf + sipEval(w.sipBp, uf, vf);
  }
  return { x: u - 1 + w.crpix[0], y: v - 1 + w.crpix[1] };
}

/** Angular separation (deg) between two sky positions (haversine). */
export function angularSepDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r1 = ra1 * DEG2RAD, d1 = dec1 * DEG2RAD;
  const r2 = ra2 * DEG2RAD, d2 = dec2 * DEG2RAD;
  const s =
    Math.sin((d2 - d1) / 2) ** 2 +
    Math.cos(d1) * Math.cos(d2) * Math.sin((r2 - r1) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) * RAD2DEG;
}

/** Worst-case round-trip error (pixels) sampled over the image grid. Used to
 *  reject internally inconsistent WCS (e.g. broken SIP) before trusting it. */
export function wcsRoundtripError(
  w: Wcs,
  width: number,
  height: number,
  step = 8,
): number {
  let worst = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const s = pixToSky(w, x, y);
      const p = skyToPix(w, s.ra, s.dec);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return Infinity;
      const err = Math.hypot(p.x - x, p.y - y);
      if (err > worst) worst = err;
      if (worst > 1) return worst; // early out; caller threshold is << 1px
    }
  }
  return worst;
}

/** Build a simple TAN WCS describing a north-up, east-left image of the
 *  given pixel scale centred on (ra0, dec0) — used for the common comparison
 *  grid. CRPIX is at the exact image center (1-based). With PNG rendering
 *  (row 0 at the TOP), north-up/east-left requires CD = [[-s, 0], [0, -s]]:
 *  +x (screen right) moves WEST, +y (screen down) moves SOUTH. */
export function makeTanWcs(
  ra0: number,
  dec0: number,
  scaleDegPerPixel: number,
  width: number,
  height: number,
): Wcs {
  const empty = new Map<string, number>();
  return {
    ctype: ["RA---TAN", "DEC--TAN"],
    projection: "TAN",
    hasSip: false,
    cd: [[-scaleDegPerPixel, 0], [0, -scaleDegPerPixel]],
    crpix: [(width + 1) / 2, (height + 1) / 2],
    crval: [ra0, dec0],
    cunit: ["deg", "deg"],
    lonpole: 180,
    latpole: 90,
    radesys: "ICRS",
    equinox: null,
    sipA: empty,
    sipB: empty,
    sipAp: empty,
    sipBp: empty,
  };
}
