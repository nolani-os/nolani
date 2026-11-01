/**
 * Local HTTP API, web side: settings and the bridge to the data layer.
 *
 * The native side (src-tauri/src/api.rs) listens on 127.0.0.1, checks key,
 * Host and Origin, and hands each request over as an event. Here it is
 * answered by the same `createLocalApi` handler the UI uses, so the API and
 * the app can never disagree. Desktop only: phones end background apps, an
 * API that is there only while the app is in front is not worth offering.
 */
import type { Db } from "./local/db";
import { isTauri } from "./local/db";

export type LocalHandler = (method: string, path: string, query: URLSearchParams, body: unknown) => Promise<Response>;

export interface ApiSettings {
  enabled: boolean;
  port: number;
  token: string;
}

export const DEFAULT_PORT = 7311;

export function apiAvailable(): boolean {
  return isTauri() && !/Android|iPhone|iPad/i.test(navigator.userAgent);
}

/** 32 random bytes as hex: the key other programs send as `Bearer`. */
export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadSettings(db: Db): Promise<ApiSettings> {
  const rows = await db.all<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key IN ('api_enabled', 'api_port', 'api_token')");
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let token = v.api_token;
  if (!token) {
    token = newToken();
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('api_token', ?)", [token]);
  }
  const port = Number(v.api_port);
  return { enabled: v.api_enabled === "1", port: Number.isInteger(port) && port >= 1024 ? port : DEFAULT_PORT, token };
}

export async function saveSettings(db: Db, s: ApiSettings): Promise<void> {
  for (const [k, val] of [["api_enabled", s.enabled ? "1" : "0"], ["api_port", String(s.port)], ["api_token", s.token]]) {
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [k, val]);
  }
}

/** Starts or stops the native listener to match the settings. Returns the port it runs on, or null. */
export async function applySettings(s: ApiSettings): Promise<number | null> {
  if (!apiAvailable()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  if (!s.enabled) {
    await invoke("api_stop");
    return null;
  }
  return await invoke<number>("api_start", { port: s.port, token: s.token });
}

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type Incoming = { id: number; method: string; path: string; query: string; content_type: string; body_b64: string };

/** Answers native API requests with the local data layer (once per app start). */
export async function startBridge(handle: LocalHandler): Promise<void> {
  if (!apiAvailable()) return;
  const { listen } = await import("@tauri-apps/api/event");
  const { invoke } = await import("@tauri-apps/api/core");
  await listen<Incoming>("local-api-request", async ({ payload: r }) => {
    let res: Response;
    try {
      const bytes = b64ToBytes(r.body_b64);
      let body: unknown;
      if (bytes.length) {
        if (r.content_type.toLowerCase().startsWith("multipart/form-data")) {
          body = await new Response(bytes, { headers: { "Content-Type": r.content_type } }).formData();
        } else {
          body = JSON.parse(new TextDecoder().decode(bytes));
        }
      }
      let path = r.path || "/";
      try {
        path = decodeURI(path);
      } catch {
        /* keep the raw path */
      }
      res = await handle(r.method, path, new URLSearchParams(r.query), body);
    } catch (e) {
      res = new Response(JSON.stringify({ detail: e instanceof SyntaxError ? "Body must be JSON" : String(e) }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    const data = new Uint8Array(await res.arrayBuffer());
    await invoke("api_respond", {
      id: r.id,
      reply: {
        status: res.status,
        content_type: res.headers.get("Content-Type") ?? "application/json",
        disposition: res.headers.get("Content-Disposition"),
        body_b64: bytesToB64(data),
      },
    });
  });
}
