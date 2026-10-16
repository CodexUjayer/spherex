"use client";

import { useEffect, useState } from "react";
import { api, type SpherexExample, type ViewStyle } from "@/lib/spherex-api";

type LoadResult =
  | { image: string; band: string | null }
  | { error: true }
  | undefined; // undefined = not yet loaded

/** Horizontal gallery of real SPHEREx preview cutouts for example sky
 *  regions. Each thumbnail is fetched live from the IRSA archive. */
export function ExampleGallery({
  examples,
  onExplore,
  style = "starfield",
}: {
  examples: SpherexExample[];
  onExplore: (ra: number, dec: number) => void;
  style?: ViewStyle;
}) {
  // index-keyed results; only mutated inside async callbacks (lint-safe)
  const [loaded, setLoaded] = useState<Record<number, LoadResult>>({});

  useEffect(() => {
    let cancelled = false;
    examples.forEach((ex, i) => {
      api
        .preview(ex.ra, ex.dec, 0.25, style)
        .then((r) => {
          if (cancelled) return;
          setLoaded((prev) => ({ ...prev, [i]: { image: r.image, band: r.band } }));
        })
        .catch(() => {
          if (cancelled) return;
          setLoaded((prev) => ({ ...prev, [i]: { error: true } }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [examples, style]);

  return (
    <section>
      <h2 className="mb-3 text-[15px] font-semibold text-neutral-900">
        Explore example regions
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {examples.map((ex, i) => {
          const r = loaded[i];
          const loading = !r;
          const error = r && "error" in r;
          const image = r && "image" in r ? r.image : null;
          const band = r && "image" in r ? r.band : null;
          return (
            <button
              key={ex.name}
              onClick={() => onExplore(ex.ra, ex.dec)}
              className="group w-[140px] shrink-0 text-left"
            >
              <div className="relative aspect-square w-[140px] overflow-hidden rounded-lg border border-black/10 bg-black">
                {loading ? (
                  <div className="flex h-full items-center justify-center text-[10px] text-neutral-500">
                    loading…
                  </div>
                ) : error || !image ? (
                  <div className="flex h-full items-center justify-center text-[10px] text-neutral-500">
                    no coverage
                  </div>
                ) : (
                  <img
                    src={image}
                    alt={`SPHEREx preview of ${ex.name}`}
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]"
                  />
                )}
                {band && (
                  <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-mono text-white">
                    {band.replace("SPHEREx-", "")}
                  </span>
                )}
              </div>
              <div className="mt-2 text-[13px] font-semibold text-neutral-900">{ex.name}</div>
              <div className="text-[12px] font-medium text-blue-600 group-hover:underline">
                Explore →
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
