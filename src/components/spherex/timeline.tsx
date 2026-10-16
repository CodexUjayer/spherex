"use client";

import { useEffect, useRef, useState } from "react";
import type { Observation } from "@/lib/spherex-api";
import { dedupeObservations, formatMJD } from "@/lib/spherex-api";

interface TimelineProps {
  observations: Observation[];
  indexA: number;
  indexB: number;
  onChangeA: (i: number) => void;
  onChangeB: (i: number) => void;
}

/**
 * Two-handle chronological timeline.
 *
 * Observations are spaced **uniformly** (one slot per observation) rather than
 * linearly by date, so the slider is smooth and there's no huge empty gap
 * across SPHEREx's real ~6-month survey-cadence gap between epochs. The
 * actual dates are shown in the A/B labels and the range header so the real
 * cadence is still visible.
 *
 * The handle follows the cursor continuously (smooth) via window-level
 * pointer listeners (robust for fast drags and drags outside the track).
 */
export function TwoHandleTimeline({
  observations,
  indexA,
  indexB,
  onChangeA,
  onChangeB,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"A" | "B" | null>(null);
  const [dragPos, setDragPos] = useState<{ which: "A" | "B"; p: number } | null>(null);

  const obs = dedupeObservations(observations);
  const n = obs.length;
  const mjds = obs.map((o) => o.date_mjd ?? 0);
  const lo = n ? Math.min(...mjds) : 0;
  const hi = n ? Math.max(...mjds) : 1;

  // uniform spacing: observation i sits at i/(n-1) of the track
  const pct = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const posA = dragPos?.which === "A" ? dragPos.p * 100 : pct(indexA);
  const posB = dragPos?.which === "B" ? dragPos.p * 100 : pct(indexB);

  const pFromClientX = (clientX: number): number | null => {
    const track = trackRef.current;
    if (!track || n === 0) return null;
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  // window-level drag listeners (added once; act only while dragging)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const p = pFromClientX(e.clientX);
      if (p == null) return;
      setDragPos({ which: dragRef.current, p });
      const idx = Math.round(p * (n - 1));
      if (dragRef.current === "A") onChangeA(idx);
      else onChangeB(idx);
    };
    const onUp = () => {
      dragRef.current = null;
      setDragPos(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [n]);

  const startDrag = (which: "A" | "B") => (e: React.PointerEvent) => {
    e.stopPropagation();
    dragRef.current = which;
    const p = pFromClientX(e.clientX);
    if (p == null) return;
    setDragPos({ which, p });
    const idx = Math.round(p * (n - 1));
    if (which === "A") onChangeA(idx);
    else onChangeB(idx);
  };

  const a = n ? obs[Math.min(indexA, n - 1)] : null;
  const b = n ? obs[Math.min(indexB, n - 1)] : null;
  const leftPct = Math.min(posA, posB);
  const widthPct = Math.abs(posB - posA);

  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-between text-[11px] text-neutral-400">
        <span className="font-medium uppercase tracking-wider">Timeline</span>
        <span className="font-mono">
          {n} observations{n ? ` · ${formatMJD(lo)} → ${formatMJD(hi)}` : ""}
        </span>
      </div>

      <div className="relative h-8 touch-none overflow-x-clip">
        {/* usable track area, inset by half a handle width (22px) so the
            handles at 0% / 100% stay fully inside the viewport. */}
        <div
          ref={trackRef}
          className="absolute inset-y-0 left-[22px] right-[22px]"
        >
          <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-neutral-200" />
          {n > 0 && (
            <div
              className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-neutral-400"
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            />
          )}
          {n > 0 &&
            obs.map((o, i) => (
              <div
                key={o.access_url + i}
                className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-300"
                style={{ left: `${pct(i)}%` }}
              />
            ))}

          {/* handle A */}
          {n > 0 && (
            <div
              onPointerDown={startDrag("A")}
              className="absolute top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center"
              style={{ left: `${posA}%` }}
              role="slider"
              aria-label="Observation A"
              aria-valuenow={indexA}
            >
              <div className="size-4 rounded-full border-2 border-white bg-neutral-900 shadow-md" />
            </div>
          )}
          {/* handle B */}
          {n > 0 && (
            <div
              onPointerDown={startDrag("B")}
              className="absolute top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center"
              style={{ left: `${posB}%` }}
              role="slider"
              aria-label="Observation B"
              aria-valuenow={indexB}
            >
              <div className="size-4 rounded-full border-2 border-white bg-neutral-500 shadow-md" />
            </div>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex justify-between font-mono text-[11px] text-neutral-500">
        <span>
          <span className="text-neutral-400">A </span>
          {formatMJD(a?.date_mjd ?? null)}
        </span>
        <span className="hidden text-neutral-400 sm:inline">
          evenly spaced · dates show real survey cadence
        </span>
        <span>
          <span className="text-neutral-400">B </span>
          {formatMJD(b?.date_mjd ?? null)}
        </span>
      </div>
    </div>
  );
}
