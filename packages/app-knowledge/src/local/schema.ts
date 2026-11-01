/**
 * Schema of the device-local knowledge database, versioned via PRAGMA user_version.
 *
 * Columns follow the server tables (claraos_kb_*) so a later sync maps 1:1:
 * UUID text ids, ISO timestamps, JSON as text, soft delete via deleted_at.
 * `seq` is an explicit integer key so the full-text index keeps pointing at the
 * right row (implicit rowids may be renumbered by VACUUM).
 */
import type { Db } from "./db";

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE objects (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      owner TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      properties TEXT NOT NULL DEFAULT '{}',
      stage TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      parent_id TEXT,
      position TEXT,
      icon TEXT,
      cover TEXT
    )`,
    `CREATE INDEX objects_parent ON objects(parent_id, position)`,
    `CREATE INDEX objects_updated ON objects(updated_at)`,
    `CREATE TABLE types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      owner TEXT,
      prop_schema TEXT NOT NULL DEFAULT '[]'
    )`,
    `CREATE TABLE collections (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      name TEXT NOT NULL,
      icon TEXT,
      description TEXT,
      default_type TEXT,
      settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE collection_items (
      collection_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (collection_id, object_id)
    )`,
    `CREATE TABLE favorites (object_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
    `CREATE TABLE links (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      rel TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    // FTS4 (not FTS5): the WebAssembly build ships only FTS3/4.
    `CREATE VIRTUAL TABLE objects_fts USING fts4(content="objects", title, body, tokenize=unicode61)`,
    `CREATE TRIGGER objects_bu BEFORE UPDATE ON objects BEGIN DELETE FROM objects_fts WHERE docid = old.seq; END`,
    `CREATE TRIGGER objects_bd BEFORE DELETE ON objects BEGIN DELETE FROM objects_fts WHERE docid = old.seq; END`,
    `CREATE TRIGGER objects_au AFTER UPDATE ON objects BEGIN INSERT INTO objects_fts(docid, title, body) VALUES (new.seq, new.title, new.body); END`,
    `CREATE TRIGGER objects_ai AFTER INSERT ON objects BEGIN INSERT INTO objects_fts(docid, title, body) VALUES (new.seq, new.title, new.body); END`,
  ],
  // 2: databases (fields, views), references, history, attachments, page templates
  [
    `CREATE TABLE fields (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      field_type INTEGER NOT NULL DEFAULT 0,
      type_option TEXT NOT NULL DEFAULT '{}',
      is_primary INTEGER NOT NULL DEFAULT 0,
      position TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (collection_id, key)
    )`,
    `CREATE TABLE views (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      name TEXT NOT NULL,
      layout TEXT NOT NULL DEFAULT 'table',
      layout_setting TEXT NOT NULL DEFAULT '{}',
      filters TEXT NOT NULL DEFAULT '{}',
      sorts TEXT NOT NULL DEFAULT '[]',
      group_setting TEXT NOT NULL DEFAULT '{}',
      field_settings TEXT NOT NULL DEFAULT '{}',
      position TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE refs (
      src_object_id TEXT NOT NULL,
      target_object_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      anchor_text TEXT,
      PRIMARY KEY (src_object_id, target_object_id, kind)
    )`,
    `CREATE INDEX refs_target ON refs(target_object_id)`,
    `CREATE TABLE history (
      object_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      properties TEXT NOT NULL DEFAULT '{}',
      actor TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (object_id, version)
    )`,
    // File content as base64 text: the native driver passes parameters as JSON
    // and has no binary type.
    `CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX attachments_object ON attachments(object_id)`,
    `CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      name TEXT NOT NULL,
      icon TEXT,
      target_type TEXT,
      body TEXT NOT NULL DEFAULT '',
      default_properties TEXT NOT NULL DEFAULT '{}',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX links_unique ON links(from_id, to_id, rel)`,
  ],
  // 3: device settings (local API)
  [
    `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ],
];

const SYSTEM_TYPES: [string, string, string][] = [
  ["note", "Notiz", "📝"],
  ["research", "Recherche", "🔎"],
  ["item", "Gegenstand", "📦"],
  ["comparison", "Vergleichs-Option", "⚖️"],
  ["trip", "Reise", "✈️"],
  ["idea", "Idee", "💡"],
];

/** Brings the database to the newest schema (`upTo` only for upgrade tests). */
export async function migrate(db: Db, upTo: number = MIGRATIONS.length): Promise<void> {
  const [{ user_version: version }] = await db.all<{ user_version: number }>("PRAGMA user_version");
  for (let v = version; v < Math.min(upTo, MIGRATIONS.length); v++) {
    for (const sql of MIGRATIONS[v]) await db.run(sql);
    await db.run(`PRAGMA user_version = ${v + 1}`);
  }
  for (const [id, name, icon] of SYSTEM_TYPES) {
    await db.run(
      "INSERT OR IGNORE INTO types (id, name, icon, is_system, prop_schema) VALUES (?, ?, ?, 1, '[]')",
      [id, name, icon],
    );
  }
}
