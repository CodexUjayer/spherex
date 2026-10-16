/// <reference types="bun-types" />
/**
 * Difference-imaging tests (Task 9.7, 9.8): band compatibility, photometric
 * normalization (star-based + robust pixel fit), background offsets,
 * brightness-scale differences, invalid-pixel masking, candidate detection,
 * signed differences.
 */

import { describe, expect, test } from "bun:test";
import {
  checkBandCompat, computeDifferenceSci, scaleFromStars, findCandidates,
} from "@/lib/spherex/diffimg";
import type { Raster } from "@/lib/spherex/reproject";

function rasterFrom(image: Float32Array, W: number, H: number, invalid: number[] = []): Raster {
  const valid = new Uint8Array(W * H).fill(1);
  for (const i of invalid) valid[i] = 0;
  return { image, valid, width: W, height: H };
}

describe("checkBandCompat (wavelength/product compatibility)", () => {
  test("same band and overlapping wavelengths pass", () => {
    const r = checkBandCompat(
      { band: "SPHEREx-D2", wlMinUm: 1.13, wlMaxUm: 1.68, calibLevel: 2 },
      { band: "SPHEREx-D2", wlMinUm: 1.13, wlMaxUm: 1.68, calibLevel: 2 },
    );
    expect(r.compatible).toBeTrue();
    expect(r.overlap).toBeCloseTo(1, 5);
  });

  test("different bands are rejected explicitly", () => {
    const r = checkBandCompat(
      { band: "SPHEREx-D2", wlMinUm: 1.13, wlMaxUm: 1.68, calibLevel: 2 },
      { band: "SPHEREx-D4", wlMinUm: 2.42, wlMaxUm: 3.82, calibLevel: 2 },
    );
    expect(r.compatible).toBeFalse();
    expect(r.reason).toContain("bands differ");
  });

  test("disjoint wavelengths are rejected even with a missing band name", () => {
    const r = checkBandCompat(
      { band: null, wlMinUm: 1.13, wlMaxUm: 1.68, calibLevel: 2 },
      { band: null, wlMinUm: 3.0, wlMaxUm: 3.8, calibLevel: 2 },
    );
    expect(r.compatible).toBeFalse();
    expect(r.reason).toContain("wavelength ranges barely overlap");
  });

  test("mismatched calibration levels are rejected", () => {
    const r = checkBandCompat(
      { band: "SPHEREx-D2", wlMinUm: 1.13, wlMaxUm: 1.68, calibLevel: 2 },
      { band: "SPHEREx-D2", wlMinUm: 1.13, wlMaxUm: 1.68, calibLevel: 3 },
    );
    expect(r.compatible).toBeFalse();
    expect(r.reason).toContain("calibration levels differ");
  });

  test("unknown wavelength metadata with matching band names passes with null overlap", () => {
    const r = checkBandCompat(
      { band: "SPHEREx-D2", wlMinUm: null, wlMaxUm: null, calibLevel: null },
      { band: "SPHEREx-D2", wlMinUm: null, wlMaxUm: null, calibLevel: null },
    );
    expect(r.compatible).toBeTrue();
    expect(r.overlap).toBeNull();
  });
});

describe("scaleFromStars", () => {
  test("recovers a 1.25 flux ratio and rejects an outlier", () => {
    const a = [10, 20, 40, 80, 30];
    const b = [8, 16, 32, 64, 100]; // last one is bogus
    const r = scaleFromStars(a, b);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.scale).toBeCloseTo(1.25, 1);
    expect(r.n).toBeGreaterThanOrEqual(4);
  });

  test("returns null with fewer than 3 stars", () => {
    expect(scaleFromStars([10], [8])).toBeNull();
    expect(scaleFromStars([], [])).toBeNull();
  });
});

