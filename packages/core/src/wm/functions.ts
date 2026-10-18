import type { Position, Size } from "../types";
import { TASKBAR_HEIGHT, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT } from "./rndDefaults";

/** Offscreen buffer - how far a window can be dragged off-screen */
const OFFSCREEN_BUFFER = {
  right: 50,
  left: 150,
  top: 0,
  bottom: 15,
};

/** Get usable viewport dimensions (minus taskbar) */
export function getViewport(): { width: number; height: number } {
  return {
    width: window.innerWidth,
    height: window.innerHeight - TASKBAR_HEIGHT,
  };
}

/** Check if a window position+size is outside usable bounds */
export function isOutsideBounds(
  position: Position,
  size: Size,
  strict = false,
): boolean {
  const vp = getViewport();

  if (strict) {
    return (
      position.x + OFFSCREEN_BUFFER.right > vp.width ||
      position.x + size.width - OFFSCREEN_BUFFER.left < 0 ||
      position.y + OFFSCREEN_BUFFER.bottom > vp.height ||
      position.y < OFFSCREEN_BUFFER.top
    );
  }

  return (
    position.x < 0 ||
    position.y < 0 ||
    position.x + size.width > vp.width ||
    position.y + size.height > vp.height
  );
}

/** Clamp position to keep window accessible */
export function clampPosition(
  x: number,
  y: number,
  width: number,
  height: number,
): Position {
  const vp = getViewport();
  return {
    x: Math.max(
      -(width - OFFSCREEN_BUFFER.left),
      Math.min(x, vp.width - OFFSCREEN_BUFFER.right),
    ),
    y: Math.max(0, Math.min(y, vp.height - OFFSCREEN_BUFFER.bottom)),
  };
}

/** Calculate cascade position for new windows */
export function cascadePosition(windowIndex: number): Position {
  const offset = 30;
  const cascade = windowIndex % 10;
  return {
    x: 80 + cascade * offset,
    y: 60 + cascade * offset,
  };
}

/** Center a window on screen */
export function centerPosition(width: number, height: number): Position {
  const vp = getViewport();
  return {
    x: Math.max(0, Math.round((vp.width - width) / 2)),
    y: Math.max(0, Math.round((vp.height - height) / 2)),
  };
}

/** Enforce min/max size constraints */
export function clampSize(width: number, height: number): Size {
  const vp = getViewport();
  return {
    width: Math.max(MIN_WINDOW_WIDTH, Math.min(width, vp.width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.min(height, vp.height)),
  };
}
