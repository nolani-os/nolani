/**
 * Corporate skin template.
 *
 * A company gets a skin from two colours, a name and a logo: light, quiet,
 * opaque surfaces (no glass), a brand rule over the bar, the logo and the
 * company name in the start button. Every token is derived from `primary`
 * and `accent` — and the derivation MEASURES contrast (WCAG 2.1) instead of
 * assuming it: text roles are pushed towards black until they reach their
 * target on the white window, the foreground on the accent surface is
 * black or white, whichever reads better.
 *
 * Pure (no DOM, no assets) — `corporate.test.mjs` checks the ratios for the
 * shipped tenant and for a hostile input (a yellow primary).
 */
import type { SkinManifest } from "@claraos/core";
import {
  accentForeground,
  accentTokens,
  contrastRatio,
  ensureContrast,
  parseColor,
  tint,
  toHex,
  withAlpha,
  type RGB,
} from "../accent";

export interface CorporateSkinOptions {
  /** Skin id, e.g. `corporate-medical`. */
  id: string;
  /** Shown in the start button and in the settings. */
  companyName: string;
  /** Logo image URL (SVG), drawn at 22 px in the bar. */
  logo: string;
  /** Main brand colour: accent, links, focus, selection. */
  primary: string;
  /** Second brand colour: running indicator, switches, the brand rule's end. */
  accent: string;
  /** One line under the company name in the start menu. */
  tagline?: string;
  /** Wallpaper URL; without one the desktop is a tinted plain surface. */
  wallpaper?: string;
  /** Skin stylesheet URL (`[data-chrome="corporate"]` rules). */
  stylesheet?: string;
}

const WHITE: RGB = { r: 255, g: 255, b: 255 };

/** Tokens derived from the two brand colours — exported for the tests. */
export function corporateColors(
  primaryInput: string,
  accentInput: string,
  wallpaper?: string,
): SkinManifest["tokens"]["colors"] {
  const primary = parseColor(primaryInput) ?? { r: 11, g: 79, b: 138 };
  const accent = parseColor(accentInput) ?? { r: 15, g: 163, b: 163 };

  // Neutrals carry a hint of the primary (OKLab tint keeps the lightness),
  // so the grey of a blue brand is a cool grey and that of a red brand warm.
  const desktop = tint({ r: 243, g: 247, b: 250 }, primary, 0.25);
  const subtle = tint({ r: 244, g: 247, b: 250 }, primary, 0.2);
  const hover = tint({ r: 232, g: 238, b: 244 }, primary, 0.3);
  const active = tint({ r: 224, g: 232, b: 239 }, primary, 0.3);
  const border = tint({ r: 217, g: 225, b: 233 }, primary, 0.3);
  const borderWindow = tint({ r: 205, g: 215, b: 225 }, primary, 0.3);

  // Text: dark neutrals tinted towards the primary, then measured against
  // the white window — primary text wants AAA (7:1), secondary AA (4.5:1).
  const textPrimary = ensureContrast(tint({ r: 24, g: 30, b: 38 }, primary, 0.6), WHITE, 7);
  const textSecondary = ensureContrast(tint({ r: 84, g: 96, b: 110 }, primary, 0.4), WHITE, 4.5);
  const textDisabled = tint({ r: 150, g: 160, b: 170 }, primary, 0.3);

  // Accent roles: the shared resolver (hover, link correction, selection).
  const a = accentTokens(toHex(primary), "#ffffff")!;

  const colors: SkinManifest["tokens"]["colors"] = {
    "bg-desktop": toHex(desktop),
    "bg-surface": "#ffffff",
    "bg-surface-solid": "#ffffff",
    "bg-taskbar": "rgba(255, 255, 255, 0.96)",
    "bg-window": "#ffffff",
    "bg-window-solid": "#ffffff",
    "bg-window-header": "#ffffff",
    "bg-hover": toHex(hover),
    "bg-active": toHex(active),
    "bg-subtle": toHex(subtle),
    "text-primary": toHex(textPrimary),
    "text-secondary": toHex(textSecondary),
    "text-disabled": toHex(textDisabled),
    "accent": a.accent,
    "accent-hover": a["accent-hover"],
    "accent-bg": withAlpha(primary, 0.1),
    "accent-fg": a["accent-fg"],
    "accent-secondary": toHex(accent),
    "link-color": a["link-color"],
    "selection-bg": withAlpha(primary, 0.14),
    "selection-fg": toHex(textPrimary),
    "border": toHex(border),
    "border-focus": a["border-focus"],
    "border-window": toHex(borderWindow),
    "close-hover": "#c42b1c",
    "close-hover-text": "#ffffff",
    // Brand roles consumed by the corporate stylesheet
    "brand-primary": toHex(primary),
    "brand-accent": toHex(accent),
    "brand-accent-fg": toHex(accentForeground(accent)),
    "brand-rule": `linear-gradient(90deg, ${toHex(primary)}, ${toHex(accent)})`,
    "wallpaper": wallpaper
      ? `url("${wallpaper}") center/cover no-repeat, linear-gradient(135deg, ${toHex(desktop)} 0%, ${toHex(active)} 100%)`
      : `linear-gradient(135deg, ${toHex(desktop)} 0%, ${toHex(active)} 100%)`,
  };
  return colors;
}

