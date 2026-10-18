import { memo, useState } from "react";
import { useUIStore } from "@claraos/core";
import { getIconComponent, getBrandLogo, PLATELESS_ICONS, availableSkins, getSkinById } from "@claraos/skins";
import { AppKachel } from "./AppKachel";

type Size = "taskbar" | "pinned" | "start" | "desktop";

interface AppIconProps {
  /** Stable app identifier — must match keys in skin icon registries (e.g. "files"). */
  appId: string;
  /** Emoji or text fallback used when no skin-specific SVG exists. */
  fallback: string;
  /** Pixel size override. Skin-specific styling uses `size` slot for variable widths. */
  pixelSize?: number;
  /** Size slot for skin-aware presets. Defaults to "taskbar". */
  size?: Size;
  className?: string;
  title?: string;
  /** Surface the brand-logo set regardless of active skin (mobile homescreen). */
  forceLogos?: boolean;
  /** Runtime icon (DB-generated hub services) — only applies if no build-time
   *  BrandLogo/skin SVG exists; falls back to the emoji on load error. */
  iconUrl?: string;
}

/**
 * Renders an app icon with skin-aware overrides.
 *
 * Lookup order:
 *   1. `getIconComponent(skinId, appId)` — custom SVG component from active skin
 *   2. `skin.icons.apps[appId]` — emoji-string override declared in the manifest
 *   3. `fallback` — the emoji from the AppManifest (legacy default)
 *
 * The Aero Glass stylesheet styles `.aeroAppIcon` to provide the squircle/glass treatment;
 * other skins simply render the inner glyph without that wrapper styling.
 */
// Default emoji glyph sizes per slot — used when no SVG override exists, so
// emoji icons stay legible across every skin (not just aero-glass).
const EMOJI_PX: Record<Size, number> = {
  taskbar: 20,
  pinned: 22,
  start: 30,
  desktop: 36,
};

function AppIconImpl({
  appId,
  fallback,
  pixelSize,
  size = "taskbar",
  className,
  title,
  forceLogos,
  iconUrl,
}: AppIconProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const skinId = useUIStore((s) => s.skinId);
  const skin = getSkinById(skinId, availableSkins);
  // Brand-logo mode: use ONLY the real brand-logo set (dashboard-icons) on a
  // light plate; otherwise fall straight through to the emoji. Active either
  // via forceLogos (mobile homescreen) or when the skin manifest declares
  // iconStyle "brand" (clara-glass). Skin-specific full-bleed icons (e.g.
  // aero's purple files fill) are skipped so every app reads as a clean
  // glass bead + tile. All other skins are unchanged (iconStyle undefined).
  const useLogos = forceLogos || skin?.iconStyle === "brand";
  // On desktop NO glass bead — the logo fills a tile in the brand color,
  // ClaraOS's own apps use the new icon family. The phone path (forceLogos)
  // keeps the bead and plate.
  if (!forceLogos && skin?.iconStyle === "brand") {
    return (
      <AppKachel appId={appId} fallback={fallback} slot={size} pixelSize={pixelSize}
                 iconUrl={iconUrl} className={className} title={title} />
    );
  }
  const BrandLogo = useLogos ? getBrandLogo(appId) : null;
  const IconSvg = useLogos ? BrandLogo : getIconComponent(skinId, appId);
  // Plateless = a white mono glyph drawn directly on the dark bead (no tile).
  const isMono = useLogos && !!BrandLogo && PLATELESS_ICONS.has(appId);
  const isBrand = !!BrandLogo && !isMono;

  // Resolve emoji-only override from manifest (fallback chain step 2)
  const emojiOverride = IconSvg ? undefined : skin?.icons?.apps?.[appId];

  // forceLogos = mobile context: skip the skin wrapper class entirely so
  // desktop skin stylesheets (.aeroAppIcon rules, e.g. clara-glass bead +
  // brand plate) can never restyle mobile icons — the mobile shell paints
  // its own bead/plate via .iconSquircle/.appLogo.
  const wrapperClass = [forceLogos ? null : "aeroAppIcon", className]
    .filter(Boolean)
    .join(" ");
  const wrapperStyle = pixelSize
    ? ({ "--aero-icon-size": `${pixelSize}px` } as React.CSSProperties)
    : undefined;
  const emojiPx = pixelSize ?? EMOJI_PX[size];

  return (
    <span
      className={wrapperClass}
      data-size={size}
      data-brand={isBrand ? "1" : undefined}
      data-mono={isMono ? "1" : undefined}
      style={wrapperStyle}
      title={title}
      aria-label={title ?? appId}
      role="img"
    >
      {IconSvg ? (
        <IconSvg aria-hidden="true" focusable="false" />
      ) : iconUrl && !imgFailed ? (
        <img
          src={iconUrl}
          alt=""
          aria-hidden="true"
          onError={() => setImgFailed(true)}
          style={{ width: `${emojiPx}px`, height: `${emojiPx}px`, objectFit: "contain" }}
        />
      ) : (
        <span
          className="aeroIconGlyph"
          aria-hidden="true"
          style={{
            fontSize: `${emojiPx}px`,
            lineHeight: 1,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {emojiOverride ?? fallback}
        </span>
      )}
    </span>
  );
}

export const AppIcon = memo(AppIconImpl);
