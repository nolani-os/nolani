import type { SkinManifest } from "@claraos/core";

// Asset URLs resolved by Vite at build time
import stylesheetUrl from "./stylesheet.css?url";
import wallpaperUrl from "./wallpaper.svg?url";
import wallpaperAnimatedUrl from "./wallpaper-animated.svg?url";

// Re-exported so the live-wallpaper toggle in PersonalizationTab can pick
// the right URL without re-importing the SVG asset directly.
export const aeroGlassStaticWallpaper = wallpaperUrl;
export const aeroGlassAnimatedWallpaper = wallpaperAnimatedUrl;

// === Aero Glass — Apple Liquid Glass on familiar Win11 layout ===
// Layout matches the Win11 skins (taskbar bottom, pins+start left, tray right).
// Visual identity is entirely in the glass effects, gradient mesh wallpaper,
// and the duotone Liquid-Glass app icons.

const colors: SkinManifest["tokens"]["colors"] = {
  // Surfaces — translucent with strong backdrop-filter applied via CSS
  "bg-desktop": "#0A0A14",
  "bg-surface": "rgba(20, 22, 38, 0.55)",
  "bg-surface-solid": "#15172A",
  "bg-taskbar": "rgba(14, 16, 30, 0.45)",
  "bg-window": "rgba(22, 25, 42, 0.78)",
  // Opaque version of the same colour — window content must NOT let the
  // wallpaper show through.
  "bg-window-solid": "#16192A",
  "bg-window-header": "rgba(28, 32, 52, 0.65)",
  "bg-hover": "rgba(255, 255, 255, 0.08)",
  "bg-active": "rgba(255, 255, 255, 0.12)",
  "bg-subtle": "rgba(255, 255, 255, 0.04)",

  // Text
  "text-primary": "#F5F6FF",
  "text-secondary": "#B8BCD8",
  "text-disabled": "#6A6E8A",

  // Accent — Periwinkle primary, Lavender secondary
  "accent": "#7B9FFF",
  "accent-hover": "#9BB6FF",
  "accent-bg": "rgba(123, 159, 255, 0.16)",
  "accent-secondary": "#A78BFA",
  "accent-tertiary": "#5EEAD4",

  // Borders — subtle, mostly used as inner highlight stroke
  "border": "rgba(255, 255, 255, 0.10)",
  "border-focus": "rgba(123, 159, 255, 0.85)",
  "border-window": "rgba(255, 255, 255, 0.08)",

  // Highlights and reflections (consumed by the stylesheet)
  "highlight-glass": "rgba(255, 255, 255, 0.18)",
  "highlight-stroke": "rgba(255, 255, 255, 0.22)",

  // Window control colors
  "close-hover": "#FF5C7A",
  "close-hover-text": "#FFFFFF",

  // Wallpaper — referenced as a CSS url() pointing to the bundled SVG
  "wallpaper": `url("${wallpaperUrl}") center/cover no-repeat, radial-gradient(at 30% 20%, #1B1F40 0%, #0A0A14 60%)`,
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
  // Window shadows — deeper and softer for premium feel
  "shadow-window":
    "0 12px 48px rgba(0, 0, 0, 0.40), 0 4px 12px rgba(0, 0, 0, 0.20), 0 0 0 1px rgba(255, 255, 255, 0.06)",
  "shadow-window-focused":
    "0 24px 72px rgba(0, 0, 0, 0.55), 0 6px 18px rgba(0, 0, 0, 0.30), 0 0 0 1px rgba(123, 159, 255, 0.18)",
  "shadow-taskbar":
    "0 -8px 32px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.10)",
  "shadow-menu":
    "0 16px 48px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.08)",
  "shadow-tooltip": "0 6px 20px rgba(0, 0, 0, 0.35)",
  // Glass icon containers
  "shadow-icon":
    "0 4px 14px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.18), inset 0 -1px 0 rgba(0, 0, 0, 0.20)",
  "shadow-icon-hover":
    "0 8px 22px rgba(123, 159, 255, 0.40), inset 0 1px 0 rgba(255, 255, 255, 0.30), inset 0 -1px 0 rgba(0, 0, 0, 0.20)",
};

const effects: SkinManifest["tokens"]["effects"] = {
  // Stronger blur for the premium glass feel
  "blur-acrylic": "blur(28px) saturate(180%)",
  "blur-mica": "blur(60px) saturate(180%)",
  "blur-menu": "blur(36px) saturate(160%)",
  "blur-icon": "blur(8px) saturate(140%)",
  "opacity-glass": "0.55",
  "transition-fast": "0.12s cubic-bezier(0.2, 0.9, 0.25, 1)",
  "transition-normal": "0.22s cubic-bezier(0.2, 0.9, 0.25, 1)",
  "transition-slow": "0.45s cubic-bezier(0.16, 1, 0.3, 1)",
};

export const aeroGlassSkin: SkinManifest = {
  id: "aero-glass",
  name: "Crystal",
  colorScheme: "dark",
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
  wallpapers: [wallpaperUrl],
  defaultWallpaper: wallpaperUrl,
  stylesheet: stylesheetUrl,
};
