/**
 * Test runner for the core unit tests.
 *
 * Transpiles the TS sources with esbuild (already in the tree via vite) and
 * loads them as ES modules — so the tests need neither Vitest nor a build.
 *
 *   node packages/core/test/run-tests.mjs
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
    /* no store — then the candidates above apply */
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
const dir = mkdtempSync(join(tmpdir(), "claraos-core-test-"));

async function load(relSrc) {
  const src = readFileSync(join(here, "..", relSrc), "utf8");
  const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
  const file = join(dir, relSrc.replace(/[\/]/g, "_").replace(/\.ts$/, ".mjs"));
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

const SUITES = [
  ["src/terminal/pasteGuard.ts", "pasteGuard.test.mjs", "runPasteGuardTests"],
  ["src/format.ts", "format.test.mjs", "runFormatTests"],
  ["src/notifications/policy.ts", "policy.test.mjs", "runPolicyTests"],
  ["src/shortcuts/registry.ts", "shortcuts.test.mjs", "runShortcutTests"],
  ["src/i18n/languages.ts", "languages.test.mjs", "runLanguageTests"],
];

let failed = 0;
let total = 0;
for (const [srcPath, testFile, exportName] of SUITES) {
  const mod = await load(srcPath);
  const suite = await import(pathToFileURL(join(here, testFile)).href);
  const results = suite[exportName](mod);
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
console.log(`\ncore: ${total - failed} ok, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
