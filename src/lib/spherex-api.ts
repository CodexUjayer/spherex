/**
 * SPHEREx Explorer — API client + types.
 *
 * All requests go to Next.js API routes on the same origin (/api/search,
 * /api/image, /api/compare, /api/examples, /api/preview). These routes run
 * as serverless functions that fetch live from the NASA/IPAC IRSA SPHEREx
 * archive. No separate backend, no mock data.
 */

function apiUrl(path: string, params: Record<string, string | number | boolean | null | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    sp.set(k, String(v));
  }
  return `${path}?${sp.toString()}`;
}

export interface SpherexExample {
  name: string;
  ra: number;
  dec: number;
  note: string;
}

export type ViewStyle = "starfield" | "heatmap";

export interface Observation {
  obs_id: string;
  access_url: string;
  publisher_did: string;
  /** observation time (MJD, from t_min) — NOT the archive release date */
  date_mjd: number | null;
  /** observation time ISO */
  date_iso: string | null;
  /** archive release date ISO (separate from the observation time) */
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

export interface FitsMetaWcs {
  crval: [number, number];
  crpix: [number, number];
  cd: number[][];
  pixelScaleArcsec: number;
  paDeg: number;
  projection: string;
  hasSip: boolean;
}

export interface FitsMeta {
  access_url?: string;
  width: number;
  height: number;
  bunit: string | null;
  mjd_obs: number | null;
  mjd_beg?: number | null;
  mjd_end?: number | null;
  date_obs?: string | null;
  xposure?: number | null;
  psf_fwhm_arcsec?: number | null;
  wcs?: FitsMetaWcs | null;
  stats: {
    min: number | null;
    max: number | null;
    mean: number | null;
    median: number | null;
    std: number | null;
    p1: number | null;
    p99: number | null;
    p995?: number | null;
    nan_fraction?: number | null;
    n_pixels?: number;
  };
  source: string;
}

export interface Candidate {
  label: number;
  pixel_x: number;
  pixel_y: number;
  area_px: number;
  peak_deviation: number;
  sign: "positive" | "negative";
  ra?: number | null;
  dec?: number | null;
  sum_sigma?: number;
}

export interface DifferenceInfo {
  candidates: Candidate[];
  sigma?: number;
  scale?: number;
  offset?: number;
  method?: "stars" | "pixels";
  n_stars?: number;
}

export interface RegistrationInfo {
  method: "wcs+stars" | "wcs" | "feature" | "failed";
  status: "ok" | "low" | "failed";
  detail: string;
  nSourcesA: number;
  nSourcesB: number;
  nMatched: number;
  nInliers: number;
  rmsArcsec: number | null;
  rmsPx: number | null;
  shiftAppliedArcsec: number | null;
  wcsA: string;
  wcsB: string;
  outputScaleArcsec: number;
  outputOrientation: string;
}

export interface ImageResponse {
  image: string; // data URL
  width: number;
  height: number;
  metadata: FitsMeta & { stretch_lo?: number; stretch_hi?: number };
  source: string;
}

export interface CompareResponse {
  /** aligned pair on the common celestial grid (slider / subtract views) */
  image_a: string;
  image_b: string;
  /** original cutouts on their native grids (side-by-side view) */
  image_a_orig?: string;
  image_b_orig?: string;
  image_diff: string;
  width: number;
  height: number;
  metadata_a: FitsMeta;
  metadata_b: FitsMeta;
  difference: DifferenceInfo;
  registration?: RegistrationInfo;
  band_compatibility?: { compatible: boolean; reason: string | null; overlap: number | null };
  warnings?: string[];
  source: string;
}

export interface SearchResponse {
  observations: Observation[];
  count: number;
  bands: BandSummary[];
  position: { ra: number; dec: number; radius: number };
  collection: string;
  collections?: string[];
  source: string;
}

export interface ExamplesResponse {
  examples: SpherexExample[];
  source: string;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export const api = {
  examples: (signal?: AbortSignal) => getJson<ExamplesResponse>(apiUrl("/api/examples", {}), signal),

  search: (ra: number, dec: number, radius = 0.05, cutout = 0.3, signal?: AbortSignal) =>
    getJson<SearchResponse>(
      apiUrl("/api/search", { ra, dec, radius, cutout }),
      signal,
    ),

  image: (
    accessUrl: string,
    ra: number,
    dec: number,
    size: number,
    style: ViewStyle = "starfield",
    signal?: AbortSignal,
  ) =>
    getJson<ImageResponse>(
      apiUrl("/api/image", { access_url: accessUrl, ra, dec, size, style }),
      signal,
    ),

  preview: (
    ra: number,
    dec: number,
    size = 0.25,
    style: ViewStyle = "starfield",
    signal?: AbortSignal,
  ) =>
    getJson<{
      image: string;
      width: number;
      height: number;
      obs_id: string;
      band: string;
      date_iso: string | null;
      release_iso?: string | null;
      source: string;
    }>(apiUrl("/api/preview", { ra, dec, size, style }), signal),

  compare: (
    accessUrlA: string,
    accessUrlB: string,
    ra: number,
    dec: number,
    size: number,
    style: ViewStyle = "starfield",
    obsA?: Observation | null,
    obsB?: Observation | null,
    signal?: AbortSignal,
  ) =>
    getJson<CompareResponse>(
      apiUrl("/api/compare", {
        access_url_a: accessUrlA,
        access_url_b: accessUrlB,
        ra,
        dec,
        size,
        style,
        band_a: obsA?.band ?? null,
        band_b: obsB?.band ?? null,
        wl_min_a: obsA?.wavelength_min_um ?? null,
        wl_max_a: obsA?.wavelength_max_um ?? null,
        wl_min_b: obsB?.wavelength_min_um ?? null,
        wl_max_b: obsB?.wavelength_max_um ?? null,
        calib_a: obsA?.calib_level ?? null,
        calib_b: obsB?.calib_level ?? null,
        release_a: obsA?.release_iso ?? null,
        release_b: obsB?.release_iso ?? null,
        obs_id_a: obsA?.obs_id ?? null,
        obs_id_b: obsB?.obs_id ?? null,
        exposure_a: obsA?.t_exptime ?? null,
        exposure_b: obsB?.t_exptime ?? null,
      }),
      signal,
    ),
};

/**
 * De-duplicate observations by identity — (obs_id, band) — keeping
 * legitimately distinct same-date observations. Sorted by observation date.
 * (The old date-based key collapsed distinct observations that happened to
 * share a date, which is scientifically wrong.)
 */
export function dedupeObservations(obs: Observation[]): Observation[] {
  const byUrl = new Map<string, Observation>();
  for (const o of obs) if (!byUrl.has(o.access_url)) byUrl.set(o.access_url, o);
  const byIdentity = new Map<string, Observation>();
  const rank = (c: string) => {
    const m = c.match(/qr(\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  };
  for (const o of byUrl.values()) {
    const key = `${o.obs_id}::${o.band}`;
    const prev = byIdentity.get(key);
    if (!prev || rank(o.obs_collection) > rank(prev.obs_collection)) byIdentity.set(key, o);
  }
  return [...byIdentity.values()].sort(
    (a, b) => (a.date_mjd ?? Number.POSITIVE_INFINITY) - (b.date_mjd ?? Number.POSITIVE_INFINITY),
  );
}

/** Backwards-compatible alias. */
export const dedupeByDate = dedupeObservations;

export function formatMJD(mjd: number | null): string {
  if (mjd == null) return "—";
  const d = new Date((mjd - 40587) * 86400000); // MJD epoch 1858-11-17
  if (isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

export function formatDateTime(iso: string | null, mjd: number | null): string {
  if (iso) {
    const d = new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z"));
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
  return formatMJD(mjd);
}
