"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MaskData, AmbiguousZone } from "@/lib/use-sse";

interface MaskOverlayProps {
  maskData: MaskData;
  isHovering: boolean;
}

const HIDE_DELAY_MS = 400;

export function MaskOverlay({ maskData, isHovering }: MaskOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoneBiases, setZoneBiases] = useState<Record<string, number>>({});
  const [activeZone, setActiveZone] = useState<AmbiguousZone | null>(null);
  const [sliderPos, setSliderPos] = useState({ x: 0, y: 0 });
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drag state for the Edge Adjustment panel
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ px: 0, py: 0, ox: 0, oy: 0 });

  const [alphaState, setAlphaState] = useState<{
    data: Uint8ClampedArray;
    w: number;
    h: number;
  } | null>(null);

  const baseOutputRef = useRef<Uint8ClampedArray | null>(null);

  const hasInteractiveMode = !!(
    maskData.alpha_matte && maskData.zones.length > 0
  );

  useEffect(() => {
    setZoneBiases({});
    setActiveZone(null);
  }, [maskData.alpha_matte]);

  // Load the alpha matte PNG into an offscreen canvas to get pixel data
  useEffect(() => {
    if (!maskData.alpha_matte) {
      setAlphaState(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      setAlphaState({ data: ctx.getImageData(0, 0, w, h).data, w, h });
    };
    img.src = maskData.alpha_matte;
  }, [maskData.alpha_matte]);

  // Pre-compute the base (unbiased) output buffer once alpha loads
  useEffect(() => {
    if (!alphaState) {
      baseOutputRef.current = null;
      return;
    }
    const { data, w, h } = alphaState;
    const base = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const rawAlpha = data[i * 4] / 255;
      const v = Math.round((1 - rawAlpha) * 255);
      const idx = i * 4;
      base[idx] = v;
      base[idx + 1] = v;
      base[idx + 2] = v;
      base[idx + 3] = 255;
    }
    baseOutputRef.current = base;
  }, [alphaState]);

  // Canvas render — runs when biases, hover, or active zone changes
  useEffect(() => {
    if (!hasInteractiveMode || !alphaState || !baseOutputRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { data: alphaPixels, w, h } = alphaState;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext("2d")!;
    const out = new Uint8ClampedArray(baseOutputRef.current);

    for (const zone of maskData.zones) {
      const bias = zoneBiases[zone.id];
      if (!bias) continue;
      const { x, y, w: zw, h: zh } = zone.bbox;
      const xEnd = Math.min(x + zw, w);
      const yEnd = Math.min(y + zh, h);
      for (let py = y; py < yEnd; py++) {
        for (let px = x; px < xEnd; px++) {
          const i = py * w + px;
          const rawAlpha = alphaPixels[i * 4] / 255;
          if (rawAlpha <= 0.05 || rawAlpha >= 0.95) continue;
          const adjusted = Math.max(0, Math.min(1, rawAlpha + bias));
          const v = Math.round((1 - adjusted) * 255);
          const idx = i * 4;
          out[idx] = v;
          out[idx + 1] = v;
          out[idx + 2] = v;
        }
      }
    }

    ctx.putImageData(new ImageData(out, w, h), 0, 0);

    if (isHovering) {
      ctx.setLineDash([6, 4]);
      for (const zone of maskData.zones) {
        const active = activeZone?.id === zone.id;
        ctx.lineWidth = active ? 2.5 : 1;
        ctx.strokeStyle = active
          ? "rgba(52,211,153,0.9)"
          : "rgba(52,211,153,0.3)";
        ctx.strokeRect(
          zone.bbox.x - 2,
          zone.bbox.y - 2,
          zone.bbox.w + 4,
          zone.bbox.h + 4,
        );
      }
      ctx.setLineDash([]);
    }
  }, [hasInteractiveMode, alphaState, zoneBiases, isHovering, activeZone, maskData.zones]);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) return;
    hideTimerRef.current = setTimeout(() => {
      setActiveZone(null);
      hideTimerRef.current = null;
    }, HIDE_DELAY_MS);
  }, []);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  // Reset drag offset when the active zone changes
  useEffect(() => {
    setDragOffset(null);
  }, [activeZone?.id]);

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      cancelHide();
      const cur = dragOffset ?? { x: 0, y: 0 };
      dragStartRef.current = { px: e.clientX, py: e.clientY, ox: cur.x, oy: cur.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [dragOffset, cancelHide],
  );

  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    const dx = e.clientX - dragStartRef.current.px;
    const dy = e.clientY - dragStartRef.current.py;
    setDragOffset({
      x: dragStartRef.current.ox + dx,
      y: dragStartRef.current.oy + dy,
    });
  }, []);

  const onDragEnd = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !alphaState) return;

      const rect = canvas.getBoundingClientRect();
      const scaleX = alphaState.w / rect.width;
      const scaleY = alphaState.h / rect.height;
      const imgX = (e.clientX - rect.left) * scaleX;
      const imgY = (e.clientY - rect.top) * scaleY;

      const zone = maskData.zones.find(
        (z) =>
          imgX >= z.bbox.x &&
          imgX <= z.bbox.x + z.bbox.w &&
          imgY >= z.bbox.y &&
          imgY <= z.bbox.y + z.bbox.h,
      );

      if (zone) {
        cancelHide();
        setActiveZone(zone);
        setSliderPos({
          x: (zone.centroid.x / alphaState.w) * rect.width,
          y: (zone.centroid.y / alphaState.h) * rect.height,
        });
      } else {
        scheduleHide();
      }
    },
    [maskData.zones, alphaState, cancelHide, scheduleHide],
  );

  // Cleanup hide timer
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const overlayStyle = isHovering
    ? { opacity: 0.85, filter: "none", mixBlendMode: "normal" as const }
    : {
        opacity: 0.35,
        filter:
          "invert(1) sepia(1) saturate(4) hue-rotate(100deg) brightness(0.7)",
        mixBlendMode: "screen" as const,
      };

  if (!hasInteractiveMode) {
    return (
      <img
        src={maskData.display}
        alt="Mask overlay"
        className="pointer-events-none absolute inset-0 h-full w-full rounded-lg object-contain transition-[filter,opacity] duration-200"
        style={overlayStyle}
      />
    );
  }

  const canvasW = canvasRef.current?.offsetWidth ?? 400;

  return (
    <>
      <canvas
        ref={canvasRef}
        onMouseMove={isHovering ? handleMouseMove : undefined}
        className="absolute inset-0 h-full w-full rounded-lg transition-[filter,opacity] duration-200"
        style={{
          pointerEvents: isHovering ? "auto" : "none",
          ...overlayStyle,
        }}
      />
      {isHovering && activeZone && (
        <div
          className="absolute z-50 flex flex-col gap-1.5 rounded-lg border border-emerald-500/30 bg-card/95 px-3 py-2 shadow-2xl backdrop-blur-sm"
          style={{
            left:
              Math.max(8, Math.min(sliderPos.x + 16, canvasW - 190)) +
              (dragOffset?.x ?? 0),
            top: Math.max(8, sliderPos.y - 30) + (dragOffset?.y ?? 0),
            pointerEvents: "auto",
          }}
          onMouseEnter={cancelHide}
          onMouseLeave={() => { if (!draggingRef.current) scheduleHide(); }}
        >
          {/* Drag handle */}
          <div
            className="flex cursor-grab items-center gap-1.5 active:cursor-grabbing"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
          >
            <div className="flex gap-[2px]">
              <span className="block h-[3px] w-[3px] rounded-full bg-emerald-500/50" />
              <span className="block h-[3px] w-[3px] rounded-full bg-emerald-500/50" />
            </div>
            <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[10px] font-medium text-emerald-300 select-none">
              Edge Adjustment
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-muted-foreground select-none">
              &minus;
            </span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={zoneBiases[activeZone.id] ?? 0}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setZoneBiases((prev) => ({ ...prev, [activeZone.id]: val }));
              }}
              className="h-1 w-28 cursor-pointer accent-emerald-400"
            />
            <span className="text-[9px] text-muted-foreground select-none">
              +
            </span>
          </div>
          <div className="flex justify-between text-[8px] text-muted-foreground/60">
            <span>Exclude</span>
            <span className="tabular-nums text-emerald-300/70">
              {((zoneBiases[activeZone.id] ?? 0) * 100).toFixed(0)}%
            </span>
            <span>Include</span>
          </div>
        </div>
      )}
    </>
  );
}
