/**
 * Common-grid reprojection for SPHEREx image comparison.
 *
 * Both observations are resampled onto a common celestial grid (TAN, north
 * up, east left, finest of the two pixel scales, centred on the requested
 * sky position) — the same principle the official IRSA SPHEREx mosaic tool
 * uses, applied to exactly two frames.
 *
 * Resampling is bilinear. Validity is tracked conservatively:
 *   - an output pixel is valid only when its 4 bilinear neighbours are all
 *     inside the source image and valid (no NaN, no masked flag);
 *   - after resampling, the invalid mask is dilated by one pixel so bright
 *     cores cannot bleed across a mask boundary into the difference image
 *     (SPHEREx PSF FWHM ≈ 0.85 px, so a 1-px dilation is adequate).
 *
 * A pure pixel-space similarity-transform resampler is also provided for the
 * documented no-WCS fallback path.
 */

import { makeTanWcs, pixelScaleArcsec, pixToSky, skyToPix, type Wcs } from "./wcs";
import type { SimilarityTransform } from "./stars";

export interface Grid {
  width: number;
  height: number;
  /** WCS of the output grid (no SIP). */
  wcs: Wcs;
}

export interface Raster {
  image: Float32Array; // row-major, NaN where invalid
  valid: Uint8Array; // 1 = usable
  width: number;
  height: number;
}

/** Choose the common output grid for two images. */
export function buildCommonGrid(
  wcsA: Wcs,
  widthA: number,
  heightA: number,
  wcsB: Wcs,
  widthB: number,
  heightB: number,
  raCenter: number,
  decCenter: number,
  sizeDeg: number,
): Grid {
  const sA = pixelScaleArcsec(wcsA);
  const sB = pixelScaleArcsec(wcsB);
  // finest sampling of the two (never undersample the sharper image)
  const scaleArcsec = Math.min(sA, sB);
  const scaleDeg = Math.max(scaleArcsec / 3600, 1e-6);
  const n = Math.max(8, Math.round(sizeDeg / scaleDeg));
  return { width: n, height: n, wcs: makeTanWcs(raCenter, decCenter, scaleDeg, n, n) };
}

/** Bilinear sample of `src` at fractional pixel (x, y) — 0-based pixel-CENTER
 *  coordinates (the convention returned by skyToPix): integer x returns
 *  image[x] exactly. Returns NaN unless all four neighbours are valid. */
export function sampleBilinear(src: Raster, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sw = src.width, sh = src.height;
  if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) return NaN;
  const i00 = y0 * sw + x0;
  const i10 = i00 + 1;
  const i01 = i00 + sw;
  const i11 = i01 + 1;
  if (!src.valid[i00] || !src.valid[i10] || !src.valid[i01] || !src.valid[i11]) return NaN;
  const v00 = src.image[i00], v10 = src.image[i10];
  const v01 = src.image[i01], v11 = src.image[i11];
  if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)) return NaN;
  return (
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty
  );
}

/** Bicubic (Catmull-Rom) sample — materially lower interpolation error on
 *  the critically-sampled SPHEREx PSF than bilinear. Requires the full 4×4
 *  neighbourhood to be valid; NaN otherwise. */
export function sampleBicubic(src: Raster, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sw = src.width, sh = src.height;
  if (x0 - 1 < 0 || y0 - 1 < 0 || x0 + 2 >= sw || y0 + 2 >= sh) return NaN;
  const cr = (t: number): [number, number, number, number] => [
    -0.5 * t + t * t - 0.5 * t * t * t,
    1.5 * t * t * t - 2.5 * t * t + 1,
    -1.5 * t * t * t + 2 * t * t + 0.5 * t,
    0.5 * t * t * t - 0.5 * t * t,
  ];
  const wx = cr(tx);
  const wy = cr(ty);
  let acc = 0;
  for (let j = 0; j < 4; j++) {
    const row = (y0 - 1 + j) * sw;
    let rowAcc = 0;
    for (let i = 0; i < 4; i++) {
      const idx = row + (x0 - 1 + i);
      if (!src.valid[idx]) return NaN;
      const v = src.image[idx];
      if (!Number.isFinite(v)) return NaN;
      rowAcc += wx[i] * v;
    }
    acc += wy[j] * rowAcc;
  }
  return acc;
}

