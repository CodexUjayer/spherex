import { NextRequest, NextResponse } from "next/server";
import { streamCutout, cutoutUrl, readSpherexFits } from "@/lib/spherex/fits";
import { renderImagePng, b64png, metaFromFits, type FitsMeta, type ViewStyle } from "@/lib/spherex/imageproc";

export const runtime = "nodejs";

function parseCoords(ra: string | null, dec: string | null) {
  const r = parseFloat(ra ?? "");
  const d = parseFloat(dec ?? "");
  if (!Number.isFinite(r) || !Number.isFinite(d)) return null;
  if (r < 0 || r > 360 || d < -90 || d > 90) return null;
  return { ra: r, dec: d };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const accessUrl = sp.get("access_url");
  const coords = parseCoords(sp.get("ra"), sp.get("dec"));
  if (!accessUrl || !coords) {
    return NextResponse.json(
      { detail: "access_url, ra and dec are required." },
      { status: 422 },
    );
  }
  const size = Math.min(1.0, Math.max(0.05, parseFloat(sp.get("size") ?? "0.3") || 0.3));
  const style = (sp.get("style") ?? "starfield") as ViewStyle;

  try {
    const buf = await streamCutout(cutoutUrl(accessUrl, coords.ra, coords.dec, size));
    const fd = readSpherexFits(buf);
    const png = renderImagePng(fd.image, fd.width, fd.height, style);
    const metadata: FitsMeta & { stretch_lo?: number; stretch_hi?: number } = metaFromFits(fd);
    return NextResponse.json({
      image: b64png(png),
      width: fd.width,
      height: fd.height,
      metadata,
      source: "NASA/IPAC IRSA SPHEREx Archive",
    });
  } catch (e) {
    return NextResponse.json(
      { detail: `Failed to retrieve/read SPHEREx cutout: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
