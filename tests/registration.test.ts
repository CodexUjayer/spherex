/// <reference types="bun-types" />
/**
 * End-to-end registration & difference pipeline tests (Task 9.3–9.8).
 *
 * Deterministic synthetic scenes (identical sky content viewed through
 * different WCS geometries) verify that:
 *   - a known registration offset is corrected and does NOT produce a
 *     misleading difference pattern (the old pixel-index subtraction does);
 *   - 180°-flipped orientations and different pixel scales register;
 *   - a deliberately introduced source change remains detectable after
 *     alignment and normalization;
 *   - invalid/missing WCS triggers the documented feature fallback, and
 *     unrecoverable cases fail explicitly instead of fabricating a result;
 *   - wavelength-incompatible pairs are blocked before any science runs.
 */

import { describe, expect, test } from "bun:test";
import { readSpherexFits } from "@/lib/spherex/fits";
import { comparePipeline, type ObsMeta } from "@/lib/spherex/compare-pipeline";
import { computeDifference } from "@/lib/spherex/imageproc";
import { buildFits } from "./helpers/fits-builder";
import { makeCatalog, renderScene, type CatalogStar } from "./helpers/scene";
import { parseWcs, type Wcs } from "@/lib/spherex/wcs";
import { cdFromScalePa } from "./helpers/fits-builder";

const W = 96, H = 96;
const CENTER = { ra: 150, dec: 2 };

/** Construct the Wcs directly (CD form) — matches how buildFits encodes it. */
function synthWcs(scaleDeg: number, paDeg: number, crpix: [number, number], crval: [number, number]): Wcs {
  const cd = cdFromScalePa(scaleDeg, paDeg);
  const empty = new Map<string, number>();
  return {
    ctype: ["RA---TAN", "DEC--TAN"], projection: "TAN", hasSip: false, cd,
    crpix, crval, cunit: ["deg", "deg"], lonpole: 180, latpole: 90,
    radesys: "ICRS", equinox: null,
    sipA: empty, sipB: empty, sipAp: empty, sipBp: empty,
  };
}

const meta = (band = "SPHEREx-D2", wlMin = 1.13, wlMax = 1.68): ObsMeta => ({
  obsId: "SYNTH",
  band,
  wlMinUm: wlMin,
  wlMaxUm: wlMax,
  calibLevel: 2,
  releaseIso: "2026-01-01T00:00:00Z",
  dateMjd: 61000.5,
  exposureS: 113.5,
});

/** Build a synthetic observation: a catalog rendered through a WCS that may
 *  be BIASED relative to the header (simulating an astrometric offset),
 *  serialized to a FITS buffer and parsed back through the real reader. */
function makeObs(
  spec: { scaleDeg: number; paDeg: number; crpix: [number, number]; sip?: boolean },
  cat: CatalogStar[],
  opts: {
    extraStars?: CatalogStar[];
    background?: number;
    fluxScale?: number;
    seed: number;
    /** PSF sigma in pixels (default 0.75; pass scale-adjusted values to keep
     *  the SKY PSF constant between different pixel scales) */
    psfSigma?: number;
    /** content offset (px) NOT declared in the header — astrometric error */
    renderBias?: [number, number];
    omitWcs?: boolean;
  },
) {
  const headerSpec = {
    scaleDeg: spec.scaleDeg,
    paDeg: spec.paDeg,
    crpix: spec.crpix,
    crval: [CENTER.ra, CENTER.dec] as [number, number],
    sip: spec.sip ?? false,
    omit: opts.omitWcs ?? false,
  };
  let renderWcs: Wcs;
  if (spec.sip) {
    // SIP headers need the parsed polynomial set — round-trip via the builder
    const dummy = buildFits({ width: W, height: H, image: new Float32Array(W * H), wcs: headerSpec });
    const st = parseWcs(readSpherexFits(dummy).header);
    if (!st.ok) throw new Error("test WCS failed to parse");
    renderWcs = st.wcs;
  } else {
    renderWcs = synthWcs(spec.scaleDeg, spec.paDeg, spec.crpix, headerSpec.crval);
  }
  if (opts.renderBias) {
    renderWcs = { ...renderWcs, crpix: [renderWcs.crpix[0] + opts.renderBias[0], renderWcs.crpix[1] + opts.renderBias[1]] };
  }
  const scene = renderScene(cat, renderWcs, {
    width: W, height: H,
    psfSigma: opts.psfSigma ?? 0.75,
    background: opts.background ?? 0.1,
    fluxScale: opts.fluxScale ?? 1,
    noiseSigma: 0.02,
    seed: opts.seed,
    extraStars: opts.extraStars,
  });
  const buf = buildFits({ width: W, height: H, image: scene.image, wcs: headerSpec });
  return readSpherexFits(buf);
}

const cat = makeCatalog(CENTER.ra, CENTER.dec, 0.14, 42, 99, [8, 60]);

