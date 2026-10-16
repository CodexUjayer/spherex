/**
 * Point-source detection, matching and registration refinement.
 *
 * SPHEREx L2 images are undersampled (PSF FWHM ≈ 5.2" ≈ 0.85 px), so the
 * detector is deliberately simple: light Gaussian smoothing, sigma-clipped
 * background statistics, 3×3 local maxima, windowed centroid, aperture flux.
 *
 * Two matching modes:
 *  1. "wcs" — when both images carry a trustworthy WCS, sources from A are
 *     projected into B's pixel frame and matched by nearest neighbour; the
 *     median residual is measured and (if significant) applied as a constant
 *     shift refinement, with MAD outlier rejection. The RMS of inlier
 *     residuals is reported as the alignment error.
 *  2. "feature" — documented fallback when WCS is absent/invalid: triangle
 *     signatures (edge-ratio invariants) between the brightest sources give
 *     candidate similarity transforms (rotation + uniform scale +
 *     translation); a RANSAC vote picks the best, which is then refined by
 *     least squares on inliers. Registration relies on measurable individual
 *     sources, never on constellation shapes.
 *
 * If too few usable sources exist, the result is an explicit low-confidence /
 * failed status — never a manufactured transform.
 */

import { pixToSky, skyToPix, type Wcs } from "./wcs";

export interface SourceDet {
  x: number; // centroid px (0-based)
  y: number;
  peak: number;
  flux: number; // aperture sum − local background
  snr: number;
}

export interface DetectOptions {
  fwhmPx?: number; // for the detection filter (default 1.0)
  nsigma?: number; // detection threshold (default 5)
  maxSources?: number;
  /** minimum isolation radius (px) from a brighter source */
  isolationPx?: number;
}

/** Sigma-clipped (median/MAD) statistics of valid pixels. */
export function clippedStats(
  image: Float32Array,
  valid: Uint8Array,
  iterations = 3,
  k = 3,
): { median: number; sigma: number } {
  const vals: number[] = [];
  for (let i = 0; i < image.length; i++) {
    if (valid[i] && Number.isFinite(image[i])) vals.push(image[i]);
  }
  if (!vals.length) return { median: 0, sigma: 0 };
  vals.sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * (vals.length - 1))))];
  let median = q(0.5);
  let sigma = 0;
  for (let it = 0; it < iterations; it++) {
    const abs = vals.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = abs[Math.floor(0.5 * (abs.length - 1))] * 1.4826;
    sigma = mad || sigma || 1e-12;
    const kept = vals.filter((v) => Math.abs(v - median) <= k * sigma);
    if (kept.length < 10) break;
    const s2 = kept.slice().sort((a, b) => a - b);
    median = s2[Math.floor(0.5 * (s2.length - 1))];
    const abs2 = kept.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    sigma = abs2[Math.floor(0.5 * (abs2.length - 1))] * 1.4826 || sigma;
    vals.length = 0;
    for (const v of kept) vals.push(v);
  }
  return { median, sigma };
}

function gaussianKernel(sigma: number): { k: Float32Array; w: number } {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const size = 2 * r + 1;
  const k = new Float32Array(size * size);
  let sum = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const v = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      k[(dy + r) * size + (dx + r)] = v;
      sum += v;
    }
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { k, w: size };
}

