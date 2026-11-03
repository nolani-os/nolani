import type { SkinManifest } from "@claraos/core";

// Asset URLs resolved by Vite at build time
import stylesheetUrl from "./stylesheet.css?url";
import wallpaperDarkUrl from "./wallpaper-dark.jpg";
import wallpaperLightUrl from "./wallpaper-light.jpg";

// === Orchard — two bars: a thin menu bar on top, a floating glass dock below ===
// Traffic-light window buttons on the left, 12 px window corners, liquid-glass
// surfaces (strong blur, light tint, a bright rim). Fonts: Inter (OFL) with the
// platform's own sans as fallback. Wallpapers are own renders of liquid glass
// forms — amber/coral/indigo on a deep night blue (dark), peach/rose/sky blue
// on a bright haze (light).

export const orchardWallpaperDark = wallpaperDarkUrl;
export const orchardWallpaperLight = wallpaperLightUrl;

const darkColors: SkinManifest["tokens"]["colors"] = {
  "bg-desktop": "#0b1020",
  "bg-surface": "rgba(36, 36, 44, 0.72)",
  "bg-surface-solid": "#26262c",
  // The dock pill and the menu bar: a light glass tint, the wallpaper shows through
  "bg-taskbar": "rgba(70, 70, 82, 0.38)",
  "bg-window": "#1e1e22",
  // Opaque version of the same colour — window content must NOT let the
  // wallpaper show through.
  "bg-window-solid": "#1e1e22",
  // Unified title bar: the header is the window
  "bg-window-header": "#1e1e22",
  "bg-hover": "rgba(255, 255, 255, 0.10)",
  "bg-active": "rgba(255, 255, 255, 0.14)",
  "bg-subtle": "rgba(255, 255, 255, 0.05)",
  "text-primary": "#f5f5f7",
  "text-secondary": "#a1a1aa",
  "text-disabled": "#71717a",
  "accent": "#0a84ff",
  "accent-hover": "#3395ff",
  "accent-bg": "rgba(10, 132, 255, 0.22)",
  "accent-secondary": "#ff9f0a",
  "border": "rgba(255, 255, 255, 0.12)",
  "border-focus": "rgba(10, 132, 255, 0.9)",
  "border-window": "rgba(255, 255, 255, 0.10)",
  "close-hover": "#ff3b30",
  "close-hover-text": "#ffffff",
  "wallpaper": `url("${wallpaperDarkUrl}") center/cover no-repeat, linear-gradient(160deg, #1b1a3a 0%, #0b1020 60%, #2a1420 100%)`,
};

const lightColors: SkinManifest["tokens"]["colors"] = {
  "bg-desktop": "#eef0f6",
  "bg-surface": "rgba(242, 242, 247, 0.78)",
  "bg-surface-solid": "#f2f2f7",
  "bg-taskbar": "rgba(255, 255, 255, 0.42)",
  "bg-window": "#f0f0f4",
  // Opaque version of the same colour — window content must NOT let the
  // wallpaper show through.
  "bg-window-solid": "#f0f0f4",
  "bg-window-header": "#f0f0f4",
  "bg-hover": "rgba(0, 0, 0, 0.06)",
  "bg-active": "rgba(0, 0, 0, 0.08)",
  "bg-subtle": "rgba(0, 0, 0, 0.03)",
  "text-primary": "#1d1d1f",
  "text-secondary": "#6e6e73",
  "text-disabled": "#a1a1a6",
  "accent": "#007aff",
  "accent-hover": "#2a8fff",
  "accent-bg": "rgba(0, 122, 255, 0.14)",
  "accent-secondary": "#ff9500",
  "border": "rgba(0, 0, 0, 0.10)",
  "border-focus": "rgba(0, 122, 255, 0.7)",
  "border-window": "rgba(0, 0, 0, 0.12)",
  "close-hover": "#ff3b30",
  "close-hover-text": "#ffffff",
  "wallpaper": `url("${wallpaperLightUrl}") center/cover no-repeat, linear-gradient(160deg, #fbe4e8 0%, #e6eefc 55%, #fde7d2 100%)`,
};

