#!/usr/bin/env node
// Standalone smoke test for the mobile shell's pure logic — no test framework.
//
//   Run:  pnpm --filter @claraos/shell test     (or: node test/mobile.smoke.mjs)
//
// Covers the parts of ClaraOS-Mobile that are NOT testable on a real device:
//   - mobileStrategies.ts : the app -> embedding-strategy routing table
//   - Mobile/homeLayout.ts : the home-grid / dock data-model transforms
//
// Real Android gestures (pointercancel on swipe-up) and native deeplinks
// (nextcloud://, bitwarden:// ...) are inherently device-only and need a
// manual on-device pass.
//
// The REAL source files are transpiled in-memory with esbuild (already a
// transitive dependency) so this test never drifts from a hand-copied logic.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, relative, resolve } from "node:path";
// vite (a declared devDependency) ships Oxc's transform, so no extra dependency
// is needed to strip the TS types from the real source files. (Vite 8 dropped
// the bundled esbuild behind transformWithEsbuild.)
import { transformWithOxc } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel) => resolve(here, "..", "src", rel);

// Transpile a real .ts source (strips `import type`, type annotations) and
// import it as an in-memory ES module via a base64 data: URL.
// Eager `import.meta.glob("<file>", { eager: true })` (this installation's
// optional extension files) is resolved like Vite does: the file is loaded when
// it exists, otherwise the glob is empty.
globalThis.__smokeGlobs = {};
const CORE_STUB = "data:text/javascript;base64," + Buffer.from(
  'export const getBrand = () => ({ product: "NolaniOS", assistant: "Nolani" });',
).toString("base64");
let globCount = 0;
async function loadTs(relPath) {
  const code = readFileSync(src(relPath), "utf8");
  let { code: js } = await transformWithOxc(code, src(relPath));
  const globRe = /import\.meta\.glob\(\s*["']([^"'*]+)["']\s*,\s*\{\s*eager:\s*true\s*\}\s*\)/g;
  for (const m of [...js.matchAll(globRe)]) {
    const target = resolve(dirname(src(relPath)), m[1]);
    const key = `g${globCount++}`;
    globalThis.__smokeGlobs[key] = existsSync(target) ? { [m[1]]: await loadTs(relative(src(""), target)) } : {};
    js = js.replace(m[0], `globalThis.__smokeGlobs[${JSON.stringify(key)}]`);
  }
  // A data: URL cannot resolve bare package names; the brand getter is the only
  // runtime import from @claraos/core these modules use.
  js = js.replaceAll(/(["'])@claraos\/core\1/g, JSON.stringify(CORE_STUB));
  const url = "data:text/javascript;base64," + Buffer.from(js).toString("base64");
  return import(url);
}

// --- tiny assert harness ---
let pass = 0, fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function t(name, got, want) {
  if (eq(got, want)) { pass++; }
  else { fail++; console.log("  FAIL", name, "\n     got ", JSON.stringify(got), "\n     want", JSON.stringify(want)); }
}
function ok(name, cond) { cond ? pass++ : (fail++, console.log("  FAIL", name)); }

// localStorage shim (homeLayout uses it inside load/save/migrate)
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const S = await loadTs("apps/mobileStrategies.ts");
const H = await loadTs("Mobile/homeLayout.ts");

console.log("--- mobileStrategies: app -> strategy routing ---");
const rs = (m) => S.resolveMobileStrategy(m);
// No built-in "choice" list anymore — everything opens inline in ClaraOS by default
t("nextcloud -> iframe (kein choice mehr)", rs({ id: "nextcloud" }), { strategy: "iframe" });
t("immich -> iframe (kein choice mehr)", rs({ id: "immich" }), { strategy: "iframe" });
t("element -> iframe (kein choice mehr)", rs({ id: "element" }), { strategy: "iframe" });
t("vaultwarden -> iframe (kein choice mehr)", rs({ id: "vaultwarden" }), { strategy: "iframe" });
t("paperless -> iframe (default)", rs({ id: "paperless" }), { strategy: "iframe" });
t("backend override wins", rs({ id: "nextcloud", mobileStrategy: "redirect" }), { strategy: "redirect", scheme: undefined });
t("backend kann choice reaktivieren", rs({ id: "nextcloud", mobileStrategy: "choice", deeplinkScheme: "nextcloud://" }), { strategy: "choice", scheme: "nextcloud://" });
t("backend override deeplink+scheme", rs({ id: "foo", mobileStrategy: "deeplink", deeplinkScheme: "foo://x" }), { strategy: "deeplink", scheme: "foo://x" });
t("selkies-browser (type selkies) -> iframe-Default (MobileShell routet selbst zum Mobile-Zwilling)", rs({ id: "selkies-browser", type: "selkies" }), { strategy: "iframe" });
t("selkies + explizit redirect -> Tab-Ausbruch pro App erzwingbar", rs({ id: "selkies-browser", type: "selkies", mobileStrategy: "redirect" }), { strategy: "redirect", scheme: undefined });

console.log("--- homeLayout: grid/dock transforms ---");
const L0 = { pages: [new Array(20).fill(null)], dock: [] };
let l = H.placeOnGrid(L0, "a", 0, 5);
ok("placeOnGrid sets cell", l.pages[0][5] === "a");
ok("placeOnGrid immutable (L0 untouched)", L0.pages[0][5] === null);
let l2 = H.placeOnGrid(l, "b", 0, 5);
ok("occupant displaced from cell5", l2.pages[0][5] === "b");
ok("occupant 'a' relocated to a free cell", l2.pages[0].includes("a") && l2.pages[0].indexOf("a") !== 5);
let l3 = H.placeOnGrid(l2, "a", 0, 0);
ok("no duplicate appId after move", l3.pages.flat().filter((x) => x === "a").length === 1);
let l4 = H.placeOnGrid(L0, "z", 2, 0);
ok("auto-creates pages up to idx2", l4.pages.length === 3 && l4.pages[2][0] === "z");
let d = H.addToDock(l, "a");
ok("addToDock moves 'a' into dock", d.dock.includes("a"));
ok("addToDock removed 'a' from grid", !d.pages.flat().includes("a"));
let d2 = H.addToDock(d, "a");
ok("addToDock dedup (still one)", d2.dock.filter((x) => x === "a").length === 1);
const full = { pages: [new Array(20).fill(null)], dock: ["1", "2", "3", "4"] };
ok("dock full -> no-op same ref", H.addToDock(full, "5") === full);
const multi = { pages: [Object.assign(new Array(20).fill(null), { 0: "x" }), new Array(20).fill(null)], dock: [] };
const rm = H.removeFromHome(multi, "x");
ok("removeFromHome removed 'x'", !rm.pages.flat().includes("x"));
ok("removeFromHome trims trailing empty (keep >=1)", rm.pages.length === 1);
const neLast = { pages: [Object.assign(new Array(20).fill(null), { 0: "x" })], dock: [] };
const wt = H.withTrailingEmptyPage(neLast);
ok("adds empty page when last non-empty", wt.pages.length === 2 && wt.pages[1].every((c) => c === null));
const emLast = { pages: [new Array(20).fill(null)], dock: [] };
ok("no-op when last already empty", H.withTrailingEmptyPage(emLast) === emLast);
ok("isOnHome grid", H.isOnHome(l, "a") === true);
ok("isOnHome dock", H.isOnHome(d, "a") === true);
ok("isOnHome false", H.isOnHome(L0, "a") === false);
const def = H.loadHomeLayout();
ok("default layout dock has 3 (Clara button = column 1)", Array.isArray(def.dock) && def.dock.length === 3);
ok("default dock = talk/mail/selkies",
  eq(def.dock, ["nextcloud-talk", "bulwark-mail", "selkies-browser"]));
ok("default dock has no dead 'clara' id", !def.dock.includes("clara"));
ok("default page1 has open-webui (page0 = widgets)", def.pages[1].includes("open-webui"));
store["claraos.mobile.workspaces"] = JSON.stringify({ main: ["immich", "paperless", "element", "files", "post"] });
delete store["claraos.mobile.homeLayout.v2"];
const mig = H.loadHomeLayout();
ok("migrate: dock = first 3 pins", eq(mig.dock, ["immich", "paperless", "element"]));
ok("migrate: rest placed on grid", mig.pages.flat().includes("post"));
// dock slot drag & drop (addToDockAt): reorder, insert, swap-with-displacement
{
  const base = { pages: [[...Array(20)].map(() => null)], dock: ["a", "b", "c"], widgets: [] };
  const re = H.addToDockAt(base, "c", 0);
  ok("dockAt: reorder within dock", eq(re.dock, ["c", "a", "b"]));
  const partial = { ...base, dock: ["a", "b"] };
  ok("dockAt: insert into free slot", eq(H.addToDockAt(partial, "x", 1).dock, ["a", "x", "b"]));
  const full = H.addToDockAt(base, "x", 1);
  ok("dockAt: swap on full dock", eq(full.dock, ["a", "x", "c"]));
  ok("dockAt: displaced app lands on grid", full.pages.flat().includes("b"));
}

console.log("--- homeLayout v3: widgets ---");
const empty20 = () => new Array(20).fill(null);
const W0 = { pages: [empty20()], dock: [], widgets: [] };

// addWidget: requested rect + immutability
let wA = H.addWidget(W0, "flip-clock-weather", 4, 2, { page: 0, col: 0, row: 0 });
ok("addWidget places at requested rect",
  wA.widgets.length === 1 && wA.widgets[0].col === 0 && wA.widgets[0].row === 0
  && wA.widgets[0].w === 4 && wA.widgets[0].h === 2 && wA.widgets[0].page === 0);
ok("addWidget immutable (W0 untouched)", W0.widgets.length === 0);
ok("addWidget generates unique ids",
  H.addWidget(wA, "nc-tasks", 4, 2).widgets.every((w, i, a) => a.findIndex((x) => x.id === w.id) === i));

// addWidget: occupied target -> first free rect (below the existing widget)
let wB = H.addWidget(wA, "calendar-agenda", 4, 2, { page: 0, col: 0, row: 1 });
ok("addWidget occupied -> relocates to first free rect",
  wB.widgets[1].row === 2 && wB.widgets[1].col === 0);

// addWidget: page full of icons -> lands on a new page
const iconFull = { pages: [new Array(20).fill("x")], dock: [], widgets: [] };
let wC = H.addWidget(iconFull, "nc-tasks", 4, 2);
ok("addWidget full page -> new page", wC.pages.length === 2 && wC.widgets[0].page === 1);

// canPlaceWidget
ok("canPlaceWidget: out of bounds w", H.canPlaceWidget(W0, 0, 2, 0, 4, 2) === false);
ok("canPlaceWidget: out of bounds h", H.canPlaceWidget(W0, 0, 0, 4, 4, 2) === false);
ok("canPlaceWidget: overlap widget", H.canPlaceWidget(wA, 0, 0, 1, 4, 2) === false);
ok("canPlaceWidget: ignoreId self", H.canPlaceWidget(wA, 0, 0, 1, 4, 2, wA.widgets[0].id) === true);
const iconAt5 = { pages: [Object.assign(empty20(), { 5: "x" })], dock: [], widgets: [] };
ok("canPlaceWidget: overlap icon cell", H.canPlaceWidget(iconAt5, 0, 0, 1, 4, 2) === false);

// moveWidget
const mvOk = H.moveWidget(wA, wA.widgets[0].id, 0, 0, 3);
ok("moveWidget valid updates pos", mvOk !== wA && mvOk.widgets[0].row === 3);
const mvBad = H.moveWidget(wB, wB.widgets[0].id, 0, 0, 1); // would overlap agenda
ok("moveWidget invalid -> same ref (snap back)", mvBad === wB);
const mvClamp = H.moveWidget(wA, wA.widgets[0].id, 0, 3, 9); // clamps into grid
ok("moveWidget clamps to bounds", mvClamp.widgets[0].col === 0 && mvClamp.widgets[0].row === 3);

// moveWidgetDisplacing: free target behaves like moveWidget
const mdFree = H.moveWidgetDisplacing(wA, wA.widgets[0].id, 0, 0, 3);
ok("moveWidgetDisplacing free target moves", mdFree.widgets[0].row === 3);
// occupied target: blocker (agenda rows 2-3) makes way for the dragged widget
const mdDisp = H.moveWidgetDisplacing(wB, wB.widgets[0].id, 0, 0, 2);
const mdMoved = mdDisp.widgets.find((w) => w.id === wB.widgets[0].id);
const mdBlk = mdDisp.widgets.find((w) => w.id === wB.widgets[1].id);
ok("moveWidgetDisplacing anchors dragged widget", mdMoved.page === 0 && mdMoved.row === 2);
ok("moveWidgetDisplacing relocates blocker without overlap",
  !(mdBlk.page === 0 && mdBlk.row < 4 && mdBlk.row + mdBlk.h > 2)
  && H.canPlaceWidget(mdDisp, mdBlk.page, mdBlk.col, mdBlk.row, mdBlk.w, mdBlk.h, mdBlk.id));
// covered icons are displaced to a free cell NOT under a widget
const iconTop = { pages: [Object.assign(empty20(), { 0: "x" })], dock: [],
  widgets: [{ id: "wq", type: "nc-tasks", page: 0, col: 0, row: 3, w: 4, h: 2 }] };
const mdIcon = H.moveWidgetDisplacing(iconTop, "wq", 0, 0, 0);
const iconCell = mdIcon.pages[0].findIndex((c) => c === "x");
ok("moveWidgetDisplacing displaces covered icon to widget-free cell",
  mdIcon.widgets[0].row === 0 && iconCell >= 8 && iconCell < 20);

// addWidget onto a not-yet-existing page creates the page
const wNewPage = H.addWidget(W0, "nc-tasks", 4, 2, { page: 1, col: 0, row: 0 });
ok("addWidget creates missing pages", wNewPage.pages.length === 2 && wNewPage.widgets[0].page === 1);

// removeWidget trims a widget-only trailing page
const twoPages = { pages: [empty20(), empty20()], dock: [],
  widgets: [{ id: "wz", type: "nc-tasks", page: 1, col: 0, row: 0, w: 4, h: 2 }] };
const rmW = H.removeWidget(twoPages, "wz");
ok("removeWidget removes + trims trailing page", rmW.widgets.length === 0 && rmW.pages.length === 1);

// removeFromHome must NOT trim a trailing page that still holds a widget
const iconP0widgetP1 = { pages: [Object.assign(empty20(), { 0: "x" }), empty20()], dock: [],
  widgets: [{ id: "wy", type: "nc-tasks", page: 1, col: 0, row: 0, w: 4, h: 2 }] };
const rmIcon = H.removeFromHome(iconP0widgetP1, "x");
ok("removeFromHome keeps widget page", rmIcon.pages.length === 2 && rmIcon.widgets.length === 1);

// withTrailingEmptyPage counts widgets as usage
const widgetOnlyLast = { pages: [empty20()], dock: [],
  widgets: [{ id: "ww", type: "nc-tasks", page: 0, col: 0, row: 0, w: 4, h: 2 }] };
const wtW = H.withTrailingEmptyPage(widgetOnlyLast);
ok("withTrailingEmptyPage adds page after widget-only page", wtW.pages.length === 2);

// placeOnGrid: icon drop onto widget-covered cell rejected (same ref);
// occupant relocation skips widget-covered cells
const wIcons = { pages: [Object.assign(empty20(), { 8: "a" })], dock: [],
  widgets: [{ id: "wv", type: "flip-clock-weather", page: 0, col: 0, row: 0, w: 4, h: 2 }] };
ok("placeOnGrid rejected on widget cell", H.placeOnGrid(wIcons, "b", 0, 2) === wIcons);
const disp = H.placeOnGrid(wIcons, "b", 0, 8);
ok("displaced occupant skips widget-covered cells",
  disp.pages[0][8] === "b" && disp.pages[0].indexOf("a") >= 8);

// legacy-shape tolerance: pre-v3 {pages,dock} objects don't crash transforms
const legacyShape = { pages: [empty20()], dock: [] };
ok("transforms tolerate missing widgets field",
  H.placeOnGrid(legacyShape, "a", 0, 0).widgets.length === 0
  && H.withTrailingEmptyPage(legacyShape) === legacyShape);

const clearLayout = () => ["v2", "v3", "v4", "workspaces"].forEach((k) => delete store[`claraos.mobile.${k === "workspaces" ? "workspaces" : "homeLayout." + k}`]);

// v2 -> v4 migration, branch 1: all rows free -> both default widgets (clock 4x3)
clearLayout();
const v2FreeTop = { pages: [Object.assign(empty20(), { 16: "immich", 17: "paperless" })], dock: ["a", "b"] };
// note: icons in row 4 mean rows 0-4 are NOT all free -> only clock fits
const v2AllFree = { pages: [empty20()], dock: ["a", "b"] };
store["claraos.mobile.homeLayout.v2"] = JSON.stringify(v2AllFree);
const mg1 = H.loadHomeLayout();
ok("v2->v4: all rows free -> 2 default widgets",
  mg1.widgets.length === 2 && mg1.widgets.some((w) => w.type === "flip-clock-weather")
  && mg1.widgets.some((w) => w.type === "calendar-agenda"));
ok("v2->v4: clock widget is 4x3", mg1.widgets.find((w) => w.type === "flip-clock-weather").h === 3);
ok("v2->v4: dock preserved", eq(mg1.dock, v2AllFree.dock));
ok("v2->v4: v2 key kept as rollback", store["claraos.mobile.homeLayout.v2"] === JSON.stringify(v2AllFree));
ok("v2->v4: saved under v4 key", !!store["claraos.mobile.homeLayout.v4"]);

// branch 2: top rows occupied -> no widgets, icons untouched
clearLayout();
store["claraos.mobile.homeLayout.v2"] = JSON.stringify({ pages: [Object.assign(empty20(), { 0: "immich" })], dock: [] });
const mg2 = H.loadHomeLayout();
ok("v2->v4: occupied top rows -> no widgets", mg2.widgets.length === 0);
ok("v2->v4: icons preserved", mg2.pages[0][0] === "immich");

// branch 3: only rows 0-2 free -> clock widget only
clearLayout();
store["claraos.mobile.homeLayout.v2"] = JSON.stringify({ pages: [Object.assign(empty20(), { 12: "immich" })], dock: [] });
const mg3 = H.loadHomeLayout();
ok("v2->v4: rows 0-2 free -> clock only",
  mg3.widgets.length === 1 && mg3.widgets[0].type === "flip-clock-weather");

// v3 -> v4 migration: clock grows to 4x3, icons move to page 1+, dock preserved
clearLayout();
store["claraos.mobile.homeLayout.v3"] = JSON.stringify({
  pages: [Object.assign(empty20(), { 16: "open-webui", 17: "nextcloud" })],
  dock: ["nextcloud-talk", "settings"],
  widgets: [{ id: "w-clock-0", type: "flip-clock-weather", page: 0, col: 0, row: 0, w: 4, h: 2 }],
});
const mg4 = H.loadHomeLayout();
ok("v3->v4: clock now 4x3", mg4.widgets.find((w) => w.type === "flip-clock-weather")?.h === 3);
ok("v3->v4: agenda added", mg4.widgets.some((w) => w.type === "calendar-agenda"));
ok("v3->v4: page 0 has no icons", mg4.pages[0].every((c) => c === null));
ok("v3->v4: icons moved to page 1+", mg4.pages[1].includes("open-webui") && mg4.pages[1].includes("nextcloud"));
ok("v3->v4: dock preserved", eq(mg4.dock, ["nextcloud-talk", "settings"]));

// v4 sanitize drops malformed widgets, keeps good ones
clearLayout();
store["claraos.mobile.homeLayout.v4"] = JSON.stringify({
  pages: [empty20()], dock: [],
  widgets: [
    { id: "good", type: "nc-tasks", page: 0, col: 0, row: 0, w: 4, h: 2 },
    { id: "oob", type: "nc-tasks", page: 0, col: 9, row: 0, w: 4, h: 2 },
    { id: "overlap", type: "nc-tasks", page: 0, col: 0, row: 1, w: 4, h: 2 },
    { type: "no-id", page: 0, col: 0, row: 3, w: 2, h: 1 },
    "garbage",
  ],
});
const san = H.loadHomeLayout();
ok("v4 sanitize keeps only valid widgets", san.widgets.length === 1 && san.widgets[0].id === "good");

// fresh default: page 0 = clock 4x3 + agenda 4x2, all icons on page 1
clearLayout();
const fresh = H.loadHomeLayout();
ok("fresh default: 2 widgets on page 0",
  fresh.widgets.length === 2 && fresh.widgets.every((w) => w.page === 0));
ok("fresh default: clock 4x3 + agenda 4x2",
  fresh.widgets.find((w) => w.type === "flip-clock-weather").h === 3
  && fresh.widgets.find((w) => w.type === "calendar-agenda").h === 2);
ok("fresh default: page 0 icon-free", fresh.pages[0].every((c) => c === null));
ok("fresh default: icons on page 1", fresh.pages[1][0] === "open-webui" && fresh.pages[1].includes("immich"));

// --- toolAppMap: Clara tool call -> app id (cobrowse auto-trigger) ---
console.log("--- toolAppMap: tool -> app routing ---");
const T = await loadTs("Chat/toolAppMap.ts");
t("immich API tool", T.appIdForTool("immich_add_assets_to_album"), "immich");
t("paperless tool", T.appIdForTool("paperless_search_documents"), "paperless");
t("bridged module tool", T.appIdForTool("claraos_modules_media_immich__search"), "immich");
t("bridged module tool (dash-domain ok)", T.appIdForTool("claraos_modules_office_paperless-ngx__list_documents"), "paperless-ngx");
t("meta server nie gemappt", T.appIdForTool("claraos_action_navigate_to"), null);
t("memory nie gemappt", T.appIdForTool("memory_search"), null);
t("meta_platform nie gemappt", T.appIdForTool("meta_platform_meta_run_task"), null);
t("undefined tool", T.appIdForTool(undefined), null);

// --- fileItemMenu: print ---
// The menu item may ONLY appear when a printer exists (onPrint set) and the
// target is a file — for folders it would make no sense.
console.log("--- fileItemMenu: Drucken-Eintrag ---");
const FM = await loadTs("apps/file-browser/fileItemMenu.ts");
const baseCtx = {
  variant: "mobile", defaultApp: null,
  onOpen() {}, onOpenWith() {}, onDownload() {}, onArchive() {}, onExtract() {},
  onEncrypt() {}, onCopy() {}, onCut() {}, onRename() {}, onDelete() {}, onProperties() {},
};
const file = { name: "brief.pdf", path: "/brief.pdf", isDir: false };
const folder = { name: "Ordner", path: "/Ordner", isDir: true };
// Rarely used items live under "Weitere Aktionen" (More actions) — include submenus
const flach = (items) => items.flatMap((i) => [i, ...(i.submenu ? flach(i.submenu) : [])]);
const ids = (node, ctx) => flach(FM.buildFileItemMenu(node, ctx)).map((i) => i.id);

ok("ohne Drucker kein Eintrag", !ids(file, baseCtx).includes("print"));
ok("mit Drucker: Eintrag bei Datei",
   ids(file, { ...baseCtx, onPrint() {} }).includes("print"));
ok("mit Drucker: KEIN Eintrag bei Ordner",
   !ids(folder, { ...baseCtx, onPrint() {} }).includes("print"));
ok("Eintrag steht vor dem Archivieren",
   (() => { const l = ids(file, { ...baseCtx, onPrint() {} });
            return l.indexOf("print") < l.indexOf("archive"); })());

// Checks for this installation's own apps (optional test/heim/).
const heimTest = resolve(here, "heim", "mobile.smoke.mjs");
if (existsSync(heimTest)) {
  const { run } = await import(pathToFileURL(heimTest).href);
  await run({ loadTs, t, ok, eq, store, S, H, T });
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
