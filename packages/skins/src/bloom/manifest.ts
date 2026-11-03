import type { SkinManifest } from "@claraos/core";

// Asset URLs resolved by Vite at build time
import stylesheetUrl from "./stylesheet.css?url";
import wallpaperDarkUrl from "./wallpaper-dark.jpg";
import wallpaperLightUrl from "./wallpaper-light.jpg";

// === Bloom — the familiar centred-bar desktop, done with care ===
// Layout: bar at the bottom with the app strip centred, 8 px radii, Mica
// surfaces (a strongly blurred, tinted wallpaper shows through the bar and
// the start menu). Fonts: Segoe-like humanist sans with Selawik (OFL) as the
// free stand-in. Wallpapers are own renders: a ribbon of translucent glass
// petals, cobalt/violet on midnight navy (dark) and sky blue/lavender on an
// airy blue-white (light).

export const bloomWallpaperDark = wallpaperDarkUrl;
export const bloomWallpaperLight = wallpaperLightUrl;

const darkColors: SkinManifest["tokens"]["colors"] = {
  "bg-desktop": "#05070f",
  // Mica: the surface carries a hint of the wallpaper's navy, not plain grey
  "bg-surface": "rgba(30, 32, 44, 0.72)",
  "bg-surface-solid": "#1f2130",
  "bg-taskbar": "rgba(26, 28, 40, 0.78)",
  "bg-window": "#20222e",
  // Opaque version of the same colour — window content must NOT let the
  // wallpaper show through.
  "bg-window-solid": "#20222e",
  "bg-window-header": "#272a38",
  "bg-hover": "rgba(255, 255, 255, 0.06)",
  "bg-active": "rgba(255, 255, 255, 0.04)",
  "bg-subtle": "rgba(255, 255, 255, 0.03)",
  "text-primary": "#ffffff",
  "text-secondary": "#c9cbd6",
  "text-disabled": "#6f7280",
  // Accent: the wallpaper's ice blue
  "accent": "#5cc8ff",
  "accent-hover": "#82d6ff",
  "accent-bg": "rgba(92, 200, 255, 0.14)",
  "accent-secondary": "#8b7cf6",
  "border": "rgba(255, 255, 255, 0.08)",
  "border-focus": "rgba(92, 200, 255, 0.85)",
  "border-window": "rgba(255, 255, 255, 0.07)",
  "close-hover": "#c42b1c",
  "close-hover-text": "#ffffff",
  "wallpaper": `url("${wallpaperDarkUrl}") center/cover no-repeat, radial-gradient(at 60% 50%, #0e1430 0%, #05070f 70%)`,
};

const lightColors: SkinManifest["tokens"]["colors"] = {
  "bg-desktop": "#eef3fb",
  "bg-surface": "rgba(246, 248, 252, 0.78)",
  "bg-surface-solid": "#f3f5fa",
  "bg-taskbar": "rgba(240, 244, 251, 0.80)",
  "bg-window": "#ffffff",
  // Opaque version of the same colour — window content must NOT let the
  // wallpaper show through.
  "bg-window-solid": "#ffffff",
  "bg-window-header": "#f3f5fa",
  "bg-hover": "rgba(0, 0, 0, 0.045)",
  "bg-active": "rgba(0, 0, 0, 0.03)",
  "bg-subtle": "rgba(0, 0, 0, 0.02)",
  "text-primary": "#1b1b1f",
  "text-secondary": "#5c5f6b",
  "text-disabled": "#a0a3ae",
  "accent": "#0f6cbd",
  "accent-hover": "#1a7ad1",
  "accent-bg": "rgba(15, 108, 189, 0.10)",
  "accent-secondary": "#7c6ff0",
  "border": "rgba(0, 0, 0, 0.07)",
  "border-focus": "rgba(15, 108, 189, 0.6)",
  "border-window": "rgba(0, 0, 0, 0.09)",
  "close-hover": "#c42b1c",
  "close-hover-text": "#ffffff",
  "wallpaper": `url("${wallpaperLightUrl}") center/cover no-repeat, linear-gradient(135deg, #eef3fb 0%, #d6e2f3 100%)`,
};

