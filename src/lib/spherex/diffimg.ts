/**
 * Scientific difference imaging for registered (common-grid) image pairs.
 *
 * Only invoked after both images have been WCS-registered onto the same
 * celestial grid and their compatibility checked. Steps follow established
 * practice (and the IRSA SPHEREx mosaic/photometry tool conventions):
 *
 *  1. Band compatibility — the two observations must cover overlapping
 *     wavelength ranges (>= 50% of the narrower band) and the same product
 *     type / calibration level. Incompatible pairs are rejected explicitly.
 *  2. Photometric normalization — the flux scale ratio is estimated from
 *     matched, unsaturated reference stars when available (median of
 *     per-star flux ratios, MAD-clipped); otherwise a robust (iteratively
 *     sigma-clipped) linear fit over valid pixels is used. This keeps the
 *     subtraction meaningful when calibration/background differs between
 *     epochs.
 *  3. Background match — a sigma-clipped median offset is removed.
 *  4. Difference D = A − (α·B + β), preserving SIGN information.
 *  5. Candidate transient sources — connected components above/below a
 *     robust noise threshold. These are *candidates* (unconfirmed): the
 *     software never labels a differing pixel pattern as a moving object.
 */

import { clippedStats } from "./stars";
import type { Raster } from "./reproject";

export interface BandInfo {
  band: string | null;
  wlMinUm: number | null;
  wlMaxUm: number | null;
  calibLevel: number | null;
}

export interface BandCompatibility {
  compatible: boolean;
  reason: string | null;
  /** fractional overlap of the two bandpasses (0..1) */
  overlap: number | null;
}

export function checkBandCompat(a: BandInfo, b: BandInfo): BandCompatibility {
  if (a.band && b.band && a.band !== b.band) {
    return { compatible: false, reason: `bands differ (${a.band} vs ${b.band})`, overlap: 0 };
  }
  if (a.calibLevel != null && b.calibLevel != null && a.calibLevel !== b.calibLevel) {
    return { compatible: false, reason: `calibration levels differ (L${a.calibLevel} vs L${b.calibLevel})`, overlap: null };
  }
  if (a.wlMinUm != null && a.wlMaxUm != null && b.wlMinUm != null && b.wlMaxUm != null) {
    const lo = Math.max(a.wlMinUm, b.wlMinUm);
    const hi = Math.min(a.wlMaxUm, b.wlMaxUm);
    const overlap = hi > lo ? (hi - lo) / Math.min(a.wlMaxUm - a.wlMinUm, b.wlMaxUm - b.wlMinUm) : 0;
    if (overlap < 0.5) {
      return {
        compatible: false,
        reason: `wavelength ranges barely overlap (${(overlap * 100).toFixed(0)}%): ${a.wlMinUm.toFixed(2)}–${a.wlMaxUm.toFixed(2)} µm vs ${b.wlMinUm.toFixed(2)}–${b.wlMaxUm.toFixed(2)} µm`,
        overlap,
      };
    }
    return { compatible: true, reason: null, overlap };
  }
  // same band name (or one side unknown) — treat as compatible but note it
  return { compatible: true, reason: null, overlap: null };
}

export interface Normalization {
  /** photometric scale α applied to B */
  scale: number;
  /** background offset β */
  offset: number;
  method: "stars" | "pixels";
  nStarsUsed: number;
  /** robust sigma of (A − α·B) after offset removal */
  sigma: number;
}

/** Aperture flux at fractional positions on a raster, with a local annulus
 *  background subtracted. Used post-homogenization so both sides see
 *  identical PSFs and grids. */
