import type { SkinManifest } from "@claraos/core";

// Win11 Dark Theme
const darkColors: SkinManifest["tokens"]["colors"] = {
  "bg-desktop": "#000000",
  "bg-surface": "rgba(32, 32, 32, 0.70)",
  "bg-surface-solid": "#2c2c2c",
  "bg-taskbar": "rgba(32, 32, 32, 0.65)",
  "bg-window": "#202020",
  // Opaque version of the same colour — window content must NOT let the
  // wallpaper show through.
  "bg-window-solid": "#202020",
  "bg-window-header": "#2d2d2d",
  "bg-hover": "rgba(255, 255, 255, 0.06)",
  "bg-active": "rgba(255, 255, 255, 0.04)",
  "bg-subtle": "rgba(255, 255, 255, 0.03)",
  "text-primary": "#ffffff",
  "text-secondary": "#c5c5c5",
  "text-disabled": "#6b6b6b",
  "accent": "#60cdff",
  "accent-hover": "#78d4ff",
  "accent-bg": "rgba(96, 205, 255, 0.12)",
  "border": "rgba(255, 255, 255, 0.07)",
  "border-focus": "rgba(96, 205, 255, 0.8)",
  "border-window": "rgba(255, 255, 255, 0.05)",
  "close-hover": "#c42b1c",
  "close-hover-text": "#ffffff",
  // Wallpaper gradient
  "wallpaper": "linear-gradient(135deg, #000428 0%, #004e92 100%)",
};

// Win11 Light Theme
const lightColors: SkinManifest["tokens"]["colors"] = {
  "bg-desktop": "#f3f3f3",
  "bg-surface": "rgba(243, 243, 243, 0.72)",
  "bg-surface-solid": "#f3f3f3",
  "bg-taskbar": "rgba(243, 243, 243, 0.65)",
  "bg-window": "#ffffff",
  // Opaque version of the same colour — window content must NOT let the
  // wallpaper show through.
  "bg-window-solid": "#ffffff",
  "bg-window-header": "#f3f3f3",
  "bg-hover": "rgba(0, 0, 0, 0.04)",
  "bg-active": "rgba(0, 0, 0, 0.03)",
  "bg-subtle": "rgba(0, 0, 0, 0.02)",
  "text-primary": "#1a1a1a",
  "text-secondary": "#5c5c5c",
  "text-disabled": "#a0a0a0",
  "accent": "#005fb8",
  "accent-hover": "#0067c0",
  "accent-bg": "rgba(0, 95, 184, 0.08)",
  "border": "rgba(0, 0, 0, 0.06)",
  "border-focus": "rgba(0, 95, 184, 0.6)",
  "border-window": "rgba(0, 0, 0, 0.08)",
  "close-hover": "#c42b1c",
  "close-hover-text": "#ffffff",
  "wallpaper": "linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)",
};

const fonts: SkinManifest["tokens"]["fonts"] = {
  "font-system": "'Segoe UI Variable', 'Segoe UI', system-ui, -apple-system, sans-serif",
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
  "shadow-window": "0 8px 32px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.12)",
  "shadow-window-focused": "0 8px 48px rgba(0, 0, 0, 0.36), 0 2px 12px rgba(0, 0, 0, 0.18)",
  "shadow-taskbar": "0 -1px 4px rgba(0, 0, 0, 0.08)",
  "shadow-menu": "0 8px 32px rgba(0, 0, 0, 0.24), 0 0 0 1px rgba(0, 0, 0, 0.04)",
  "shadow-tooltip": "0 4px 12px rgba(0, 0, 0, 0.2)",
};

const effects: SkinManifest["tokens"]["effects"] = {
  "blur-acrylic": "blur(30px) saturate(125%)",
  "blur-mica": "blur(80px) saturate(150%)",
  "blur-menu": "blur(40px) saturate(140%)",
  "opacity-glass": "0.72",
  "transition-fast": "0.1s ease",
  "transition-normal": "0.2s ease",
  "transition-slow": "0.35s cubic-bezier(0.1, 0.9, 0.2, 1)",
};

export const windows11DarkSkin: SkinManifest = {
  id: "windows11-dark",
  name: "Windows 11 Dark",
  tokens: { colors: darkColors, fonts, spacing, shadows, effects },
  layout: {
    taskbarPosition: "bottom",
    taskbarHeight: 48,
    startMenuStyle: "grid",
    windowButtonsPosition: "right",
    windowHeaderHeight: 32,
    desktopIconGrid: { columns: 12, rows: 8 },
  },
  icons: { system: "", apps: {}, files: {}, folders: {} },
  wallpapers: [],
  defaultWallpaper: "",
};

export const windows11LightSkin: SkinManifest = {
  id: "windows11-light",
  name: "Windows 11 Light",
  tokens: { colors: lightColors, fonts, spacing, shadows, effects },
  layout: {
    taskbarPosition: "bottom",
    taskbarHeight: 48,
    startMenuStyle: "grid",
    windowButtonsPosition: "right",
    windowHeaderHeight: 32,
    desktopIconGrid: { columns: 12, rows: 8 },
  },
  icons: { system: "", apps: {}, files: {}, folders: {} },
  wallpapers: [],
  defaultWallpaper: "",
};

// Default export for backward compat
export const windows11Skin = windows11DarkSkin;