function robustSigma(img: Float32Array): number {
  const finite: number[] = [];
  for (const v of img) if (Number.isFinite(v)) finite.push(v);
  finite.sort((a, b) => a - b);
  const med = finite[Math.floor(0.5 * (finite.length - 1))];
  const abs = finite.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return 1.4826 * abs[Math.floor(0.5 * (abs.length - 1))] + 1e-12;
}

describe("pipeline: known offset is corrected (no misleading difference)", () => {
  test("0.8 px astrometric bias in B is measured, refined away, difference is clean", () => {
    const fa = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 261.4, crpix: [40, 55] }, cat, { seed: 1 });
    // B's content sits (0.8, −0.6) px away from where its header predicts
    const fb = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 261.4, crpix: [40, 55] }, cat, { seed: 2, renderBias: [0.8, -0.6] });

    const res = comparePipeline({ fitsA: fa, fitsB: fb, metaA: meta(), metaB: meta(), ra: CENTER.ra, dec: CENTER.dec, sizeDeg: 0.16 });
    expect(res.ok).toBeTrue();
    if (!res.ok || !res.registration) return;

    // the systematic offset is detected and refined
    expect(res.registration.method).toBe("wcs+stars");
    expect(res.registration.nInliers).toBeGreaterThan(10);
    expect(res.registration.shiftAppliedArcsec).not.toBeNull();
    if (res.registration.shiftAppliedArcsec != null) {
      // |bias| = hypot(0.8, 0.6) = 1.0 px ≈ 6.15"
      expect(res.registration.shiftAppliedArcsec).toBeGreaterThan(4.5);
      expect(res.registration.shiftAppliedArcsec).toBeLessThan(8.0);
    }
    expect(res.registration.rmsPx ?? 1).toBeLessThan(0.5);

    // after alignment+normalization the difference is noise-like, while the
    // OLD pixel-index subtraction of the same pair shows a strong spurious
    // pattern (every star becomes a dipole ~1 px wide).
    const naive = computeDifference(fa.image, fb.image);
    const naiveSig = robustSigma(naive);
    let naiveMax = 0;
    for (const v of naive) if (Number.isFinite(v)) naiveMax = Math.max(naiveMax, Math.abs(v));
    const naivePeakSigmas = naiveMax / naiveSig;
    // pipeline: no candidate should reach even half the naive peak SNR
    const cands = res.difference!.candidates;
    const maxCand = cands.length ? Math.max(...cands.map((c) => c.snr)) : 0;
    expect(maxCand).toBeLessThan(naivePeakSigmas * 0.5);
    // and the pipeline noise stays near the injected noise level
    expect(res.difference!.sigma).toBeLessThan(0.1);
  });
});

describe("pipeline: 180° flip + scale difference registers and transients survive", () => {
  test("flipped, rescaled epochs: injected source detected at the right place", () => {
    // A: PA 261.4°, B: PA 81.3° → 180.1° relative rotation (real SPHEREx case).
    // PSF σ = 1.0 px is well-sampled, isolating the registration math.
    const fa = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 261.4, crpix: [40, 55] }, cat, { seed: 3, psfSigma: 1.0 });
    const transient: CatalogStar = { ra: CENTER.ra + 0.03, dec: CENTER.dec - 0.02, flux: 160 };
    const fb = makeObs(
      { scaleDeg: (6.15 / 3600) * 1.025, paDeg: 81.3, crpix: [70, 30] },
      cat,
      { seed: 4, fluxScale: 0.9, background: 0.35, extraStars: [transient], psfSigma: 1.0 / 1.025 },
    );

    const res = comparePipeline({ fitsA: fa, fitsB: fb, metaA: meta(), metaB: meta(), ra: CENTER.ra, dec: CENTER.dec, sizeDeg: 0.16 });
    expect(res.ok).toBeTrue();
    if (!res.ok || !res.registration) return;
    expect(res.registration.method).toBe("wcs+stars");
    expect(res.registration.status).toBe("ok");
    expect(res.registration.nInliers).toBeGreaterThan(10);
    expect(res.registration.rmsPx ?? 1).toBeLessThan(0.6);

    // photometric normalization: the recovered α is the PIXEL-VALUE ratio on
    // the common grid — the true flux ratio (1/0.9) times the pixel-area
    // factor (6.15/6.3)², because the synthetic renderer bakes each frame's
    // pixel scale into its values and the subtraction operates on values.
    // What matters scientifically: this α makes constant sources cancel
    // (verified by the candidate assertions below).
    expect(res.normalization!.scale).toBeGreaterThan(1.02);
    expect(res.normalization!.scale).toBeLessThan(1.15);
    expect(res.normalization!.method).toBe("stars");

    // the injected transient is found at its expected position, with the
    // correct sign, and DOMINATES the candidate list (PSF/interpolation
    // residuals at constant stars stay far below it)
    const cands = res.difference!.candidates;
    expect(cands.length).toBeGreaterThanOrEqual(1);
    const scaleOut = res.registration.outputScaleArcsec / 3600;
    // output grid is north-up, EAST-LEFT (CD = [[-s,0],[0,s]]): x decreases
    // with RA, y decreases with Dec
    const dxPix = ((transient.ra - CENTER.ra) * Math.cos((CENTER.dec * Math.PI) / 180)) / scaleOut;
    const dyPix = -(transient.dec - CENTER.dec) / scaleOut;
    const expectX = res.grid!.width / 2 - dxPix;
    const expectY = res.grid!.height / 2 + dyPix;
    let bestDist = Infinity;
    let best = cands[0];
    for (const c of cands) {
      const d = Math.hypot(c.x - expectX, c.y - expectY);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    expect(bestDist).toBeLessThan(3);
    expect(best.sign).toBe("negative");
    expect(best.snr).toBeGreaterThan(10);
    // the transient must be the single brightest difference source
    expect(best.snr).toBeGreaterThanOrEqual(Math.max(...cands.map((c) => c.snr)));
    // sky coordinates are trustworthy on the common grid
    expect(best.ra).not.toBeNull();
    if (best.ra != null && best.dec != null) {
      expect(Math.abs(best.ra - transient.ra)).toBeLessThan(0.005);
      expect(Math.abs(best.dec - transient.dec)).toBeLessThan(0.005);
    }
  });

  test("identical content through different geometry produces no bright false candidates", () => {
    // well-sampled PSF (σ = 1.1 px): any remaining candidates would be
    // registration failures — the geometry alone (180° flip + 2.5% scale)
    // must NOT create them
    const fa = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 261.4, crpix: [40, 55] }, cat, { seed: 5, psfSigma: 1.1 });
    const fb = makeObs(
      { scaleDeg: (6.15 / 3600) * 1.025, paDeg: 81.3, crpix: [70, 30] },
      cat,
      { seed: 6, psfSigma: 1.1 / 1.025 },
    );
    const res = comparePipeline({ fitsA: fa, fitsB: fb, metaA: meta(), metaB: meta(), ra: CENTER.ra, dec: CENTER.dec, sizeDeg: 0.16 });
    expect(res.ok).toBeTrue();
    if (!res.ok) return;
    const bright = res.difference!.candidates.filter((c) => c.snr > 15);
    expect(bright.length).toBe(0);
  });
});

