import type { ComponentType, SVGProps } from "react";
import { aeroGlassIcons } from "./aero-glass/icons";

export type SkinIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Look up a skin-specific icon component for the given app.
 * Returns null when the active skin has no custom icon for that app —
 * callers should then fall back to the AppManifest's emoji.
 */
export function getIconComponent(
  skinId: string,
  appId: string,
  forceLogos = false,
): SkinIconComponent | null {
  // The aero-glass set is the de-facto brand-logo registry. `forceLogos`
  // (mobile) surfaces it under any skin; desktop behavior is unchanged.
  if (skinId === "aero-glass" || forceLogos) {
    return aeroGlassIcons[appId] ?? null;
  }
  return null;
}
