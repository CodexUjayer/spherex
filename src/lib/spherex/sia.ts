/**
 * IRSA SPHEREx SIA client.
 *
 * Queries the live NASA/IPAC IRSA Simple Image Access service using
 * RESPONSEFORMAT=json (no XML parser needed), filters to tiles that fully
 * cover the cutout region, and de-duplicates by OBSERVATION IDENTITY —
 * (obs_id, band, access_url) — never by date alone.
 *
 * Metadata semantics (SPHEREx archive schema):
 *   - t_min / t_max         → observation MJD (when the sky was observed)
 *   - obs_release_date      → archive release/processing date (separate field)
 *   The observation date is derived from t_min (falling back to t_max) and
 *   is NEVER replaced by the release date; the release date is exposed
 *   separately as `release_iso`.
 *
 * Collections: SPHEREx quick releases are cumulative per sky position but
 * epoch-disjoint; querying both `spherex_qr2` (2025-08 → 2026-03) and
 * `spherex_qr3` (2026-08 → 2026-09) gives the full time baseline. When the
 * same (obs_id, band) appears in multiple collections the record from the
 * NEWEST release wins (never silently mixed). Configure via the
 * SPHEREX_COLLECTIONS environment variable (comma-separated); default
 * covers the two public quick releases.
 */

const SIA_URL = "https://irsa.ipac.caltech.edu/SIA";

/** Public SPHEREx quick-release collections at IRSA (queried in parallel). */
export const SPHEREX_COLLECTIONS = (() => {
  const env = process.env.SPHEREX_COLLECTIONS;
  if (env && env.trim()) {
    return env.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return ["spherex_qr2", "spherex_qr3"];
})();

export interface Observation {
  obs_id: string;
  access_url: string;
  publisher_did: string;
  /** observation start time (MJD, from t_min; t_max if t_min absent) */
  date_mjd: number | null;
  /** observation time as ISO (derived from t_min — NOT the release date) */
  date_iso: string | null;
  /** archive release date (from obs_release_date), separate field */
  release_iso: string | null;
  band: string;
  wavelength_min_um: number | null;
  wavelength_max_um: number | null;
  wavelength_center_um: number | null;
  em_res_power: number | null;
  t_exptime: number | null;
  ra_center: number | null;
  dec_center: number | null;
  target_name: string | null;
  s_xel1: number | null;
  s_xel2: number | null;
  s_pixel_scale: number | null;
  s_fov: number | null;
  calib_level: number | null;
  proposal_title: string | null;
  obs_collection: string;
  facility: string | null;
  instrument: string | null;
}

export interface BandSummary {
  band: string;
  count: number;
  wavelength_center_um: number | null;
  wavelength_min_um: number | null;
  wavelength_max_um: number | null;
}

function toNum(v: string | undefined): number | null {
  if (!v) return null;
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : null;
}
function toInt(v: string | undefined): number | null {
  const x = toNum(v);
  return x === null ? null : Math.round(x);
}
function toStr(v: string | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  return s === "" || s === "--" ? null : s;
}

/** MJD → ISO 8601 UTC. MJD epoch 1858-11-17. */
export function mjdToIso(mjd: number | null): string | null {
  if (mjd == null || !Number.isFinite(mjd)) return null;
  const ms = (mjd - 40587) * 86400000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Great-circle separation in degrees (haversine). */
function angularSep(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r1 = (ra1 * Math.PI) / 180;
  const d1 = (dec1 * Math.PI) / 180;
  const r2 = (ra2 * Math.PI) / 180;
  const d2 = (dec2 * Math.PI) / 180;
  const s =
    Math.sin((d2 - d1) / 2) ** 2 +
    Math.cos(d1) * Math.cos(d2) * Math.sin((r2 - r1) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(s))) * 180) / Math.PI;
}

function coversCutout(
  o: Observation, ra: number, dec: number, cutoutSize: number, margin = 0.15
): boolean {
  if (o.ra_center == null || o.dec_center == null) return true;
  const fov = o.s_fov ?? 3.49;
  // s_fov is the tile SIDE length; a circle of radius fov/2 is inscribed in
  // the (roughly square) tile, so requiring sep + cutout/2 + margin < fov/2
  // guarantees the cutout lies fully inside the tile.
  const sep = angularSep(o.ra_center, o.dec_center, ra, dec);
  return sep < fov / 2 - cutoutSize / 2 - margin;
}

/** Map a parsed row (string[]) to an Observation, using a name->index map. */
function rowToObs(row: string[], idx: Record<string, number>): Observation | null {
  const g = (name: string): string | undefined => {
    const i = idx[name];
    return i === undefined ? undefined : row[i];
  };
  const accessUrl = toStr(g("access_url"));
  if (!accessUrl) return null;
  const emMin = toNum(g("em_min"));
  const emMax = toNum(g("em_max"));
  const wlMin = emMin !== null ? emMin * 1e6 : null;
  const wlMax = emMax !== null ? emMax * 1e6 : null;
  const wlCenter =
    wlMin !== null && wlMax !== null ? (wlMin + wlMax) / 2 : null;
  // observation time: t_min (start), never the release date
  const tMin = toNum(g("t_min"));
  const tMax = toNum(g("t_max"));
  const obsMjd = tMin ?? tMax;
  // release date is stored SEPARATELY (IRSA gives "YYYY-MM-DD HH:MM:SS" UTC)
  let releaseIso = toStr(g("obs_release_date"));
  if (releaseIso && !releaseIso.endsWith("Z") && releaseIso.includes(" ")) {
    releaseIso = releaseIso.replace(" ", "T") + "Z";
  }
  return {
    obs_id: toStr(g("obs_id")) ?? "",
    access_url: accessUrl,
    publisher_did: toStr(g("obs_publisher_did")) ?? "",
    date_mjd: obsMjd,
    date_iso: mjdToIso(obsMjd),
    release_iso: releaseIso,
    band: toStr(g("energy_bandpassname")) ?? "",
    wavelength_min_um: wlMin,
    wavelength_max_um: wlMax,
    wavelength_center_um: wlCenter,
    em_res_power: toNum(g("em_res_power")),
    t_exptime: toNum(g("t_exptime")),
    ra_center: toNum(g("s_ra")),
    dec_center: toNum(g("s_dec")),
    target_name: toStr(g("target_name")),
    s_xel1: toInt(g("s_xel1")),
    s_xel2: toInt(g("s_xel2")),
    s_pixel_scale: toNum(g("s_pixel_scale")),
    s_fov: toNum(g("s_fov")),
    calib_level: toInt(g("calib_level")),
    proposal_title: toStr(g("proposal_title")),
    obs_collection: toStr(g("obs_collection")) ?? "spherex",
    facility: toStr(g("facility_name")),
    instrument: toStr(g("instrument_name")),
  };
}

