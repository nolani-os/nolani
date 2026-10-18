import { useEffect } from "react";
import { useUIStore } from "@claraos/core";
import {
  applySkin,
  windows11DarkSkin,
  windows11LightSkin,
  aeroGlassSkin,
  claraGlassSkin,
  extraSkinIds,
} from "@claraos/skins";

const skinMap: Record<string, typeof windows11DarkSkin> = {
  "windows11-dark": windows11DarkSkin,
  "windows11-light": windows11LightSkin,
  "aero-glass": aeroGlassSkin,
  "clara-glass": claraGlassSkin,
  // Legacy ID mapping
  "windows11": windows11DarkSkin,
  // Skins of this installation
  ...extraSkinIds,
};

/** Sets `color-scheme` from the skin's ACTUAL brightness.
 *
 * The parts the browser draws itself depend on it: scrollbars, sliders,
 * select and date fields. `global.css` hard-coded `dark` — so under a light
 * skin they stayed dark (visible as a dark bar in the slider track of the
 * settings).
 *
 * Important: measured rather than tied to a list of skin names. A list is
 * complete on the day it is written and never again — every new light skin
 * would be missing from it, and the bug shows up as an unreadable control,
 * not as a crash.
 */
function setzeFarbschema(): void {
  const wurzel = document.documentElement;
  const roh = getComputedStyle(wurzel).getPropertyValue("--bg-window").trim()
    || getComputedStyle(wurzel).getPropertyValue("--bg-surface-solid").trim();
  const m = /rgba?\(([^)]+)\)|#([0-9a-fA-F]{6})/.exec(roh);
  if (!m) return;                       // unknown notation: better change nothing
  let r: number, g: number, b: number;
  if (m[2]) {
    r = parseInt(m[2].slice(0, 2), 16);
    g = parseInt(m[2].slice(2, 4), 16);
    b = parseInt(m[2].slice(4, 6), 16);
  } else {
    [r, g, b] = m[1].split(",").map((s) => parseFloat(s));
  }
  const kanal = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const hell = 0.2126 * kanal(r) + 0.7152 * kanal(g) + 0.0722 * kanal(b) > 0.4;
  wurzel.style.setProperty("--claraos-color-scheme", hell ? "light" : "dark");
  setzeAkzentSchrift(wurzel, kanal);
}

/** Sets `--on-accent`: the text color that is readable ON the accent.
 *
 * Measured: 15 places in 8 apps write `background: var(--accent)` with a
 * fixed `color: white`. The default skin's accent is a light blue — white
 * text on it came to **2.14:1**, far below the required 4.5:1. It was
 * visible on the active filter chip in the app center.
 *
 * A fixed text color cannot be right, because the accent comes from the skin
 * and may be light OR dark. CSS cannot branch on brightness, so it is
 * measured here — the same approach as for the color scheme one function
 * above, and for the same reason: a maintained list of skin names is complete
 * on the day it is written and never again.
 */
function setzeAkzentSchrift(wurzel: HTMLElement, kanal: (c: number) => number): void {
  const roh = getComputedStyle(wurzel).getPropertyValue("--accent").trim();
  const m = /rgba?\(([^)]+)\)|#([0-9a-fA-F]{6})/.exec(roh);
  if (!m) return;
  let r: number, g: number, b: number;
  if (m[2]) {
    r = parseInt(m[2].slice(0, 2), 16);
    g = parseInt(m[2].slice(2, 4), 16);
    b = parseInt(m[2].slice(4, 6), 16);
  } else {
    [r, g, b] = m[1].split(",").map((s) => parseFloat(s));
  }
  const hell = 0.2126 * kanal(r) + 0.7152 * kanal(g) + 0.0722 * kanal(b) > 0.4;
  wurzel.style.setProperty("--on-accent", hell ? "#101418" : "#ffffff");
}

/**
 * Reactive skin manager – applies skin tokens whenever theme/skinId changes.
 *
 * Important: NO WIDGETS ARE SEEDED HERE ANY MORE. Previously this effect
 * placed three widgets (clock+weather, system stats, Clara) at fixed spots in
 * the top left for `aero-glass`/`clara-glass` when the active workspace was
 * empty. That is why users got the same three widgets back in the top left
 * after EVERY reload and lost their own arrangement:
 *
 *   1. `useWorkspaceStore` persists to **IndexedDB, i.e. asynchronously**.
 *      On first render it is still empty.
 *   2. This effect ran immediately, saw "no widgets" and seeded.
 *   3. Seeding is a `set()` — the persist middleware wrote it to IndexedDB
 *      and thereby overwrote the user's real state.
 *   4. The guard against it was only a module-level `Set`, which does not
 *      survive a reload.
 *
 * `useStateSync` shows how to do it right: it waits with `whenHydrated(...)`
 * before touching state. Anyone who wants to set defaults here again MUST do
 * the same — and additionally be able to tell whether the user removed their
 * widgets on purpose. Otherwise "empty" does not mean "new".
 * New users now deliberately start without widgets; the widget gallery is
 * the way to add some.
 */
export function SkinManager() {
  const skinId = useUIStore((s) => s.skinId);
  const theme = useUIStore((s) => s.theme);

  // User-selected wallpaper override (persisted in useUIStore). When set,
  // it should win over the skin's default wallpaper across reloads — but a
  // fresh skin click in PersonalizationTab clears it so the skin's default
  // wins until the user picks a custom wallpaper again.
  const userWallpaper = useUIStore((s) => s.wallpaper);

  useEffect(() => {
    const skin =
      skinMap[skinId] ??
      (theme === "light" ? windows11LightSkin : windows11DarkSkin);
    applySkin(skin);
    setzeFarbschema();

    // Re-apply user-chosen wallpaper after applySkin() so it survives skin
    // re-applies + page reloads. Empty string = use skin default.
    if (userWallpaper) {
      document.documentElement.style.setProperty("--wallpaper", userWallpaper);
    }

  }, [skinId, theme, userWallpaper]);

  return null;
}
