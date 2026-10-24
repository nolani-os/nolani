/**
 * AppearanceManager.
 *
 * Applies the settings module "appearance" to the UI — accent color, UI scale,
 * motion, contrast — and drives the automatic light/dark switch.
 *
 * Order matters: the SkinManager sets the skin tokens, THEN this manager lays
 * the user overrides on top. That is why the effect also depends on skinId —
 * a skin change would otherwise wipe the overrides.
 *
 * The light/dark automation follows KDE's model: three separate values
 * (active design, design for light, design for dark) instead of an "auto"
 * mode with an implicit theme. Switching happens on the full minute via a
 * timer, not via polling.
 */
import { useEffect, useRef } from "react";
import {
  useSettingsStore,
  useUIStore,
  useWindowsStore,
  useAppRegistryStore,
  applyUiLanguage,
} from "@claraos/core";
import { accentTokens } from "@claraos/skins";

const ACCENT_KEYS = [
  "accent",
  "accent-hover",
  "accent-bg",
  "accent-fg",
  "border-focus",
  "link-color",
  "selection-bg",
  "selection-fg",
] as const;

const OVERRIDE_STYLE_ID = "claraos-appearance-overrides";

/**
 * Overrides as a separate stylesheet, NOT as an inline style on :root.
 *
 * The SkinManager writes the skin tokens inline on :root. If we wrote there
 * too, "remove override" would necessarily also delete the skin value — the
 * accent would simply be empty afterwards. A separate stylesheet with
 * !important sits cleanly on top and can be removed without residue.
 */
function writeOverrides(tokens: Record<string, string> | null): void {
  let el = document.getElementById(OVERRIDE_STYLE_ID) as HTMLStyleElement | null;
  if (!tokens) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = OVERRIDE_STYLE_ID;
    document.head.appendChild(el);
  }
  const body = Object.entries(tokens)
    .map(([k, v]) => `  --${k}: ${v} !important;`)
    .join("\n");
  el.textContent = `:root {\n${body}\n}`;
}

/** Is it "light" at the given hour? Sunrise < sunset. */
export function isDaytime(hour: number, sunrise: number, sunset: number): boolean {
  if (sunrise === sunset) return true;
  if (sunrise < sunset) return hour >= sunrise && hour < sunset;
  // Times wrapped over midnight (e.g. light from 20, dark from 7)
  return hour >= sunrise || hour < sunset;
}

