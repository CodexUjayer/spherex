import { NextRequest, NextResponse } from "next/server";
import {
  querySia,
  summariseByBand,
  SPHEREX_COLLECTIONS,
  type Observation,
} from "@/lib/spherex/sia";

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
  const coords = parseCoords(sp.get("ra"), sp.get("dec"));
  if (!coords) {
    return NextResponse.json({ detail: "ra and dec must be valid degrees." }, { status: 422 });
  }
  const radius = Math.min(2.0, Math.max(0.0005, parseFloat(sp.get("radius") ?? "0.05") || 0.05));
  const cutout = Math.min(1.0, Math.max(0.05, parseFloat(sp.get("cutout") ?? "0.3") || 0.3));
  try {
    const obs = await querySia(coords.ra, coords.dec, radius, cutout, true);
    return NextResponse.json({
      observations: obs.map((o) => ({ ...o, source: "NASA/IPAC IRSA SPHEREx Archive" })),
      count: obs.length,
      bands: summariseByBand(obs),
      position: { ra: coords.ra, dec: coords.dec, radius },
      cutout,
      collection: SPHEREX_COLLECTIONS.join("+"),
      collections: SPHEREX_COLLECTIONS,
      source: "NASA/IPAC IRSA SPHEREx Archive",
    });
  } catch (e) {
    return NextResponse.json(
      { detail: `IRSA SIA query failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}

export type { Observation };