const fonts: SkinManifest["tokens"]["fonts"] = {
  "font-system": "'Inter', 'SF Pro Text', -apple-system, 'Helvetica Neue', system-ui, sans-serif",
  "font-mono": "'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, monospace",
  "font-size-xs": "11px",
  "font-size-sm": "13px",
  "font-size-base": "14px",
  "font-size-lg": "16px",
  "font-size-xl": "20px",
  "font-size-xxl": "28px",
  "font-weight-normal": "400",
  "font-weight-semibold": "600",
};

const spacing: SkinManifest["tokens"]["spacing"] = {
  "radius-sm": "6px",
  "radius-md": "10px",
  "radius-lg": "14px",
  "radius-window": "12px",
  "radius-pill": "9999px",
  "gap-xs": "4px",
  "gap-sm": "8px",
  "gap-md": "12px",
  "gap-lg": "16px",
  "gap-xl": "24px",
  // The dock's reserved strip (pill + margin); the engine also sets it from layout
  "taskbar-height": "72px",
  "menu-bar-height": "28px",
  "window-header-height": "38px",
};

const shadows: SkinManifest["tokens"]["shadows"] = {
  "shadow-window": "0 12px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(0, 0, 0, 0.5)",
  "shadow-window-focused": "0 22px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.55)",
  "shadow-taskbar": "0 10px 30px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.18)",
  "shadow-menu": "0 12px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(0, 0, 0, 0.3)",
  "shadow-tooltip": "0 4px 14px rgba(0, 0, 0, 0.3)",
};

const lightShadows: SkinManifest["tokens"]["shadows"] = {
  "shadow-window": "0 12px 40px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(0, 0, 0, 0.15)",
  "shadow-window-focused": "0 22px 60px rgba(0, 0, 0, 0.30), 0 0 0 1px rgba(0, 0, 0, 0.18)",
  "shadow-taskbar": "0 10px 30px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.6)",
  "shadow-menu": "0 12px 40px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(0, 0, 0, 0.1)",
  "shadow-tooltip": "0 4px 14px rgba(0, 0, 0, 0.16)",
};

const effects: SkinManifest["tokens"]["effects"] = {
  "blur-acrylic": "blur(40px) saturate(180%)",
  "blur-mica": "blur(60px) saturate(180%)",
  "blur-menu": "blur(40px) saturate(180%)",
  "opacity-glass": "0.72",
  "transition-fast": "0.12s ease-out",
  "transition-normal": "0.22s ease",
  "transition-slow": "0.4s cubic-bezier(0.2, 0.8, 0.2, 1)",
};

const layout: SkinManifest["layout"] = {
  taskbarPosition: "bottom",
  // Reserved strip for the floating dock
  taskbarHeight: 72,
  startMenuStyle: "dock",
  menuBar: true,
  // Overview like Mission Control: spaces bar on top, windows spread below
  overviewStyle: "mission",
  windowButtonsPosition: "left",
  windowHeaderHeight: 38,
  desktopIconGrid: { columns: 12, rows: 8 },
};

export const orchardDarkSkin: SkinManifest = {
  id: "orchard-dark",
  name: "Orchard",
  colorScheme: "dark",
  chrome: "liquid",
  preview: `url("${wallpaperDarkUrl}") center/cover no-repeat`,
  tokens: { colors: darkColors, fonts, spacing, shadows, effects },
  layout,
  icons: { system: "", apps: {}, files: {}, folders: {} },
  wallpapers: [wallpaperDarkUrl, wallpaperLightUrl],
  defaultWallpaper: wallpaperDarkUrl,
  stylesheet: stylesheetUrl,
};

export const orchardLightSkin: SkinManifest = {
  id: "orchard-light",
  name: "Orchard Light",
  colorScheme: "light",
  chrome: "liquid",
  preview: `url("${wallpaperLightUrl}") center/cover no-repeat`,
  tokens: { colors: lightColors, fonts, spacing, shadows: lightShadows, effects },
  layout,
  icons: { system: "", apps: {}, files: {}, folders: {} },
  wallpapers: [wallpaperLightUrl, wallpaperDarkUrl],
  defaultWallpaper: wallpaperLightUrl,
  stylesheet: stylesheetUrl,
};
