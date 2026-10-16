"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useGridSVG, fmtRa, fmtDec, pixelToSkyWcs } from "@/components/spherex/coord-grid";
import type { FitsMetaWcs } from "@/lib/spherex-api";

export type ViewMode = "single" | "blink" | "difference";
export type DiffView = "slider" | "side" | "subtract";

interface SkyViewerProps {
  imageA: string | null;
  imageB: string | null;
  imageDiff: string | null;
  /** original (native-grid) cutouts for the side-by-side difference view */
  imageAOrig?: string | null;
  imageBOrig?: string | null;
  /** FITS WCS of image A (raw view) — enables correct cursor readout on
   *  rotated cutouts; the difference grid is north-up and uses the linear
   *  fallback by construction. */
  wcs?: FitsMetaWcs | null;
  /** small caption shown in difference mode (e.g. "WCS-aligned") */
  modeCaption?: string | null;
  width: number;
  height: number;
  cutoutRa: number;
  cutoutDec: number;
  cutoutSize: number;
  mode: ViewMode;
  onModeChange: (m: ViewMode) => void;
  diffView: DiffView;
  onDiffViewChange: (d: DiffView) => void;
  aLabel: string;
  bLabel: string;
  loading: boolean;
  error: string | null;
}

interface ViewState {
  tx: number;
  ty: number;
  scale: number;
}

function zoomPct(scale: number, base: number): string {
  if (!base) return "100X";
  return `${Math.round((scale / base) * 100)}X`;
}

/**
 * SkyViewer — star-field image viewer.
 *
 * Modes:
 *  - single:  show observation A.
 *  - blink:   rapidly alternate A ↔ B.
 *  - difference: compare A and B via a draggable Slider wipe, Side-by-side,
 *               or the computed Subtract (A−B) image.
 *
 * Interaction: a dedicated `overflow-hidden` viewport that never moves; only
 * the inner "stage" is transformed. Panning is clamped; wheel zoom is
 * cursor-centred; pinch zoom is midpoint-centred; touch + mouse via pointer
 * events.
 */
