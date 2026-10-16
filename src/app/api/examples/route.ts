import { NextResponse } from "next/server";

export const runtime = "nodejs";

const EXAMPLES = [
  { name: "Orion Nebula (M42)", ra: 83.822, dec: -5.391,
    note: "Bright star-forming region; rich infrared structure." },
  { name: "Pleiades (M45)", ra: 56.75, dec: 24.117,
    note: "Nearby young open cluster in Taurus." },
  { name: "Andromeda (M31)", ra: 10.685, dec: 41.269,
    note: "Nearest large spiral galaxy." },
  { name: "Large Magellanic Cloud", ra: 80.894, dec: -69.756,
    note: "Dwarf galaxy neighbour of the Milky Way." },
  { name: "Crab Nebula (M1)", ra: 83.633, dec: 22.014,
    note: "Supernova remnant in Taurus." },
];

export async function GET() {
  return NextResponse.json({
    examples: EXAMPLES,
    source: "NASA/IPAC IRSA SPHEREx Archive",
  });
}