export function measureStarFluxes(
  r: Raster,
  positions: { x: number; y: number }[],
  radius: number,
): number[] {
  const { width: w, height: h, image, valid } = r;
  const out: number[] = [];
  const rIn = radius + 1;
  const rOut = radius + 3;
  for (const p of positions) {
    const x0 = Math.max(0, Math.floor(p.x - rOut));
    const x1 = Math.min(w - 1, Math.ceil(p.x + rOut));
    const y0 = Math.max(0, Math.floor(p.y - rOut));
    const y1 = Math.min(h - 1, Math.ceil(p.y + rOut));
    if (x0 >= x1 || y0 >= y1) { out.push(NaN); continue; }
    let flux = 0, n = 0, invalidNear = 0;
    const annulus: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - p.x, y - p.y);
        const i = y * w + x;
        if (!valid[i] || !Number.isFinite(image[i])) {
          if (d <= radius) invalidNear++;
          continue;
        }
        if (d <= radius) {
          flux += image[i];
          n++;
        } else if (d >= rIn && d <= rOut) {
          annulus.push(image[i]);
        }
      }
    }
    if (n < 4 || invalidNear > 2 || annulus.length < 8) { out.push(NaN); continue; }
    annulus.sort((m, q) => m - q);
    const bg = annulus[Math.floor(0.5 * (annulus.length - 1))];
    out.push(flux - n * bg);
  }
  return out;
}

/** Estimate α from matched star flux ratios (both lists aligned to pairs). */
export function scaleFromStars(
  fluxA: number[],
  fluxB: number[],
): { scale: number; n: number } | null {
  if (fluxA.length < 3) return null;
  const ratios = fluxA
    .map((fa, i) => (fluxB[i] > 0 ? fa / fluxB[i] : NaN))
    .filter((r) => Number.isFinite(r) && r > 0 && Number.isFinite(1 / r))
    .sort((m, n) => m - n);
  if (ratios.length < 3) return null;
  // MAD-clipped median
  let kept = ratios.slice();
  let med = kept[Math.floor(0.5 * (kept.length - 1))];
  for (let it = 0; it < 2; it++) {
    const abs = kept.map((r) => Math.abs(r - med)).sort((m, n) => m - n);
    const mad = 1.4826 * (abs[Math.floor(0.5 * (abs.length - 1))] ?? 0);
    const next = kept.filter((r) => Math.abs(r - med) <= 3.5 * (mad || 1e-9) + 0.02);
    if (next.length < 3) break;
    kept = next;
    med = kept[Math.floor(0.5 * (kept.length - 1))];
  }
  return { scale: med, n: kept.length };
}

/** Robust pixel-domain linear fit A ≈ α·B + β with iterative sigma clipping. */
function robustLinearFit(
  A: Float32Array,
  B: Float32Array,
  valid: Uint8Array,
): { scale: number; offset: number } {
  let mask = valid;
  let scale = 1;
  let offset = 0;
  for (let it = 0; it < 4; it++) {
    // weighted moments (uniform) on masked pixels
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < A.length; i++) {
      if (!mask[i]) continue;
      const a = A[i], b = B[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    if (n < 20) return { scale: 1, offset: 0 };
    const cov = sab / n - (sa / n) * (sb / n);
    const varB = sbb / n - (sb / n) * (sb / n);
    scale = varB > 1e-30 ? cov / varB : 1;
    if (!Number.isFinite(scale) || scale <= 0 || scale > 100 || scale < 0.01) scale = 1;
    offset = sa / n - scale * (sb / n);
    // clip
    const resid = new Float32Array(A.length);
    const abs: number[] = [];
    for (let i = 0; i < A.length; i++) {
      resid[i] = mask[i] && Number.isFinite(A[i]) && Number.isFinite(B[i]) ? A[i] - (scale * B[i] + offset) : NaN;
      if (Number.isFinite(resid[i])) abs.push(Math.abs(resid[i]));
    }
    if (abs.length < 20) break;
    abs.sort((m, x) => m - x);
    const mad = 1.4826 * abs[Math.floor(0.5 * (abs.length - 1))];
    const newMask = new Uint8Array(A.length);
    for (let i = 0; i < A.length; i++) {
      newMask[i] = mask[i] && Number.isFinite(resid[i]) && Math.abs(resid[i]) <= 3.5 * (mad || 1e-12) ? 1 : 0;
    }
    if (newMask.reduce((s, v) => s + v, 0) < 20) break;
    mask = newMask;
  }
  return { scale, offset };
}

export interface DifferenceResult {
  diff: Raster; // signed difference A − (α·B + β), NaN where masked
  normalization: Normalization;
  /** robust noise sigma of the difference (MAD-based) */
  sigma: number;
  candidates: DiffCandidate[];
  /** PSF (px) both images were convolved to before subtraction, if any */
  psfMatchedPx: number | null;
}

/** Convolve a raster with a Gaussian of width `sigma` px, respecting the
 *  valid mask (kernel renormalized over valid pixels; pixels whose valid
 *  kernel weight < 0.9 are dropped). Used to homogenize the PSF before
 *  subtraction — the symmetric cousin of difference-imaging PSF matching
 *  (Alard & Lupton 1998): both epochs are broadened to the common width
 *  max(σ_A, σ_B, 0.9 px), which also suppresses interpolation-phase noise
 *  on the critically-sampled SPHEREx PSF. */
export function convolveGaussian(r: Raster, sigma: number): Raster {
  if (!(sigma > 0.05)) return r;
  const rad = Math.max(1, Math.ceil(3 * sigma));
  const kern = new Float64Array(2 * rad + 1);
  let ksum = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kern[i + rad] = v;
    ksum += v;
  }
  const threshold = 0.9 * ksum;
  const { width: w, height: h } = r;
  const pass = (src: Float32Array, valid: Uint8Array, horizontal: boolean) => {
    const out = new Float32Array(w * h);
    const outValid = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!valid[i]) continue;
        let acc = 0, wsum = 0;
        for (let k = -rad; k <= rad; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const j = yy * w + xx;
          if (!valid[j] || !Number.isFinite(src[j])) continue;
          const kv = kern[k + rad];
          acc += kv * src[j];
          wsum += kv;
        }
        if (wsum >= threshold) {
          out[i] = acc / wsum;
          outValid[i] = 1;
        }
      }
    }
    return { out, outValid };
  };
  const px = pass(r.image, r.valid, true);
  const py = pass(px.out, px.outValid, false);
  return { image: py.out, valid: py.outValid, width: w, height: h };
}

