import { Fragment, forwardRef, useCallback, useEffect, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  useFileStore, useDragStore, useWindowsStore, windowCloseGuards,
  regionLocale, useTranslation,
  type ViewMode, type FileSourceInfo, type FileTabState,
} from "@claraos/core";
import { PropertiesDialog, formatBytes, formatDateTime } from "../../components/PropertiesDialog";
import { ShareDialog } from "./ShareDialog";
import { PrintDialog } from "./PrintDialog";
import { VersionsDialog } from "./VersionsDialog";
import { WindowContextMenu } from "../../components/WindowContextMenu";
import { PopupMenu } from "../../components/PopupMenu";
import { FileTypeIcon } from "../../components/FileTypeIcon";
import { Button, IconButton } from "../../components/Button";
import { Icon, type IconName } from "../../components/Icon";
import { getViewerSize, resolveFileApp, fileExt, sniffIsText } from "../../lib/fileTypeRouter";
import { downloadFile, downloadMany } from "../../lib/downloadFile";
import { NEW_FILE_TEMPLATES, templateLabel } from "../../lib/newFileTemplates";
import { useDialogs } from "../../Chat/Dialogs";
import { useFileBrowserCore } from "./useFileBrowserCore";
import { useArchiveOps } from "./useArchiveOps";
import { useFileOps } from "./useFileOps";
import { buildFileItemMenu } from "./fileItemMenu";
import { OpenWithDialog } from "./OpenWithDialog";
import { FileThumb } from "./FileThumb";
import { prepareItems } from "./listTransform";
import { getFileTypeInfo, folderTypeName } from "../../lib/fileTypeMeta";
import { ToolbarMenu } from "../../components/ToolbarMenu";
import { Leerzustand } from "../../components/Leerzustand";
import { INSTALL_TEXTS } from "../../installTexts";
import styles from "./FileBrowserApp.module.css";

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  source?: string;
  size?: number;
  modified?: string;
  children?: FileNode[];
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDate(d?: string | number): string {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString(regionLocale()); } catch { return ""; }
}


// Dolphin squeezes tab titles to 40 characters (ellipsis in the middle).
function squeezeLabel(label: string, max = 40): string {
  if (label.length <= max) return label;
  const half = Math.floor((max - 1) / 2);
  return `${label.slice(0, half)}…${label.slice(-half)}`;
}

function paneLeaf(source: string, path: string, sources: FileSourceInfo[]): string {
  const leaf = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
  return leaf || (sources.find((s) => s.id === source)?.name ?? source);
}

function tabTitle(tab: FileTabState, sources: FileSourceInfo[]): string {
  if (tab.customLabel) return squeezeLabel(tab.customLabel);
  const a = paneLeaf(tab.source, tab.path, sources);
  if (tab.split) {
    // Dolphin: the INACTIVE pane is shown in parentheses (dolphintabwidget.cpp:533)
    const b = paneLeaf(tab.split.source, tab.split.path, sources);
    return squeezeLabel(tab.activePane === 1 ? `(${a}) | ${b}` : `${a} | (${b})`);
  }
  return squeezeLabel(a);
}

