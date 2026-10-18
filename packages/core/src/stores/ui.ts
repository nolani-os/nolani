import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { idbStorage } from "./persist";
import type { Notification } from "../types";
import { decide, DEFAULT_POLICY, type NotificationPolicy } from "../notifications/policy";
import { useSettingsStore } from "./settings";

export interface UIState {
  skinId: string;
  theme: "light" | "dark";
  wallpaper: string;
  startMenuOpen: boolean;
  /** Open tray popover (quick settings, volume, ...) — exactly one at a
   *  time; null = none. Transient, not persisted. */
  trayPopover: string | null;
  notifications: Notification[];
}

export interface UIActions {
  setSkin: (skinId: string) => void;
  setTheme: (theme: "light" | "dark") => void;
  setWallpaper: (url: string) => void;
  toggleStartMenu: () => void;
  closeStartMenu: () => void;
  /** Toggle semantics: the same id closes, a different id switches. */
  setTrayPopover: (id: string | null) => void;
  addNotification: (n: Omit<Notification, "id" | "timestamp" | "read">) => void;
  markRead: (id: string) => void;
  /** Remove a notification permanently (phone: swipe right, as on Android). */
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
  /** Remove only the read ones ("Silent" group of the phone shade). */
  clearReadNotifications: () => void;
}

export type UIStore = UIState & UIActions;

/**
 * Unique id per notification. `notif-${Date.now()}` alone was not unique — a
 * burst from the SSE replay creates several notifications in the same
 * millisecond, which then shared an id. Result on desktop: the same
 * notification shown as a toast several times, duplicate React keys, a frozen
 * fade-out animation, a close button without effect. Counter + random part,
 * so that even two tabs (separate counters, shared IndexedDB) never collide.
 */
let notificationSeq = 0;
function nextNotificationId(): string {
  notificationSeq += 1;
  return `notif-${Date.now()}-${notificationSeq}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Current rules from the settings (module "notifications").
 * "Do not disturb" is stored as a timestamp in the same place — so it applies
 * across devices and expires on its own.
 */
function currentPolicy(): NotificationPolicy {
  const v = useSettingsStore.getState().values["notifications"];
  if (!v) return DEFAULT_POLICY;
  let apps: NotificationPolicy["apps"] = {};
  try {
    apps = (v.appRules as NotificationPolicy["apps"]) ?? {};
  } catch {
    apps = {};
  }
  return {
    dndUntil: typeof v.dndUntil === "number" ? v.dndUntil : 0,
    criticalInDnd: v.criticalInDnd !== false,
    lowPriorityPopups: v.lowPriorityPopups !== false,
    lowPriorityHistory: v.lowPriorityHistory === true,
    apps,
  };
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      // Default for fresh profiles; existing users keep their persisted choice.
      skinId: "clara-glass",
      theme: "dark" as const,
      wallpaper: "",
      startMenuOpen: false,
      trayPopover: null,
      notifications: [] as Notification[],

      setSkin: (skinId) => set({ skinId }),
      setTheme: (theme) => set({ theme }),
      setWallpaper: (wallpaper) => set({ wallpaper }),
      toggleStartMenu: () => set((s) => ({ startMenuOpen: !s.startMenuOpen })),
      closeStartMenu: () => set({ startMenuOpen: false }),
      setTrayPopover: (id) =>
        set((s) => ({ trayPopover: id !== null && s.trayPopover === id ? null : id })),

      addNotification: (n) =>
        set((s) => {
          // The same source message (ntfy id) only once — the SSE subscription
          // replays the last 24 h on connect.
          if (n.sourceId && s.notifications.some((e) => e.sourceId === n.sourceId)) return s;
          // Apply rules (do not disturb, urgency, per-app switches).
          // Something that gets no popup can still go into the history — that
          // is why the policy decides the two separately.
          const decision = decide(n, currentPolicy());
          if (!decision.history) return s;
          const entry = {
            ...n,
            id: nextNotificationId(),
            timestamp: Date.now(),
            read: false,
            suppressed: !decision.popup,
            countInBadge: decision.badge,
          };
          return { notifications: [entry, ...s.notifications].slice(0, 100) };
        }),

      markRead: (id) =>
        set((s) => ({
          notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
        })),

      removeNotification: (id) =>
        set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),

      clearNotifications: () => set({ notifications: [] }),
      clearReadNotifications: () =>
        set((s) => ({ notifications: s.notifications.filter((n) => !n.read) })),
    }),
    {
      name: "claraos-ui",
      storage: createJSONStorage(() => idbStorage),
      // Only startMenuOpen is transient. Notifications survive a reload —
      // the cap of 100 comes from addNotification; actions are plain data
      // (registry IDs), hence serializable.
      partialize: (state) => ({
        skinId: state.skinId,
        theme: state.theme,
        wallpaper: state.wallpaper,
        notifications: state.notifications,
      }),
    },
  ),
);
