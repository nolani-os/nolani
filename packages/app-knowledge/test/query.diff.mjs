// Differential test: src/local/query.ts against the server's real query
// compiler (packages/api/services/kb_query.py) running on PostgreSQL.
//
// Run (needs docker, python3 with asyncpg, node 20; no network ports are
// published, the test talks to the container over the docker bridge):
//
//   node packages/app-knowledge/test/query.diff.mjs        (from projects/claraos)
//
// It starts a throwaway `postgres:17-alpine` container named
// `kbquery-difftest-<random>`, loads a generated dataset into a minimal
// `claraos_kb_objects` table, runs every case through the Python compiler +
// asyncpg (query.diff.pg.py) and through query.ts, compares ordered id lists,
// aggregate values and errors, and removes the container again. Exit code 0
// means zero mismatches.
//
// Env: KBQ_IMAGE (default postgres:17-alpine), KBQ_VERBOSE=1 prints every case.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const CLARAOS = resolve(APP, "../..");
const API_DIR = join(CLARAOS, "packages/api");
const IMAGE = process.env.KBQ_IMAGE || "postgres:17-alpine";
const VERBOSE = process.env.KBQ_VERBOSE === "1";

// --- load query.ts through esbuild -----------------------------------------
function findEsbuild() {
  const pnpm = join(CLARAOS, "node_modules/.pnpm");
  const dir = readdirSync(pnpm).filter((d) => /^esbuild@\d/.test(d)).sort().pop();
  if (!dir) throw new Error("esbuild not found under " + pnpm);
  return createRequire(import.meta.url)(join(pnpm, dir, "node_modules/esbuild"));
}

const work = mkdtempSync(join(tmpdir(), "kbquery-difftest-"));
const esbuild = findEsbuild();
const src = readFileSync(join(APP, "src/local/query.ts"), "utf8");
writeFileSync(join(work, "query.mjs"),
  esbuild.transformSync(src, { loader: "ts", format: "esm", target: "node20" }).code);
const Q = await import(pathToFileURL(join(work, "query.mjs")).href);

// --- dataset -----------------------------------------------------------------
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261101);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const NOW = new Date();
const isoDay = (offset) => new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(),
  NOW.getUTCDate() + offset)).toISOString().slice(0, 10);

const FIELDS = {
  name: Q.FT_TEXT, url: Q.FT_URL, num: Q.FT_NUMBER, rollup: Q.FT_ROLLUP,
  due: Q.FT_DATE, ctime: Q.FT_CREATED_TIME, utime: Q.FT_UPDATED_TIME,
  status: Q.FT_SELECT, tags: Q.FT_MULTI_SELECT, done: Q.FT_CHECKBOX, todo: Q.FT_CHECKLIST,
  files: Q.FT_MEDIA, owner: Q.FT_PERSON, rel: Q.FT_RELATION, calc: Q.FT_FORMULA,
  "bad key!": Q.FT_TEXT, "nl\n": Q.FT_TEXT, odd: 99,
};

const TEXTS = ["Apfel", "apfel", "Äpfel", "äpfel", "APFEL", "Zebra", "zebra", "Øl", "ß", "SS",
  "straße", "STRASSE", "İstanbul", "istanbul", "Ⓐbc", "ⓐbc", "", " ", "a%b", "a_b",
  "back\\slash", "100%", "😀 emoji", "Ｆull", "naïve", "NAÏVE", 42, 3.5, true, false, null,
  ["x", "y"], { b: 1, a: [1, "z"], aa: null }, "Ünïcödé", "Ελλάδα", "ΣΊΣΥΦΟΣ", "tab\there",
  "line\nbreak", 'quote"d', "ab", "abc", "abc\\", "None", "True", "\u0001ctl", "", "x",
  "Ａ", "", "😀", "Ab", "aB", "1e3", 1e-7, 1e21];
const NUMS = [1, 2, 2.5, -3, 0, "007", "7", "7.0", 7, "1e3", " 5", "5 ", "-0", "-0.5", ".5", "5.",
  1e-7, 1.5e-7, 1e21, 123456789012345680000, 0.1, "0.1", 0.30000000000000004, "abc", "", null,
  true, [1], "9007199254740993", "12345678901234567890.123456789", 1e300, -1e-300, "-12.50",
  100, 99.99, "99.990", -0.000001, 4, 4.0000001, "+4", "٤"];
