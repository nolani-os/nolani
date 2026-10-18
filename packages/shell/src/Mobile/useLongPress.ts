import { useCallback, useRef } from "react";

interface LongPressOpts {
  onTap?: () => void;
  onLongPress?: (x: number, y: number) => void;
  delay?: number;
  moveTolerance?: number;
}

interface Handlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerLeave: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

// Distinguishes a tap from a long-press, cancelling the long-press if the
// finger moves past `moveTolerance` (i.e. the user is scrolling, not holding).
export function useLongPress({
  onTap,
  onLongPress,
  delay = 450,
  moveTolerance = 10,
}: LongPressOpts): Handlers {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const moved = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    fired.current = false;
    moved.current = false;
    start.current = { x: e.clientX, y: e.clientY };
    clear();
    timer.current = window.setTimeout(() => {
      fired.current = true;
      if (navigator.vibrate) try { navigator.vibrate(15); } catch { /* ignore */ }
      onLongPress?.(start.current!.x, start.current!.y);
    }, delay);
  }, [clear, delay, onLongPress]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!start.current || fired.current) return;
    const dx = Math.abs(e.clientX - start.current.x);
    const dy = Math.abs(e.clientY - start.current.y);
    if (dx > moveTolerance || dy > moveTolerance) { moved.current = true; clear(); }
  }, [clear, moveTolerance]);

  const onPointerUp = useCallback(() => {
    // Ignore ups without a matching down on THIS element: releasing a drag
    // over an icon otherwise fired its onTap (fresh refs → "genuine tap")
    // and launched that app right on top of the drop.
    if (!start.current) { clear(); return; }
    clear();
    // Only a genuine tap (no long-press fired, finger didn't travel) launches.
    if (!fired.current && !moved.current) onTap?.();
    start.current = null;
  }, [clear, onTap]);

  const onPointerLeave = useCallback(() => { clear(); }, [clear]);
  const onPointerCancel = useCallback(() => { clear(); start.current = null; }, [clear]);
  const onContextMenu = useCallback((e: React.MouseEvent) => e.preventDefault(), []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onPointerCancel, onContextMenu };
}
