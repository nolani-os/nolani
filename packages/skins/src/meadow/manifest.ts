// Meadow — wildflower meadow in a steady breeze; the sky follows the real sun.
// The motion is a seamless video loop served from /scenes/meadow.{mp4,webm}
// (shell/public), the poster and the sky/cloud mask ship with the skin.
import posterUrl from "./poster.jpg";
import maskUrl from "./mask.png";
import { livingPhotoSkin } from "../livingPhotoChrome";

export const meadowSceneAssets = {
  poster: posterUrl,
  mask: maskUrl,
  /** Horizon of the first video frame as a fraction of the height (measured by the mask tool). */
  horizon: 0.272,
};

export const meadowSkin = livingPhotoSkin(
  "meadow",
  "Meadow",
  posterUrl,
  "linear-gradient(180deg, #5f9fd6 0%, #a9d0ee 27%, #6d9a3a 28%, #3f6b2a 100%)",
  // sunlit amber — reads on the dark glass and against the green ground
  { accent: "#F2B544", accentHover: "#F7CB6E", accentRgb: "242, 181, 68", rimRgb: "255, 228, 170" },
);
