import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  type CSSProperties,
} from "react";
import {
  useWindowsStore,
  useUIStore,
  useFileStore,
  useDragStore,
  useWorkspaceStore,
  type DesktopItem,
  useSettingsStore,
  useTranslation,
} from "@claraos/core";
import { WindowContextMenu, type ContextMenuItem } from "../components/WindowContextMenu";
import { PropertiesDialog, formatBytes, formatDateTime } from "../components/PropertiesDialog";
import { AppIcon } from "../components/AppIcon";
import { FileTypeIcon } from "../components/FileTypeIcon";
import { downloadFile } from "../lib/downloadFile";
import { getTemplate } from "../lib/newFileTemplates";
import { useDialogs } from "../Chat/Dialogs";
import { resolveFileApp, getViewerSizeForFile } from "../lib/fileTypeRouter";
import styles from "./DesktopIcons.module.css";

const CELL_W = 90;
const CELL_H = 90;

// Per-user Desktop folder. All file operations from the desktop view scope to
// this path so each user only sees the contents of their own /Desktop folder
// (lazy-created on first access by the backend).
export const DESKTOP_ROOT = "/Desktop";

function joinPath(parent: string, name: string): string {
  const p = parent.replace(/\/+$/, "");
  return `${p}/${name}`;
}

export type DesktopSortMode = "name" | "type" | "modified";

export interface DesktopIconsRef {
  clearSelection: () => void;
  refresh: () => void;
  startCreatingFolder: () => void;
  startCreatingFile: (extension: string) => void;
  renameSelected: () => void;
  deleteSelected: () => void;
  sortBy: (mode: DesktopSortMode) => void;
}

interface FileTreeChild {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  modified?: string;
  source?: string;
  isShortcut?: boolean;
  shortcut?: {
    target: string;
    type: string;
    icon?: string;
    broken?: boolean;
  };
}

/**
 * Column-major cell allocation that skips widget cells (and optionally
 * pre-occupied icon cells). Shared basis for loadDesktop + sortBy.
 */
function createCellAllocator(
  extraOccupied?: Iterable<string>,
  opts?: { nachDemLetzten?: boolean },
) {
  const occupied = new Set<string>(extraOccupied ?? []);
  const widgets = useWorkspaceStore.getState().getActive()?.widgets ?? [];
  for (const w of widgets) {
    for (let c = w.gridCol; c < w.gridCol + (w.gridW ?? 1); c++) {
      for (let rw = w.gridRow; rw < w.gridRow + (w.gridH ?? 1); rw++) {
        occupied.add(`${c}:${rw}`);
      }
    }
  }
  const maxRows = Math.max(3, Math.floor((window.innerHeight - 120) / CELL_H));
  let col = 0;
  let row = 0;

  /* Important: append new arrivals at the end instead of the first gap at the
   * top (requirement: new files appear where the user expects them, not
   * automatically at the top left).
   *
   * A file that was NOT placed by hand (Clara, Nextcloud sync, another app)
   * has no desired position. Previously it got the first free cell — i.e.
   * top left, right in the middle of the grown arrangement. Now allocation
   * starts after the last occupied cell in column order
   * (index = column * row count + row). Already saved positions are not
   * affected; they are set beforehand. */
  if (opts?.nachDemLetzten && occupied.size > 0) {
    let hoechster = -1;
    for (const zelle of occupied) {
      const [c, r] = zelle.split(":").map(Number);
      if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
      hoechster = Math.max(hoechster, c * maxRows + r);
    }
    const start = hoechster + 1;
    col = Math.floor(start / maxRows);
    row = start % maxRows;
  }
  const nextFree = (): { col: number; row: number } => {
    while (occupied.has(`${col}:${row}`)) {
      row += 1;
      if (row >= maxRows) { row = 0; col += 1; }
    }
    const cell = { col, row };
    occupied.add(`${col}:${row}`);
    row += 1;
    if (row >= maxRows) { row = 0; col += 1; }
    return cell;
  };
  return nextFree;
}

