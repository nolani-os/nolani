import { create } from "zustand";
import { useAppRegistryStore } from "./appregistry";
import { persist, createJSONStorage, subscribeWithSelector } from "zustand/middleware";
import { idbStorage } from "./persist";
import type { WindowInstance } from "../types";

let nextWindowId = 0;

/**
 * Close guard per window: apps can hook in a confirmation here (e.g. Files with
 * several tabs, Dolphin ConfirmClosingMultipleTabs). The title bar asks the
 * guard BEFORE closeWindow; true = close.
 */
export const windowCloseGuards = new Map<string, () => boolean | Promise<boolean>>();

/** Guard-aware close — used by the window chrome. */
export async function requestCloseWindow(windowId: string): Promise<void> {
  const guard = windowCloseGuards.get(windowId);
  if (guard) {
    const ok = await guard();
    if (!ok) return;
  }
  useWindowsStore.getState().closeWindow(windowId);
}

export interface WindowsState {
  windows: Record<string, WindowInstance>;
  windowOrder: string[];
  focusedWindowId: string | null;
  /**
   * Set of window IDs that were minimized by the most recent Show-Desktop
   * click. A second click on Show-Desktop restores exactly this set; a
   * normal user-driven minimize on any other window clears the set.
   */
  lastMinimizedSet: string[];
  /** Aero-Peek mode — true while the user hovers the Show-Desktop button. */
  peekActive: boolean;
}

export interface WindowsActions {
  openWindow: (
    appId: string,
    opts?: Partial<Pick<WindowInstance, "title" | "icon" | "x" | "y" | "width" | "height" | "workspaceId" | "path" | "source" | "maximized" | "fullscreen">>,
  ) => string;
  closeWindow: (windowId: string) => void;
  focusWindow: (windowId: string) => void;
  minimizeWindow: (windowId: string) => void;
  maximizeWindow: (windowId: string) => void;
  restoreWindow: (windowId: string) => void;
  toggleMaximize: (windowId: string) => void;
  toggleWindowFullscreen: (windowId: string) => void;
  updatePosition: (windowId: string, x: number, y: number) => void;
  updateSize: (windowId: string, width: number, height: number) => void;
  updatePositionAndSize: (
    windowId: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => void;
  setClosing: (windowId: string) => void;
  setTitle: (windowId: string, title: string) => void;
  /** Switch the file of a viewer window without opening a new window. The
   *  viewers tie their load effect to path/source — so switching loads the new
   *  file in the SAME window. */
  setWindowFile: (windowId: string, source: string, path: string, title?: string) => void;
  setAlwaysOnTop: (windowId: string, value: boolean) => void;
  /** Toggle Show-Desktop: minimize all visible windows, or restore the previously-minimized set. */
  toggleShowDesktop: () => void;
  setPeek: (active: boolean) => void;
  /** Toggle the per-window inline Clara chat panel. */
  toggleClaraInline: (windowId: string) => void;
  /** Update the canonical object-URI an app has open (used by inline chat). */
  setCurrentObjectUri: (windowId: string, objectUri: string | undefined) => void;
}

export type WindowsStore = WindowsState & WindowsActions;

export const useWindowsStore = create<WindowsStore>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        windows: {},
        windowOrder: [],
        focusedWindowId: null,
        lastMinimizedSet: [],
        peekActive: false,

        openWindow: (appId, opts) => {
          const id = `win-${nextWindowId++}`;
          const win: WindowInstance = {
            id,
            appId,
            // Without an explicit title, use the app's (translated) display name —
            // callers like Clara's open_window action pass none, and the raw id
            // ("planner") then stood in the title bar.
            title: opts?.title ?? useAppRegistryStore.getState().getApp(appId)?.name ?? appId,
            icon: opts?.icon,
            x: opts?.x ?? 100 + (nextWindowId % 10) * 30,
            y: opts?.y ?? 80 + (nextWindowId % 10) * 30,
            width: opts?.width ?? 800,
            height: opts?.height ?? 600,
            minimized: false,
            // Apps may start full-screen (e.g. the games desktop should
            // open without the taskbar margin).
            maximized: opts?.maximized ?? false,
            fullscreen: opts?.fullscreen ?? false,
            focused: true,
            workspaceId: opts?.workspaceId,
            path: opts?.path,
            source: opts?.source,
            createdAt: Date.now(),
            lastFocusedAt: Date.now(),
          };
          set((state) => ({
            windows: { ...state.windows, [id]: win },
            windowOrder: [...state.windowOrder, id],
            focusedWindowId: id,
          }));
          return id;
        },

