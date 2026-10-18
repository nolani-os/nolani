import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Workspace, DesktopItem, DesktopWidget } from "../types";
import { idbStorage } from "./persist";

const DEFAULT_WORKSPACE: Workspace = {
  id: "ws-default",
  name: "Desktop 1",
  icon: "🖥️",
  desktopItems: [],
  widgets: [],
  createdAt: Date.now(),
};

export interface WorkspaceStore {
  workspaces: Workspace[];
  activeId: string;

  getActive: () => Workspace;
  setActive: (id: string) => void;
  createWorkspace: (name: string) => string;
  deleteWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setWallpaper: (id: string, wallpaper: string) => void;
  setDesktopItems: (id: string, items: DesktopItem[]) => void;
  addShortcut: (item: Omit<DesktopItem, "id">, workspaceId?: string) => string;
  deleteItems: (itemIds: string[], workspaceId?: string) => void;

  // Widget actions — operate on the active workspace by default
  addWidget: (widget: Omit<DesktopWidget, "id">, workspaceId?: string) => string;
  removeWidget: (widgetId: string, workspaceId?: string) => void;
  moveWidget: (widgetId: string, gridCol: number, gridRow: number, workspaceId?: string) => void;
  resizeWidget: (widgetId: string, gridW: number, gridH: number, workspaceId?: string) => void;
  updateWidgetConfig: (widgetId: string, config: Record<string, unknown>, workspaceId?: string) => void;
  setWidgets: (id: string, widgets: DesktopWidget[]) => void;
}

let wsCounter = 1;
let widgetCounter = 0;
const newWidgetId = () => `wgt-${Date.now().toString(36)}-${++widgetCounter}`;

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist((set, get) => ({
  workspaces: [DEFAULT_WORKSPACE],
  activeId: "ws-default",

  getActive: () => {
    const { workspaces, activeId } = get();
    return workspaces.find((w) => w.id === activeId) || workspaces[0];
  },

  setActive: (id) => set({ activeId: id }),

  createWorkspace: (name) => {
    const id = `ws-${++wsCounter}`;
    const ws: Workspace = {
      id,
      name,
      icon: "🖥️",
      desktopItems: [],
      widgets: [],
      createdAt: Date.now(),
    };
    set((s) => ({ workspaces: [...s.workspaces, ws], activeId: id }));
    return id;
  },

  deleteWorkspace: (id) => {
    set((s) => {
      if (s.workspaces.length <= 1) return s;
      const remaining = s.workspaces.filter((w) => w.id !== id);
      return {
        workspaces: remaining,
        activeId: s.activeId === id ? remaining[0].id : s.activeId,
      };
    });
  },

  renameWorkspace: (id, name) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
    }));
  },

  setWallpaper: (id, wallpaper) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, wallpaper } : w)),
    }));
  },

  setDesktopItems: (id, items) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, desktopItems: items } : w)),
    }));
  },

  addShortcut: (item, workspaceId) => {
    const id = `shortcut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const targetId = workspaceId ?? get().activeId;
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === targetId
          ? { ...w, desktopItems: [...w.desktopItems, { ...item, id }] }
          : w,
      ),
    }));
    return id;
  },

  deleteItems: (itemIds, workspaceId) => {
    const targetId = workspaceId ?? get().activeId;
    const ids = new Set(itemIds);
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === targetId
          ? { ...w, desktopItems: w.desktopItems.filter((it) => !ids.has(it.id)) }
          : w,
      ),
    }));
  },

  addWidget: (widget, workspaceId) => {
    const id = newWidgetId();
    const targetId = workspaceId ?? get().activeId;
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === targetId
          ? { ...w, widgets: [...(w.widgets ?? []), { ...widget, id }] }
          : w,
      ),
    }));
    return id;
  },

  removeWidget: (widgetId, workspaceId) => {
    const targetId = workspaceId ?? get().activeId;
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === targetId
          ? { ...w, widgets: (w.widgets ?? []).filter((wd) => wd.id !== widgetId) }
          : w,
      ),
    }));
  },

  moveWidget: (widgetId, gridCol, gridRow, workspaceId) => {
    const targetId = workspaceId ?? get().activeId;
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === targetId
          ? {
              ...w,
              widgets: (w.widgets ?? []).map((wd) =>
                wd.id === widgetId ? { ...wd, gridCol, gridRow } : wd,
              ),
            }
          : w,
      ),
    }));
  },

  resizeWidget: (widgetId, gridW, gridH, workspaceId) => {
    const targetId = workspaceId ?? get().activeId;
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === targetId
          ? {
              ...w,
              widgets: (w.widgets ?? []).map((wd) =>
                wd.id === widgetId ? { ...wd, gridW, gridH } : wd,
              ),
            }
          : w,
      ),
    }));
  },

  updateWidgetConfig: (widgetId, config, workspaceId) => {
    const targetId = workspaceId ?? get().activeId;
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === targetId
          ? {
              ...w,
              widgets: (w.widgets ?? []).map((wd) =>
                wd.id === widgetId ? { ...wd, config: { ...wd.config, ...config } } : wd,
              ),
            }
          : w,
      ),
    }));
  },

  setWidgets: (id, widgets) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, widgets } : w)),
    }));
  },
}), {
  name: "claraos-workspace",
  storage: createJSONStorage(() => idbStorage),
  // Persist only state, not actions; counters are session-local
  partialize: (state) => ({ workspaces: state.workspaces, activeId: state.activeId }),
  // Migrate older shapes that lack the widgets array
  migrate: (persistedState: unknown) => {
    const s = persistedState as { workspaces?: Workspace[]; activeId?: string };
    if (s?.workspaces) {
      s.workspaces = s.workspaces.map((w) => ({ widgets: [], ...w }));
    }
    return s as Partial<WorkspaceStore>;
  },
  version: 1,
}));
