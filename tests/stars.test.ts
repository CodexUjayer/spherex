/// <reference types="bun-types" />
/**
 * Point-source detection & matching tests (Task 9.6): detection on
 * synthetic scenes, WCS matching with outliers, MAD-based shift estimation,
 * triangle fallback (rotation + scale), insufficient stars → explicit
 * failure.
 */

import { describe, expect, test } from "bun:test";
import {
  detectSources, matchWithWcs, matchByTriangles, fitSimilarity, applySim,
} from "@/lib/spherex/stars";
import { makeTanWcs, type Wcs } from "@/lib/spherex/wcs";
import { makeCatalog, renderScene } from "./helpers/scene";
import { skyToPix } from "@/lib/spherex/wcs";

function scene(wcs: Wcs, W: number, H: number, seed: number, nStars = 40) {
  const cat = makeCatalog(150, 2, 0.14, nStars, seed, [8, 60]);
  const r = renderScene(cat, wcs, { width: W, height: H, psfSigma: 0.7, noiseSigma: 0.02, seed: seed + 1 });
  return { cat, ...r };
}

describe("detectSources", () => {
  const W = 96, H = 96;
  const wcs = makeTanWcs(150, 2, 6.15 / 3600, W, H);
  test("finds most catalog stars with accurate centroids", () => {
    const { cat, image, valid } = scene(wcs, W, H, 42);
    const stars = detectSources(image, valid, W, H, { fwhmPx: 1.65 });
    expect(stars.length).toBeGreaterThan(20);
    // each detected star should be near a catalog position
    let matched = 0;
    for (const s of stars) {
      for (const c of cat) {
        const p = skyToPix(wcs, c.ra, c.dec);
        if (Math.hypot(p.x - s.x, p.y - s.y) < 0.5) { matched++; break; }
      }
    }
    expect(matched / stars.length).toBeGreaterThan(0.9);
  });

  test("too few sources on an empty image", () => {
    const stars = detectSources(new Float32Array(W * H), new Uint8Array(W * H).fill(1), W, H);
    expect(stars.length).toBe(0);
  });
});

describe("matchWithWcs", () => {
  const W = 96, H = 96;
  const wcsA = makeTanWcs(150, 2, 6.15 / 3600, W, H);
  test("matches the same catalog viewed through a different WCS", () => {
    // B: flipped orientation + small shift, same sky content
    const cat = makeCatalog(150, 2, 0.14, 40, 7, [8, 60]);
    const a = renderScene(cat, wcsA, { width: W, height: H, psfSigma: 0.7, noiseSigma: 0.02, seed: 8 });
    const wcsB = makeTanWcs(150, 2, 6.3 / 3600, W, H);
    // rotate B 180°: crpix shift + cd flip — approximate via pa=180 offset
    const wcsB2: Wcs = { ...wcsB, cd: [[-wcsB.cd[0][0], -wcsB.cd[0][1]], [-wcsB.cd[1][0], -wcsB.cd[1][1]]] };
    const b = renderScene(cat, wcsB2, { width: W, height: H, psfSigma: 0.7, noiseSigma: 0.02, seed: 9 });
    const starsA = detectSources(a.image, a.valid, W, H, { fwhmPx: 1.65 });
    const starsB = detectSources(b.image, b.valid, W, H, { fwhmPx: 1.65 });
    const m = matchWithWcs(starsA, starsB, wcsA, wcsB2);
    expect(m.status).not.toBe("failed");
    expect(m.nMatched).toBeGreaterThan(10);
    expect(m.rmsPx).toBeLessThan(0.6);
  });

  test("measures and reports a systematic 0.8 px offset", () => {
    const cat = makeCatalog(150, 2, 0.14, 40, 11, [8, 60]);
    const a = renderScene(cat, wcsA, { width: W, height: H, psfSigma: 0.7, noiseSigma: 0.02, seed: 12 });
    // B's CONTENT is rendered through a biased WCS: its stars sit (0.8, −0.6) px
    // away from where the UNBIASED header would predict them.
    const biased: Wcs = { ...wcsA, crpix: [wcsA.crpix[0] + 0.8, wcsA.crpix[1] - 0.6] };
    const b = renderScene(cat, biased, { width: W, height: H, psfSigma: 0.7, noiseSigma: 0.02, seed: 13 });
    const starsA = detectSources(a.image, a.valid, W, H, { fwhmPx: 1.65 });
    const starsB = detectSources(b.image, b.valid, W, H, { fwhmPx: 1.65 });
    // predict B positions with the (unbiased) declared WCS → residual = +0.8, −0.6
    const m = matchWithWcs(starsA, starsB, wcsA, wcsA);
    expect(m.nInliers).toBeGreaterThan(5);
    expect(Math.abs(m.shift.dx - 0.8)).toBeLessThan(0.25);
    expect(Math.abs(m.shift.dy + 0.6)).toBeLessThan(0.25);
  });

  test("insufficient stars → explicit failed status", () => {
    const cat = makeCatalog(150, 2, 0.14, 2, 3, [8, 60]);
    const a = renderScene(cat, wcsA, { width: W, height: H, psfSigma: 0.7, noiseSigma: 0.02, seed: 14 });
    const b = renderScene(cat, wcsA, { width: W, height: H, psfSigma: 0.7, noiseSigma: 0.02, seed: 15 });
    const starsA = detectSources(a.image, a.valid, W, H, { fwhmPx: 1.65 });
    const starsB = detectSources(b.image, b.valid, W, H, { fwhmPx: 1.65 });
    const m = matchWithWcs(starsA, starsB, wcsA, wcsA);
    expect(m.status).toBe("failed");
    expect(m.nMatched).toBeLessThanOrEqual(2);
  });
});

