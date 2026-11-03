import { useCallback, useMemo } from "react";
import {
  useWindowsStore,
  useAppCenterStore,
  useAppRegistryStore,
  useWorkspaceStore,
  useTranslation,
  type AppManifest,
  type WindowInstance,
} from "@claraos/core";
import type { ContextMenuItem } from "../components/WindowContextMenu";

/**
 * The app strip's logic, shared by the Taskbar (one bar) and the Dock
 * (two bars, Orchard): which apps are pinned, which windows run in the
 * active workspace, what a click and a context menu do. Both surfaces must
 * behave identically — this is the one place where that behaviour lives.
 */
export function useTaskbarApps() {
  const windows = useWindowsStore((s) => s.windows);
  const windowOrder = useWindowsStore((s) => s.windowOrder);
  const focusedWindowId = useWindowsStore((s) => s.focusedWindowId);
  const focusWindow = useWindowsStore((s) => s.focusWindow);
  const minimizeWindow = useWindowsStore((s) => s.minimizeWindow);
  const closeWindow = useWindowsStore((s) => s.closeWindow);
  const openWindow = useWindowsStore((s) => s.openWindow);
  const pinnedAppIds = useAppCenterStore((s) => s.pinnedAppIds);
  const unpinApp = useAppCenterStore((s) => s.unpinApp);
  const activeWs = useWorkspaceStore((s) => s.activeId);
  const { t } = useTranslation("shell");

  // Pinned apps – ALWAYS shown, highlighted if open
  const openAppIds = useMemo(() => new Set(Object.values(windows).map((w) => w.appId)), [windows]);
  const pinnedApps = useMemo(
    () => pinnedAppIds.map((id) => useAppRegistryStore.getState().getApp(id)).filter(Boolean) as AppManifest[],
    [pinnedAppIds],
  );

  // Running windows NOT in pinned, filtered by workspace
  const runningWindows = useMemo(
    () => windowOrder
      .map((id) => windows[id])
      .filter((w) => w && !pinnedAppIds.includes(w.appId) &&
        (w.workspaceId === activeWs || (!w.workspaceId && activeWs === "ws-default"))),
    [windows, windowOrder, pinnedAppIds, activeWs],
  );

  const handleWindowClick = useCallback(
    (windowId: string) => {
      const win = windows[windowId];
      if (!win) return;
      if (win.minimized) focusWindow(windowId);
      else if (focusedWindowId === windowId) minimizeWindow(windowId);
      else focusWindow(windowId);
    },
    [windows, focusedWindowId, focusWindow, minimizeWindow],
  );

  const launchApp = useCallback(
    (app: AppManifest) => openWindow(app.id, {
      title: app.name,
      width: app.window.defaultWidth,
      height: app.window.defaultHeight,
      maximized: app.window.startMaximized,
      fullscreen: app.window.startFullscreen,
    }),
    [openWindow],
  );

  const handlePinnedClick = useCallback(
    (appId: string) => {
      const app = useAppRegistryStore.getState().getApp(appId);
      if (!app) return;
      // Check if already open
      const existing = Object.values(windows).find((w) => w.appId === appId);
      if (existing) focusWindow(existing.id);
      else launchApp(app);
    },
    [windows, focusWindow, launchApp],
  );

  /** Context menu of a pinned app (open/focus, new instance, unpin, App Center). */
  const pinContextItems = useCallback(
    (app: AppManifest, isOpen: boolean): ContextMenuItem[] => [
      {
        id: "open",
        label: isOpen ? t("taskbar.pinned.focus", { app: app.name }) : t("taskbar.pinned.open", { app: app.name }),
        onSelect: () => handlePinnedClick(app.id),
      },
      {
        id: "new-instance",
        label: t("taskbar.pinned.newInstance"),
        onSelect: () => launchApp(app),
      },
      { id: "sep1", label: "---" },
      {
        id: "unpin",
        label: t("taskbar.pinned.unpin"),
        onSelect: () => unpinApp(app.id),
        variant: "destructive",
      },
      {
        id: "app-center",
        label: t("taskbar.pinned.openAppCenter"),
        onSelect: () => openWindow("app-center", { title: t("taskbar.pinned.appCenterTitle"), width: 800, height: 600 }),
      },
    ],
    [t, handlePinnedClick, launchApp, unpinApp, openWindow],
  );

  /** Context menu of a running (unpinned) window. */
  const windowContextItems = useCallback(
    (win: WindowInstance): ContextMenuItem[] => [
      { id: "close", label: t("taskbar.window.close"), onSelect: () => closeWindow(win.id) },
      { id: "minimize", label: t("taskbar.window.minimize"), onSelect: () => minimizeWindow(win.id) },
    ],
    [t, closeWindow, minimizeWindow],
  );

  return {
    windows,
    focusedWindowId,
    openAppIds,
    pinnedApps,
    runningWindows,
    handleWindowClick,
    handlePinnedClick,
    pinContextItems,
    windowContextItems,
    closeWindow,
    minimizeWindow,
  };
}
