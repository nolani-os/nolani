export { bloomDarkSkin, bloomLightSkin } from "./bloom/manifest";
export { claraGlassSkin, claraGlassWallpaper, claraGlassWallpaperAlt, glassChromeStylesheet } from "./clara-glass/manifest";
export { meadowSkin, meadowSceneAssets } from "./meadow/manifest";
export { shoreSkin, shoreSceneAssets } from "./shore/manifest";
export { createCorporateSkin, corporateColors, corporateContrast } from "./corporate/createCorporateSkin";
export type { CorporateSkinOptions } from "./corporate/createCorporateSkin";
export { corporateMedicalSkin, corporateMedicalLogo, corporateMedicalWallpaper } from "./corporate/medical/manifest";
export { livingPhotoTextures } from "./livingPhotoChrome";
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
export { sunPosition, sunTimes, sunState, moonPhase, dayPhase, julianDay } from "./sun";
export type { SunPosition, SunState, DayPhase } from "./sun";

import { bloomDarkSkin, bloomLightSkin } from "./bloom/manifest";
import { orchardDarkSkin, orchardLightSkin } from "./orchard/manifest";
import { corporateMedicalSkin } from "./corporate/medical/manifest";
import { claraGlassSkin } from "./clara-glass/manifest";
import { meadowSkin } from "./meadow/manifest";
import { shoreSkin } from "./shore/manifest";
import type { SkinManifest } from "@claraos/core";

// Skins of this installation (optional ./heim).
const heimSkinModule = Object.values(
  import.meta.glob<{ heimSkins?: SkinManifest[]; heimSkinIds?: Record<string, SkinManifest> }>(
    "./heim/index.ts", { eager: true },
  ),
)[0];

/** All available skins — Glass first because it is the default. */
export const availableSkins: SkinManifest[] = [
  claraGlassSkin,
  bloomDarkSkin,
  bloomLightSkin,
  orchardDarkSkin,
  orchardLightSkin,
  corporateMedicalSkin,
  meadowSkin,
  shoreSkin,
  ...(heimSkinModule?.heimSkins ?? []),
];

/** The default skin of a fresh installation. */
export const DEFAULT_SKIN_ID = claraGlassSkin.id;
/** Light/dark pair used by the automatic switch when nothing else is configured. */
export const DEFAULT_LIGHT_SKIN_ID = bloomLightSkin.id;
export const DEFAULT_DARK_SKIN_ID = claraGlassSkin.id;

/**
 * Stored ids of skins that no longer exist → their successor. Settings and the
 * UI store keep the old id until the user picks again; without this map a
 * stale id would fall back to the default and silently change the look.
 */
export const legacySkinIds: Record<string, string> = {
  "windows11": bloomDarkSkin.id,
  "windows11-dark": bloomDarkSkin.id,
  "windows11-light": bloomLightSkin.id,
  "aero-glass": claraGlassSkin.id,
};

/** Additional skin ids (including legacy aliases) of this installation → manifest. */
export const extraSkinIds: Record<string, SkinManifest> = heimSkinModule?.heimSkinIds ?? {};

/** Resolve any stored id (current, legacy or installation-specific) to a manifest. */
export function resolveSkin(skinId: string): SkinManifest | undefined {
  const id = legacySkinIds[skinId] ?? skinId;
  return availableSkins.find((s) => s.id === id) ?? extraSkinIds[skinId] ?? extraSkinIds[id];
}

/** Canonical id for a stored one (legacy ids map to their successor). */
export function canonicalSkinId(skinId: string): string {
  return resolveSkin(skinId)?.id ?? skinId;
}
