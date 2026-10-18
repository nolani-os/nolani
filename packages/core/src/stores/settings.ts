/**
 * Settings v2 client.
 *
 * The server is the source: schema (categories/modules/field definitions) and
 * values come from /api/claraos/settings. No IndexedDB persistence — otherwise
 * we would again have two sources of truth, as with the old prefs path.
 *
 * Draft model (KDE needsSave/representsDefaults):
 *   values  = state last confirmed by the server
 *   drafts  = the user's unsaved changes
 *   isDirty = drafts != values → apply/discard bar + navigation guard
 */
import { create } from "zustand";

export type SettingType = "bool" | "int" | "float" | "string" | "enum" | "color" | "json";

export interface SettingDef {
  key: string;
  type: SettingType;
  default: unknown;
  label: string;
  description: string;
  min: number | null;
  max: number | null;
  choices: string[];
  dependsOn: string;
}

export interface SettingsModuleDef {
  id: string;
  name: string;
  icon: string;
  category: string;
  weight: number;
  keywords: string[];
  component: string;
  formFactors: string[];
  settings: SettingDef[];
}

export interface SettingsCategoryDef {
  id: string;
  name: string;
  icon: string;
  weight: number;
  parent: string;
  ownerModule: string;
}

type Values = Record<string, unknown>;

interface SettingsStore {
  loaded: boolean;
  categories: SettingsCategoryDef[];
  modules: SettingsModuleDef[];
  /** module -> values confirmed by the server */
  values: Record<string, Values>;
  /** module -> unsaved changes */
  drafts: Record<string, Values>;
  /** module -> keys that differ from the default (for badges) */
  changed: Record<string, string[]>;
  error: string;

  loadSchema: () => Promise<void>;
  loadModule: (moduleId: string) => Promise<void>;
  loadDiff: () => Promise<void>;
  setDraft: (moduleId: string, key: string, value: unknown) => void;
  discard: (moduleId: string) => void;
  apply: (moduleId: string) => Promise<boolean>;
  resetKey: (moduleId: string, key: string) => Promise<void>;
  resetModule: (moduleId: string) => Promise<void>;
  connectWs: () => () => void;

  // Selectors
  moduleById: (moduleId: string) => SettingsModuleDef | undefined;
  effective: (moduleId: string) => Values;
  isDirty: (moduleId: string) => boolean;
  isDefaultValue: (moduleId: string, key: string) => boolean;
  search: (query: string) => SettingsModuleDef[];
}

const API = "/api/claraos/settings";

/** KRunner-Scoring (systemsettings/runner): exact 1.0, prefix 0.8, keyword 0.2-0.5. */
function score(mod: SettingsModuleDef, q: string): number {
  const name = mod.name.toLowerCase();
  if (name === q) return 1.0;
  if (name.startsWith(q)) return 0.9;
  let best = 0;
  if (name.includes(q)) best = 0.6;
  for (const kw of mod.keywords) {
    const k = kw.toLowerCase();
    if (k === q) best = Math.max(best, 0.5);
    else if (k.startsWith(q)) best = Math.max(best, 0.35);
    else if (q.length >= 3 && k.includes(q)) best = Math.max(best, 0.2);
  }
  for (const s of mod.settings) {
    if (s.label.toLowerCase().includes(q)) best = Math.max(best, 0.3);
  }
  return best;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  loaded: false,
  categories: [],
  modules: [],
  values: {},
  drafts: {},
  changed: {},
  error: "",

  loadSchema: async () => {
    try {
      const res = await fetch(`${API}/schema`);
      if (!res.ok) throw new Error(`schema ${res.status}`);
      const data = await res.json();
      set({
        categories: data.categories ?? [],
        modules: data.modules ?? [],
        loaded: true,
        error: "",
      });
    } catch (e) {
      set({ error: `Einstellungen konnten nicht geladen werden: ${String(e)}`, loaded: true });
    }
  },

  loadModule: async (moduleId) => {
    try {
      const res = await fetch(`${API}/${moduleId}`);
      if (!res.ok) throw new Error(`module ${res.status}`);
      const data = await res.json();
      set((s) => ({
        values: { ...s.values, [moduleId]: data.values ?? {} },
        drafts: { ...s.drafts, [moduleId]: {} },
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadDiff: async () => {
    try {
      const res = await fetch(`${API}/diff`);
      if (!res.ok) return;
      const data = await res.json();
      set({ changed: data.changed ?? {} });
    } catch {
      /* badges are optional — do not escalate errors */
    }
  },

  setDraft: (moduleId, key, value) =>
    set((s) => ({
      drafts: { ...s.drafts, [moduleId]: { ...(s.drafts[moduleId] ?? {}), [key]: value } },
    })),

  discard: (moduleId) => set((s) => ({ drafts: { ...s.drafts, [moduleId]: {} } })),

  apply: async (moduleId) => {
    const draft = get().drafts[moduleId] ?? {};
    if (Object.keys(draft).length === 0) return true;
    try {
      const res = await fetch(`${API}/${moduleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        set({ error: body.detail ?? `Speichern fehlgeschlagen (${res.status})` });
        return false;
      }
      set((s) => ({
        values: { ...s.values, [moduleId]: { ...(s.values[moduleId] ?? {}), ...draft } },
        drafts: { ...s.drafts, [moduleId]: {} },
        error: "",
      }));
      await get().loadDiff();
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  resetKey: async (moduleId, key) => {
    await fetch(`${API}/${moduleId}/${key}`, { method: "DELETE" });
    await get().loadModule(moduleId);
    await get().loadDiff();
  },

  resetModule: async (moduleId) => {
    await fetch(`${API}/${moduleId}`, { method: "DELETE" });
    await get().loadModule(moduleId);
    await get().loadDiff();
  },

  /** WS back channel: another window/device changed something → reload. */
  connectWs: () => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      try {
        ws = new WebSocket(`${proto}//${location.host}${API}/ws`);
      } catch {
        return;
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "settings.changed" && msg.module) {
            // The user's unsaved drafts win — only re-fetch confirmed values.
            void get().loadModule(msg.module);
            void get().loadDiff();
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(open, 5000);
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  },

  moduleById: (moduleId) => get().modules.find((m) => m.id === moduleId),

  effective: (moduleId) => {
    const s = get();
    return { ...(s.values[moduleId] ?? {}), ...(s.drafts[moduleId] ?? {}) };
  },

  isDirty: (moduleId) => Object.keys(get().drafts[moduleId] ?? {}).length > 0,

  isDefaultValue: (moduleId, key) => {
    const mod = get().moduleById(moduleId);
    const def = mod?.settings.find((s) => s.key === key);
    if (!def) return true;
    return get().effective(moduleId)[key] === def.default;
  },

  search: (query) => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return get()
      .modules.map((m) => ({ m, s: score(m, q) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.m);
  },
}));

/** Hook facade for individual fields (analogous to KDE SettingStateBinding). */
export function useSetting(moduleId: string, key: string) {
  const store = useSettingsStore();
  const mod = store.moduleById(moduleId);
  const def = mod?.settings.find((s) => s.key === key);
  const value = store.effective(moduleId)[key] ?? def?.default;
  const enabled = !def?.dependsOn || Boolean(store.effective(moduleId)[def.dependsOn]);
  return {
    def,
    value,
    enabled,
    isDefault: store.isDefaultValue(moduleId, key),
    setValue: (v: unknown) => store.setDraft(moduleId, key, v),
    reset: () => store.resetKey(moduleId, key),
  };
}
