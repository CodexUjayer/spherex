/// <reference types="bun-types" />
/**
 * Synthetic sky scenes for registration/difference tests (tests ONLY).
 *
 * A star catalog (sky positions + fluxes) is rendered through a WCS onto a
 * pixel grid with a small Gaussian PSF, optionally with per-visit shifts,
 * background levels, flux scale factors, and injected transients.
 */

import { pixToSky, skyToPix, type Wcs } from "@/lib/spherex/wcs";

export interface CatalogStar {
  ra: number;
  dec: number;
  flux: number;
}

/** Deterministic PRNG (mulberry32) so tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RenderOpts {
  width: number;
  height: number;
  /** Gaussian PSF sigma in pixels */
  psfSigma?: number;
  /** additive background level */
  background?: number;
  /** flux multiplier (photometric scale difference) */
  fluxScale?: number;
  /** per-pixel noise sigma */
  noiseSigma?: number;
  seed?: number;
  /** extra stars rendered ONLY in this visit (transients) */
  extraStars?: CatalogStar[];
  /** omit catalog stars whose ids are in this list */
  skipIndices?: Set<number>;
}

/** Render a catalog through `wcs` onto the pixel grid. Returns image + valid
 *  mask (all-valid; masking is exercised separately). */
export function renderScene(
  catalog: CatalogStar[],
  wcs: Wcs,
  opts: RenderOpts,
): { image: Float32Array; valid: Uint8Array } {
  const { width: W, height: H } = opts;
  const sigma = opts.psfSigma ?? 0.6;
  const bg = opts.background ?? 0;
  const scale = opts.fluxScale ?? 1;
  const image = new Float32Array(W * H);
  const valid = new Uint8Array(W * H).fill(1);
  const r = opts.seed != null ? rng(opts.seed) : null;

  const render = (s: CatalogStar, weight: number) => {
    const p = skyToPix(wcs, s.ra, s.dec);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    const x0 = Math.max(0, Math.floor(p.x - 4 * sigma));
    const x1 = Math.min(W - 1, Math.ceil(p.x + 4 * sigma));
    const y0 = Math.max(0, Math.floor(p.y - 4 * sigma));
    const y1 = Math.min(H - 1, Math.ceil(p.y + 4 * sigma));
    const norm = 1 / (2 * Math.PI * sigma * sigma);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - p.x) ** 2 + (y - p.y) ** 2;
        image[y * W + x] += (weight * s.flux * norm) * Math.exp(-d2 / (2 * sigma * sigma));
      }
    }
  };

  catalog.forEach((s, i) => {
    if (opts.skipIndices?.has(i)) return;
    render(s, scale);
  });
  for (const s of opts.extraStars ?? []) render(s, scale);

  if (r && opts.noiseSigma) {
    for (let i = 0; i < image.length; i++) image[i] += (r() - 0.5) * 2 * opts.noiseSigma;
  }
  for (let i = 0; i < image.length; i++) image[i] += bg;
  return { image, valid };
}

/** Build a random star catalog inside a box around (ra0, dec0). */
export function makeCatalog(
  ra0: number,
  dec0: number,
  sizeDeg: number,
  n: number,
  seed: number,
  fluxRange: [number, number] = [5, 120],
): CatalogStar[] {
  const r = rng(seed);
  const out: CatalogStar[] = [];
  for (let i = 0; i < n; i++) {
    // uniform over the field
    const ra = ra0 + (r() - 0.5) * sizeDeg / Math.cos((dec0 * Math.PI) / 180);
    const dec = dec0 + (r() - 0.5) * sizeDeg;
    const flux = fluxRange[0] + r() * (fluxRange[1] - fluxRange[0]);
    out.push({ ra, dec, flux });
  }
  return out;
}

/** Sky position of the image center under `wcs`. */
export function centerSky(w: Wcs, width: number, height: number) {
  return pixToSky(w, (width - 1) / 2, (height - 1) / 2);
}