/** Sample with bicubic and bilinear fallback (near edges or masked pixels). */
function sampleAuto(src: Raster, x: number, y: number): number {
  const b = sampleBicubic(src, x, y);
  if (Number.isFinite(b)) return b;
  return sampleBilinear(src, x, y);
}

/**
 * Resample `src` onto a W×H grid. `map` converts an output pixel (x, y) to
 * the fractional source-pixel position (or null for "no data").
 */
export function resample(
  src: Raster,
  width: number,
  height: number,
  map: (x: number, y: number) => { x: number; y: number } | null,
): Raster {
  const out = new Float32Array(width * height);
  const valid = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = map(x, y);
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const v = sampleAuto(src, p.x, p.y);
      if (Number.isFinite(v)) {
        out[y * width + x] = v;
        valid[y * width + x] = 1;
      }
    }
  }
  return dilateInvalid({ image: out, valid, width, height });
}

/** Precompute grid-pixel → sky (used to avoid recomputing per source image). */
export function gridSkyCache(grid: Grid): Float64Array {
  const n = grid.width * grid.height;
  const cache = new Float64Array(n * 2);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const s = pixToSky(grid.wcs, x, y);
      const i = (y * grid.width + x) * 2;
      cache[i] = s.ra;
      cache[i + 1] = s.dec;
    }
  }
  return cache;
}

/** Reproject `src` (with its WCS) onto `grid` using an optional sky cache. */
export function reprojectToGrid(
  src: Raster,
  srcWcs: Wcs,
  grid: Grid,
  skyCache?: Float64Array,
): Raster {
  const W = grid.width;
  return resample(src, W, grid.height, (x, y) => {
    let ra: number, dec: number;
    if (skyCache) {
      const i = (y * W + x) * 2;
      ra = skyCache[i];
      dec = skyCache[i + 1];
    } else {
      const s = pixToSky(grid.wcs, x, y);
      ra = s.ra;
      dec = s.dec;
    }
    return skyToPix(srcWcs, ra, dec);
  });
}

/** Apply a constant pixel shift to a WCS (CRPIX += d). Non-mutating. */
export function shiftedWcs(w: Wcs, dx: number, dy: number): Wcs {
  return { ...w, crpix: [w.crpix[0] + dx, w.crpix[1] + dy] };
}

/**
 * Fallback (no WCS on one side): render `src` onto a W×H grid through a
 * similarity transform T that maps SOURCE pixel coords → TARGET pixel
 * coords. For each target pixel we sample at T⁻¹(target).
 */
export function reprojectBySimilarity(
  src: Raster,
  t: SimilarityTransform,
  width: number,
  height: number,
): Raster {
  const det = t.a * t.d - t.b * t.c;
  if (Math.abs(det) < 1e-12) {
    return { image: new Float32Array(width * height).fill(NaN), valid: new Uint8Array(width * height), width, height };
  }
  // inverse similarity
  const ia = t.d / det, ib = -t.b / det, ic = -t.c / det, id_ = t.a / det;
  return resample(src, width, height, (x, y) => {
    const ux = x - t.tx, uy = y - t.ty;
    return { x: ia * ux + ib * uy, y: ic * ux + id_ * uy };
  });
}

/** Set pixels adjacent (3×3) to any invalid pixel to invalid. Returns new raster. */
export function dilateInvalid(r: Raster): Raster {
  const { width: w, height: h } = r;
  const valid = r.valid.slice();
  const image = r.image;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (r.valid[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (valid[j]) {
            valid[j] = 0;
            image[j] = NaN;
          }
        }
      }
    }
  }
  return { image, valid, width: w, height: h };
}

/** Fraction of valid pixels. */
export function validFraction(r: Raster): number {
  let n = 0;
  for (let i = 0; i < r.valid.length; i++) n += r.valid[i];
  return r.valid.length ? n / r.valid.length : 0;
}
