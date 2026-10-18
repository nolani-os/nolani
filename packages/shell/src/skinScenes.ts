import type { ComponentType } from "react";

/** An animated scene a skin draws behind the desktop (and on mobile behind
 *  the home screen), plus an optional overlay above the desktop icons. */
export interface SkinScene {
  Scene: ComponentType;
  Overlay?: ComponentType;
}

// Scenes of this installation's own skins (optional
// heim/skinScenes.tsx). Keyed by skin id.
const heimScenes = import.meta.glob<{ heimSkinScenes?: Record<string, SkinScene> }>(
  "./heim/skinScenes.tsx", { eager: true },
);

export const skinScenes: Record<string, SkinScene> = Object.assign(
  {},
  ...Object.values(heimScenes).map((m) => m.heimSkinScenes ?? {}),
);
