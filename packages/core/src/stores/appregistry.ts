import { create } from "zustand";
import type { AppManifest, AppCategory } from "../types";

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
      const list: AppManifest[] = await res.json();
      const apps: Record<string, AppManifest> = {};
      for (const app of list) {
        apps[app.id] = app;
      }
      set({ apps, loading: false, loaded: true });
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
