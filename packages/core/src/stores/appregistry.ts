import { create } from "zustand";
import type { AppManifest, AppCategory } from "../types";
import { i18n } from "../i18n";

export interface AppRegistryState {
  apps: Record<string, AppManifest>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export interface AppRegistryActions {
  loadApps: () => Promise<void>;
  reloadApps: () => Promise<void>;
  getApp: (id: string) => AppManifest | undefined;
  getAllApps: () => AppManifest[];
  getAppsByCategory: (category: AppCategory) => AppManifest[];
  getActivatedApps: () => AppManifest[];
  getStartMenuApps: () => AppManifest[];
  getHubServices: () => AppManifest[];
}

export type AppRegistryStore = AppRegistryState & AppRegistryActions;

const API_BASE = "/api/claraos";

// The server sends names/descriptions in the install's base language. They are
// translated HERE, once, instead of at the ~120 places that read `app.name`:
// a product app has keys in the "apps" catalog, third-party modules (Immich,
// Paperless …) have none and keep their own names.
let rawApps: AppManifest[] = [];

function localize(list: AppManifest[]): Record<string, AppManifest> {
  const apps: Record<string, AppManifest> = {};
  for (const app of list) {
    apps[app.id] = {
      ...app,
      name: i18n.t(`apps:${app.id}.name`, { defaultValue: app.name }),
      description: i18n.t(`apps:${app.id}.description`, { defaultValue: app.description }),
    };
  }
  return apps;
}

export const useAppRegistryStore = create<AppRegistryStore>((set, get) => ({
  apps: {},
  loading: false,
  loaded: false,
  error: null,

  loadApps: async () => {
    if (get().loaded || get().loading) return;
    await get().reloadApps();
  },

  reloadApps: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/apps`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rawApps = await res.json();
      set({ apps: localize(rawApps), loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
      console.error("Failed to load apps:", e);
    }
  },

  getApp: (id: string) => get().apps[id],

  getAllApps: () => Object.values(get().apps),

  getAppsByCategory: (category: AppCategory) =>
    Object.values(get().apps).filter((a) => a.category === category),

  getActivatedApps: () =>
    Object.values(get().apps).filter((a) => a.activated !== false),

  getStartMenuApps: () =>
    Object.values(get().apps).filter((a) => a.activated !== false && a.showInStartMenu !== false),

  getHubServices: () =>
    Object.values(get().apps).filter((a) => a.hubService === true && a.activated !== false),
}));

// Re-translate on a language switch and once the catalog arrives (the app
// list can be loaded before the "apps" namespace is).
function relocalize() {
  if (rawApps.length) useAppRegistryStore.setState({ apps: localize(rawApps) });
}
i18n.on("languageChanged", relocalize);
i18n.on("loaded", relocalize);
