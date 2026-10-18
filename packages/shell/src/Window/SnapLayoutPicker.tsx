import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./SnapLayoutPicker.module.css";

const HOVER_DELAY = 500;

type LayoutId = "halves" | "quarters" | "thirds" | "wide-side";

interface Layout {
  id: LayoutId;
  zones: { zone: string; style: React.CSSProperties }[];
}

const LAYOUTS: Layout[] = [
  {
    id: "halves",
    zones: [
      { zone: "left",  style: { left: 0,    top: 0, width: "50%", height: "100%" } },
      { zone: "right", style: { left: "50%", top: 0, width: "50%", height: "100%" } },
    ],
  },
  {
    id: "quarters",
    zones: [
      { zone: "top-left",     style: { left: 0,     top: 0,     width: "50%", height: "50%" } },
      { zone: "top-right",    style: { left: "50%", top: 0,     width: "50%", height: "50%" } },
      { zone: "bottom-left",  style: { left: 0,     top: "50%", width: "50%", height: "50%" } },
      { zone: "bottom-right", style: { left: "50%", top: "50%", width: "50%", height: "50%" } },
    ],
  },
  {
    id: "thirds",
    zones: [
      { zone: "left",  style: { left: 0, top: 0, width: "33.33%", height: "100%" } },
      // Middle zone deliberately maps to maximize for now (3-up needs new geometry helpers)
      { zone: "maximize", style: { left: "33.33%", top: 0, width: "33.34%", height: "100%" } },
      { zone: "right",    style: { left: "66.67%", top: 0, width: "33.33%", height: "100%" } },
    ],
  },
  {
    id: "wide-side",
    zones: [
      { zone: "left",  style: { left: 0,    top: 0, width: "70%", height: "100%" } },
      { zone: "right", style: { left: "70%", top: 0, width: "30%", height: "100%" } },
    ],
  },
];

interface Props {
  /** Element that triggers the picker on hover — usually the Maximize button. */
  children: ReactNode;
  /** Callback receives the snap-zone id ("left", "right", "top-left", ...). */
  onPick: (zone: string) => void;
}

/**
 * Win11-style hover overlay on the Maximize button. Shows 4 layout options;
 * each option is a tiny 80×60 preview made of clickable zones. Clicking a
 * zone snaps the window to that area via getSnapBounds — already supports
 * 4-zone via core/wm/useSnapToEdge.
 */
export function SnapLayoutPicker({ children, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onEnter = useCallback(() => {
    cancelTimer();
    timer.current = setTimeout(() => setOpen(true), HOVER_DELAY);
  }, [cancelTimer]);

  const onLeave = useCallback(() => {
    cancelTimer();
    // Slight grace period so user can move into the popup
    timer.current = setTimeout(() => setOpen(false), 150);
  }, [cancelTimer]);

  // Click-anywhere-else closes the picker
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const handleZoneClick = useCallback((zone: string) => {
    onPick(zone);
    setOpen(false);
  }, [onPick]);

  return (
    <span
      ref={wrapRef}
      className={styles.wrapper}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {children}
      {open && (
        <div
          className={`aeroWidget ${styles.popup}`}
          data-shell-part="snap-popup"
          onMouseEnter={cancelTimer}
          onMouseLeave={onLeave}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {LAYOUTS.map((layout) => (
            <div key={layout.id} className={styles.layout} data-shell-part="snap-layout">
              {layout.zones.map((z, idx) => (
                <button
                  key={`${layout.id}-${idx}`}
                  className={styles.zone}
                  data-shell-part="snap-zone"
                  style={z.style}
                  onClick={() => handleZoneClick(z.zone)}
                  title={z.zone}
                  aria-label={`Snap to ${z.zone}`}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