        // True full screen: window above the taskbar, without a title bar.
        // Deliberately separate from `maximized`, which intentionally leaves
        // the taskbar visible.
        toggleWindowFullscreen: (windowId) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            return {
              windows: { ...state.windows, [windowId]: { ...win, fullscreen: !win.fullscreen } },
            };
          });
        },

        closeWindow: (windowId) => {
          set((state) => {
            const { [windowId]: _, ...remaining } = state.windows;
            const newOrder = state.windowOrder.filter((id) => id !== windowId);
            return {
              windows: remaining,
              windowOrder: newOrder,
              focusedWindowId:
                state.focusedWindowId === windowId
                  ? (newOrder[newOrder.length - 1] ?? null)
                  : state.focusedWindowId,
            };
          });
        },

        focusWindow: (windowId) => {
          set((state) => {
            if (!state.windows[windowId]) return state;
            const order = state.windowOrder.filter((id) => id !== windowId);
            order.push(windowId);
            return {
              windows: {
                ...state.windows,
                [windowId]: {
                  ...state.windows[windowId],
                  focused: true,
                  minimized: false,
                  lastFocusedAt: Date.now(),
                },
              },
              windowOrder: order,
              focusedWindowId: windowId,
            };
          });
        },

        minimizeWindow: (windowId) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            const otherTop = state.windowOrder
              .filter((id) => id !== windowId && !state.windows[id]?.minimized)
              .pop();
            return {
              windows: {
                ...state.windows,
                [windowId]: { ...win, minimized: true, focused: false },
              },
              focusedWindowId:
                state.focusedWindowId === windowId ? (otherTop ?? null) : state.focusedWindowId,
            };
          });
        },

        maximizeWindow: (windowId) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            return {
              windows: {
                ...state.windows,
                [windowId]: {
                  ...win,
                  maximized: true,
                  snapped: null,
                  preMaximize: { x: win.x, y: win.y, width: win.width, height: win.height },
                },
              },
            };
          });
        },

        restoreWindow: (windowId) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            const restored = win.preMaximize ?? { x: win.x, y: win.y, width: win.width, height: win.height };
            return {
              windows: {
                ...state.windows,
                [windowId]: {
                  ...win,
                  maximized: false,
                  snapped: null,
                  x: restored.x,
                  y: restored.y,
                  width: restored.width,
                  height: restored.height,
                  preMaximize: undefined,
                },
              },
            };
          });
        },

        toggleMaximize: (windowId) => {
          const win = useWindowsStore.getState().windows[windowId];
          if (!win) return;
          if (win.maximized) {
            useWindowsStore.getState().restoreWindow(windowId);
          } else {
            useWindowsStore.getState().maximizeWindow(windowId);
          }
        },

        updatePosition: (windowId, x, y) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            return { windows: { ...state.windows, [windowId]: { ...win, x, y } } };
          });
        },

        updateSize: (windowId, width, height) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            return { windows: { ...state.windows, [windowId]: { ...win, width, height } } };
          });
        },

        updatePositionAndSize: (windowId, x, y, width, height) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            return { windows: { ...state.windows, [windowId]: { ...win, x, y, width, height } } };
          });
        },

        setClosing: (windowId) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            return { windows: { ...state.windows, [windowId]: { ...win, closing: true } } };
          });
        },

        setTitle: (windowId, title) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            return { windows: { ...state.windows, [windowId]: { ...win, title } } };
          });
        },

        setWindowFile: (windowId, source, path, title) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            return {
              windows: {
                ...state.windows,
                [windowId]: { ...win, source, path, title: title ?? win.title },
              },
            };
          });
        },

        setAlwaysOnTop: (windowId, value) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            return {
              windows: { ...state.windows, [windowId]: { ...win, alwaysOnTop: value } },
            };
          });
        },

        toggleClaraInline: (windowId) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            return {
              windows: {
                ...state.windows,
                [windowId]: { ...win, claraInlineOpen: !win.claraInlineOpen },
              },
            };
          });
        },

        setCurrentObjectUri: (windowId, objectUri) => {
          set((state) => {
            const win = state.windows[windowId];
            if (!win) return state;
            if (win.currentObjectUri === objectUri) return state;
            return {
              windows: {
                ...state.windows,
                [windowId]: { ...win, currentObjectUri: objectUri },
              },
            };
          });
        },

        toggleShowDesktop: () => {
          const state = get();
          const restorable = state.lastMinimizedSet.filter((id) => state.windows[id]?.minimized);
          if (restorable.length > 0) {
            // Second click — restore previously-minimized windows
            set((s) => {
              const next: Record<string, WindowInstance> = { ...s.windows };
              for (const id of restorable) {
                if (next[id]) next[id] = { ...next[id], minimized: false };
              }
              return {
                windows: next,
                lastMinimizedSet: [],
                focusedWindowId: restorable[restorable.length - 1] ?? s.focusedWindowId,
              };
            });
          } else {
            // First click — minimize everything visible, remember the set
            const visibleIds = state.windowOrder.filter(
              (id) => state.windows[id] && !state.windows[id].minimized,
            );
            if (visibleIds.length === 0) return;
            set((s) => {
              const next: Record<string, WindowInstance> = { ...s.windows };
              for (const id of visibleIds) {
                if (next[id]) next[id] = { ...next[id], minimized: true, focused: false };
              }
              return {
                windows: next,
                lastMinimizedSet: visibleIds,
                focusedWindowId: null,
              };
            });
          }
        },

        setPeek: (active) => set({ peekActive: active }),
      }),
      {
        name: "claraos-windows",
        storage: createJSONStorage(() => idbStorage),
        partialize: (state) => ({
          // Only persist window layout, not transient state
          windows: Object.fromEntries(
            Object.entries(state.windows).map(([id, win]) => [
              id,
              {
                id: win.id,
                appId: win.appId,
                title: win.title,
                icon: win.icon,
                x: win.x,
                y: win.y,
                width: win.width,
                height: win.height,
                maximized: win.maximized,
                preMaximize: win.preMaximize,
                path: win.path,
                source: win.source,
                workspaceId: win.workspaceId,
              },
            ]),
          ),
          windowOrder: state.windowOrder,
        }),
        // Only merge persisted STATE keys, never overwrite ACTIONS
        merge: (persisted, current) => {
          // Safe start: the Android app loads `?sicherer_start=1` when its WebView
          // crashed twice in quick succession. Then do not restore saved
          // windows — otherwise the window that causes the crash reopens on
          // every start.
          if (typeof location !== "undefined" &&
              new URLSearchParams(location.search).has("sicherer_start")) {
            const u = new URL(location.href);
            u.searchParams.delete("sicherer_start");
            history.replaceState(history.state, "", u.pathname + u.search + u.hash);
            // Also SAVE the empty state — otherwise the window returns on the next
            // normal start (persist does not write during rehydration).
            setTimeout(() => useWindowsStore.setState({}), 0);
            return current;
          }
          const p = (persisted || {}) as Record<string, unknown>;
          return {
            ...current,
            ...(p.windows !== undefined ? { windows: p.windows } : {}),
            ...(p.windowOrder !== undefined ? { windowOrder: p.windowOrder } : {}),
          };
        },
        // On rehydrate: reset transient flags
        onRehydrateStorage: () => (state) => {
          if (!state) return;
          // Reset focused/minimized/closing – fresh session
          const windows: Record<string, WindowInstance> = {};
          for (const [id, win] of Object.entries(state.windows)) {
            windows[id] = {
              ...win,
              minimized: false,
              focused: false,
              closing: false,
              createdAt: win.createdAt ?? Date.now(),
              lastFocusedAt: undefined,
            } as WindowInstance;
          }
          state.windows = windows;
          state.focusedWindowId = state.windowOrder[state.windowOrder.length - 1] ?? null;
          // Sync nextWindowId
          const maxId = Math.max(0, ...Object.keys(windows).map((k) => parseInt(k.replace("win-", ""), 10) || 0));
          nextWindowId = maxId + 1;
        },
      },
    ),
  ),
);
