import { NextRequest, NextResponse } from "next/server";
import { querySia, dedupeObservations } from "@/lib/spherex/sia";
import { streamCutout, cutoutUrl, readSpherexFits } from "@/lib/spherex/fits";
import { renderImagePng, b64png, type ViewStyle } from "@/lib/spherex/imageproc";

export const runtime = "nodejs";

function parseCoords(ra: string | null, dec: string | null) {
  const r = parseFloat(ra ?? "");
  const d = parseFloat(dec ?? "");
  if (!Number.isFinite(r) || !Number.isFinite(d)) return null;
  if (r < 0 || r > 360 || d < -90 || d > 90) return null;
  return { ra: r, dec: d };
}

/** One-shot preview: search a position, pick a fully-covering observation
 *  (de-duplicated by observation identity, not date), return a rendered PNG
 *  thumbnail. Used by the example-region gallery. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const coords = parseCoords(sp.get("ra"), sp.get("dec"));
  if (!coords) {
    return NextResponse.json({ detail: "ra and dec are required." }, { status: 422 });
  }
  const size = Math.min(1.0, Math.max(0.05, parseFloat(sp.get("size") ?? "0.25") || 0.25));
  const style = (sp.get("style") ?? "starfield") as ViewStyle;

  try {
    const obs = await querySia(coords.ra, coords.dec, 0.05, size, true);
    const sorted = dedupeObservations(obs);
    if (sorted.length === 0) {
      return NextResponse.json(
        { detail: "No SPHEREx coverage for this position." },
        { status: 404 },
      );
    }
    const o = sorted[0];
    const buf = await streamCutout(cutoutUrl(o.access_url, coords.ra, coords.dec, size));
    const fd = readSpherexFits(buf);
    const png = renderImagePng(fd.image, fd.width, fd.height, style);
    return NextResponse.json({
      image: b64png(png),
      width: fd.width,
      height: fd.height,
      obs_id: o.obs_id,
      band: o.band,
      date_iso: o.date_iso,
      release_iso: o.release_iso,
      source: "NASA/IPAC IRSA SPHEREx Archive",
    });
  } catch (e) {
    return NextResponse.json(
      { detail: `Preview failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