/** Detect point-like sources on a raster. */
export function detectSources(
  image: Float32Array,
  valid: Uint8Array,
  width: number,
  height: number,
  opts: DetectOptions = {},
): SourceDet[] {
  const fwhm = opts.fwhmPx ?? 1.0;
  const nsigma = opts.nsigma ?? 5;
  const maxSources = opts.maxSources ?? 200;
  const isolation = opts.isolationPx ?? 6;
  const sigmaFilter = Math.max(0.5, (fwhm / 2.355) * 0.9);

  const { median, sigma } = clippedStats(image, valid);
  if (!Number.isFinite(sigma) || sigma <= 0) return [];

  // smooth for detection
  const { k: kern, w: kw } = gaussianKernel(sigmaFilter);
  const r = (kw - 1) / 2;
  const sm = new Float32Array(width * height);
  const smValid = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!valid[i]) continue;
      let acc = 0, wsum = 0, ok = true;
      for (let dy = -r; dy <= r && ok; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) { ok = false; break; }
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) { ok = false; break; }
          const j = yy * width + xx;
          if (!valid[j] || !Number.isFinite(image[j])) { ok = false; break; }
          const kv = kern[(dy + r) * kw + (dx + r)];
          acc += image[j] * kv;
          wsum += kv;
        }
      }
      if (ok) {
        sm[i] = acc / (wsum || 1);
        smValid[i] = 1;
      }
    }
  }
  const smSigma = sigma / (2 * Math.sqrt(Math.PI) * sigmaFilter) || sigma; // variance reduction of matched filter
  const thresh = median + nsigma * smSigma;

  const out: SourceDet[] = [];
  const cands: SourceDet[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!smValid[i]) continue;
      const v = sm[i];
      if (v < thresh) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const j = (y + dy) * width + (x + dx);
          if (smValid[j] && sm[j] > v) { isMax = false; break; }
        }
      }
      if (!isMax) continue;
      // windowed centroid on the RAW image (5x5, bg-subtracted, valid-only)
      const c = centroid(image, valid, width, height, x, y, 2, median);
      if (!c) continue;
      // aperture flux (r = 2.5 px) minus local background
      const f = apertureFlux(image, valid, width, height, c.x, c.y, 2.5, median);
      if (f.flux <= 0) continue;
      cands.push({ x: c.x, y: c.y, peak: v - median, flux: f.flux, snr: f.flux / (sigma * Math.sqrt(Math.max(1, f.npix)) + 1e-12) });
    }
  }
  // brightest first, then isolation + edge filters, then cap
  cands.sort((a, b) => b.flux - a.flux);
  const picked: SourceDet[] = [];
  for (const s of cands) {
    if (picked.length >= maxSources) break;
    let isolated = true;
    for (const p of picked) {
      if (Math.hypot(p.x - s.x, p.y - s.y) < isolation) { isolated = false; break; }
    }
    if (!isolated) continue;
    if (s.x < 3 || s.y < 3 || s.x > width - 4 || s.y > height - 4) continue;
    picked.push(s);
  }
  return picked;
}

function centroid(
  image: Float32Array,
  valid: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  half: number,
  bg: number,
): { x: number; y: number } | null {
  let sx = 0, sy = 0, sw = 0;
  for (let dy = -half; dy <= half; dy++) {
    const y = y0 + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -half; dx <= half; dx++) {
      const x = x0 + dx;
      if (x < 0 || x >= width) continue;
      const i = y * width + x;
      if (!valid[i]) continue;
      const v = image[i] - bg;
      if (v <= 0) continue;
      sx += x * v;
      sy += y * v;
      sw += v;
    }
  }
  if (sw <= 0) return null;
  return { x: sx / sw, y: sy / sw };
}

function apertureFlux(
  image: Float32Array,
  valid: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  r: number,
  bg: number,
): { flux: number; npix: number } {
  let flux = 0, n = 0;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.hypot(x + 0.5 - (cx + 0.5), y + 0.5 - (cy + 0.5)) > r) continue;
      const i = y * width + x;
      if (!valid[i]) continue;
      flux += image[i] - bg;
      n++;
    }
  }
  return { flux, npix: n };
}

/* ------------------------- WCS-based matching ------------------------- */

export interface StarPair {
  a: SourceDet;
  b: SourceDet;
  /** residual (b − predicted) in B frame pixels */
  dx: number;
  dy: number;
}

export interface WcsMatchResult {
  method: "wcs";
  pairs: StarPair[];
  /** median residual shift applied as refinement (B frame px) */
  shift: { dx: number; dy: number };
  /** robust RMS of inlier residuals (px) */
  rmsPx: number;
  rmsArcsec: number;
  nMatched: number;
  nInliers: number;
  status: "ok" | "low" | "failed";
}

