import { create } from "zustand";
import type { FileNode } from "../types";

export type ViewMode = "icons-large" | "icons-small" | "list" | "details";
export type SortKey = "name" | "modified" | "size" | "type";
export type SortDir = "asc" | "desc";
export type GroupBy = "none" | "type" | "date";

// ── Tabs (Dolphin model) ─────────────────────────────────────────────────
export interface TabLocation {
  source: string;
  path: string;
}

// ── Places sidebar (KFilePlaces model) ───────────────────────────────────
// System entries are generated and can ONLY be hidden (XBEL isSystemItem);
// user entries + hidden system IDs live in the settings key
// files.places = { entries: [...], hiddenSystem: [...] }.
export interface PlaceEntry {
  id: string;
  title: string;
  source: string;
  path: string;
  icon?: string;
}

/** Second pane of the split view (Dolphin: exactly 2 panes per tab). */
export interface SplitPane extends TabLocation {
  back: TabLocation[];
  fwd: TabLocation[];
}

export interface FileTabState extends TabLocation {
  id: number;
  /** History per tab (Dolphin: history lives in the ViewContainer, not globally). */
  back: TabLocation[];
  fwd: TabLocation[];
  /** A user rename wins permanently; empty = automatic name. */
  customLabel?: string;
  /** Split view: the tab itself is pane 0 (left), split is pane 1 (right). */
  split?: SplitPane;
  activePane?: 0 | 1;
  /** Splitter position, survives off/on (Dolphin m_splitterLastPosition). */
  splitRatio?: number;
}

/** Active pane of a tab (pane 0 = the tab itself). */
export function activePaneOf(t: FileTabState): SplitPane {
  return t.activePane === 1 && t.split ? t.split : t;
}

function withActivePane(t: FileTabState, patch: Partial<SplitPane>): FileTabState {
  return t.activePane === 1 && t.split
    ? { ...t, split: { ...t.split, ...patch } }
    : { ...t, ...patch };
}

export interface FileSourceInfo {
  id: string;
  name: string;
  type: "nextcloud" | "sftp";
  icon: string;
  connected: boolean;
  /** `kein_zugang`: the service is running, but this user has no credentials
   *  of their own stored — different from "offline", and fixable. */
  status?: "online" | "sshd_down" | "offline" | "kein_zugang";
  /** Network path the API used to reach the device (e.g. "lan"). */
  via?: string | null;
  last_seen?: string | null;
  default_path?: string;
  os?: string;
  device_type?: string;
}

export interface TrashItem {
  name: string;
  trashPath: string;
  originalPath: string;
  deletedAt: number | null;  // Unix seconds
  isDir: boolean;
  size?: number;
}

/** Structured error from loadTree/loadSources — the UI renders a device-offline
 *  state from it instead of a silent empty folder. */
export interface FileError {
  message: string;
  httpStatus?: number;
  code?: string;      // "device_offline" | "sftp_error" | …
  status?: string;    // "offline" | "sshd_down" (for device_offline)
  device?: string;
  last_seen?: string | null;  // ISO, from the device DB
}

export interface FileState {
  sources: FileSourceInfo[];
  /** Mirror of the active tab — existing consumers keep reading here. */
  activeSource: string;
  currentPath: string;
  // Tabs (Dolphin): activeSource/currentPath always mirror tabs[activeTab].
  tabs: FileTabState[];
  activeTab: number;
  /** Ring buffer of closed tabs for undo-close (Dolphin: 6 entries). */
  closedTabs: { tab: FileTabState; index: number }[];
  // Tab behavior from the settings module "files"
  rememberOpenedTabs: boolean;
  openNewTabAfterLastTab: boolean;
  alwaysShowTabBar: boolean;
  confirmClosingMultipleTabs: boolean;
  closeSplitViewChoice: "active" | "inactive" | "right";
  // Places sidebar (KFilePlaces model)
  places: PlaceEntry[];
  hiddenSystemPlaces: string[];
  /** "Show all entries" — runtime toggle, not persisted. */
  showHiddenPlaces: boolean;
  /** null = not loaded yet; Nextcloud favorites as a live group. */
  favorites: FileNode[] | null;
  tree: FileNode | null;
  treeCache: Record<string, FileNode>;  // source:path -> tree
  loading: boolean;
  error: FileError | null;
  viewMode: ViewMode;
  selectedFiles: string[];
  clipboard: { action: "copy" | "cut"; source: string; paths: string[] } | null;
  sidebarExpanded: Record<string, boolean>;  // source:path -> expanded
  // View/sorting (persisted per user in the server prefs)
  sortKey: SortKey;
  sortDir: SortDir;
  dirsFirst: boolean;
  showHidden: boolean;
  groupBy: GroupBy;
  /** Instant filter of the toolbar search — NOT persisted. */
  filterQuery: string;
  /** User overrides "always open with this app": ext → appId. */
  openWithOverrides: Record<string, string>;
  filePrefsLoaded: boolean;
  /** null = normal folder view; otherwise the trash view is active. */
  trashItems: TrashItem[] | null;
  trashLoading: boolean;
  /** null = no recursive search active. */
  searchResults: FileNode[] | null;
  searchLoading: boolean;
  searchTruncated: boolean;
}

