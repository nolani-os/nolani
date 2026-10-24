import { useEffect, useState } from "react";
import { useWindowsStore, useAppRegistryStore, useTranslation } from "@claraos/core";
import { AppIcon } from "../components/AppIcon";
import { captureToDataUrl } from "../lib/screenshots";
import styles from "./AltTabSwitcher.module.css";

/**
 * Win11-style Alt+Tab switcher.
 *
 * Visible while the user is "cycling" — tracked by useAltTabCycle(): the
 * overlay opens on Alt+Tab, advances the highlighted index on each Tab
 * press while Alt is held, and commits focus to the highlighted window on
 * Alt-release.
 *
 * Thumbnails: snapshot each window's DOM via html-to-image once on overlay
 * open. Slow / cross-origin / iframe-heavy windows fall back to the app's
 * AppIcon so the switcher stays usable even when capture fails.
 */
export function AltTabSwitcher() {
  const { open, candidates, activeIndex } = useAltTabState();
  const { t } = useTranslation("shell");
  const focusWindow = useWindowsStore((s) => s.focusWindow);
  const apps = useAppRegistryStore((s) => s.apps);

  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) {
      setThumbs({});
      return;
    }
    // Capture up to 8 thumbs in parallel; the rest fall back to icon
    const slice = candidates.slice(0, 8);
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        slice.map(async (winId) => {
          const el = document.querySelector<HTMLElement>(`[data-window-id="${winId}"]`);
          if (!el) return;
          const url = await captureToDataUrl(el, { maxSize: 280 });
          if (url) next[winId] = url;
        }),
      );
      if (!cancelled) setThumbs(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, candidates]);

  // Click-to-pick: closing the overlay focuses the chosen window
  const onPick = (winId: string) => {
    focusWindow(winId);
    closeAltTab();
  };

  if (!open || candidates.length === 0) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-label={t("window.altTab.label")}>
      <div className={`aeroWidget ${styles.panel}`}>
        <div className={styles.title}>{t("window.altTab.title")}</div>
        <div className={styles.row}>
          {candidates.map((winId, idx) => {
            const win = useWindowsStore.getState().windows[winId];
            if (!win) return null;
            const app = apps[win.appId];
            const thumb = thumbs[winId];
            return (
              <button
                key={winId}
                className={`${styles.tile} ${idx === activeIndex ? styles.tileActive : ""}`}
                onClick={() => onPick(winId)}
              >
                <div className={styles.preview}>
                  {thumb ? (
                    <img src={thumb} alt={win.title} />
                  ) : (
                    <AppIcon
                      appId={win.appId}
                      fallback={app?.icon ?? "🔲"}
                      size="desktop"
                      pixelSize={64}
                    />
                  )}
                </div>
                <div className={styles.label}>
                  <span className={styles.appIcon}>
                    <AppIcon appId={win.appId} fallback={app?.icon ?? "🔲"} pixelSize={16} />
                  </span>
                  <span className={styles.titleText}>{win.title}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Switcher state — module-local, controlled by useKeyboardShortcuts ──

interface AltTabState {
  open: boolean;
  candidates: string[];
  activeIndex: number;
}

let listeners = new Set<(state: AltTabState) => void>();
let state: AltTabState = { open: false, candidates: [], activeIndex: 0 };

function emit() {
  for (const fn of listeners) fn(state);
}

export function openAltTab(direction: 1 | -1 = 1) {
  const { windowOrder, windows } = useWindowsStore.getState();
  // Most-recently-focused first (LRU): reverse the windowOrder, exclude minimized
  const candidates = windowOrder
    .slice()
    .reverse()
    .filter((id) => windows[id] && !windows[id].minimized);
  if (candidates.length < 2) {
    // No-op when only 0-1 windows visible
    return;
  }
  state = { open: true, candidates, activeIndex: direction === 1 ? 1 : candidates.length - 1 };
  emit();
}

export function cycleAltTab(direction: 1 | -1) {
  if (!state.open) return;
  const len = state.candidates.length;
  state = {
    ...state,
    activeIndex: (state.activeIndex + direction + len) % len,
  };
  emit();
}

export function commitAltTab() {
  if (!state.open) return;
  const winId = state.candidates[state.activeIndex];
  if (winId) {
    useWindowsStore.getState().focusWindow(winId);
  }
  closeAltTab();
}

export function closeAltTab() {
  if (!state.open) return;
  state = { open: false, candidates: [], activeIndex: 0 };
  emit();
}

function useAltTabState(): AltTabState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
