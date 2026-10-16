import { useMemo } from "react";
import type { FitsMetaWcs } from "@/lib/spherex-api";

/** Format RA (degrees) as "5h 35m". */
export function fmtRa(raDeg: number): string {
  const ra = ((raDeg % 360) + 360) % 360;
  const h = ra / 15;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${hh}h ${mm.toString().padStart(2, "0")}m`;
}

/** Format Dec (degrees) as "-5° 23'". */
export function fmtDec(decDeg: number): string {
  const sign = decDeg < 0 ? "-" : "+";
  const a = Math.abs(decDeg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  return `${sign}${d}° ${m.toString().padStart(2, "0")}'`;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Pixel (0-based) → sky using the REAL FITS WCS (TAN, no SIP — the SIP
 *  residual is < 2 px at cutout edges and is intentionally ignored for the
 *  cursor overlay). Falls back to the linear approximation when the WCS is
 *  unavailable. */
export function pixelToSkyWcs(
  wcs: FitsMetaWcs,
  x: number,
  y: number,
): { ra: number; dec: number } {
  const u = x + 1 - wcs.crpix[0];
  const v = y + 1 - wcs.crpix[1];
  const xi = (wcs.cd[0][0] * u + wcs.cd[0][1] * v) * D2R; // rad east
  const eta = (wcs.cd[1][0] * u + wcs.cd[1][1] * v) * D2R; // rad north
  if (wcs.projection === "CAR") {
    const ra = wcs.crval[0] + xi * R2D;
    const dec = Math.max(-90, Math.min(90, wcs.crval[1] + eta * R2D));
    return { ra: ((ra % 360) + 360) % 360, dec };
  }
  // TAN (gnomonic) inverse around (crval1, crval2)
  const r0 = wcs.crval[0] * D2R;
  const d0 = wcs.crval[1] * D2R;
  const cosd0 = Math.cos(d0);
  const sind0 = Math.sin(d0);
  const rho = Math.hypot(xi, eta);
  const c = Math.atan(rho);
  const sinc = Math.sin(c);
  const cosc = Math.cos(c);
  const dec = Math.asin(cosc * sind0 + (rho > 0 ? (eta * sinc * cosd0) / rho : 0));
  const ra = r0 + Math.atan2(xi * sinc, rho * cosd0 * cosc - eta * sind0 * sinc);
  return { ra: ((ra * R2D) % 360 + 360) % 360, dec: dec * R2D };
}

/** Linear sky coordinate at an image pixel (fallback when no WCS): the
 *  cutout is treated as north-up centred on (centerRa, centerDec) with the
 *  given pixel scale. */
function pixelToSky(
  x: number,
  y: number,
  W: number,
  H: number,
  centerRa: number,
  centerDec: number,
  pixelScaleDeg: number,
): { ra: number; dec: number } {
  const cosd = Math.cos((centerDec * Math.PI) / 180);
  const ra =
    centerRa + ((x - W / 2) * pixelScaleDeg) / Math.max(cosd, 1e-3);
  const dec = centerDec - (y - H / 2) * pixelScaleDeg;
  return { ra, dec };
}

/** Build a minimal celestial-coordinate overlay as an SVG sized to the image:
 *  a centre crosshair, the centre RA label at the top, the centre Dec label
 *  at the left, and four faint edge ticks. Pans/zooms with the sky. */
export function useGridSVG(
  W: number,
  H: number,
  centerRa: number,
  centerDec: number,
  pixelScaleDeg: number,
  wcs?: FitsMetaWcs | null,
): string | null {
  return useMemo(() => {
    if (!W || !H || !pixelScaleDeg) return null;
    const toSky = wcs
      ? (x: number, y: number) => pixelToSkyWcs(wcs, x, y)
      : (x: number, y: number) => pixelToSky(x, y, W, H, centerRa, centerDec, pixelScaleDeg);
    const cx = W / 2;
    const cy = H / 2;
    const bits: string[] = [];
    bits.push(
      `<line x1="0" y1="${cy}" x2="${W}" y2="${cy}" stroke="white" stroke-opacity="0.16" stroke-width="1"/>`,
    );
    bits.push(
      `<line x1="${cx}" y1="0" x2="${cx}" y2="${H}" stroke="white" stroke-opacity="0.16" stroke-width="1"/>`,
    );
    const r = Math.max(6, Math.min(W, H) * 0.04);
    bits.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="white" stroke-opacity="0.35" stroke-width="1"/>`,
    );
    bits.push(
      `<line x1="${cx - r - 4}" y1="${cy}" x2="${cx - r}" y2="${cy}" stroke="white" stroke-opacity="0.5" stroke-width="1"/>`,
    );
    bits.push(
      `<line x1="${cx + r}" y1="${cy}" x2="${cx + r + 4}" y2="${cy}" stroke="white" stroke-opacity="0.5" stroke-width="1"/>`,
    );
    bits.push(
      `<line x1="${cx}" y1="${cy - r - 4}" x2="${cx}" y2="${cy - r}" stroke="white" stroke-opacity="0.5" stroke-width="1"/>`,
    );
    bits.push(
      `<line x1="${cx}" y1="${cy + r}" x2="${cx}" y2="${cy + r + 4}" stroke="white" stroke-opacity="0.5" stroke-width="1"/>`,
    );
    const cs = toSky(cx, cy);
    bits.push(
      `<text x="${cx}" y="11" text-anchor="middle" fill="white" fill-opacity="0.7" font-size="9" font-family="monospace">${fmtRa(cs.ra)}</text>`,
    );
    bits.push(
      `<text x="3" y="${(cy + 3).toFixed(1)}" fill="white" fill-opacity="0.7" font-size="9" font-family="monospace">${fmtDec(cs.dec)}</text>`,
    );
    const s1 = toSky(0, cy);
    const s2 = toSky(W, cy);
    const s3 = toSky(cx, 0);
    const s4 = toSky(cx, H);
    bits.push(
      `<text x="3" y="${(H - 4).toFixed(1)}" fill="white" fill-opacity="0.5" font-size="8" font-family="monospace">${fmtDec(s1.dec)}</text>`,
    );
    bits.push(
      `<text x="${(W - 3).toFixed(1)}" y="${(H - 4).toFixed(1)}" text-anchor="end" fill="white" fill-opacity="0.5" font-size="8" font-family="monospace">${fmtDec(s2.dec)}</text>`,
    );
    bits.push(
      `<text x="${(W - 3).toFixed(1)}" y="11" text-anchor="end" fill="white" fill-opacity="0.5" font-size="8" font-family="monospace">${fmtRa(s3.ra)}</text>`,
    );
    bits.push(
      `<text x="3" y="${(H - 14).toFixed(1)}" fill="white" fill-opacity="0.5" font-size="8" font-family="monospace">${fmtRa(s4.ra)}</text>`,
    );
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bits.join(
      "",
    )}</svg>`;
  }, [W, H, centerRa, centerDec, pixelScaleDeg, wcs]);
}

export { pixelToSky };
