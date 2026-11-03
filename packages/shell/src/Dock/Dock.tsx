import { useCallback, useRef } from "react";
import { useAppRegistryStore } from "@claraos/core";
import { AppIcon } from "../components/AppIcon";
import { WindowContextMenu } from "../components/WindowContextMenu";
import { TaskbarHoverThumb } from "../Taskbar/TaskbarHoverThumb";
import { useTaskbarApps } from "../Taskbar/useTaskbarApps";
import { magnification } from "./magnify";
import styles from "./Dock.module.css";

/**
 * The floating app strip at the bottom of a two-bar skin (Orchard): pinned
 * apps, a separator, running windows that are not pinned. A dot marks what
 * runs; icons grow under the pointer (transform only — no layout reflow).
 * Click/context behaviour is the Taskbar's (useTaskbarApps).
 */
export function Dock() {
  const {
    windows, focusedWindowId, openAppIds, pinnedApps, runningWindows,
    handleWindowClick, handlePinnedClick, pinContextItems, windowContextItems,
  } = useTaskbarApps();

  // Magnification is written straight to the DOM: a mousemove per frame must
  // not re-render the whole strip.
  const itemsRef = useRef<Map<string, HTMLElement>>(new Map());
  const setItemRef = useCallback((key: string) => (el: HTMLElement | null) => {
    if (el) itemsRef.current.set(key, el);
    else itemsRef.current.delete(key);
  }, []);

  const handleMove = useCallback((e: React.MouseEvent) => {
    for (const el of itemsRef.current.values()) {
      const r = el.getBoundingClientRect();
      const centre = r.left + r.width / 2;
      el.style.setProperty("--mag", magnification(e.clientX - centre).toFixed(3));
    }
  }, []);

  const handleLeave = useCallback(() => {
    for (const el of itemsRef.current.values()) el.style.removeProperty("--mag");
  }, []);

  // Fullscreen: the dock steps aside like the taskbar does.
  const anyFullscreen = Object.values(windows).some((w) => w.fullscreen && !w.minimized);
  if (anyFullscreen) return null;

  return (
    <div className={styles.area} data-shell-part="dock-area">
      <div
        className={styles.dock}
        data-shell-part="dock"
        data-tour="taskbar-pinned"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        {pinnedApps.map((app) => {
          const isOpen = openAppIds.has(app.id);
          return (
            <WindowContextMenu key={app.id} items={pinContextItems(app, isOpen)}>
              <button
                ref={setItemRef(`pin:${app.id}`)}
                className={`${styles.item} ${isOpen ? styles.running : ""}`}
                onClick={() => handlePinnedClick(app.id)}
                title={app.name}
                data-dock-item={app.id}
              >
                <AppIcon
                  appId={app.id}
                  fallback={app.icon}
                  iconUrl={app.config?.iconUrl}
                  size="pinned"
                  pixelSize={30}
                  className={styles.icon}
                  title={app.name}
                />
                <span className={styles.label}>{app.name}</span>
              </button>
            </WindowContextMenu>
          );
        })}

        {runningWindows.length > 0 && <div className={styles.separator} />}

        {runningWindows.map((win) => (
          <WindowContextMenu key={win.id} items={windowContextItems(win)}>
            <TaskbarHoverThumb windowId={win.id}>
              <button
                ref={setItemRef(`win:${win.id}`)}
                className={`${styles.item} ${styles.running} ${
                  win.id === focusedWindowId && !win.minimized ? styles.focused : ""
                } ${win.minimized ? styles.minimized : ""}`}
                onClick={() => handleWindowClick(win.id)}
                title={win.title}
                data-dock-item={win.appId}
              >
                <AppIcon
                  appId={win.appId}
                  fallback={useAppRegistryStore.getState().getApp(win.appId)?.icon || "🔲"}
                  size="pinned"
                  pixelSize={30}
                  className={styles.icon}
                  title={win.title}
                />
                <span className={styles.label}>{win.title}</span>
              </button>
            </TaskbarHoverThumb>
          </WindowContextMenu>
        ))}
      </div>
    </div>
  );
}
