// Shore — waves rolling onto a sandy beach; sun and moon glitter on the water.
// The motion is a seamless video loop served from /scenes/shore.{mp4,webm}
// (shell/public), the poster and the sky/cloud mask ship with the skin.
import posterUrl from "./poster.jpg";
import maskUrl from "./mask.png";
import { livingPhotoSkin } from "../livingPhotoChrome";

export const shoreSceneAssets = {
  poster: posterUrl,
  mask: maskUrl,
  /** Horizon of the first video frame as a fraction of the height (the sea is blue too, so this is set by hand). */
  horizon: 0.289,
};

export const shoreSkin = livingPhotoSkin(
  "shore",
  "Shore",
  posterUrl,
  "linear-gradient(180deg, #7fb6e6 0%, #cfe6f6 28%, #2aa6c0 29%, #e9dcc4 70%, #d9c9ab 100%)",
  // sea teal
  { accent: "#3FC8D2", accentHover: "#7EDCE3", accentRgb: "63, 200, 210", rimRgb: "190, 235, 240" },
);