export interface DiffCandidate {
  /** centroid on the common grid (0-based px) */
  x: number;
  y: number;
  /** peak |D|/σ inside the blob */
  snr: number;
  /** integrated signed flux in σ units */
  sumSigma: number;
  areaPx: number;
  sign: "positive" | "negative";
}

/** Connected-component candidate detection on the difference raster. */
export function findCandidates(
  diff: Raster,
  sigma: number,
  minSnr = 5,
  minArea = 5,
  maxCandidates = 24,
): DiffCandidate[] {
  const { width: w, height: h, image, valid } = diff;
  const thresh = minSnr * sigma;
  if (!(thresh > 0)) return [];
  const seen = new Uint8Array(w * h);
  const out: DiffCandidate[] = [];
  const queue = new Int32Array(w * h);
  for (let i0 = 0; i0 < w * h; i0++) {
    if (seen[i0] || !valid[i0]) continue;
    const v0 = image[i0];
    if (!Number.isFinite(v0) || Math.abs(v0) < thresh) continue;
    const sign: "positive" | "negative" = v0 > 0 ? "positive" : "negative";
    // BFS 4-connectivity within same-sign super-threshold pixels
    let qh = 0, qt = 0;
    queue[qt++] = i0;
    seen[i0] = 1;
    let sum = 0, nPix = 0, sx = 0, sy = 0, peak = 0;
    while (qh < qt) {
      const idx = queue[qh++];
      const x = idx % w;
      const y = (idx / w) | 0;
      const v = image[idx];
      sum += v; nPix++;
      sx += x * Math.abs(v); sy += y * Math.abs(v);
      if (Math.abs(v) > peak) peak = Math.abs(v);
      const push = (j: number) => {
        if (j < 0 || j >= w * h || seen[j] || !valid[j]) return;
        const vv = image[j];
        if (!Number.isFinite(vv)) return;
        if ((sign === "positive" && vv >= thresh) || (sign === "negative" && vv <= -thresh)) {
          seen[j] = 1;
          if (qt < queue.length) queue[qt++] = j;
        }
      };
      if (x > 0) push(idx - 1);
      if (x < w - 1) push(idx + 1);
      if (y > 0) push(idx - w);
      if (y < h - 1) push(idx + w);
    }
    if (nPix >= minArea) {
      out.push({
        x: sx / (sum === 0 ? 1 : Math.abs(sum)),
        y: sy / (sum === 0 ? 1 : Math.abs(sum)),
        snr: peak / sigma,
        sumSigma: Math.abs(sum) / sigma,
        areaPx: nPix,
        sign,
      });
    }
  }
  out.sort((m, n) => n.snr - m.snr);
  return out.slice(0, maxCandidates);
}

