/**
 * SPHEREx two-epoch comparison pipeline (pure, network-free, testable).
 *
 * Given two parsed SPHEREx cutouts (FITS IMAGE/FLAGS/VARIANCE/ZODI with
 * headers) plus their SIA observation metadata and the requested sky
 * position/size, produce:
 *
 *   1. band/product compatibility verdict (explicit rejection when the
 *      observations do not measure compatible wavelengths),
 *   2. WCS-verified registration onto a common north-up TAN grid,
 *      with reference-star validation and optional constant-shift
 *      refinement (median of matched-source residuals, MAD-clipped),
 *   3. a documented feature-based (triangle matching) fallback when WCS
 *      metadata is absent or fails validation, and an explicit failure
 *      status when reliable registration is impossible,
 *   4. masking (official SPHEREx bad-flag policy + saturation/outliers for
 *      difference work), zodiacal-light subtraction (official mosaic
 *      practice), photometric + background normalization, and a SIGNED
 *      difference image with robust-noise candidate detection.
 *
 * Diagnostics (method, matched sources, residual RMS, coverage, warnings)
 * are returned for display; nothing is silently manufactured.
 */

import {
  readSpherexFits, flagMaskFromNames, BAD_FLAG_NAMES, DIFF_EXTRA_FLAG_NAMES,
  type FitsData,
} from "./fits";
import {
  parseWcs, wcsRoundtripError, pixelScaleArcsec, pixToSky, skyToPix,
  type Wcs, type WcsParseStatus,
} from "./wcs";
import {
  buildCommonGrid, reprojectToGrid, reprojectBySimilarity, gridSkyCache,
  shiftedWcs, validFraction, type Grid, type Raster,
} from "./reproject";
import {
  detectSources, matchWithWcs, matchByTriangles, applySim,
  type SourceDet, type MatchResult,
} from "./stars";
import {
  checkBandCompat, computeDifferenceSci, type BandInfo, type DiffCandidate,
} from "./diffimg";
import { renderImagePng, renderDifferencePng, pixelStats } from "./imageproc";

export interface ObsMeta {
  obsId: string | null;
  band: string | null;
  wlMinUm: number | null;
  wlMaxUm: number | null;
  calibLevel: number | null;
  releaseIso: string | null;
  dateMjd: number | null;
  exposureS: number | null;
}

export interface RegistrationDiagnostics {
  method: "wcs+stars" | "wcs" | "feature" | "failed";
  status: "ok" | "low" | "failed";
  detail: string;
  nSourcesA: number;
  nSourcesB: number;
  nMatched: number;
  nInliers: number;
  /** robust RMS of matched-source residuals (arcsec) — null if unknown */
  rmsArcsec: number | null;
  rmsPx: number | null;
  /** constant shift refinement applied to B's WCS (arcsec) */
  shiftAppliedArcsec: number | null;
  /** WCS validation status per image */
  wcsA: "ok" | string;
  wcsB: "ok" | string;
  outputScaleArcsec: number;
  outputOrientation: string;
}

export interface CompareImageMeta {
  width: number;
  height: number;
  bunit: string | null;
  mjd_obs: number | null;
  mjd_beg: number | null;
  mjd_end: number | null;
  date_obs: string | null;
  xposure: number | null;
  psf_fwhm_arcsec: number | null;
  obsid: string | null;
  detector: number | null;
  nan_fraction: number | null;
  flagged_fraction: number | null;
  coverage: number;
  pixel_scale_arcsec: number | null;
  stats: ReturnType<typeof pixelStats>;
  source: string;
}

