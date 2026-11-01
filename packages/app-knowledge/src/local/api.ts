/**
 * Local implementation of the Knowledge REST contract (`/api/claraos/knowledge/*`)
 * on the device's SQLite database.
 *
 * The UI talks to the same paths and receives the same JSON shapes as from the
 * server (routers/knowledge.py), so it cannot tell whether the device or a
 * cell answered. Everything that needs other people or the assistant (shares,
 * notifications, clipping, strategy) is answered with 501 and a readable reason.
 *
 * Databases follow the server exactly: filters, sorts and aggregates
 * (query.ts ↔ services/kb_query.py) and formulas (formula.ts ↔
 * services/kb_formula.py) are ports checked by differential tests.
 */
import type { Db, SqlValue } from "./db";
import { FilterError, QueryError, UnsupportedError, aggregate, aggregateQuery, AGGREGATES, queryRows } from "./query";
import {
  FormulaError, FormulaNotPortable, errorText, evaluate as evalFormula,
  setTodayProvider, validate as validateFormula,
} from "./formula";
import { diffMarkdown, summarize } from "./diff";
import { buildExportZip, guessFieldType, parseZip, pyStr, rewriteLinks } from "./archive";

export const LOCAL_USER = "local";

export interface LocalApiOptions {
  /** UI language ("de" | "en"): formulas and messages follow it like the server's setting. */
  lang?: () => string;
}

/** A binary answer (attachment download, export archive). */
class BinaryResult {
  constructor(readonly data: Uint8Array, readonly contentType: string, readonly disposition: string) {}
}

const FT_ROLLUP = 11;
const FT_FORMULA = 14;
/** Old prop_schema vocabulary → field_type ids (as on the server). */
const FIELD_KIND_TO_TYPE: Record<string, number> = {
  text: 0, number: 1, date: 2, select: 3, multi_select: 4, url: 5, checkbox: 6,
};
const LAYOUTS = ["table", "board", "gallery", "list", "calendar", "timeline"];
const LINK_RELS = ["relates_to", "part_of_vision", "inspired_by", "duplicates",
  "measured_by", "contributes_to", "derived_from"];
const ATTACH_MAX = 20 * 1024 * 1024;
const ATTACH_INLINE = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav", "application/pdf",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server messages in both UI languages (server catalogs: packages/api/locales, server.json). */
const MESSAGES: Record<string, Record<string, string>> = {
  de: {
    allEntries: "Alle Einträge", objectNotFound: "Objekt nicht gefunden",
    versionNotFound: "Version nicht gefunden", compareNotFound: "Vergleichsversion nicht gefunden",
    fileTooLarge: "Datei zu groß (max. 20 MB)", attachmentNotFound: "Anhang nicht gefunden",
    collectionNotFound: "Sammlung nicht gefunden", templateNotFound: "Vorlage nicht gefunden",
    archiveTooLarge: "Archiv zu groß (max. 80 MB)", zipUnreadable: "ZIP konnte nicht gelesen werden: {error}",
    formulaInvalid: "Formel ungültig: {error}", fieldNotFound: "Feld nicht gefunden",
    viewNotFound: "Ansicht nicht gefunden", lastView: "Die letzte Ansicht kann nicht gelöscht werden",
    linkSelf: "Ein Objekt kann nicht mit sich selbst verknüpft werden",
    formulaBroken: "Formel fehlerhaft",
  },
  en: {
    allEntries: "All entries", objectNotFound: "Object not found",
    versionNotFound: "Version not found", compareNotFound: "Comparison version not found",
    fileTooLarge: "File too large (max. 20 MB)", attachmentNotFound: "Attachment not found",
    collectionNotFound: "Collection not found", templateNotFound: "Template not found",
    archiveTooLarge: "Archive too large (max. 80 MB)", zipUnreadable: "The ZIP could not be read: {error}",
    formulaInvalid: "Invalid formula: {error}", fieldNotFound: "Field not found",
    viewNotFound: "View not found", lastView: "The last view cannot be deleted",
    linkSelf: "An object cannot be linked to itself",
    formulaBroken: "Formula broken",
  },
};

type ObjRow = {
  id: string; type: string; owner: string; visibility: string; title: string; body: string;
  properties: string; stage: string | null; created_by: string; created_at: string;
  updated_at: string; deleted_at: string | null; parent_id: string | null;
  position: string | null; icon: string | null; cover: string | null;
};

class HttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(detail);
  }
}