export default function FileBrowserDesktop({ windowId }: { windowId: string }) {
  const {
    sources, activeSource, currentPath, tree, loading, error, viewMode,
    selectedFiles, clipboard,
    sortKey, sortDir, dirsFirst, showHidden, groupBy, filterQuery,
    openWithOverrides, trashItems,
    searchResults, searchLoading, searchTruncated,
    tabs, activeTab, closedTabs, alwaysShowTabBar,
    openTab, activateTab, closeTab, undoCloseTab, renameTab, goBack, goForward,
    closeSplitViewChoice, toggleSplit, openSplitAt, setActivePane,
    focusOtherPane, setSplitRatio, copyToOtherPane, moveToOtherPane,
    loadSources, loadTree, setViewMode, loadTrash,
    setSort, toggleDirsFirst, toggleHidden, setGroupBy, setFilterQuery,
    searchRecursive, clearSearch,
    selectFile, setSelection, clearSelection, setClipboard, createFolder,
    renameFile,
    handleNavigate, handleOpen, openWith,
    createFromTemplate: createFromTemplateCore,
  } = useFileBrowserCore(windowId);
  const { t } = useTranslation("files");
  // Shortcut hints in the UI language ("Strg" / "Ctrl")
  const ctrlKey = t("keys.ctrl");

  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [crumbMenu, setCrumbMenu] = useState<{ x: number; y: number } | null>(null);
  // Editable location bar (Dolphin F6/Ctrl+L): type a path instead of clicking.
  // For long, known paths this is the fastest way.
  const [pathEdit, setPathEdit] = useState<string | null>(null);
  // Track Shift live so the delete entry in the context menu changes its
  // label before you click (Dolphin pattern).
  const [shiftHeld, setShiftHeld] = useState(false);
  // Share dialog: only for Nextcloud sources, SFTP cannot do links.
  const [shareNode, setShareNode] = useState<FileNode | null>(null);
  // Print: the menu entry only appears when the household has a printer
  // set up; otherwise it would lead nowhere.
  const [printNode, setPrintNode] = useState<FileNode | null>(null);
  const [hasPrinter, setHasPrinter] = useState(false);
  useEffect(() => {
    let alive = true;
    void fetch("/api/claraos/printing/printers", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { printers: [] }))
      .then((d) => { if (alive) setHasPrinter((d.printers ?? []).length > 0); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  // "Previous versions": also Nextcloud only.
  const [versionsNode, setVersionsNode] = useState<FileNode | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [propsNode, setPropsNode] = useState<FileNode | null>(null);
  const [openWithNode, setOpenWithNode] = useState<FileNode | null>(null);
  const [lasso, setLasso] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const { dialogHost, confirmDlg, promptDlg, alertDlg, chooseDlg } = useDialogs();
  const ops = useFileOps({ alertDlg, chooseDlg });
  // Folder currently being dragged over (drop = into it)
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Visible list for keyboard handlers (the list is only built further down
  // in render; a ref avoids the effect running before it exists)
  const itemsRef = useRef<FileNode[]>([]);

  // ── Tabs (Dolphin model) ────────────────────────────────────────────────
  // Middle-click on a tab closes it, but only if press AND release happen
  // on the SAME tab (DolphinTabBar guard).
  const midPressTab = useRef<number | null>(null);

  /** Close a tab; the last tab closes the window (Dolphin closeTab). */
  const closeTabAt = useCallback((index: number) => {
    if (!closeTab(index)) {
      useWindowsStore.getState().closeWindow(windowId);
    }
  }, [closeTab, windowId]);

  // Confirm when closing the window with multiple tabs (ConfirmClosingMultipleTabs)
  useEffect(() => {
    windowCloseGuards.set(windowId, () => {
      const s = useFileStore.getState();
      if (s.tabs.length > 1 && s.confirmClosingMultipleTabs) {
        return confirmDlg(
          t("confirm.closeTabs", { count: s.tabs.length }),
          t("actions.closeWindow"),
        );
      }
      return true;
    });
    return () => { windowCloseGuards.delete(windowId); };
  }, [windowId, confirmDlg, t]);

  // Places/favorites: straight from the store, saves hook plumbing
  const favoritesList = useFileStore((s) => s.favorites);
  const addPlace = useFileStore((s) => s.addPlace);
  const setFavorite = useFileStore((s) => s.setFavorite);
  const favSet = new Set((favoritesList ?? []).map((f) => f.path));

  // Dolphin pattern: copy/move-to-other-pane without a selection → hint bar
  const [paneHint, setPaneHint] = useState<string | null>(null);
  const showPaneHint = useCallback((msg: string) => {
    setPaneHint(msg);
    window.setTimeout(() => setPaneHint(null), 4000);
  }, []);

  const renameTabDlg = useCallback((index: number) => {
    const tab = useFileStore.getState().tabs[index];
    if (!tab) return;
    void promptDlg(t("tabs.renamePrompt"), tab.customLabel ?? "")
      .then((v) => { if (v !== null && v !== undefined) renameTab(index, String(v)); });
  }, [promptDlg, renameTab, t]);

  // Lasso multi-selection (desktop pattern; measured from the DOM here instead
  // of fixed grid cells, because list/tile views wrap and scroll freely)
  const handleLassoDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const el = e.currentTarget;
    // Don't treat clicks on the scrollbar as a lasso
    if (e.nativeEvent.offsetX > el.clientWidth || e.nativeEvent.offsetY > el.clientHeight) return;
    e.preventDefault();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? [...useFileStore.getState().selectedFiles] : [];
    const toContent = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      return { x: cx - r.left + el.scrollLeft, y: cy - r.top + el.scrollTop };
    };
    const start = toContent(e.clientX, e.clientY);
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      const cur = toContent(ev.clientX, ev.clientY);
      const box = {
        x: Math.min(start.x, cur.x),
        y: Math.min(start.y, cur.y),
        w: Math.abs(cur.x - start.x),
        h: Math.abs(cur.y - start.y),
      };
      if (box.w > 3 || box.h > 3) moved = true;
      setLasso(box);
      const r = el.getBoundingClientRect();
      const hits: string[] = [];
      el.querySelectorAll<HTMLElement>("[data-lasso-path]").forEach((n) => {
        const ir = n.getBoundingClientRect();
        const ix = ir.left - r.left + el.scrollLeft;
        const iy = ir.top - r.top + el.scrollTop;
        if (ix < box.x + box.w && ix + ir.width > box.x && iy < box.y + box.h && iy + ir.height > box.y) {
          hits.push(n.dataset.lassoPath as string);
        }
      });
      setSelection([...new Set([...base, ...hits])]);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setLasso(null);
      if (!moved && !additive) clearSelection(); // click on empty area = deselect
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [setSelection, clearSelection]);

  const { archiveItem, encryptItem, extractItem } = useArchiveOps({
    activeSource, currentPath, promptDlg, alertDlg,
  });

  // Open with gap handling: zip → extract flow, unknown type →
  // "Open with…" dialog (instead of a silent files fallback), otherwise default app.
  const openNode = useCallback((node: FileNode) => {
    if (node.isDir) { handleOpen(node); return; }
    const src = node.source || activeSource;
    if (fileExt(node.name) === "zip" && src === "nextcloud") {
      void confirmDlg(t("confirm.extractHere", { name: node.name }), t("actions.extract")).then((ok) => {
        if (ok) void extractItem(node);
      });
      return;
    }
    const appId = resolveFileApp(node.name, openWithOverrides);
    if (appId) { openWith(node, appId); return; }
    // No extension (hosts, .bashrc-like): peek briefly; text opens in the editor
    if (!fileExt(node.name)) {
      void sniffIsText(src, node.path).then((txt) => (txt ? openWith(node, "text-editor") : setOpenWithNode(node)));
      return;
    }
    setOpenWithNode(node);
  }, [handleOpen, activeSource, confirmDlg, extractItem, openWithOverrides, openWith, t]);

  // New file from template → jump straight into inline rename
  const createFromTemplate = useCallback(async (ext: string) => {
    const created = await createFromTemplateCore(ext);
    if (created) setRenaming({ path: created.path, value: created.name });
  }, [createFromTemplateCore]);

  const handleNewFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    const p = currentPath.replace(/\/$/, "") + "/" + newFolderName.trim();
    await createFolder(activeSource, p);
    setNewFolderName("");
    setShowNewFolder(false);
  }, [newFolderName, currentPath, activeSource, createFolder]);

  const startRename = useCallback(() => {
    const p = selectedFiles[0];
    if (!p) return;
    const node = items.find((n: FileNode) => n.path === p);
    if (node) setRenaming({ path: p, value: node.name });
  }, [selectedFiles]);  // items closed-over below

  const commitRename = useCallback(async () => {
    if (!renaming) return;
    const newName = renaming.value.trim();
    const path = renaming.path;
    setRenaming(null);
    if (!newName) return;
    await renameFile(activeSource, path, newName);
    clearSelection();
  }, [renaming, activeSource, renameFile, clearSelection]);

  const showProperties = useCallback(() => {
    const p = selectedFiles[0];
    if (!p) return;
    const node = items.find((n: FileNode) => n.path === p);
    if (node) setPropsNode(node);
  }, [selectedFiles]);  // items closed-over below

  // Right-click "link to desktop": writes a .lnk.json
  // file into the user's /Desktop folder (Authentik user is resolved server-side).
  const createDesktopShortcut = useCallback(async (node: FileNode) => {
    try {
      await fetch("/api/claraos/files/v2/shortcut", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: node.path,
          target_source: node.source ?? activeSource,
          target_type: node.isDir ? "folder" : "file",
          name: node.name,
        }),
      });
    } catch (err) {
      console.error("createDesktopShortcut failed", err);
    }
  }, [activeSource]);

  // Drop-target: accept drags from the Desktop / other Files-App windows.
  // Default behavior is Move into the currently-shown folder. Holding Ctrl
  // turns it into a Copy. We only intercept when there's an active drag from
  // useDragStore — drops from outside the app fall through.
  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    // Files from the operating system (Explorer/Dolphin) → upload
    if (!useDragStore.getState().current && e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      return;
    }
    if (!useDragStore.getState().current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = (e.ctrlKey || e.metaKey) ? "copy" : "move";
  }, []);

  /** Drop dragged items onto a folder: move, copy with Ctrl. */
  const dropInto = useCallback(async (e: React.DragEvent, dstFolder: string) => {
    const drag = useDragStore.getState().current;
    if (!drag || (drag.type !== "file" && drag.type !== "files")) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const copy = e.ctrlKey || e.metaKey;
    const source = drag.source ?? "nextcloud";
    const paths = drag.type === "file" ? [drag.path] : drag.paths;
    useDragStore.getState().endDrag();
    // Don't drop a folder onto itself
    const items = paths.filter((p) => p !== dstFolder).map((path) => ({ source, path }));
    if (items.length === 0) return;
    await ops.transfer(copy ? "copy" : "move", items, activeSource, dstFolder);
  }, [ops, activeSource]);

  /** Delete a list. Nextcloud: trash without confirmation (reversible);
   *  without a trash (SFTP) or with Shift: ask first. */
  const deleteNodes = useCallback(async (nodes: FileNode[], permanent: boolean) => {
    if (nodes.length === 0) return;
    const isNc = activeSource === "nextcloud";
    const forever = permanent || !isNc;
    if (forever) {
      const question = nodes.length === 1
        ? t("confirm.deletePermanentOne", { name: nodes[0].name })
        : t("confirm.deletePermanentMany", { count: nodes.length });
      if (!(await confirmDlg(
        `${question} ${isNc ? t("confirm.skipsTrash") : t("confirm.noTrash")}`,
        t("actions.deletePermanently"),
      ))) return;
    }
    // Shift+Del in Nextcloud also purges the trash entry
    await ops.remove(activeSource, nodes.map((n) => n.path), permanent && isNc);
  }, [activeSource, confirmDlg, ops, t]);

  const handlePanelDrop = useCallback((e: React.DragEvent) => {
    if (!useDragStore.getState().current && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      void ops.uploadFiles(Array.from(e.dataTransfer.files), activeSource, currentPath || "/");
      return;
    }
    void dropInto(e, currentPath || "/");
  }, [dropInto, currentPath, ops, activeSource]);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // F2 → rename selected
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Before all guards: the delete entry should change its label even
      // when an input field has focus.
      setShiftHeld(e.shiftKey);
      if (renaming) return;
      // Important: only in the FRONT files window; the handler is attached to
      // window and would otherwise intercept Del/Ctrl+V in every other window.
      if (useWindowsStore.getState().focusedWindowId !== windowId) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
      // An open dialog (confirmation, conflict) takes precedence
      if (active?.closest('[role="dialog"]')) return;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
      const sel = useFileStore.getState().selectedFiles;
      // ── File operations on the whole selection ──
      if (e.key === "Delete" && !e.ctrlKey && !e.metaKey && sel.length > 0) {
        e.preventDefault();
        void deleteNodes(itemsRef.current.filter((n) => sel.includes(n.path)), e.shiftKey);
        return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "c" && sel.length > 0) {
        e.preventDefault(); setClipboard("copy", activeSource, sel); return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "x" && sel.length > 0) {
        e.preventDefault(); setClipboard("cut", activeSource, sel); return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "v" && useFileStore.getState().clipboard) {
        e.preventDefault(); void ops.paste(activeSource, currentPath || "/"); return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault(); setSelection(itemsRef.current.map((n) => n.path)); return;
      }
      if (plain && e.key === "Enter" && sel.length === 1) {
        const n = itemsRef.current.find((it) => it.path === sel[0]);
        if (n) { e.preventDefault(); openNode(n); }
        return;
      }
      if (plain && e.key === "Backspace" && (currentPath || "/") !== "/") {
        e.preventDefault();
        handleNavigate(activeSource, currentPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/");
        return;
      }
      if (plain && e.key === "Escape" && sel.length > 0) { clearSelection(); return; }
      if (e.key === "F2" && selectedFiles.length === 1) {
        e.preventDefault();
        startRename();
      }
      // Ctrl+H: toggle hidden files (Nautilus convention)
      if (e.key.toLowerCase() === "h" && e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        toggleHidden();
      }
      // F6 / Ctrl+L: open the location bar for typing (Dolphin convention);
      // Shift+F6 belongs to the split view (move-to-other-pane)
      if ((e.key === "F6" && !e.shiftKey) || (e.ctrlKey && e.key.toLowerCase() === "l")) {
        e.preventDefault();
        setPathEdit(currentPath || "/");
      }
      // ── Split view (Dolphin F3 shortcut) ──
      if (e.key === "F3" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggleSplit();
      }
      if (e.key === "F3" && e.ctrlKey) { e.preventDefault(); focusOtherPane(); }
      if (e.key === "F5" && e.shiftKey && tabs[activeTab]?.split) {
        e.preventDefault();
        void copyToOtherPane().then((ok) => {
          if (!ok) showPaneHint(t("view.copyHint"));
        });
      }
      if (e.key === "F6" && e.shiftKey && tabs[activeTab]?.split) {
        e.preventDefault();
        void moveToOtherPane().then((ok) => {
          if (!ok) showPaneHint(t("view.moveHint"));
        });
      }
      // ── Tabs (Dolphin shortcuts; in the installed PWA window Ctrl+T/W
      //    arrive here, in a browser tab the browser's own may take over) ──
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        if (e.shiftKey) undoCloseTab();
        else openTab(activeSource, currentPath || "/", { force: true });
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeTabAt(activeTab);
      }
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const n = tabs.length;
        if (n > 1) activateTab(((activeTab + (e.shiftKey ? -1 : 1)) % n + n) % n);
      }
      // History per tab (Alt+←/→, browser convention)
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goBack(); }
      if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goForward(); }
    };
    const up = (e: KeyboardEvent) => setShiftHeld(e.shiftKey);
    window.addEventListener("keydown", handler);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keyup", up);
    };
  }, [renaming, selectedFiles, startRename, toggleHidden, currentPath, activeSource,
      tabs, activeTab, openTab, undoCloseTab, activateTab, closeTabAt, goBack, goForward,
      toggleSplit, focusOtherPane, copyToOtherPane, moveToOtherPane, showPaneHint,
      windowId, setClipboard, setSelection, clearSelection, ops, openNode, handleNavigate, deleteNodes, t]);

  const breadcrumbs = currentPath.split("/").filter(Boolean);
  const sourceName = sources.find((s) => s.id === activeSource)?.name || activeSource;
  const groups = prepareItems(tree?.children, { sortKey, sortDir, dirsFirst, showHidden, groupBy, filterQuery });
  // Visible order: basis for shift-range, lasso and rendering
  const items = groups.flatMap((g) => g.items);
  itemsRef.current = items;
  /** What an action on entry n applies to: if n is part of a multi-selection,
   *  the whole selection (Windows/Dolphin), otherwise just n. */
  const targetsFor = (n: FileNode): FileNode[] => (
    selectedFiles.length > 1 && selectedFiles.includes(n.path)
      ? items.filter((it) => selectedFiles.includes(it.path))
      : [n]
  );
  const cutPaths = clipboard?.action === "cut" && clipboard.source === activeSource
    ? new Set(clipboard.paths) : null;
  const dotfilesHidden = showHidden ? 0 : (tree?.children ?? []).filter((n) => n.name.startsWith(".")).length;

  const showTabBar = tabs.length > 1 || alwaysShowTabBar;

  // ── Split view: pane 0 = left (the tab itself), pane 1 = right ──
  const splitPane = tabs[activeTab]?.split;
  const activePaneIdx = tabs[activeTab]?.activePane ?? 0;
  const splitRatio = tabs[activeTab]?.splitRatio ?? 0.5;

  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    const row = (e.currentTarget as HTMLElement).parentElement;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => setSplitRatio((ev.clientX - rect.left) / rect.width);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    e.preventDefault();
  }, [setSplitRatio]);

  // Dolphin updateSplitActions: the label says WHICH side closes
  const closeSplitLabel = (() => {
    const closes = closeSplitViewChoice === "right"
      ? 1
      : closeSplitViewChoice === "active" ? activePaneIdx : (activePaneIdx === 0 ? 1 : 0);
    return closes === 0 ? t("view.splitCloseLeft") : t("view.splitCloseRight");
  })();

  return (
    <div className={styles.appRoot}>
      {/* Tab bar (Dolphin: auto-hide with one tab, AlwaysShowTabBar setting) */}
      {showTabBar && (
        <div className={styles.tabBar} role="tablist" aria-label={t("tabs.ariaLabel")}>
          {tabs.map((tab, i) => (
            <WindowContextMenu
              key={tab.id}
              items={[
                { id: "tab-rename", label: t("tabs.rename"), onSelect: () => renameTabDlg(i) },
                ...(tab.customLabel
                  ? [{ id: "tab-autoname", label: t("tabs.autoName"), onSelect: () => renameTab(i, "") }]
                  : []),
                { id: "tab-sep", label: "---" },
                { id: "tab-close", label: t("tabs.close"), onSelect: () => closeTabAt(i) },
              ]}
            >
              <div
                role="tab"
                aria-selected={i === activeTab}
                className={`${styles.tab} ${i === activeTab ? styles.tabActive : ""}`}
                title={`${tab.source}:${tab.path}`}
                onClick={() => activateTab(i)}
                onDoubleClick={() => renameTabDlg(i)}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); midPressTab.current = i; } }}
                onMouseUp={(e) => {
                  if (e.button !== 1) return;
                  // Press+release on the same tab (DolphinTabBar guard)
                  if (midPressTab.current === i) closeTabAt(i);
                  midPressTab.current = null;
                }}
              >
                <span className={styles.tabLabel}>{tabTitle(tab, sources)}</span>
                <button
                  className={styles.tabClose}
                  aria-label={t("tabs.close")}
                  onClick={(e) => { e.stopPropagation(); closeTabAt(i); }}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            </WindowContextMenu>
          ))}
          <button
            className={styles.tabNewBtn}
            title={t("tabs.newTitle", { shortcut: `${ctrlKey}+T` })}
            aria-label={t("tabs.new")}
            onClick={() => openTab(activeSource, currentPath || "/", { force: true })}
          >
            <Icon name="plus" size={14} />
          </button>
          {closedTabs.length > 0 && (
            <button
              className={styles.tabNewBtn}
              title={t("tabs.reopenTitle", { shortcut: `${ctrlKey}+${t("keys.shift")}+T` })}
              aria-label={t("tabs.reopen")}
              onClick={() => undoCloseTab()}
            ><Icon name="reload" size={14} /></button>
          )}
        </div>
      )}
      <div className={styles.browser}>
      {/* Left: Tree Panel */}
      <WindowContextMenu
        items={[
          { id: "reload-sources", label: t("sidebar.reloadSources"), onSelect: () => { void loadSources(); } },
          { id: "refresh", label: t("sidebar.refreshFolder"), shortcut: "F5", onSelect: () => loadTree(activeSource, currentPath || "/") },
        ]}
      >
      <nav className={styles.treePanel} data-tour="files-sidebar">
        <PlacesSection onNavigate={handleNavigate} promptDlg={promptDlg} />
        <div className={styles.treePanelHeader}>{t("sections.sources")}</div>
        {sources.map((src) => (
          <Fragment key={src.id}>
            <TreeSourceNode
              source={src}
              isActive={activeSource === src.id && trashItems === null}
              onNavigate={handleNavigate}
            />
            {src.id === "nextcloud" && (
              <div
                className={`${styles.treeNode} ${trashItems !== null ? styles.treeNodeActive : ""}`}
                style={{ paddingLeft: 16 }}
                onClick={() => { void loadTrash(); }}
              >
                <span className={styles.treeExpander}> </span>
                <span><OrtSymbol icon="🗑" /> {t("sections.trash")}</span>
              </div>
            )}
          </Fragment>
        ))}
      </nav>
      </WindowContextMenu>

      {/* Right: Content */}
      <div
        className={styles.contentPanel}
        data-tour="files-content"
        onDragOver={handlePanelDragOver}
        onDrop={handlePanelDrop}
      >
        {trashItems !== null ? (
          <TrashView confirmDlg={confirmDlg} />
        ) : (
        <>
        {/* Toolbar */}
        <div className={styles.toolbar}>
          <IconButton label={t("toolbar.back")} icon="back" groesse="s" disabled={(tabs[activeTab]?.back.length ?? 0) === 0} onClick={() => goBack()} />
          <IconButton label={t("toolbar.forward")} icon="arrowRight" groesse="s" disabled={(tabs[activeTab]?.fwd.length ?? 0) === 0} onClick={() => goForward()} />
          <WindowContextMenu
            items={[
              {
                id: "copy-path",
                label: t("toolbar.copyPath"),
                onSelect: () => { navigator.clipboard?.writeText(currentPath || "/").catch(() => undefined); },
              },
              {
                id: "refresh",
                label: t("actions.refresh"),
                shortcut: "F5",
                onSelect: () => loadTree(activeSource, currentPath || "/"),
              },
            ]}
          >
          {pathEdit !== null ? (
            <input
              className={styles.pathInput}
              autoFocus
              value={pathEdit}
              aria-label={t("toolbar.enterPath")}
              onChange={(e) => setPathEdit(e.target.value)}
              onBlur={() => setPathEdit(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setPathEdit(null);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const p = pathEdit.trim();
                  setPathEdit(null);
                  handleNavigate(activeSource, p.startsWith("/") ? p : `/${p}`);
                }
              }}
            />
          ) : (
          <div className={styles.breadcrumb} onDoubleClick={() => setPathEdit(currentPath || "/")}>
            <button
              className={styles.breadcrumbItem}
              onClick={() => handleNavigate(activeSource, "/")}
              onMouseUp={(e) => {
                if (e.button === 1) { e.preventDefault(); openTab(activeSource, "/", { background: !e.shiftKey }); }
              }}
            >
              {sourceName}
            </button>
            {(breadcrumbs.length <= 3 ? breadcrumbs.map((seg, i) => [seg, i] as const)
              // Long paths: first segment / … / last two; otherwise the nowrap
              // segments squeeze the toolbar buttons out of the window.
              : [[breadcrumbs[0], 0] as const, ["…", -1] as const,
                 ...breadcrumbs.slice(-2).map((seg, j) => [seg, breadcrumbs.length - 2 + j] as const)]
            ).map(([seg, i]) => (
              <span key={`${i}-${seg}`}>
                <span className={styles.breadcrumbSep}>/</span>
                {i === -1 ? (
                  <button
                    className={styles.breadcrumbItem}
                    title={t("toolbar.showIntermediate")}
                    onClick={(e) => setCrumbMenu({ x: e.clientX, y: e.clientY })}
                  >
                    …
                  </button>
                ) : (
                  <button
                    className={styles.breadcrumbItem}
                    onClick={() => handleNavigate(activeSource, "/" + breadcrumbs.slice(0, i + 1).join("/"))}
                    onMouseUp={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        openTab(activeSource, "/" + breadcrumbs.slice(0, i + 1).join("/"), { background: !e.shiftKey });
                      }
                    }}
                  >
                    {decodeURIComponent(seg)}
                  </button>
                )}
              </span>
            ))}
            <button
              className={styles.breadcrumbEdit}
              title={t("toolbar.enterPathTitle")}
              aria-label={t("toolbar.enterPath")}
              onClick={() => setPathEdit(currentPath || "/")}
            ><Icon name="pen" size={13} /></button>
          </div>
          )}
          </WindowContextMenu>
          {crumbMenu && (
            <PopupMenu
              x={crumbMenu.x}
              y={crumbMenu.y}
              onClose={() => setCrumbMenu(null)}
              items={breadcrumbs.slice(1, -2).map((seg, j) => ({
                id: `crumb-${j}`,
                label: decodeURIComponent(seg),
                onSelect: () => {
                  setCrumbMenu(null);
                  handleNavigate(activeSource, "/" + breadcrumbs.slice(0, j + 2).join("/"));
                },
              }))}
            />
          )}
          <input
            className={styles.searchInput}
            data-tour="files-search"
            value={filterQuery}
            placeholder={t("toolbar.search")}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filterQuery.trim()) {
                e.preventDefault();
                void searchRecursive(filterQuery);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setFilterQuery("");
                clearSearch();
              }
            }}
          />
          <div className={styles.toolbarActions}>
            <Button stufe="tonal" groesse="s" icon="plus" data-tour="files-new-folder"
                    onClick={() => setShowNewFolder(!showNewFolder)} title={t("new.folder")}>{t("new.folderShort")}</Button>
            <IconButton label={t("actions.upload")} icon="export" groesse="s"
                        onClick={() => uploadInputRef.current?.click()} />
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              hidden
              aria-label={t("actions.uploadFiles")}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) void ops.uploadFiles(files, activeSource, currentPath || "/");
              }}
            />
            {clipboard && (
              <IconButton
                label={t(clipboard.action === "cut" ? "toolbar.pasteCut" : "toolbar.pasteCopied", { count: clipboard.paths.length })}
                icon="copy" groesse="s"
                onClick={() => { void ops.paste(activeSource, currentPath || "/"); }}
              />
            )}
            <ToolbarMenu
              triggerClassName={styles.toolBtn}
              title={t("view.title")}
              trigger={<><Icon name={String(viewMode).includes("grid") ? "image" : "list"} size={16} /><Icon name="chevronDown" size={12} /></>}
              items={[
                {
                  id: "split-toggle",
                  label: splitPane ? closeSplitLabel : t("view.splitOpen"),
                  shortcut: "F3",
                  onSelect: () => toggleSplit(),
                },
                ...(splitPane
                  ? [{
                      id: "split-focus",
                      label: t("view.splitFocusOther"),
                      shortcut: `${ctrlKey}+F3`,
                      onSelect: () => focusOtherPane(),
                    }]
                  : []),
                { id: "sep-v0", label: "---" },
                ...(["icons-large", "icons-small", "list", "details"] as ViewMode[]).map((m) => ({
                  id: `view-${m}`,
                  label: t(`view.${m}`),
                  checked: viewMode === m,
                  onSelect: () => setViewMode(m),
                })),
                { id: "sep-v1", label: "---" },
                {
                  id: "hidden",
                  label: t("view.hiddenFiles"),
                  shortcut: "Ctrl+H",
                  checked: showHidden,
                  onSelect: () => toggleHidden(),
                },
                {
                  id: "group-by",
                  label: t("view.groupBy"),
                  submenu: [
                    { id: "g-none", label: t("view.noGrouping"), checked: groupBy === "none", onSelect: () => setGroupBy("none") },
                    { id: "g-type", label: t("sort.type"), checked: groupBy === "type", onSelect: () => setGroupBy("type") },
                    { id: "g-date", label: t("sort.modified"), checked: groupBy === "date", onSelect: () => setGroupBy("date") },
                  ],
                },
              ]}
            />
            <ToolbarMenu
              triggerClassName={styles.toolBtn}
              title={t("sort.title")}
              trigger={<><Icon name="arrowUp" size={16} style={sortDir === "asc" ? undefined : { transform: "rotate(180deg)" }} /><Icon name="chevronDown" size={12} /></>}
              items={[
                { id: "s-name", label: t("sort.name"), checked: sortKey === "name", onSelect: () => setSort("name") },
                { id: "s-modified", label: t("sort.modified"), checked: sortKey === "modified", onSelect: () => setSort("modified") },
                { id: "s-size", label: t("sort.size"), checked: sortKey === "size", onSelect: () => setSort("size") },
                { id: "s-type", label: t("sort.type"), checked: sortKey === "type", onSelect: () => setSort("type") },
                { id: "sep-s1", label: "---" },
                { id: "s-asc", label: t("sort.asc"), checked: sortDir === "asc", onSelect: () => setSort(sortKey, "asc") },
                { id: "s-desc", label: t("sort.desc"), checked: sortDir === "desc", onSelect: () => setSort(sortKey, "desc") },
                { id: "sep-s2", label: "---" },
                { id: "s-dirs", label: t("sort.dirsFirst"), checked: dirsFirst, onSelect: () => toggleDirsFirst() },
              ]}
            />
          </div>
        </div>

        {showNewFolder && (
          <div className={styles.newFolderBar}>
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleNewFolder()}
              placeholder={t("new.folderPlaceholder")}
              autoFocus
            />
            <Button stufe="filled" groesse="s" onClick={handleNewFolder}>{t("actions.create")}</Button>
            <Button stufe="text" groesse="s" onClick={() => setShowNewFolder(false)}>{t("actions.cancel")}</Button>
          </div>
        )}

        {paneHint && <div className={styles.noteBanner}>{paneHint}</div>}

        {/* Header like planner/knowledge: folder name + source · count */}
        {searchResults === null && !searchLoading && (
          <div className={styles.ordnerKopf}>
            <Icon name={breadcrumbs.length ? "folder" : "cloud"} size={18} />
            <h2 className={styles.ordnerTitel}>
              {breadcrumbs.length ? decodeURIComponent(breadcrumbs[breadcrumbs.length - 1]) : sourceName}
            </h2>
            <span className={styles.ordnerSub}>
              {sourceName}{!loading && !error ? ` · ${t("count.items", { count: items.length })}` : ""}
            </span>
          </div>
        )}

        <div className={styles.paneRow}>
          {splitPane && activePaneIdx === 1 && (
            <>
              <SimplePane side={0} style={{ flexBasis: `${splitRatio * 100}%`, flexGrow: 0, flexShrink: 0 }} />
              <div className={styles.paneSplitter} onMouseDown={startSplitDrag} role="separator" aria-label={t("view.splitDivider")} />
            </>
          )}
          <div
            className={`${styles.paneMain} ${splitPane ? styles.paneActive : ""}`}
            style={splitPane && activePaneIdx === 0
              ? { flexBasis: `${splitRatio * 100}%`, flexGrow: 0, flexShrink: 0 }
              : undefined}
          >
        {tree?.note && <div className={styles.noteBanner}>{tree.note}</div>}

        {/* Search results (recursive, Enter in the search field) */}
        {searchLoading || searchResults !== null ? (
          searchLoading ? (
            <div className={styles.emptyState}>{t("search.searching")}</div>
          ) : (
            <div className={styles.fileList}>
              {searchTruncated && (
                <div className={styles.noteBanner}>{t("search.truncated")}</div>
              )}
              {(searchResults ?? []).length === 0 ? (
                <div className={styles.emptyState}>{t("empty.noHits")}</div>
              ) : (
                (searchResults ?? []).map((node) => {
                  const parent = node.path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
                  return (
                    <div
                      key={`${node.source}:${node.path}`}
                      className={styles.fileRow}
                      onDoubleClick={() => (node.isDir
                        ? handleNavigate(node.source || activeSource, node.path)
                        : openNode(node))}
                    >
                      <span className={`${styles.detailName} ${styles.detailNameCell}`}>
                        <FileTypeIcon name={node.name} isDir={node.isDir} px={18} className={styles.rowTypeIcon} />
                        <span>
                          {node.name}
                          <span className={styles.searchParent}> — {parent}</span>
                        </span>
                      </span>
                      <IconButton
                        label={t("search.openParent")} icon="folder" groesse="s"
                        onClick={() => handleNavigate(node.source || activeSource, parent)}
                      />
                    </div>
                  );
                })
              )}
            </div>
          )
        ) : loading ? (
          <div className={styles.emptyState}>{t("status.loading")}</div>
        ) : error ? (
          <div className={styles.errorPanel}>
            <div className={styles.errorIcon}>
              <Icon name={error.code === "device_offline" ? "devices" : "warning"} size={40} />
            </div>
            <div className={styles.errorTitle}>
              {error.code === "device_offline"
                ? error.status === "sshd_down"
                  ? t("errors.sshdDown", { device: error.device ?? sourceName })
                  : t("errors.offline", { device: error.device ?? sourceName })
                : t("errors.loadFolder")}
            </div>
            <div className={styles.errorDetail}>
              {error.code === "device_offline"
                ? error.status === "sshd_down"
                  ? INSTALL_TEXTS.deviceSshdDown
                  : INSTALL_TEXTS.deviceOffline
                : error.message}
              {error.last_seen && (
                <div>{t("errors.lastSeen", { date: new Date(error.last_seen).toLocaleString(regionLocale()) })}</div>
              )}
            </div>
            <Button stufe="tonal" icon="reload" onClick={() => { void loadSources(true).then(() => loadTree(activeSource, currentPath || "/")); }}>{t("actions.retry")}</Button>
          </div>
        ) : items.length === 0 ? (
          <WindowContextMenu
            items={[
              { id: "new-folder", label: t("new.folder"), onSelect: () => setShowNewFolder(true) },
              ...(clipboard
                ? [{ id: "paste", label: t("actions.paste"), shortcut: `${ctrlKey}+V`,
                     onSelect: () => { void ops.paste(activeSource, currentPath || "/"); } }]
                : []),
            ]}
          >
            <div className={styles.emptyState}>
              <Leerzustand
                symbol={<Icon name="folder" size={36} />}
                titel={t("empty.folder")}
                hinweis={t("empty.folderHint")}
                aktionen={[
                  { label: t("actions.upload"), onClick: () => uploadInputRef.current?.click() },
                  { label: t("new.folder"), onClick: () => setShowNewFolder(true), zweitrangig: true },
                ]}
              />
            </div>
          </WindowContextMenu>
        ) : (
          <ContextMenu.Root>
            <ContextMenu.Trigger asChild>
              <div
                className={viewMode === "list" || viewMode === "details" ? styles.fileList : viewMode === "icons-small" ? styles.fileGridSmall : styles.fileGrid}
                onMouseDown={handleLassoDown}
              >
                {viewMode === "details" && (
                  <div className={styles.detailsHeader}>
                    <button className={`${styles.detailName} ${styles.headerBtn}`} onClick={() => setSort("name")}>
                      {t("details.name")}{sortKey === "name" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                    <button className={`${styles.detailType} ${styles.headerBtn}`} onClick={() => setSort("type")}>
                      {t("details.type")}{sortKey === "type" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                    <button className={`${styles.detailSize} ${styles.headerBtn}`} onClick={() => setSort("size")}>
                      {t("details.size")}{sortKey === "size" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                    <button className={`${styles.detailDate} ${styles.headerBtn}`} onClick={() => setSort("modified")}>
                      {t("details.modified")}{sortKey === "modified" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                  </div>
                )}
                {groups.map((group) => (
                <Fragment key={group.label ?? "_"}>
                {group.label && <div className={styles.groupHeader}>{group.label}</div>}
                {group.items.map((node) => {
                  const allPaths = items.map((it: FileNode) => it.path);
                  const defaultApp = node.isDir ? null : resolveFileApp(node.name, openWithOverrides);
                  const isNc = (node.source || activeSource) === "nextcloud";
                  const targets = targetsFor(node);
                  const fileItemMenu = buildFileItemMenu(node, {
                    variant: "desktop",
                    count: targets.length,
                    symbol: (name) => <Icon name={name} size={16} />,
                    defaultApp,
                    trashEnabled: isNc,
                    onOpen: openNode,
                    onOpenWith: (n, viewerId) =>
                      useWindowsStore.getState().openWindow(viewerId, {
                        title: n.name,
                        ...getViewerSize(viewerId),
                        path: n.path,
                        source: activeSource,
                      }),
                    onClaraAnalyze: (n) => {
                      selectFile(n.path, "single", allPaths);
                      const win = useWindowsStore.getState().windows[windowId];
                      if (win && !win.claraInlineOpen) {
                        useWindowsStore.getState().toggleClaraInline(windowId);
                      }
                    },
                    onOpenInNewTab: (n) => openTab(n.source || activeSource, n.path, { background: true }),
                    onOpenInSplit: (n) => openSplitAt(n.source || activeSource, n.path),
                    onAddToPlaces: (n) => addPlace(n.name, n.source || activeSource, n.path),
                    onToggleFavorite: isNc
                      ? (n) => { void setFavorite(n.path, !favSet.has(n.path)); }
                      : undefined,
                    isFavorite: favSet.has(node.path),
                    onDownload: (n) => {
                      const ts = targetsFor(n);
                      if (ts.length === 1) void downloadFile(activeSource, n.path, n.name);
                      else downloadMany(activeSource, ts.map((it) => it.path));
                    },
                    onArchive: (n) => { void archiveItem(n); },
                    onExtract: (n) => { void extractItem(n); },
                    onEncrypt: (n) => { void encryptItem(n); },
                    onDesktopShortcut: (n) => { void createDesktopShortcut(n); },
                    onCopy: (n) => setClipboard("copy", activeSource, targetsFor(n).map((it) => it.path)),
                    onCut: (n) => setClipboard("cut", activeSource, targetsFor(n).map((it) => it.path)),
                    onPaste: clipboard && node.isDir
                      ? (n) => { void ops.paste(activeSource, n.path); }
                      : undefined,
                    onRename: (n) => setRenaming({ path: n.path, value: n.name }),
                    shiftHeld,
                    onShare: isNc ? (n) => setShareNode(n) : undefined,
                    onPrint: hasPrinter ? (n) => setPrintNode(n) : undefined,
                    onVersions: isNc ? (n) => setVersionsNode(n) : undefined,
                    onDelete: (n, permanent) => deleteNodes(targetsFor(n), permanent === true),
                    onProperties: (n) => setPropsNode(n),
                  });
                  return (
                    <WindowContextMenu key={node.path} items={fileItemMenu}>
                      <FileItem
                        node={node}
                        source={activeSource}
                        viewMode={viewMode}
                        data-lasso-path={node.path}
                        selected={selectedFiles.includes(node.path)}
                        cut={cutPaths?.has(node.path) ?? false}
                        dropTarget={dropTarget === node.path}
                        onOpen={() => openNode(node)}
                        onRightClick={() => {
                          // Right-click on an unselected item selects it (Explorer/Dolphin)
                          if (!selectedFiles.includes(node.path)) selectFile(node.path, "single", allPaths);
                        }}
                        onFolderDragOver={node.isDir ? (e) => {
                          const d = useDragStore.getState().current;
                          if (!d || (d.type !== "file" && d.type !== "files")) return;
                          const dragged = d.type === "file" ? [d.path] : d.paths;
                          if (dragged.includes(node.path)) return;
                          e.preventDefault();
                          e.stopPropagation();
                          e.dataTransfer.dropEffect = (e.ctrlKey || e.metaKey) ? "copy" : "move";
                          if (dropTarget !== node.path) setDropTarget(node.path);
                        } : undefined}
                        onFolderDragLeave={node.isDir ? () => setDropTarget((cur) => (cur === node.path ? null : cur)) : undefined}
                        onFolderDrop={node.isDir ? (e) => { void dropInto(e, node.path); } : undefined}
                        onMiddleOpen={node.isDir
                          ? (fg) => openTab(node.source || activeSource, node.path, { background: !fg })
                          : undefined}
                        onSelect={(mode) => selectFile(node.path, mode, allPaths)}
                        onDragStart={(n) => {
                          // If n is part of the selection, the whole selection is dragged
                          const ts = targetsFor(n);
                          useDragStore.getState().startDrag(ts.length > 1
                            ? { type: "files", source: activeSource, paths: ts.map((it) => it.path) }
                            : { type: "file", source: activeSource, path: n.path, name: n.name, isDir: n.isDir });
                        }}
                        onDragEnd={() => useDragStore.getState().endDrag()}
                      />
                    </WindowContextMenu>
                  );
                })}
                </Fragment>
                ))}
                {lasso && (
                  <div
                    className={styles.lassoBox}
                    style={{ left: lasso.x, top: lasso.y, width: lasso.w, height: lasso.h }}
                  />
                )}
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className={styles.ctxMenu}>
                <ContextMenu.Sub>
                  <ContextMenu.SubTrigger className={styles.ctxItem}>
                    {t("new.title")}
                    <span style={{ marginLeft: "auto" }}>›</span>
                  </ContextMenu.SubTrigger>
                  <ContextMenu.Portal>
                    <ContextMenu.SubContent className={styles.ctxMenu}>
                      <ContextMenu.Item className={styles.ctxItem} onSelect={() => setShowNewFolder(true)}>
                        <FileTypeIcon isDir px={15} /> {t("new.folderShort")}
                      </ContextMenu.Item>
                      <ContextMenu.Separator className={styles.ctxSep} />
                      {NEW_FILE_TEMPLATES.map((tpl) => (
                        <ContextMenu.Item
                          key={tpl.ext}
                          className={styles.ctxItem}
                          onSelect={() => { void createFromTemplate(tpl.ext); }}
                        >
                          <FileTypeIcon name={`neu${tpl.ext}`} px={15} /> {templateLabel(tpl)} ({tpl.ext})
                        </ContextMenu.Item>
                      ))}
                    </ContextMenu.SubContent>
                  </ContextMenu.Portal>
                </ContextMenu.Sub>
                <ContextMenu.Separator className={styles.ctxSep} />
                <ContextMenu.Item className={styles.ctxItem} disabled={selectedFiles.length === 0}
                  onSelect={() => setClipboard("copy", activeSource, selectedFiles)}>
                  {t("actions.copy")}
                </ContextMenu.Item>
                <ContextMenu.Item className={styles.ctxItem} disabled={selectedFiles.length === 0}
                  onSelect={() => setClipboard("cut", activeSource, selectedFiles)}>
                  {t("actions.cut")}
                </ContextMenu.Item>
                {clipboard && (
                  <ContextMenu.Item className={styles.ctxItem}
                    onSelect={() => { void ops.paste(activeSource, currentPath || "/"); }}>
                    {t("actions.paste")}
                  </ContextMenu.Item>
                )}
                <ContextMenu.Item className={styles.ctxItem} disabled={items.length === 0}
                  onSelect={() => setSelection(items.map((n) => n.path))}>
                  {t("actions.selectAll")}
                </ContextMenu.Item>
                <ContextMenu.Separator className={styles.ctxSep} />
                <ContextMenu.Item
                  className={styles.ctxItem}
                  onSelect={startRename}
                  disabled={selectedFiles.length !== 1}
                >
                  {t("actions.rename")}
                </ContextMenu.Item>
                <ContextMenu.Item className={styles.ctxItem} disabled={selectedFiles.length === 0}
                  onSelect={() => { void deleteNodes(items.filter((n) => selectedFiles.includes(n.path)), false); }}>
                  {activeSource === "nextcloud" ? t("actions.moveToTrash") : t("actions.delete")}
                </ContextMenu.Item>
                <ContextMenu.Separator className={styles.ctxSep} />
                <ContextMenu.Item
                  className={styles.ctxItem}
                  onSelect={showProperties}
                  disabled={selectedFiles.length !== 1}
                >
                  {t("actions.properties")}
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        )}
          </div>
          {splitPane && activePaneIdx === 0 && (
            <>
              <div className={styles.paneSplitter} onMouseDown={startSplitDrag} role="separator" aria-label={t("view.splitDivider")} />
              <SimplePane side={1} style={{ flex: 1 }} />
            </>
          )}
        </div>

        {renaming && (
          <div className={styles.renameOverlay} onClick={commitRename}>
            <div className={styles.renameBox} onClick={(e) => e.stopPropagation()}>
              <label>{t("actions.rename")}</label>
              <input
                autoFocus
                value={renaming.value}
                onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                  else if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                }}
              />
              <div className={styles.renameActions}>
                <Button stufe="text" groesse="s" onClick={() => setRenaming(null)}>{t("actions.cancel")}</Button>
                <Button stufe="filled" groesse="s" onClick={commitRename}>{t("actions.ok")}</Button>
              </div>
            </div>
          </div>
        )}

        {openWithNode && (
          <OpenWithDialog
            node={openWithNode}
            source={openWithNode.source || activeSource}
            onPick={(viewerId) => openWith(openWithNode, viewerId)}
            onClose={() => setOpenWithNode(null)}
          />
        )}

        {printNode && (
          <PrintDialog
            path={printNode.path}
            name={printNode.name}
            source={printNode.source || activeSource}
            onClose={() => setPrintNode(null)}
          />
        )}
        {shareNode && (
          <ShareDialog
            path={shareNode.path}
            name={shareNode.name}
            onClose={() => setShareNode(null)}
          />
        )}

        {versionsNode && (
          <VersionsDialog
            path={versionsNode.path}
            name={versionsNode.name}
            onClose={() => setVersionsNode(null)}
            confirmDlg={confirmDlg}
          />
        )}

        <PropertiesDialog
          open={!!propsNode}
          title={propsNode?.name ?? ""}
          onClose={() => setPropsNode(null)}
          rows={propsNode ? [
            { label: t("details.type"), value: propsNode.isDir ? folderTypeName() : getFileTypeInfo(propsNode.name).name },
            { label: t("details.source"), value: sourceName },
            { label: t("details.path"), value: propsNode.path },
            { label: t("details.size"), value: formatBytes(propsNode.size) },
            { label: t("details.modified"), value: formatDateTime(propsNode.modified ? String(propsNode.modified) : undefined) },
          ] : []}
        />

        {/* Status bar */}
        <div className={styles.statusBar}>
          <span>
            {t("count.items", { count: items.length })}
            {dotfilesHidden > 0 && ` ${t("count.hidden", { count: dotfilesHidden })}`}
          </span>
          {selectedFiles.length > 0 && <span>{t("count.selected", { count: selectedFiles.length })}</span>}
          {ops.upload && (
            <span className={styles.uploadStatus} role="status">
              {ops.upload.count > 1
                ? t("upload.desktopCount", { index: ops.upload.index + 1, total: ops.upload.count, name: ops.upload.name })
                : t("upload.desktop", { name: ops.upload.name })}
              <span className={styles.uploadBar}><span style={{ width: `${Math.round(ops.upload.fraction * 100)}%` }} /></span>
              {Math.round(ops.upload.fraction * 100)} %
            </span>
          )}
        </div>
        </>
        )}
      </div>
      {dialogHost}
      </div>
    </div>
  );
}

