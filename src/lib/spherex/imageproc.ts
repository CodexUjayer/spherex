/**
 * SPHEREx image processing (pure TypeScript, zero native deps).
 *
 * - asinh percentile stretch
 * - matplotlib colormap LUTs (inferno / viridis / gray)
 * - PNG encoding via pngjs (pure JS, Vercel-safe)
 * - pixel-wise difference image
 *
 * All data is real, fetched live from NASA/IPAC IRSA.
 */
import { PNG } from "pngjs";
import { getLUT, type ColormapName } from "./colormaps";
import type { FitsData } from "./fits";
import { parseWcs, pixelScaleArcsec, pixelAxisPa } from "./wcs";

export interface PixelStats {
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  std: number | null;
  p1: number | null;
  p99: number | null;
  nan_fraction: number | null;
  n_pixels: number;
}

export function pixelStats(image: Float32Array): PixelStats {
  const finite: number[] = [];
  let nanCount = 0;
  for (let i = 0; i < image.length; i++) {
    const v = image[i];
    if (Number.isNaN(v)) nanCount++;
    else finite.push(v);
  }
  if (finite.length === 0) {
    return {
      min: null, max: null, mean: null, median: null, std: null,
      p1: null, p99: null, nan_fraction: image.length ? 1 : 0,
      n_pixels: image.length,
    };
  }
  finite.sort((a, b) => a - b);
  const sum = finite.reduce((a, b) => a + b, 0);
  const mean = sum / finite.length;
  const variance =
    finite.reduce((a, b) => a + (b - mean) * (b - mean), 0) / finite.length;
  const pct = (p: number) => finite[Math.floor((p / 100) * (finite.length - 1))];
  return {
    min: finite[0],
    max: finite[finite.length - 1],
    mean,
    median: pct(50),
    std: Math.sqrt(variance),
    p1: pct(1),
    p99: pct(99),
    nan_fraction: image.length ? nanCount / image.length : 1,
    n_pixels: image.length,
  };
}

/** asinh stretch mapped to [0,1], beta controls midtone contrast. */
function asinhStretch(v: number, lo: number, hi: number, beta: number): number {
  if (!Number.isFinite(v)) return 0;
  const d = (v - lo) / (hi - lo || 1e-12);
  const c = d < 0 ? 0 : d > 1 ? 1 : d;
  return Math.asinh(beta * c) / Math.asinh(beta);
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.floor((p / 100) * (sorted.length - 1))];
}

export type ViewStyle = "starfield" | "heatmap";

/** Render a 2D float image to a PNG (RGBA). Returns PNG bytes.
 *
 *  - "starfield": median -> black, steep asinh, inferno — only real sources
 *    pop on a clean black sky.
 *  - "heatmap": low percentile -> visible, gentler asinh, viridis — the full
 *    intensity field is filled with colour (a classic scientific heatmap). */
