import { useState, useCallback, useRef } from "react";
import { getViewport } from "./functions";

const SNAP_THRESHOLD = 24;
const CORNER_SIZE = 80; // px from corner to trigger quarter-snap

export type SnapZone =
  | "left" | "right" | "top" | "maximize"
  | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | null;

export interface SnapPreview {
  zone: SnapZone;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapResult {
  zone: SnapZone;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Calculate snap zone bounds */
export function getSnapBounds(zone: SnapZone): SnapResult | null {
  if (!zone) return null;
  const vp = getViewport();
  const hw = Math.round(vp.width / 2);
  const hh = Math.round(vp.height / 2);

  switch (zone) {
    case "left":
      return { zone, x: 0, y: 0, width: hw, height: vp.height };
    case "right":
      return { zone, x: hw, y: 0, width: vp.width - hw, height: vp.height };
    case "top":
    case "maximize":
      return { zone: "maximize", x: 0, y: 0, width: vp.width, height: vp.height };
    case "top-left":
      return { zone, x: 0, y: 0, width: hw, height: hh };
    case "top-right":
      return { zone, x: hw, y: 0, width: vp.width - hw, height: hh };
    case "bottom-left":
      return { zone, x: 0, y: hh, width: hw, height: vp.height - hh };
    case "bottom-right":
      return { zone, x: hw, y: hh, width: vp.width - hw, height: vp.height - hh };
    default:
      return null;
  }
}

/** Detect snap zone from cursor position */
function detectSnapZone(cursorX: number, cursorY: number): SnapZone {
  const vp = getViewport();
  const nearLeft = cursorX <= SNAP_THRESHOLD;
  const nearRight = cursorX >= vp.width - SNAP_THRESHOLD;
  const nearTop = cursorY <= SNAP_THRESHOLD;

  // Corners: cursor near both edges
  if (nearLeft && cursorY < CORNER_SIZE) return "top-left";
  if (nearRight && cursorY < CORNER_SIZE) return "top-right";
  if (nearLeft && cursorY > vp.height - CORNER_SIZE) return "bottom-left";
  if (nearRight && cursorY > vp.height - CORNER_SIZE) return "bottom-right";

  // Top edge = maximize
  if (nearTop) return "maximize";

  // Side edges = half-screen
  if (nearLeft) return "left";
  if (nearRight) return "right";

  return null;
}

export function useSnapToEdge() {
  const [preview, setPreview] = useState<SnapPreview | null>(null);
  const lastCheckRef = useRef(0);

  const onDrag = useCallback((_e: unknown, data: { x: number; y: number; node: HTMLElement }) => {
    const now = performance.now();
    if (now - lastCheckRef.current < 16) return;
    lastCheckRef.current = now;

    const rect = data.node.getBoundingClientRect();
    const zone = detectSnapZone(rect.left, rect.top);
    if (zone) {
      const bounds = getSnapBounds(zone);
      if (bounds) {
        setPreview({ zone: bounds.zone, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
        return;
      }
    }
    setPreview(null);
  }, []);

  const getSnapResult = useCallback((cursorX: number, cursorY: number): SnapResult | null => {
    const zone = detectSnapZone(cursorX, cursorY);
    setPreview(null);
    if (!zone) return null;
    return getSnapBounds(zone);
  }, []);

  const clearPreview = useCallback(() => setPreview(null), []);

  return { preview, onDrag, getSnapResult, clearPreview };
}