describe("matchByTriangles (no-WCS fallback)", () => {
  const W = 96, H = 96;
  const wcsA = makeTanWcs(150, 2, 6.15 / 3600, W, H);
  const cat = makeCatalog(150, 2, 0.12, 30, 21, [8, 60]);

  test("recovers a 180° rotation + 3% scale difference", () => {
    const a = renderScene(cat, wcsA, { width: W, height: H, psfSigma: 0.7, noiseSigma: 0.02, seed: 22 });
    const wcsB: Wcs = { ...makeTanWcs(150, 2, (6.15 / 3600) * 1.03, W, H) };
    const wcsB2: Wcs = { ...wcsB, cd: [[-wcsB.cd[0][0], -wcsB.cd[0][1]], [-wcsB.cd[1][0], -wcsB.cd[1][1]]] };
    const b = renderScene(cat, wcsB2, { width: W, height: H, psfSigma: 0.72, noiseSigma: 0.02, seed: 23 });
    const starsA = detectSources(a.image, a.valid, W, H, { fwhmPx: 1.65 });
    const starsB = detectSources(b.image, b.valid, W, H, { fwhmPx: 1.65 });
    const m = matchByTriangles(starsA, starsB);
    expect(m.status).not.toBe("failed");
    expect(m.transform).not.toBeNull();
    if (!m.transform) return;
    expect(m.nInliers).toBeGreaterThan(8);
    // recovered scale ≈ 1/1.03 (A→B direction) and rotation ≈ 180°
    expect(Math.abs(m.transform.scale - 1 / 1.03)).toBeLessThan(0.02);
    const rot = Math.abs(((m.transform.rotDeg % 360) + 360) % 360 - 180);
    expect(Math.min(rot, 360 - rot)).toBeLessThan(2);
    expect(m.rmsPx).toBeLessThan(1.2);
  });

  test("fails explicitly when there are too few sources", () => {
    const small = makeCatalog(150, 2, 0.12, 2, 24, [8, 60]);
    const a = renderScene(small, wcsA, { width: W, height: H, psfSigma: 0.7, noiseSigma: 0.02, seed: 25 });
    const b = renderScene(small, wcsA, { width: W, height: H, psfSigma: 0.7, noiseSigma: 0.02, seed: 26 });
    const starsA = detectSources(a.image, a.valid, W, H);
    const starsB = detectSources(b.image, b.valid, W, H);
    const m = matchByTriangles(starsA, starsB);
    expect(m.status).toBe("failed");
    expect(m.transform).toBeNull();
  });
});

describe("fitSimilarity", () => {
  test("exact least-squares recovery of a known similarity", () => {
    const pts = Array.from({ length: 12 }, (_, i) => ({ x: 10 + i * 5, y: 5 + ((i * 37) % 80) }));
    const t: Parameters<typeof applySim>[0] = {
      a: 1.03 * Math.cos((32 * Math.PI) / 180), b: 1.03 * Math.sin((32 * Math.PI) / 180),
      c: 0, d: 0, tx: 4, ty: -7, scale: 1.03, rotDeg: 32,
    };
    t.c = t.b; t.d = t.a;
    const mapped = pts.map((p) => applySim(t, p.x, p.y));
    const fit = fitSimilarity(pts, mapped);
    expect(fit).not.toBeNull();
    if (!fit) return;
    expect(Math.abs(fit.scale - 1.03)).toBeLessThan(1e-9);
    const err = pts.map((p, i) => {
      const q = applySim(fit, p.x, p.y);
      return Math.hypot(q.x - mapped[i].x, q.y - mapped[i].y);
    });
    expect(Math.max(...err)).toBeLessThan(1e-6);
  });
});
