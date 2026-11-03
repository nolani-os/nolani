import { useCallback, useEffect, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useWindowsStore, useUIStore, useVoiceStore, useAppRegistryStore } from "@claraos/core";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { AppIcon } from "../components/AppIcon";
import { WindowContextMenu } from "../components/WindowContextMenu";
import { TaskbarHoverThumb } from "./TaskbarHoverThumb";
import { TrayPopoverHost } from "./tray/TrayPopoverHost";
import { TrayCluster } from "./TrayCluster";
import { useTaskbarApps } from "./useTaskbarApps";
import { useSkinBrand, type SkinLayout } from "../useSkinLayout";
import ClaraMark from "../Mobile/clara-c.svg?react";
import styles from "./Taskbar.module.css";
import { regionLocale, useTranslation } from "@claraos/core";

interface TaskbarProps {
  layout?: Pick<SkinLayout, "taskbarPosition" | "taskbarHeight"> & Partial<SkinLayout>;
  onSearchClick?: () => void;
}

/**
 * The one-bar surface (Glass, Bloom, Meadow, Shore): start button, pinned and
 * running apps, tray and clock in a single strip. The app logic lives in
 * useTaskbarApps and the tray buttons in TrayCluster, both shared with the
 * Orchard menu bar + dock pair — the behaviour here is unchanged by that split.
 */
export function Taskbar({ layout, onSearchClick }: TaskbarProps) {
  const windows = useWindowsStore((s) => s.windows);
  const toggleStartMenu = useUIStore((s) => s.toggleStartMenu);
  const startMenuOpen = useUIStore((s) => s.startMenuOpen);
  const { t } = useTranslation("shell");
  const brand = useSkinBrand();
  const {
    focusedWindowId, openAppIds, pinnedApps, runningWindows,
    handleWindowClick, handlePinnedClick, pinContextItems, closeWindow, minimizeWindow,
  } = useTaskbarApps();

  const [time, setTime] = useState(new Date());
  const setTrayPopover = useUIStore((s) => s.setTrayPopover);
  // Win+A lives in the shortcut registry (useKeyboardShortcuts).

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 10000);
    setTime(new Date());
    return () => clearInterval(timer);
  }, []);

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
          {/* Start button: the product mark — or, on a corporate skin, the
              company's logo and name (SkinManifest.brand) */}
          <button
            className={`${styles.claraBtn} ${brand ? styles.brandBtn : ""} ${startMenuOpen ? styles.claraActive : ""}`}
            onClick={() => toggleStartMenu()}
            title={brand ? (brand.tagline ? `${brand.name} — ${brand.tagline}` : brand.name) : t("taskbar.clara")}
            data-tour="taskbar-clara"
            data-shell-part="start-button"
          >
            {brand ? (
              <>
                <img src={brand.logo} alt="" className={styles.brandLogo} draggable={false} />
                <span className={styles.brandName}>{brand.name}</span>
              </>
            ) : (
              <ClaraMark className={styles.claraMark} />
            )}
          </button>

          {/* Search field (layout.searchField): a wide pill that opens the
              search overlay — the centred-bar skins show it, the others keep
              search on the keyboard shortcut */}
          {layout?.searchField && (
            <button
              className={styles.searchField}
              onClick={onSearchClick}
              title={t("taskbar.search")}
              data-shell-part="taskbar-search"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" />
                <line x1="10.5" y1="10.5" x2="14" y2="14" />
              </svg>
              <span className={styles.searchLabel}>{t("taskbar.search")}</span>
            </button>
          )}

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
            return (
              <WindowContextMenu key={app.id} items={pinContextItems(app, isOpen)}>
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
          <TrayCluster />

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
