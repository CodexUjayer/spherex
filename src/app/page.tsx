"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { SkyViewer, type ViewMode, type DiffView } from "@/components/spherex/sky-viewer";
import { SearchPanel } from "@/components/spherex/search-panel";
import { TwoHandleTimeline } from "@/components/spherex/timeline";
import { AboutDialog } from "@/components/spherex/about-dialog";
import { ExampleGallery } from "@/components/spherex/example-gallery";
import { NasaLogo } from "@/components/spherex/nasa-logo";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  api,
  dedupeObservations,
  formatMJD,
  type Observation,
  type SpherexExample,
  type ImageResponse,
  type CompareResponse,
  type ViewStyle,
} from "@/lib/spherex-api";

const CUTOUT_SIZE_DEG = 0.3;
const DEFAULT_BAND = "SPHEREx-D2";
const PRELOAD_CONCURRENCY = 3;

async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  onItemError?: (item: T, index: number, err: unknown) => void,
): Promise<void> {
  let cursor = 0;
  const next = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      try {
        await fn(items[i], i);
      } catch (e) {
        onItemError?.(items[i], i, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
}

export default function Page() {
  const [examples, setExamples] = useState<SpherexExample[]>([]);
  const [searchRa, setSearchRa] = useState<number | null>(null);
  const [searchDec, setSearchDec] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  const [observations, setObservations] = useState<Observation[]>([]);
  const [bands, setBands] = useState<
    { band: string; count: number; wavelength_center_um: number | null; wavelength_min_um: number | null; wavelength_max_um: number | null }[]
  >([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [selectedBand, setSelectedBand] = useState<string | null>(null);
  const [indexA, setIndexA] = useState(0);
  const [indexB, setIndexB] = useState(1);

  const cacheRef = useRef<Map<string, ImageResponse>>(new Map());
  const [, bumpCache] = useReducer((x: number) => x + 1, 0);
  const [preloadDone, setPreloadDone] = useState(0);
  const [preloadTotal, setPreloadTotal] = useState(0);

  const [diff, setDiff] = useState<CompareResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffErr, setDiffErr] = useState<string | null>(null);

  const [mode, setMode] = useState<ViewMode>("single");
  const [diffView, setDiffView] = useState<DiffView>("slider");
  const [view, setView] = useState<ViewStyle>("starfield");
  const diffSeqRef = useRef(0);

  const bandObs = useMemo(
    () =>
      dedupeObservations(
        selectedBand ? observations.filter((o) => o.band === selectedBand) : observations,
      ),
    [observations, selectedBand],
  );
  const total = bandObs.length;

  const obsA = bandObs[Math.min(indexA, Math.max(0, total - 1))] ?? null;
  const obsB = bandObs[Math.min(indexB, Math.max(0, total - 1))] ?? null;

  // search
  const onSearch = useCallback(async (ra: number, dec: number) => {
    setSearching(true);
    setSearchErr(null);
    setSearchRa(ra);
    setSearchDec(dec);
    setObservations([]);
    setBands([]);
    setCollections([]);
    setDiff(null);
    cacheRef.current = new Map();
    setPreloadDone(0);
    setPreloadTotal(0);
    try {
      const r = await api.search(ra, dec, 0.05);
      setObservations(r.observations);
      setBands(r.bands);
      setCollections(r.collections ?? [r.collection]);
      const defaultBand = r.bands.find((b) => b.band === DEFAULT_BAND) ?? r.bands[0];
      if (defaultBand) {
        setSelectedBand(defaultBand.band);
        const bo = dedupeObservations(r.observations.filter((o) => o.band === defaultBand.band));
        setIndexA(0);
        setIndexB(Math.max(0, bo.length - 1));
      } else {
        setSelectedBand(null);
        const all = dedupeObservations(r.observations);
        setIndexA(0);
        setIndexB(Math.max(0, all.length - 1));
      }
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    api.examples().then((r) => setExamples(r.examples)).catch(() => {});
    onSearch(83.821, -53.937);
  }, [onSearch]);

  // preload all band observations (keyed by access_url + view style so
  // switching Starfield/Heatmap re-fetches the re-rendered PNGs)
  useEffect(() => {
    if (searchRa == null || searchDec == null || !selectedBand || total === 0) return;
    let cancelled = false;
    const items = bandObs.slice();
    setPreloadTotal(items.length);
    setPreloadDone(0);
    (async () => {
      let done = 0;
      await runPool(
        items,
        PRELOAD_CONCURRENCY,
        async (o) => {
          const key = o.access_url + "|" + view;
          if (cacheRef.current.has(key)) return;
          const img = await api.image(o.access_url, searchRa!, searchDec!, CUTOUT_SIZE_DEG, view);
          if (cancelled) return;
          cacheRef.current.set(key, img);
          done += 1;
          setPreloadDone(done);
          bumpCache();
        },
        () => {
          done += 1;
          setPreloadDone(done);
        },
      );
      if (!cancelled) setPreloadDone(items.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [searchRa, searchDec, selectedBand, total, bandObs, view]);

  // priority-fetch A and B
  useEffect(() => {
    if (searchRa == null || searchDec == null || !obsA || !obsB) return;
    let cancelled = false;
    (async () => {
      await Promise.all(
        [obsA, obsB].map(async (o) => {
          const key = o.access_url + "|" + view;
          if (cacheRef.current.has(key)) return;
          try {
            const img = await api.image(o.access_url, searchRa!, searchDec!, CUTOUT_SIZE_DEG, view);
            if (cancelled) return;
            cacheRef.current.set(key, img);
            bumpCache();
          } catch {
            /* preload will retry */
          }
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [obsA, obsB, searchRa, searchDec, view]);

  // difference mode (WCS-registered comparison with band metadata)
  useEffect(() => {
    if (mode !== "difference" || !obsA || !obsB || searchRa == null || searchDec == null) {
      setDiff(null);
      setDiffErr(null);
      return;
    }
    let cancelled = false;
    const seq = ++diffSeqRef.current;
    setDiffLoading(true);
    setDiffErr(null);
    api
      .compare(obsA.access_url, obsB.access_url, searchRa, searchDec, CUTOUT_SIZE_DEG, view, obsA, obsB)
      .then((c) => {
        if (cancelled || seq !== diffSeqRef.current) return;
        setDiff(c);
      })
      .catch((e) => {
        if (cancelled || seq !== diffSeqRef.current) return;
        setDiffErr(e instanceof Error ? e.message : "Failed to compute difference");
      })
      .finally(() => {
        if (seq === diffSeqRef.current) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, obsA, obsB, searchRa, searchDec, view]);

  const cacheA = obsA ? cacheRef.current.get(obsA.access_url + "|" + view) ?? null : null;
  const cacheB = obsB ? cacheRef.current.get(obsB.access_url + "|" + view) ?? null : null;

  let viewerA: string | null = null;
  let viewerB: string | null = null;
  let viewerDiff: string | null = null;
  let viewerAOrig: string | null = null;
  let viewerBOrig: string | null = null;
  let viewerW = 0;
  let viewerH = 0;
  let viewerLoading = false;
  let viewerErr: string | null = null;
  if (mode === "difference") {
    viewerA = diff?.image_a ?? null; // aligned pair (common grid)
    viewerB = diff?.image_b ?? null;
    viewerDiff = diff?.image_diff ?? null;
    viewerAOrig = diff?.image_a_orig ?? null; // original native-grid cutouts
    viewerBOrig = diff?.image_b_orig ?? null;
    viewerW = diff?.width ?? 0;
    viewerH = diff?.height ?? 0;
    viewerLoading = diffLoading;
    viewerErr = diffErr;
  } else {
    viewerA = cacheA?.image ?? null;
    viewerB = cacheB?.image ?? null;
    viewerW = cacheA?.width ?? cacheB?.width ?? 0;
    viewerH = cacheA?.height ?? cacheB?.height ?? 0;
    viewerLoading = !cacheA || (mode === "blink" && !cacheB);
  }

  const reg = diff?.registration ?? null;
  const regCaption = reg
    ? reg.method === "failed"
      ? "registration failed"
      : reg.method === "feature"
        ? `geometric registration · ${reg.nInliers} sources`
        : `${reg.nInliers} matched stars · RMS ${reg.rmsArcsec != null ? `${reg.rmsArcsec.toFixed(2)}″` : "—"}`
    : null;

  const onSelectBand = (band: string) => {
    setSelectedBand(band);
    cacheRef.current = new Map();
    setPreloadDone(0);
    const bo = dedupeObservations(observations.filter((o) => o.band === band));
    setIndexA(0);
    setIndexB(Math.max(0, bo.length - 1));
  };

  const preloadActive = preloadTotal > 0 && preloadDone < preloadTotal;
  const wlRange = useMemo(() => {
    if (!bands.length) return null;
    const mins = bands.map((b) => b.wavelength_min_um).filter(Boolean) as number[];
    const maxs = bands.map((b) => b.wavelength_max_um).filter(Boolean) as number[];
    if (!mins.length || !maxs.length) return null;
    return `${Math.min(...mins).toFixed(2)}–${Math.max(...maxs).toFixed(2)} µm`;
  }, [bands]);
  const collectionsLabel = collections.length
    ? collections.join(" + ").replace(/spherex_/g, "")
    : "spherex_qr2";

  const epochSpan = useMemo(() => {
    const mjds = bandObs.map((o) => o.date_mjd).filter((m): m is number => m != null);
    if (mjds.length < 2) return null;
    const days = Math.max(...mjds) - Math.min(...mjds);
    return days > 1 ? `${(days / 365.25).toFixed(2)} yr` : `${days.toFixed(1)} d`;
  }, [bandObs]);

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f3f0e7] text-neutral-900">
      {/* header */}
      <header className="sticky top-0 z-40 border-b border-black/[0.08] bg-[#f3f0e7]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[980px] items-center justify-between px-5">
          <div className="flex items-center gap-2.5">
            <NasaLogo size={30} />
            <span className="text-[17px] font-semibold tracking-tight text-neutral-900">
              SPHEREx Explorer
            </span>
          </div>
          <nav className="flex items-center gap-1">
            <Button
              variant="ghost"
              className="h-8 rounded-full px-3 text-[13px] font-medium text-neutral-700 hover:bg-black/5 hover:text-black"
            >
              Explore
            </Button>
            <Button
              variant="ghost"
              className="h-8 rounded-full px-3 text-[13px] font-medium text-neutral-700 hover:bg-black/5 hover:text-black"
            >
              About
            </Button>
            <AboutDialog>
              <Button
                variant="ghost"
                className="h-8 rounded-full px-3 text-[13px] font-medium text-neutral-700 hover:bg-black/5 hover:text-black"
              >
                Data
              </Button>
            </AboutDialog>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[980px] px-5 py-6">
        {/* search */}
        <section className="mb-5">
          <SearchPanel examples={examples} onSearch={onSearch} loading={searching} />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-neutral-500">
            {searchRa != null && searchDec != null ? (
              <span className="font-mono">
                RA {searchRa.toFixed(3)}°, Dec {searchDec.toFixed(3)}° · {observations.length} observations
              </span>
            ) : (
              <span className="font-mono">Enter a sky position to begin.</span>
            )}
            {preloadActive && (
              <span className="font-mono text-neutral-600">
                · Preloading {preloadDone}/{preloadTotal}…
              </span>
            )}
            {searchErr && (
              <span className="rounded bg-red-100 px-2 py-0.5 text-red-700">{searchErr}</span>
            )}
          </div>
          {preloadActive && (
            <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-black/10">
              <div
                className="h-full bg-neutral-800 transition-all duration-300"
                style={{ width: `${preloadTotal ? (preloadDone / preloadTotal) * 100 : 0}%` }}
              />
            </div>
          )}
        </section>

        {/* view style: Starfield vs Heatmap */}
        <section className="mb-3 flex items-center justify-end gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            View
          </span>
          <div className="flex items-center gap-0.5 rounded-full bg-white p-0.5 shadow-sm border border-black/[0.06]">
            {(["starfield", "heatmap"] as ViewStyle[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-full px-3 py-1 text-[11px] font-medium capitalize transition ${
                  view === v
                    ? "bg-black text-white shadow-sm"
                    : "text-neutral-600 hover:text-black"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </section>

        {/* viewer */}
        <section className="mb-6 aspect-[16/10] w-full sm:aspect-[16/9]">
          <SkyViewer
            imageA={viewerA}
            imageB={viewerB}
            imageDiff={viewerDiff}
            imageAOrig={viewerAOrig}
            imageBOrig={viewerBOrig}
            wcs={cacheA?.metadata?.wcs ?? null}
            modeCaption={mode === "difference" ? regCaption : null}
            width={viewerW}
            height={viewerH}
            cutoutRa={searchRa ?? 0}
            cutoutDec={searchDec ?? 0}
            cutoutSize={CUTOUT_SIZE_DEG}
            mode={mode}
            onModeChange={setMode}
            diffView={diffView}
            onDiffViewChange={setDiffView}
            aLabel={`${formatMJD(obsA?.date_mjd ?? null)}${obsA?.band ? ` · ${obsA.band.replace("SPHEREx-", "")}` : ""}`}
            bLabel={`${formatMJD(obsB?.date_mjd ?? null)}${obsB?.band ? ` · ${obsB.band.replace("SPHEREx-", "")}` : ""}`}
            loading={viewerLoading}
            error={viewerErr}
          />
        </section>

        {/* registration + comparison diagnostics (difference mode only) */}
        {mode === "difference" && reg && (
          <section className="mb-6 rounded-xl border border-black/[0.06] bg-white/70 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                Registration
              </span>
              {reg.method === "failed" ? (
                <span className="font-medium text-red-700">failed — comparison blocked</span>
              ) : (
                <span className="font-medium text-neutral-900">
                  {reg.method === "feature" ? "geometric (star-pattern)" : "WCS"}{reg.nInliers > 0 ? " + reference stars" : ""}
                  {" · "}
                  {reg.detail}
                </span>
              )}
              <span className="text-neutral-400">·</span>
              <span className="text-neutral-600">
                output {reg.outputScaleArcsec.toFixed(2)}″/px, {reg.outputOrientation.split(",")[0]}
              </span>
            </div>
            {diff?.difference && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-neutral-600">
                <span>
                  normalization: {diff.difference.method === "stars" ? `${diff.difference.n_stars} stars` : "pixel fit"}
                  {diff.difference.scale != null && ` · scale ×${diff.difference.scale.toFixed(3)}`}
                </span>
                <span className="text-neutral-400">·</span>
                <span>
                  {diff.difference.candidates.length} candidate {diff.difference.candidates.length === 1 ? "source" : "sources"} (≥5σ, unconfirmed)
                </span>
              </div>
            )}
            {diff?.warnings && diff.warnings.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-amber-700">
                {diff.warnings.map((w, i) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[11px] text-neutral-400">
              Difference pixels show change between epochs after WCS alignment, flag masking,
              zodiacal subtraction and photometric normalization. Candidates are unconfirmed
              difference sources — not validated detections or moving objects.
            </p>
          </section>
        )}

        {/* observation timeline (with inline band selector) */}
        <section className="mb-7 border-t border-black/[0.08] pt-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-neutral-900">Observation Timeline</h2>
            <Select value={selectedBand ?? undefined} onValueChange={onSelectBand}>
              <SelectTrigger className="h-8 w-[170px] rounded-lg border-neutral-300 bg-white text-[12px] font-medium text-neutral-800 focus:ring-blue-300">
                <SelectValue placeholder="Select band" />
              </SelectTrigger>
              <SelectContent className="rounded-lg">
                {bands.map((b) => (
                  <SelectItem key={b.band} value={b.band} className="text-[12px]">
                    <span className="font-mono">{b.band.replace("SPHEREx-", "")}</span>
                    <span className="ml-2 text-neutral-500">
                      {b.wavelength_center_um?.toFixed(2)} µm · {b.count}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <TwoHandleTimeline
            observations={observations.filter((o) => o.band === selectedBand)}
            indexA={indexA}
            indexB={indexB}
            onChangeA={setIndexA}
            onChangeB={setIndexB}
          />
          {(obsA || obsB) && (
            <p className="mt-3 text-[12px] text-neutral-600">
              <span className="text-neutral-400">Observation: </span>
              {formatMJD(obsA?.date_mjd ?? null)}
              {obsA?.band && (
                <span className="ml-2 font-mono">{obsA.band.replace("SPHEREx-", "")}</span>
              )}
              {obsA?.wavelength_center_um != null && (
                <span className="ml-1 text-neutral-400">
                  · {obsA.wavelength_center_um.toFixed(2)} µm
                </span>
              )}
              {obsA?.calib_level != null && (
                <span className="ml-2 text-neutral-400">· Level {obsA.calib_level}</span>
              )}
              <span className="ml-2 text-neutral-400">vs</span>
              <span className="ml-2 font-mono">{formatMJD(obsB?.date_mjd ?? null)}</span>
              {epochSpan && (
                <span className="ml-2 text-neutral-400">· baseline {epochSpan}</span>
              )}
            </p>
          )}
        </section>

        {/* observation information */}
        <section className="mb-7 border-t border-black/[0.08] pt-5">
          <h2 className="mb-3 text-[15px] font-semibold text-neutral-900">
            Observation Information
          </h2>
          <dl className="text-[13px]">
            <InfoRow label="Observations" value={`${observations.length} observations`} />
            <InfoRow label="Epoch A observed" value={obsA ? formatDateTimeUx(obsA.date_iso, obsA.date_mjd) : "—"} />
            <InfoRow label="Epoch B observed" value={obsB ? formatDateTimeUx(obsB.date_iso, obsB.date_mjd) : "—"} />
            <InfoRow
              label="Archive release"
              value={
                obsA?.release_iso || obsB?.release_iso
                  ? [obsA?.release_iso?.slice(0, 10), obsB?.release_iso?.slice(0, 10)]
                      .filter(Boolean)
                      .join(" / ")
                  : "—"
              }
            />
            <InfoRow label="Wavelengths" value={wlRange ?? "—"} />
            <InfoRow label="Bands" value="D1–D6 (0.75–5.0 µm)" />
            <InfoRow label="Mission" value="SPHEREx" />
            <InfoRow label="Collections" value={collectionsLabel} />
            <InfoRow label="Data source" value="NASA / IPAC IRSA" />
          </dl>
        </section>

        {/* example regions */}
        <ExampleGallery examples={examples} onExplore={onSearch} style={view} />
      </main>

      {/* footer */}
      <footer className="border-t border-black/[0.08] bg-[#f3f0e7] py-5">
        <div className="mx-auto flex w-full max-w-[980px] flex-col items-center justify-between gap-1 px-5 text-[11px] text-neutral-500 sm:flex-row">
          <span>SPHEREx Explorer · NASA Space Apps prototype</span>
          <span className="font-mono">Live data · NASA / IPAC IRSA · {collectionsLabel}</span>
        </div>
      </footer>
    </div>
  );
}

function formatDateTimeUx(iso: string | null, mjd: number | null): string {
  if (iso) {
    const d = new Date(iso.endsWith("Z") ? iso : iso.replace(" ", "T") + "Z");
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
  return formatMJD(mjd);
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-black/[0.04] py-1.5 last:border-0">
      <dt className="text-[12px] text-neutral-500">{label}</dt>
      <dd className="text-right text-[13px] font-medium text-neutral-900">{value}</dd>
    </div>
  );
}
