import { useCallback, useMemo, useRef } from "react";
import { Rnd } from "react-rnd";
import { motion, AnimatePresence } from "motion/react";
import type { DraggableEventHandler } from "react-draggable";
import type { RndResizeCallback } from "react-rnd";
import { useWindowsStore, useCredentialsStore, useWorkspaceStore, useWrappStore, requestCloseWindow } from "@claraos/core";
import type { WindowInstance } from "@claraos/core";
import { RND_DEFAULTS, RESIZING_ENABLED, RESIZING_DISABLED, TASKBAR_HEIGHT } from "@claraos/core/wm/rndDefaults";
import { clampPosition } from "@claraos/core/wm/functions";
import { useSnapToEdge } from "@claraos/core/wm/useSnapToEdge";
import { useViewportSize } from "@claraos/core/wm/useViewportSize";
import { setIframeCapture } from "@claraos/core/wm/iframeCapture";
import { computeMagneticSnap } from "@claraos/core/wm/magneticSnap";
import { WindowContextMenu, type ContextMenuItem } from "../components/WindowContextMenu";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import { SnapLayoutPicker } from "./SnapLayoutPicker";
import { ClaraChatPanel, SparklesIcon } from "../Chat";
import { parseObjectUri, useIframeAppStore } from "@claraos/core";
import styles from "./Window.module.css";
import type { AppAccount } from "@claraos/core";

const heimConfig = import.meta.glob<{ NATIVE_CLARA_APPS?: string[] }>("../heim.config.ts", { eager: true });

/** Native React apps with object-context that always offer the Clara-toggle. */
const NATIVE_CLARA_APPS = new Set([
  // The Clara Browser gets the same Clara button in the title bar as every
  // other app — instead of its own button inside the streamed picture (which
  // appeared twice and looked foreign).
  "selkies-browser",
  "files",
  "file-browser",
  "text-editor",
  "pdf-viewer",
  "office-viewer",
  "model-viewer",
  "image-viewer",
  "video-player",
  "terminal",
  "wrapp-container",
  // Site-specific apps (optional heim.config.ts)
  ...(Object.values(heimConfig)[0]?.NATIVE_CLARA_APPS ?? []),
]);

const EMPTY_ACCOUNTS: AppAccount[] = [];

interface WindowProps {
  window: WindowInstance;
  zIndex: number;
  isFocused: boolean;
  children?: React.ReactNode;
}

