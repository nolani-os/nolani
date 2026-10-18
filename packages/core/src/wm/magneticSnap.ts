/**
 * Magnetic window-edge snap.
 *
 * During a window drag, the dragged window's edges are checked against the
 * edges of every other visible window. When an edge falls within
 * `MAGNETIC_THRESHOLD` pixels of another edge, the dragged position is
 * adjusted to align them — effectively making windows "click" to each
 * other's borders. Edge-snap (top of screen / left half / right half)
 * already happens elsewhere via getSnapBounds; this is the in-between case.
 *
 * Out of scope: group-move (Hold-Shift to drag two snapped windows
 * together). Easy follow-up.
 */
export const MAGNETIC_THRESHOLD = 10;

export interface DraggedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OtherRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MagneticResult {
  /** The (possibly adjusted) drag position. */
  x: number;
  y: number;
  /** ID of the window the dragged window snapped to, or null. */
  snappedTo: string | null;
}

/**
 * Compute a magnetic-snap-adjusted position for the dragged window. Returns
 * the original coordinates when no neighbour edge is within threshold.
 */
export function computeMagneticSnap(
  dragged: DraggedRect,
  others: OtherRect[],
): MagneticResult {
  const dragLeft = dragged.x;
  const dragRight = dragged.x + dragged.width;
  const dragTop = dragged.y;
  const dragBottom = dragged.y + dragged.height;

  let bestDx: { delta: number; abs: number; otherId: string } | null = null;
  let bestDy: { delta: number; abs: number; otherId: string } | null = null;

  for (const o of others) {
    const oLeft = o.x;
    const oRight = o.x + o.width;
    const oTop = o.y;
    const oBottom = o.y + o.height;

    // Vertical adjacency required for horizontal snap
    const horizontallyAdjacent = dragBottom > oTop && dragTop < oBottom;
    if (horizontallyAdjacent) {
      // Right edge of dragged ↔ left edge of other
      const dxA = oLeft - dragRight;
      // Left edge of dragged ↔ right edge of other
      const dxB = oRight - dragLeft;
      // Top alignment of left edges
      const dxC = oLeft - dragLeft;
      // Top alignment of right edges
      const dxD = oRight - dragRight;
      for (const dx of [dxA, dxB, dxC, dxD]) {
        const abs = Math.abs(dx);
        if (abs <= MAGNETIC_THRESHOLD && (!bestDx || abs < bestDx.abs)) {
          bestDx = { delta: dx, abs, otherId: o.id };
        }
      }
    }

    // Horizontal adjacency required for vertical snap
    const verticallyAdjacent = dragRight > oLeft && dragLeft < oRight;
    if (verticallyAdjacent) {
      const dyA = oTop - dragBottom;
      const dyB = oBottom - dragTop;
      const dyC = oTop - dragTop;
      const dyD = oBottom - dragBottom;
      for (const dy of [dyA, dyB, dyC, dyD]) {
        const abs = Math.abs(dy);
        if (abs <= MAGNETIC_THRESHOLD && (!bestDy || abs < bestDy.abs)) {
          bestDy = { delta: dy, abs, otherId: o.id };
        }
      }
    }
  }

  return {
    x: dragged.x + (bestDx?.delta ?? 0),
    y: dragged.y + (bestDy?.delta ?? 0),
    snappedTo: bestDx?.otherId ?? bestDy?.otherId ?? null,
  };
}