export interface FileActions {
  loadSources: (refresh?: boolean) => Promise<void>;
  /** fallbackToParent: 404 => show the nearest existing parent folder
   *  (startup with a remembered folder that has since been deleted). */
  loadTree: (source?: string, path?: string, opts?: { fallbackToParent?: boolean }) => Promise<void>;
  navigateTo: (source: string, path: string) => void;
  // Tabs (Dolphin model)
  /** force skips the dedupe (Ctrl+T may duplicate the current location). */
  openTab: (source: string, path: string, opts?: { background?: boolean; force?: boolean }) => void;
  activateTab: (index: number) => void;
  /** false = last tab (the caller then closes the window, like Dolphin). */
  closeTab: (index: number) => boolean;
  undoCloseTab: () => void;
  renameTab: (index: number, label: string) => void;
  goBack: () => void;
  goForward: () => void;
  // Split view (Dolphin model)
  toggleSplit: () => void;
  /** Open a folder specifically in the second pane ("Open in split view"). */
  openSplitAt: (source: string, path: string) => void;
  closeSplit: () => void;
  setActivePane: (pane: 0 | 1) => void;
  focusOtherPane: () => void;
  setSplitRatio: (ratio: number) => void;
  /** Load a tree into the cache WITHOUT switching the active view. */
  loadPaneTree: (source: string, path: string) => Promise<void>;
  /** false = no selection (the UI shows the Dolphin hint bar). */
  copyToOtherPane: () => Promise<boolean>;
  moveToOtherPane: () => Promise<boolean>;
  // Places sidebar
  addPlace: (title: string, source: string, path: string) => void;
  removePlace: (id: string) => void;
  renamePlace: (id: string, title: string) => void;
  /** Move an entry by one position (dir = -1 up / +1 down). */
  movePlace: (id: string, dir: -1 | 1) => void;
  hideSystemPlace: (id: string) => void;
  unhideSystemPlace: (id: string) => void;
  setShowHiddenPlaces: (show: boolean) => void;
  loadFavorites: () => Promise<void>;
  setFavorite: (path: string, value: boolean) => Promise<boolean>;
  setViewMode: (mode: ViewMode) => void;
  selectFile: (path: string, mode?: "single" | "toggle" | "range", allPaths?: string[]) => void;
  setSelection: (paths: string[]) => void;
  clearSelection: () => void;
  setClipboard: (action: "copy" | "cut", source: string, paths: string[]) => void;
  clearClipboard: () => void;
  toggleSidebarNode: (key: string) => void;
  // View/sorting + persistence
  setSort: (key: SortKey, dir?: SortDir) => void;
  toggleDirsFirst: () => void;
  toggleHidden: () => void;
  setGroupBy: (g: GroupBy) => void;
  setFilterQuery: (q: string) => void;
  setOpenWithOverride: (ext: string, appId: string | null) => void;
  loadFilePrefs: () => Promise<void>;
  // Trash (Nextcloud only)
  loadTrash: () => Promise<void>;
  closeTrash: () => void;
  restoreTrashItem: (trashPath: string) => Promise<boolean>;
  purgeTrashItem: (trashPath: string) => Promise<boolean>;
  emptyTrash: () => Promise<boolean>;
  // Recursive search (Enter in the search field)
  searchRecursive: (q: string) => Promise<void>;
  clearSearch: () => void;
  // File operations
  readFile: (source: string, path: string) => Promise<{ content: string; encoding: string; size: number } | null>;
  writeFile: (source: string, path: string, content: string, encoding?: "utf-8" | "base64") => Promise<boolean>;
  /** reload=false: batch operations reload the folder once at the end. */
  /** permanent: skip the Nextcloud trash (purge the entry afterwards). */
  deleteFile: (source: string, path: string, reload?: boolean, permanent?: boolean) => Promise<boolean>;
  createFolder: (source: string, path: string) => Promise<boolean>;
  /** dstPath = target folder. */
  copyFile: (srcSource: string, srcPath: string, dstSource: string, dstPath: string,
             onConflict?: ConflictMode, reload?: boolean) => Promise<FileOpResult>;
  /** Upload a file (browser File) into the target folder. */
  uploadFile: (source: string, dirPath: string, file: File) => Promise<boolean>;
  renameFile: (source: string, path: string, newName: string) => Promise<string | null>;
  /** dstPath = full target path. */
  moveFile: (srcSource: string, srcPath: string, dstSource: string, dstPath: string,
             onConflict?: ConflictMode, reload?: boolean) => Promise<FileOpResult>;
}

export type FileStore = FileState & FileActions;

/** Result of copyFile/moveFile. Formerly a boolean — a 409 conflict was
 *  indistinguishable from "broken", and the UI could not ask the user. */
export interface FileOpResult {
  ok: boolean;
  status: number;
  dst?: string;
  skipped?: boolean;
  /** set on 409: code "exists" | "type_mismatch" | "into_itself" … */
  conflict?: { code: string; name?: string; isDir?: boolean; message?: string };
  message?: string;
}

