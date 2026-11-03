import type { ComponentType, SVGProps } from "react";
import { logoIcons } from "./logo-icons";

export type SkinIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Look up a skin-specific icon component for the given app.
 * Returns null when nothing asks for the logo set — callers then fall back
 * to the AppManifest's emoji. `forceLogos` (mobile) surfaces the glass-bead
 * logo set under any skin; the desktop keeps the skin's own icon style.
 */
export function getIconComponent(
  _skinId: string,
  appId: string,
  forceLogos = false,
): SkinIconComponent | null {
  if (forceLogos) {
    return logoIcons[appId] ?? null;
  }
  return null;
}