// ─── Trash view ──────────────────────────────────────────

function TrashView({ confirmDlg }: { confirmDlg: (message: string, confirmLabel?: string) => Promise<boolean> }) {
  const { trashItems, trashLoading, closeTrash, restoreTrashItem, purgeTrashItem, emptyTrash } = useFileStore();
  const items = trashItems ?? [];
  const { t } = useTranslation("files");

  const restore = (name: string, trashPath: string) => {
    void confirmDlg(t("confirm.restore", { name }), t("actions.restore")).then((ok) => {
      if (ok) void restoreTrashItem(trashPath);
    });
  };

  return (
    <>
      <div className={styles.toolbar}>
        <div className={styles.breadcrumb}>
          <button className={styles.breadcrumbItem} onClick={closeTrash}><Icon name="back" size={14} /> {t("trash.back")}</button>
          <span className={styles.breadcrumbSep}>/</span>
          <span className={styles.breadcrumbItem}><Icon name="trash" size={14} /> {t("sections.trash")}</span>
        </div>
        <div className={styles.toolbarActions}>
          <Button
            stufe="text" groesse="s" icon="trash"
            disabled={items.length === 0}
            onClick={() => {
              void confirmDlg(t("confirm.emptyTrash", { count: items.length }), t("actions.emptyConfirm"))
                .then((ok) => { if (ok) void emptyTrash(); });
            }}
          >
            {t("actions.emptyTrash")}
          </Button>
        </div>
      </div>
      {trashLoading ? (
        <div className={styles.emptyState}>{t("status.loading")}</div>
      ) : items.length === 0 ? (
        <div className={styles.emptyState}>
          <Leerzustand symbol={<Icon name="trash" size={36} />} titel={t("empty.trash")}
                       hinweis={t("empty.trashHint")} />
        </div>
      ) : (
        <div className={styles.fileList}>
          <div className={styles.detailsHeader}>
            <span className={styles.detailName}>{t("details.name")}</span>
            <span className={styles.trashOrigin}>{t("trash.originalLocation")}</span>
            <span className={styles.detailDate}>{t("trash.deleted")}</span>
          </div>
          {items.map((it) => (
            <WindowContextMenu
              key={it.trashPath}
              items={[
                { id: "restore", label: t("actions.restore"), onSelect: () => restore(it.name, it.trashPath) },
                {
                  id: "purge",
                  label: t("actions.deletePermanently"),
                  variant: "destructive",
                  onSelect: () => {
                    void confirmDlg(t("confirm.purge", { name: it.name }), t("actions.deletePermanently"))
                      .then((ok) => { if (ok) void purgeTrashItem(it.trashPath); });
                  },
                },
              ]}
            >
              <div className={styles.fileRow} onDoubleClick={() => restore(it.name, it.trashPath)}>
                <span className={`${styles.detailName} ${styles.detailNameCell}`}>
                  <FileTypeIcon name={it.name} isDir={it.isDir} px={18} className={styles.rowTypeIcon} />
                  {it.name}
                </span>
                <span className={styles.trashOrigin} title={it.originalPath}>
                  {it.originalPath ? "/" + it.originalPath.split("/").slice(0, -1).join("/").replace(/^\//, "") : ""}
                </span>
                <span className={styles.detailDate}>
                  {it.deletedAt ? new Date(it.deletedAt * 1000).toLocaleString(regionLocale()) : ""}
                </span>
              </div>
            </WindowContextMenu>
          ))}
        </div>
      )}
      <div className={styles.statusBar}>
        <span>{t("trash.count", { count: items.length })}</span>
      </div>
    </>
  );
}

// ─── Places bar (KFilePlaces model) ───────────────────────
// System entries can only be hidden, never deleted; user entries come via
// "add to places" or folder drop and live in files.places.

/** Places, sources and favorites are drawn with icons rather than emoji
 *  (🏠 🖥️ 📄 ⬇️ ⭐ 🗑 ☁), which render differently on each device. The data keeps
 *  its character (user places come from `files.places`); an icon from our own
 *  set is drawn. Unknown characters stay visible, nothing disappears. */
const ORT_SYMBOLE: Record<string, IconName> = {
  "🏠": "home", "🖥️": "devices", "🖥": "devices", "📄": "document", "⬇️": "import", "⬇": "import",
  "📁": "folder", "📂": "folder", "⭐": "star", "🗑": "trash", "🗑️": "trash", "☁️": "cloud", "☁": "cloud",
  "💾": "devices", "🔗": "link", "📷": "camera", "🖼": "image", "🖼️": "image",
};
function OrtSymbol({ icon, size = 15 }: { icon?: string; size?: number }) {
  const name = icon ? ORT_SYMBOLE[icon] : "folder";
  return (
    <span className={styles.treeIcon} aria-hidden="true">
      {name ? <Icon name={name} size={size} /> : (icon ?? <Icon name="folder" size={size} />)}
    </span>
  );
}

// titleKey: translated at render time (`files:places.*`); the paths are real
// folder names on the server and stay as they are.
const SYSTEM_PLACES = [
  { id: "sys:home", titleKey: "places.homeFolder", source: "nextcloud", path: "/", icon: "🏠" },
  { id: "sys:desktop", titleKey: "places.desktop", source: "nextcloud", path: "/Desktop", icon: "🖥️" },
  { id: "sys:documents", titleKey: "places.documents", source: "nextcloud", path: "/Dokumente", icon: "📄" },
  { id: "sys:downloads", titleKey: "places.downloads", source: "nextcloud", path: "/Downloads", icon: "⬇️" },
];

function PlacesSection({ onNavigate, promptDlg }: {
  onNavigate: (source: string, path: string) => void;
  promptDlg: (message: string, defaultValue?: string) => Promise<string | null>;
}) {
  const {
    places, hiddenSystemPlaces, showHiddenPlaces, setShowHiddenPlaces,
    addPlace, removePlace, renamePlace, movePlace, hideSystemPlace, unhideSystemPlace,
    favorites, loadFavorites, openTab, openSplitAt,
    activeSource, currentPath, trashItems,
  } = useFileStore();
  const { t } = useTranslation("files");

  useEffect(() => {
    if (favorites === null) void loadFavorites();
  }, [favorites, loadFavorites]);

  const anyHidden = hiddenSystemPlaces.length > 0;
  const rows = [
    ...SYSTEM_PLACES.map(({ titleKey, ...p }) => ({
      ...p, title: t(titleKey), system: true, hidden: hiddenSystemPlaces.includes(p.id),
    })),
    ...places.map((p) => ({ ...p, system: false, hidden: false })),
  ].filter((r) => showHiddenPlaces || !r.hidden);

  const headerMenu = [
    ...(anyHidden
      ? [{
          id: "show-all",
          label: showHiddenPlaces ? t("places.hideHiddenAgain") : t("places.showAll"),
          onSelect: () => setShowHiddenPlaces(!showHiddenPlaces),
        }]
      : []),
    { id: "add-current", label: t("places.addCurrent"), onSelect: () => {
        addPlace(currentPath.split("/").filter(Boolean).pop() ?? "/", activeSource, currentPath || "/");
      } },
  ];

  return (
    <div data-places>
      <WindowContextMenu items={headerMenu}>
        <div className={styles.treePanelHeader}>{t("sections.places")}</div>
      </WindowContextMenu>
      {rows.map((r) => (
        <WindowContextMenu
          key={r.id}
          items={[
            { id: "p-tab", label: t("menu.openInNewTab"), onSelect: () => openTab(r.source, r.path, { background: true }) },
            { id: "p-split", label: t("menu.openInSplit"), onSelect: () => openSplitAt(r.source, r.path) },
            { id: "p-sep", label: "---" },
            ...(r.system
              ? [r.hidden
                  ? { id: "p-unhide", label: t("places.unhide"), onSelect: () => unhideSystemPlace(r.id) }
                  : { id: "p-hide", label: t("places.hide"), onSelect: () => hideSystemPlace(r.id) }]
              : [
                  { id: "p-rename", label: t("places.rename"), onSelect: () => {
                      void promptDlg(t("places.renamePrompt"), r.title).then((v) => { if (v) renamePlace(r.id, v); });
                    } },
                  { id: "p-up", label: t("places.moveUp"), onSelect: () => movePlace(r.id, -1) },
                  { id: "p-down", label: t("places.moveDown"), onSelect: () => movePlace(r.id, 1) },
                  { id: "p-remove", label: t("places.remove"), variant: "destructive" as const, onSelect: () => removePlace(r.id) },
                ]),
          ]}
        >
          <div
            className={`${styles.treeNode} ${r.hidden ? styles.placeHidden : ""} ${trashItems === null && activeSource === r.source && currentPath === r.path ? styles.treeNodeActive : ""}`}
            style={{ paddingLeft: 10 }}
            data-place={r.id}
            onClick={() => onNavigate(r.source, r.path)}
            onMouseUp={(e) => {
              if (e.button === 1) { e.preventDefault(); openTab(r.source, r.path, { background: !e.shiftKey }); }
            }}
          >
            <span className={styles.treeExpander}> </span>
            <span><OrtSymbol icon={r.icon ?? "📁"} /> {r.title}</span>
          </div>
        </WindowContextMenu>
      ))}
      {(favorites?.length ?? 0) > 0 && (
        <>
          <div className={styles.treePanelHeader}>{t("sections.favorites")}</div>
          {favorites!.map((f) => {
            const parent = f.path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
            return (
              <div
                key={f.path}
                className={styles.treeNode}
                style={{ paddingLeft: 10 }}
                data-favorite={f.path}
                title={f.path}
                onClick={() => onNavigate("nextcloud", f.isDir ? f.path : parent)}
                onMouseUp={(e) => {
                  if (e.button === 1 && f.isDir) { e.preventDefault(); openTab("nextcloud", f.path, { background: !e.shiftKey }); }
                }}
              >
                <span className={styles.treeExpander}> </span>
                <span><OrtSymbol icon="⭐" /> {f.name}</span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── Inactive pane of the split view ──────────────────────
// The full view (bound to the toolbar) always shows the ACTIVE pane; the
// inactive one is a slim list from the tree cache. Interacting with the
// inactive pane activates it (Dolphin behavior).

function SimplePane({ side, style }: { side: 0 | 1; style?: React.CSSProperties }) {
  const { tabs, activeTab, treeCache, setActivePane, loadPaneTree, navigateTo, showHidden } = useFileStore();
  const { t } = useTranslation("files");
  const tab = tabs[activeTab];
  const pane = side === 1 ? tab?.split : tab ? { source: tab.source, path: tab.path } : undefined;
  const cacheKey = pane ? `${pane.source}:${pane.path}` : "";
  const tree = pane ? treeCache[cacheKey] : undefined;

  useEffect(() => {
    if (pane && !tree) void loadPaneTree(pane.source, pane.path);
  }, [cacheKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (!pane) return null;
  const children = (tree?.children ?? []).filter((n: FileNode) => showHidden || !n.name.startsWith("."));
  return (
    <div
      className={styles.paneSecondary}
      style={style}
      data-pane={side}
      onMouseDown={() => setActivePane(side)}
    >
      <div className={styles.paneSecondaryHeader} title={pane.path || "/"}>
        {pane.path || "/"}
      </div>
      {!tree ? (
        <div className={styles.emptyState}>{t("status.loadingShort")}</div>
      ) : children.length === 0 ? (
        <div className={styles.emptyState}>{t("empty.folderShort")}</div>
      ) : (
        <div className={styles.fileList}>
          {children.map((n: FileNode) => (
            <div
              key={n.path}
              className={styles.fileRow}
              onDoubleClick={() => {
                setActivePane(side);
                if (n.isDir) navigateTo(pane.source, n.path);
              }}
            >
              <span className={styles.detailNameCell}>
                <FileTypeIcon name={n.name} isDir={n.isDir} px={18} className={styles.rowTypeIcon} />
                {n.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tree Source Node ─────────────────────────────────────

function TreeSourceNode({ source, isActive, onNavigate }: {
  source: FileSourceInfo; isActive: boolean;
  onNavigate: (source: string, path: string) => void;
}) {
  const { sidebarExpanded, toggleSidebarNode, treeCache, loadTree } = useFileStore();
  const { t } = useTranslation("files");
  const key = source.id;
  const expanded = sidebarExpanded[key] ?? isActive;
  // Device start path (Android: /sdcard); "/" is unreadable on phones
  const home = source.default_path ?? "/";
  const cached = treeCache[`${source.id}:${home}`];
  const offline = source.connected === false;

  const handleToggle = () => {
    toggleSidebarNode(key);
    if (!expanded && !cached) {
      loadTree(source.id, home);
    }
  };

  return (
    <div className={styles.treeSource}>
      <div
        className={`${styles.treeSourceHeader} ${isActive ? styles.treeSourceActive : ""} ${offline ? styles.sourceOffline : ""}`}
        onClick={handleToggle}
      >
        <span className={styles.treeExpander}><Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} /></span>
        <span><OrtSymbol icon={source.icon} /> {source.name}</span>
        {offline && (
          <span className={styles.offlineBadge}>
            {/* Important: "no access" is different from "offline": the user can
                fix the one themselves, not the other. */}
            {source.status === "kein_zugang" ? t("source.noAccessShort")
              : source.status === "sshd_down" ? t("source.sshOff") : t("source.offline")}
          </span>
        )}
      </div>
      {expanded && cached?.children && (
        <div className={styles.treeChildren}>
          {cached.children.filter((c: FileNode) => c.isDir).map((child: FileNode) => (
            <TreeNode
              key={child.path}
              node={child}
              source={source.id}
              depth={1}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeNode({ node, source, depth, onNavigate }: {
  node: FileNode; source: string; depth: number;
  onNavigate: (source: string, path: string) => void;
}) {
  const { currentPath, activeSource, sidebarExpanded, toggleSidebarNode, loadTree, treeCache } = useFileStore();
  const key = `${source}:${node.path}`;
  const expanded = sidebarExpanded[key] ?? false;
  const isActive = activeSource === source && currentPath === node.path;
  const cached = treeCache[key];

  const handleClick = () => {
    onNavigate(source, node.path);
  };

  const handleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleSidebarNode(key);
    if (!expanded && !cached) {
      loadTree(source, node.path);
    }
  };

  return (
    <div>
      <div
        className={`${styles.treeNode} ${isActive ? styles.treeNodeActive : ""}`}
        style={{ paddingLeft: depth * 16 }}
        onClick={handleClick}
        onMouseUp={(e) => {
          // Middle-click = background tab, Shift+middle-click = foreground (Dolphin)
          if (e.button === 1 && node.isDir) {
            e.preventDefault();
            useFileStore.getState().openTab(source, node.path, { background: !e.shiftKey });
          }
        }}
      >
        <span className={styles.treeExpander} onClick={handleExpand}>
          {node.isDir ? <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} /> : " "}
        </span>
        <span className={styles.detailNameCell}>
          <FileTypeIcon name={node.name} isDir={node.isDir} px={15} className={styles.rowTypeIcon} />
          {node.name}
        </span>
      </div>
      {expanded && cached?.children && (
        <div>
          {cached.children.filter((c: FileNode) => c.isDir).map((child: FileNode) => (
            <TreeNode key={child.path} node={child} source={source} depth={depth + 1} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── File Item ────────────────────────────────────────────

type SelectMode = "single" | "toggle" | "range";

function pickMode(e: React.MouseEvent): SelectMode {
  if (e.shiftKey) return "range";
  if (e.ctrlKey || e.metaKey) return "toggle";
  return "single";
}

// forwardRef + rest spread: Radix' asChild (WindowContextMenu trigger) attaches
// onContextMenu/ref; without passing them on, the row trigger is dead and the
// right-click falls through to the container menu.
const FileItem = forwardRef<HTMLDivElement, {
  node: FileNode; source: string; viewMode: ViewMode; selected: boolean;
  /** Cut to the clipboard (dimmed). */
  cut?: boolean;
  /** Folder currently being dragged over. */
  dropTarget?: boolean;
  onOpen: () => void; onSelect: (mode: SelectMode) => void;
  /** Before the context menu: select an unselected item. */
  onRightClick?: () => void;
  onFolderDragOver?: (e: React.DragEvent) => void;
  onFolderDragLeave?: () => void;
  onFolderDrop?: (e: React.DragEvent) => void;
  /** Middle-click on a folder: background tab; with Shift foreground (Dolphin). */
  onMiddleOpen?: (foreground: boolean) => void;
  onDragStart: (node: FileNode) => void;
  onDragEnd: () => void;
} & React.HTMLAttributes<HTMLDivElement>>(function FileItem(
  { node, source, viewMode, selected, cut, dropTarget, onOpen, onSelect, onRightClick,
    onFolderDragOver, onFolderDragLeave, onFolderDrop, onMiddleOpen, onDragStart, onDragEnd, ...rest },
  ref,
) {
  // Radix (asChild) passes onContextMenu through rest; call both
  const radixCtx = rest.onContextMenu;
  const common = {
    onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => { onRightClick?.(); radixCtx?.(e); },
    onDragOver: onFolderDragOver,
    onDragLeave: onFolderDragLeave,
    onDrop: onFolderDrop,
  };
  const state = `${selected ? styles.fileSelected : ""} ${cut ? styles.fileCut : ""} ${dropTarget ? styles.dropTarget : ""}`;
  const middleHandlers = onMiddleOpen
    ? {
        onMouseDown: (e: React.MouseEvent) => { if (e.button === 1) e.preventDefault(); },
        onMouseUp: (e: React.MouseEvent) => {
          if (e.button === 1) { e.preventDefault(); onMiddleOpen(e.shiftKey); }
        },
      }
    : {};
  if (viewMode === "list" || viewMode === "details") {
    return (
      <div
        ref={ref}
        {...rest}
        {...middleHandlers}
        {...common}
        className={`${styles.fileRow} ${state}`}
        onClick={(e) => onSelect(pickMode(e))}
        onDoubleClick={onOpen}
        draggable
        onDragStart={() => onDragStart(node)}
        onDragEnd={onDragEnd}
      >
        <span className={`${styles.detailName} ${styles.detailNameCell}`}>
          <FileTypeIcon name={node.name} isDir={node.isDir} px={20} className={styles.rowTypeIcon} />
          {node.name}
        </span>
        {viewMode === "details" && (
          <>
            <span className={styles.detailType}>{node.isDir ? folderTypeName() : getFileTypeInfo(node.name).name}</span>
            <span className={styles.detailSize}>{formatSize(node.size)}</span>
            <span className={styles.detailDate}>{formatDate(node.modified)}</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      {...rest}
      {...middleHandlers}
      {...common}
      className={`${styles.fileCard} ${state}`}
      onClick={(e) => onSelect(pickMode(e))}
      onDoubleClick={onOpen}
      draggable
      onDragStart={() => onDragStart(node)}
      onDragEnd={onDragEnd}
    >
      <span className={viewMode === "icons-large" ? styles.iconLarge : styles.iconSmall}>
        <FileThumb
          source={node.source ?? source}
          path={node.path}
          name={node.name}
          isDir={node.isDir}
          px={viewMode === "icons-large" ? 44 : 26}
        />
      </span>
      <span className={styles.fileName}>{node.name}</span>
      {viewMode === "icons-large" && node.size != null && (
        <span className={styles.fileSize}>{formatSize(node.size)}</span>
      )}
    </div>
  );
});
