/**
 * Mobile-shell preferences — small persisted store for the Android-style
 * quick-settings panel. Only holds settings a PWA can genuinely honour
 * (a browser cannot control system brightness or volume).
 *
 *  - haptics  : gate the shell's vibrate() feedback
 *  - dnd      : suppress *browser* notifications from the ntfy feed
 *               (the in-app notification shade keeps updating either way)
 *
 * Warning: `fontScale` used to live here and was deliberately REMOVED: the font
 * size is an account value (settings module `appearance`, key `uiScale`) and is
 * written to the document exclusively by `AppearanceManager`. Two writers on
 * `documentElement.style.fontSize` cancelled each other out — the phone
 * setting was lost after every reload.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Shade layout: "separate" like Android 16 / One UI 7 — swipe top-left =
 *  notifications, top-right = quick settings; "combined" = one panel with both
 *  (the old shade). A device value, not an account value: whether you like the
 *  split depends on your thumb, not your account. */
export type ShadeAufbau = "getrennt" | "kombiniert";

export interface MobilePrefsStore {
  haptics: boolean;
  dnd: boolean;
  shadeAufbau: ShadeAufbau;
  setShadeAufbau: (a: ShadeAufbau) => void;
  setHaptics: (on: boolean) => void;
  setDnd: (on: boolean) => void;
  toggleHaptics: () => void;
  toggleDnd: () => void;
}

export const useMobilePrefs = create<MobilePrefsStore>()(
  persist(
    (set) => ({
      haptics: true,
      dnd: false,
      shadeAufbau: "getrennt",
      setShadeAufbau: (shadeAufbau) => set({ shadeAufbau }),
      setHaptics: (haptics) => set({ haptics }),
      setDnd: (dnd) => set({ dnd }),
      toggleHaptics: () => set((s) => ({ haptics: !s.haptics })),
      toggleDnd: () => set((s) => ({ dnd: !s.dnd })),
    }),
    { name: "claraos.mobile.prefs.v1" },
  ),
);
