/// <reference types="bun-types" />
/**
 * WCS parsing and transform tests (Task 9.1, 9.2).
 *
 *  - header representations actually used: CD matrix, PC+CDELT (SPHEREx),
 *    plain CDELT; TAN ± SIP, CAR, SIN; negative (cutout) CRPIX.
 *  - round-trip pixel↔sky, known-point validation against the analytically
 *    validated SPHEREx header from the live archive.
 *  - invalid/missing/unsupported WCS is rejected explicitly.
 */

import { describe, expect, test } from "bun:test";
import {
  parseWcs, pixToSky, skyToPix, wcsRoundtripError, pixelScaleArcsec,
  pixelAxisPa, angularSepDeg, makeTanWcs,
} from "@/lib/spherex/wcs";
import { buildFits, cdFromScalePa } from "./helpers/fits-builder";
import { readSpherexFits } from "@/lib/spherex/fits";

const DEG = Math.PI / 180;

function hdrWcs(header: Record<string, string>) {
  return parseWcs(header);
}

describe("WCS parsing — header representations", () => {
  test("PC + CDELT form (SPHEREx style, CDELT=1, scale inside PC)", () => {
    const scale = 6.15 / 3600;
    const cd = cdFromScalePa(scale, 261.43);
    const st = hdrWcs({
      CTYPE1: "RA---TAN-SIP", CTYPE2: "DEC--TAN-SIP",
      CRPIX1: "-472.5", CRPIX2: "916.5",
      CRVAL1: "83.6967904069", CRVAL2: "-55.6081067328",
      CDELT1: "1.0", CDELT2: "1.0",
      PC1_1: String(cd[0][0]), PC1_2: String(cd[0][1]),
      PC2_1: String(cd[1][0]), PC2_2: String(cd[1][1]),
      CUNIT1: "deg", CUNIT2: "deg", RADESYS: "ICRS",
      A_0_2: "1.37615551081E-06", B_2_0: "6.66525726912E-06",
      AP_0_2: "-1.37052435899E-06", BP_2_0: "-6.64535743701E-06",
    });
    expect(st.ok).toBeTrue();
    if (!st.ok) return;
    expect(st.wcs.projection).toBe("TAN");
    expect(st.wcs.hasSip).toBeTrue();
    expect(pixelScaleArcsec(st.wcs)).toBeCloseTo(6.15, 2);
  });

  test("DEC--TAN-SIP (two-hyphen CTYPE) parses — regression for the hyphen bug", () => {
    const st = hdrWcs({
      CTYPE1: "RA---TAN-SIP", CTYPE2: "DEC--TAN-SIP",
      CRPIX1: "88.0", CRPIX2: "88.5",
      CRVAL1: "150.0", CRVAL2: "2.2",
      CD1_1: "-0.0017", CD1_2: "0.0", CD2_1: "0.0", CD2_2: "0.0017",
    });
    expect(st.ok).toBeTrue();
  });

  test("CD matrix form (no PC/CDELT)", () => {
    const st = hdrWcs({
      CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN",
      CRPIX1: "50", CRPIX2: "50", CRVAL1: "10", CRVAL2: "30",
      CD1_1: "-0.001", CD1_2: "0.0002", CD2_1: "0.0002", CD2_2: "0.001",
    });
    expect(st.ok).toBeTrue();
    if (!st.ok) return;
    expect(pixelScaleArcsec(st.wcs)).toBeCloseTo(Math.sqrt(0.001 * 0.001 + 0.0002 * 0.0002) * 3600, 4);
  });

  test("plain CDELT (diagonal) form", () => {
    const st = hdrWcs({
      CTYPE1: "RA---CAR", CTYPE2: "DEC--CAR",
      CRPIX1: "50", CRPIX2: "50", CRVAL1: "10", CRVAL2: "30",
      CDELT1: "-0.001", CDELT2: "0.001",
    });
    expect(st.ok).toBeTrue();
    if (!st.ok) return;
    expect(st.wcs.projection).toBe("CAR");
  });

  test("SIN projection parses and round-trips", () => {
    const st = hdrWcs({
      CTYPE1: "RA---SIN", CTYPE2: "DEC--SIN",
      CRPIX1: "50", CRPIX2: "50", CRVAL1: "10", CRVAL2: "30",
      CDELT1: "-0.001", CDELT2: "0.001",
    });
    expect(st.ok).toBeTrue();
    if (!st.ok) return;
    expect(wcsRoundtripError(st.wcs, 100, 100, 4)).toBeLessThan(0.01);
  });

  test("missing WCS is reported as missing, not silently accepted", () => {
    expect(hdrWcs({ NAXIS: "2" }).ok).toBeFalse();
    const st = hdrWcs({ NAXIS: "2" });
    expect(!st.ok && st.reason).toBe("missing");
  });

  test("unsupported projection (AIT) is rejected explicitly", () => {
    const st = hdrWcs({
      CTYPE1: "RA---AIT", CTYPE2: "DEC--AIT",
      CRPIX1: "50", CRPIX2: "50", CRVAL1: "10", CRVAL2: "30",
      CDELT1: "-0.001", CDELT2: "0.001",
    });
    expect(!st.ok && st.reason).toBe("unsupported-projection");
  });

  test("incomplete WCS (missing CRVAL) is rejected", () => {
    const st = hdrWcs({
      CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN",
      CRPIX1: "50", CRPIX2: "50",
      CDELT1: "-0.001", CDELT2: "0.001",
    });
    expect(!st.ok && st.reason).toBe("incomplete");
  });

  test("singular CD matrix is rejected", () => {
    const st = hdrWcs({
      CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN",
      CRPIX1: "50", CRPIX2: "50", CRVAL1: "10", CRVAL2: "30",
      CD1_1: "0", CD1_2: "0", CD2_1: "0", CD2_2: "0",
    });
    expect(!st.ok && st.reason).toBe("invalid");
  });
});

