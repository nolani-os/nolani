/**
 * SQLite access for the standalone Knowledge app — one interface, two drivers.
 *
 * - native (Tauri): a real database file in the app's data directory via
 *   tauri-plugin-sql. Durable, survives WebView storage clearing (iOS does that).
 * - browser (PWA, development, tests): SQLite compiled to WebAssembly (sql.js);
 *   the database image is persisted to IndexedDB after every write.
 *
 * Both run the same SQL (positional `?` parameters, FTS4, JSON functions), so
 * the API handlers do not know which one they talk to.
 */
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

export type SqlValue = string | number | null;

export interface Db {
  /** Runs a statement; resolves once the change is durable. */
  run(sql: string, params?: SqlValue[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  readonly driver: "native" | "wasm";
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function openDb(): Promise<Db> {
  return isTauri() ? openNative() : openWasm();
}

async function openNative(): Promise<Db> {
  const { default: Database } = await import("@tauri-apps/plugin-sql");
  const db = await Database.load("sqlite:knowledge.db");
  return {
    driver: "native",
    run: async (sql, params = []) => {
      await db.execute(sql, params);
    },
    all: (sql, params = []) => db.select(sql, params),
  };
}

const IDB_NAME = "nolani-knowledge";
const IDB_STORE = "sqlite";
const IDB_KEY = "image";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function openWasm(): Promise<Db> {
  const { default: initSqlJs } = await import("sql.js");
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const store = await idb();
  const image = await new Promise<Uint8Array | undefined>((resolve, reject) => {
    const req = store.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result as Uint8Array | undefined);
    req.onerror = () => reject(req.error);
  });
  const db = new SQL.Database(image);

  // Writes arriving close together share one save; each caller resolves only
  // after the transaction that contains its change has committed.
  let pending: Promise<void> | null = null;
  function persist(): Promise<void> {
    if (pending) return pending;
    pending = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        pending = null;
        const tx = store.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(db.export(), IDB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }, 30);
    });
    return pending;
  }

  return {
    driver: "wasm",
    run: async (sql, params = []) => {
      db.run(sql, params);
      await persist();
    },
    all: async <T,>(sql: string, params: SqlValue[] = []) => {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        const rows: T[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
        return rows;
      } finally {
        stmt.free();
      }
    },
  };
}
