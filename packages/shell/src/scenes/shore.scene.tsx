/**
 * Shore: waves rolling onto a sandy beach, sun and moon glitter on the water.
 * Loaded by `skinScenes.ts`; the heavy part (WebGL + video) is its own chunk.
 */
import { lazy } from "react";
import { shoreSceneAssets } from "@claraos/skins";
import type { SkinScene } from "../skinScenes";

export const skinId = "shore";

const Scene = lazy(() =>
  import("./livingPhoto/LivingPhotoScene").then((m) => ({
    default: () => <m.LivingPhotoScene {...shoreSceneAssets} video="/scenes/shore" kind="shore" />,
  })),
);

export const scene: SkinScene = { Scene };
