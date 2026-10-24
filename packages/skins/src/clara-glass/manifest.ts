import type { SkinManifest } from "@claraos/core";

// Asset URLs resolved by Vite at build time
import stylesheetUrl from "./stylesheet.css?url";
import wallpaperUrl from "./wallpaper.jpg";
import wallpaperAltUrl from "./wallpaper-alt.jpg";

// Re-exported so PersonalizationTab can offer both renders in its wallpaper
// grid (same pattern as the aero-glass static/animated exports).
export const claraGlassWallpaper = wallpaperUrl;
export const claraGlassWallpaperAlt = wallpaperAltUrl;

// === Clara Glass — the ClaraOS mobile design language on the desktop ===
// Layout matches aero-glass (taskbar bottom, pins+start left, tray right).
// Visual identity: deep navy glass with ice-blue rims (rgba(147,197,253,…)),
// dark glossy glass-bead app icons carrying real brand logos, Clara cyan
// accents (#38BDF8/#22D3EE) and the Orbit-C mark — the same language as
// MobileShell, adapted for pointer-driven desktop surfaces.

// Wallpaper: SDXL "navy liquid glass" render, 2688x1536,
// bottom vignette for the taskbar zone; the radial gradient paints while it loads.
const wallpaperFallback =
  "radial-gradient(at 30% 20%, #12203E 0%, #070A13 65%)";

const colors: SkinManifest["tokens"]["colors"] = {
  // Surfaces — deep navy glass, darker + bluer than aero-glass
  "bg-desktop": "#070A13",
  "bg-surface": "rgba(19, 26, 46, 0.62)",
  "bg-surface-solid": "#0F1626",
  "bg-taskbar": "rgba(12, 18, 34, 0.45)",
  "bg-window": "rgba(14, 20, 38, 0.80)",
  // Opaque version of the same colour — window content must NOT let the
  // wallpaper show through.
  "bg-window-solid": "#0E1426",
  "bg-window-header": "rgba(19, 26, 46, 0.68)",
  "bg-hover": "rgba(147, 197, 253, 0.10)",
  "bg-active": "rgba(147, 197, 253, 0.16)",
  "bg-subtle": "rgba(147, 197, 253, 0.05)",

  // Text
  "text-primary": "#F2F6FF",
  "text-secondary": "#AFC0E0",
  "text-disabled": "#5D6B8C",

  // Accent — Clara cyan family (matches the Orbit-C mark)
  "accent": "#38BDF8",
  "accent-hover": "#7DD3FC",
  "accent-bg": "rgba(56, 189, 248, 0.16)",
  "accent-secondary": "#22D3EE",
  "accent-tertiary": "#A5B4FC",

  // Borders — the ice-blue rim from the mobile widget glass
  "border": "rgba(147, 197, 253, 0.16)",
  "border-focus": "rgba(56, 189, 248, 0.85)",
  "border-window": "rgba(147, 197, 253, 0.12)",

  // Highlights and reflections (consumed by the stylesheet)
  "highlight-glass": "rgba(180, 205, 253, 0.16)",
  "highlight-stroke": "rgba(180, 205, 253, 0.22)",

  // Window control colors
  "close-hover": "#FF5C7A",
  "close-hover-text": "#FFFFFF",

  // Wallpaper — navy liquid-glass; gradient paints instantly under the JPG
  "wallpaper": `url("${wallpaperUrl}") center/cover no-repeat, ${wallpaperFallback}`,
};

const fonts: SkinManifest["tokens"]["fonts"] = {
  "font-system":
    "'Inter Variable', 'Inter', 'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  "font-mono": "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
  "font-size-xs": "11px",
  "font-size-sm": "12px",
  "font-size-base": "14px",
  "font-size-lg": "16px",
  "font-size-xl": "20px",
  "font-size-xxl": "30px",
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
  "taskbar-height": "52px",
  "window-header-height": "36px",
};

const shadows: SkinManifest["tokens"]["shadows"] = {
  "shadow-window":
    "0 12px 48px rgba(0, 0, 0, 0.40), 0 4px 12px rgba(0, 0, 0, 0.20), 0 0 0 1px rgba(147, 197, 253, 0.06)",
  "shadow-window-focused":
    "0 24px 72px rgba(0, 0, 0, 0.55), 0 6px 18px rgba(0, 0, 0, 0.30), 0 0 0 1px rgba(56, 189, 248, 0.18)",
  "shadow-taskbar":
    "0 -8px 32px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(180, 205, 253, 0.14)",
  "shadow-menu":
    "0 16px 48px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(147, 197, 253, 0.10)",
  "shadow-tooltip": "0 6px 20px rgba(0, 0, 0, 0.35)",
  // Glass tile icon containers — flat desktop squircle (NOT the mobile
  // sphere recipe: dome insets read as a squeezed ball on a 22% squircle)
  "shadow-icon":
    "0 2px 6px rgba(0, 0, 0, 0.40), 0 6px 16px rgba(0, 0, 0, 0.30), inset 0 1px 0 rgba(200, 225, 255, 0.35), inset 0 -1px 0 rgba(0, 0, 0, 0.30), inset 0 0 0 1px rgba(120, 160, 220, 0.12)",
  "shadow-icon-hover":
    "0 6px 18px rgba(56, 189, 248, 0.38), 0 2px 6px rgba(0, 0, 0, 0.40), inset 0 1px 0 rgba(200, 225, 255, 0.50), inset 0 -1px 0 rgba(0, 0, 0, 0.30), inset 0 0 0 1px rgba(120, 160, 220, 0.18)",
};

const effects: SkinManifest["tokens"]["effects"] = {
  // Research-backed blur budget: taskbar 30px, flyouts/menus <= 40px
  "blur-acrylic": "blur(30px) saturate(125%)",
  "blur-mica": "blur(40px) saturate(140%)",
  "blur-menu": "blur(36px) saturate(130%)",
  "blur-icon": "blur(8px) saturate(140%)",
  "opacity-glass": "0.62",
  "transition-fast": "0.12s cubic-bezier(0.2, 0.9, 0.25, 1)",
  "transition-normal": "0.22s cubic-bezier(0.2, 0.9, 0.25, 1)",
  "transition-slow": "0.45s cubic-bezier(0.16, 1, 0.3, 1)",
};

export const claraGlassSkin: SkinManifest = {
  id: "clara-glass",
  name: "Glass",
  colorScheme: "dark",
  iconStyle: "brand",
  tokens: { colors, fonts, spacing, shadows, effects },
  layout: {
    taskbarPosition: "bottom",
    taskbarHeight: 52,
    startMenuStyle: "grid",
    windowButtonsPosition: "right",
    windowHeaderHeight: 36,
    desktopIconGrid: { columns: 12, rows: 8 },
  },
  icons: { system: "", apps: {}, files: {}, folders: {} },
  wallpapers: [wallpaperUrl, wallpaperAltUrl],
  defaultWallpaper: wallpaperUrl,
  stylesheet: stylesheetUrl,
};