export function SkyViewer({
  imageA,
  imageB,
  imageDiff,
  imageAOrig,
  imageBOrig,
  wcs,
  modeCaption,
  width,
  height,
  cutoutRa,
  cutoutDec,
  cutoutSize,
  mode,
  onModeChange,
  diffView,
  onDiffViewChange,
  aLabel,
  bLabel,
  loading,
  error,
}: SkyViewerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewState>({ tx: 0, ty: 0, scale: 1 });
  const [baseScale, setBaseScale] = useState(1);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [cursor, setCursor] = useState<{ ra: number; dec: number } | null>(null);
  const [wipe, setWipe] = useState(0.5); // slider divider position 0..1

  // blink state
  const [showA, setShowA] = useState(true);
  useEffect(() => {
    if (mode !== "blink") return;
    const id = window.setInterval(() => setShowA((p) => !p), 620);
    return () => window.clearInterval(id);
  }, [mode]);

  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });
  const boxRef = useRef(box);
  useEffect(() => {
    boxRef.current = box;
  });

  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const pinchRef = useRef<{
    dist: number;
    scale: number;
    tx: number;
    ty: number;
    mx: number;
    my: number;
  } | null>(null);
  const wipeDrag = useRef(false);

  const pixelScale = width ? cutoutSize / width : 0;
  const gridWcs = mode === "difference" ? null : (wcs ?? null);
  const gridSVG = useGridSVG(width, height, cutoutRa, cutoutDec, pixelScale, gridWcs);
  const inSideMode = mode === "difference" && diffView === "side";

  // measure viewport + re-clamp on resize
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const r = wrap.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
      const v = viewRef.current;
      const dW = width * v.scale;
      const dH = height * v.scale;
      if (!r.width || !r.height || !width || !height) return;
      const minVis = 56;
      const maxX = dW <= r.width ? Math.max(0, (r.width - dW) / 2) : r.width / 2 + dW / 2 - minVis;
      const maxY = dH <= r.height ? Math.max(0, (r.height - dH) / 2) : r.height / 2 + dH / 2 - minVis;
      const ntx = Math.max(-maxX, Math.min(maxX, v.tx));
      const nty = Math.max(-maxY, Math.min(maxY, v.ty));
      if (ntx !== v.tx || nty !== v.ty) setView({ ...v, tx: ntx, ty: nty });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [width, height]);

  const clampView = (tx: number, ty: number, scale: number) => {
    const dW = width * scale;
    const dH = height * scale;
    const cW = box.w;
    const cH = box.h;
    if (!cW || !cH || !width || !height) return { tx, ty };
    const minVis = 56;
    const maxX = dW <= cW ? Math.max(0, (cW - dW) / 2) : cW / 2 + dW / 2 - minVis;
    const maxY = dH <= cH ? Math.max(0, (cH - dH) / 2) : cH / 2 + dH / 2 - minVis;
    return {
      tx: Math.max(-maxX, Math.min(maxX, tx)),
      ty: Math.max(-maxY, Math.min(maxY, ty)),
    };
  };

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !width || !height) return;
    const r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const s = Math.min(r.width / width, r.height / height) * 0.96;
    const ns = Math.max(s, 0.01);
    setView({ tx: 0, ty: 0, scale: ns });
    setBaseScale(ns);
  }, [width, height]);
  useEffect(() => {
    fit();
  }, [fit]);

  // wheel zoom centred on the cursor (disabled in side-by-side)
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const handler = (e: WheelEvent) => {
      if (inSideMode) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const cCx = rect.width / 2;
      const cCy = rect.height / 2;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const ns = Math.min(50, Math.max(0.05, v.scale * factor));
        const f = ns / v.scale;
        const ntx = v.tx * f + (px - cCx) * (1 - f);
        const nty = v.ty * f + (py - cCy) * (1 - f);
        const b = boxRef.current;
        const cW = b.w || rect.width;
        const cH = b.h || rect.height;
        const dW = width * ns;
        const dH = height * ns;
        const minVis = 56;
        const maxX = dW <= cW ? Math.max(0, (cW - dW) / 2) : cW / 2 + dW / 2 - minVis;
        const maxY = dH <= cH ? Math.max(0, (cH - dH) / 2) : cH / 2 + dH / 2 - minVis;
        return {
          scale: ns,
          tx: Math.max(-maxX, Math.min(maxX, ntx)),
          ty: Math.max(-maxY, Math.min(maxY, nty)),
        };
      });
    };
    wrap.addEventListener("wheel", handler, { passive: false });
    return () => wrap.removeEventListener("wheel", handler);
  }, [width, height, inSideMode]);

  const updateCursor = (px: number, py: number) => {
    if (!width || !height || !box.w || !pixelScale) return;
    const cCx = box.w / 2;
    const cCy = box.h / 2;
    const ix = (px - (cCx + view.tx)) / view.scale + width / 2;
    const iy = (py - (cCy + view.ty)) / view.scale + height / 2;
    if (ix < 0 || ix >= width || iy < 0 || iy >= height) {
      setCursor(null);
      return;
    }
    // real WCS when available (raw cutouts are rotated); the difference
    // grid is north-up TAN so the linear approximation applies there
    if (mode !== "difference" && gridWcs) {
      const s = pixelToSkyWcs(gridWcs, ix, iy);
      setCursor({ ra: s.ra, dec: s.dec });
      return;
    }
    const cosd = Math.cos((cutoutDec * Math.PI) / 180);
    let ra =
      cutoutRa + ((ix - width / 2) * pixelScale) / Math.max(cosd, 1e-3);
    const dec = cutoutDec - (iy - height / 2) * pixelScale;
    ra = ((ra % 360) + 360) % 360;
    setCursor({ ra, dec });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (inSideMode) return;
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      dragRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    } else if (pointers.current.size === 2) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchRef.current = {
        dist,
        scale: view.scale,
        tx: view.tx,
        ty: view.ty,
        mx: (pts[0].x + pts[1].x) / 2,
        my: (pts[0].y + pts[1].y) / 2,
      };
      dragRef.current = null;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (!inSideMode) updateCursor(px, py);
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinchRef.current && pointers.current.size >= 2) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      const p = pinchRef.current;
      const ns = Math.min(50, Math.max(0.05, p.scale * (dist / (p.dist || 1))));
      const cCx = rect.width / 2;
      const cCy = rect.height / 2;
      const ix = (p.mx - (cCx + p.tx)) / p.scale + width / 2;
      const iy = (p.my - (cCy + p.ty)) / p.scale + height / 2;
      const ntx = mx - cCx - (ix - width / 2) * ns;
      const nty = my - cCy - (iy - height / 2) * ns;
      const c = clampView(ntx, nty, ns);
      setView({ scale: ns, tx: c.tx, ty: c.ty });
      return;
    }
    if (dragRef.current) {
      const ddx = e.clientX - dragRef.current.x;
      const ddy = e.clientY - dragRef.current.y;
      const ntx = dragRef.current.tx + ddx;
      const nty = dragRef.current.ty + ddy;
      setView((v) => {
        const c = clampView(ntx, nty, v.scale);
        return { ...v, tx: c.tx, ty: c.ty };
      });
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
    if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()];
      dragRef.current = { x: p.x, y: p.y, tx: view.tx, ty: view.ty };
    } else if (pointers.current.size === 0) {
      dragRef.current = null;
    }
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  // wipe divider drag (Slider sub-mode)
  const onWipePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    wipeDrag.current = true;
  };
  const onWipePointerMove = (e: React.PointerEvent) => {
    if (!wipeDrag.current || !wrapRef.current) return;
    e.stopPropagation();
    const rect = wrapRef.current.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setWipe(p);
  };
  const onWipePointerUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    wipeDrag.current = false;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  // click-to-position on the track
  const onTrackClick = (e: React.PointerEvent) => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setWipe(p);
  };

  const reset = () => fit();
  const stageTransform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;

  // what the stage shows, per mode
  const sliderMode = mode === "difference" && diffView === "slider";
  const subtractMode = mode === "difference" && diffView === "subtract";

  // shared centered-image className/style
  const imgClass =
    "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none";

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full touch-none overflow-hidden rounded-xl border border-black/[0.08] bg-black"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onPointerLeave={() => setCursor(null)}
    >
      {/* ---------------- STAGE rendering ---------------- */}
      {inSideMode ? (
        // SIDE-BY-SIDE: original (native-grid) cutouts with LEFT/RIGHT labels
        <div className="absolute inset-0 flex">
          <div className="relative h-full w-1/2 overflow-hidden border-r border-white/15">
            {imageAOrig && (
              <img
                src={imageAOrig}
                alt="Observation A (original cutout)"
                className="absolute inset-0 h-full w-full object-cover"
                draggable={false}
              />
            )}
            <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-white/85 px-2.5 py-1.5 text-[11px] leading-tight text-black backdrop-blur-md">
              <div className="font-semibold uppercase tracking-wide text-neutral-500">Left · original</div>
              <div className="font-semibold">Observation A</div>
              <div className="font-mono text-neutral-600">{aLabel}</div>
            </div>
          </div>
          <div className="relative h-full w-1/2 overflow-hidden">
            {imageBOrig && (
              <img
                src={imageBOrig}
                alt="Observation B (original cutout)"
                className="absolute inset-0 h-full w-full object-cover"
                draggable={false}
              />
            )}
            <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-white/85 px-2.5 py-1.5 text-right text-[11px] leading-tight text-black backdrop-blur-md">
              <div className="font-semibold uppercase tracking-wide text-neutral-500">Right · original</div>
              <div className="font-semibold">Observation B</div>
              <div className="font-mono text-neutral-600">{bLabel}</div>
            </div>
          </div>
        </div>
      ) : sliderMode ? (
        <>
          {/* stage A: imgA + grid (full) */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{ transform: stageTransform, transformOrigin: "center center" }}
          >
            {imageA && (
              <img src={imageA} alt="Observation A" width={width || 1} height={height || 1} draggable={false} className={imgClass} />
            )}
            {gridSVG && (
              <img
                src={`data:image/svg+xml;utf8,${encodeURIComponent(gridSVG)}`}
                alt=""
                width={width}
                height={height}
                draggable={false}
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none"
              />
            )}
          </div>
          {/* clipped layer B: imgB shows only right of the wipe */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{ clipPath: `inset(0 0 0 ${wipe * 100}%)` }}
          >
            <div
              className="absolute inset-0"
              style={{ transform: stageTransform, transformOrigin: "center center" }}
            >
              {imageB && (
                <img src={imageB} alt="Observation B" width={width || 1} height={height || 1} draggable={false} className={imgClass} />
              )}
            </div>
          </div>
          {/* wipe divider + handle (screen-fixed, draggable) */}
          <div
            className="absolute inset-y-0 z-10"
            style={{ left: `${wipe * 100}%` }}
            onPointerDown={onTrackClick}
          >
            <div className="absolute inset-y-0 -ml-px w-0.5 bg-white/85" />
            <button
              onPointerDown={onWipePointerDown}
              onPointerMove={onWipePointerMove}
              onPointerUp={onWipePointerUp}
              onPointerCancel={onWipePointerUp}
              className="absolute top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-neutral-300 bg-white text-neutral-700 shadow-lg"
              aria-label="Drag to compare A and B"
            >
              <span className="text-[13px] leading-none">⇄</span>
            </button>
          </div>
          {/* A / B edge labels */}
          <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-md">
            A · {aLabel}
          </div>
          <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-md">
            B · {bLabel}
          </div>
        </>
      ) : (
        // SINGLE / BLINK / SUBTRACT: one stage
        <div
          className="pointer-events-none absolute inset-0"
          style={{ transform: stageTransform, transformOrigin: "center center" }}
        >
          {imageA && (
            <img
              src={imageA}
              alt="Observation A"
              width={width || 1}
              height={height || 1}
              draggable={false}
              className={imgClass}
              style={{ opacity: mode === "difference" ? 0 : mode === "blink" ? (showA ? 1 : 0) : 1 }}
            />
          )}
          {imageB && (
            <img
              src={imageB}
              alt="Observation B"
              width={width || 1}
              height={height || 1}
              draggable={false}
              className={imgClass}
              style={{ opacity: mode === "difference" ? 0 : mode === "blink" ? (showA ? 0 : 1) : 0 }}
            />
          )}
          {imageDiff && (
            <img
              src={imageDiff}
              alt="Difference A−B"
              width={width || 1}
              height={height || 1}
              draggable={false}
              className={imgClass}
              style={{ opacity: mode === "difference" && subtractMode ? 1 : 0 }}
            />
          )}
          {gridSVG && mode !== "difference" && (
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(gridSVG)}`}
              alt=""
              width={width}
              height={height}
              draggable={false}
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none"
            />
          )}
        </div>
      )}

      {/* top-left coordinate readout (cursor) */}
      {!inSideMode && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/50 px-2 py-1 font-mono text-[11px] text-neutral-200 backdrop-blur-md">
          {cursor
            ? `${fmtRa(cursor.ra)}  ${fmtDec(cursor.dec)}`
            : `${fmtRa(cutoutRa)}  ${fmtDec(cutoutDec)}`}
        </div>
      )}

      {/* blink indicator */}
      {mode === "blink" && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-white/90 px-3 py-1 text-[11px] font-medium text-black backdrop-blur-md">
          {showA ? "Observation A" : "Observation B"}
        </div>
      )}

      {/* difference-mode caption (e.g. "WCS-aligned · N matched stars") */}
      {mode === "difference" && modeCaption && !loading && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-white/85 px-3 py-1 text-[11px] font-medium text-black backdrop-blur-md">
          {modeCaption}
        </div>
      )}

      {/* Difference sub-toggle (shown only in difference mode) */}
      {mode === "difference" && (
        <div
          className="absolute bottom-16 left-1/2 -translate-x-1/2"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-0.5 rounded-full bg-white/92 p-0.5 shadow-sm backdrop-blur-md">
            {(["slider", "side", "subtract"] as DiffView[]).map((d) => (
              <button
                key={d}
                onClick={() => onDiffViewChange(d)}
                className={`rounded-full px-3 py-1 text-[11px] font-medium capitalize transition ${
                  diffView === d
                    ? "bg-black text-white shadow-sm"
                    : "text-neutral-600 hover:text-black"
                }`}
              >
                {d === "side" ? "Side by side" : d}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* bottom control pill: mode toggle (left) + zoom (right) */}
      <div
        className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 rounded-full bg-white/92 px-2 py-1.5 shadow-sm backdrop-blur-md"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-0.5 rounded-full bg-neutral-100 p-0.5">
          {(["single", "blink", "difference"] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize transition ${
                mode === m
                  ? "bg-black text-white shadow-sm"
                  : "text-neutral-600 hover:text-black"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-[11px] font-medium text-neutral-700">
          <button
            onClick={() =>
              setView((v) => {
                const ns = Math.max(0.05, v.scale * 0.77);
                const c = clampView(v.tx, v.ty, ns);
                return { scale: ns, tx: c.tx, ty: c.ty };
              })
            }
            className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-100 text-sm leading-none text-neutral-700 transition hover:bg-neutral-200"
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="w-12 text-center font-mono text-neutral-600">
            {zoomPct(view.scale, baseScale)}
          </span>
          <button
            onClick={() =>
              setView((v) => {
                const ns = Math.min(50, v.scale * 1.3);
                const c = clampView(v.tx, v.ty, ns);
                return { scale: ns, tx: c.tx, ty: c.ty };
              })
            }
            className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-100 text-sm leading-none text-neutral-700 transition hover:bg-neutral-200"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            onClick={reset}
            className="ml-1 flex h-6 items-center justify-center rounded-full bg-neutral-100 px-2 text-[10px] font-medium text-neutral-700 transition hover:bg-neutral-200"
            aria-label="Reset view"
            title="Reset view"
          >
            Reset
          </button>
        </div>
      </div>

      {/* states */}
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-full bg-black/70 px-4 py-2 text-[12px] font-medium text-neutral-100 backdrop-blur-md">
            Loading SPHEREx cutout…
          </div>
        </div>
      )}
      {error && !loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="max-w-[80%] rounded-xl bg-white/90 px-4 py-3 text-center text-[12px] text-red-700 shadow-sm">
            {error}
          </div>
        </div>
      )}
      {!imageA && !loading && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-[13px] text-neutral-500">
            Search a sky position to retrieve real SPHEREx observations.
          </div>
        </div>
      )}
    </div>
  );
}
