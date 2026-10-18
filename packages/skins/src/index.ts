export { windows11Skin, windows11DarkSkin, windows11LightSkin } from "./windows11/manifest";
export { aeroGlassSkin, aeroGlassStaticWallpaper, aeroGlassAnimatedWallpaper } from "./aero-glass/manifest";
export { claraGlassSkin, claraGlassWallpaper, claraGlassWallpaperAlt } from "./clara-glass/manifest";
export { applySkin, getSkinById } from "./engine";
export {
  accentTokens,
  parseColor,
  contrastRatio,
  accentForeground,
  ensureContrast,
  tint,
  ACCENT_PRESETS,
} from "./accent";
export type { RGB, AccentTokens } from "./accent";
export { getIconComponent } from "./getIconComponent";
export type { SkinIconComponent } from "./getIconComponent";
export { getBrandLogo, BRAND_BG, brandLogos, PLATELESS_ICONS } from "./brand-logos";
export type { BrandLogoComponent } from "./brand-logos";
export { getAppSymbol, appSymbols } from "./app-symbols";
export type { AppSymbolComponent } from "./app-symbols";

import { windows11DarkSkin, windows11LightSkin } from "./windows11/manifest";
import { aeroGlassSkin } from "./aero-glass/manifest";
import { claraGlassSkin } from "./clara-glass/manifest";
import type { SkinManifest } from "@claraos/core";

// Skins of this installation (optional ./heim).
const heimSkinModule = Object.values(
  import.meta.glob<{ heimSkins?: SkinManifest[]; heimSkinIds?: Record<string, SkinManifest> }>(
    "./heim/index.ts", { eager: true },
  ),
)[0];

/** All available skins */
export const availableSkins: SkinManifest[] = [
  claraGlassSkin,
  windows11DarkSkin,
  windows11LightSkin,
  aeroGlassSkin,
  ...(heimSkinModule?.heimSkins ?? []),
];

/** Additional skin ids (including legacy aliases) of this installation → manifest. */
export const extraSkinIds: Record<string, SkinManifest> = heimSkinModule?.heimSkinIds ?? {};
