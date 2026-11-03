/**
 * Meadow: wildflower meadow in a steady breeze, sky after the real sun.
 * Loaded by `skinScenes.ts`; the heavy part (WebGL + video) is its own chunk.
 */
import { lazy } from "react";
import { meadowSceneAssets } from "@claraos/skins";
import type { SkinScene } from "../skinScenes";

export const skinId = "meadow";

const Scene = lazy(() =>
  import("./livingPhoto/LivingPhotoScene").then((m) => ({
    default: () => <m.LivingPhotoScene {...meadowSceneAssets} video="/scenes/meadow" kind="meadow" />,
  })),
);

export const scene: SkinScene = { Scene };
