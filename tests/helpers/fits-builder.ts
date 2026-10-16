/// <reference types="bun-types" />
/**
 * Deterministic synthetic FITS builder for tests ONLY.
 *
 * Builds a SPHEREx-like cutout MEF in memory (PRIMARY + IMAGE + FLAGS +
 * VARIANCE + ZODI + PSF) with a caller-supplied WCS header, so the whole
 * stack (FITS parsing, WCS, registration, difference imaging) can be tested
 * without network access. Synthetic data never touches the live pipeline.
 */

const BLOCK = 2880;

function card(key: string, value: string | number | boolean, comment?: string): string {
  let v: string;
  if (typeof value === "string") {
    v = `'${value}'`;
  } else if (typeof value === "boolean") {
    v = value ? "T" : "F";
  } else {
    v = String(value);
  }
  let c = `${key.padEnd(8, " ")}= ${v.padEnd(20)}`;
  if (comment) c += ` / ${comment}`;
  return c.padEnd(80, " ");
}

function headerBlock(cards: string[]): Buffer {
  const withEnd = [...cards, "END".padEnd(80, " ")];
  while (withEnd.length % 36 !== 0) withEnd.push("".padEnd(80, " "));
  const header = Buffer.from(withEnd.join(""), "ascii");
  const blocks = Math.ceil(header.length / BLOCK) * BLOCK;
  return Buffer.concat([header, Buffer.alloc(blocks - header.length)]);
}

function pad2880(data: Buffer): Buffer {
  const blocks = Math.ceil(data.length / BLOCK) * BLOCK;
  return Buffer.concat([data, Buffer.alloc(blocks - data.length)]);
}

export interface WcsHeaderSpec {
  /** degrees per pixel (positive) */
  scaleDeg: number;
  /** rotation of the x-axis (deg east of north) */
  paDeg: number;
  crpix: [number, number];
  crval: [number, number];
  /** add SIP distortion coefficients (order 2, deterministic) */
  sip?: boolean;
  /** override CTYPE projection (default TAN) */
  projection?: string;
  /** deliberately unsupported CTYPE projection */
  badCtype?: boolean;
  /** omit WCS keywords entirely */
  omit?: boolean;
}

export interface FitsBuilderOpts {
  width: number;
  height: number;
  /** image data row-major */
  image: Float32Array;
  /** int32 flag array (zero-filled when omitted) */
  flags?: Int32Array;
  variance?: Float32Array;
  zodi?: Float32Array;
  wcs: WcsHeaderSpec;
  /** extra IMAGE header cards */
  extraHeader?: Record<string, string | number>;
  /** omit FLAGS HDU */
  noFlags?: boolean;
  /** omit VARIANCE HDU */
  noVariance?: boolean;
}

/** Build CD (deg/px) from scale + position angle (x-axis east of north). */
export function cdFromScalePa(scaleDeg: number, paDeg: number): [[number, number], [number, number]] {
  const t = (paDeg * Math.PI) / 180;
  const xe = Math.sin(t), xn = Math.cos(t);
  const ye = Math.sin(t + Math.PI / 2), yn = Math.cos(t + Math.PI / 2);
  return [
    [scaleDeg * xe, scaleDeg * ye],
    [scaleDeg * xn, scaleDeg * yn],
  ];
}

