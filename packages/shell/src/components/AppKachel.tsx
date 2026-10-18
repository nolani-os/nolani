/** AppKachel — the desktop icon without a glass bead.
 *
 * NO tile behind the logo. The brand color as background does not work — a
 * logo on its own color (Nextcloud blue on blue) is invisible, and dark
 * backgrounds dissolve into the navy. Instead, like Plasma and Windows: the
 * icon stands FREE, fills 88 % of its area and gets a fine shadow as an
 * outline. Only the few dark logos (DUNKLE_LOGOS) sit on a light round disc,
 * as Plasma does for fallback icons.
 *
 * ClaraOS's own apps use the 3D icon set from `packages/skins/src/app-symbols/`
 * (generated): squircle with gradient, light
 * edge, gloss, glyph with extrusion + shadow — the same construction as
 * Apple's Big Sur and Microsoft's Fluent icons. The colored stroke glyph in
 * the section color remains only as a fallback for apps without an icon.
 *
 * Sizes per slot: taskbar 32 · pinned 34 · start 48 · desktop 60.
 * The phone path (forceLogos in AppIcon) keeps the bead and plate.
 */
import { useState, type CSSProperties } from "react";
import { getBrandLogo, PLATELESS_ICONS, getAppSymbol } from "@claraos/skins";
import { Icon, type IconName } from "./Icon";
import styles from "./AppKachel.module.css";

// Tile aliases, dark logos and own-app glyphs of this installation
// (optional heim.config.ts).
const heimConfig = Object.values(import.meta.glob<{
  APP_KACHEL_ALIAS?: Record<string, string>;
  APP_KACHEL_DARK_LOGOS?: string[];
  APP_KACHEL_EIGENE?: Record<string, { icon: IconName; bereich: Bereich }>;
}>("../heim.config.ts", { eager: true }))[0];
const KACHEL_ALIAS: Record<string, string> = heimConfig?.APP_KACHEL_ALIAS ?? {};

export type KachelSlot = "taskbar" | "pinned" | "start" | "desktop";
/** Taskbar/pinned sizes (26/30 was too small). */
const PX: Record<KachelSlot, number> = { taskbar: 32, pinned: 34, start: 48, desktop: 60 };

/** Logos whose base color is almost black — measured (luminance of the most
 *  frequent colors < 0.25) and supplemented by cases the measurement misses
 *  (black circle without a fill attribute). Only these get the disc. */
const DUNKLE_LOGOS = new Set<string>([
  "open-webui", "vaultwarden", "paperless",
  ...(heimConfig?.APP_KACHEL_DARK_LOGOS ?? []),
]);

type Bereich = "system" | "prod" | "komm" | "medien" | "werk" | "buero" | "ki" | "spiele";
/** Section color of the glyph (the color is on the glyph, not a background). */
const FARBE: Record<Bereich, string> = {
  system: "#9fb3d6",
  prod:   "#2fc4d8",
  komm:   "#b784ff",
  medien: "#ff6f91",
  werk:   "#5fd39a",
  buero:  "#5aa9ff",
  ki:     "#6fd3ff",
  spiele: "#ffb454",
};

/** ClaraOS's own apps: glyph + section. Anything not listed here and without
 *  a brand logo falls back to image/emoji. */
export const EIGENE: Record<string, { icon: IconName; bereich: Bereich }> = {
  settings:          { icon: "gear",        bereich: "system" },
  "task-manager":    { icon: "recents",     bereich: "system" },
  "user-admin":      { icon: "people",      bereich: "system" },
  "services-hub":    { icon: "link",        bereich: "system" },
  files:             { icon: "folder",      bereich: "prod" },
  planner:           { icon: "calendar",    bereich: "prod" },
  knowledge:         { icon: "collections", bereich: "prod" },
  ideas:             { icon: "idea",        bereich: "prod" },
  kontakte:          { icon: "person",      bereich: "prod" },
  "teams-workspace": { icon: "comment",     bereich: "komm" },
  "image-viewer":    { icon: "image",       bereich: "medien" },
  "video-player":    { icon: "play",        bereich: "medien" },
  "pdf-viewer":      { icon: "document",    bereich: "buero" },
  "text-editor":     { icon: "note",        bereich: "buero" },
  "office-viewer":   { icon: "document",    bereich: "buero" },
  "wrapp-container": { icon: "cube",        bereich: "werk" },
  ...heimConfig?.APP_KACHEL_EIGENE,
};

interface Props {
  appId: string;
  fallback: string;
  slot: KachelSlot;
  pixelSize?: number;
  iconUrl?: string;
  className?: string;
  title?: string;
}

export function AppKachel({ appId: rawAppId, fallback, slot, pixelSize, iconUrl, className, title }: Props) {
  const appId = KACHEL_ALIAS[rawAppId] ?? rawAppId;
  const [imgFailed, setImgFailed] = useState(false);
  const px = pixelSize ?? PX[slot];
  const eigen = EIGENE[appId];
  const Symbol3D = getAppSymbol(appId);
  const BrandLogo = getBrandLogo(appId);
  // White mono glyphs of the logo set (PLATELESS) are not brands — they use
  // the own icon family if there is an entry there.
  const marke = !!BrandLogo && !PLATELESS_ICONS.has(appId);
  const scheibe = marke && DUNKLE_LOGOS.has(appId);
  const farbe = eigen ? FARBE[eigen.bereich] : undefined;
  const style = { width: px, height: px, ["--kachel-px" as string]: `${px}px`, ["--glyphe" as string]: farbe } as CSSProperties;
  return (
    <span className={`${styles.symbol} ${className ?? ""}`} style={style} data-slot={slot}
          data-marke={marke ? "1" : undefined} data-scheibe={!Symbol3D && scheibe ? "1" : undefined}
          data-3d={Symbol3D ? "1" : undefined}
          title={title} aria-label={title ?? appId} role="img">
      {Symbol3D ? (
        <Symbol3D aria-hidden="true" focusable="false" />
      ) : eigen ? (
        <Icon name={eigen.icon} size={Math.round(px * 0.82)} className={styles.glyphe} />
      ) : BrandLogo ? (
        <BrandLogo aria-hidden="true" focusable="false" />
      ) : iconUrl && !imgFailed ? (
        <img src={iconUrl} alt="" aria-hidden="true" onError={() => setImgFailed(true)} />
      ) : (
        <span className={styles.emoji} aria-hidden="true">{fallback}</span>
      )}
    </span>
  );
}
