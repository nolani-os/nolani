import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useWindowsStore, useUIStore, useAppCenterStore, useVoiceStore, useWorkspaceStore, useAppRegistryStore, useDeviceStore, type AppManifest } from "@claraos/core";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { AppIcon } from "../components/AppIcon";
import { WindowContextMenu, type ContextMenuItem } from "../components/WindowContextMenu";
import { TaskbarHoverThumb } from "./TaskbarHoverThumb";
import { TRAY_ITEMS } from "./tray/registry";
import { TrayButton } from "./tray/TrayButton";
import { TrayPopoverHost } from "./tray/TrayPopoverHost";
import ClaraMark from "../Mobile/clara-c.svg?react";
import styles from "./Taskbar.module.css";
import { regionLocale, useTranslation } from "@claraos/core";

interface TaskbarProps {
  layout?: { taskbarPosition: string; taskbarHeight: number };
  onSearchClick?: () => void;
}

export function Taskbar({ layout, onSearchClick }: TaskbarProps) {
  const windows = useWindowsStore((s) => s.windows);
  const windowOrder = useWindowsStore((s) => s.windowOrder);
  const focusedWindowId = useWindowsStore((s) => s.focusedWindowId);
  const focusWindow = useWindowsStore((s) => s.focusWindow);
  const minimizeWindow = useWindowsStore((s) => s.minimizeWindow);
  const closeWindow = useWindowsStore((s) => s.closeWindow);
  const openWindow = useWindowsStore((s) => s.openWindow);
  const toggleStartMenu = useUIStore((s) => s.toggleStartMenu);
  const startMenuOpen = useUIStore((s) => s.startMenuOpen);
  const pinnedAppIds = useAppCenterStore((s) => s.pinnedAppIds);
  const { t } = useTranslation("shell");

  const [time, setTime] = useState(new Date());
  const unpinApp = useAppCenterStore((s) => s.unpinApp);
  const setTrayPopover = useUIStore((s) => s.setTrayPopover);
  // Win+A lives in the shortcut registry (useKeyboardShortcuts).

  // Tray visibility depends on device state (caps/web battery) — the store
  // is the only subscription source, visibleWhen receives the snapshot.
  const deviceState = useDeviceStore();
  const visibleTrayItems = useMemo(
    () =>
      TRAY_ITEMS.filter((i) => !i.visibleWhen || i.visibleWhen(deviceState)).sort(
        (a, b) => a.order - b.order,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceState.caps, deviceState.battery, deviceState.bridgeAvailable],
  );

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 10000);
    setTime(new Date());
    return () => clearInterval(timer);
  }, []);

  // Pinned apps – ALWAYS shown, highlighted if open
  const openAppIds = useMemo(() => new Set(Object.values(windows).map((w) => w.appId)), [windows]);
  const pinnedApps = useMemo(
    () => pinnedAppIds.map((id) => useAppRegistryStore.getState().getApp(id)).filter(Boolean) as AppManifest[],
    [pinnedAppIds],
  );

  const activeWs = useWorkspaceStore((s) => s.activeId);

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

  const handlePinnedClick = useCallback(
    (appId: string) => {
      const app = useAppRegistryStore.getState().getApp(appId);
      if (!app) return;
      // Check if already open
      const existing = Object.values(windows).find((w) => w.appId === appId);
      if (existing) {
        focusWindow(existing.id);
      } else {
        openWindow(appId, { title: app.name, width: app.window.defaultWidth, height: app.window.defaultHeight, maximized: app.window.startMaximized, fullscreen: app.window.startFullscreen });
      }
    },
    [windows, openWindow, focusWindow],
  );

  const toggleShowDesktop = useWindowsStore((s) => s.toggleShowDesktop);
  const setPeek = useWindowsStore((s) => s.setPeek);
  const peekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show-Desktop click: toggle minimize-all / restore-set
  const handleShowDesktopClick = useCallback(() => {
    toggleShowDesktop();
  }, [toggleShowDesktop]);

  // Aero-Peek: hover for >500ms fades all windows; mouseleave restores
  const handleShowDesktopEnter = useCallback(() => {
    if (peekTimerRef.current) clearTimeout(peekTimerRef.current);
    peekTimerRef.current = setTimeout(() => setPeek(true), 500);
  }, [setPeek]);

  const handleShowDesktopLeave = useCallback(() => {
    if (peekTimerRef.current) clearTimeout(peekTimerRef.current);
    setPeek(false);
  }, [setPeek]);

  useEffect(() => () => {
    if (peekTimerRef.current) clearTimeout(peekTimerRef.current);
  }, []);

  // Fullscreen: while a window is in real fullscreen, the taskbar steps aside —
  // otherwise it slides over the picture (it has its own stacking context, a
  // higher z-index on the window is not enough). Back with Win+Down.
  const anyFullscreen = Object.values(windows).some((w) => w.fullscreen && !w.minimized);
  if (anyFullscreen) return null;

  return (
    <>
      {/* data-shell-part: stable hook for skin stylesheets — production CSS-module
          class names are hashed (e.g. _taskbar_x5vpr_1), so [class*=…] matching
          on file names does not survive the build. */}
      <div className={styles.taskbar} data-shell-part="taskbar">
        {/* === Left: Clara + Mic + Workspace === */}
        <div className={styles.left}>
          {/* Clara C Button */}
          <button
            className={`${styles.claraBtn} ${startMenuOpen ? styles.claraActive : ""}`}
            onClick={() => toggleStartMenu()}
            title={t("taskbar.clara")}
            data-tour="taskbar-clara"
          >
            <ClaraMark className={styles.claraMark} />
          </button>

          {/* Microphone */}
          <button
            className={`${styles.iconBtn} ${useVoiceStore.getState().recording ? styles.micRecording : ""}`}
            title={t("taskbar.voice")}
            data-tour="taskbar-voice"
            onClick={() => {
              const vs = useVoiceStore.getState();
              if (vs.active) { vs.clearTranscript(); }
              else { vs.startListening(); }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={useVoiceStore.getState().recording ? "#ff3b30" : "currentColor"} strokeWidth="1.5">
              <rect x="5" y="1" width="6" height="9" rx="3" />
              <path d="M3 7a5 5 0 0 0 10 0" />
              <line x1="8" y1="12" x2="8" y2="15" />
              <line x1="5" y1="15" x2="11" y2="15" />
            </svg>
          </button>

          {/* Workspace Switcher */}
          <WorkspaceSwitcher />
        </div>

        {/* === Pinned Favorites === */}
        <div className={styles.pinned} data-tour="taskbar-pinned">
          {pinnedApps.map((app) => {
            const isOpen = openAppIds.has(app.id);
            const pinItems: ContextMenuItem[] = [
              {
                id: "open",
                label: isOpen ? t("taskbar.pinned.focus", { app: app.name }) : t("taskbar.pinned.open", { app: app.name }),
                onSelect: () => handlePinnedClick(app.id),
              },
              {
                id: "new-instance",
                label: t("taskbar.pinned.newInstance"),
                onSelect: () => openWindow(app.id, {
                  title: app.name,
                  width: app.window.defaultWidth,
                  height: app.window.defaultHeight,
                  maximized: app.window.startMaximized,
                  fullscreen: app.window.startFullscreen,
                }),
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
            ];
            return (
              <WindowContextMenu key={app.id} items={pinItems}>
                <button
                  className={`${styles.pinnedBtn} ${isOpen ? styles.pinnedActive : ""}`}
                  onClick={() => handlePinnedClick(app.id)}
                  title={app.name}
                >
                  <AppIcon
                    appId={app.id}
                    fallback={app.icon}
                    iconUrl={app.config?.iconUrl}
                    size="pinned"
                    className={styles.pinnedIcon}
                    title={app.name}
                  />
                  {isOpen && <span className={styles.dotActive} />}
                </button>
              </WindowContextMenu>
            );
          })}
        </div>

        {/* === Separator === */}
        <div className={styles.separator} />

        {/* === Running Apps/Wrapps === */}
        <div className={styles.running}>
          {runningWindows.map((win) => (
            <ContextMenu.Root key={win.id}>
              <ContextMenu.Trigger asChild>
                <TaskbarHoverThumb windowId={win.id}>
                  <button
                    className={`${styles.appBtn} ${
                      win.id === focusedWindowId && !win.minimized ? styles.appActive : ""
                    } ${win.minimized ? styles.appMinimized : ""}`}
                    onClick={() => handleWindowClick(win.id)}
                    title={win.title}
                  >
                    <AppIcon
                      appId={win.appId}
                      fallback={useAppRegistryStore.getState().getApp(win.appId)?.icon || "🔲"}
                      size="taskbar"
                      className={styles.appIcon}
                      title={win.title}
                    />
                    <span className={styles.dotActive} />
                  </button>
                </TaskbarHoverThumb>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className={styles.ctxMenu}>
                  <ContextMenu.Item className={styles.ctxItem} onSelect={() => closeWindow(win.id)}>
                    {t("taskbar.window.close")}
                  </ContextMenu.Item>
                  <ContextMenu.Item className={styles.ctxItem} onSelect={() => minimizeWindow(win.id)}>
                    {t("taskbar.window.minimize")}
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}
        </div>

        {/* === Spacer === */}
        <div className={styles.spacer} />

        {/* === Right: System Tray (registry) ===
            Clock + show-desktop stay hard-coded: their own look or
            hover-peek special behavior. data-shell-part="taskbar-tray" =
            stable skin hook for this area. */}
        <div className={styles.right} data-shell-part="taskbar-tray" data-tour="taskbar-tray">
          {visibleTrayItems.map((item) => (
            <TrayButton key={item.id} item={item} />
          ))}

          <div className={styles.tray} onClick={() => setTrayPopover("calendar")} data-ctx="tray-clock">
            <span className={styles.clock}>
              {time.toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className={styles.date}>
              {time.toLocaleDateString(regionLocale(), { day: "2-digit", month: "2-digit", year: "numeric" })}
            </span>
          </div>

          <button
            className={styles.showDesktop}
            onClick={handleShowDesktopClick}
            onMouseEnter={handleShowDesktopEnter}
            onMouseLeave={handleShowDesktopLeave}
            title={t("taskbar.showDesktop")}
          />
        </div>
      </div>

      <TrayPopoverHost />
    </>
  );
}
