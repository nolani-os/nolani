import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useWindowsStore } from "@claraos/core";
import { captureToDataUrl } from "../lib/screenshots";
import styles from "./TaskbarHoverThumb.module.css";

const HOVER_DELAY = 800;
const CACHE_TTL_MS = 5_000;

// Module-level LRU cache so concurrent hovers across the taskbar reuse work
interface CacheEntry {
  url: string;
  ts: number;
}
const thumbCache = new Map<string, CacheEntry>();

interface Props {
  windowId: string;
  children: ReactNode;
}

/**
 * Wraps a taskbar running-window button: hovering >800ms shows a tooltip
 * with a live thumbnail of the window. Captures via html-to-image, cached
 * 5s per window. Skipped (placeholder) for minimized windows since their
 * DOM is `display:none`.
 */
export function TaskbarHoverThumb({ windowId, children }: Props) {
  const win = useWindowsStore((s) => s.windows[windowId]);
  const [open, setOpen] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const captureNow = useCallback(async () => {
    const cached = thumbCache.get(windowId);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      setThumb(cached.url);
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-window-id="${windowId}"]`);
    if (!el) {
      setThumb(null);
      return;
    }
    const url = await captureToDataUrl(el, { maxSize: 240 });
    if (url) {
      thumbCache.set(windowId, { url, ts: Date.now() });
      setThumb(url);
    } else {
      setThumb(null);
    }
  }, [windowId]);

  const onEnter = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setOpen(true);
      void captureNow();
    }, HOVER_DELAY);
  }, [captureNow]);

  const onLeave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <div
      ref={wrapRef}
      className={styles.wrapper}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {children}
      {open && win && !win.minimized && (
        <div className={`aeroWidget ${styles.thumb}`}>
          {thumb ? (
            <img src={thumb} alt={win.title} className={styles.thumbImg} />
          ) : (
            <div className={styles.placeholder}>…</div>
          )}
          <div className={styles.thumbLabel}>{win.title}</div>
        </div>
      )}
    </div>
  );
}