/** API conflict strategy: fail (→ 409) · overwrite · rename · skip. */
export type ConflictMode = "fail" | "overwrite" | "rename" | "skip";

const API = "/api/claraos/files/v2";

// ── Persistence in the settings schema module "files" ────────────────────
// Formerly the legacy block files_app in /api/claraos/prefs; the server
// migrates old data once on the first GET (routers/settings.py).
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// Important: load responses do not arrive in the order they were requested.
// Without a counter, a stale 404 overwrote the fresh folder — symptom: "Path not
// found" while the status bar counted 9 items.
let treeSeq = 0;

async function fileOp(url: string, body: Record<string, unknown>): Promise<FileOpResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, status: res.status, dst: data.dst ?? undefined, skipped: !!data.skipped };
    const d = data?.detail;
    if (res.status === 409 && d && typeof d === "object") {
      return { ok: false, status: 409, conflict: { code: d.code, name: d.name, isDir: d.is_dir, message: d.message } };
    }
    const message = typeof d === "string" ? d : d?.message ?? `HTTP ${res.status}`;
    return { ok: false, status: res.status, message, ...(d?.code ? { conflict: { code: d.code, message } } : {}) };
  } catch (e) {
    return { ok: false, status: 0, message: String(e) };
  }
}

// Tab session restore runs exactly ONCE per browser session — a second Files
// window must not reset the live state to the saved one.
let tabsRestoredOnce = false;
let persistTabsTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced storage of the open tabs in the settings key files.openTabs. */
function persistTabs(get: () => FileStore) {
  if (persistTabsTimer) clearTimeout(persistTabsTimer);
  persistTabsTimer = setTimeout(() => {
    const s = get();
    const payload = s.rememberOpenedTabs
      ? {
          tabs: s.tabs.map((t) => ({
            source: t.source,
            path: t.path,
            ...(t.customLabel ? { customLabel: t.customLabel } : {}),
            ...(t.split ? { split: { source: t.split.source, path: t.split.path }, activePane: t.activePane ?? 0 } : {}),
          })),
          active: s.activeTab,
        }
      : [];  // off = default [] → the delta store deletes the row
    void fetch("/api/claraos/settings/files", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openTabs: payload }),
    }).catch(() => undefined);
  }, 1000);
}

let persistPlacesTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced storage of the places in the settings key files.places. */
function persistPlaces(get: () => FileStore) {
  if (persistPlacesTimer) clearTimeout(persistPlacesTimer);
  persistPlacesTimer = setTimeout(() => {
    const s = get();
    const payload = s.places.length || s.hiddenSystemPlaces.length
      ? { entries: s.places, hiddenSystem: s.hiddenSystemPlaces }
      : [];  // empty = default → the row is removed from the delta store
    void fetch("/api/claraos/settings/files", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ places: payload }),
    }).catch(() => undefined);
  }, 1000);
}

/** Mirror update + reset the view state on tab/location change. */
function mirrorActiveTab(tab: TabLocation): Partial<FileState> {
  return {
    activeSource: tab.source,
    currentPath: tab.path,
    selectedFiles: [],
    trashItems: null,
    searchResults: null,
    filterQuery: "",
  };
}

/** Debounced PUT — the settings service only stores deviations from the default. */
function persistFilePrefs(get: () => FileStore) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const s = get();
    void fetch("/api/claraos/settings/files", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        viewMode: s.viewMode,
        sortKey: s.sortKey,
        sortDir: s.sortDir,
        dirsFirst: s.dirsFirst,
        showHidden: s.showHidden,
        groupBy: s.groupBy,
        openWithOverrides: s.openWithOverrides,
      }),
    }).catch(() => undefined);
  }, 1000);
}

