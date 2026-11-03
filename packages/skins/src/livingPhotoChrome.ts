import type { SkinManifest } from "@claraos/core";
import { glassChromeStylesheet } from "./clara-glass/manifest";
import skyUrl from "./textures/night-sky.jpg";
import moonUrl from "./textures/moon.jpg";

/** Photographic textures for the night sky of the living-photo scenes (own
 *  renders, no third-party rights): a night-sky plate as a normal camera sees
 *  it — horizon glow at the bottom edge, few stars of varied brightness — and a
 *  full moon on black, shaded per phase in the shader. */
export const livingPhotoTextures = { sky: skyUrl, moon: moonUrl };

/**
 * Shared dark-glass chrome for the animated "living photo" skins. The scene
 * paints the whole desktop, so the chrome has to stay quiet and translucent:
 * deep neutral glass with the accent chosen per scene (sunlit amber for the
 * meadow, sea teal for the shore). Fonts, spacing, shadows and effects are the
 * Glass set — one visual language, one stylesheet (`chrome: "glass"`).
 */
export interface LivingPhotoAccent {
  accent: string;
  accentHover: string;
  accentRgb: string; // "r, g, b" for translucent variants
  rimRgb: string;    // rim/highlight tint
}

export function livingPhotoColors(poster: string, fallback: string, a: LivingPhotoAccent): SkinManifest["tokens"]["colors"] {
  return {
    "bg-desktop": "#0B0F17",
    "bg-surface": "rgba(16, 20, 30, 0.62)",
    "bg-surface-solid": "#12161F",
    "bg-taskbar": "rgba(10, 13, 20, 0.48)",
    "bg-window": "rgba(13, 17, 26, 0.82)",
    // Opaque version of the same colour — window content must NOT let the
    // scene show through.
    "bg-window-solid": "#0E121B",
    "bg-window-header": "rgba(18, 23, 34, 0.70)",
    "bg-hover": `rgba(${a.rimRgb}, 0.10)`,
    "bg-active": `rgba(${a.rimRgb}, 0.16)`,
    "bg-subtle": `rgba(${a.rimRgb}, 0.05)`,
    "text-primary": "#F3F5F8",
    "text-secondary": "#B4BCC9",
    "text-disabled": "#66707F",
    "accent": a.accent,
    "accent-hover": a.accentHover,
    "accent-bg": `rgba(${a.accentRgb}, 0.16)`,
    "accent-secondary": a.accentHover,
    "accent-tertiary": "#C7D2E0",
    "border": `rgba(${a.rimRgb}, 0.16)`,
    "border-focus": `rgba(${a.accentRgb}, 0.85)`,
    "border-window": `rgba(${a.rimRgb}, 0.12)`,
    "highlight-glass": `rgba(${a.rimRgb}, 0.16)`,
    "highlight-stroke": `rgba(${a.rimRgb}, 0.22)`,
    "close-hover": "#FF5C7A",
    "close-hover-text": "#FFFFFF",
    // The poster under the scene: visible before the video plays, and the
    // wallpaper when the scene cannot run (no WebGL).
    "wallpaper": `url("${poster}") center/cover no-repeat, ${fallback}`,
  };
}

export const livingPhotoFonts: SkinManifest["tokens"]["fonts"] = {
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

export const livingPhotoSpacing: SkinManifest["tokens"]["spacing"] = {
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

export function livingPhotoShadows(a: LivingPhotoAccent): SkinManifest["tokens"]["shadows"] {
  return {
    "shadow-window":
      `0 12px 48px rgba(0, 0, 0, 0.45), 0 4px 12px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(${a.rimRgb}, 0.06)`,
    "shadow-window-focused":
      `0 24px 72px rgba(0, 0, 0, 0.58), 0 6px 18px rgba(0, 0, 0, 0.30), 0 0 0 1px rgba(${a.accentRgb}, 0.18)`,
    "shadow-taskbar": `0 -8px 32px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(${a.rimRgb}, 0.14)`,
    "shadow-menu": `0 16px 48px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(${a.rimRgb}, 0.10)`,
    "shadow-tooltip": "0 6px 20px rgba(0, 0, 0, 0.35)",
    "shadow-icon":
      `0 2px 6px rgba(0, 0, 0, 0.40), 0 6px 16px rgba(0, 0, 0, 0.30), inset 0 1px 0 rgba(${a.rimRgb}, 0.35), inset 0 -1px 0 rgba(0, 0, 0, 0.30), inset 0 0 0 1px rgba(${a.rimRgb}, 0.12)`,
    "shadow-icon-hover":
      `0 6px 18px rgba(${a.accentRgb}, 0.38), 0 2px 6px rgba(0, 0, 0, 0.40), inset 0 1px 0 rgba(${a.rimRgb}, 0.50), inset 0 -1px 0 rgba(0, 0, 0, 0.30), inset 0 0 0 1px rgba(${a.rimRgb}, 0.18)`,
  };
}

export const livingPhotoEffects: SkinManifest["tokens"]["effects"] = {
  "blur-acrylic": "blur(30px) saturate(125%)",
  "blur-mica": "blur(40px) saturate(140%)",
  "blur-menu": "blur(36px) saturate(130%)",
  "blur-icon": "blur(8px) saturate(140%)",
  "opacity-glass": "0.62",
  "transition-fast": "0.12s cubic-bezier(0.2, 0.9, 0.25, 1)",
  "transition-normal": "0.22s cubic-bezier(0.2, 0.9, 0.25, 1)",
  "transition-slow": "0.45s cubic-bezier(0.16, 1, 0.3, 1)",
};

export const livingPhotoLayout: SkinManifest["layout"] = {
  taskbarPosition: "bottom",
  taskbarHeight: 52,
  startMenuStyle: "grid",
  windowButtonsPosition: "right",
  windowHeaderHeight: 36,
  desktopIconGrid: { columns: 12, rows: 8 },
};

export function livingPhotoSkin(
  id: string,
  name: string,
  poster: string,
  fallback: string,
  accent: LivingPhotoAccent,
): SkinManifest {
  return {
    id,
    name,
    colorScheme: "dark",
    chrome: "glass",
    iconStyle: "brand",
    preview: `url("${poster}") center/cover no-repeat`,
    tokens: {
      colors: livingPhotoColors(poster, fallback, accent),
      fonts: livingPhotoFonts,
      spacing: livingPhotoSpacing,
      shadows: livingPhotoShadows(accent),
      effects: livingPhotoEffects,
    },
    layout: livingPhotoLayout,
    icons: { system: "", apps: {}, files: {}, folders: {} },
    wallpapers: [poster],
    defaultWallpaper: poster,
    stylesheet: glassChromeStylesheet,
  };
}
