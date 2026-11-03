/**
 * Harness for the living-photo scenes: renders one scene full-screen at a
 * fixed moment (`?scene=meadow|shore&t=HH:MM&date=YYYY-MM-DD`) so the sky,
 * sun, moon and relighting can be checked by eye and by screenshot — without
 * the shell, the API or a login. `useSunState` is replaced by the stub in
 * ./sunStub.ts through the Vite alias in vite.config.mjs.
 */
import { createRoot } from "react-dom/client";
import { LivingPhotoScene } from "../../src/scenes/livingPhoto/LivingPhotoScene";
import { meadowSceneAssets, shoreSceneAssets } from "@claraos/skins";
import { sunState } from "@claraos/skins";
import { fixedMoment, LAT, LON } from "./sunStub";

const q = new URLSearchParams(location.search);
const scene = q.get("scene") === "shore" ? "shore" : "meadow";
const assets = scene === "shore" ? shoreSceneAssets : meadowSceneAssets;
const at = fixedMoment();
const s = sunState(at, LAT, LON);
document.getElementById("hud")!.textContent =
  `${scene} · ${at.toLocaleString("de-DE")} · ${s.phase} · Sonne ${s.altitude.toFixed(1)}° / ${s.azimuth.toFixed(0)}° · Mond ${s.moonPhase.toFixed(2)}`;

createRoot(document.getElementById("stage")!).render(
  <LivingPhotoScene {...assets} video={`/scenes/${scene}`} kind={scene} />,
);