export interface SimilarityTransform {
  /** maps A-plane coords -> B-plane coords: [s·cosθ, −s·sinθ, tx; s·sinθ, s·cosθ, ty] */
  a: number; b: number; c: number; d: number; tx: number; ty: number;
  scale: number;
  rotDeg: number;
}
export function applySim(t: SimilarityTransform, x: number, y: number): { x: number; y: number } {
  return { x: t.a * x - t.b * y + t.tx, y: t.c * x + t.d * y + t.ty };
}

export interface FeatureMatchResult {
  method: "feature";
  transform: SimilarityTransform | null;
  rmsPx: number;
  nMatched: number;
  nInliers: number;
  status: "ok" | "low" | "failed";
  note?: string;
}

export type MatchResult = WcsMatchResult | FeatureMatchResult;

/** Match sources using their WCS sky positions (both frames need valid WCS). */
export function matchWithWcs(
  starsA: SourceDet[],
  starsB: SourceDet[],
  wcsA: Wcs,
  wcsB: Wcs,
  tolPx = 3,
): WcsMatchResult {
  const pairs: StarPair[] = [];
  for (const a of starsA) {
    const sky = pixToSky(wcsA, a.x, a.y);
    const p = skyToPix(wcsB, sky.ra, sky.dec);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    // nearest B source within tolerance (mutual check)
    let best: SourceDet | null = null;
    let bestD = Infinity;
    for (const b of starsB) {
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best || bestD > tolPx) continue;
    // mutuality: is `a` the best A partner for `best`?
    let mutual = true;
    const bSky = pixToSky(wcsB, best.x, best.y);
    const bp = skyToPix(wcsA, bSky.ra, bSky.dec);
    for (const a2 of starsA) {
      if (Math.hypot(a2.x - bp.x, a2.y - bp.y) < bestD - 1e-9 && a2 !== a) { mutual = false; break; }
    }
    if (!mutual) continue;
    pairs.push({ a, b: best, dx: best.x - p.x, dy: best.y - p.y });
  }
  if (pairs.length === 0) {
    return { method: "wcs", pairs, shift: { dx: 0, dy: 0 }, rmsPx: Infinity, rmsArcsec: Infinity, nMatched: 0, nInliers: 0, status: "failed" };
  }
  // median shift with MAD outlier rejection (2 iterations)
  let inliers = pairs.slice();
  let shift = { dx: 0, dy: 0 };
  for (let it = 0; it < 2; it++) {
    const dxs = inliers.map((p) => p.dx).sort((m, n) => m - n);
    const dys = inliers.map((p) => p.dy).sort((m, n) => m - n);
    shift = {
      dx: dxs[Math.floor(0.5 * (dxs.length - 1))] ?? 0,
      dy: dys[Math.floor(0.5 * (dys.length - 1))] ?? 0,
    };
    const madx = 1.4826 * medianAbs(dxs, shift.dx);
    const mady = 1.4826 * medianAbs(dys, shift.dy);
    const keep = inliers.filter(
      (p) =>
        Math.abs(p.dx - shift.dx) <= 3.5 * (madx || 1e-6) + 0.3 &&
        Math.abs(p.dy - shift.dy) <= 3.5 * (mady || 1e-6) + 0.3,
    );
    if (keep.length >= 3) inliers = keep;
  }
  let sq = 0;
  for (const p of inliers) sq += p.dx * p.dx + p.dy * p.dy;
  const rmsPx = inliers.length ? Math.sqrt(sq / inliers.length) : Infinity;
  const scale = pixelScaleOf(wcsB);
  const rmsArcsec = rmsPx * scale;
  const status = inliers.length >= 5 ? "ok" : inliers.length >= 3 ? "low" : "failed";
  return { method: "wcs", pairs, shift, rmsPx, rmsArcsec, nMatched: pairs.length, nInliers: inliers.length, status };
}

