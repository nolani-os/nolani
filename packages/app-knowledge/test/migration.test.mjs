// Upgrade test of the device database: a database created by an older app
// version (schema 1, the first shipped one) is opened by the current version.
// Every earlier object, collection, favourite and link must survive, the full-text
// index must still find them, and the new tables (fields, history, settings …)
// must work on the old data.
//
//   node packages/app-knowledge/test/migration.test.mjs   (from projects/claraos)

import { readdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const pnpm = resolve(APP, "../../node_modules/.pnpm");
const esbuildDir = readdirSync(pnpm).filter((d) => /^esbuild@\d/.test(d)).sort().pop();
const esbuild = createRequire(import.meta.url)(join(pnpm, esbuildDir, "node_modules/esbuild"));
const req = createRequire(join(APP, "package.json"));
const initSqlJs = req("sql.js");

const work = mkdtempSync(join(tmpdir(), "kb-migration-"));
let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
};

try {
  esbuild.buildSync({
    entryPoints: [join(APP, "src/local/schema.ts")], bundle: true, format: "esm", platform: "node",
    target: "node20", outfile: join(work, "schema.mjs"), logLevel: "warning",
  });
  esbuild.buildSync({
    entryPoints: [join(APP, "src/local/api.ts")], bundle: true, format: "esm", platform: "node",
    target: "node20", outfile: join(work, "api.mjs"), logLevel: "warning", nodePaths: [join(APP, "node_modules")],
  });
  const { migrate } = await import(pathToFileURL(join(work, "schema.mjs")).href);
  const { createLocalApi } = await import(pathToFileURL(join(work, "api.mjs")).href);

  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  const db = {
    driver: "wasm",
    run: async (sql, params = []) => { raw.run(sql, params); },
    all: async (sql, params = []) => {
      const st = raw.prepare(sql);
      try { st.bind(params); const rows = []; while (st.step()) rows.push(st.getAsObject()); return rows; }
      finally { st.free(); }
    },
  };

  // 1) Bring the database to schema 1 only, as the first shipped version left it
  await migrate(db, 1);
  const [{ user_version: v1 }] = await db.all("PRAGMA user_version");
  check("Ausgangslage Schema 1", v1 === 1, v1);
  const ts = "2026-11-01T12:00:00.000Z";
  await db.run(`INSERT INTO objects (id, type, owner, visibility, title, body, properties, stage, created_by, created_at,
    updated_at, deleted_at, parent_id, position, icon, cover) VALUES
    ('11111111-1111-4111-8111-111111111111', 'note', 'local', 'private', 'Alte Notiz', 'Text aus Version eins', '{"preis": 3}', NULL, 'local', ?, ?, NULL, NULL, NULL, NULL, NULL),
    ('22222222-2222-4222-8222-222222222222', 'note', 'local', 'private', 'Unterseite', 'Kind', '{}', NULL, 'local', ?, ?, NULL, '11111111-1111-4111-8111-111111111111', '00000001', NULL, NULL)`,
    [ts, ts, ts, ts]);
  await db.run(`INSERT INTO collections (id, owner, visibility, name, icon, description, default_type, settings, created_at, updated_at)
    VALUES ('33333333-3333-4333-8333-333333333333', 'local', 'private', 'Alte Sammlung', NULL, NULL, 'note', '{}', ?, ?)`, [ts, ts]);
  await db.run("INSERT INTO collection_items (collection_id, object_id, position) VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 0)");
  await db.run("INSERT INTO favorites (object_id, created_at) VALUES ('11111111-1111-4111-8111-111111111111', ?)", [ts]);
  await db.run("INSERT INTO links (id, from_id, to_id, rel, created_at) VALUES ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'relates_to', ?)", [ts]);

  // 2) The current version opens it
  await migrate(db);
  const [{ user_version: v }] = await db.all("PRAGMA user_version");
  check("nach dem Update aktuelles Schema", v >= 3, v);
  const api = createLocalApi(db);
  const call = async (m, p, b) => {
    const [path, query = ""] = p.split("?");
    return (await api(m, path, new URLSearchParams(query), b)).json();
  };
  const o = (await call("GET", "/objects/11111111-1111-4111-8111-111111111111")).object;
  check("alte Notiz samt Eigenschaften da", o?.title === "Alte Notiz" && o.properties.preis === 3, JSON.stringify(o));
  check("Unterseite hängt weiter darunter",
    (await call("GET", "/objects/11111111-1111-4111-8111-111111111111/children")).children.length === 1);
  check("Sammlung mit Eintrag da", (await call("GET", "/collections")).collections[0]?.item_count === 1);
  check("Favorit da", (await call("GET", "/favorites")).favorites.length === 1);
  check("Verknüpfung im Detail", o?.links?.some((l) => l.other_title === "Unterseite"), JSON.stringify(o?.links));
  check("Volltext findet alten Text", (await call("GET", "/search?q=version")).results.length === 1);
  // new tables on old data
  const rows = await call("GET", "/collections/33333333-3333-4333-8333-333333333333/rows");
  check("Zeilenabfrage auf alter Sammlung", rows.rows?.length === 1, JSON.stringify(rows).slice(0, 200));
  const views = await call("GET", "/collections/33333333-3333-4333-8333-333333333333/views");
  check("Standardansicht entsteht", views.views?.length === 1);
  await call("PATCH", "/objects/11111111-1111-4111-8111-111111111111", { body: "Geändert nach dem Update" });
  check("Verlauf beginnt nach dem Update", (await call("GET", "/objects/11111111-1111-4111-8111-111111111111/history")).history.length === 1);
  // 3) Opening again changes nothing
  await migrate(db);
  check("zweites Öffnen ändert nichts", (await call("GET", "/objects")).objects.length === 2);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(bad ? `${bad} fehlgeschlagen` : "Update-Test grün");
process.exitCode = bad ? 1 : 0;