/** Contrast ratios the template guarantees — the tests read these. */
export function corporateContrast(colors: SkinManifest["tokens"]["colors"]) {
  const c = (k: string) => parseColor(colors[k]) ?? WHITE;
  return {
    textOnWindow: contrastRatio(c("text-primary"), c("bg-window")),
    secondaryOnWindow: contrastRatio(c("text-secondary"), c("bg-window")),
    linkOnWindow: contrastRatio(c("link-color"), c("bg-window")),
    fgOnAccent: contrastRatio(c("accent-fg"), c("accent")),
    fgOnBrandAccent: contrastRatio(c("brand-accent-fg"), c("brand-accent")),
    textOnHover: contrastRatio(c("text-primary"), c("bg-hover")),
  };
}

const fonts: SkinManifest["tokens"]["fonts"] = {
  // Manrope (OFL) is the house face; the stack falls back to what is installed.
  "font-system": "'Manrope', 'Inter', 'Segoe UI', 'Noto Sans', system-ui, -apple-system, sans-serif",
  "font-mono": "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
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
  "radius-md": "6px",
  "radius-lg": "8px",
  "radius-window": "6px",
  "radius-pill": "9999px",
  "gap-xs": "4px",
  "gap-sm": "8px",
  "gap-md": "12px",
  "gap-lg": "16px",
  "gap-xl": "24px",
  "taskbar-height": "48px",
  "window-header-height": "36px",
};

const shadows: SkinManifest["tokens"]["shadows"] = {
  "shadow-window": "0 6px 24px rgba(15, 42, 68, 0.14), 0 1px 3px rgba(15, 42, 68, 0.08), 0 0 0 1px rgba(15, 42, 68, 0.06)",
  "shadow-window-focused": "0 12px 36px rgba(15, 42, 68, 0.20), 0 2px 6px rgba(15, 42, 68, 0.10), 0 0 0 1px rgba(15, 42, 68, 0.08)",
  "shadow-taskbar": "0 -1px 0 rgba(15, 42, 68, 0.06)",
  "shadow-menu": "0 8px 28px rgba(15, 42, 68, 0.16), 0 0 0 1px rgba(15, 42, 68, 0.06)",
  "shadow-tooltip": "0 4px 12px rgba(15, 42, 68, 0.14)",
};

const effects: SkinManifest["tokens"]["effects"] = {
  // No glass: surfaces are opaque, the blur tokens are inert on purpose
  "blur-acrylic": "none",
  "blur-mica": "none",
  "blur-menu": "none",
  "opacity-glass": "1",
  "transition-fast": "0.1s ease",
  "transition-normal": "0.18s ease",
  "transition-slow": "0.3s ease",
};

const layout: SkinManifest["layout"] = {
  taskbarPosition: "bottom",
  taskbarHeight: 48,
  startMenuStyle: "grid",
  windowButtonsPosition: "right",
  windowHeaderHeight: 36,
  desktopIconGrid: { columns: 12, rows: 8 },
};

export function createCorporateSkin(opts: CorporateSkinOptions): SkinManifest {
  const colors = corporateColors(opts.primary, opts.accent, opts.wallpaper);
  return {
    id: opts.id,
    name: opts.companyName,
    colorScheme: "light",
    chrome: "corporate",
    brand: { name: opts.companyName, logo: opts.logo, tagline: opts.tagline },
    preview: opts.wallpaper
      ? `url("${opts.wallpaper}") center/cover no-repeat`
      : `linear-gradient(135deg, ${colors["bg-desktop"]}, ${colors["bg-active"]})`,
    tokens: { colors, fonts, spacing, shadows, effects },
    layout,
    icons: { system: "", apps: {}, files: {}, folders: {} },
    wallpapers: opts.wallpaper ? [opts.wallpaper] : [],
    defaultWallpaper: opts.wallpaper ?? "",
    stylesheet: opts.stylesheet,
  };
}