function medianAbs(sorted: number[], med: number): number {
  const abs = sorted.map((v) => Math.abs(v - med)).sort((m, n) => m - n);
  return abs[Math.floor(0.5 * (abs.length - 1))] ?? 0;
}

function pixelScaleOf(w: Wcs): number {
  const det = Math.abs(w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0]);
  return Math.sqrt(det) * 3600;
}

/* ---------------------- triangle-based fallback ---------------------- */

interface Tri { i: number; j: number; k: number; sig: number[]; }

function triangles(stars: SourceDet[], n: number): Tri[] {
  const s = stars.slice(0, n);
  const out: Tri[] = [];
  const d = (p: SourceDet, q: SourceDet) => Math.hypot(p.x - q.x, p.y - q.y);
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      for (let k = j + 1; k < s.length; k++) {
        const edges = [d(s[i], s[j]), d(s[i], s[k]), d(s[j], s[k])].sort((m, n) => m - n);
        const per = edges[2] || 1;
        out.push({ i, j, k, sig: [edges[0] / per, edges[1] / per] });
      }
    }
  }
  return out;
}

function simFromPairPair(
  ax: number, ay: number, bx: number, by: number, // A pair
  cx: number, cy: number, dx: number, dy: number, // B pair
): SimilarityTransform | null {
  const dA = Math.hypot(bx - ax, by - ay);
  const dB = Math.hypot(dx - cx, dy - cy);
  if (dA < 1e-6 || dB < 1e-6) return null;
  const s = dB / dA;
  const thA = Math.atan2(by - ay, bx - ax);
  const thB = Math.atan2(dy - cy, dx - cx);
  const th = thB - thA;
  const a = s * Math.cos(th), b = s * Math.sin(th);
  // t = B1 − R·A1
  const tx = cx - (a * ax - b * ay);
  const ty = cy - (b * ax + a * ay);
  return { a, b, c: b, d: a, tx, ty, scale: s, rotDeg: (th * 180) / Math.PI };
}

/** Geometric registration fallback (no usable WCS): triangle-signature voting
 *  over the brightest sources, then least-squares similarity refinement. */
