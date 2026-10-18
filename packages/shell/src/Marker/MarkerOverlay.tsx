import { useEffect, useMemo, useRef } from "react";
import * as markerjs2 from "markerjs2";

export interface MarkerOverlayProps {
  /** Source image to annotate. Becomes the canvas MarkerJS draws over. */
  imageBlob: Blob;
  /** Called with the annotated PNG (data: URL) and MarkerJS state JSON. */
  onConfirm: (annotatedDataUrl: string, state: markerjs2.MarkerAreaState) => void;
  /** Called when the user closes the toolbar without rendering. */
  onCancel: () => void;
}

/**
 * Compute the union bbox in canvas-pixels from a MarkerJS state. Covers
 * rectangular markers (left/top/width/height) + linear markers (x1,y1,x2,y2)
 * — freehand strokes are skipped (their state shape varies). Returns
 * undefined if no extractable markers were drawn.
 *
 * The returned bbox is used as `bboxPx` on bbox-img markers so the backend
 * Vision pre-pass can tell Gemini WHERE to focus on the annotated PNG.
 */
export function computeBboxFromState(
  state: markerjs2.MarkerAreaState | undefined,
): { x: number; y: number; w: number; h: number } | undefined {
  if (!state || !Array.isArray(state.markers)) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of state.markers) {
    const ms = m as Record<string, unknown>;
    // RectangularBox shape (Rectangle, Frame, Cover, Highlight, Ellipse, …)
    if (
      typeof ms.left === "number" &&
      typeof ms.top === "number" &&
      typeof ms.width === "number" &&
      typeof ms.height === "number"
    ) {
      minX = Math.min(minX, ms.left);
      minY = Math.min(minY, ms.top);
      maxX = Math.max(maxX, ms.left + ms.width);
      maxY = Math.max(maxY, ms.top + ms.height);
    } else if (
      // Linear shape (Line, Arrow, Measurement)
      typeof ms.x1 === "number" &&
      typeof ms.y1 === "number" &&
      typeof ms.x2 === "number" &&
      typeof ms.y2 === "number"
    ) {
      minX = Math.min(minX, ms.x1, ms.x2);
      minY = Math.min(minY, ms.y1, ms.y2);
      maxX = Math.max(maxX, ms.x1, ms.x2);
      maxY = Math.max(maxY, ms.y1, ms.y2);
    }
    // Freehand / Curve / Polygon: complex path data; skipped here.
  }
  if (!isFinite(minX) || !isFinite(maxX)) return undefined;
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    w: Math.round(maxX - minX),
    h: Math.round(maxY - minY),
  };
}

/**
 * Inline MarkerJS 2 overlay used by every marker driver. Wraps a fresh
 * `<img>` rendered from `imageBlob`, mounts MarkerArea on it in `inline`
 * mode rooted at our container, and forwards the `render` / `close` events.
 */
export default function MarkerOverlay({ imageBlob, onConfirm, onCancel }: MarkerOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const objectUrl = useMemo(() => URL.createObjectURL(imageBlob), [imageBlob]);

  useEffect(() => () => URL.revokeObjectURL(objectUrl), [objectUrl]);

  useEffect(() => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container) return;

    let area: markerjs2.MarkerArea | null = null;
    let cancelled = false;

    const start = () => {
      if (cancelled) return;
      area = new markerjs2.MarkerArea(img);
      area.targetRoot = container;
      area.settings.displayMode = "inline";
      area.uiStyleSettings.zIndex = "10000";
      // Keep the rendered PNG at the source pixel size — no downscale.
      area.renderAtNaturalSize = true;

      area.addEventListener("render", (ev) => {
        onConfirm(ev.dataUrl, ev.state);
      });
      area.addEventListener("close", () => {
        if (!cancelled) onCancel();
      });
      area.show();
    };

    if (img.complete && img.naturalWidth > 0) start();
    else img.addEventListener("load", start, { once: true });

    return () => {
      cancelled = true;
      img.removeEventListener("load", start);
      try { area?.close(); } catch { /* noop */ }
    };
  }, [objectUrl, onConfirm, onCancel]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(10, 14, 20, 0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <img
        ref={imgRef}
        src={objectUrl}
        alt="markup target"
        style={{ maxWidth: "100%", maxHeight: "100%", display: "block" }}
      />
    </div>
  );
}