describe("pipeline: WCS fallbacks and failures", () => {
  test("missing WCS on one image → documented feature-based registration", () => {
    const fa = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 261.4, crpix: [40, 55] }, cat, { seed: 7 });
    const fb = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 81.3, crpix: [70, 30] }, cat, { seed: 8, omitWcs: true });
    const res = comparePipeline({ fitsA: fa, fitsB: fb, metaA: meta(), metaB: meta(), ra: CENTER.ra, dec: CENTER.dec, sizeDeg: 0.16 });
    expect(res.ok).toBeTrue();
    if (!res.ok || !res.registration) return;
    expect(res.registration.method).toBe("feature");
    expect(res.registration.nInliers).toBeGreaterThan(5);
    expect(res.warnings.join(" ")).toContain("geometric");
  });

  test("too few stars and no WCS → explicit blocked result (never fabricated)", () => {
    const small = makeCatalog(CENTER.ra, CENTER.dec, 0.14, 2, 55, [8, 60]);
    const fa = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 30, crpix: [48.5, 48.5] }, small, { seed: 9 });
    const fb = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 30, crpix: [48.5, 48.5] }, small, { seed: 10, omitWcs: true });
    const res = comparePipeline({ fitsA: fa, fitsB: fb, metaA: meta(), metaB: meta(), ra: CENTER.ra, dec: CENTER.dec, sizeDeg: 0.16 });
    expect(res.ok).toBeFalse();
    expect(res.blockedReason).toContain("Registration not possible");
  });

  test("wavelength-incompatible bands are blocked before processing", () => {
    const fa = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 30, crpix: [48.5, 48.5] }, cat, { seed: 11 });
    const fb = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 30, crpix: [48.5, 48.5] }, cat, { seed: 12 });
    const res = comparePipeline({
      fitsA: fa, fitsB: fb,
      metaA: meta("SPHEREx-D2", 1.13, 1.68),
      metaB: meta("SPHEREx-D4", 2.42, 3.82),
      ra: CENTER.ra, dec: CENTER.dec, sizeDeg: 0.16,
    });
    expect(res.ok).toBeFalse();
    expect(res.blockedReason).toContain("not scientifically valid");
    expect(res.bandCompatibility!.compatible).toBeFalse();
  });

  test("SIP-bearing headers register (full TAN-SIP path)", () => {
    const fa = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 261.4, crpix: [40, 55], sip: true }, cat, { seed: 13 });
    const fb = makeObs({ scaleDeg: 6.15 / 3600, paDeg: 81.3, crpix: [70, 30], sip: true }, cat, { seed: 14 });
    const res = comparePipeline({ fitsA: fa, fitsB: fb, metaA: meta(), metaB: meta(), ra: CENTER.ra, dec: CENTER.dec, sizeDeg: 0.16 });
    expect(res.ok).toBeTrue();
    if (!res.ok || !res.registration) return;
    expect(res.registration.wcsA).toBe("ok");
    expect(res.registration.wcsB).toBe("ok");
    expect(res.registration.nInliers).toBeGreaterThan(8);
  });
});
