/**
 * Exposé layout: spread n window boxes over a field without overlap, each
 * scaled down proportionally (never up), rows centred — the arrangement
 * Mission Control, Task View and the Plasma overview all converge on.
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placed extends Box {
  scale: number;
}

export function exposeLayout(items: Box[], field: Box, gap = 24, maxScale = 1): Placed[] {
  const n = items.length;
  if (n === 0) return [];
  const cols = n <= 2 ? n : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = (field.w - gap * (cols + 1)) / cols;
  const cellH = (field.h - gap * (rows + 1)) / rows;
  const out: Placed[] = [];
  for (let r = 0; r < rows; r++) {
    const rowItems = items.slice(r * cols, (r + 1) * cols);
    const scales = rowItems.map((b) => Math.min(cellW / Math.max(b.w, 1), cellH / Math.max(b.h, 1), maxScale));
    const total = rowItems.reduce((s, b, i) => s + b.w * scales[i], 0) + gap * (rowItems.length - 1);
    let x = field.x + (field.w - total) / 2;
    const rowY = field.y + gap + r * (cellH + gap);
    rowItems.forEach((b, i) => {
      const s = scales[i];
      const w = b.w * s;
      const h = b.h * s;
      out.push({ x, y: rowY + (cellH - h) / 2, w, h, scale: s });
      x += w + gap;
    });
  }
  return out;
}