export function AppearanceManager() {
  const values = useSettingsStore((s) => s.values["appearance"]);
  const uiLanguage = useSettingsStore((s) => s.values["region-formats"]?.uiLanguage);
  const behavior = useSettingsStore((s) => s.values["workspace-behavior"]);
  const session = useSettingsStore((s) => s.values["session"]);
  const loadModule = useSettingsStore((s) => s.loadModule);
  const loadSchema = useSettingsStore((s) => s.loadSchema);
  const connectWs = useSettingsStore((s) => s.connectWs);
  const skinId = useUIStore((s) => s.skinId);
  const setSkin = useUIStore((s) => s.setSkin);
  const autoSwitchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load schema + values once and stay attached to the WS back channel, so a
  // change in the Settings window takes effect across the whole desktop at once.
  useEffect(() => {
    void loadSchema();
    void loadModule("appearance");
    // Region formats use the same back channel — numbers/dates/file sizes across
    // the whole shell follow them, not just the settings page.
    void loadModule("region-formats");
    void loadModule("workspace-behavior");
    void loadModule("privacy-history");
    void loadModule("session");
    void loadModule("notifications");
    void loadModule("terminal");
    return connectWs();
  }, [loadSchema, loadModule, connectWs]);

  // ── UI language ───────────────────────────────────────────────────────
  // Only once the setting has arrived: until then the remembered start
  // language stays, otherwise a reload would flash the browser language.
  useEffect(() => {
    if (uiLanguage !== undefined) applyUiLanguage(uiLanguage);
  }, [uiLanguage]);

  // ── Apply tokens ───────────────────────────────────────────────────────
  useEffect(() => {
    const root = document.documentElement;
    if (!values) return;

    // Accent
    if (values.accentSource === "custom" && typeof values.accentColor === "string") {
      // Skin background as reference — without it the contrast correction would be blind.
      const bg =
        getComputedStyle(root).getPropertyValue("--bg-surface-solid").trim() ||
        getComputedStyle(root).getPropertyValue("--bg-desktop").trim() ||
        "#0f1626";
      const tokens = accentTokens(values.accentColor, bg);
      if (tokens) {
        writeOverrides(Object.fromEntries(ACCENT_KEYS.map((k) => [k, tokens[k]])));
        root.dataset.accentSource = "custom";
      }
    } else {
      writeOverrides(null);
      delete root.dataset.accentSource;
    }

    // UI scale: a separate axis, do not bend the font size (KDE lesson)
    const scale = typeof values.uiScale === "number" ? values.uiScale : 100;
    root.style.setProperty("--ui-scale", String(scale / 100));
    root.style.fontSize = scale === 100 ? "" : `${scale}%`;

    // Font roles: only the family, not the size (the UI scale above controls
    // that — otherwise there would be two controls for the same thing).
    const UI_FONTS: Record<string, string> = {
      system: "",
      inter: '"Inter", system-ui, sans-serif',
      "noto-sans": '"Noto Sans", system-ui, sans-serif',
      segoe: '"Segoe UI", system-ui, sans-serif',
      dejavu: '"DejaVu Sans", system-ui, sans-serif',
    };
    const MONO_FONTS: Record<string, string> = {
      system: "",
      cascadia: '"Cascadia Code", ui-monospace, monospace',
      "fira-code": '"Fira Code", ui-monospace, monospace',
      jetbrains: '"JetBrains Mono", ui-monospace, monospace',
      "dejavu-mono": '"DejaVu Sans Mono", ui-monospace, monospace',
    };
    const ui = UI_FONTS[String(values.fontUi ?? "system")] ?? "";
    const mono = MONO_FONTS[String(values.fontMono ?? "system")] ?? "";
    if (ui) root.style.setProperty("--font-ui", ui);
    else root.style.removeProperty("--font-ui");
    if (mono) root.style.setProperty("--font-mono", mono);
    else root.style.removeProperty("--font-mono");

    // Motion / contrast as data attributes — CSS decides what that means
    if (values.reduceMotion) root.dataset.reduceMotion = "1";
    else delete root.dataset.reduceMotion;
    if (values.highContrast) root.dataset.highContrast = "1";
    else delete root.dataset.highContrast;
  }, [values, skinId]);

  // ── Behavior from the module "workspace-behavior" ──────────────────────
  // Separate effect because it depends on a different settings module.
  useEffect(() => {
    const root = document.documentElement;
    if (!behavior) return;

    // Map animation speed to a factor. "Instant" is the same as "reduce
    // motion" — both paths must work.
    const speed = String(behavior.animationSpeed ?? "normal");
    const factor = { instant: 0, fast: 0.6, normal: 1, slow: 1.6 }[speed] ?? 1;
    root.style.setProperty("--animation-factor", String(factor));
    if (speed === "instant") root.dataset.reduceMotion = "1";

    if (behavior.showTooltips === false) root.dataset.hideTooltips = "1";
    else delete root.dataset.hideTooltips;
  }, [behavior]);

  // ── Autostart ──────────────────────────────────────────────────────────
  // Once per page load: open the chosen apps unless they are already open
  // (session restore may have brought them back — the same window twice
  // would be annoying).
  const autostartDone = useRef(false);
  useEffect(() => {
    if (autostartDone.current) return;
    const list = useSettingsStore.getState().values["session"]?.autostartApps;
    if (!Array.isArray(list) || list.length === 0) return;
    autostartDone.current = true;
    const W = useWindowsStore.getState();
    const open = new Set(Object.values(W.windows).map((w) => w.appId));
    for (const appId of list as string[]) {
      if (open.has(appId)) continue;
      const app = useAppRegistryStore.getState().getApp(appId);
      if (!app) continue;
      W.openWindow(appId, {
        title: app.name,
        width: app.window?.defaultWidth,
        height: app.window?.defaultHeight,
      });
    }
  }, [session]);

  // ── Light/dark automation ──────────────────────────────────────────────
  useEffect(() => {
    if (!values) return;
    const mode = values.themeMode ?? "skin";
    if (mode === "skin") return;

    const lightSkin = String(values.lightSkinId ?? "windows11-light");
    const darkSkin = String(values.darkSkinId ?? "clara-glass");

    const applyForNow = () => {
      let wantLight: boolean;
      if (mode === "light") wantLight = true;
      else if (mode === "dark") wantLight = false;
      else {
        wantLight = isDaytime(
          new Date().getHours(),
          Number(values.sunriseHour ?? 7),
          Number(values.sunsetHour ?? 20),
        );
      }
      const target = wantLight ? lightSkin : darkSkin;
      if (target && target !== useUIStore.getState().skinId) setSkin(target);
    };

    applyForNow();

    if (mode !== "auto") return;
    // Check at the next full hour — no polling interval.
    const schedule = () => {
      const now = new Date();
      const msToNextHour =
        (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1000 + 1000;
      autoSwitchRef.current = setTimeout(() => {
        applyForNow();
        schedule();
      }, msToNextHour);
    };
    schedule();
    return () => {
      if (autoSwitchRef.current) clearTimeout(autoSwitchRef.current);
    };
  }, [values, setSkin]);

  return null;
}