/** Full normalization + difference. A and B are on the SAME grid.
 *  Optional PSF widths (px on the common grid) trigger homogenization to
 *  the broader of the two before subtraction. Matched-star positions (on
 *  the common grid) let the photometric scale be measured on the
 *  homogenized pair with identical apertures — unbiased by native-grid
 *  aperture truncation. */
export function computeDifferenceSci(
  a: Raster,
  b: Raster,
  starPositions?: { x: number; y: number }[],
  psfSigmaPx?: { a: number; b: number },
): DifferenceResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`grid mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }

  // 0) PSF homogenization (broaden both to the common, better-sampled width)
  let psfMatchedPx: number | null = null;
  if (psfSigmaPx && psfSigmaPx.a > 0 && psfSigmaPx.b > 0) {
    const target = Math.max(psfSigmaPx.a, psfSigmaPx.b, 0.9);
    const addA = Math.sqrt(Math.max(0, target * target - psfSigmaPx.a * psfSigmaPx.a));
    const addB = Math.sqrt(Math.max(0, target * target - psfSigmaPx.b * psfSigmaPx.b));
    if (addA > 0.05 || addB > 0.05) {
      a = convolveGaussian(a, addA);
      b = convolveGaussian(b, addB);
      psfMatchedPx = target;
    }
  }
  if (!psfMatchedPx) psfMatchedPx = Math.max(psfSigmaPx?.a ?? 0.9, psfSigmaPx?.b ?? 0.9, 0.9);

  const n = a.width * a.height;
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) valid[i] = a.valid[i] && b.valid[i] ? 1 : 0;

  // 1) photometric scale — matched stars measured on the homogenized pair
  //    (identical apertures both sides), fallback robust pixel fit
  let scale = 1;
  let method: "stars" | "pixels" = "pixels";
  let nStarsUsed = 0;
  if (starPositions && starPositions.length >= 3) {
    const radius = Math.max(2.5, 3 * (psfMatchedPx ?? 1));
    const fa = measureStarFluxes(a, starPositions, radius);
    const fb = measureStarFluxes(b, starPositions, radius);
    const s = scaleFromStars(fa, fb);
    if (s && Number.isFinite(s.scale) && s.scale > 0.05 && s.scale < 20) {
      scale = s.scale;
      method = "stars";
      nStarsUsed = s.n;
    }
  }
  if (method === "pixels") {
    const fit = robustLinearFit(a.image, b.image, valid);
    scale = fit.scale;
  }

  // 2) background offset — sigma-clipped median of A − α·B
  const scaledB = new Float32Array(n);
  const ab = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    scaledB[i] = valid[i] ? scale * b.image[i] : NaN;
    ab[i] = valid[i] ? a.image[i] - scaledB[i] : NaN;
  }
  const st = clippedStats(ab, valid);
  const offset = st.median;

  // 3) signed difference
  const diffImg = new Float32Array(n);
  const diffValid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (valid[i]) {
      diffImg[i] = ab[i] - offset;
      diffValid[i] = 1;
    } else {
      diffImg[i] = NaN;
    }
  }
  const diff: Raster = { image: diffImg, valid: diffValid, width: a.width, height: a.height };

  // robust noise sigma of the difference (clipped MAD)
  const ds = clippedStats(diffImg, diffValid);
  const sigma = ds.sigma > 0 ? ds.sigma : 1e-12;

  const candidates = findCandidates(diff, sigma);
  return {
    diff,
    normalization: { scale, offset, method, nStarsUsed, sigma },
    sigma,
    candidates,
    psfMatchedPx,
  };
}