const DATES = () => [isoDay(0), isoDay(-1), isoDay(1), isoDay(-7), isoDay(7), isoDay(-8), isoDay(8),
  isoDay(-30), `${isoDay(0)}T00:00:00Z`, `${isoDay(0)}T23:59:59.999Z`, `${isoDay(-1)}T23:30:00-05:00`,
  `${isoDay(1)}T00:30:00+02:00`, "2024-01-15", "2024-01-15T10:00:00Z", "2024-01-15T23:30:00-05:00",
  "2024-02-29", "2023-12-31 08:00", "2024-01-15T10:00:00.123456789Z", "2024-01-15Z",
  "2024-01-15t10:00", "2024-01-15T24:00:00", "2024-01-15T23:59:60", "2024-01-15T10:00:00+0530",
  "2024-01-15T10:00:00 +02", "2024-01-15 +02", "2024-01-15   10:00", "2024-01-15T10:00:60",
  "2024-01-15T10:00:00+15:59", "2024-01-15  ", " 2024-01-15", "15.01.2024", "2024/01/15", "",
  null, 20240115, "0001-01-01", "9999-12-31", "2024-01-14", "2024-01-16", true, ["2024-01-15"]];
const SELECTS = ["Open", "open", "Done", "In Progress", "", null, ["Open"], 5, "Ö", "done"];
const TAGS = [["a", "b"], ["b"], [], ["A"], ["a", "c", "d"], "a", null, [1, "1"], [["a"]],
  { a: true }, ["ä", "ß"], ["b", "a"], [null], ["None"], "", ["c"]];
const CHECKS = [true, false, "true", "false", "yes", 1, 0, null, "TRUE", []];
const TODOS = [{ percentage: 100 }, { percentage: "100" }, { percentage: 100.0 }, { percentage: 50 },
  {}, [], "100", null, { percentage: 100.5 }, { percentage: null }, 100, { percentage: 1e2 }];