const fonts: SkinManifest["tokens"]["fonts"] = {
  "font-system": "'Segoe UI Variable', 'Segoe UI', 'Selawik', 'Noto Sans', system-ui, -apple-system, sans-serif",
  "font-mono": "'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace",
  "font-size-xs": "11px",
  "font-size-sm": "12px",
  "font-size-base": "14px",
  "font-size-lg": "16px",
  "font-size-xl": "20px",
  "font-size-xxl": "28px",
  "font-weight-normal": "400",
  "font-weight-semibold": "600",
};

const spacing: SkinManifest["tokens"]["spacing"] = {
  "radius-sm": "4px",
  "radius-md": "8px",
  "radius-lg": "12px",
  "radius-window": "8px",
  "radius-pill": "9999px",
  "gap-xs": "4px",
  "gap-sm": "8px",
  "gap-md": "12px",
  "gap-lg": "16px",
  "gap-xl": "24px",
  "taskbar-height": "48px",
  "window-header-height": "32px",
};

const shadows: SkinManifest["tokens"]["shadows"] = {
  "shadow-window": "0 8px 32px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.20)",
  "shadow-window-focused": "0 16px 48px rgba(0, 0, 0, 0.38), 0 2px 12px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.28)",
  "shadow-taskbar": "0 -1px 0 rgba(255, 255, 255, 0.04)",
  "shadow-menu": "0 8px 32px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(0, 0, 0, 0.12)",
  "shadow-tooltip": "0 4px 12px rgba(0, 0, 0, 0.2)",
};

const lightShadows: SkinManifest["tokens"]["shadows"] = {
  "shadow-window": "0 8px 32px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.08)",
  "shadow-window-focused": "0 16px 48px rgba(0, 0, 0, 0.22), 0 2px 12px rgba(0, 0, 0, 0.10), 0 0 0 1px rgba(0, 0, 0, 0.10)",
  "shadow-taskbar": "0 -1px 0 rgba(0, 0, 0, 0.04)",
  "shadow-menu": "0 8px 32px rgba(0, 0, 0, 0.16), 0 0 0 1px rgba(0, 0, 0, 0.06)",
  "shadow-tooltip": "0 4px 12px rgba(0, 0, 0, 0.14)",
};

const effects: SkinManifest["tokens"]["effects"] = {
  // Mica: a lot of blur, the surface tint does the rest
  "blur-acrylic": "blur(40px) saturate(140%)",
  "blur-mica": "blur(80px) saturate(150%)",
  "blur-menu": "blur(60px) saturate(140%)",
  "opacity-glass": "0.78",
  "transition-fast": "0.1s ease",
  "transition-normal": "0.2s ease",
  "transition-slow": "0.35s cubic-bezier(0.1, 0.9, 0.2, 1)",
};

const layout: SkinManifest["layout"] = {
  taskbarPosition: "bottom",
  taskbarHeight: 48,
  startMenuStyle: "grid",
  // Start button, search field and the apps sit together in the middle
  searchField: true,
  // Overview like Task View: windows above, the desktops in a strip at the bottom
  overviewStyle: "taskview",
  windowButtonsPosition: "right",
  windowHeaderHeight: 32,
  desktopIconGrid: { columns: 12, rows: 8 },
};

export const bloomDarkSkin: SkinManifest = {
  id: "bloom-dark",
  name: "Bloom",
  colorScheme: "dark",
  chrome: "mica",
  preview: `url("${wallpaperDarkUrl}") center/cover no-repeat`,
  tokens: { colors: darkColors, fonts, spacing, shadows, effects },
  layout,
  icons: { system: "", apps: {}, files: {}, folders: {} },
  wallpapers: [wallpaperDarkUrl, wallpaperLightUrl],
  defaultWallpaper: wallpaperDarkUrl,
  stylesheet: stylesheetUrl,
};

export const bloomLightSkin: SkinManifest = {
  id: "bloom-light",
  name: "Bloom Light",
  colorScheme: "light",
  chrome: "mica",
  preview: `url("${wallpaperLightUrl}") center/cover no-repeat`,
  tokens: { colors: lightColors, fonts, spacing, shadows: lightShadows, effects },
  layout,
  icons: { system: "", apps: {}, files: {}, folders: {} },
  wallpapers: [wallpaperLightUrl, wallpaperDarkUrl],
  defaultWallpaper: wallpaperLightUrl,
  stylesheet: stylesheetUrl,
};
