#!/usr/bin/env node
// Smoke test for the dock's pure parts — no test framework, no browser.
//   Run:  node test/dock.smoke.mjs
// Covers Dock/magnify.ts: the icon-scale curve under the pointer. The
// surfaces themselves (MenuBar, Dock) are React + DOM and are checked in the
// running shell.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { transformWithOxc } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "src", "Dock", "magnify.ts");
const { code } = await transformWithOxc(readFileSync(src, "utf8"), src, { loader: "ts" });
const { magnification, MAGNIFY_MAX, MAGNIFY_REACH } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) failed++; };

check("under the pointer the icon is at its maximum", Math.abs(magnification(0) - MAGNIFY_MAX) < 1e-9);
check("at the reach the icon is back to 1", Math.abs(magnification(MAGNIFY_REACH) - 1) < 1e-9);
check("beyond the reach it stays at 1", magnification(MAGNIFY_REACH * 3) === 1);
check("symmetric left/right", magnification(-40) === magnification(40));
check("monotonic falloff", [0, 20, 40, 60, 80, 100].map(magnification).every((v, i, a) => i === 0 || v < a[i - 1]));
check("halfway is halfway (cosine bell)", Math.abs(magnification(MAGNIFY_REACH / 2) - (1 + (MAGNIFY_MAX - 1) / 2)) < 1e-9);

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("dock smoke: all green");
