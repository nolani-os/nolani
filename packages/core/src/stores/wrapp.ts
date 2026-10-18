import { create } from "zustand";
import type { WrappManifest } from "../types";

// ── Event Bus ──

type EventHandler = (payload: Record<string, unknown>) => void;

class WrappEventBus {
  private listeners = new Map<string, Set<EventHandler>>();

  on(event: string, handler: EventHandler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  emit(event: string, payload: Record<string, unknown> = {}) {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }

  clear() {
    this.listeners.clear();
  }
}

// ── Shared Object Store ──

export interface SharedObjectNode {
  id: string;
  type: string;
  name: string;
  icon: string;
  meta: Record<string, unknown>;
  children: SharedObjectNode[];
  expanded?: boolean;
}

// ── Wrapp Instance ──

/** App-specific instance state. A wrapp app adds its fields by declaration merging
 *  (`declare module "@claraos/core" { interface WrappExtensions { … } }`); they are
 *  saved and loaded with the instance. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WrappExtensions {}

/** Fields every wrapp instance has; everything else is app-specific state. */
const CORE_FIELDS = new Set([
  "id", "manifestId", "windowId", "objectTree", "selectedNodeId",
  "activeTab", "activeTabs", "eventBus", "savedAt",
]);

function extensionFields(src: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(src).filter(([k, v]) => !CORE_FIELDS.has(k) && v !== undefined),
  );
}

export interface WrappInstance extends WrappExtensions {
  id: string;
  manifestId: string;
  windowId: string;
  objectTree: SharedObjectNode;
  selectedNodeId: string | null;
  activeTab: string;
  activeTabs: Record<string, string>;  // objectId → active tab role
  eventBus: WrappEventBus;
}

// ── Store ──

export interface WrappStore {
  instances: Record<string, WrappInstance>;
  manifests: WrappManifest[];

  registerManifest: (manifest: WrappManifest) => void;
  getManifest: (id: string) => WrappManifest | undefined;

  openWrapp: (manifestId: string, windowId: string, rootObject?: SharedObjectNode) => string;
  closeWrapp: (instanceId: string) => void;
  getInstance: (instanceId: string) => WrappInstance | undefined;

  setSelectedNode: (instanceId: string, nodeId: string | null) => void;
  setActiveTab: (instanceId: string, tab: string) => void;
  setActiveTabForObject: (instanceId: string, objectId: string, tab: string) => void;
  getActiveTabForObject: (instanceId: string, objectId: string) => string;
  updateNodeMeta: (instanceId: string, nodeId: string, key: string, value: unknown) => void;
  addChildNode: (instanceId: string, parentId: string, child: SharedObjectNode) => void;

  /** true = actually written; false = failed (details in the console) */
  saveToFile: (instanceId: string, filename?: string) => Promise<boolean>;
  /** true = loaded and applied; false = file missing/corrupt/not a wrapp save */
  loadFromFile: (instanceId: string, path: string) => Promise<boolean>;
}

let wrappIdCounter = 0;

