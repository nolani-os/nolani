import { useEffect, useRef } from "react";
import { useWindowsStore, useUIStore, useAppCenterStore, useWorkspaceStore, useSettingsStore } from "@claraos/core";

const SYNC_DEBOUNCE_MS = 5000; // Sync to backend every 5s max

/**
 * Syncs desktop state (window positions, widgets, skin, theme, pins) to the
 * backend API.
 * - On mount: waits for IndexedDB rehydration, THEN loads prefs from API
 * - Server prefs are applied only when they are real user values
 *   (`stored: true`) — defaults from the API never overwrite local state
 * - On change: debounced write to API
 * - IndexedDB handles offline/instant persistence (via Zustand persist middleware)
 * - API handles multi-device sync (last-write-wins, no merge across devices)
 */

type PersistStore = {
  persist: {
    hasHydrated: () => boolean;
    onFinishHydration: (cb: () => void) => () => void;
  };
};

function whenHydrated(store: PersistStore): Promise<void> {
  if (store.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = store.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
  });
}

export function useStateSync() {
  const syncPrefsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncDesktopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadDone = useRef(false);

  // Load prefs + desktop-state from API on mount — but only AFTER the local
  // IndexedDB state finished rehydrating; otherwise, depending on timing, either
  // the server or IndexedDB wins (non-deterministic skin reset).
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    (async () => {
      await Promise.all([
        whenHydrated(useUIStore as unknown as PersistStore),
        whenHydrated(useAppCenterStore as unknown as PersistStore),
        whenHydrated(useWorkspaceStore as unknown as PersistStore),
      ]);

      // ── User-Prefs (Skin, Theme, Wallpaper, Pins) ──
      try {
        const r = await fetch("/api/claraos/prefs");
        const prefs = r.ok ? await r.json() : null;
        if (prefs?.stored) {
          // Real server values take precedence over IndexedDB (multi-device).
          const ui = useUIStore.getState();
          if (prefs.skin_id && prefs.skin_id !== ui.skinId) ui.setSkin(prefs.skin_id);
          if (prefs.theme && prefs.theme !== ui.theme) ui.setTheme(prefs.theme);
          if (prefs.wallpaper && prefs.wallpaper !== ui.wallpaper) ui.setWallpaper(prefs.wallpaper);
          if (Array.isArray(prefs.pinned_apps) && prefs.pinned_apps.length > 0) {
            useAppCenterStore.setState({ pinnedAppIds: prefs.pinned_apps });
          }
        } else if (prefs && !prefs.stored) {
          // Server does not know this user yet → push the local state up so
          // the next device finds it.
          pushPrefs();
        }
      } catch {
        // API not available – IndexedDB state is primary
      }

      // ── Desktop-State (Widgets/Workspaces) ──
      // Only apply if the local workspace state is still pristine
      // (fresh browser / cleared cache). A populated local state stays and is
      // synced up on the next change — so a stale server state never
      // overwrites fresher local work.
      try {
        // Only restore windows/workspaces of the last session if the user
        // wants that (Settings → Session).
        const restore =
          useSettingsStore.getState().values["session"]?.restoreWindows;
        if (restore === false) return;

        const ws = useWorkspaceStore.getState();
        const pristine =
          ws.workspaces.length === 1 &&
          (ws.workspaces[0].widgets?.length ?? 0) === 0 &&
          (ws.workspaces[0].desktopItems?.length ?? 0) === 0;
        if (pristine) {
          const r = await fetch("/api/claraos/prefs/desktop-state");
          const state = r.ok ? await r.json() : null;
          if (Array.isArray(state?.workspaces) && state.workspaces.length > 0) {
            useWorkspaceStore.setState({
              workspaces: state.workspaces,
              activeId: state.active_workspace || state.workspaces[0].id,
            });
          }
        }
      } catch {
        // API not available – IndexedDB state is primary
      }
    })();
  }, []);

  // Debounced sync: subscribe to store changes
  useEffect(() => {
    // useUIStore has no subscribeWithSelector middleware → use 1-arg form with manual diff
    const unsubPrefs = useUIStore.subscribe((state, prev) => {
      if (state.skinId !== prev.skinId || state.theme !== prev.theme || state.wallpaper !== prev.wallpaper) {
        scheduleSyncPrefs();
      }
    });
    const unsubPins = useAppCenterStore.subscribe((state, prev) => {
      if (state.pinnedAppIds !== prev.pinnedAppIds) scheduleSyncPrefs();
    });
    // useWindowsStore has subscribeWithSelector → selector+listener form works
    const unsubDesktop = useWindowsStore.subscribe(
      (state) => ({ windows: state.windows, windowOrder: state.windowOrder }),
      () => scheduleSyncDesktop(),
      { equalityFn: () => false },
    );
    const unsubWorkspace = useWorkspaceStore.subscribe((state, prev) => {
      if (state.workspaces !== prev.workspaces || state.activeId !== prev.activeId) {
        scheduleSyncDesktop();
      }
    });

    return () => { unsubPrefs(); unsubPins(); unsubDesktop(); unsubWorkspace(); };
  }, []);

  function pushPrefs() {
    const { skinId, theme, wallpaper } = useUIStore.getState();
    const { pinnedAppIds } = useAppCenterStore.getState();
    fetch("/api/claraos/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // Partial update (backend merges): desktop_icons etc. stay untouched.
      body: JSON.stringify({ skin_id: skinId, theme, wallpaper, pinned_apps: pinnedAppIds }),
    }).catch(() => {});
  }

  function scheduleSyncPrefs() {
    if (syncPrefsTimerRef.current) clearTimeout(syncPrefsTimerRef.current);
    syncPrefsTimerRef.current = setTimeout(pushPrefs, SYNC_DEBOUNCE_MS);
  }

  function scheduleSyncDesktop() {
    // Desktop state sync uses a longer debounce since it changes frequently (drag/resize)
    if (syncDesktopTimerRef.current) clearTimeout(syncDesktopTimerRef.current);
    syncDesktopTimerRef.current = setTimeout(() => {
      const { windows, windowOrder } = useWindowsStore.getState();
      const { workspaces, activeId } = useWorkspaceStore.getState();
      // Only sync minimal window data
      const minimalWindows: Record<string, { appId: string; x: number; y: number; width: number; height: number }> = {};
      for (const [id, win] of Object.entries(windows)) {
        minimalWindows[id] = { appId: win.appId, x: win.x, y: win.y, width: win.width, height: win.height };
      }
      fetch("/api/claraos/prefs/desktop-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windows: minimalWindows,
          window_order: windowOrder,
          workspaces,
          active_workspace: activeId,
        }),
      }).catch(() => {});
    }, SYNC_DEBOUNCE_MS * 2); // 10s for desktop state
  }
}