export function Window({ window: win, zIndex, isFocused, children }: WindowProps) {
  const focusWindow = useWindowsStore((s) => s.focusWindow);
  const minimizeWindow = useWindowsStore((s) => s.minimizeWindow);
  const toggleMaximize = useWindowsStore((s) => s.toggleMaximize);
  const maximizeWindow = useWindowsStore((s) => s.maximizeWindow);
  const restoreWindow = useWindowsStore((s) => s.restoreWindow);
  const updatePosition = useWindowsStore((s) => s.updatePosition);
  const updatePositionAndSize = useWindowsStore((s) => s.updatePositionAndSize);
  const setAlwaysOnTop = useWindowsStore((s) => s.setAlwaysOnTop);
  const toggleClaraInline = useWindowsStore((s) => s.toggleClaraInline);
  const peekActive = useWindowsStore((s) => s.peekActive);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  // Iframe apps that registered the Clara bridge become Clara-eligible too.
  const iframeBridge = useIframeAppStore((s) => s.apps[win.id]);
  const inlineClaraSupported = NATIVE_CLARA_APPS.has(win.appId)
    || !!useWrappStore.getState().getManifest(win.appId)   // wrapp apps (registered manifests)
    || (!!iframeBridge && iframeBridge.ready);
  const inlineClaraOpen = inlineClaraSupported && !!win.claraInlineOpen;
  const parsedObject = win.currentObjectUri ? parseObjectUri(win.currentObjectUri) : null;

  const rndRef = useRef<Rnd | null>(null);
  const { preview, onDrag, getSnapResult, clearPreview } = useSnapToEdge();

  const position = useMemo(() => ({ x: win.x, y: win.y }), [win.x, win.y]);
  const size = useMemo(
    () => ({ width: win.width, height: win.height }),
    [win.width, win.height],
  );

  const enableResizing = useMemo(
    () => (win.maximized || win.fullscreen ? RESIZING_DISABLED : RESIZING_ENABLED),
    [win.maximized, win.fullscreen],
  );

  // Screen size as a subscription — see the reasoning at `rndSize`.
  const viewport = useViewportSize();

  // --- Drag Handlers ---
  const handleDragStart = useCallback(() => {
    setIframeCapture(false);
    focusWindow(win.id);
  }, [focusWindow, win.id]);

  const handleDrag: DraggableEventHandler = useCallback(
    (_e, data) => {
      onDrag(_e, data as { x: number; y: number; node: HTMLElement });
    },
    [onDrag],
  );

  const handleDragStop: DraggableEventHandler = useCallback(
    (_e, data) => {
      setIframeCapture(true);
      clearPreview();

      const rect = data.node.getBoundingClientRect();
      const snap = getSnapResult(rect.left, rect.top);

      if (snap) {
        if (snap.zone === "maximize") {
          maximizeWindow(win.id);
        } else {
          updatePositionAndSize(win.id, snap.x, snap.y, snap.width, snap.height);
        }
        // Edge-snap took priority — no magnetic snap to apply
        return;
      }

      // No edge snap: try magnetic alignment to neighbouring windows.
      const all = useWindowsStore.getState().windows;
      const others = Object.values(all)
        .filter((w) => w.id !== win.id && !w.minimized && !w.maximized)
        .map((w) => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }));
      const mag = computeMagneticSnap(
        { x: data.x, y: data.y, width: win.width, height: win.height },
        others,
      );
      const clamped = clampPosition(mag.x, mag.y, win.width, win.height);
      updatePosition(win.id, clamped.x, clamped.y);
    },
    [getSnapResult, clearPreview, updatePosition, updatePositionAndSize, maximizeWindow, win.id, win.width, win.height],
  );

  // --- Resize Handlers ---
  const handleResizeStart = useCallback(() => {
    setIframeCapture(false);
    focusWindow(win.id);
  }, [focusWindow, win.id]);

  const handleResizeStop: RndResizeCallback = useCallback(
    (_e, _dir, elementRef, _delta, newPosition) => {
      setIframeCapture(true);
      const newWidth = parseInt(elementRef.style.width, 10);
      const newHeight = parseInt(elementRef.style.height, 10);
      updatePositionAndSize(win.id, newPosition.x, newPosition.y, newWidth, newHeight);
    },
    [updatePositionAndSize, win.id],
  );

  // --- Titlebar actions ---
  const handleMinimize = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); minimizeWindow(win.id); },
    [minimizeWindow, win.id],
  );

  const handleToggleMaximize = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); toggleMaximize(win.id); },
    [toggleMaximize, win.id],
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); void requestCloseWindow(win.id); },
    [win.id],
  );

  const handleTitlebarDoubleClick = useCallback(
    () => toggleMaximize(win.id),
    [toggleMaximize, win.id],
  );

  const handleMouseDown = useCallback(
    () => { if (!isFocused) focusWindow(win.id); },
    [focusWindow, isFocused, win.id],
  );

  // --- Single render path: Rnd always present, maximize via position/size override ---
  // This preserves the React tree (and iframe state) when toggling maximize.
  // Fullscreen takes precedence over maximized: NO taskbar offset and no
  // title bar — for streamed desktops that should fill the screen.
  const rndPosition = win.fullscreen || win.maximized ? { x: 0, y: 0 } : position;
  // Warning: read this as a subscription, not in the render body. Without
  //    `useViewportSize` this size stayed fixed when a phone was rotated —
  //    the window kept its old pixel size and no longer filled the screen.
  //    It looked like "left fullscreen", but was a frozen number. Whoever
  //    reads a size in the render body reads it exactly once.
  const rndSize = win.fullscreen
    ? { width: viewport.width, height: viewport.height }
    : win.maximized
    ? { width: viewport.width, height: viewport.height - TASKBAR_HEIGHT }
    : size;

  // Always-on-Top windows render above everything else, including newly-
  // focused ordinary windows. Aero-Peek dims windows to 10% opacity so the
  // user can see the desktop momentarily without losing the layout.
  // Fullscreen sits above the taskbar (which has z-index 1000 in the shell).
  const effectiveZ = win.fullscreen ? zIndex + 20000 : win.alwaysOnTop ? zIndex + 10000 : zIndex;
  const peekOpacity = peekActive && !win.alwaysOnTop ? 0.08 : 1;

  // Titlebar context-menu items
  const ctxItems: ContextMenuItem[] = [
    {
      id: "restore",
      label: "Wiederherstellen",
      onSelect: () => restoreWindow(win.id),
      disabled: !win.maximized,
    },
    {
      id: "minimize",
      label: "Minimieren",
      onSelect: () => minimizeWindow(win.id),
    },
    {
      id: "maximize",
      label: win.maximized ? "Verkleinern" : "Maximieren",
      onSelect: () => toggleMaximize(win.id),
    },
    { id: "sep1", label: "---" },
    {
      id: "always-on-top",
      label: win.alwaysOnTop ? "✓ Immer im Vordergrund" : "Immer im Vordergrund",
      onSelect: () => setAlwaysOnTop(win.id, !win.alwaysOnTop),
    },
    {
      id: "send-to-workspace",
      label: "Auf Workspace verschieben…",
      submenu: workspaces.map((w) => ({
        id: `ws-${w.id}`,
        label: `${w.icon} ${w.name}${w.id === win.workspaceId ? " (aktuell)" : ""}`,
        onSelect: () => {
          // Move window to selected workspace by setting workspaceId via store
          useWindowsStore.setState((s) => ({
            windows: {
              ...s.windows,
              [win.id]: { ...s.windows[win.id]!, workspaceId: w.id },
            },
          }));
        },
        disabled: w.id === win.workspaceId,
      })),
      disabled: workspaces.length < 2,
    },
    { id: "sep2", label: "---" },
    {
      id: "close",
      label: "Schließen",
      shortcut: "Strg+W",
      variant: "destructive",
      onSelect: () => { void requestCloseWindow(win.id); },
    },
  ];

  return (
    <>
      <Rnd
        ref={rndRef}
        position={rndPosition}
        size={rndSize}
        enableResizing={enableResizing}
        disableDragging={win.maximized || win.fullscreen}
        onDragStart={handleDragStart}
        onDrag={handleDrag}
        onDragStop={handleDragStop}
        onResizeStart={handleResizeStart}
        onResizeStop={handleResizeStop}
        style={{
          zIndex: effectiveZ,
          display: win.minimized ? "none" : undefined,
          opacity: peekOpacity,
          transition: "width 0.2s ease, height 0.2s ease, opacity 0.2s ease",
        }}
        {...RND_DEFAULTS}
      >
        <motion.div
          className={`${styles.window} ${isFocused ? styles.focused : ""} ${win.maximized ? styles.maximized : ""}`}
          data-window-id={win.id}
          onMouseDown={handleMouseDown}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          style={{ width: "100%", height: "100%", position: "relative", zIndex: 1 }}
        >
          {!win.fullscreen && (
          <Titlebar
            title={win.title}
            appId={win.appId}
            isMaximized={win.maximized}
            ctxItems={ctxItems}
            onMinimize={handleMinimize}
            onToggleMaximize={handleToggleMaximize}
            onClose={handleClose}
            onDoubleClick={handleTitlebarDoubleClick}
            inlineClaraSupported={inlineClaraSupported}
            inlineClaraOpen={inlineClaraOpen}
            onToggleClara={() => toggleClaraInline(win.id)}
            onSnapZone={(zone) => {
              const w = window.innerWidth;
              const h = window.innerHeight - TASKBAR_HEIGHT;
              const halfW = Math.floor(w / 2);
              const halfH = Math.floor(h / 2);
              const map: Record<string, { x: number; y: number; width: number; height: number }> = {
                "left":         { x: 0,     y: 0, width: halfW, height: h },
                "right":        { x: halfW, y: 0, width: w - halfW, height: h },
                "top-left":     { x: 0,     y: 0, width: halfW, height: halfH },
                "top-right":    { x: halfW, y: 0, width: w - halfW, height: halfH },
                "bottom-left":  { x: 0,     y: halfH, width: halfW, height: h - halfH },
                "bottom-right": { x: halfW, y: halfH, width: w - halfW, height: h - halfH },
                "maximize":     { x: 0,     y: 0, width: w, height: h },
              };
              const b = map[zone];
              if (b) {
                if (win.maximized) restoreWindow(win.id);
                updatePositionAndSize(win.id, b.x, b.y, b.width, b.height);
              }
            }}
          />
          )}
          {/* Stable structure — `appPane` always wraps `children` so the
              app component (e.g. WrappContainer) doesn't unmount/remount
              when Clara is toggled. The outer div just swaps its CSS class
              and conditionally adds a sibling pane. */}
          <div className={`${inlineClaraOpen ? styles.contentWithClara : styles.content} window-content-selectable`}>
            <div className={styles.appPane}>
              <AppErrorBoundary appName={win.title}>{children}</AppErrorBoundary>
            </div>
            {inlineClaraOpen && (
              <div className={styles.claraPane}>
                <ClaraChatPanel
                  variant="inline"
                  appId={parsedObject?.appId ?? win.appId}
                  objectKey={parsedObject?.objectKey}
                  windowId={win.id}
                  onClose={() => toggleClaraInline(win.id)}
                />
              </div>
            )}
          </div>
        </motion.div>
      </Rnd>

      <AnimatePresence>
        {preview && (
          <motion.div
            className={styles.snapPreview}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            style={{
              left: preview.x,
              top: preview.y,
              width: preview.width,
              height: preview.height,
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// --- Titlebar Sub-Component ---
function Titlebar({
  title,
  appId,
  isMaximized,
  ctxItems,
  onMinimize,
  onToggleMaximize,
  onClose,
  onDoubleClick,
  onSnapZone,
  inlineClaraSupported,
  inlineClaraOpen,
  onToggleClara,
  buttonsLeft = false,
}: {
  title: string;
  appId: string;
  isMaximized: boolean;
  ctxItems: ContextMenuItem[];
  onMinimize: (e: React.MouseEvent) => void;
  onToggleMaximize: (e: React.MouseEvent) => void;
  onClose: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onSnapZone: (zone: string) => void;
  inlineClaraSupported?: boolean;
  inlineClaraOpen?: boolean;
  onToggleClara?: () => void;
  buttonsLeft?: boolean;
}) {
  const accountsRaw = useCredentialsStore((s) => s.accounts[appId]);
  const accounts = accountsRaw || EMPTY_ACCOUNTS;
  const activateAccount = useCredentialsStore((s) => s.activateAccount);
  const hasMultipleAccounts = accounts.length > 1;
  const activeAccount = accounts.find((a) => a.isActive);
  const controls = (
    <div className={`${styles.controls} cancel`} style={buttonsLeft ? { flexDirection: "row-reverse" } : undefined}>
      {buttonsLeft ? (
        <>
          <button onClick={onClose} className={`${styles.controlBtn} ${styles.closeBtnMac}`} title="Close">●</button>
          <button onClick={onMinimize} className={`${styles.controlBtn} ${styles.minBtnMac}`} title="Minimize">●</button>
          <button onClick={onToggleMaximize} className={`${styles.controlBtn} ${styles.maxBtnMac}`} title={isMaximized ? "Restore" : "Maximize"}>●</button>
        </>
      ) : (
        <>
          <button onClick={onMinimize} className={styles.controlBtn} title="Minimieren" aria-label="Minimieren">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5h10" /></svg>
          </button>
          <SnapLayoutPicker onPick={onSnapZone}>
            <button onClick={onToggleMaximize} className={styles.controlBtn} title={isMaximized ? "Wiederherstellen" : "Maximieren"} aria-label={isMaximized ? "Wiederherstellen" : "Maximieren"}>
              {isMaximized
                ? <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="5" width="8" height="8" rx="1.5" /><path d="M6 5V4a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 13 4v4a1.5 1.5 0 0 1-1.5 1.5H11" /></svg>
                : <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg>}
            </button>
          </SnapLayoutPicker>
          <button onClick={onClose} className={`${styles.controlBtn} ${styles.closeBtn}`} title="Schließen" aria-label="Schließen">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </>
      )}
    </div>
  );

  return (
    <WindowContextMenu items={ctxItems}>
      <div
        className={`${styles.titlebar} window-drag-handle`}
        onDoubleClick={onDoubleClick}
        style={buttonsLeft ? { flexDirection: "row-reverse" } : undefined}
      >
      <span className={styles.title}>{title}</span>
      {inlineClaraSupported && onToggleClara && (
        <button
          type="button"
          className={`cancel ${styles.claraToggle} ${inlineClaraOpen ? styles.claraToggleActive : ""}`}
          onClick={(e) => { e.stopPropagation(); onToggleClara(); }}
          title={inlineClaraOpen ? "Clara schließen" : "Mit Clara reden über das aktuelle Objekt"}
          aria-pressed={inlineClaraOpen}
        >
          <span className={styles.claraToggleIcon}>
            <SparklesIcon size={13} />
          </span>
          <span className={styles.claraToggleLabel}>Clara</span>
        </button>
      )}
      {hasMultipleAccounts && (
        <select
          className="cancel"
          value={activeAccount?.accountName || ""}
          onChange={(e) => { e.stopPropagation(); activateAccount(appId, e.target.value); }}
          onClick={(e) => e.stopPropagation()}
          style={{
            fontSize: "11px", padding: "1px 4px", border: "1px solid var(--border)",
            borderRadius: "3px", background: "var(--bg-subtle)", color: "var(--text-primary)",
            cursor: "pointer", maxWidth: "120px", marginLeft: "4px",
          }}
          title="Switch account"
        >
          {accounts.map((a) => (
            <option key={a.accountName} value={a.accountName}>{a.accountName}</option>
          ))}
        </select>
      )}
        {controls}
      </div>
    </WindowContextMenu>
  );
}