const COLS = "id, type, owner, visibility, title, body, properties, stage, created_by, created_at, " +
  "updated_at, deleted_at, parent_id, position, icon, cover";
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const parse = <T,>(s: unknown, fallback: T): T => {
  try {
    return typeof s === "string" ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function slim(o: ObjRow) {
  const { body, deleted_at: _d, properties, ...rest } = o;
  return {
    ...rest,
    properties: parse(properties, {}),
    body_preview: body.slice(0, 280) + (body.length > 280 ? "…" : ""),
    can_edit: true,
  };
}

/** User text → FTS4 query: every word must match, as a prefix. */
function ftsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.map((w) => `${w}*`).join(" ") : null;
}

const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Reference forms in Markdown, as in routers/knowledge.py `_extract_refs`. */
const REF_MD_RE = /\[([^\]]*)\]\((?:claraos:\/\/(?:knowledge|ideas)\/object\/|#kb-)([0-9a-f-]{36})\)/gi;
const REF_BARE_RE = /(?<!\()claraos:\/\/(?:knowledge|ideas)\/object\/([0-9a-f-]{36})/gi;

function extractRefs(body: string): [string, string, string][] {
  const seen = new Map<string, [string, string, string]>();
  for (const m of (body || "").matchAll(REF_MD_RE)) {
    const t: [string, string, string] = [m[2].toLowerCase(), "mention", [...m[1]].slice(0, 200).join("")];
    seen.set(t.join("\u0000"), t);
  }
  for (const m of (body || "").matchAll(REF_BARE_RE)) {
    const id = m[1].toLowerCase();
    if (![...seen.values()].some((k) => k[0] === id)) seen.set(`${id}\u0000link\u0000`, [id, "link", ""]);
  }
  return [...seen.values()];
}

/** The device's calendar day as YYYY-MM-DD (the server uses UTC). */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function createLocalApi(db: Db, options: LocalApiOptions = {}) {
  setTodayProvider(localToday);
  const lang = () => (options.lang?.() ?? "de").startsWith("en") ? "en" : "de";
  const msg = (key: string, args: Record<string, string> = {}) =>
    (MESSAGES[lang()][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => args[k] ?? "");

  async function find(id: string, withDeleted = false): Promise<ObjRow> {
    const [o] = await db.all<ObjRow>(`SELECT ${COLS} FROM objects WHERE id = ?`, [id]);
    if (!o || (o.deleted_at && !withDeleted)) throw new HttpError(404, msg("objectNotFound"));
    return o;
  }

  /** After every write, like the server's `_post_save`: references are
   *  rewritten idempotently and a history snapshot is taken (skipped when
   *  nothing changed). Errors never block the save. */
  async function postSave(id: string): Promise<void> {
    try {
      const [o] = await db.all<ObjRow>(`SELECT ${COLS} FROM objects WHERE id = ?`, [id]);
      if (!o) return;
      if (o.deleted_at) {
        await db.run("DELETE FROM refs WHERE src_object_id = ? AND kind <> 'relation_prop'", [id]);
        return;
      }
      await db.run("DELETE FROM refs WHERE src_object_id = ? AND kind <> 'relation_prop'", [id]);
      for (const [target, kind, anchor] of extractRefs(o.body)) {
        if (target === id) continue;
        await db.run(
          "INSERT OR IGNORE INTO refs (src_object_id, target_object_id, kind, anchor_text) " +
            "SELECT ?, id, ?, ? FROM objects WHERE id = ?", [id, kind, anchor, target]);
      }
      const props = JSON.stringify(parse(o.properties, {}));
      const [last] = await db.all<{ version: number; title: string; body: string; properties: string }>(
        "SELECT version, title, body, properties FROM history WHERE object_id = ? ORDER BY version DESC LIMIT 1", [id]);
      if (last && last.title === o.title && last.body === o.body &&
          JSON.stringify(parse(last.properties, {})) === props) return;
      await db.run(
        "INSERT OR IGNORE INTO history (object_id, version, title, body, properties, actor, created_at) " +
          "VALUES (?, COALESCE((SELECT MAX(version) FROM history WHERE object_id = ?), 0) + 1, ?, ?, ?, ?, ?)",
        [id, id, o.title, o.body, props, LOCAL_USER, now()]);
    } catch (e) {
      console.warn("local post-save failed", id, e);
    }
  }

  async function fetchColl(id: string) {
    const [c] = await db.all<{ id: string; default_type: string | null; owner: string; name: string }>(
      "SELECT id, default_type, owner, name FROM collections WHERE id = ?", [id]);
    if (!c) throw new HttpError(404, msg("collectionNotFound"));
    return c;
  }

  type FieldRow = { id: string; collection_id: string; key: string; name: string; field_type: number;
    type_option: string; is_primary: number; position: string | null; created_at: string; updated_at: string };
  const fieldOut = (f: FieldRow) => ({ ...f, type_option: parse(f.type_option, {}), is_primary: !!f.is_primary });

  type ViewRow = Record<string, unknown> & { id: string; filters: string; sorts: string };
  const viewOut = (v: ViewRow) => {
    const d: Record<string, unknown> = { ...v };
    for (const k of ["layout_setting", "filters", "group_setting", "field_settings"]) d[k] = parse(v[k], {});
    d.sorts = parse(v.sorts, []);
    return d;
  };

  async function nextColumnPosition(table: "fields" | "views", collectionId: string): Promise<string> {
    const [r] = await db.all<{ p: string | null }>(
      `SELECT MAX(position) AS p FROM ${table} WHERE collection_id = ?`, [collectionId]);
    const n = r?.p ? parseInt(r.p, 36) + 1 : 1;
    return n.toString(36).padStart(8, "0");
  }

  /** Fields of a collection; inherited once from the default type's prop_schema (server: `_ensure_fields`). */
  async function ensureFields(collectionId: string): Promise<FieldRow[]> {
    const q = "SELECT * FROM fields WHERE collection_id = ? ORDER BY position IS NULL, position, created_at";
    let rows = await db.all<FieldRow>(q, [collectionId]);
    if (rows.length) return rows;
    const coll = await fetchColl(collectionId);
    if (!coll.default_type) return [];
    const [t] = await db.all<{ prop_schema: string }>("SELECT prop_schema FROM types WHERE id = ?", [coll.default_type]);
    if (!t) return [];
    for (const p of parse<{ key?: string; label?: string; kind?: string; options?: unknown }[]>(t.prop_schema, [])) {
      if (!p.key) continue;
      const ts = now();
      await db.run(
        "INSERT OR IGNORE INTO fields (id, collection_id, key, name, field_type, type_option, is_primary, position, " +
          "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
        [uuid(), collectionId, p.key, p.label || p.key, FIELD_KIND_TO_TYPE[p.kind ?? "text"] ?? 0,
          JSON.stringify(p.options ? { options: p.options } : {}), await nextColumnPosition("fields", collectionId), ts, ts]);
    }
    rows = await db.all<FieldRow>(q, [collectionId]);
    return rows;
  }

  /** Validation message for a formula, or null when it is valid. Formulas the
   *  port cannot judge exactly (FormulaNotPortable) or that the server would
   *  reject with an internal error are refused here as invalid too. */
  function formulaProblem(expression: string): string | null {
    try {
      validateFormula(expression);
      return null;
    } catch (e) {
      if (e instanceof FormulaError) return errorText(e, lang());
      return e instanceof Error ? e.message : String(e);
    }
  }

  function checkFormulaOption(fieldType: number, typeOption: Record<string, unknown> | null | undefined) {
    if (fieldType !== FT_FORMULA) return;
    const problem = formulaProblem(String(typeOption?.expression ?? ""));
    if (problem !== null) throw new HttpError(400, msg("formulaInvalid", { error: problem }));
  }

  /** One formula cell. A formula the port cannot judge exactly shows the
   *  server's "formula broken" text instead of a guessed value. */
  function formulaCell(expression: string, props: Record<string, unknown>, rollups: Record<string, unknown>) {
    try {
      return evalFormula(expression, props, rollups, lang());
    } catch (e) {
      if (e instanceof FormulaNotPortable || e instanceof RangeError) return `⚠ ${msg("formulaBroken")}`;
      throw e;
    }
  }

  /** Visible (= not deleted) members of a collection as slim rows. */
  async function collectionRows(collectionId: string) {
    const rows = await db.all<ObjRow & { item_position: number }>(
      `SELECT ${COLS.split(", ").map((c) => "o." + c).join(", ")}, ci.position AS item_position
       FROM objects o JOIN collection_items ci ON ci.object_id = o.id AND ci.collection_id = ?
       WHERE o.deleted_at IS NULL`, [collectionId]);
    return rows.map((r) => ({ ...slim(r), item_position: r.item_position }));
  }

  /** Rollups on read (server: `_rollup_values`): aggregate over the linked, visible targets. */
  async function rollupValues(rows: ReturnType<typeof slim>[], fields: FieldRow[]) {
    const out: Record<string, Record<string, number | null>> = {};
    const rollups = fields.filter((f) => f.field_type === FT_ROLLUP);
    if (!rollups.length || !rows.length) return out;
    for (const f of rollups) {
      const opt = parse<Record<string, unknown>>(f.type_option, {});
      const relKey = opt.relation_field as string | undefined;
      const targetKey = (opt.target_field as string | undefined) ?? "";
      const agg = String(opt.aggregate || "count").toLowerCase();
      if (!relKey || !(AGGREGATES as readonly string[]).includes(agg)) continue;
      for (const r of rows) {
        const ids = (r.properties as Record<string, unknown>)[relKey];
        if (!Array.isArray(ids) || !ids.length) continue;
        const valid = ids.filter((i): i is string => typeof i === "string" && i.length === 36);
        if (!valid.length) continue;
        const targets = (await db.all<ObjRow>(
          `SELECT ${COLS} FROM objects WHERE deleted_at IS NULL AND id IN (${valid.map(() => "?").join(",")})`,
          valid)).map(slim);
        const val = agg === "count" ? targets.length : aggregate(targets as never, agg, targetKey);
        (out[r.id] ??= {})[f.key] = val ?? null;
      }
    }
    return out;
  }

  function formulaValues(props: Record<string, unknown>, rollups: Record<string, unknown>, formulaFields: FieldRow[]) {
    const values: Record<string, unknown> = {};
    for (const ff of formulaFields) {
      const opt = parse<Record<string, unknown>>(ff.type_option, {});
      values[ff.key] = formulaCell(String(opt.expression ?? ""), props, rollups);
    }
    return values;
  }

  async function viewOf(collectionId: string, viewId: string | null): Promise<ViewRow | null> {
    if (!viewId) return null;
    const [v] = await db.all<ViewRow>("SELECT * FROM views WHERE id = ? AND collection_id = ?", [viewId, collectionId]);
    if (!v) throw new HttpError(404, msg("viewNotFound"));
    return v;
  }

  const fieldTypes = (fields: FieldRow[]) => Object.fromEntries(fields.map((f) => [f.key, f.field_type]));

  /** FilterError = the server's 400; QueryError/UnsupportedError = what the
   *  server's database would reject (500), shown with its reason. */
  function asFilterError(e: unknown): never {
    if (e instanceof FilterError) throw new HttpError(400, e.message);
    if (e instanceof QueryError || e instanceof UnsupportedError) throw new HttpError(500, e.message);
    throw e;
  }

  async function full(id: string) {
    const o = await find(id, true);
    const collections = await db.all(
      "SELECT c.id, c.name, c.icon FROM collection_items ci JOIN collections c ON c.id = ci.collection_id " +
        "WHERE ci.object_id = ? ORDER BY c.name", [id]);
    const links = (await db.all<{ id: string; from_id: string; to_id: string; rel: string;
      other_title: string; other_type: string }>(
      `SELECT l.id, l.from_id, l.to_id, l.rel, o.title AS other_title, o.type AS other_type
       FROM links l JOIN objects o ON o.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
       WHERE (l.from_id = ? OR l.to_id = ?) AND o.deleted_at IS NULL`, [id, id, id]))
      .map((l) => ({
        id: l.id, rel: l.rel, direction: l.from_id === id ? "out" : "in",
        other_id: l.from_id === id ? l.to_id : l.from_id, other_title: l.other_title, other_type: l.other_type,
      }));
    return {
      ...o, properties: parse(o.properties, {}), collections, links, activity: [],
      rag_status: "none", rag_indexed_at: null, can_edit: true,
    };
  }

  async function nextPosition(parentId: string | null): Promise<string> {
    const [r] = await db.all<{ p: string | null }>(
      "SELECT MAX(position) AS p FROM objects WHERE parent_id IS ? AND deleted_at IS NULL", [parentId]);
    // Zero-padded base-36 counters sort lexically like the server's fractional keys.
    const n = r?.p ? parseInt(r.p, 36) + 1 : 1;
    return n.toString(36).padStart(8, "0");
  }

  async function collectionOut(id: string) {
    const [c] = await db.all<Record<string, unknown>>(
      "SELECT c.*, (SELECT COUNT(*) FROM collection_items ci JOIN objects o ON o.id = ci.object_id " +
        "WHERE ci.collection_id = c.id AND o.deleted_at IS NULL) AS item_count FROM collections c WHERE c.id = ?",
      [id]);
    if (!c) throw new HttpError(404, msg("collectionNotFound"));
    return { ...c, settings: parse(c.settings, {}), permission: "owner", is_owner: true, can_edit: true };
  }

  type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: any) => Promise<unknown>;
  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/types$/, async () => ({
      types: (await db.all<Record<string, unknown>>("SELECT * FROM types ORDER BY is_system DESC, name"))
        .map((t) => ({ ...t, is_system: !!t.is_system, prop_schema: parse(t.prop_schema, []) })),
    })],
    ["POST", /^\/types$/, async (_m, _q, b) => {
      await db.run("INSERT INTO types (id, name, icon, is_system, owner, prop_schema) VALUES (?, ?, ?, 0, ?, ?)",
        [b.id, b.name, b.icon ?? null, LOCAL_USER, JSON.stringify(b.prop_schema ?? [])]);
      return { type: { id: b.id, name: b.name, icon: b.icon ?? null, description: null, is_system: false,
        owner: LOCAL_USER, prop_schema: b.prop_schema ?? [] } };
    }],

    ["GET", /^\/objects$/, async (_m, q) => {
      const where = ["o.deleted_at IS NULL"];
      const params: SqlValue[] = [];
      let join = "";
      let order = "o.updated_at DESC";
      for (const col of ["type", "stage", "visibility"]) {
        const v = q.get(col);
        if (v) {
          where.push(`o.${col} = ?`);
          params.push(v);
        }
      }
      const text = q.get("q") && ftsQuery(q.get("q")!);
      if (text) {
        where.push("o.seq IN (SELECT docid FROM objects_fts WHERE objects_fts MATCH ?)");
        params.push(text);
      }
      const coll = q.get("collection_id");
      if (coll) {
        join = "JOIN collection_items ci ON ci.object_id = o.id AND ci.collection_id = ?";
        params.unshift(coll);
        order = "ci.position, o.updated_at DESC";
      }
      const limit = Math.max(1, Math.min(Number(q.get("limit") ?? 50), 200));
      const offset = Math.max(0, Number(q.get("offset") ?? 0));
      const rows = await db.all<ObjRow>(
        `SELECT ${COLS.split(", ").map((c) => "o." + c).join(", ")} FROM objects o ${join} ` +
          `WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params);
      return { objects: rows.map(slim) };
    }],
    ["POST", /^\/objects$/, async (_m, _q, b) => handlers.createObject(b)],
  ];

  const handlers = {
    async createObject(b: any) {
      // Defaults of the server's ObjectCreate model
      b = { ...b, type: b.type ?? "note", body: b.body ?? "", visibility: b.visibility ?? "private" };
      if (!b.title?.trim()) throw new HttpError(400, "title darf nicht leer sein");
      const [t] = await db.all("SELECT id FROM types WHERE id = ?", [b.type]);
      if (!t) throw new HttpError(400, `Unbekannter Typ: '${b.type}'`);
      const parent_id: string | null = b.parent_id ?? null;
      if (parent_id) await find(parent_id);
      const id = uuid();
      const ts = now();
      await db.run(
        `INSERT INTO objects (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [id, b.type, LOCAL_USER, b.visibility ?? "private", b.title.trim(), b.body ?? "",
          JSON.stringify(b.properties ?? {}), b.stage ?? (b.type === "idea" ? "spark" : null), LOCAL_USER,
          ts, ts, parent_id, parent_id ? await nextPosition(parent_id) : null, b.icon ?? null, b.cover ?? null]);
      if (b.collection_id) {
        await db.run("INSERT OR IGNORE INTO collection_items (collection_id, object_id) VALUES (?, ?)",
          [b.collection_id, id]);
      }
      await postSave(id);
      return { object: await full(id) };
    },
  };
  routes.push(
    ["GET", /^\/objects\/([^/]+)$/, async (m) => {
      await find(m[1]);
      return { object: await full(m[1]) };
    }],
    ["PATCH", /^\/objects\/([^/]+)$/, async (m, _q, b) => {
      await find(m[1]);
      const sets: string[] = [];
      const params: SqlValue[] = [];
      for (const k of ["title", "body", "stage", "visibility", "icon", "cover", "type"]) {
        if (k in b) {
          if (k === "title" && !String(b.title ?? "").trim()) throw new HttpError(400, "title darf nicht leer sein");
          sets.push(`${k} = ?`);
          params.push(b[k] ?? null);
        }
      }
      if ("properties" in b) {
        sets.push("properties = ?");
        params.push(JSON.stringify(b.properties ?? {}));
      }
      sets.push("updated_at = ?");
      params.push(now(), m[1]);
      await db.run(`UPDATE objects SET ${sets.join(", ")} WHERE id = ?`, params);
      await postSave(m[1]);
      return { object: await full(m[1]) };
    }],
    ["DELETE", /^\/objects\/([^/]+)$/, async (m) => {
      // Like the server: the page and its subtree go to the trash together,
      // marked with the same timestamp so restore brings back exactly this set.
      await find(m[1]);
      await db.run(
        `WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT o.id FROM objects o JOIN sub ON o.parent_id = sub.id
           WHERE o.deleted_at IS NULL)
         UPDATE objects SET deleted_at = ? WHERE id IN (SELECT id FROM sub)`, [m[1], now()]);
      await postSave(m[1]);
      return { ok: true };
    }],
    ["POST", /^\/objects\/([^/]+)\/restore$/, async (m) => {
      const o = await find(m[1], true);
      if (o.deleted_at) await db.run("UPDATE objects SET deleted_at = NULL WHERE deleted_at = ?", [o.deleted_at]);
      await postSave(m[1]);
      return { ok: true };
    }],
    ["DELETE", /^\/objects\/([^/]+)\/purge$/, async (m) => {
      await db.run("DELETE FROM collection_items WHERE object_id = ?", [m[1]]);
      await db.run("DELETE FROM favorites WHERE object_id = ?", [m[1]]);
      await db.run("DELETE FROM links WHERE from_id = ? OR to_id = ?", [m[1], m[1]]);
      await db.run("DELETE FROM refs WHERE src_object_id = ? OR target_object_id = ?", [m[1], m[1]]);
      await db.run("DELETE FROM history WHERE object_id = ?", [m[1]]);
      await db.run("DELETE FROM attachments WHERE object_id = ?", [m[1]]);
      await db.run("DELETE FROM objects WHERE id = ?", [m[1]]);
      return { ok: true };
    }],
    ["GET", /^\/objects\/([^/]+)\/children$/, async (m) => ({
      children: (await db.all<ObjRow>(
        `SELECT ${COLS} FROM objects WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position`, [m[1]]))
        .map(slim),
    })],
    ["GET", /^\/objects\/([^/]+)\/ancestors$/, async (m) => ({
      ancestors: (await db.all<{ id: string; title: string; icon: string | null; type: string; depth: number }>(
        `WITH RECURSIVE up(id, depth) AS (
           SELECT parent_id, 1 FROM objects WHERE id = ? AND parent_id IS NOT NULL
           UNION SELECT o.parent_id, up.depth + 1 FROM objects o JOIN up ON o.id = up.id
             WHERE o.parent_id IS NOT NULL AND up.depth < 64)
         SELECT o.id, o.title, o.icon, o.type, up.depth FROM up JOIN objects o ON o.id = up.id
         ORDER BY up.depth DESC`, [m[1]]))
        .map(({ depth: _d, ...a }) => a),
    })],
    ["PATCH", /^\/objects\/([^/]+)\/move$/, async (m, _q, b) => {
      await find(m[1]);
      const parent_id: string | null = b.parent_id ?? null;
      if (parent_id) {
        const [cycle] = await db.all(
          `WITH RECURSIVE up(id) AS (SELECT ? UNION SELECT o.parent_id FROM objects o JOIN up ON o.id = up.id
             WHERE o.parent_id IS NOT NULL) SELECT 1 FROM up WHERE id = ?`, [parent_id, m[1]]);
        if (cycle) throw new HttpError(400, "Eine Seite kann nicht unter sich selbst liegen");
      }
      await db.run("UPDATE objects SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?",
        [parent_id, await nextPosition(parent_id), now(), m[1]]);
      return { object: await full(m[1]) };
    }],
    ["GET", /^\/objects\/([^/]+)\/activity$/, async () => ({ activity: [] })],
    ["POST", /^\/objects\/([^/]+)\/duplicate$/, async (m) => {
      const o = await find(m[1]);
      const id = uuid();
      const ts = now();
      await db.run(
        `INSERT INTO objects (${COLS}) SELECT ?, type, owner, visibility, title || ' (Kopie)', body, properties,
           stage, created_by, ?, ?, NULL, parent_id, position, icon, cover FROM objects WHERE id = ?`,
        [id, ts, ts, o.id]);
      // Collection memberships come along (everything here is writable)
      await db.run(
        "INSERT OR IGNORE INTO collection_items (collection_id, object_id, position) " +
          "SELECT collection_id, ?, position FROM collection_items WHERE object_id = ?", [id, o.id]);
      await postSave(id);
      return { object: await full(id) };
    }],

    ["GET", /^\/favorites$/, async () => ({
      favorites: (await db.all<ObjRow>(
        `SELECT ${COLS.split(", ").map((c) => "o." + c).join(", ")} FROM favorites f JOIN objects o ` +
          "ON o.id = f.object_id WHERE o.deleted_at IS NULL ORDER BY f.created_at")).map(slim),
    })],
    ["PUT", /^\/objects\/([^/]+)\/favorite$/, async (m) => {
      await find(m[1]);
      await db.run("INSERT OR IGNORE INTO favorites (object_id, created_at) VALUES (?, ?)", [m[1], now()]);
      return { ok: true };
    }],
    ["DELETE", /^\/objects\/([^/]+)\/favorite$/, async (m) => {
      await db.run("DELETE FROM favorites WHERE object_id = ?", [m[1]]);
      return { ok: true };
    }],
    ["GET", /^\/trash$/, async () => ({
      trash: (await db.all<ObjRow>(
        `SELECT ${COLS} FROM objects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`))
        .map((o) => ({ ...slim(o), deleted_at: o.deleted_at })),
    })],

    ["GET", /^\/collections$/, async () => {
      const ids = await db.all<{ id: string }>("SELECT id FROM collections ORDER BY name");
      return { collections: await Promise.all(ids.map((c) => collectionOut(c.id))) };
    }],
    ["POST", /^\/collections$/, async (_m, _q, b) => {
      if (!b.name?.trim()) throw new HttpError(400, "name darf nicht leer sein");
      const id = uuid();
      const ts = now();
      await db.run(
        "INSERT INTO collections (id, owner, visibility, name, icon, description, default_type, settings, " +
          "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)",
        [id, LOCAL_USER, b.visibility ?? "private", b.name.trim(), b.icon ?? null, b.description ?? null,
          b.default_type ?? null, ts, ts]);
      return { collection: await collectionOut(id) };
    }],
    ["PATCH", /^\/collections\/([^/]+)$/, async (m, _q, b) => {
      await collectionOut(m[1]);
      const sets: string[] = [];
      const params: SqlValue[] = [];
      for (const k of ["name", "icon", "description", "default_type", "visibility"]) {
        if (k in b) {
          sets.push(`${k} = ?`);
          params.push(b[k] ?? null);
        }
      }
      if ("settings" in b) {
        sets.push("settings = ?");
        params.push(JSON.stringify(b.settings ?? {}));
      }
      sets.push("updated_at = ?");
      params.push(now(), m[1]);
      await db.run(`UPDATE collections SET ${sets.join(", ")} WHERE id = ?`, params);
      return { collection: await collectionOut(m[1]) };
    }],
    ["DELETE", /^\/collections\/([^/]+)$/, async (m) => {
      await db.run("DELETE FROM fields WHERE collection_id = ?", [m[1]]);
      await db.run("DELETE FROM views WHERE collection_id = ?", [m[1]]);
      await db.run("DELETE FROM collection_items WHERE collection_id = ?", [m[1]]);
      await db.run("DELETE FROM collections WHERE id = ?", [m[1]]);
      return { ok: true };
    }],
    ["POST", /^\/collections\/([^/]+)\/items$/, async (m, _q, b) => {
      await collectionOut(m[1]);
      await find(b.object_id);
      await db.run(
        "INSERT INTO collection_items (collection_id, object_id, position) VALUES (?, ?, ?) " +
          "ON CONFLICT (collection_id, object_id) DO UPDATE SET position = excluded.position",
        [m[1], b.object_id, b.position ?? 0]);
      return { ok: true };
    }],
    ["DELETE", /^\/collections\/([^/]+)\/items\/([^/]+)$/, async (m) => {
      await db.run("DELETE FROM collection_items WHERE collection_id = ? AND object_id = ?", [m[1], m[2]]);
      return { ok: true };
    }],

    // ── Links between objects ──────────────────────────────────────────────
    ["POST", /^\/objects\/([^/]+)\/links$/, async (m, _q, b) => {
      await find(m[1]);
      const rel = b.rel ?? "relates_to";
      if (!LINK_RELS.includes(rel)) throw new HttpError(400, `Ungültiger Wert für rel: '${rel}'`);
      if (!UUID_RE.test(String(b.to_id ?? ""))) throw new HttpError(400, "Ungültige to_id");
      if (b.to_id === m[1]) throw new HttpError(400, msg("linkSelf"));
      await find(b.to_id);
      const [existing] = await db.all<{ id: string }>(
        "SELECT id FROM links WHERE from_id = ? AND to_id = ? AND rel = ?", [m[1], b.to_id, rel]);
      const id = existing?.id ?? uuid();
      if (!existing) {
        await db.run("INSERT INTO links (id, from_id, to_id, rel, created_at) VALUES (?, ?, ?, ?, ?)",
          [id, m[1], b.to_id, rel, now()]);
      }
      return { ok: true, link_id: id };
    }],
    ["DELETE", /^\/links\/([^/]+)$/, async (m) => {
      await db.run("DELETE FROM links WHERE id = ?", [m[1]]);
      return { ok: true };
    }],

    // ── References ─────────────────────────────────────────────────────────
    ["GET", /^\/objects\/([^/]+)\/backlinks$/, async (m, q) => {
      await find(m[1]);
      const limit = Math.max(1, Math.min(Number(q.get("limit") ?? 50), 200));
      const rows = await db.all<ObjRow & { kind: string; anchor_text: string }>(
        `SELECT r.kind, r.anchor_text, ${COLS.split(", ").map((c) => "o." + c).join(", ")}
         FROM refs r JOIN objects o ON o.id = r.src_object_id
         WHERE r.target_object_id = ? AND o.deleted_at IS NULL ORDER BY o.updated_at DESC LIMIT ${limit}`, [m[1]]);
      return { backlinks: rows.map((r) => ({ ...slim(r), kind: r.kind, anchor_text: r.anchor_text })) };
    }],
    ["GET", /^\/objects\/([^/]+)\/backmentions$/, async (m, q) => {
      const o = await find(m[1]);
      const title = (o.title || "").trim();
      if ([...title].length < 4) return { backmentions: [] };
      const limit = Math.max(1, Math.min(Number(q.get("limit") ?? 20), 50));
      // ILIKE on the server: case-insensitive for every alphabet, so compare in JS
      const needle = title.toLowerCase();
      const candidates = await db.all<ObjRow>(
        `SELECT ${COLS} FROM objects o WHERE o.deleted_at IS NULL AND o.id <> ?
           AND NOT EXISTS (SELECT 1 FROM refs r WHERE r.src_object_id = o.id AND r.target_object_id = ?)
         ORDER BY o.updated_at DESC`, [m[1], m[1]]);
      return { backmentions: candidates.filter((c) => c.body.toLowerCase().includes(needle)).slice(0, limit).map(slim) };
    }],

    // ── History ────────────────────────────────────────────────────────────
    ["GET", /^\/objects\/([^/]+)\/history$/, async (m, q) => {
      await find(m[1]);
      const limit = Math.max(1, Math.min(Number(q.get("limit") ?? 50), 200));
      const rows = await db.all<{ version: number; name: string | null; title: string; actor: string;
        created_at: string; body: string }>(
        `SELECT version, name, title, actor, created_at, body FROM history WHERE object_id = ?
         ORDER BY version DESC LIMIT ${limit}`, [m[1]]);
      return { history: rows.map(({ body, ...r }) => ({ ...r, body_len: [...body].length })) };
    }],
    ["GET", /^\/objects\/([^/]+)\/history\/(\d+)$/, async (m) => {
      await find(m[1]);
      const [r] = await db.all<Record<string, unknown> & { properties: string }>(
        "SELECT version, title, body, properties, actor, created_at FROM history WHERE object_id = ? AND version = ?",
        [m[1], Number(m[2])]);
      if (!r) throw new HttpError(404, msg("versionNotFound"));
      return { version: { ...r, properties: parse(r.properties, {}) } };
    }],
    ["GET", /^\/objects\/([^/]+)\/history\/(\d+)\/diff$/, async (m, q) => {
      const o = await find(m[1]);
      const one = async (v: number) => (await db.all<{ version: number; title: string; body: string }>(
        "SELECT version, title, body FROM history WHERE object_id = ? AND version = ?", [m[1], v]))[0];
      const base = await one(Number(m[2]));
      if (!base) throw new HttpError(404, msg("versionNotFound"));
      let other = { title: o.title, body: o.body, label: "aktuell" };
      if (q.get("against") !== null) {
        const a = await one(Number(q.get("against")));
        if (!a) throw new HttpError(404, msg("compareNotFound"));
        other = { title: a.title, body: a.body, label: `v${a.version}` };
      }
      const ops = diffMarkdown(base.body, other.body);
      return { from: { version: base.version, title: base.title }, to: { label: other.label, title: other.title },
        ops, summary: summarize(ops) };
    }],
    ["POST", /^\/objects\/([^/]+)\/history\/(\d+)\/restore$/, async (m) => {
      await find(m[1]);
      const [snap] = await db.all<{ title: string; body: string; properties: string }>(
        "SELECT title, body, properties FROM history WHERE object_id = ? AND version = ?", [m[1], Number(m[2])]);
      if (!snap) throw new HttpError(404, msg("versionNotFound"));
      await db.run("UPDATE objects SET title = ?, body = ?, properties = ?, updated_at = ? WHERE id = ?",
        [snap.title, snap.body, snap.properties, now(), m[1]]);
      await postSave(m[1]);
      return { object: await full(m[1]) };
    }],
    ["PATCH", /^\/objects\/([^/]+)\/history\/(\d+)$/, async (m, _q, b) => {
      await find(m[1]);
      const name = [...String(b.name ?? "").trim()].slice(0, 120).join("") || null;
      const [hit] = await db.all("SELECT 1 FROM history WHERE object_id = ? AND version = ?", [m[1], Number(m[2])]);
      if (!hit) throw new HttpError(404, msg("versionNotFound"));
      await db.run("UPDATE history SET name = ? WHERE object_id = ? AND version = ?", [name, m[1], Number(m[2])]);
      return { ok: true };
    }],

    // ── Attachments ────────────────────────────────────────────────────────
    ["POST", /^\/objects\/([^/]+)\/attachments$/, async (m, _q, b) => {
      await find(m[1]);
      const file = b instanceof FormData ? b.get("file") : null;
      if (!(file instanceof File)) throw new HttpError(400, "Leere Datei");
      if (file.size > ATTACH_MAX) throw new HttpError(413, msg("fileTooLarge"));
      if (!file.size) throw new HttpError(400, "Leere Datei");
      const data = new Uint8Array(await file.arrayBuffer());
      const ctype = (file.type || "application/octet-stream").split(";")[0].trim().toLowerCase();
      const fname = [...(file.name || "datei").replace(/[^\p{L}\p{N}_.\-()+ ]/gu, "_")].slice(0, 180).join("") || "datei";
      const id = uuid();
      await db.run(
        "INSERT INTO attachments (id, object_id, filename, content_type, size_bytes, data, created_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, m[1], fname, ctype, data.length, toBase64(data), LOCAL_USER, now()]);
      return { attachment: { id, filename: fname, content_type: ctype, size_bytes: data.length,
        url: `/api/claraos/knowledge/attachments/${id}/${fname}` } };
    }],
    ["GET", /^\/objects\/([^/]+)\/attachments$/, async (m) => {
      await find(m[1]);
      const rows = await db.all<{ id: string; filename: string }>(
        "SELECT id, filename, content_type, size_bytes, created_by, created_at FROM attachments " +
          "WHERE object_id = ? ORDER BY created_at", [m[1]]);
      return { attachments: rows.map((r) => ({ ...r, url: `/api/claraos/knowledge/attachments/${r.id}/${r.filename}` })) };
    }],
    ["GET", /^\/attachments\/([^/]+)\/[^/]+$/, async (m) => {
      const [r] = await db.all<{ object_id: string; filename: string; content_type: string; data: string }>(
        "SELECT object_id, filename, content_type, data FROM attachments WHERE id = ?", [m[1]]);
      if (!r) throw new HttpError(404, msg("attachmentNotFound"));
      await find(r.object_id);
      const inline = ATTACH_INLINE.has(r.content_type);
      return new BinaryResult(fromBase64(r.data), inline ? r.content_type : "application/octet-stream",
        `${inline ? "inline" : "attachment"}; filename="${r.filename}"`);
    }],

    // ── Page templates ─────────────────────────────────────────────────────
    ["GET", /^\/templates$/, async (_m, q) => {
      const tt = q.get("target_type");
      const rows = await db.all<Record<string, unknown> & { default_properties: string; is_default: number }>(
        `SELECT * FROM templates ${tt ? "WHERE target_type = ?" : ""} ORDER BY is_default DESC, name`, tt ? [tt] : []);
      return { templates: rows.map((t) => ({ ...t, default_properties: parse(t.default_properties, {}),
        is_default: !!t.is_default })) };
    }],
    ["POST", /^\/templates$/, async (_m, _q, b) => {
      let body: string = b.body ?? "";
      let props: Record<string, unknown> = b.default_properties ?? {};
      let ttype: string | null = b.target_type ?? null;
      if (b.from_object_id) {
        const src = await find(b.from_object_id);
        body = src.body || "";
        ttype = ttype || src.type;
        props = parse(src.properties, {});
      }
      if (b.is_default && ttype) await db.run("UPDATE templates SET is_default = 0 WHERE target_type = ?", [ttype]);
      const id = uuid();
      const ts = now();
      const name = String(b.name ?? "").trim();
      await db.run(
        "INSERT INTO templates (id, owner, visibility, name, icon, target_type, body, default_properties, is_default, " +
          "created_at, updated_at) VALUES (?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, LOCAL_USER, name || "Vorlage", b.icon ?? null, ttype, body, JSON.stringify(props), b.is_default ? 1 : 0, ts, ts]);
      return { template: { id, name } };
    }],
    ["DELETE", /^\/templates\/([^/]+)$/, async (m) => {
      const [hit] = await db.all("SELECT 1 FROM templates WHERE id = ?", [m[1]]);
      if (!hit) throw new HttpError(404, msg("templateNotFound"));
      await db.run("DELETE FROM templates WHERE id = ?", [m[1]]);
      return { ok: true };
    }],
    ["POST", /^\/objects\/from-template$/, async (_m, _q, b) => {
      type T = { id: string; target_type: string | null; body: string; default_properties: string };
      let t: T | undefined;
      if (b.template_id) {
        [t] = await db.all<T>("SELECT * FROM templates WHERE id = ?", [b.template_id]);
        if (!t) throw new HttpError(404, msg("templateNotFound"));
      } else {
        [t] = await db.all<T>("SELECT * FROM templates WHERE target_type = ? AND is_default = 1 LIMIT 1", [b.type ?? null]);
      }
      if (b.collection_id) await fetchColl(b.collection_id);
      const res = await handlers.createObject({
        type: t?.target_type || b.type || "note", title: b.title, body: t?.body ?? "",
        properties: t ? parse(t.default_properties, {}) : {}, parent_id: b.parent_id ?? null,
      });
      if (b.collection_id) {
        await db.run("INSERT OR IGNORE INTO collection_items (collection_id, object_id, position) VALUES (?, ?, 0)",
          [b.collection_id, res.object.id]);
      }
      return { object: await full(res.object.id), from_template: t?.id ?? null };
    }],

    // ── Databases: fields, views, rows ─────────────────────────────────────
    ["GET", /^\/collections\/([^/]+)\/fields$/, async (m) => {
      await fetchColl(m[1]);
      return { fields: (await ensureFields(m[1])).map(fieldOut) };
    }],
    ["POST", /^\/collections\/([^/]+)\/fields$/, async (m, _q, b) => {
      const ft = Number(b.field_type ?? 0);
      if (!Number.isInteger(ft) || ft < 0 || ft > 14) throw new HttpError(400, `Unbekannter field_type: ${b.field_type}`);
      checkFormulaOption(ft, b.type_option);
      const key = [...String(b.key ?? "").trim().replace(/[^\p{L}\p{N}_-]/gu, "_")].slice(0, 64).join("");
      if (!key) throw new HttpError(400, "key darf nicht leer sein");
      await fetchColl(m[1]);
      await ensureFields(m[1]);
      const ts = now();
      const [existing] = await db.all<{ id: string }>("SELECT id FROM fields WHERE collection_id = ? AND key = ?", [m[1], key]);
      if (existing) {
        await db.run("UPDATE fields SET name = ?, field_type = ?, type_option = ?, updated_at = ? WHERE id = ?",
          [String(b.name ?? "").trim(), ft, JSON.stringify(b.type_option ?? {}), ts, existing.id]);
      } else {
        await db.run(
          "INSERT INTO fields (id, collection_id, key, name, field_type, type_option, is_primary, position, created_at, " +
            "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [uuid(), m[1], key, String(b.name ?? "").trim(), ft, JSON.stringify(b.type_option ?? {}), b.is_primary ? 1 : 0,
            await nextColumnPosition("fields", m[1]), ts, ts]);
      }
      const [row] = await db.all<FieldRow>("SELECT * FROM fields WHERE collection_id = ? AND key = ?", [m[1], key]);
      return { field: fieldOut(row) };
    }],
    ["PATCH", /^\/collections\/([^/]+)\/fields\/([^/]+)$/, async (m, _q, b) => {
      if (b.field_type != null && !(Number.isInteger(b.field_type) && b.field_type >= 0 && b.field_type <= 14)) {
        throw new HttpError(400, `Unbekannter field_type: ${b.field_type}`);
      }
      if (b.type_option != null && b.field_type != null) checkFormulaOption(b.field_type, b.type_option);
      await fetchColl(m[1]);
      const sets = ["updated_at = ?"];
      const params: SqlValue[] = [now()];
      for (const col of ["name", "field_type"]) {
        if (b[col] != null) {
          sets.push(`${col} = ?`);
          params.push(b[col]);
        }
      }
      if (b.type_option != null) {
        sets.push("type_option = ?");
        params.push(JSON.stringify(b.type_option));
      }
      params.push(m[2], m[1]);
      await db.run(`UPDATE fields SET ${sets.join(", ")} WHERE id = ? AND collection_id = ?`, params);
      const [row] = await db.all<FieldRow>("SELECT * FROM fields WHERE id = ? AND collection_id = ?", [m[2], m[1]]);
      if (!row) throw new HttpError(404, msg("fieldNotFound"));
      return { field: fieldOut(row) };
    }],
    ["DELETE", /^\/collections\/([^/]+)\/fields\/([^/]+)$/, async (m) => {
      // Only the definition; the values stay in the properties (same key restores them).
      await fetchColl(m[1]);
      await db.run("DELETE FROM fields WHERE id = ? AND collection_id = ?", [m[2], m[1]]);
      return { ok: true };
    }],
    ["GET", /^\/collections\/([^/]+)\/views$/, async (m) => {
      const coll = await fetchColl(m[1]);
      const q = "SELECT * FROM views WHERE collection_id = ? ORDER BY position IS NULL, position, created_at";
      let rows = await db.all<ViewRow>(q, [m[1]]);
      if (!rows.length) {
        const ts = now();
        await db.run(
          "INSERT INTO views (id, collection_id, name, layout, position, created_by, created_at, updated_at) " +
            "VALUES (?, ?, ?, 'table', ?, ?, ?, ?)",
          [uuid(), m[1], msg("allEntries"), await nextColumnPosition("views", m[1]), coll.owner, ts, ts]);
        rows = await db.all<ViewRow>(q, [m[1]]);
      }
      return { views: rows.map(viewOut) };
    }],
    ["POST", /^\/collections\/([^/]+)\/views$/, async (m, _q, b) => {
      const layout = b.layout ?? "table";
      if (!LAYOUTS.includes(layout)) throw new HttpError(400, `Ungültiger Wert für layout: '${layout}'`);
      await fetchColl(m[1]);
      const id = uuid();
      const ts = now();
      await db.run(
        "INSERT INTO views (id, collection_id, name, layout, layout_setting, filters, sorts, group_setting, " +
          "field_settings, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, m[1], String(b.name ?? "").trim() || "Ansicht", layout, JSON.stringify(b.layout_setting ?? {}),
          JSON.stringify(b.filters ?? {}), JSON.stringify(b.sorts ?? []), JSON.stringify(b.group_setting ?? {}),
          JSON.stringify(b.field_settings ?? {}), await nextColumnPosition("views", m[1]), LOCAL_USER, ts, ts]);
      const [row] = await db.all<ViewRow>("SELECT * FROM views WHERE id = ?", [id]);
      return { view: viewOut(row) };
    }],
    ["PATCH", /^\/collections\/([^/]+)\/views\/([^/]+)$/, async (m, _q, b) => {
      if (b.layout != null && !LAYOUTS.includes(b.layout)) throw new HttpError(400, `Ungültiger Wert für layout: '${b.layout}'`);
      await fetchColl(m[1]);
      const sets = ["updated_at = ?"];
      const params: SqlValue[] = [now()];
      if (b.name != null) { sets.push("name = ?"); params.push(String(b.name).trim()); }
      if (b.layout != null) { sets.push("layout = ?"); params.push(b.layout); }
      for (const col of ["layout_setting", "filters", "group_setting", "field_settings", "sorts"]) {
        if (b[col] != null) {
          sets.push(`${col} = ?`);
          params.push(JSON.stringify(b[col]));
        }
      }
      params.push(m[2], m[1]);
      await db.run(`UPDATE views SET ${sets.join(", ")} WHERE id = ? AND collection_id = ?`, params);
      const [row] = await db.all<ViewRow>("SELECT * FROM views WHERE id = ? AND collection_id = ?", [m[2], m[1]]);
      if (!row) throw new HttpError(404, msg("viewNotFound"));
      return { view: viewOut(row) };
    }],
    ["DELETE", /^\/collections\/([^/]+)\/views\/([^/]+)$/, async (m) => {
      await fetchColl(m[1]);
      const [{ n }] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM views WHERE collection_id = ?", [m[1]]);
      if (n <= 1) throw new HttpError(400, msg("lastView"));
      await db.run("DELETE FROM views WHERE id = ? AND collection_id = ?", [m[2], m[1]]);
      return { ok: true };
    }],
    ["GET", /^\/collections\/([^/]+)\/rows$/, async (m, q) => {
      await fetchColl(m[1]);
      const fields = await ensureFields(m[1]);
      const view = await viewOf(m[1], q.get("view_id"));
      const filters = view ? parse(view.filters, {}) : {};
      const sorts = view ? parse(view.sorts, []) : [];
      const limit = Math.max(1, Math.min(Number(q.get("limit") ?? 200), 500));
      let rows = await collectionRows(m[1]);
      try {
        // "today" is the device's calendar day (the server uses UTC)
        rows = queryRows(rows as never, filters, sorts, fieldTypes(fields), undefined, "local") as never;
      } catch (e) {
        asFilterError(e);
      }
      rows = rows.slice(0, limit);
      const rollups = await rollupValues(rows, fields);
      const formulaFields = fields.filter((f) => f.field_type === FT_FORMULA);
      return {
        rows: rows.map(({ item_position: _p, ...r }) => {
          const out: Record<string, unknown> = { ...r };
          if (rollups[r.id]) out.rollups = rollups[r.id];
          if (formulaFields.length) {
            out.formulas = formulaValues(r.properties as Record<string, unknown>, rollups[r.id] ?? {}, formulaFields);
          }
          return out;
        }),
        fields: fields.map(fieldOut),
        view_id: view ? view.id : null,
      };
    }],
    ["POST", /^\/collections\/([^/]+)\/formula\/preview$/, async (m, _q, b) => {
      const problem = formulaProblem(String(b.expression ?? ""));
      if (problem !== null) return { ok: false, fehler: problem, proben: [] };
      await fetchColl(m[1]);
      const fields = await ensureFields(m[1]);
      const n = Math.max(1, Math.min(Number(b.limit ?? 3), 5));
      const rows = (await collectionRows(m[1]))
        .sort((x, y) => (x.updated_at < y.updated_at ? 1 : x.updated_at > y.updated_at ? -1 : 0)).slice(0, n);
      const rollups = await rollupValues(rows, fields);
      return {
        ok: true, fehler: null,
        proben: rows.map((r) => ({
          titel: r.title,
          wert: formulaCell(String(b.expression), r.properties as Record<string, unknown>, rollups[r.id] ?? {}),
        })),
      };
    }],
    ["GET", /^\/collections\/([^/]+)\/aggregate$/, async (m, q) => {
      await fetchColl(m[1]);
      const fields = await ensureFields(m[1]);
      const key = q.get("key") ?? "";
      const agg = q.get("agg") ?? "count";
      if (!fields.some((f) => f.key === key)) throw new HttpError(400, `Unbekanntes Feld: '${key}'`);
      const view = await viewOf(m[1], q.get("view_id")).catch(() => null);
      const rows = await collectionRows(m[1]);
      let value: number | null = null;
      try {
        value = aggregateQuery(rows as never, agg, key, view ? parse(view.filters, {}) : {}, fieldTypes(fields),
          undefined, "local");
      } catch (e) {
        asFilterError(e);
      }
      return { key, aggregate: agg, value: value ?? null };
    }],
    ["PUT", /^\/objects\/([^/]+)\/relations$/, async (m, _q, b) => {
      const cur = await find(m[1]);
      const targets: string[] = (Array.isArray(b.target_ids) ? b.target_ids : []).slice(0, 100);
      for (const t of targets) if (!UUID_RE.test(String(t))) throw new HttpError(400, "Ungültige target_id");
      const keep = targets.length ? (await db.all<{ id: string }>(
        `SELECT id FROM objects WHERE deleted_at IS NULL AND id IN (${targets.map(() => "?").join(",")})`, targets))
        .map((r) => r.id) : [];
      // Request order (the server's lookup has no defined order; the caller's is the useful one)
      const ordered = targets.filter((t) => keep.includes(t));
      const props = { ...parse<Record<string, unknown>>(cur.properties, {}), [b.field_key]: ordered };
      await db.run("UPDATE objects SET properties = ?, updated_at = ? WHERE id = ?", [JSON.stringify(props), now(), m[1]]);
      await db.run("DELETE FROM refs WHERE src_object_id = ? AND kind = 'relation_prop'", [m[1]]);
      for (const t of ordered) {
        if (t === m[1]) continue;
        await db.run("INSERT OR IGNORE INTO refs (src_object_id, target_object_id, kind, anchor_text) " +
          "VALUES (?, ?, 'relation_prop', ?)", [m[1], t, b.field_key]);
      }
      return { ok: true, linked: ordered, skipped: targets.length - ordered.length };
    }],

    // ── Import / export ────────────────────────────────────────────────────
    ["POST", /^\/import$/, async (_m, _q, b) => {
      const file = b instanceof FormData ? b.get("file") : null;
      if (!(file instanceof File)) throw new HttpError(400, msg("zipUnreadable", { error: "keine Datei" }));
      if (file.size > 80 * 1024 * 1024) throw new HttpError(413, msg("archiveTooLarge"));
      let parsed: ReturnType<typeof parseZip>;
      try {
        parsed = parseZip(new Uint8Array(await file.arrayBuffer()));
      } catch (e) {
        throw new HttpError(400, msg("zipUnreadable", { error: e instanceof Error ? e.message : String(e) }));
      }
      const idMap = new Map<string, string>();
      const pages: [string, (typeof parsed.pages)[number]][] = [];
      let rowsCreated = 0, collsCreated = 0;
      const insertObject = async (title: string, body: string, props: Record<string, unknown>) => {
        const id = uuid();
        const ts = now();
        await db.run(`INSERT INTO objects (${COLS}) VALUES (?, 'note', ?, 'private', ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
          [id, LOCAL_USER, title, body, JSON.stringify(props), LOCAL_USER, ts, ts]);
        return id;
      };
      for (const p of parsed.pages) {
        const id = await insertObject(p.title, p.body, {});
        pages.push([id, p]);
        if (p.notion_id) idMap.set(p.notion_id, id);
      }
      for (const [id, p] of pages) {
        const parent = p.parent_notion_id ? idMap.get(p.parent_notion_id) : undefined;
        if (parent && parent !== id) {
          await db.run("UPDATE objects SET parent_id = ?, position = ? WHERE id = ?", [parent, await nextPosition(parent), id]);
        }
      }
      const keyOf = (s: string) => [...s.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, "_")].slice(0, 64).join("");
      for (const d of parsed.databases) {
        const cid = uuid();
        const ts = now();
        await db.run("INSERT INTO collections (id, owner, visibility, name, default_type, settings, created_at, updated_at) " +
          "VALUES (?, ?, 'private', ?, 'note', '{}', ?, ?)", [cid, LOCAL_USER, d.name, ts, ts]);
        collsCreated++;
        for (const col of d.columns) {
          const key = keyOf(col) || "feld";
          await db.run("INSERT OR IGNORE INTO fields (id, collection_id, key, name, field_type, type_option, position, " +
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)",
            [uuid(), cid, key, [...col.trim()].slice(0, 120).join("") || key,
              guessFieldType(d.rows.map((r) => r.props[col] ?? "")), await nextColumnPosition("fields", cid), ts, ts]);
        }
        for (const r of d.rows) {
          const props = Object.fromEntries(Object.entries(r.props).map(([k, v]) => [keyOf(k), v]));
          const oid = await insertObject(r.title, "", props);
          await db.run("INSERT OR IGNORE INTO collection_items (collection_id, object_id, position) VALUES (?, ?, ?)",
            [cid, oid, rowsCreated]);
          rowsCreated++;
          await postSave(oid);
        }
      }
      let rewritten = 0;
      for (const [id, p] of pages) {
        const nb = rewriteLinks(p.body, idMap);
        if (nb !== p.body) {
          await db.run("UPDATE objects SET body = ? WHERE id = ?", [nb, id]);
          rewritten++;
        }
        await postSave(id);
      }
      return { ok: true, pages: pages.length, collections: collsCreated, rows: rowsCreated, links_rewritten: rewritten };
    }],
    ["GET", /^\/export$/, async (_m, q) => {
      const cid = q.get("collection_id");
      let objs: ObjRow[];
      let colls: { name: string; columns: string[]; rows: { title: string; props: Record<string, string> }[] }[] = [];
      if (cid) {
        const coll = await fetchColl(cid);
        objs = await db.all<ObjRow>(
          `SELECT ${COLS.split(", ").map((c) => "o." + c).join(", ")} FROM objects o JOIN collection_items ci
           ON ci.object_id = o.id WHERE ci.collection_id = ? AND o.deleted_at IS NULL ORDER BY ci.position`, [cid]);
        const fields = await ensureFields(cid);
        const cols = fields.map((f) => f.name);
        colls = [{ name: coll.name, columns: cols, rows: objs.map((o) => {
          const p = parse<Record<string, unknown>>(o.properties, {});
          return { title: o.title, props: Object.fromEntries(fields.map((f) => [f.name, pyStr(p[f.key] ?? "")])) };
        }) }];
      } else {
        objs = await db.all<ObjRow>(`SELECT ${COLS} FROM objects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 2000`);
      }
      const zip = buildExportZip(objs.map((o) => ({ title: o.title, body: o.body, properties: parse(o.properties, {}) })), colls);
      const stamp = new Date().toISOString().slice(0, 10);
      return new BinaryResult(zip, "application/zip", `attachment; filename="knowledge-export-${stamp}.zip"`);
    }],

    ["GET", /^\/search$/, async (_m, q) => {
      const text = ftsQuery(q.get("q") ?? "");
      if (!text) return { results: [] };
      const params: SqlValue[] = [text];
      let typeFilter = "";
      if (q.get("type")) {
        typeFilter = "AND o.type = ?";
        params.push(q.get("type"));
      }
      const rows = await db.all<ObjRow & { snippet: string }>(
        `SELECT ${COLS.split(", ").map((c) => "o." + c).join(", ")},
                snippet(objects_fts, '', '', '…', -1, 24) AS snippet
         FROM objects_fts JOIN objects o ON o.seq = objects_fts.docid
         WHERE objects_fts MATCH ? AND o.deleted_at IS NULL ${typeFilter}
         ORDER BY o.updated_at DESC LIMIT 50`, params);
      return { results: rows.map((r) => ({ ...slim(r), snippet: r.snippet })) };
    }],
    ["GET", /^\/notifications$/, async () => ({ notifications: [] })],
    ["POST", /^\/notifications\/read$/, async () => ({ ok: true })],
    ["GET", /^\/knowledge-graph$/, async () => {
      const objs = await db.all<{ id: string; title: string; type: string; icon: string | null; parent_id: string | null }>(
        "SELECT id, title, type, icon, parent_id FROM objects WHERE deleted_at IS NULL");
      return {
        nodes: objs.map(({ parent_id: _p, ...n }) => n),
        edges: objs.filter((o) => o.parent_id).map((o) => ({ from: o.parent_id!, to: o.id, kind: "child" })),
      };
    }],
    ["GET", /^\/graph$/, async () => ({
      objects: (await db.all<ObjRow>(`SELECT ${COLS} FROM objects WHERE deleted_at IS NULL`)).map(slim),
      links: await db.all("SELECT id, from_id, to_id, rel FROM links"),
    })],
  );

  /** Answers one request against the local database, shaped like a fetch Response. */
  return async function handle(method: string, path: string, query: URLSearchParams, body: unknown): Promise<Response> {
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    for (const [verb, re, fn] of routes) {
      if (verb !== method) continue;
      const m = path.match(re);
      if (!m) continue;
      try {
        const out = await fn(m, query, body ?? {});
        if (out instanceof BinaryResult) {
          return new Response(new Uint8Array(out.data), { status: 200, headers: {
            "Content-Type": out.contentType, "Content-Disposition": out.disposition,
            "X-Content-Type-Options": "nosniff" } });
        }
        return json(200, out);
      } catch (e) {
        if (e instanceof HttpError) return json(e.status, { detail: e.message });
        console.error("local knowledge api", method, path, e);
        return json(500, { detail: "Interner Fehler in der lokalen Datenbank" });
      }
    }
    return json(501, { detail: "In der lokalen Version nicht verfügbar" });
  };
}
