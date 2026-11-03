import type { ComponentType } from "react";

/** An animated scene a skin draws behind the desktop (and on mobile behind
 *  the home screen), plus an optional overlay above the desktop icons. */
export interface SkinScene {
  Scene: ComponentType;
  Overlay?: ComponentType;
}

/** Shape of a product scene module: `scenes/<name>.scene.tsx` exports the
 *  skin id it belongs to and the (lazily loaded) scene components, so each
 *  scene ends up in its own chunk and costs the other skins nothing. */
export interface SceneModule {
  skinId: string;
  scene: SkinScene;
}

// Product scenes, keyed by skin id (one file per scene).
const productScenes = import.meta.glob<SceneModule>("./scenes/*.scene.tsx", { eager: true });

// Scenes of this installation's own skins (optional
// heim/skinScenes.tsx). Keyed by skin id.
const heimScenes = import.meta.glob<{ heimSkinScenes?: Record<string, SkinScene> }>(
  "./heim/skinScenes.tsx", { eager: true },
);

export const skinScenes: Record<string, SkinScene> = Object.assign(
  {},
  ...Object.values(productScenes).map((m) => ({ [m.skinId]: m.scene })),
  ...Object.values(heimScenes).map((m) => m.heimSkinScenes ?? {}),
);