export function buildFits(opts: FitsBuilderOpts): Buffer {
  const parts: Buffer[] = [];
  // PRIMARY
  parts.push(
    headerBlock([
      card("SIMPLE", true, "conforms to FITS standard"),
      card("BITPIX", 8),
      card("NAXIS", 0),
      card("EXTEND", true),
    ]),
  );

  // IMAGE
  const imgCards = [
    card("XTENSION", "IMAGE"),
    card("BITPIX", -32),
    card("NAXIS", 2),
    card("NAXIS1", opts.width),
    card("NAXIS2", opts.height),
    card("PCOUNT", 0),
    card("GCOUNT", 1),
    card("EXTNAME", "IMAGE"),
    card("BUNIT", "MJy / sr"),
    card("DETECTOR", 2),
    card("OBSID", "SYNTH_001"),
    card("MJD-OBS", 61000.5),
    card("MJD-BEG", 61000.5),
    card("MJD-END", 61000.501),
    card("MJD-AVG", 61000.5005),
    card("DATE-OBS", "2026-01-01T00:00:00"),
    card("XPOSURE", 113.5),
    card("PSF_FWHM", 5.2),
  ];
  if (!opts.wcs.omit) {
    const proj = opts.wcs.projection ?? "TAN";
    const ct = `RA---${proj}${opts.wcs.sip ? "-SIP" : ""}`;
    const ct2 = `DEC--${proj}${opts.wcs.sip ? "-SIP" : ""}`;
    if (opts.wcs.badCtype) {
      imgCards.push(card("CTYPE1", "RA---AIT", "unsupported projection"));
      imgCards.push(card("CTYPE2", "DEC--AIT", "unsupported projection"));
    } else {
      imgCards.push(card("CTYPE1", ct), card("CTYPE2", ct2));
    }
    imgCards.push(
      card("CRPIX1", opts.wcs.crpix[0]),
      card("CRPIX2", opts.wcs.crpix[1]),
      card("CRVAL1", opts.wcs.crval[0]),
      card("CRVAL2", opts.wcs.crval[1]),
      card("CDELT1", 1.0),
      card("CDELT2", 1.0),
    );
    const cd = cdFromScalePa(opts.wcs.scaleDeg, opts.wcs.paDeg);
    imgCards.push(
      card("PC1_1", cd[0][0].toPrecision(14)),
      card("PC1_2", cd[0][1].toPrecision(14)),
      card("PC2_1", cd[1][0].toPrecision(14)),
      card("PC2_2", cd[1][1].toPrecision(14)),
      card("CUNIT1", "deg"),
      card("CUNIT2", "deg"),
      card("RADESYS", "ICRS"),
    );
    if (opts.wcs.sip) {
      imgCards.push(
        card("A_ORDER", 2), card("B_ORDER", 2),
        card("A_0_2", 2.0e-7), card("A_1_1", 1.0e-7), card("A_2_0", 3.0e-7),
        card("B_0_2", 1.5e-7), card("B_1_1", 0.5e-7), card("B_2_0", 2.5e-7),
        card("AP_ORDER", 2), card("BP_ORDER", 2),
        card("AP_0_2", -2.0e-7), card("AP_1_1", -1.0e-7), card("AP_2_0", -3.0e-7),
        card("BP_0_2", -1.5e-7), card("BP_1_1", -0.5e-7), card("BP_2_0", -2.5e-7),
      );
    }
  }
  for (const [k, v] of Object.entries(opts.extraHeader ?? {})) {
    imgCards.push(card(k, v));
  }
  parts.push(headerBlock(imgCards));
  const imgData = Buffer.alloc(opts.width * opts.height * 4);
  for (let i = 0; i < opts.image.length; i++) imgData.writeFloatBE(opts.image[i], i * 4);
  parts.push(pad2880(imgData));

  const pushExt = (
    name: string,
    bitpix: number,
    write: (buf: Buffer, i: number) => void,
    bytesPer: number,
    n: number,
    extra: string[] = [],
  ) => {
    parts.push(
      headerBlock([
        card("XTENSION", "IMAGE"),
        card("BITPIX", bitpix),
        card("NAXIS", 2),
        card("NAXIS1", opts.width),
        card("NAXIS2", opts.height),
        card("PCOUNT", 0),
        card("GCOUNT", 1),
        card("EXTNAME", name),
        ...extra,
      ]),
    );
    const data = Buffer.alloc(n * bytesPer);
    for (let i = 0; i < n; i++) write(data, i);
    parts.push(pad2880(data));
  };

  if (!opts.noFlags) {
    pushExt("FLAGS", 32, (b, i) => b.writeInt32BE(opts.flags ? opts.flags[i] : 0, i * 4), 4, opts.width * opts.height);
  }
  if (!opts.noVariance) {
    pushExt("VARIANCE", -32, (b, i) => b.writeFloatBE(opts.variance ? opts.variance[i] : 1, i * 4), 4, opts.width * opts.height, [card("BUNIT", "MJy2 / sr2")]);
  }
  pushExt("ZODI", -32, (b, i) => b.writeFloatBE(opts.zodi ? opts.zodi[i] : 0, i * 4), 4, opts.width * opts.height, [card("BUNIT", "MJy / sr")]);
  // small PSF-like HDU (streamCutout would stop before it)
  pushExt("PSF", -32, (b, i) => b.writeFloatBE(0, i * 4), 4, 16);

  return Buffer.concat(parts);
}