export const useFileStore = create<FileStore>()((set, get) => ({
  sources: [],
  activeSource: "nextcloud",
  currentPath: "/",
  tabs: [{ id: 1, source: "nextcloud", path: "/", back: [], fwd: [] }],
  activeTab: 0,
  closedTabs: [],
  rememberOpenedTabs: true,
  openNewTabAfterLastTab: false,
  alwaysShowTabBar: false,
  confirmClosingMultipleTabs: true,
  closeSplitViewChoice: "active",
  places: [],
  hiddenSystemPlaces: [],
  showHiddenPlaces: false,
  favorites: null,
  tree: null,
  treeCache: {},
  loading: false,
  error: null,
  viewMode: "icons-large",
  selectedFiles: [],
  clipboard: null,
  sidebarExpanded: {},
  sortKey: "name",
  sortDir: "asc",
  dirsFirst: true,
  showHidden: false,
  groupBy: "none",
  filterQuery: "",
  openWithOverrides: {},
  filePrefsLoaded: false,
  trashItems: null,
  trashLoading: false,
  searchResults: null,
  searchLoading: false,
  searchTruncated: false,

  loadSources: async (refresh = false) => {
    try {
      const res = await fetch(`${API}/sources${refresh ? "?refresh=1" : ""}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sources: FileSourceInfo[] = await res.json();
      set({ sources });
    } catch (e) {
      set({ error: { message: (e as Error).message } });
    }
  },

  loadTree: async (source?: string, path?: string, opts?: { fallbackToParent?: boolean }) => {
    const s = source || get().activeSource;
    const p = path || get().currentPath;
    const cacheKey = `${s}:${p}`;
    const seq = ++treeSeq;

    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API}/tree?source=${encodeURIComponent(s)}&path=${encodeURIComponent(p)}`);
      if (seq !== treeSeq) return;  // a newer request was made meanwhile — this response is stale
      if (res.status === 404 && opts?.fallbackToParent && p.replace(/\/+$/, "") !== "") {
        const parent = p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
        return get().loadTree(s, parent, opts);
      }
      if (!res.ok) {
        // keep the API's structured detail (device_offline etc.) for the error UI
        const detail = (await res.json().catch(() => ({})))?.detail;
        const err: FileError = typeof detail === "object" && detail !== null
          ? { message: detail.message ?? detail.code ?? `HTTP ${res.status}`, httpStatus: res.status, ...detail }
          : { message: typeof detail === "string" ? detail : `HTTP ${res.status}`, httpStatus: res.status };
        // activate anyway so the sidebar highlight + error panel match the source
        set((state) => ({
          error: err, loading: false, tree: null, activeSource: s, currentPath: p,
          tabs: state.tabs.map((t, i) => (i === state.activeTab ? withActivePane(t, { source: s, path: p }) : t)),
        }));
        return;
      }
      const tree = await res.json();
      if (seq !== treeSeq) return;
      set((state) => ({
        tree,
        activeSource: s,
        currentPath: p,
        // active pane of the active tab follows (without a history push — navigateTo does that)
        tabs: state.tabs.map((t, i) => (i === state.activeTab ? withActivePane(t, { source: s, path: p }) : t)),
        treeCache: { ...state.treeCache, [cacheKey]: tree },
        loading: false,
      }));
    } catch (err) {
      if (seq !== treeSeq) return;
      set({ error: { message: String(err) }, loading: false, tree: null });
    }
  },

  navigateTo: (source, path) => {
    // An explicit navigation wins over the pending session restore: when Clara
    // opens the Files-app at a folder, the restore (async, on first mount)
    // used to land afterwards and silently put the user back on the old tab.
    tabsRestoredOnce = true;
    // Navigation leaves the trash and search views; history lives per pane.
    set((s) => {
      const t = s.tabs[s.activeTab];
      let tabs = s.tabs;
      if (t) {
        const pane = activePaneOf(t);
        if (!(pane.source === source && pane.path === path)) {
          tabs = s.tabs.map((tab, i) => i === s.activeTab
            ? withActivePane(tab, {
                source, path,
                back: [...pane.back, { source: pane.source, path: pane.path }].slice(-50),
                fwd: [],
              })
            : tab);
        }
      }
      return { ...mirrorActiveTab({ source, path }), tabs };
    });
    persistTabs(get);
    get().loadTree(source, path);
  },

  openTab: (source, path, opts = {}) => {
    const s = get();
    // Dedupe (Dolphin openDirectories): activate an existing tab instead of duplicating
    if (!opts.force) {
      const existing = s.tabs.findIndex((t) => t.source === source && t.path === path);
      if (existing >= 0) {
        if (!opts.background) get().activateTab(existing);
        return;
      }
    }
    const id = Math.max(0, ...s.tabs.map((t) => t.id)) + 1;
    const tab: FileTabState = { id, source, path, back: [], fwd: [] };
    const insertAt = s.openNewTabAfterLastTab ? s.tabs.length : s.activeTab + 1;
    set((st) => {
      const tabs = [...st.tabs];
      tabs.splice(insertAt, 0, tab);
      const activeTab = opts.background
        ? insertAt <= st.activeTab ? st.activeTab + 1 : st.activeTab
        : insertAt;
      return opts.background
        ? { tabs, activeTab }
        : { tabs, activeTab, ...mirrorActiveTab(tab) };
    });
    persistTabs(get);
    if (!opts.background) get().loadTree(source, path);
  },

  activateTab: (index) => {
    const t = get().tabs[index];
    if (!t) return;
    const pane = activePaneOf(t);
    set({ activeTab: index, ...mirrorActiveTab(pane) });
    persistTabs(get);
    get().loadTree(pane.source, pane.path);
  },

  closeTab: (index) => {
    const s = get();
    if (s.tabs.length <= 1) return false;  // last tab → close the window (caller)
    const tab = s.tabs[index];
    if (!tab) return true;
    const wasActive = index === s.activeTab;
    set((st) => {
      const tabs = st.tabs.filter((_, i) => i !== index);
      const closedTabs = [...st.closedTabs, { tab, index }].slice(-6);
      const activeTab = index < st.activeTab
        ? st.activeTab - 1
        : Math.min(st.activeTab, tabs.length - 1);
      return { tabs, closedTabs, activeTab };
    });
    if (wasActive) {
      const now = get();
      const at = activePaneOf(now.tabs[now.activeTab]);
      set(mirrorActiveTab(at));
      get().loadTree(at.source, at.path);
    }
    persistTabs(get);
    return true;
  },

  undoCloseTab: () => {
    const s = get();
    const last = s.closedTabs[s.closedTabs.length - 1];
    if (!last) return;
    set((st) => {
      const tabs = [...st.tabs];
      const at = Math.min(last.index, tabs.length);
      tabs.splice(at, 0, last.tab);
      return {
        tabs,
        closedTabs: st.closedTabs.slice(0, -1),
        activeTab: at,
        ...mirrorActiveTab(activePaneOf(last.tab)),
      };
    });
    persistTabs(get);
    const pane = activePaneOf(last.tab);
    get().loadTree(pane.source, pane.path);
  },

  renameTab: (index, label) => {
    set((s) => ({
      tabs: s.tabs.map((t, i) => {
        if (i !== index) return t;
        const { customLabel: _drop, ...rest } = t;
        return label.trim() ? { ...rest, customLabel: label.trim() } : rest;
      }),
    }));
    persistTabs(get);
  },

  goBack: () => {
    const s = get();
    const t = s.tabs[s.activeTab];
    if (!t) return;
    const pane = activePaneOf(t);
    if (pane.back.length === 0) return;
    const prev = pane.back[pane.back.length - 1];
    set((st) => ({
      tabs: st.tabs.map((tab, i) => i === st.activeTab
        ? withActivePane(tab, {
            source: prev.source, path: prev.path,
            back: pane.back.slice(0, -1),
            fwd: [...pane.fwd, { source: pane.source, path: pane.path }],
          })
        : tab),
      ...mirrorActiveTab(prev),
    }));
    persistTabs(get);
    get().loadTree(prev.source, prev.path);
  },

  goForward: () => {
    const s = get();
    const t = s.tabs[s.activeTab];
    if (!t) return;
    const pane = activePaneOf(t);
    if (pane.fwd.length === 0) return;
    const next = pane.fwd[pane.fwd.length - 1];
    set((st) => ({
      tabs: st.tabs.map((tab, i) => i === st.activeTab
        ? withActivePane(tab, {
            source: next.source, path: next.path,
            fwd: pane.fwd.slice(0, -1),
            back: [...pane.back, { source: pane.source, path: pane.path }],
          })
        : tab),
      ...mirrorActiveTab(next),
    }));
    persistTabs(get);
    get().loadTree(next.source, next.path);
  },

  // ── Split view (Dolphin dolphintabpage.cpp) ────────────────────────────
  toggleSplit: () => {
    const s = get();
    const t = s.tabs[s.activeTab];
    if (!t) return;
    if (t.split) { get().closeSplit(); return; }
    // Exactly ONE selected folder → the second pane opens THERE, otherwise a clone
    const sel = s.selectedFiles.length === 1 ? s.selectedFiles[0] : null;
    const selIsDir = sel != null
      && (s.tree?.children ?? []).some((c) => c.path === sel && c.isDir);
    get().openSplitAt(s.activeSource, selIsDir && sel ? sel : s.currentPath);
  },

  openSplitAt: (source, path) => {
    const split: SplitPane = { source, path, back: [], fwd: [] };
    set((st) => ({
      tabs: st.tabs.map((tab, i) => i === st.activeTab
        ? { ...tab, split, activePane: (tab.activePane ?? 0) as 0 | 1 }
        : tab),
    }));
    persistTabs(get);
    void get().loadPaneTree(source, path);
  },

  closeSplit: () => {
    const s = get();
    const t = s.tabs[s.activeTab];
    if (!t?.split) return;
    const active = t.activePane ?? 0;
    // Which survives: active→the other pane · inactive→the active one · right→left
    const survivorIdx = s.closeSplitViewChoice === "right"
      ? 0
      : s.closeSplitViewChoice === "active" ? (active === 0 ? 1 : 0) : active;
    const survivor: SplitPane = survivorIdx === 1
      ? t.split
      : { source: t.source, path: t.path, back: t.back, fwd: t.fwd };
    set((st) => ({
      tabs: st.tabs.map((tab, i) => i === st.activeTab
        ? {
            ...tab,
            source: survivor.source, path: survivor.path,
            back: survivor.back, fwd: survivor.fwd,
            split: undefined, activePane: 0 as const,
          }
        : tab),
      ...mirrorActiveTab(survivor),
    }));
    persistTabs(get);
    get().loadTree(survivor.source, survivor.path);
  },

  setActivePane: (pane) => {
    const s = get();
    const t = s.tabs[s.activeTab];
    if (!t || (pane === 1 && !t.split) || (t.activePane ?? 0) === pane) return;
    const target = pane === 1 ? t.split! : { source: t.source, path: t.path };
    set((st) => ({
      tabs: st.tabs.map((tab, i) => i === st.activeTab ? { ...tab, activePane: pane } : tab),
      ...mirrorActiveTab(target),
    }));
    get().loadTree(target.source, target.path);
  },

  focusOtherPane: () => {
    const t = get().tabs[get().activeTab];
    if (t?.split) get().setActivePane(((t.activePane ?? 0) === 0 ? 1 : 0) as 0 | 1);
  },

  setSplitRatio: (ratio) => {
    const r = Math.min(0.8, Math.max(0.2, ratio));
    set((st) => ({
      tabs: st.tabs.map((tab, i) => i === st.activeTab ? { ...tab, splitRatio: r } : tab),
    }));
  },

  loadPaneTree: async (source, path) => {
    try {
      const res = await fetch(`${API}/tree?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`);
      if (!res.ok) return;
      const tree = await res.json();
      set((st) => ({ treeCache: { ...st.treeCache, [`${source}:${path}`]: tree } }));
    } catch {
      // Filling the cache is best-effort; otherwise the pane shows the loading state
    }
  },

  copyToOtherPane: async () => {
    const s = get();
    const t = s.tabs[s.activeTab];
    if (!t?.split || s.selectedFiles.length === 0) return false;
    const target = (t.activePane ?? 0) === 0
      ? { source: t.split.source, path: t.split.path }
      : { source: t.source, path: t.path };
    for (const p of s.selectedFiles) {
      await get().copyFile(s.activeSource, p, target.source, target.path, "rename", false);
    }
    get().loadTree();
    await get().loadPaneTree(target.source, target.path);
    return true;
  },

  // ── Places sidebar (KFilePlaces) ───────────────────────────────────────
  addPlace: (title, source, path) => {
    const id = `place-${Date.now().toString(36)}-${get().places.length}`;
    // Dedupe: the same place is not added twice
    if (get().places.some((p) => p.source === source && p.path === path)) return;
    set((s) => ({ places: [...s.places, { id, title: title || path.split("/").filter(Boolean).pop() || "/", source, path }] }));
    persistPlaces(get);
  },

  removePlace: (id) => {
    // System entries can only be hidden, never deleted (KFilePlaces)
    if (id.startsWith("sys:")) return;
    set((s) => ({ places: s.places.filter((p) => p.id !== id) }));
    persistPlaces(get);
  },

  renamePlace: (id, title) => {
    set((s) => ({ places: s.places.map((p) => (p.id === id && title.trim() ? { ...p, title: title.trim() } : p)) }));
    persistPlaces(get);
  },

  movePlace: (id, dir) => {
    set((s) => {
      const i = s.places.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.places.length) return {};
      const places = [...s.places];
      [places[i], places[j]] = [places[j], places[i]];
      return { places };
    });
    persistPlaces(get);
  },

  hideSystemPlace: (id) => {
    set((s) => ({ hiddenSystemPlaces: s.hiddenSystemPlaces.includes(id) ? s.hiddenSystemPlaces : [...s.hiddenSystemPlaces, id] }));
    persistPlaces(get);
  },

  unhideSystemPlace: (id) => {
    set((s) => ({ hiddenSystemPlaces: s.hiddenSystemPlaces.filter((h) => h !== id) }));
    persistPlaces(get);
  },

  setShowHiddenPlaces: (show) => {
    set(show ? { showHiddenPlaces: true } : { showHiddenPlaces: false, hiddenSystemPlaces: get().hiddenSystemPlaces });
    // Turning "Show all" OFF hides entries again; re-hiding happens per
    // entry — Dolphin behavior (Show All is a display toggle).
  },

  loadFavorites: async () => {
    try {
      const res = await fetch(`${API}/favorites`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      set({ favorites: data.favorites ?? [] });
    } catch {
      set({ favorites: [] });
    }
  },

  setFavorite: async (path, value) => {
    try {
      const res = await fetch(`${API}/favorite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, value }),
      });
      if (!res.ok) return false;
      await get().loadFavorites();
      return true;
    } catch { return false; }
  },

  moveToOtherPane: async () => {
    const s = get();
    const t = s.tabs[s.activeTab];
    if (!t?.split || s.selectedFiles.length === 0) return false;
    const target = (t.activePane ?? 0) === 0
      ? { source: t.split.source, path: t.split.path }
      : { source: t.source, path: t.path };
    for (const p of s.selectedFiles) {
      const name = p.replace(/\/+$/, "").split("/").pop() ?? p;
      await get().moveFile(s.activeSource, p, target.source,
        `${target.path.replace(/\/+$/, "")}/${name}`, "rename", false);
    }
    get().clearSelection();
    get().loadTree();
    await get().loadPaneTree(target.source, target.path);
    return true;
  },

  searchRecursive: async (q) => {
    const s = get();
    if (!q.trim()) return;
    set({ searchLoading: true });
    try {
      const res = await fetch(
        `${API}/search?q=${encodeURIComponent(q.trim())}&source=${encodeURIComponent(s.activeSource)}&path=${encodeURIComponent(s.currentPath || "/")}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ searchResults: data.results ?? [], searchTruncated: !!data.truncated, searchLoading: false });
    } catch (e) {
      set({ searchResults: [], searchTruncated: false, searchLoading: false, error: { message: String(e) } });
    }
  },

  clearSearch: () => set({ searchResults: null, searchTruncated: false }),

  loadTrash: async () => {
    set({ trashLoading: true, selectedFiles: [] });
    try {
      const res = await fetch(`${API}/trash`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      set({ trashItems: await res.json(), trashLoading: false });
    } catch (e) {
      set({ trashItems: [], trashLoading: false, error: { message: String(e) } });
    }
  },

  closeTrash: () => set({ trashItems: null }),

  restoreTrashItem: async (trashPath) => {
    try {
      const res = await fetch(`${API}/trash/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trash_path: trashPath }),
      });
      if (!res.ok) return false;
      // target folder caches are now stale
      set({ treeCache: {} });
      await get().loadTrash();
      return true;
    } catch { return false; }
  },

  purgeTrashItem: async (trashPath) => {
    try {
      const res = await fetch(`${API}/trash/item?path=${encodeURIComponent(trashPath)}`, { method: "DELETE" });
      if (!res.ok) return false;
      await get().loadTrash();
      return true;
    } catch { return false; }
  },

  emptyTrash: async () => {
    try {
      const res = await fetch(`${API}/trash/empty`, { method: "POST" });
      if (!res.ok) return false;
      await get().loadTrash();
      return true;
    } catch { return false; }
  },

  setViewMode: (mode) => { set({ viewMode: mode }); persistFilePrefs(get); },

  setSort: (key, dir) => {
    set((s) => ({
      sortKey: key,
      // without an explicit direction: same key toggles, a new key starts asc
      sortDir: dir ?? (s.sortKey === key ? (s.sortDir === "asc" ? "desc" : "asc") : "asc"),
    }));
    persistFilePrefs(get);
  },
  toggleDirsFirst: () => { set((s) => ({ dirsFirst: !s.dirsFirst })); persistFilePrefs(get); },
  toggleHidden: () => { set((s) => ({ showHidden: !s.showHidden })); persistFilePrefs(get); },
  setGroupBy: (g) => { set({ groupBy: g }); persistFilePrefs(get); },
  setFilterQuery: (q) => set({ filterQuery: q }),
  setOpenWithOverride: (ext, appId) => {
    set((s) => {
      const next = { ...s.openWithOverrides };
      if (appId) next[ext.toLowerCase()] = appId;
      else delete next[ext.toLowerCase()];
      return { openWithOverrides: next };
    });
    persistFilePrefs(get);
  },

  loadFilePrefs: async () => {
    try {
      // The first GET triggers the one-time legacy migration on the server.
      const res = await fetch("/api/claraos/settings/files");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const v = data?.values;
      if (v && typeof v === "object") {
        // Effective values = default or user delta; both may set the local
        // state because the store defaults equal the schema defaults.
        set({
          ...(v.viewMode ? { viewMode: v.viewMode } : {}),
          ...(v.sortKey ? { sortKey: v.sortKey } : {}),
          ...(v.sortDir ? { sortDir: v.sortDir } : {}),
          ...(typeof v.dirsFirst === "boolean" ? { dirsFirst: v.dirsFirst } : {}),
          ...(typeof v.showHidden === "boolean" ? { showHidden: v.showHidden } : {}),
          ...(v.groupBy ? { groupBy: v.groupBy } : {}),
          ...(v.openWithOverrides && typeof v.openWithOverrides === "object"
            ? { openWithOverrides: v.openWithOverrides } : {}),
          ...(typeof v.rememberOpenedTabs === "boolean" ? { rememberOpenedTabs: v.rememberOpenedTabs } : {}),
          ...(typeof v.openNewTabAfterLastTab === "boolean" ? { openNewTabAfterLastTab: v.openNewTabAfterLastTab } : {}),
          ...(typeof v.alwaysShowTabBar === "boolean" ? { alwaysShowTabBar: v.alwaysShowTabBar } : {}),
          ...(typeof v.confirmClosingMultipleTabs === "boolean" ? { confirmClosingMultipleTabs: v.confirmClosingMultipleTabs } : {}),
          ...(v.closeSplitViewChoice === "active" || v.closeSplitViewChoice === "inactive" || v.closeSplitViewChoice === "right"
            ? { closeSplitViewChoice: v.closeSplitViewChoice } : {}),
        });
        // Places sidebar: {entries, hiddenSystem} — default [] means "nothing there"
        const pl = v.places as { entries?: unknown[]; hiddenSystem?: unknown[] } | unknown[];
        if (pl && !Array.isArray(pl) && typeof pl === "object") {
          const entries = (Array.isArray(pl.entries) ? pl.entries : [])
            .filter((p): p is PlaceEntry => {
              const e = p as Record<string, unknown>;
              return !!e && typeof e.id === "string" && typeof e.title === "string"
                && typeof e.source === "string" && typeof e.path === "string";
            });
          const hiddenSystem = (Array.isArray(pl.hiddenSystem) ? pl.hiddenSystem : [])
            .filter((h): h is string => typeof h === "string");
          set({ places: entries, hiddenSystemPlaces: hiddenSystem });
        }
        // Session restore (Dolphin RememberOpenedTabs) — only for the first
        // Files window of the session; restoring is programmatic and does not
        // count as user navigation (no history push).
        const ot = v.openTabs as { tabs?: unknown[]; active?: number } | unknown[];
        if (!tabsRestoredOnce && v.rememberOpenedTabs !== false
            && ot && !Array.isArray(ot) && Array.isArray(ot.tabs) && ot.tabs.length > 0) {
          const tabs: FileTabState[] = (ot.tabs as Record<string, unknown>[])
            .filter((t) => t && typeof t.source === "string" && typeof t.path === "string")
            .map((t, i) => {
              const sp = t.split as Record<string, unknown> | undefined;
              const split = sp && typeof sp.source === "string" && typeof sp.path === "string"
                ? { source: sp.source, path: sp.path, back: [], fwd: [] }
                : undefined;
              return {
                id: i + 1,
                source: t.source as string,
                path: t.path as string,
                back: [],
                fwd: [],
                ...(typeof t.customLabel === "string" && t.customLabel ? { customLabel: t.customLabel } : {}),
                ...(split ? { split, activePane: (t.activePane === 1 ? 1 : 0) as 0 | 1 } : {}),
              };
            });
          if (tabs.length > 0) {
            const active = Math.min(Math.max(0, Number(ot.active) || 0), tabs.length - 1);
            const pane = activePaneOf(tabs[active]);
            set({ tabs, activeTab: active, activeSource: pane.source, currentPath: pane.path });
          }
        }
        tabsRestoredOnce = true;
      }
    } catch {
      // Offline/error: keep the local defaults
    } finally {
      set({ filePrefsLoaded: true });
    }
  },

  selectFile: (path, mode = "single", allPaths) => {
    set((s) => {
      if (mode === "single") return { selectedFiles: [path] };
      if (mode === "toggle") {
        return {
          selectedFiles: s.selectedFiles.includes(path)
            ? s.selectedFiles.filter((p) => p !== path)
            : [...s.selectedFiles, path],
        };
      }
      // range — needs the visible-paths order
      if (!allPaths || allPaths.length === 0) return { selectedFiles: [path] };
      const anchor = s.selectedFiles[s.selectedFiles.length - 1] ?? path;
      const a = allPaths.indexOf(anchor);
      const b = allPaths.indexOf(path);
      if (a < 0 || b < 0) return { selectedFiles: [path] };
      const [from, to] = a < b ? [a, b] : [b, a];
      return { selectedFiles: allPaths.slice(from, to + 1) };
    });
  },

  setSelection: (paths) => set({ selectedFiles: paths }),

  clearSelection: () => set({ selectedFiles: [] }),

  setClipboard: (action, source, paths) => set({ clipboard: { action, source, paths } }),
  clearClipboard: () => set({ clipboard: null }),

  toggleSidebarNode: (key) => {
    set((s) => ({
      sidebarExpanded: { ...s.sidebarExpanded, [key]: !s.sidebarExpanded[key] },
    }));
  },

  readFile: async (source, path) => {
    try {
      const res = await fetch(`${API}/read?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`);
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  },

  writeFile: async (source, path, content, encoding = "utf-8") => {
    try {
      const res = await fetch(`${API}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, path, content, encoding }),
      });
      if (res.ok) { get().loadTree(); return true; }
      return false;
    } catch { return false; }
  },

  deleteFile: async (source, path, reload = true, permanent = false) => {
    try {
      const res = await fetch(`${API}/delete?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}${permanent ? "&permanent=1" : ""}`, { method: "DELETE" });
      if (res.ok) { if (reload) get().loadTree(); return true; }
      return false;
    } catch { return false; }
  },

  createFolder: async (source, path) => {
    try {
      const res = await fetch(`${API}/mkdir?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`, { method: "POST" });
      if (res.ok) { get().loadTree(); return true; }
      return false;
    } catch { return false; }
  },

  copyFile: async (srcSource, srcPath, dstSource, dstPath, onConflict = "fail", reload = true) => {
    const r = await fileOp(`${API}/copy`, {
      src_source: srcSource, src_path: srcPath, dst_source: dstSource, dst_path: dstPath,
      on_conflict: onConflict,
    });
    if (r.ok && reload) get().loadTree();
    return r;
  },

  uploadFile: async (source, dirPath, file) => {
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(
        `${API}/upload?source=${encodeURIComponent(source)}&path=${encodeURIComponent(dirPath || "/")}`,
        { method: "POST", body: form },
      );
      if (res.ok) { get().loadTree(); return true; }
      return false;
    } catch { return false; }
  },

  renameFile: async (source, path, newName) => {
    try {
      const res = await fetch(`${API}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, path, new_name: newName }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      get().loadTree();
      return data.path as string;
    } catch { return null; }
  },

  moveFile: async (srcSource, srcPath, dstSource, dstPath, onConflict = "fail", reload = true) => {
    const r = await fileOp(`${API}/move`, {
      src_source: srcSource, src_path: srcPath, dst_source: dstSource, dst_path: dstPath,
      on_conflict: onConflict,
    });
    if (r.ok && reload) get().loadTree();
    return r;
  },
}));