describe("computeDifferenceSci", () => {
  const W = 60, H = 60;

  test("normalizes a pure background offset (α=1, β≠0)", () => {
    const a = new Float32Array(W * H);
    const b = new Float32Array(W * H);
    for (let i = 0; i < a.length; i++) {
      a[i] = 0.3 + ((i * 7919) % 97) / 97 * 0.01; // small deterministic variation
      b[i] = 0.3 + ((i * 7919) % 97) / 97 * 0.01 - 0.25; // same sky, -0.25 background
    }
    const ra = rasterFrom(a, W, H);
    const rb = rasterFrom(b, W, H);
    const res = computeDifferenceSci(ra, rb);
    expect(res.normalization.scale).toBeCloseTo(1, 2);
    // after normalization the difference should be ~zero everywhere
    let maxAbs = 0;
    for (const v of res.diff.image) if (Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
    expect(maxAbs).toBeLessThan(1e-6);
    expect(res.candidates.length).toBe(0);
  });

  test("normalizes a global brightness scale (α≠1)", () => {
    const a = new Float32Array(W * H);
    const b = new Float32Array(W * H);
    for (let i = 0; i < a.length; i++) {
      const sky = 0.5 + ((i * 104729) % 89) / 89 * 0.4; // structured scene
      a[i] = sky;
      b[i] = sky * 0.8; // 20% fainter calibration
    }
    const res = computeDifferenceSci(rasterFrom(a, W, H), rasterFrom(b, W, H));
    expect(res.normalization.scale).toBeCloseTo(1 / 0.8, 2);
    let maxAbs = 0;
    for (const v of res.diff.image) if (Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
    expect(maxAbs).toBeLessThan(0.01);
  });

  test("star-based scaling is preferred when matched positions are supplied", () => {
    const a = new Float32Array(W * H).fill(0.1);
    const b = new Float32Array(W * H).fill(0.1);
    // add 4 common "stars" to both images at the same positions, B half as bright
    const positions = [[10, 10], [30, 20], [20, 40], [45, 30]];
    for (const [x, y] of positions) {
      a[y * W + x] += 5;
      b[y * W + x] += 2.5;
    }
    const res = computeDifferenceSci(
      rasterFrom(a, W, H),
      rasterFrom(b, W, H),
      positions.map(([x, y]) => ({ x, y })),
    );
    expect(res.normalization.method).toBe("stars");
    expect(res.normalization.scale).toBeCloseTo(2, 1);
  });

  test("invalid pixels are excluded and stay NaN in the difference", () => {
    const a = new Float32Array(W * H).fill(1);
    const b = new Float32Array(W * H).fill(1);
    const invalid = [100, 101, 200, 340];
    for (const i of invalid) a[i] = 5; // would be a huge false difference if unmasked
    const res = computeDifferenceSci(rasterFrom(a, W, H, invalid), rasterFrom(b, W, H, invalid));
    for (const i of invalid) {
      expect(res.diff.valid[i]).toBe(0);
      expect(Number.isNaN(res.diff.image[i])).toBeTrue();
    }
    expect(res.candidates.find((c) => c.x === 10 && c.y === 10)).toBeUndefined();
  });

  test("a deliberately introduced source is detected with correct sign and position", () => {
    const a = new Float32Array(W * H).fill(0.1);
    const b = new Float32Array(W * H).fill(0.1);
    // transient in B only at (30, 40)
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d2 = dx * dx + dy * dy;
        b[(40 + dy) * W + (30 + dx)] += 6 * Math.exp(-d2 / 1.2);
      }
    }
    const res = computeDifferenceSci(rasterFrom(a, W, H), rasterFrom(b, W, H));
    expect(res.candidates.length).toBeGreaterThanOrEqual(1);
    const c = res.candidates[0];
    expect(c.sign).toBe("negative"); // A − B: B brighter → negative
    expect(Math.hypot(c.x - 30, c.y - 40)).toBeLessThan(2);
  });
});

describe("findCandidates", () => {
  test("requires 5σ and a minimum area", () => {
    const W = 40, H = 40;
    const image = new Float32Array(W * H);
    const valid = new Uint8Array(W * H).fill(1);
    // 3-px faint blob (3σ — should NOT trigger), 6-px bright blob (20σ — should)
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) image[(10 + dy) * W + (10 + dx)] = 3;
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) image[(30 + dy) * W + (5 + dx)] = 20;
    const r: Raster = { image, valid, width: W, height: H };
    const cands = findCandidates(r, 1.0, 5, 4);
    expect(cands.length).toBe(1);
    expect(cands[0].sign).toBe("positive");
    expect(cands[0].snr).toBeCloseTo(20, 1);
  });
});
