/**
 * Accent resolver.
 *
 * Modelled on KDE's `colorsapplicator.cpp`: an accent colour chosen by the
 * user selectively overrides some roles of the active skin instead of adding
 * a second colour scheme next to it.
 *
 * Rules adopted from the KDE original:
 *  1. The accent directly replaces the active/link/focus/hover roles.
 *  2. Link colours get a contrast correction against the background
 *     (WCAG ratio ≥ 4.5); otherwise they are lightened/darkened.
 *  3. Foreground on accent surfaces is black or white — whichever gives the
 *     better contrast. Never "the accent, just darker".
 *  4. Tinting happens in OKLab: only a/b are interpolated towards the accent,
 *     L stays. That way a light theme does not tip into dark.
 *
 * Pure functions without DOM access — hence testable in Node
 * (test/accent.test.mjs).
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

// ── Parsing / formatting ─────────────────────────────────────────────────

export function parseColor(input: string): RGB | null {
  const s = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  return null;
}

export function toHex({ r, g, b }: RGB): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function withAlpha({ r, g, b }: RGB, alpha: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${alpha})`;
}

// ── Contrast (WCAG 2.1) ──────────────────────────────────────────────────

function channelLuminance(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(c: RGB): number {
  return (
    0.2126 * channelLuminance(c.r) +
    0.7152 * channelLuminance(c.g) +
    0.0722 * channelLuminance(c.b)
  );
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: RGB = { r: 255, g: 255, b: 255 };
const BLACK: RGB = { r: 0, g: 0, b: 0 };

/** Readable foreground on an accent surface (KDE accentForeground). */
export function accentForeground(accent: RGB): RGB {
  return contrastRatio(accent, WHITE) >= contrastRatio(accent, BLACK) ? WHITE : BLACK;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/**
 * Push the accent towards white or black until it reaches the required
 * contrast ratio against `bg` (KDE: link correction, target 5.0).
 * If no mix reaches the target, the highest-contrast one wins.
 */
export function ensureContrast(accent: RGB, bg: RGB, target = 5.0): RGB {
  if (contrastRatio(accent, bg) >= target) return accent;
  const towards = relativeLuminance(bg) > 0.5 ? BLACK : WHITE;
  let best = accent;
  let bestRatio = contrastRatio(accent, bg);
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const cand = mix(accent, towards, t);
    const ratio = contrastRatio(cand, bg);
    if (ratio > bestRatio) {
      best = cand;
      bestRatio = ratio;
    }
    if (ratio >= target) return cand;
  }
  return best;
}

// ── OKLab (for tinting) ──────────────────────────────────────────────────

function srgbToLinear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return s * 255;
}

export function rgbToOklab(c: RGB): { L: number; a: number; b: number } {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToRgb(lab: { L: number; a: number; b: number }): RGB {
  const l = Math.pow(lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3);
  const m = Math.pow(lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3);
  const s = Math.pow(lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3);
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/**
 * Tint a colour slightly towards the accent — lightness is preserved
 * (KDE tintColor: interpolate only a/b, leave L untouched).
 */
export function tint(color: RGB, accent: RGB, factor: number): RGB {
  if (factor <= 0) return color;
  const c = rgbToOklab(color);
  const a = rgbToOklab(accent);
  return oklabToRgb({
    L: c.L,
    a: c.a + (a.a - c.a) * factor,
    b: c.b + (a.b - c.b) * factor,
  });
}

// ── Token derivation ─────────────────────────────────────────────────────

export interface AccentTokens {
  accent: string;
  "accent-hover": string;
  "accent-bg": string;
  "accent-fg": string;
  "border-focus": string;
  "link-color": string;
  "selection-bg": string;
  "selection-fg": string;
}

/**
 * The CSS variables an accent colour sets.
 *
 * `background` is the window background of the active skin — it determines
 * how strongly the link/accent colour must be corrected. Without it, accents
 * on light skins would be unreadable.
 */
export function accentTokens(accentInput: string, background: string): AccentTokens | null {
  const accent = parseColor(accentInput);
  if (!accent) return null;
  const bg = parseColor(background) ?? { r: 15, g: 22, b: 38 };

  const readable = ensureContrast(accent, bg, 5.0);
  const fg = accentForeground(accent);
  const hover = mix(accent, relativeLuminance(bg) > 0.5 ? BLACK : WHITE, 0.18);

  return {
    accent: toHex(accent),
    "accent-hover": toHex(hover),
    "accent-bg": withAlpha(accent, 0.16),
    "accent-fg": toHex(fg),
    "border-focus": withAlpha(accent, 0.85),
    "link-color": toHex(readable),
    // KDE: selection = accent with alpha 0.7 over the view background
    "selection-bg": withAlpha(accent, 0.7),
    "selection-fg": toHex(accentForeground(mix(bg, accent, 0.7))),
  };
}

/** Default palette (KDE Breeze accents) for the picker in the settings. */
export const ACCENT_PRESETS = [
  "#e93a9a", "#e93d58", "#e9643a", "#e8cb2d", "#3dd425",
  "#00d3b8", "#3daee9", "#b875dc", "#926ee4", "#686b6f",
] as const;
