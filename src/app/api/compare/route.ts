import { NextRequest, NextResponse } from "next/server";
import { streamCutout, cutoutUrl, readSpherexFits } from "@/lib/spherex/fits";
import { comparePipeline, type ObsMeta } from "@/lib/spherex/compare-pipeline";
import { b64png, type ViewStyle } from "@/lib/spherex/imageproc";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseCoords(ra: string | null, dec: string | null) {
  const r = parseFloat(ra ?? "");
  const d = parseFloat(dec ?? "");
  if (!Number.isFinite(r) || !Number.isFinite(d)) return null;
  if (r < 0 || r > 360 || d < -90 || d > 90) return null;
  return { ra: r, dec: d };
}

function num(sp: URLSearchParams, key: string): number | null {
  const v = sp.get(key);
  if (v == null || v === "") return null;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : null;
}

function str(sp: URLSearchParams, key: string): string | null {
  const v = sp.get(key);
  return v && v.trim() !== "" ? v.trim() : null;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const a = sp.get("access_url_a");
  const b = sp.get("access_url_b");
  const coords = parseCoords(sp.get("ra"), sp.get("dec"));
  if (!a || !b || !coords) {
    return NextResponse.json(
      { detail: "access_url_a, access_url_b, ra and dec are required." },
      { status: 422 },
    );
  }
  const size = Math.min(1.0, Math.max(0.05, parseFloat(sp.get("size") ?? "0.3") || 0.3));
  const style = (sp.get("style") ?? "starfield") as ViewStyle;

  try {
    // fetch both cutouts concurrently (streaming + early abort + retry)
    const [bufA, bufB] = await Promise.all([
      streamCutout(cutoutUrl(a, coords.ra, coords.dec, size)),
      streamCutout(cutoutUrl(b, coords.ra, coords.dec, size)),
    ]);
    const fa = readSpherexFits(bufA);
    const fb = readSpherexFits(bufB);

    // observation metadata (from the client's SIA selection, FITS fallback)
    const metaFrom = (
      f: typeof fa,
      band: string | null,
      wlMin: number | null,
      wlMax: number | null,
      calib: number | null,
      release: string | null,
      obsId: string | null,
      exposure: number | null,
    ): ObsMeta => ({
      obsId: obsId ?? f.obsid,
      band: band ?? (f.detector != null ? `SPHEREx-D${f.detector}` : null),
      wlMinUm: wlMin,
      wlMaxUm: wlMax,
      calibLevel: calib ?? 2,
      releaseIso: release,
      dateMjd: f.mjdObs,
      exposureS: exposure ?? f.xposure,
    });

    const result = comparePipeline({
      fitsA: fa,
      fitsB: fb,
      metaA: metaFrom(
        fa, str(sp, "band_a"), num(sp, "wl_min_a"), num(sp, "wl_max_a"),
        num(sp, "calib_a"), str(sp, "release_a"), str(sp, "obs_id_a"), num(sp, "exposure_a"),
      ),
      metaB: metaFrom(
        fb, str(sp, "band_b"), num(sp, "wl_min_b"), num(sp, "wl_max_b"),
        num(sp, "calib_b"), str(sp, "release_b"), str(sp, "obs_id_b"), num(sp, "exposure_b"),
      ),
      ra: coords.ra,
      dec: coords.dec,
      sizeDeg: size,
      style,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          detail: result.blockedReason,
          blocked: true,
          band_compatibility: result.bandCompatibility ?? null,
          registration: result.registration ?? null,
        },
        { status: 409 },
      );
    }

    const cand = result.difference!.candidates.map((c, i) => ({
      label: i + 1,
      pixel_x: Math.round(c.x * 10) / 10,
      pixel_y: Math.round(c.y * 10) / 10,
      area_px: c.areaPx,
      peak_deviation: Math.round(c.snr * 10) / 10,
      sign: c.sign,
      ra: c.ra != null ? Math.round(c.ra * 10000) / 10000 : null,
      dec: c.dec != null ? Math.round(c.dec * 10000) / 10000 : null,
      sum_sigma: Math.round(c.sumSigma * 10) / 10,
    }));

    return NextResponse.json({
      // aligned pair on the common grid (used by the slider + subtract views)
      image_a: b64png(result.images!.aAligned),
      image_b: b64png(result.images!.bAligned),
      // original cutouts on their native grids (side-by-side view)
      image_a_orig: b64png(result.images!.aOrig),
      image_b_orig: b64png(result.images!.bOrig),
      image_diff: b64png(result.images!.diff),
      width: result.grid!.width,
      height: result.grid!.height,
      metadata_a: result.metadataA,
      metadata_b: result.metadataB,
      difference: {
        candidates: cand,
        sigma: result.difference!.sigma,
        scale: result.normalization!.scale,
        offset: result.normalization!.offset,
        method: result.normalization!.method,
        n_stars: result.normalization!.nStarsUsed,
      },
      registration: result.registration,
      band_compatibility: result.bandCompatibility,
      warnings: result.warnings,
      source: "NASA/IPAC IRSA SPHEREx Archive",
    });
  } catch (e) {
    return NextResponse.json(
      { detail: `Failed to compare SPHEREx cutouts: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
