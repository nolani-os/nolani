/**
 * Shared controller of the files app: store bindings, navigation, open
 * routing and file operations without JSX. Desktop and mobile views build
 * their own presentation on top; the logic exists only once.
 */
import { useCallback, useEffect } from "react";
import { useFileStore, useWindowsStore, buildObjectUri, type FileNode } from "@claraos/core";
import { getFileAppId, getViewerSizeForFile, type ViewerAppId } from "../../lib/fileTypeRouter";
import { NEW_FILE_TEMPLATES } from "../../lib/newFileTemplates";

export function useFileBrowserCore(windowId: string) {
  const setCurrentObjectUri = useWindowsStore((s) => s.setCurrentObjectUri);
  const store = useFileStore();
  const {
    sources, activeSource, currentPath, tree, loading, error, viewMode,
    selectedFiles, clipboard,
    sortKey, sortDir, dirsFirst, showHidden, groupBy, filterQuery,
    openWithOverrides, filePrefsLoaded,
    trashItems, trashLoading,
    searchResults, searchLoading, searchTruncated,
    tabs, activeTab, closedTabs, alwaysShowTabBar, confirmClosingMultipleTabs,
    openTab, activateTab, closeTab, undoCloseTab, renameTab, goBack, goForward,
    closeSplitViewChoice, toggleSplit, openSplitAt, closeSplit, setActivePane,
    focusOtherPane, setSplitRatio, copyToOtherPane, moveToOtherPane,
    loadSources, loadTree, navigateTo, setViewMode,
    setSort, toggleDirsFirst, toggleHidden, setGroupBy, setFilterQuery,
    setOpenWithOverride, loadFilePrefs,
    loadTrash, closeTrash, restoreTrashItem, purgeTrashItem, emptyTrash,
    searchRecursive, clearSearch,
    selectFile, setSelection, clearSelection, setClipboard, clearClipboard, deleteFile, createFolder, copyFile,
    renameFile,
  } = store;

  useEffect(() => {
    loadSources();
    // Load prefs first (incl. tab session restore), THEN the active tab's
    // tree; otherwise the hard-coded "/" overwrites the restored location.
    void loadFilePrefs().then(() => {
      const s = useFileStore.getState();
      // The remembered folder may have been deleted meanwhile ⇒ show the
      // nearest parent folder instead of starting in an error state
      loadTree(s.activeSource, s.currentPath || "/", { fallbackToParent: true });
    });
  }, [loadFilePrefs, loadSources, loadTree]);

  // Surface the current selection (or current folder) as the inline-chat object-URI
  useEffect(() => {
    const target = selectedFiles[0] ?? currentPath;
    if (target) {
      setCurrentObjectUri(windowId, buildObjectUri("files", `${activeSource}://${target}`));
    } else {
      setCurrentObjectUri(windowId, undefined);
    }
  }, [windowId, activeSource, currentPath, selectedFiles, setCurrentObjectUri]);

  const handleNavigate = useCallback((source: string, path: string) => {
    navigateTo(source, path);
  }, [navigateTo]);

  /** Open a file in a specific viewer (file-aware window size). */
  const openWith = useCallback((node: FileNode & { source?: string }, viewerId: ViewerAppId) => {
    useWindowsStore.getState().openWindow(viewerId, {
      title: node.name,
      ...getViewerSizeForFile(viewerId, node.name),
      path: node.path,
      source: node.source || activeSource,
    });
  }, [activeSource]);

  const handleOpen = useCallback((node: FileNode & { source?: string }) => {
    if (node.isDir) {
      handleNavigate(node.source || activeSource, node.path);
      return;
    }
    // File: route to viewer app (default routing; views with an open-with
    // dialog check resolveFileApp themselves BEFORE they get here)
    openWith(node, getFileAppId(node.name));
  }, [handleNavigate, activeSource, openWith]);

  /** Create a new file from a template; returns the created path
   *  (desktop starts inline rename with it, mobile a dialog). */
  const createFromTemplate = useCallback(async (ext: string): Promise<{ path: string; name: string } | null> => {
    const tpl = NEW_FILE_TEMPLATES.find((t) => t.ext === ext);
    if (!tpl) return null;
    const base = (currentPath || "/").replace(/\/$/, "");
    let name = `Neu${ext}`;
    const taken = new Set((tree?.children ?? []).map((c: FileNode) => c.name.toLowerCase()));
    for (let i = 2; taken.has(name.toLowerCase()) && i < 50; i++) name = `Neu-${i}${ext}`;
    const path = `${base}/${name}`;
    const ok = await useFileStore.getState().writeFile(activeSource, path, tpl.content, tpl.encoding);
    if (!ok) return null;
    loadTree(activeSource, currentPath || "/");
    return { path, name };
  }, [activeSource, currentPath, tree, loadTree]);

  return {
    // state
    sources, activeSource, currentPath, tree, loading, error, viewMode,
    selectedFiles, clipboard,
    sortKey, sortDir, dirsFirst, showHidden, groupBy, filterQuery,
    openWithOverrides, filePrefsLoaded,
    trashItems, trashLoading,
    searchResults, searchLoading, searchTruncated,
    // Tabs + split view (Dolphin model)
    tabs, activeTab, closedTabs, alwaysShowTabBar, confirmClosingMultipleTabs,
    openTab, activateTab, closeTab, undoCloseTab, renameTab, goBack, goForward,
    closeSplitViewChoice, toggleSplit, openSplitAt, closeSplit, setActivePane,
    focusOtherPane, setSplitRatio, copyToOtherPane, moveToOtherPane,
    // store actions (passed through)
    loadSources, loadTree, navigateTo, setViewMode,
    setSort, toggleDirsFirst, toggleHidden, setGroupBy, setFilterQuery, setOpenWithOverride,
    loadTrash, closeTrash, restoreTrashItem, purgeTrashItem, emptyTrash,
    searchRecursive, clearSearch,
    selectFile, setSelection, clearSelection, setClipboard, clearClipboard,
    deleteFile, createFolder, copyFile, renameFile,
    // derived handlers (batch operations: useFileOps)
    handleNavigate, handleOpen, openWith, createFromTemplate,
  };
}