const FILES = [[], ["f.png"], "", null, {}, ["a.pdf", "b.pdf"], "x.png"];
const OWNERS = [["u1"], ["u1", "u2"], "u2", [], null, ["u3"], { u1: 1 }];
const UUIDS = ["0f8fad5b-d9cb-469f-a165-70867728950e", "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "9a1f7a2e-3c11-4b9a-8f5c-2b5b0f4f3a10"];
const RELS = [[UUIDS[0]], [UUIDS[0], UUIDS[1]], [], [UUIDS[2]], null, "x"];

const GEN = {
  name: () => pick(TEXTS), url: () => pick(["https://a.example/x", "HTTPS://A.EXAMPLE/Y", "", "ftp://b", null]),
  num: () => pick(NUMS), rollup: () => pick(NUMS), due: () => pick(DATES()), ctime: () => pick(DATES()),
  utime: () => pick(DATES()), status: () => pick(SELECTS), tags: () => pick(TAGS),
  done: () => pick(CHECKS), todo: () => pick(TODOS), files: () => pick(FILES),
  owner: () => pick(OWNERS), rel: () => pick(RELS), calc: () => pick(TEXTS),
  "nl\n": () => pick(["nl-a", "NL-B", "", null]), odd: () => pick(TEXTS),
};

const ROWS = [];
const N_ROWS = 90;
const baseMs = Date.UTC(2026, 0, 1, 12, 0, 0);
const order = Array.from({ length: N_ROWS }, (_, i) => i).sort(() => rnd() - 0.5);
for (let i = 0; i < N_ROWS; i++) {
  const props = {};
  for (const [key, gen] of Object.entries(GEN)) {
    const r = rnd();
    if (r < 0.15) continue; // key missing
    props[key] = gen();
  }
  // Pairs of rows share the same millisecond and differ in microseconds, the
  // way server timestamps look; the others are app-style ISO strings.
  const k = order[i];
  const ms = baseMs + Math.floor(k / 2) * 3_600_000 + (k % 3) * 7;
  const iso = new Date(ms).toISOString();
  const updated = k % 2 === 0 ? iso
    : k % 4 === 1 ? iso.replace("Z", `${String(k).padStart(3, "0")}+00:00`)
      : iso.replace(/\.(\d{3})Z$/, `.$1${String(k).padStart(3, "0")}+02:00`).replace(/T(\d{2})/,
        (_, h) => `T${String((Number(h) + 2) % 24).padStart(2, "0")}`);
  const pj = JSON.stringify(props);
  ROWS.push({ id: `r${String(i).padStart(3, "0")}`, title: `Row ${i}`, created_at: iso,
    updated_at: updated, properties_json: pj, properties: JSON.parse(pj) });
}

// --- cases -------------------------------------------------------------------
const cases = [];
const add = (c) => cases.push(c);
const VALID_OPS = {
  [Q.FT_TEXT]: ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty"],
  [Q.FT_NUMBER]: ["eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"],
  [Q.FT_DATE]: ["on", "before", "after", "on_or_before", "on_or_after", "between", "is_empty", "is_not_empty"],
  [Q.FT_SELECT]: ["is", "is_not", "contains_any", "contains_all", "contains_none", "is_empty", "is_not_empty"],
};
const TEXT_VALUES = ["apfel", "ÄPFEL", "a%", "%", "_", "a_b", "\\", "\\\\", "STRASSE", "ß", "ss", "i",
  "İ", "ⓐ", "Ⓐ", "", 42, true, null, ["x", "y"], "😀", "σ", "Σ", "ς", "Ｆ", "ab", "b", "\\%", "%\\%",
  "x", "abc\\", "Ø", "ö", "1e3", "line\nbreak", "e-7"];
const NUM_VALUES = [0, 1, 2.5, 7, "7", " 7 ", "1_000", "inf", "-inf", "nan", 0.1, 0.30000000000000004,
  1e-7, 1e21, -3, true, false, "٤", 4.0000001, 99.99, "99.99", "+4", "-0", 1e300, "  -12.5\t"];
const DATE_VALUES = () => ["today", "Tomorrow", "YESTERDAY", { days_ago: 7 }, { days_from_now: 7 },
  { days_ago: true }, { days_ago: 0 }, { days_from_now: -30 }, isoDay(0), isoDay(-1), "2024-01-15",
  "2024-1-15", " 2024-01-15 ", "2024-01-15T10:00:00Z", "infinity", "-Infinity", "epoch", " Now ",
  "today ", "2024-02-29", "0001-01-01", "9999-12-31", "2023-12-31 08:00"];

const textKeys = ["name", "url", "status", "nl\n"];
for (const key of textKeys) {
  const ops = FIELDS[key] === Q.FT_SELECT ? ["is", "is_not"] : VALID_OPS[Q.FT_TEXT];
  for (const op of ops) {
    const vals = op.includes("empty") ? [null] : TEXT_VALUES;
    for (const value of vals) {
      if (key !== "name" && rnd() < 0.6) continue;
      add({ kind: "rows", filters: { key, op, value } });
    }
  }
}
for (const key of ["num", "rollup"]) {
  for (const op of VALID_OPS[Q.FT_NUMBER]) {
    for (const value of op.includes("empty") ? [null] : NUM_VALUES) {
      if (key === "rollup" && rnd() < 0.7) continue;
      add({ kind: "rows", filters: { key, op, value } });
    }
  }
}
for (const key of ["due", "ctime", "utime"]) {
  for (const op of VALID_OPS[Q.FT_DATE]) {
    if (op === "between") {
      for (const value of [["2024-01-01", "2024-12-31"], [isoDay(-7), isoDay(7)], [isoDay(7), isoDay(-7)],
        ["2024-01-15", "2024-01-15"], ["-infinity", "infinity"], ["epoch", "today"]]) {
        add({ kind: "rows", filters: { key, op, value } });
      }
      continue;
    }
    for (const value of op.includes("empty") ? [null] : DATE_VALUES()) {
      if (key !== "due" && rnd() < 0.7) continue;
      add({ kind: "rows", filters: { key, op, value } });
    }
  }
}
const MULTI_VALUES = [["a"], ["a", "b"], [], "a", ["A"], [1], ["1"], ["ä"], [null], ["None"], ["c", "x"],
  "Open", ["Open"], ["u1"], ["u2", "u3"], [UUIDS[0]], [UUIDS[2], "zzz"], 5, ["5"], ["true"]];
for (const key of ["tags", "status", "owner", "rel"]) {
  for (const op of ["contains_any", "contains_all", "contains_none"]) {
    for (const value of MULTI_VALUES) {
      if (key !== "tags" && rnd() < 0.6) continue;
      add({ kind: "rows", filters: { key, op, value } });
    }
  }
  for (const op of ["is_empty", "is_not_empty"]) add({ kind: "rows", filters: { key, op } });
}
for (const op of ["is_checked", "is_unchecked"]) add({ kind: "rows", filters: { key: "done", op } });
for (const op of ["is_complete", "is_incomplete"]) add({ kind: "rows", filters: { key: "todo", op } });
for (const key of ["files", "calc", "odd", "done", "todo"]) {
  for (const op of ["is_empty", "is_not_empty"]) add({ kind: "rows", filters: { key, op } });
}

// Errors of the compiler (messages must match byte for byte)
const ERRORS = [
  { key: "owner", op: "is", value: "u1" }, { key: "tags", op: "is", value: "a" },
  { key: "calc", op: "is", value: "x" }, { key: "odd", op: "contains", value: "x" },
  { key: "done", op: "is", value: true }, { key: "rel", op: "contains_all", value: ["a"] },
  { key: "files", op: "contains", value: "f" }, { key: "num", op: "contains", value: 1 },
  { key: "num", op: "eq", value: "abc" }, { key: "num", op: "eq", value: null },
  { key: "num", op: "eq", value: [1] }, { key: "num", op: "gt", value: "1__0" },
  { key: "num", op: "gt", value: "0x10" }, { key: "num", op: "gt", value: "" },
  { key: "due", op: "between", value: "2024-01-01" }, { key: "due", op: "between", value: ["a"] },
  { key: "bad key!", op: "is", value: "x" }, { key: "bad key!", op: "is_empty" },
  { key: "ghost", op: "is", value: "x" }, { key: "Ghöst's \"x\"", op: "is", value: "x" },
  { op: "is", value: "x" }, { key: "", op: "is" }, { key: 5, op: "is" },
  { key: "name", op: null }, { key: "name", op: 5 }, { key: "name", op: ["is"] }, { key: "name", op: "IS" },
  { key: "name", op: "eq", value: 1 }, { key: "name" }, { key: "num", op: "eq", value: { a: "b" } },
  { key: "due", op: "on", value: "2023-02-29" }, { key: "due", op: "on", value: "2024-13-01" },
  { key: "due", op: "between", value: ["2024-01-01", "0000-01-01"] },
  { key: "due", op: "after", value: { days_ago: 3000000000 } },
  { key: "due", op: "after", value: { days_from_now: 2147483647 } },
  { key: "due", op: "on", value: "2024-01-15T24:00:01" }, { key: "due", op: "on", value: "None" },
  { key: "due", op: "on", value: null }, { key: "due", op: "on", value: ["x"] },
  { key: "name", op: "ends_with", value: "abc\\" }, { key: "name", op: "is", value: "x\\" },
  { key: "name", op: "starts_with", value: "\\" }, { key: "name", op: "contains", value: "z\\" },
];
for (const f of ERRORS) add({ kind: "rows", filters: f });
add({ kind: "rows", filters: { op: "and", children: [{ key: "name", op: "is_empty" }, { key: "ghost", op: "is" }] } });
add({ kind: "rows", filters: { op: "and" } });
add({ kind: "rows", filters: { op: "or", children: "x" } });
add({ kind: "rows", filters: { op: "and", children: [] } });
add({ kind: "rows", filters: { op: "and", children: [{}, null, "x", { op: "or", children: [] }] } });
add({ kind: "rows", filters: [] });
add({ kind: "rows", filters: "x" });
add({ kind: "rows", filters: null });
add({ kind: "rows", filters: {} });
add({ kind: "rows", filters: { op: "AND", children: [] } });
let deep = { key: "name", op: "is_not_empty" };
for (let d = 0; d < 8; d++) deep = { op: d % 2 ? "and" : "or", children: [deep] };
add({ kind: "rows", filters: deep }); // leaf at depth 8: allowed
add({ kind: "rows", filters: { op: "and", children: [deep] } }); // leaf at depth 9: error
add({ kind: "rows", filters: { op: "and", children: [deep, { op: "or" }] } });

// Random trees of valid conditions
const leafPool = cases.filter((c) => c.kind === "rows" && c.filters && c.filters.key
  && !ERRORS.includes(c.filters)).map((c) => c.filters)
  .filter((f) => !(typeof f.value === "string" && /\\$/.test(f.value)));
function tree(depth) {
  if (depth > 2 || rnd() < 0.35) return pick(leafPool);
  const n = 1 + Math.floor(rnd() * 3);
  return { op: rnd() < 0.5 ? "and" : "or", children: Array.from({ length: n }, () => tree(depth + 1)) };
}
for (let i = 0; i < 80; i++) add({ kind: "rows", filters: tree(0) });

// Sorts
const sortKeys = ["name", "url", "num", "rollup", "due", "ctime", "utime", "status", "tags", "done",
  "todo", "files", "owner", "rel", "calc", "odd", "nl\n"];
for (const key of sortKeys) {
  for (const dir of ["asc", "desc"]) add({ kind: "rows", sorts: [{ key, dir }] });
}
for (let i = 0; i < 40; i++) {
  const n = 1 + Math.floor(rnd() * 3);
  add({ kind: "rows", filters: rnd() < 0.5 ? tree(1) : null,
    sorts: Array.from({ length: n }, () => ({ key: pick(sortKeys), dir: pick(["asc", "desc", "DESC", "Desc", null, 5, undefined]) })) });
}
add({ kind: "rows", sorts: [] });
add({ kind: "rows", sorts: "x" });
add({ kind: "rows", sorts: [{ key: "ghost" }, "x", null, { key: 5 }, { key: "num" }] });
add({ kind: "rows", sorts: [{ key: "bad key!" }] });
add({ kind: "rows", filters: { key: "ghost", op: "is" }, sorts: [{ key: "bad key!" }] });
add({ kind: "rows", filters: { key: "name", op: "ends_with", value: "abc\\" }, sorts: [{ key: "bad key!" }] });
add({ kind: "rows", filters: { key: "due", op: "on", value: "2023-02-29" }, sorts: [{ key: "bad key!" }] });

// Aggregates
const aggKeys = ["num", "rollup", "name", "tags", "done", "due", "todo", "status", "ghost", "files", "nl\n"];
for (const agg of Q.AGGREGATES) {
  for (const key of aggKeys) {
    add({ kind: "agg", agg, key });
    if (rnd() < 0.5) add({ kind: "agg", agg, key, filters: tree(1) });
  }
}
// Small-scale subsets, where avg's 16-significant-digit division scale matters
for (const [lo, hi] of [[-10, 10], [0.5, 8], [1, 100], [-5, 3], [2, 2.5], [-100, 0]]) {
  for (const key of ["num", "rollup"]) {
    for (const agg of ["avg", "sum", "min", "max", "range"]) {
      add({ kind: "agg", agg, key, filters: { op: "and", children: [
        { key, op: "gte", value: lo }, { key, op: "lte", value: hi }] } });
    }
  }
}
add({ kind: "agg", agg: "median", key: "num" });
add({ kind: "agg", agg: "median", key: "num", filters: { key: "ghost", op: "is" } });
add({ kind: "agg", agg: "sum", key: "bad key!" });
add({ kind: "agg", agg: "sum", key: "" });
add({ kind: "agg", agg: "avg", key: "num", filters: { key: "ghost", op: "is" } });
add({ kind: "agg", agg: "avg", key: "num", filters: { key: "num", op: "gt", value: 1e299 } });
add({ kind: "agg", agg: "avg", key: "num", filters: { key: "num", op: "lt", value: 1 } });

// Cases whose fields registry is special
add({ kind: "rows", filters: { key: "name", op: "is", value: "x" }, fields: { name: 1.5 } });
add({ kind: "rows", filters: { key: "x".repeat(65), op: "is", value: "x" }, fields: { ["x".repeat(65)]: 0 } });

// --- run PostgreSQL side ------------------------------------------------------
writeFileSync(join(work, "dataset.json"), JSON.stringify({
  fields: FIELDS, rows: ROWS.map(({ properties, ...r }) => r) }));
writeFileSync(join(work, "cases.json"), JSON.stringify(cases));

const name = `kbquery-difftest-${Math.random().toString(36).slice(2, 10)}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
let pg;
try {
  docker("run", "-d", "--name", name, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name);
  execFileSync("python3", ["-I", join(HERE, "query.diff.pg.py"), API_DIR, ip,
    join(work, "dataset.json"), join(work, "cases.json"), join(work, "out.json")],
  { stdio: "inherit" });
  pg = JSON.parse(readFileSync(join(work, "out.json"), "utf8"));
} finally {
  try { docker("rm", "-f", name); } catch (e) { console.error("could not remove container", name, e.message); }
}

// --- run TypeScript side and compare -----------------------------------------
const dayAfter = new Date().toISOString().slice(0, 10);
if (pg.info.today !== isoDay(0) || dayAfter !== isoDay(0)) {
  console.error("UTC date changed during the run; rerun the test.");
  process.exit(2);
}

function tsRun(c) {
  const fields = c.fields || FIELDS;
  try {
    if (c.kind === "rows") {
      const out = Q.queryRows(ROWS, c.filters, c.sorts, fields, NOW, "utc");
      return { ok: out.map((r) => r.id) };
    }
    return { ok: Q.aggregateQuery(ROWS, c.agg, c.key, c.filters, fields, NOW, "utc") };
  } catch (e) {
    if (e instanceof Q.FilterError) return { error: "filter", message: e.message };
    if (e instanceof Q.QueryError) return { error: "db", message: e.message };
    if (e instanceof Q.UnsupportedError) return { error: "unsupported", message: e.message };
    throw e;
  }
}

const pyFloat = (s) => s === "nan" ? NaN : s === "inf" ? Infinity : s === "-inf" ? -Infinity : Number(s);
function same(ts, ref, kind) {
  if (ref.error || ts.error) {
    if (ref.error !== ts.error) return false;
    return ref.error === "db" || ref.message === ts.message;
  }
  if (kind === "agg") {
    if (ref.ok === null || ts.ok === null) return ref.ok === ts.ok;
    return Object.is(pyFloat(ref.ok), ts.ok);
  }
  return JSON.stringify(ts.ok) === JSON.stringify(ref.ok);
}

let mismatches = 0, stockOnlyErrors = 0, errorsMatched = 0, filterErrors = 0, emptyResults = 0;
let splitChecked = 0;
cases.forEach((c, i) => {
  const ref = pg.results[i].datetext;
  const stock = pg.results[i].stock;
  const ts = tsRun(c);
  const ok = same(ts, ref, c.kind);
  if (ref.error === "filter") filterErrors++;
  else if (ref.error) errorsMatched += ok ? 1 : 0;
  if (!ref.error && c.kind === "rows" && ref.ok.length === 0) emptyResults++;
  if (stock.error === "db" && !ref.error) stockOnlyErrors++;
  else if (!same(stock.error ? stock : ts, stock, c.kind)) {
    mismatches++;
    console.log(`STOCK MISMATCH #${i}`, JSON.stringify(c), "\n  pg:", JSON.stringify(stock), "\n  ts:", JSON.stringify(ts));
  }
  // filterRows + sortRows must agree with queryRows when nothing fails
  if (c.kind === "rows" && !ts.error) {
    const f = c.fields || FIELDS;
    const ids = Q.sortRows(Q.filterRows(ROWS, c.filters, f, NOW), c.sorts, f, NOW).map((r) => r.id);
    splitChecked++;
    if (JSON.stringify(ids) !== JSON.stringify(ts.ok)) {
      mismatches++;
      console.log(`SPLIT MISMATCH #${i}`, JSON.stringify(c));
    }
  }
  if (!ok) {
    mismatches++;
    console.log(`MISMATCH #${i}`, JSON.stringify(c), "\n  pg:", JSON.stringify(ref).slice(0, 2000),
      "\n  ts:", JSON.stringify(ts).slice(0, 2000));
  } else if (VERBOSE) {
    console.log(`ok #${i}`, JSON.stringify(c), JSON.stringify(ts).slice(0, 200));
  }
});

rmSync(work, { recursive: true, force: true });
console.log(`PostgreSQL ${pg.info.server} (${pg.info.collate}), asyncpg ${pg.info.asyncpg}, today ${pg.info.today}`);
console.log(`rows: ${ROWS.length}, cases: ${cases.length} (rows ${cases.filter((c) => c.kind === "rows").length}, `
  + `aggregates ${cases.filter((c) => c.kind === "agg").length})`);
console.log(`FilterError cases: ${filterErrors}, database-error cases matched: ${errorsMatched}, `
  + `empty results: ${emptyResults}, filterRows+sortRows cross-checks: ${splitChecked}`);
console.log(`cases that fail only with stock asyncpg (date parameters): ${stockOnlyErrors}`);
console.log(`mismatches: ${mismatches}`);
process.exit(mismatches ? 1 : 0);