export const useWrappStore = create<WrappStore>()((set, get) => ({
  instances: {},
  manifests: [],

  registerManifest: (manifest) => {
    set((s) => ({
      manifests: s.manifests.some((m) => m.id === manifest.id)
        ? s.manifests.map((m) => (m.id === manifest.id ? manifest : m))
        : [...s.manifests, manifest],
    }));
  },

  getManifest: (id) => get().manifests.find((m) => m.id === id),

  openWrapp: (manifestId, windowId, rootObject) => {
    const id = `wrapp-${wrappIdCounter++}`;
    const manifest = get().manifests.find((m) => m.id === manifestId);
    // Use provided rootObject, or manifest default, or generic empty project
    const defaultRoot: SharedObjectNode = rootObject || {
      id: "root",
      type: manifest?.objectTreeLevels?.[0]?.type || "project",
      name: "New Project",
      icon: "📁",
      meta: {},
      children: [],
    };

    const instance: WrappInstance = {
      id,
      manifestId,
      windowId,
      objectTree: defaultRoot,
      selectedNodeId: null,
      activeTab: manifest?.apps[0]?.role || "data",
      activeTabs: {},
      eventBus: new WrappEventBus(),
    };

    set((s) => ({ instances: { ...s.instances, [id]: instance } }));
    return id;
  },

  closeWrapp: (instanceId) => {
    const inst = get().instances[instanceId];
    if (inst) inst.eventBus.clear();
    set((s) => {
      const { [instanceId]: _, ...rest } = s.instances;
      return { instances: rest };
    });
  },

  getInstance: (instanceId) => get().instances[instanceId],

  setSelectedNode: (instanceId, nodeId) => {
    set((s) => {
      const inst = s.instances[instanceId];
      if (!inst) return s;
      return { instances: { ...s.instances, [instanceId]: { ...inst, selectedNodeId: nodeId } } };
    });
  },

  setActiveTab: (instanceId, tab) => {
    set((s) => {
      const inst = s.instances[instanceId];
      if (!inst) return s;
      inst.eventBus.emit("tab-changed", { tab });
      return { instances: { ...s.instances, [instanceId]: { ...inst, activeTab: tab } } };
    });
  },

  setActiveTabForObject: (instanceId, objectId, tab) => {
    set((s) => {
      const inst = s.instances[instanceId];
      if (!inst) return s;
      const activeTabs = { ...inst.activeTabs, [objectId]: tab };
      inst.eventBus.emit("tab-changed", { objectId, tab });
      return { instances: { ...s.instances, [instanceId]: { ...inst, activeTabs } } };
    });
  },

  getActiveTabForObject: (instanceId, objectId) => {
    const inst = get().instances[instanceId];
    return inst?.activeTabs[objectId] || "data";
  },

  updateNodeMeta: (instanceId, nodeId, key, value) => {
    set((s) => {
      const inst = s.instances[instanceId];
      if (!inst) return s;

      function updateTree(node: SharedObjectNode): SharedObjectNode {
        if (node.id === nodeId) {
          return { ...node, meta: { ...node.meta, [key]: value } };
        }
        return { ...node, children: node.children.map(updateTree) };
      }

      const updated = { ...inst, objectTree: updateTree(inst.objectTree) };
      inst.eventBus.emit("meta-changed", { nodeId, key, value });
      return { instances: { ...s.instances, [instanceId]: updated } };
    });
  },

  addChildNode: (instanceId, parentId, child) => {
    set((s) => {
      const inst = s.instances[instanceId];
      if (!inst) return s;

      function addToTree(node: SharedObjectNode): SharedObjectNode {
        if (node.id === parentId) {
          return { ...node, children: [...node.children, child] };
        }
        return { ...node, children: node.children.map(addToTree) };
      }

      const updated = { ...inst, objectTree: addToTree(inst.objectTree) };
      inst.eventBus.emit("node-added", { parentId, child });
      return { instances: { ...s.instances, [instanceId]: updated } };
    });
  },

  saveToFile: async (instanceId, filename) => {
    const inst = get().instances[instanceId];
    if (!inst) return false;
    const name = filename || `${inst.manifestId}-${Date.now()}.json`;
    // Persist the full wrapp state: the object tree plus the app's own fields
    // (WrappExtensions), so a saved layout can be re-loaded later.
    const data = JSON.stringify(
      {
        manifestId: inst.manifestId,
        objectTree: inst.objectTree,
        ...extensionFields(inst),
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    );
    // Without the ok check, a 4xx/5xx would be silently swallowed here and the
    // user would think the state was saved (data-loss trap).
    try {
      const resp = await fetch("/api/claraos/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: `/wrapps/${name}`, content: data }),
      });
      if (!resp.ok) {
        console.error(`wrapp saveToFile: HTTP ${resp.status} für /wrapps/${name}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error("wrapp saveToFile fehlgeschlagen:", err);
      return false;
    }
  },

  loadFromFile: async (instanceId, path) => {
    let data: Partial<WrappInstance>;
    try {
      const resp = await fetch(
        `/api/claraos/files/read?path=${encodeURIComponent(path)}`,
      );
      if (!resp.ok) {
        console.error(`wrapp loadFromFile: HTTP ${resp.status} für ${path}`);
        return false;
      }
      const { content } = await resp.json();
      data = JSON.parse(content);
    } catch (err) {
      console.error(`wrapp loadFromFile: ${path} nicht lesbar/kein JSON:`, err);
      return false;
    }
    // Save format guard: without objectTree the TreeNode render would crash.
    if (!data || typeof data !== "object" || !data.objectTree) {
      console.error(`wrapp loadFromFile: ${path} ist kein Wrapp-Savefile (objectTree fehlt)`);
      return false;
    }
    const loaded = data as Partial<WrappInstance> & { objectTree: SharedObjectNode };
    set((s) => {
      const inst = s.instances[instanceId];
      if (!inst) return s;
      return {
        instances: {
          ...s.instances,
          [instanceId]: {
            ...inst,
            objectTree: loaded.objectTree,
            // The app's own fields; ones missing in the file keep their value.
            ...extensionFields(loaded),
          },
        },
      };
    });
    return true;
  },
}));