export interface ComparePipelineResult {
  ok: boolean;
  /** reason when ok === false (band incompatibility or registration failure) */
  blockedReason?: string;
  bandCompatibility?: ReturnType<typeof checkBandCompat>;
  registration?: RegistrationDiagnostics;
  images?: {
    aOrig: Buffer;
    bOrig: Buffer;
    aAligned: Buffer;
    bAligned: Buffer;
    diff: Buffer;
  };
  grid?: { width: number; height: number };
  metadataA?: CompareImageMeta;
  metadataB?: CompareImageMeta;
  normalization?: {
    scale: number;
    offset: number;
    method: "stars" | "pixels";
    nStarsUsed: number;
  };
  difference?: {
    sigma: number;
    candidates: (DiffCandidate & { ra: number | null; dec: number | null })[];
  };
  warnings: string[];
}

/** Build the working raster for one observation: mask bad flags, NaNs, and
 *  subtract the ZODI model (official mosaic-tool practice). */
export function buildRaster(f: FitsData): Raster {
  const n = f.width * f.height;
  const valid = new Uint8Array(n);
  const image = new Float32Array(n);
  const badMask = flagMaskFromNames(f.header, BAD_FLAG_NAMES);
  const diffMask = badMask | flagMaskFromNames(f.header, DIFF_EXTRA_FLAG_NAMES);
  for (let i = 0; i < n; i++) {
    const v = f.image[i];
    const flagOk = f.flags ? (f.flags[i] & diffMask) === 0 : true;
    if (Number.isFinite(v) && flagOk) {
      image[i] = f.zodi ? v - f.zodi[i] : v;
      valid[i] = 1;
    } else {
      image[i] = NaN;
    }
  }
  return { image, valid, width: f.width, height: f.height };
}

function flaggedFraction(f: FitsData): number {
  if (!f.flags) return 0;
  const badMask = flagMaskFromNames(f.header, BAD_FLAG_NAMES) |
    flagMaskFromNames(f.header, DIFF_EXTRA_FLAG_NAMES);
  let bad = 0;
  for (let i = 0; i < f.flags.length; i++) if (f.flags[i] & badMask) bad++;
  return f.flags.length ? bad / f.flags.length : 0;
}

export interface CompareInput {
  fitsA: FitsData;
  fitsB: FitsData;
  metaA: ObsMeta;
  metaB: ObsMeta;
  ra: number;
  dec: number;
  sizeDeg: number;
  style?: "starfield" | "heatmap";
}

