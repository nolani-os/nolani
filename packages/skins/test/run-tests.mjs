/**
 * Test runner for the skins unit tests.
 *
 * Transpiles the TS sources with esbuild (already in the tree via vite) and
 * loads them as ES modules — so the tests need neither Vitest nor a build.
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
const dir = mkdtempSync(join(tmpdir(), "claraos-skins-test-"));

/** Transpile one dependency-free TS source file and import it. */
async function loadTs(name) {
  const src = readFileSync(join(here, `../src/${name}.ts`), "utf8");
  const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

/** Bundle a TS source with its relative imports (no assets) and import it. */
async function loadTsBundle(name) {
  const result = esbuild.buildSync({
    entryPoints: [join(here, `../src/${name}.ts`)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    // Type-only imports of @claraos/core vanish in the transpile; mark it
    // external so esbuild does not try to resolve the workspace package.
    external: ["@claraos/core"],
  });
  const file = join(dir, `${name.replace(/\//g, "_")}.mjs`);
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

// [source module, test module, exported runner, loader]
const SUITES = [
  ["accent", "accent.test.mjs", "runAccentTests", loadTs],
  ["sun", "sun.test.mjs", "runSunTests", loadTs],
  ["corporate/createCorporateSkin", "corporate.test.mjs", "runCorporateTests", loadTsBundle],
];

let total = 0;
let failed = 0;
for (const [source, testFile, runner, load] of SUITES) {
  const mod = await load(source);
  const tests = await import(pathToFileURL(join(here, testFile)).href);
  const results = tests[runner](mod);
  console.log(`\n${source}:`);
  for (const [status, name] of results) {
    total++;
    if (status === "ok") {
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.log(`  ✗ ${name}`);
    }
  }
}
console.log(`\nskins: ${total - failed} ok, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