export function matchByTriangles(
  starsA: SourceDet[],
  starsB: SourceDet[],
  tolPx = 1.5,
): FeatureMatchResult {
  const nA = Math.min(10, starsA.length);
  const nB = Math.min(10, starsB.length);
  if (nA < 3 || nB < 3) {
    return { method: "feature", transform: null, rmsPx: Infinity, nMatched: 0, nInliers: 0, status: "failed", note: "fewer than 3 usable sources" };
  }
  const triA = triangles(starsA, nA);
  const triB = triangles(starsB, nB);
  const holder: { best: { t: SimilarityTransform; votes: number } | null } = {
    best: null,
  };
  const tryCandidate = (t: SimilarityTransform) => {
    let votes = 0;
    for (const a of starsA.slice(0, 40)) {
      const p = applySim(t, a.x, a.y);
      for (const b of starsB.slice(0, 40)) {
        if (Math.hypot(b.x - p.x, b.y - p.y) <= tolPx) { votes++; break; }
      }
    }
    if (!holder.best || votes > holder.best.votes) holder.best = { t, votes };
  };
  for (const ta of triA) {
    for (const tb of triB) {
      const dsig =
        Math.abs(ta.sig[0] - tb.sig[0]) + Math.abs(ta.sig[1] - tb.sig[1]);
      if (dsig > 0.04) continue;
      const A = starsA, B = starsB;
      // try the 3 vertex permutations of the triangle pair
      const perms: [number, number, number][] = [
        [ta.i, ta.j, ta.k],
        [ta.i, ta.k, ta.j],
        [ta.j, ta.i, ta.k],
      ];
      for (const [i1, i2, i3] of perms) {
        const t1 = simFromPairPair(
          A[i1].x, A[i1].y, A[i2].x, A[i2].y,
          B[tb.i].x, B[tb.i].y, B[tb.j].x, B[tb.j].y,
        );
        if (!t1) continue;
        // verify on the third vertex
        const p3 = applySim(t1, A[i3].x, A[i3].y);
        if (Math.hypot(B[tb.k].x - p3.x, B[tb.k].y - p3.y) > tolPx) continue;
        tryCandidate(t1);
      }
    }
  }
  if (!holder.best || holder.best.votes < 3) {
    return {
      method: "feature", transform: null, rmsPx: Infinity, nMatched: 0, nInliers: 0,
      status: "failed",
      note: "no consistent geometric solution between source lists",
    };
  }
  // least-squares similarity refinement on mutual inliers
  let t = holder.best.t;
  for (let it = 0; it < 3; it++) {
    const pairs: { a: SourceDet; b: SourceDet }[] = [];
    for (const a of starsA.slice(0, 60)) {
      const p = applySim(t, a.x, a.y);
      let bd = Infinity, bb: SourceDet | null = null;
      for (const b of starsB.slice(0, 60)) {
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < bd) { bd = d; bb = b; }
      }
      if (bb && bd <= tolPx) pairs.push({ a, b: bb });
    }
    if (pairs.length < 3) break;
    const ref = fitSimilarity(pairs.map((p) => p.a), pairs.map((p) => p.b));
    if (!ref) break;
    t = ref;
  }
  // final inliers + rms
  let sq = 0, nIn = 0;
  for (const a of starsA.slice(0, 60)) {
    const p = applySim(t, a.x, a.y);
    let bd = Infinity;
    for (const b of starsB.slice(0, 60)) {
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d < bd) bd = d;
    }
    if (bd <= tolPx) { sq += bd * bd; nIn++; }
  }
  const rms = nIn ? Math.sqrt(sq / nIn) : Infinity;
  const status = nIn >= 5 ? "ok" : nIn >= 3 ? "low" : "failed";
  return { method: "feature", transform: t, rmsPx: rms, nMatched: nIn, nInliers: nIn, status };
}

/** Closed-form least-squares similarity fit between two ordered point lists. */
export function fitSimilarity(
  ptsA: { x: number; y: number }[],
  ptsB: { x: number; y: number }[],
): SimilarityTransform | null {
  const n = Math.min(ptsA.length, ptsB.length);
  if (n < 2) return null;
  let maX = 0, maY = 0, mbX = 0, mbY = 0;
  for (let i = 0; i < n; i++) {
    maX += ptsA[i].x; maY += ptsA[i].y;
    mbX += ptsB[i].x; mbY += ptsB[i].y;
  }
  maX /= n; maY /= n; mbX /= n; mbY /= n;
  let saa = 0, sbb = 0, sab = 0, sba = 0;
  for (let i = 0; i < n; i++) {
    const ax = ptsA[i].x - maX, ay = ptsA[i].y - maY;
    const bx = ptsB[i].x - mbX, by = ptsB[i].y - mbY;
    saa += ax * ax + ay * ay;
    sbb += bx * bx + by * by;
    sab += ax * bx + ay * by;
    sba += ax * by - ay * bx;
  }
  if (saa < 1e-12) return null;
  // Umeyama (uniform scale): s = (sab ± √(sbb... ))/saa — use sign of sab
  let denom = saa;
  let scale = Math.sqrt((sab * sab + sba * sba) / (denom * denom)) * (sab >= 0 ? 1 : -1) * Math.sqrt(denom) || 0;
  // simpler robust route: solve rotation*scale directly
  const th = Math.atan2(sba, sab);
  const s = Math.hypot(sab, sba) / saa;
  const a = s * Math.cos(th), b = s * Math.sin(th);
  const tx = mbX - (a * maX - b * maY);
  const ty = mbY - (b * maX + a * maY);
  void scale;
  return { a, b, c: b, d: a, tx, ty, scale: s, rotDeg: (th * 180) / Math.PI };
}