export function comparePipeline(input: CompareInput): ComparePipelineResult {
  const { fitsA, fitsB, metaA, metaB, ra, dec, sizeDeg } = input;
  const style = input.style ?? "starfield";
  const warnings: string[] = [];

  /* 1) band compatibility */
  const bandCompat = checkBandCompat(
    { band: metaA.band, wlMinUm: metaA.wlMinUm, wlMaxUm: metaA.wlMaxUm, calibLevel: metaA.calibLevel },
    { band: metaB.band, wlMinUm: metaB.wlMinUm, wlMaxUm: metaB.wlMaxUm, calibLevel: metaB.calibLevel },
  );
  if (!bandCompat.compatible) {
    return {
      ok: false,
      blockedReason: `Comparison not scientifically valid: ${bandCompat.reason}. Select two observations from the same wavelength band.`,
      bandCompatibility: bandCompat,
      warnings,
    };
  }

  /* 2) WCS parsing + validation */
  const stA: WcsParseStatus = parseWcs(fitsA.header);
  const stB: WcsParseStatus = parseWcs(fitsB.header);
  const wcsAOk = stA.ok && wcsRoundtripError(stA.wcs, fitsA.width, fitsA.height) < 0.05;
  const wcsBOk = stB.ok && wcsRoundtripError(stB.wcs, fitsB.width, fitsB.height) < 0.05;
  const wcsAErr = stA.ok ? (wcsAOk ? "ok" : "inconsistent (round-trip > 0.05 px)") : `${stA.reason}: ${stA.detail ?? ""}`;
  const wcsBErr = stB.ok ? (wcsBOk ? "ok" : "inconsistent (round-trip > 0.05 px)") : `${stB.reason}: ${stB.detail ?? ""}`;
  const wcsA = wcsAOk ? (stA as { ok: true; wcs: Wcs }).wcs : null;
  let wcsB = wcsBOk ? (stB as { ok: true; wcs: Wcs }).wcs : null;

  /* 3) build working rasters (flag masks + zodi subtraction) */
  const rasterA = buildRaster(fitsA);
  const rasterB = buildRaster(fitsB);

  /* 4) point sources on the NATIVE frames (no interpolation smearing) */
  const fwhmA = fitsA.psfFwhm ?? null;
  const fwhmB = fitsB.psfFwhm ?? null;
  const starsA = detectSources(rasterA.image, rasterA.valid, fitsA.width, fitsA.height, {
    fwhmPx: fwhmA && pixelScaleArcsec(wcsA ?? fallbackWcs(fitsA)) ? fwhmA / pixelScaleArcsec(wcsA ?? fallbackWcs(fitsA)) : undefined,
  });
  const starsB = detectSources(rasterB.image, rasterB.valid, fitsB.width, fitsB.height, {
    fwhmPx: fwhmB && pixelScaleArcsec(wcsB ?? fallbackWcs(fitsB)) ? fwhmB / pixelScaleArcsec(wcsB ?? fallbackWcs(fitsB)) : undefined,
  });

  /* 5) registration */
  let grid: Grid;
  let alignedA: Raster, alignedB: Raster;
  let match: MatchResult | null = null;
  let shiftArcsec: number | null = null;
  let method: RegistrationDiagnostics["method"];
  let status: RegistrationDiagnostics["status"];
  let detail: string;

  const skyValid = !!wcsA; // only A's (real) WCS gives trustworthy output sky coords

  /** Shared tail: coverage diagnostics, star flux pairs, normalization,
   *  signed difference, candidates, renders and metadata. */
  const finishAfterRegistration = (
    reg: RegistrationDiagnostics,
    grid: Grid,
    alignedA: Raster,
    alignedB: Raster,
    match: MatchResult | null,
    skyValid: boolean,
  ): ComparePipelineResult => {
    const covA = validFraction(alignedA);
    const covB = validFraction(alignedB);
    if (covA < 0.9 || covB < 0.9) {
      warnings.push(`usable pixel coverage after masking: A ${(covA * 100).toFixed(0)}%, B ${(covB * 100).toFixed(0)}% (masked: bad flags, NaN, chip edges)`);
    }
    if (reg.status === "low") {
      warnings.push("low number of matched reference sources — alignment confidence reduced");
    }
    if (fwhmA != null && fwhmB != null && fwhmA > 0 && fwhmB > 0) {
      const rel = Math.abs(fwhmA - fwhmB) / Math.min(fwhmA, fwhmB);
      if (rel > 0.2) {
        warnings.push(`PSF FWHM differs between epochs (${fwhmA.toFixed(2)}″ vs ${fwhmB.toFixed(2)}″) — residual halos around bright sources are expected`);
      }
    }

    /* matched-star positions on the common grid — the photometric scale is
     * measured from these on the PSF-homogenized pair inside the differencer
     * (identical apertures on both sides → no native-grid truncation bias) */
    let starPositions: { x: number; y: number }[] | undefined;
    if (match) {
      const pos: { x: number; y: number }[] = [];
      if (match.method === "wcs" && wcsA) {
        for (const p of match.pairs) {
          const sky = pixToSky(wcsA, p.a.x, p.a.y);
          const g = skyToPix(grid.wcs, sky.ra, sky.dec);
          if (Number.isFinite(g.x) && Number.isFinite(g.y)) pos.push(g);
        }
      } else if (match.method === "feature" && match.transform) {
        // feature path: the grid IS A's native frame
        for (const a of starsA) {
          const p = applySim(match.transform, a.x, a.y);
          let bd = Infinity;
          for (const b of starsB) {
            const d = Math.hypot(b.x - p.x, b.y - p.y);
            if (d < bd) bd = d;
          }
          if (bd <= 1.5) pos.push({ x: a.x, y: a.y });
        }
      }
      if (pos.length >= 3) starPositions = pos;
    }

    /* normalization + signed difference + candidates (PSF-homogenized) */
    const psfSigmaPx = (() => {
      const scaleOut = pixelScaleArcsec(grid.wcs);
      if (!(scaleOut > 0)) return undefined;
      const sig = (f: FitsData): number | null =>
        f.psfFwhm != null && f.psfFwhm > 0 ? f.psfFwhm / 2.355 / scaleOut : null;
      const sA = sig(fitsA);
      const sB = sig(fitsB);
      if (sA != null && sB != null) return { a: sA, b: sB };
      // PSF FWHM missing on one side — assume the SPHEREx nominal 5.2"
      const nominal = 5.2 / 2.355 / scaleOut;
      return { a: sA ?? nominal, b: sB ?? nominal };
    })();
    const diffRes = computeDifferenceSci(alignedA, alignedB, starPositions, psfSigmaPx);
    if (diffRes.psfMatchedPx != null) {
      warnings.push(`PSF homogenized to ${diffRes.psfMatchedPx.toFixed(2)} px before subtraction (standard difference-imaging practice)`);
    }
    if (diffRes.normalization.method === "pixels") {
      warnings.push("photometric scale estimated from pixels (fewer than 3 matched stars)");
    }
    if (Math.abs(diffRes.normalization.scale - 1) > 0.05) {
      warnings.push(`photometric scale difference corrected (α = ${diffRes.normalization.scale.toFixed(3)})`);
    }

    const candidates = diffRes.candidates.map((c) => {
      if (!skyValid) return { ...c, ra: null, dec: null };
      const sky = pixToSky(grid.wcs, c.x, c.y);
      return {
        ...c,
        ra: Number.isFinite(sky.ra) ? sky.ra : null,
        dec: Number.isFinite(sky.dec) ? sky.dec : null,
      };
    });

    /* renders — originals (native grids), aligned pair (common grid),
       difference with a single consistent symmetric noise stretch */
    const images = {
      aOrig: renderImagePng(rasterA.image, fitsA.width, fitsA.height, style),
      bOrig: renderImagePng(rasterB.image, fitsB.width, fitsB.height, style),
      aAligned: renderImagePng(alignedA.image, grid.width, grid.height, style),
      bAligned: renderImagePng(alignedB.image, grid.width, grid.height, style),
      diff: renderDifferencePng(diffRes.diff.image, grid.width, grid.height, diffRes.sigma),
    };

    const metaOf = (f: FitsData, r: Raster, aligned: Raster, w: Wcs | null): CompareImageMeta => {
      const pixelScale = w ? pixelScaleArcsec(w) : null;
      return {
        width: f.width,
        height: f.height,
        bunit: f.bunit,
        mjd_obs: f.mjdObs,
        mjd_beg: f.mjdBeg,
        mjd_end: f.mjdEnd,
        date_obs: f.dateObs,
        xposure: f.xposure,
        psf_fwhm_arcsec: f.psfFwhm,
        obsid: f.obsid,
        detector: f.detector,
        nan_fraction: pixelStats(r.image).nan_fraction,
        flagged_fraction: flaggedFraction(f),
        coverage: validFraction(aligned),
        pixel_scale_arcsec: pixelScale,
        stats: pixelStats(r.image),
        source: "NASA/IPAC IRSA SPHEREx Archive",
      };
    };

    return {
      ok: true,
      bandCompatibility: bandCompat,
      registration: reg,
      images,
      grid: { width: grid.width, height: grid.height },
      metadataA: metaOf(fitsA, rasterA, alignedA, wcsA),
      metadataB: metaOf(fitsB, rasterB, alignedB, wcsB),
      normalization: {
        scale: diffRes.normalization.scale,
        offset: diffRes.normalization.offset,
        method: diffRes.normalization.method,
        nStarsUsed: diffRes.normalization.nStarsUsed,
      },
      difference: { sigma: diffRes.sigma, candidates },
      warnings,
    };
  };

  if (wcsA && wcsB) {
    /* --- WCS path --- */
    match = matchWithWcs(starsA, starsB, wcsA, wcsB);
    if (match.method === "wcs" && match.status === "failed" && starsA.length >= 5 && starsB.length >= 5) {
      // Both images contain plenty of sources but the WCS predictions do not
      // match the content — the delivered WCS is contradicted. Fall back to
      // geometric registration rather than produce a misaligned difference.
      warnings.push("WCS validation failed (sources present but positions contradicted the header) — falling back to geometric registration");
      match = matchByTriangles(starsA, starsB);
      if (match.status !== "failed" && match.transform) {
        grid = { width: fitsA.width, height: fitsA.height, wcs: wcsA };
        alignedA = { ...rasterA };
        alignedB = reprojectBySimilarity(rasterB, match.transform, grid.width, grid.height);
        const regFallback: RegistrationDiagnostics = {
          method: "feature",
          status: match.status,
          detail: `WCS contradicted by sources — geometric registration from ${match.nInliers} matched sources (RMS ${match.rmsPx.toFixed(2)} px)`,
          nSourcesA: starsA.length,
          nSourcesB: starsB.length,
          nMatched: match.nMatched,
          nInliers: match.nInliers,
          rmsArcsec: null,
          rmsPx: Number.isFinite(match.rmsPx) ? match.rmsPx : null,
          shiftAppliedArcsec: null,
          wcsA: `${wcsAErr} (contradicted)`,
          wcsB: `${wcsBErr} (contradicted)`,
          outputScaleArcsec: pixelScaleArcsec(grid.wcs),
          outputOrientation: "image A frame (fallback)",
        };
        return finishAfterRegistration(regFallback, grid, alignedA, alignedB, match, true);
      }
      return {
        ok: false,
        blockedReason: "Registration not possible: both images contain sources but they contradict the WCS metadata, and geometric matching found no consistent solution. The two images cannot be compared pixel-to-pixel.",
        registration: {
          method: "failed",
          status: "failed",
          detail: "WCS contradicted; geometric fallback failed",
          nSourcesA: starsA.length,
          nSourcesB: starsB.length,
          nMatched: 0,
          nInliers: 0,
          rmsArcsec: null,
          rmsPx: null,
          shiftAppliedArcsec: null,
          wcsA: wcsAErr,
          wcsB: wcsBErr,
          outputScaleArcsec: 0,
          outputOrientation: "n/a",
        },
        warnings,
      };
    }
    // constant-shift refinement from matched stars (defensible: absorbs
    // small systematic astrometric differences between epochs)
    if (match.method === "wcs" && match.status !== "failed" &&
        (Math.abs(match.shift.dx) > 0.1 || Math.abs(match.shift.dy) > 0.1)) {
      const scaleB = pixelScaleArcsec(wcsB);
      wcsB = shiftedWcs(wcsB, match.shift.dx, match.shift.dy);
      shiftArcsec = Math.hypot(match.shift.dx, match.shift.dy) * scaleB;
      match = matchWithWcs(starsA, starsB, wcsA, wcsB); // re-measure residuals
    }
    grid = buildCommonGrid(wcsA, fitsA.width, fitsA.height, wcsB, fitsB.width, fitsB.height, ra, dec, sizeDeg);
    const skyCache = gridSkyCache(grid);
    alignedA = reprojectToGrid(rasterA, wcsA, grid, skyCache);
    alignedB = reprojectToGrid(rasterB, wcsB, grid, skyCache);
    method = match.method === "wcs" && match.nInliers > 0 ? "wcs+stars" : "wcs";
    if (match.status === "failed") {
      // too few sources to validate — archive WCS used, confidence reduced
      status = "low";
      detail = starsA.length < 5 || starsB.length < 5
        ? "too few point sources to validate the WCS alignment — archive WCS used (unverified)"
        : "no reference sources matched within tolerance — archive WCS used (unverified)";
      warnings.push("alignment could not be verified with reference stars — treat the difference with caution");
    } else {
      status = match.status;
      detail = `${match.nInliers} matched reference sources, residual RMS ${match.rmsArcsec.toFixed(3)}″ (${match.rmsPx.toFixed(2)} px)`;
    }
  } else {
    /* --- documented feature-based fallback --- */
    match = matchByTriangles(starsA, starsB);
    if (match.status === "failed" || !match.transform) {
      return {
        ok: false,
        blockedReason: `Registration not possible: WCS ${!wcsA ? "missing/invalid for image A" : ""}${!wcsA && !wcsB ? " and " : ""}${!wcsB ? "missing/invalid for image B" : ""}; geometric fallback failed (${match.note ?? "insufficient reference sources"}). The two images cannot be compared pixel-to-pixel.`,
        registration: {
          method: "failed",
          status: "failed",
          detail: match.note ?? "registration failed",
          nSourcesA: starsA.length,
          nSourcesB: starsB.length,
          nMatched: 0,
          nInliers: 0,
          rmsArcsec: null,
          rmsPx: null,
          shiftAppliedArcsec: null,
          wcsA: wcsAErr,
          wcsB: wcsBErr,
          outputScaleArcsec: 0,
          outputOrientation: "n/a",
        },
        warnings,
      };
    }
    // Render B onto A's pixel grid through the estimated similarity.
    // Sky coordinates (when A has a WCS) stay meaningful; otherwise the
    // comparison is purely morphological.
    grid = { width: fitsA.width, height: fitsA.height, wcs: wcsA ?? fallbackWcs(fitsA) };
    if (!wcsA) warnings.push("no WCS on either image — output sky coordinates are unavailable");
    alignedA = { ...rasterA };
    alignedB = reprojectBySimilarity(rasterB, match.transform, grid.width, grid.height);
    method = "feature";
    status = match.status;
    detail = `no usable WCS — geometric registration from ${match.nInliers} matched sources (RMS ${match.rmsPx.toFixed(2)} px); celestial accuracy limited`;
    warnings.push("WCS metadata missing/invalid — registration used geometric star matching; sky positions are approximate");
  }

  const reg: RegistrationDiagnostics = {
    method,
    status,
    detail,
    nSourcesA: starsA.length,
    nSourcesB: starsB.length,
    nMatched: match.nMatched,
    nInliers: match.nInliers,
    rmsArcsec: match.method === "wcs" ? (Number.isFinite(match.rmsArcsec) ? match.rmsArcsec : null) : null,
    rmsPx: Number.isFinite(match.rmsPx) ? match.rmsPx : null,
    shiftAppliedArcsec: shiftArcsec,
    wcsA: wcsAErr,
    wcsB: wcsBErr,
    outputScaleArcsec: pixelScaleArcsec(grid.wcs),
    outputOrientation: "north-up, east-left (common TAN grid)",
  };

  return finishAfterRegistration(reg, grid, alignedA, alignedB, match, skyValid);
}

/** Minimal synthetic WCS used only when the real one is unusable (feature
 *  fallback): scale from CDELT/PC if present, else the SPHEREx default. */
function fallbackWcs(f: FitsData): Wcs {
  const st = parseWcs(f.header);
  if (st.ok) return st.wcs;
  // derive scale from header if possible
  let scale = 6.15 / 3600; // SPHEREx nominal
  const cdelt = parseFloat(f.header.CDELT1 ?? "");
  if (Number.isFinite(cdelt) && cdelt !== 0) scale = Math.abs(cdelt);
  const empty = new Map<string, number>();
  return {
    ctype: ["RA---TAN", "DEC--TAN"],
    projection: "TAN",
    hasSip: false,
    cd: [[-scale, 0], [0, scale]],
    crpix: [(f.width + 1) / 2, (f.height + 1) / 2],
    crval: [0, 0],
    cunit: ["deg", "deg"],
    lonpole: 180,
    latpole: 90,
    radesys: null,
    equinox: null,
    sipA: empty, sipB: empty, sipAp: empty, sipBp: empty,
  };
}
