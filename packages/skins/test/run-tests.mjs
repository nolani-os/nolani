/**
 * Test runner for the skins unit tests.
 *
 * Transpiles the TS source with esbuild (already in the tree via vite) and
 * loads it as an ES module — so the tests need neither Vitest nor a build.
 *
 *   node packages/skins/test/run-tests.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadEsbuild() {
  const candidates = ["esbuild", join(here, "../../../node_modules/esbuild")];
  // pnpm does not hoist esbuild — search the .pnpm store as well.
  try {
    const store = join(here, "../../../node_modules/.pnpm");
    for (const entry of readdirSync(store)) {
      if (entry.startsWith("esbuild@")) {
        candidates.push(join(store, entry, "node_modules/esbuild"));
      }
    }
  } catch {
    /* no store — fall back to the candidates above */
  }
  for (const p of candidates) {
    try {
      return require(p);
    } catch {
      /* next candidate */
    }
  }
  console.error("esbuild nicht gefunden — im Repo-Root `pnpm install` laufen lassen.");
  process.exit(2);
}

const esbuild = loadEsbuild();
const src = readFileSync(join(here, "../src/accent.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const dir = mkdtempSync(join(tmpdir(), "claraos-skins-test-"));
const file = join(dir, "accent.mjs");
writeFileSync(file, js);

const mod = await import(pathToFileURL(file).href);
const { runAccentTests } = await import(pathToFileURL(join(here, "accent.test.mjs")).href);

const results = runAccentTests(mod);
let failed = 0;
for (const [status, name] of results) {
  if (status === "ok") {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}
console.log(`\nskins: ${results.length - failed} ok, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