interface SiaRowResult {
  obs: Observation[];
  collection: string;
}

async function querySiaCollection(
  collection: string,
  ra: number,
  dec: number,
  radius: number,
  cutoutSize: number,
  requireFullCoverage: boolean,
  timeoutMs: number,
): Promise<SiaRowResult> {
  const url = `${SIA_URL}?COLLECTION=${collection}&POS=circle ${ra} ${dec} ${radius}&RESPONSEFORMAT=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`IRSA SIA returned ${res.status} for collection ${collection}`);
    const json = await res.json();
    const table = json?.VOTABLE?.RESOURCE_ARRAY?.[1]?.TABLE;
    if (!table) throw new Error(`No results table in IRSA SIA response for ${collection}`);
    const fields: { name: string }[] = table.FIELD_ARRAY ?? [];
    const idx: Record<string, number> = {};
    fields.forEach((f, i) => {
      const name = f?.["<xmlattr>"]?.name ?? f?.name;
      if (name) idx[name] = i;
    });
    const rows: string[][] = table?.DATA?.TABLEDATA ?? [];
    const seen = new Set<string>();
    const out: Observation[] = [];
    for (const row of rows) {
      const o = rowToObs(row, idx);
      if (!o) continue;
      if (requireFullCoverage && !coversCutout(o, ra, dec, cutoutSize)) continue;
      if (seen.has(o.access_url)) continue;
      seen.add(o.access_url);
      out.push(o);
    }
    return { obs: out, collection };
  } finally {
    clearTimeout(timer);
  }
}

/** Query the configured IRSA SIA collections (in parallel) and merge.
 *  Returns observations (full-coverage only). A failing collection does not
 *  abort the whole search when at least one succeeds. */
export async function querySia(
  ra: number, dec: number,
  radius = 0.05,
  cutoutSize = 0.25,
  requireFullCoverage = true,
  timeoutMs = 30000,
  collections: string[] = SPHEREX_COLLECTIONS,
): Promise<Observation[]> {
  const results = await Promise.allSettled(
    collections.map((c) =>
      querySiaCollection(c, ra, dec, radius, cutoutSize, requireFullCoverage, timeoutMs)
    ),
  );
  const ok: Observation[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") ok.push(...r.value.obs);
    else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
  }
  if (ok.length === 0 && errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return dedupeObservations(ok);
}

/** Release-name ordering for "newest release wins" dedup. */
function releaseRank(collection: string): number {
  const m = collection.match(/qr(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * De-duplicate observations by IDENTITY, preserving legitimately distinct
 * same-date observations:
 *   - exact product duplicates: same access_url
 *   - same observation & band across collections (reprocessed in a newer
 *     quick release): keep the record from the newest release
 *   - the same obs_id in different bands (SPHEREx flies 6 detectors; one
 *     visit can produce D3 and D6 products) are DISTINCT observations and
 *     are always kept.
 * Sorted by observation date (date_mjd).
 */
export function dedupeObservations(obs: Observation[]): Observation[] {
  const byUrl = new Map<string, Observation>();
  for (const o of obs) {
    if (!byUrl.has(o.access_url)) byUrl.set(o.access_url, o);
  }
  const byIdentity = new Map<string, Observation>();
  for (const o of byUrl.values()) {
    const key = `${o.obs_id}::${o.band}`;
    const prev = byIdentity.get(key);
    if (!prev || releaseRank(o.obs_collection) > releaseRank(prev.obs_collection)) {
      byIdentity.set(key, o);
    }
  }
  return [...byIdentity.values()].sort(
    (a, b) => (a.date_mjd ?? Number.POSITIVE_INFINITY) - (b.date_mjd ?? Number.POSITIVE_INFINITY),
  );
}

/** Backwards-compatible alias: date-based dedup was wrong (collapsed distinct
 *  same-date observations); identity-based dedup replaces it. */
export const dedupeByDateSorted = dedupeObservations;
export const dedupeByDate = dedupeObservations;

export function summariseByBand(obs: Observation[]): BandSummary[] {
  const groups = new Map<string, Observation[]>();
  for (const o of obs) {
    const k = o.band || "unknown";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(o);
  }
  const out: BandSummary[] = [];
  for (const [band, items] of groups) {
    items.sort((a, b) => (a.date_mjd ?? 0) - (b.date_mjd ?? 0));
    out.push({
      band,
      count: items.length,
      wavelength_center_um: items[0].wavelength_center_um,
      wavelength_min_um: items[0].wavelength_min_um,
      wavelength_max_um: items[0].wavelength_max_um,
    });
  }
  out.sort((a, b) => (a.wavelength_center_um ?? 0) - (b.wavelength_center_um ?? 0));
  return out;
}
