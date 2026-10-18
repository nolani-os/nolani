import type { SkinManifest } from "@claraos/core";

/** Apply all skin tokens as CSS custom properties on :root */
export function applySkin(skin: SkinManifest): void {
  const root = document.documentElement;

  // Apply all token categories
  const tokenGroups = [
    skin.tokens.colors,
    skin.tokens.fonts,
    skin.tokens.spacing,
    skin.tokens.shadows,
    skin.tokens.effects,
  ];

  for (const group of tokenGroups) {
    for (const [key, value] of Object.entries(group)) {
      root.style.setProperty(`--${key}`, value);
    }
  }

  // Apply layout tokens as CSS custom properties
  root.style.setProperty("--taskbar-height", `${skin.layout.taskbarHeight}px`);
  root.style.setProperty("--window-header-height", `${skin.layout.windowHeaderHeight}px`);

  // Layout data attributes (for CSS structural rules)
  root.dataset.taskbarPosition = skin.layout.taskbarPosition;
  root.dataset.windowButtons = skin.layout.windowButtonsPosition;
  root.dataset.startMenuStyle = skin.layout.startMenuStyle;
  root.dataset.skinId = skin.id;

  // Color scheme for browser controls (scrollbars, inputs).
  // Prefer explicit colorScheme on the manifest; fall back to id-based heuristic.
  root.style.colorScheme =
    skin.colorScheme ?? (skin.id.includes("light") ? "light" : "dark");

  // Load skin-specific stylesheet (if any)
  if (skin.stylesheet) {
    let styleEl = document.getElementById("claraos-skin-styles") as HTMLLinkElement | null;
    if (!styleEl) {
      styleEl = document.createElement("link") as HTMLLinkElement;
      styleEl.id = "claraos-skin-styles";
      styleEl.rel = "stylesheet";
      document.head.appendChild(styleEl);
    }
    styleEl.href = skin.stylesheet;
  } else {
    // Remove skin stylesheet if switching to a skin without one
    const existing = document.getElementById("claraos-skin-styles");
    if (existing) existing.remove();
  }
}

/** Get a skin by ID from the available skins */
export function getSkinById(skinId: string, skins: SkinManifest[]): SkinManifest | undefined {
  return skins.find((s) => s.id === skinId);
}