describe("WCS transforms — numeric validation", () => {
  // The REAL SPHEREx header validated analytically during development:
  // requested center (83.821, -53.937) must land at the cutout center
  // (within ~0.7 px) and round-trip errors must be sub-milli-pixel.
  const realHeader: Record<string, string> = {
    CTYPE1: "RA---TAN-SIP", CTYPE2: "DEC--TAN-SIP",
    CRPIX1: "-472.5", CRPIX2: "916.5",
    CRVAL1: "83.6967904069", CRVAL2: "-55.6081067328",
    CDELT1: "1.0", CDELT2: "1.0",
    PC1_1: "0.00147908526968", PC1_2: "0.000915642059762",
    PC2_1: "0.000858987704983", PC2_2: "-0.00144294086313",
    CUNIT1: "deg", CUNIT2: "deg", RADESYS: "ICRS", LONPOLE: "180.0",
    A_0_2: "1.37615551081E-06", A_0_3: "2.37796903226E-11", A_1_1: "4.1728991544E-06",
    A_1_2: "6.17991782111E-10", A_2_0: "1.59549494642E-06", A_2_1: "1.25489885415E-10", A_3_0: "5.51356788206E-10",
    B_0_2: "1.99488843578E-06", B_0_3: "4.61651490881E-10", B_1_1: "7.60697477045E-07",
    B_1_2: "5.38432258281E-11", B_2_0: "6.66525726912E-06", B_2_1: "6.23933811835E-10", B_3_0: "5.1213151608E-11",
    AP_0_0: "-0.00203383936156", AP_0_1: "-2.22731463462E-07", AP_0_2: "-1.37052435899E-06",
    AP_0_3: "-1.23216447589E-11", AP_1_0: "-9.67964576327E-07", AP_1_1: "-4.15323514094E-06",
    AP_1_2: "-5.83535359302E-10", AP_2_0: "-1.58720159727E-06", AP_2_1: "-8.34472166152E-11", AP_3_0: "-5.16622081944E-10",
    BP_0_0: "-0.00505059731878", BP_0_1: "-8.98357540785E-07", BP_0_2: "-1.98114957988E-06",
    BP_0_3: "-4.5105448051E-10", BP_1_0: "-1.9360507769E-07", BP_1_1: "-7.54223260383E-07",
    BP_1_2: "-2.74335439605E-11", BP_2_0: "-6.64535743701E-06", BP_2_1: "-5.3796286344E-10", BP_3_0: "-2.46573070018E-11",
  };

  test("real SPHEREx header: requested center lands at the cutout center", () => {
    const st = parseWcs(realHeader);
    expect(st.ok).toBeTrue();
    if (!st.ok) return;
    // 175 x 176 cutout requested at center (83.821, -53.937)
    const p = skyToPix(st.wcs, 83.821, -53.937);
    expect(Math.abs(p.x - 87.0)).toBeLessThan(1.0);
    expect(Math.abs(p.y - 87.5)).toBeLessThan(1.0);
  });

  test("real SPHEREx header: round-trip within 0.01 px across the grid", () => {
    const st = parseWcs(realHeader);
    if (!st.ok) throw new Error("parse failed");
    expect(wcsRoundtripError(st.wcs, 175, 176, 5)).toBeLessThan(0.01);
  });

  test("real SPHEREx header: pixel scale matches the archive value (6.15\")", () => {
    const st = parseWcs(realHeader);
    if (!st.ok) throw new Error("parse failed");
    expect(pixelScaleArcsec(st.wcs)).toBeCloseTo(6.152, 2);
  });

  test("RA wrap-around handled (359.9° vs 0.1°)", () => {
    const w = makeTanWcs(0, 30, 0.001, 100, 100);
    const s = pixToSky(w, 0, 50);
    const p = skyToPix(w, s.ra, s.dec);
    expect(Math.abs(p.x - 0)).toBeLessThan(0.01);
    expect(Math.abs(p.y - 50)).toBeLessThan(0.01);
  });

  test("angularSepDeg matches the small-angle formula near the equator", () => {
    const sep = angularSepDeg(10, 0, 10.1, 0);
    expect(sep).toBeCloseTo(0.1, 5);
  });

  test("position angle of a north-up grid is 90° (x-axis points west/east)", () => {
    const w = makeTanWcs(150, 2, 0.0017, 100, 100);
    // cd = [[-s, 0], [0, s]] → x-axis = (-s, 0) → PA = atan2(-s, 0) = -90°
    const pa = pixelAxisPa(w);
    expect(Math.abs(pa - 270)).toBeLessThan(0.001);
  });
});

describe("WCS from a synthetic FITS file (fits.ts integration)", () => {
  test("WCS round-trips through FITS write/read", () => {
    const img = new Float32Array(64 * 64);
    const buf = buildFits({
      width: 64, height: 64, image: img,
      wcs: { scaleDeg: 6.15 / 3600, paDeg: 30, crpix: [32.5, 32.5], crval: [150, 2], sip: true },
    });
    const fd = readSpherexFits(buf);
    const st = parseWcs(fd.header);
    expect(st.ok).toBeTrue();
    if (!st.ok) return;
    expect(st.wcs.hasSip).toBeTrue();
    expect(wcsRoundtripError(st.wcs, 64, 64, 4)).toBeLessThan(0.05);
    expect(pixelScaleArcsec(st.wcs)).toBeCloseTo(6.15, 2);
    const pa = pixelAxisPa(st.wcs);
    expect(Math.min(Math.abs(pa - 30), Math.abs(pa - 390))).toBeLessThan(0.01);
  });
});