function nodeToItem(node: FileTreeChild, gridRow: number, gridCol = 0): DesktopItem {
  const isShortcut = !!node.isShortcut && !!node.shortcut;
  return {
    id: `desktop-${node.path}`,
    type: isShortcut ? "shortcut" : (node.isDir ? "folder" : "file"),
    name: node.name,
    icon: isShortcut
      ? (node.shortcut?.icon || "🔗")
      : (node.isDir ? "📁" : getFileIcon(node.name)),
    path: node.path,
    source: node.source ?? "nextcloud",
    size: node.size,
    modified: node.modified,
    gridCol,
    gridRow,
    // Augment with shortcut metadata stored on DesktopItem (extends type loosely)
    ...(isShortcut ? {
      shortcutTarget: node.shortcut!.target,
      shortcutBroken: !!node.shortcut!.broken,
      shortcutTargetType: node.shortcut!.type,
    } : {}),
  } as DesktopItem;
}

export const DesktopIcons = forwardRef<DesktopIconsRef>(function DesktopIcons(_, ref) {
  const { t } = useTranslation("desktop");
  const openWindow = useWindowsStore((s) => s.openWindow);
  // Single vs. double click (Settings → General behaviour)
  const singleClickOpens =
    useSettingsStore((s) => s.values["workspace-behavior"]?.clickBehavior) === "single";
  const closeStartMenu = useUIStore((s) => s.closeStartMenu);
  const renameFile = useFileStore((s) => s.renameFile);
  const deleteFile = useFileStore((s) => s.deleteFile);
  const createFolder = useFileStore((s) => s.createFolder);
  const writeFile = useFileStore((s) => s.writeFile);
  const startDrag = useDragStore((s) => s.startDrag);
  const endDrag = useDragStore((s) => s.endDrag);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeId);
  const addShortcut = useWorkspaceStore((s) => s.addShortcut);

  const [items, setItems] = useState<DesktopItem[]>([]);
  const itemsRef = useRef<DesktopItem[]>(items);
  itemsRef.current = items;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [creatingItem, setCreatingItem] = useState<{ kind: "folder" | "file"; value: string; ext?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DesktopItem[] | null>(null);
  const [propsItem, setPropsItem] = useState<DesktopItem | null>(null);
  const [lasso, setLasso] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { dialogHost, promptDlg, alertDlg } = useDialogs();

  // ── Persistent icon positions ──────────────────────────────────────────
  // Stored in UserPrefs.desktop_icons as [{path, col, row}]; the prefs PUT
  // is a partial update (the backend merges), so it does not touch
  // skin/theme/pins. Loaded once before the first loadDesktop.
  const savedPosRef = useRef<Map<string, { col: number; row: number }> | null>(null);
  const posLoadPromiseRef = useRef<Promise<void> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ensurePositionsLoaded = useCallback(() => {
    if (!posLoadPromiseRef.current) {
      posLoadPromiseRef.current = fetch("/api/claraos/prefs")
        .then((r) => (r.ok ? r.json() : null))
        .then((prefs) => {
          const map = new Map<string, { col: number; row: number }>();
          if (Array.isArray(prefs?.desktop_icons)) {
            for (const e of prefs.desktop_icons) {
              if (typeof e?.path === "string" && Number.isFinite(e.col) && Number.isFinite(e.row)) {
                map.set(e.path, { col: e.col, row: e.row });
              }
            }
          }
          savedPosRef.current = map;
        })
        .catch(() => { savedPosRef.current = new Map(); });
    }
    return posLoadPromiseRef.current;
  }, []);

  // Debounced: saves the current cells of all items (which automatically
  // prunes entries of deleted files) and keeps savedPosRef in sync, so a
  // refresh before the next load uses the same positions.
  const schedulePositionSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const icons = itemsRef.current
        .filter((it) => it.path)
        .map((it) => ({ path: it.path!, col: it.gridCol, row: it.gridRow }));
      savedPosRef.current = new Map(icons.map((e) => [e.path, { col: e.col, row: e.row }]));
      fetch("/api/claraos/prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desktop_icons: icons }),
      }).catch(() => {});
    }, 1000);
  }, []);

  // ── Data loading ────────────────────────────────────────────────────────
  // Loads only the per-user `/Desktop` folder. The backend lazy-creates it on
  // first access, so a brand-new user just sees an empty grid.
  //
  // Placement skips cells occupied by desktop WIDGETS (icons and widgets
  // share the same 90px grid but had no collision check — icons used to
  // stack on top of the clock). Column-major, wraps to the next column
  // when the visible rows are exhausted.
  const loadDesktop = useCallback(async () => {
    try {
      await ensurePositionsLoaded();
      const url = `/api/claraos/files/v2/tree?source=nextcloud&path=${encodeURIComponent(DESKTOP_ROOT)}`;
      const r = await fetch(url);
      if (!r.ok) {
        setItems([]);
        return;
      }
      const tree = await r.json();
      if (!tree?.children?.length) {
        setItems([]);
        return;
      }
      // Respect saved positions; only new/unknown files are auto-placed
      // (their cells must not overlap occupied ones).
      const saved = savedPosRef.current ?? new Map<string, { col: number; row: number }>();
      const savedCells: string[] = [];
      for (const node of tree.children as FileTreeChild[]) {
        const pos = saved.get(node.path);
        if (pos) savedCells.push(`${pos.col}:${pos.row}`);
      }
      // `nachDemLetzten`: append unknown files at the end, not in the
      // first gap at the top left — see createCellAllocator.
      const nextFree = createCellAllocator(savedCells, { nachDemLetzten: true });
      setItems(
        tree.children.map((node: FileTreeChild) => {
          const pos = saved.get(node.path);
          if (pos) return nodeToItem(node, pos.row, pos.col);
          const cell = nextFree();
          return nodeToItem(node, cell.row, cell.col);
        }),
      );
    } catch {
      /* offline / no-op */
    }
  }, [ensurePositionsLoaded]);

  useEffect(() => {
    loadDesktop();
  }, [loadDesktop]);

  // ── Sorting (context menu "Sort by …") ─────────────────────────────────
  // Folders first, then by mode; cells are reassigned column-major
  // (widget cells stay free). The result is saved as the new source of truth
  // for positions — the manual arrangement is deliberately replaced.
  const sortBy = useCallback((mode: DesktopSortMode) => {
    setItems((prev) => {
      const ext = (it: DesktopItem) =>
        it.type === "folder" ? "" : (it.name.split(".").pop()?.toLowerCase() ?? "");
      const byName = (a: DesktopItem, b: DesktopItem) =>
        a.name.localeCompare(b.name, "de", { numeric: true, sensitivity: "base" });
      const sorted = [...prev].sort((a, b) => {
        const dirDiff = (a.type === "folder" ? 0 : 1) - (b.type === "folder" ? 0 : 1);
        if (dirDiff) return dirDiff;
        if (mode === "type") return ext(a).localeCompare(ext(b)) || byName(a, b);
        if (mode === "modified") {
          const ta = Date.parse(a.modified ?? "") || 0;
          const tb = Date.parse(b.modified ?? "") || 0;
          return tb - ta || byName(a, b); // newest first
        }
        return byName(a, b);
      });
      const nextFree = createCellAllocator();
      return sorted.map((it) => {
        const cell = nextFree();
        return { ...it, gridCol: cell.col, gridRow: cell.row };
      });
    });
    schedulePositionSave();
  }, [schedulePositionSave]);

  // ── Imperative handle (for parent Desktop.tsx) ─────────────────────────
  useImperativeHandle(ref, () => ({
    clearSelection: () => setSelectedIds(new Set()),
    refresh: () => loadDesktop(),
    sortBy,
    startCreatingFolder: () => setCreatingItem({ kind: "folder", value: t("desktop.icons.newFolderName") }),
    startCreatingFile: (extension: string) => {
      const ext = extension.startsWith(".") ? extension : `.${extension}`;
      setCreatingItem({ kind: "file", value: `${t("desktop.icons.newFileName")}${ext}`, ext });
    },
    renameSelected: () => {
      const id = selectedIds.values().next().value;
      if (!id) return;
      const item = items.find((it) => it.id === id);
      if (item) setEditing({ id, value: item.name });
    },
    deleteSelected: () => {
      const sel = items.filter((it) => selectedIds.has(it.id));
      if (sel.length > 0) setConfirmDelete(sel);
    },
  }));

  // ── Selection helpers ──────────────────────────────────────────────────
  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds],
  );

  const toggleSelect = useCallback((id: string, mode: "single" | "toggle" | "range") => {
    setSelectedIds((prev) => {
      if (mode === "single") return new Set([id]);
      if (mode === "toggle") {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      }
      // range: select from last-anchor to id (best-effort linear by display order)
      if (prev.size === 0) return new Set([id]);
      const ids = items.map((it) => it.id);
      const lastAnchor = Array.from(prev).pop()!;
      const a = ids.indexOf(lastAnchor);
      const b = ids.indexOf(id);
      if (a < 0 || b < 0) return new Set([id]);
      const [from, to] = a < b ? [a, b] : [b, a];
      return new Set(ids.slice(from, to + 1));
    });
  }, [items]);

  // ── Mouse/drag for icon move and lasso ────────────────────────────────
  const handleIconMouseDown = useCallback((e: React.MouseEvent, itemId: string) => {
    if (editing) return;
    // Right-click: let it propagate untouched so Radix ContextMenu can fire.
    // We only intercept left-click for selection / drag-start.
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      toggleSelect(itemId, "range");
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(itemId, "toggle");
      return;
    }
    if (!isSelected(itemId)) {
      setSelectedIds(new Set([itemId]));
    }
    setDragging(itemId);
    dragStartRef.current = { x: e.clientX, y: e.clientY };

    // Multi-drag: when the dragged icon belongs to a multi-selection, every
    // selected icon moves by the same grid delta. The anchor icon (itemId)
    // snaps to the cursor cell; others preserve their relative offset.
    const movingIds = isSelected(itemId) && selectedIds.size > 1
      ? Array.from(selectedIds)
      : [itemId];
    const anchor = items.find((it) => it.id === itemId);
    const anchorCol = anchor?.gridCol ?? 0;
    const anchorRow = anchor?.gridRow ?? 0;
    const offsets = new Map<string, { dCol: number; dRow: number }>();
    for (const id of movingIds) {
      const it = items.find((x) => x.id === id);
      if (!it) continue;
      offsets.set(id, { dCol: it.gridCol - anchorCol, dRow: it.gridRow - anchorRow });
    }

    let moved = false;
    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current || !containerRef.current) return;
      if (
        Math.abs(ev.clientX - dragStartRef.current.x) < 5 &&
        Math.abs(ev.clientY - dragStartRef.current.y) < 5
      ) return;
      moved = true;
      const rect = containerRef.current.getBoundingClientRect();
      const col = Math.max(0, Math.floor((ev.clientX - rect.left) / CELL_W));
      const row = Math.max(0, Math.floor((ev.clientY - rect.top) / CELL_H));
      setItems((prev) => prev.map((it) => {
        const off = offsets.get(it.id);
        if (!off) return it;
        return { ...it, gridCol: Math.max(0, col + off.dCol), gridRow: Math.max(0, row + off.dRow) };
      }));
    };
    const onUp = () => {
      setDragging(null);
      dragStartRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Only persist real moves (clicks trigger onUp as well)
      if (moved) schedulePositionSave();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [editing, isSelected, toggleSelect, schedulePositionSave]);

  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start lasso when clicking truly empty area (the iconGrid itself)
    if (e.target !== e.currentTarget) return;
    if (e.button !== 0) return;
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;
    // Modifier-aware lasso: Shift = add to selection, Ctrl = toggle, plain = replace
    const additive = e.shiftKey;
    const toggleMode = e.ctrlKey || e.metaKey;
    const baseSelection = additive || toggleMode ? new Set(selectedIds) : new Set<string>();
    setSelectedIds(baseSelection);
    setLasso({ x: startX, y: startY, w: 0, h: 0 });

    const onMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      const cx = ev.clientX - r.left;
      const cy = ev.clientY - r.top;
      const x = Math.min(startX, cx);
      const y = Math.min(startY, cy);
      const w = Math.abs(cx - startX);
      const h = Math.abs(cy - startY);
      setLasso({ x, y, w, h });
    };
    const onUp = () => {
      setLasso((box) => {
        if (!box) return null;

        /* Warning: swallow the click that follows a lasso selection.
         *
         * "Lasso selection does not work" was NOT a bug in the hit test:
         * the lasso selected correctly — and was immediately cleared again.
         * After `mousedown` + `mouseup` the browser still sends a `click`
         * event to the common ancestor, where
         * `Desktop.handleDesktopClick` → `clearSelection()` is attached
         * ("Deselect all desktop icons when clicking empty area").
         * For a REAL click on the empty area that is correct; only the end
         * of a lasso selection must not count as one.
         * So exactly ONE click is swallowed in the capture phase — and the
         * guard is removed again after 50 ms if none arrives
         * (otherwise it would eat the user's next real click). */
        if (box.w > 3 || box.h > 3) {
          const schlucke = (e: MouseEvent) => {
            e.stopPropagation();
            window.removeEventListener("click", schlucke, true);
          };
          window.addEventListener("click", schlucke, true);
          setTimeout(() => window.removeEventListener("click", schlucke, true), 50);
        }

        setSelectedIds(() => {
          const next = new Set(baseSelection);
          for (const it of items) {
            const ix = it.gridCol * CELL_W + 8;
            const iy = it.gridRow * CELL_H + 8;
            const iw = CELL_W - 16;
            const ih = CELL_H - 16;
            const overlap = !(box.x + box.w < ix || box.x > ix + iw || box.y + box.h < iy || box.y > iy + ih);
            if (!overlap) continue;
            if (toggleMode) {
              next.has(it.id) ? next.delete(it.id) : next.add(it.id);
            } else {
              next.add(it.id);
            }
          }
          return next;
        });
        return null;
      });
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [items, selectedIds]);

  // ── Drag&Drop (HTML5) for cross-surface drags via useDragStore ────────
  const handleDragStart = useCallback((e: React.DragEvent, item: DesktopItem) => {
    if (!item.path || !item.source) return;
    const draggingSet = isSelected(item.id) ? Array.from(selectedIds) : [item.id];
    const draggedItems = items.filter((it) => draggingSet.includes(it.id));
    const draggedPaths = draggedItems.map((it) => it.path!).filter(Boolean);
    if (draggedPaths.length === 1) {
      startDrag({
        type: "file",
        source: item.source,
        path: item.path,
        name: item.name,
        isDir: item.type === "folder",
      });
    } else {
      startDrag({ type: "files", source: item.source, paths: draggedPaths });
    }
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", item.path);
  }, [isSelected, selectedIds, items, startDrag]);

  const handleDragEnd = useCallback(() => endDrag(), [endDrag]);

  // ── Open / double-click ────────────────────────────────────────────────
  const handleOpen = useCallback((item: DesktopItem) => {
    closeStartMenu();
    const itemAny = item as DesktopItem & {
      shortcutTarget?: string;
      shortcutBroken?: boolean;
      shortcutTargetType?: string;
    };

    // App-shortcut (existing behavior, e.g. pinned start-menu apps)
    if (item.type === "shortcut" && item.appId) {
      openWindow(item.appId, { title: item.name, width: 720, height: 540, path: item.path, source: item.source });
      return;
    }

    // File-shortcut (.lnk.json) — resolve target and open it
    if (item.type === "shortcut" && itemAny.shortcutTarget) {
      if (itemAny.shortcutBroken) {
        // Don't try to open a broken target; fall through silently.
        // (The badge already signals the issue; users can right-click → delete.)
        return;
      }
      const target = itemAny.shortcutTarget;
      const targetIsDir = itemAny.shortcutTargetType === "folder" || target.endsWith("/");
      if (targetIsDir) {
        const folderName = target.replace(/\/+$/, "").split("/").pop() || target;
        openWindow("files", {
          title: folderName,
          width: 750, height: 520,
          path: target,
          source: item.source ?? "nextcloud",
        });
      } else {
        const fileName = target.split("/").pop() || item.name;
        const appId = resolveFileApp(fileName, useFileStore.getState().openWithOverrides);
        if (!appId) {
          // No viewer: open the Files app in the parent folder instead of a silent fallback
          const parent = target.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
          openWindow("files", { title: fileName, width: 750, height: 520, path: parent, source: item.source ?? "nextcloud" });
          return;
        }
        openWindow(appId, {
          title: fileName, ...getViewerSizeForFile(appId, fileName),
          path: target,
          source: item.source ?? "nextcloud",
        });
      }
      return;
    }

    if (item.type === "folder") {
      openWindow("files", { title: item.name, width: 750, height: 520, path: item.path, source: item.source });
      return;
    }
    // File: route to viewer app by extension
    const appId = resolveFileApp(item.name, useFileStore.getState().openWithOverrides);
    if (!appId) {
      // No viewer: open the Files app in the parent folder instead of a silent fallback
      const parent = (item.path ?? "/").replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
      openWindow("files", { title: item.name, width: 750, height: 520, path: parent, source: item.source });
      return;
    }
    openWindow(appId, { title: item.name, ...getViewerSizeForFile(appId, item.name), path: item.path, source: item.source });
  }, [closeStartMenu, openWindow]);

  // ── Inline rename ──────────────────────────────────────────────────────
  const commitRename = useCallback(async () => {
    if (!editing) return;
    const item = items.find((it) => it.id === editing.id);
    setEditing(null);
    if (!item || !item.path || !item.source) return;
    const newName = editing.value.trim();
    if (!newName || newName === item.name) return;
    const result = await renameFile(item.source, item.path, newName);
    if (result) {
      // Optimistic local update; full refresh from server is in the bg
      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id ? { ...it, name: newName, path: result, id: `desktop-${result}` } : it,
        ),
      );
      // The saved position follows the new path
      const pos = savedPosRef.current?.get(item.path);
      if (pos) {
        savedPosRef.current!.delete(item.path);
        savedPosRef.current!.set(result, pos);
        schedulePositionSave();
      }
    }
  }, [editing, items, renameFile, schedulePositionSave]);

  const cancelRename = useCallback(() => setEditing(null), []);

  // ── Inline new folder ──────────────────────────────────────────────────
  const commitCreateItem = useCallback(async () => {
    if (!creatingItem) return;
    const name = creatingItem.value.trim();
    const kind = creatingItem.kind;
    const ext = creatingItem.ext;
    setCreatingItem(null);
    if (!name) return;
    if (kind === "folder") {
      const ok = await createFolder("nextcloud", joinPath(DESKTOP_ROOT, name));
      if (ok) await loadDesktop();
      return;
    }
    // File: ensure extension is preserved
    const finalName = ext && !name.toLowerCase().endsWith(ext.toLowerCase())
      ? `${name}${ext}`
      : name;
    const tpl = ext ? getTemplate(ext) : undefined;
    const ok = await writeFile(
      "nextcloud",
      joinPath(DESKTOP_ROOT, finalName),
      tpl?.content ?? "",
      tpl?.encoding ?? "utf-8",
    );
    if (ok) await loadDesktop();
  }, [creatingItem, createFolder, writeFile, loadDesktop]);

  const cancelCreateItem = useCallback(() => setCreatingItem(null), []);

  // ── Delete ──────────────────────────────────────────────────────────────
  const performDelete = useCallback(async (toDelete: DesktopItem[]) => {
    setConfirmDelete(null);
    for (const it of toDelete) {
      if (it.path && it.source) {
        await deleteFile(it.source, it.path);
      }
    }
    await loadDesktop();
    setSelectedIds(new Set());
  }, [deleteFile, loadDesktop]);

  // ── F2 / Delete hotkeys when desktop has focus ─────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (editing || creatingItem || confirmDelete || propsItem) return;
      // Only react when nothing is focused inside an editable target
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
        return;
      }
      if (e.key === "F2" && selectedIds.size === 1) {
        e.preventDefault();
        const id = selectedIds.values().next().value;
        const item = items.find((it) => it.id === id);
        if (id && item) setEditing({ id, value: item.name });
      } else if (e.key === "Delete" && selectedIds.size > 0) {
        e.preventDefault();
        const sel = items.filter((it) => selectedIds.has(it.id));
        setConfirmDelete(sel);
      } else if (e.key === "Escape") {
        setSelectedIds(new Set());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editing, creatingItem, confirmDelete, propsItem, selectedIds, items]);

  // ── Context menu items ─────────────────────────────────────────────────
  const buildIconMenu = useCallback((item: DesktopItem): ContextMenuItem[] => {
    const multiSelected = selectedIds.has(item.id) && selectedIds.size > 1;
    const count = multiSelected ? selectedIds.size : 1;
    const isFile = item.type === "file" && !!item.path;
    return [
      { id: "open", label: multiSelected ? t("desktop.icons.openMany", { count }) : t("desktop.icons.open"), onSelect: () => handleOpen(item), disabled: multiSelected },
      {
        id: "open-with",
        label: t("desktop.icons.openWith"),
        submenu: [
          { id: "open-files", label: t("desktop.icons.withFiles"), onSelect: () => openWindow("files", { title: item.name }) },
          { id: "open-text", label: t("desktop.icons.withTextEditor"), onSelect: () => openWindow("text-editor", { title: item.name, path: item.path, source: item.source }) },
          { id: "open-image", label: t("desktop.icons.withImageViewer"), onSelect: () => openWindow("image-viewer", { title: item.name, width: 900, height: 700, path: item.path, source: item.source }) },
          { id: "open-pdf", label: t("desktop.icons.withPdfViewer"), onSelect: () => openWindow("pdf-viewer", { title: item.name, width: 900, height: 1000, path: item.path, source: item.source }) },
          { id: "open-video", label: t("desktop.icons.withVideoPlayer"), onSelect: () => openWindow("video-player", { title: item.name, width: 960, height: 600, path: item.path, source: item.source }) },
        ],
      },
      {
        id: "download",
        label: t("desktop.icons.download"),
        disabled: !isFile || multiSelected,
        onSelect: () => { void downloadFile(item.source ?? "nextcloud", item.path!, item.name); },
      },
      {
        id: "archive",
        label: t("desktop.icons.archive"),
        disabled: !item.path || multiSelected,
        onSelect: async () => {
          const r = await fetch("/api/claraos/files/v2/archive", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: item.source ?? "nextcloud", path: item.path }),
          });
          if (r.ok) {
            await loadDesktop();
          } else {
            await alertDlg(t("desktop.icons.archiveFailed", { reason: (await r.json().catch(() => ({})))?.detail ?? r.status }));
          }
        },
      },
      {
        id: "encrypt",
        label: t("desktop.icons.encrypt"),
        disabled: !item.path || multiSelected,
        onSelect: async () => {
          const pw = await promptDlg(t("desktop.icons.encryptPrompt", { name: item.name }));
          if (!pw) return;
          const r = await fetch("/api/claraos/files/v2/encrypt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: item.source ?? "nextcloud", path: item.path, password: pw }),
          });
          if (r.ok) {
            await loadDesktop();
          } else {
            await alertDlg(t("desktop.icons.encryptFailed", { reason: (await r.json().catch(() => ({})))?.detail ?? r.status }));
          }
        },
      },
      { id: "sep1", label: "---" },
      {
        id: "rename",
        label: t("desktop.icons.rename"),
        shortcut: "F2",
        onSelect: () => setEditing({ id: item.id, value: item.name }),
        disabled: multiSelected,
      },
      {
        id: "move",
        label: t("desktop.icons.moveTo"),
        submenu: workspaces
          .filter((w) => w.id !== activeWorkspaceId)
          .map((w) => ({
            id: `move-${w.id}`,
            label: w.name,
            onSelect: () => {
              // Move desktop-item assignment between workspaces (UI-only metadata).
              // Actual file remains where it is; the icon just moves to that workspace.
              const moving = items.filter((it) => selectedIds.has(it.id) || it.id === item.id);
              for (const it of moving) {
                addShortcut(
                  { type: it.type, name: it.name, icon: it.icon, path: it.path, source: it.source, gridCol: 0, gridRow: 0 },
                  w.id,
                );
              }
            },
          })),
        disabled: workspaces.length < 2,
      },
      { id: "sep2", label: "---" },
      {
        id: "delete",
        label: multiSelected ? t("desktop.icons.deleteMany", { count }) : t("desktop.icons.delete"),
        shortcut: t("desktop.icons.deleteKey"),
        variant: "destructive",
        onSelect: () => {
          const sel = multiSelected ? items.filter((it) => selectedIds.has(it.id)) : [item];
          setConfirmDelete(sel);
        },
      },
      { id: "sep3", label: "---" },
      {
        id: "properties",
        label: t("desktop.icons.properties"),
        onSelect: () => setPropsItem(item),
        disabled: multiSelected,
      },
    ];
  }, [selectedIds, items, workspaces, activeWorkspaceId, handleOpen, openWindow, addShortcut, t]);

  const lassoStyle: CSSProperties | undefined = useMemo(
    () => lasso ? { left: lasso.x, top: lasso.y, width: lasso.w, height: lasso.h } : undefined,
    [lasso],
  );

  return (
    <div className={styles.iconGrid} ref={containerRef}>
      {/* Transparent surface for lasso-select that lets right-click pass
          through to the parent Desktop context-menu trigger. */}
      <div
        className={styles.lassoSurface}
        onMouseDown={handleContainerMouseDown}
      />
      {items.map((item) => {
        const itemAny = item as DesktopItem & {
          shortcutTarget?: string;
          shortcutBroken?: boolean;
        };
        const isFileShortcut = item.type === "shortcut" && !!itemAny.shortcutTarget;
        const isAppShortcut = item.type === "shortcut" && !!item.appId;
        const broken = !!itemAny.shortcutBroken;
        return (
        <WindowContextMenu key={item.id} items={buildIconMenu(item)}>
          <div
            className={`${styles.icon} ${isSelected(item.id) ? styles.selected : ""} ${dragging === item.id ? styles.dragging : ""} ${broken ? styles.iconBroken : ""}`}
            style={{ left: item.gridCol * CELL_W + 8, top: item.gridRow * CELL_H + 8 }}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
            onDragEnd={handleDragEnd}
            onMouseDown={(e) => handleIconMouseDown(e, item.id)}
            onDoubleClick={() => { if (!singleClickOpens) handleOpen(item); }}
            onClick={(e) => {
              e.stopPropagation();
              // Settings → General behaviour: single click opens
              if (singleClickOpens && !e.ctrlKey && !e.shiftKey) handleOpen(item);
            }}
            title={isFileShortcut
              ? (broken ? t("desktop.icons.brokenShortcut", { target: itemAny.shortcutTarget }) : `→ ${itemAny.shortcutTarget}`)
              : undefined}
          >
            {isAppShortcut ? (
              <AppIcon appId={item.appId!} fallback={item.icon} size="desktop" />
            ) : item.type === "object" ? (
              <span className={styles.iconEmoji}>{item.icon}</span>
            ) : (
              <span className={styles.iconEmoji}>
                <FileTypeIcon
                  name={isFileShortcut ? (itemAny.shortcutTarget?.split("/").pop() ?? item.name) : item.name}
                  isDir={item.type === "folder"}
                  px={46}
                />
                {isFileShortcut && (
                  <span
                    className={`${styles.shortcutBadge} ${broken ? styles.shortcutBadgeBroken : ""}`}
                    aria-label={broken ? "broken shortcut" : "shortcut"}
                  >↗</span>
                )}
              </span>
            )}
            {editing?.id === item.id ? (
              <input
                autoFocus
                className={styles.iconInput}
                value={editing.value}
                onChange={(e) => setEditing({ id: item.id, value: e.target.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                  else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              />
            ) : (
              <span className={styles.iconLabel}>{item.name}</span>
            )}
          </div>
        </WindowContextMenu>
        );
      })}

      {creatingItem && (
        <div className={`${styles.icon} ${styles.creatingFolder}`} style={{ left: 8, top: items.length * CELL_H + 8 }}>
          <span className={styles.iconEmoji}>
            <FileTypeIcon name={creatingItem.ext ? `neu${creatingItem.ext}` : undefined} isDir={creatingItem.kind === "folder"} px={46} />
          </span>
          <input
            autoFocus
            className={styles.iconInput}
            value={creatingItem.value}
            onChange={(e) => setCreatingItem((s) => s ? { ...s, value: e.target.value } : s)}
            onBlur={commitCreateItem}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitCreateItem(); }
              else if (e.key === "Escape") { e.preventDefault(); cancelCreateItem(); }
            }}
          />
        </div>
      )}

      {lasso && <div className={styles.lasso} style={lassoStyle} />}

      {confirmDelete && (
        <div className={styles.modalOverlay} onClick={() => setConfirmDelete(null)}>
          <div className={styles.confirm} onClick={(e) => e.stopPropagation()}>
            <h3>{t("desktop.icons.confirmTitle", { count: confirmDelete.length })}</h3>
            <p>{confirmDelete.length === 1
              ? t("desktop.icons.confirmOne", { name: confirmDelete[0].name })
              : t("desktop.icons.confirmMany")}</p>
            <div className={styles.confirmActions}>
              <button className={styles.btnCancel} onClick={() => setConfirmDelete(null)}>{t("desktop.icons.cancel")}</button>
              <button className={styles.btnDanger} onClick={() => performDelete(confirmDelete)}>{t("desktop.icons.delete")}</button>
            </div>
          </div>
        </div>
      )}

      <PropertiesDialog
        open={!!propsItem}
        title={propsItem?.name ?? ""}
        onClose={() => setPropsItem(null)}
        rows={propsItem ? [
          { label: "Type", value: propsItem.type },
          { label: "Source", value: propsItem.source ?? "—" },
          { label: "Path", value: propsItem.path ?? "—" },
          { label: "Size", value: formatBytes(propsItem.size) },
          { label: "Modified", value: formatDateTime(propsItem.modified) },
        ] : []}
      />
      {dialogHost}
    </div>
  );
});

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    txt: "📄", md: "📝", py: "🐍", ts: "📘", js: "📒", json: "📋",
    css: "🎨", html: "🌐", yml: "⚙️", sh: "▸_", sql: "🗄️",
    png: "🖼️", jpg: "🖼️", svg: "🎨", pdf: "📕", stl: "🔧", csv: "📊", zip: "📦",
  };
  return map[ext || ""] || "📄";
}