export function renderImagePng(
  image: Float32Array,
  width: number,
  height: number,
  style: ViewStyle = "starfield",
): Buffer {
  const finite: number[] = [];
  for (let i = 0; i < image.length; i++) {
    if (Number.isFinite(image[i])) finite.push(image[i]);
  }
  finite.sort((a, b) => a - b);
  const starfield = style !== "heatmap";
  const loPct = starfield ? 50 : 2;
  const hiPct = starfield ? 99.7 : 99.5;
  const beta = starfield ? 3.5 : 2.0;
  const colormap: ColormapName = starfield ? "inferno" : "viridis";
  const lo = finite.length ? percentile(finite, loPct) : 0;
  const hi = finite.length ? percentile(finite, hiPct) : 1;
  const lut = getLUT(colormap);
  const png = new PNG({ width, height });
  const data = png.data; // Uint8Array RGBA
  for (let i = 0; i < image.length; i++) {
    const v = image[i];
    const o = i * 4;
    if (!Number.isFinite(v)) {
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
      continue;
    }
    const t = asinhStretch(v, lo, hi, beta);
    const idx = Math.round(t * 255) * 3;
    data[o] = lut[idx];
    data[o + 1] = lut[idx + 1];
    data[o + 2] = lut[idx + 2];
    data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Pixel-wise difference A − B (NaN where either is NaN). */
export function computeDifference(
  a: Float32Array,
  b: Float32Array,
): Float32Array {
  const n = Math.min(a.length, b.length);
  const diff = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const av = a[i];
    const bv = b[i];
    diff[i] = Number.isFinite(av) && Number.isFinite(bv) ? av - bv : NaN;
  }
  return diff;
}

/** Render a difference image with a symmetric noise-based diverging grey
 *  scale. When the pipeline supplies its robust σ, the SAME stretch is used
 *  for every panel so brightness is directly comparable — never stretched
 *  independently per image. */
export function renderDifferencePng(
  diff: Float32Array,
  width: number,
  height: number,
  sigmaOverride?: number,
): Buffer {
  const finite: number[] = [];
  for (let i = 0; i < diff.length; i++) {
    if (Number.isFinite(diff[i])) finite.push(diff[i]);
  }
  finite.sort((a, b) => a - b);
  const med = finite.length ? percentile(finite, 50) : 0;
  let sigma: number;
  if (sigmaOverride != null && Number.isFinite(sigmaOverride) && sigmaOverride > 0) {
    sigma = sigmaOverride;
  } else if (finite.length) {
    const mad =
      finite.map((x) => Math.abs(x - med)).sort((a, b) => a - b)[
        Math.floor(0.5 * (finite.length - 1))
      ] + 1e-12;
    sigma = mad * 1.4826 || 1e-12;
  } else {
    sigma = 1;
  }
  const scale = 5 * sigma; // ±5σ of the robust noise maps to full range
  const png = new PNG({ width, height });
  const data = png.data;
  for (let i = 0; i < diff.length; i++) {
    const v = diff[i];
    const o = i * 4;
    if (!Number.isFinite(v)) {
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
      continue;
    }
    let n = (v - med) / (2 * scale) + 0.5;
    n = n < 0 ? 0 : n > 1 ? 1 : n;
    const g = Math.round(n * 255);
    data[o] = g; data[o + 1] = g; data[o + 2] = g; data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function b64png(png: Buffer): string {
  return "data:image/png;base64," + png.toString("base64");
}

export interface FitsMetaWcs {
  crval: [number, number];
  crpix: [number, number];
  cd: number[][];
  pixelScaleArcsec: number;
  paDeg: number;
  projection: string;
  hasSip: boolean;
}

export interface FitsMeta {
  width: number;
  height: number;
  bunit: string | null;
  mjd_obs: number | null;
  mjd_beg?: number | null;
  mjd_end?: number | null;
  date_obs?: string | null;
  xposure?: number | null;
  psf_fwhm_arcsec?: number | null;
  wcs?: FitsMetaWcs | null;
  stats: PixelStats;
  source: string;
}

export function metaFromFits(fd: FitsData): FitsMeta {
  // Expose the real FITS WCS so the client can compute cursor sky positions
  // (SPHEREx cutouts are rotated ~180° between epochs, so a north-up linear
  // approximation is wrong; the tiny SIP residual is < 2 px at cutout edges
  // and is ignored client-side).
  let wcs: { crval: [number, number]; crpix: [number, number]; cd: number[][]; pixelScaleArcsec: number; paDeg: number; projection: string; hasSip: boolean } | null = null;
  try {
    const st = parseWcs(fd.header);
    if (st.ok) {
      wcs = {
        crval: st.wcs.crval,
        crpix: st.wcs.crpix,
        cd: [st.wcs.cd[0], st.wcs.cd[1]],
        pixelScaleArcsec: pixelScaleArcsec(st.wcs),
        paDeg: pixelAxisPa(st.wcs),
        projection: st.wcs.projection,
        hasSip: st.wcs.hasSip,
      };
    }
  } catch {
    /* metadata stays linear */
  }
  return {
    width: fd.width,
    height: fd.height,
    bunit: fd.bunit,
    mjd_obs: fd.mjdObs,
    mjd_beg: fd.mjdBeg,
    mjd_end: fd.mjdEnd,
    date_obs: fd.dateObs,
    xposure: fd.xposure,
    psf_fwhm_arcsec: fd.psfFwhm,
    wcs,
    stats: pixelStats(fd.image),
    source: "NASA/IPAC IRSA SPHEREx Archive",
  };
}
