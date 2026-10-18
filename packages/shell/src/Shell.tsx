import { useCallback, useEffect, useState } from "react";
import { useWindowsStore, useUIStore, useWorkspaceStore, useDragStore, useAppRegistryStore, useDeviceStore } from "@claraos/core";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { usePageVolume } from "./usePageVolume";
import { useStateSync } from "./useStateSync";
import { useNtfySubscription } from "./useNtfySubscription";
import { useMeldungen } from "./useMeldungen";
import { openClaraChat, useBootDeepLink } from "./useBootDeepLink";
import { useSkinLayout } from "./useSkinLayout";
import { Taskbar } from "./Taskbar/Taskbar";
import { Desktop } from "./Desktop/Desktop";
import { WindowsView } from "./Window/WindowsView";
import { AltTabSwitcher } from "./Window/AltTabSwitcher";
import { StartMenu } from "./StartMenu/StartMenu";
import { ToastContainer } from "./Notifications/ToastContainer";
import { COMPANION_NOTIFICATION_CLICK_EVENT, oeffneShellZiel } from "./Notifications/notificationActions";
import { SearchOverlay } from "./Search/SearchOverlay";
import { VoiceBubble } from "./Voice/VoiceBubble";
import { ScreenshotOverlay } from "./Screenshot/ScreenshotOverlay";
import { OpenExternalDialog } from "./Browser/OpenExternalDialog";
import { ClipboardOverlay } from "./Clipboard/ClipboardOverlay";
import MarkerOverlayModal from "./Marker/MarkerOverlayModal";
import { GlobalContextMenu } from "./components/GlobalContextMenu";
import { TourProvider } from "./Tour/TourProvider";
import { NudgeHost } from "./Tour/NudgeHost";
import { useActionBus, installAppActionHandlers } from "./Chat";
import styles from "./Shell.module.css";
import { KnopfUmgebung } from "./components/Button";
import { usePraesenzHerzschlag } from "./usePraesenz";

// Register per-app action handlers once at module load (wrapp/files mutations).
installAppActionHandlers();

export function Shell() {
  // Connect to backend action-bus once for the shell session (`form`: see MobileShell).
  useActionBus({ url: "/api/claraos/actions/ws?form=desktop" });
  const openWindow = useWindowsStore((s) => s.openWindow);
  const closeStartMenu = useUIStore((s) => s.closeStartMenu);
  const layout = useSkinLayout();
  const [searchOpen, setSearchOpen] = useState(false);

  useKeyboardShortcuts();
  useStateSync();
  useNtfySubscription();
  useMeldungen();
  // Device state (Companion bridge/web facts) + page volume
  useEffect(() => { useDeviceStore.getState().init(); }, []);

  // Report presence while ClaraOS is visibly open.
  usePraesenzHerzschlag();
  usePageVolume();
  // ?app=<id> from ntfy click URLs (routines, game invitations) -> open the app;
  // ?chat=1 -> start menu directly in Clara chat mode (StartMenu.tsx listens)
  useBootDeepLink((appId) => {
    const app = useAppRegistryStore.getState().getApp(appId);
    useWindowsStore.getState().openWindow(appId, app
      ? { title: app.name, width: app.window.defaultWidth, height: app.window.defaultHeight, maximized: app.window.startMaximized, fullscreen: app.window.startFullscreen }
      : undefined);
  }, (chatId) => openClaraChat(chatId));

  // Click on a system notification of the Companion app ->
  // same app/action as "Open" in the ClaraOS notification.
  useEffect(() => {
    const onKlick = (e: Event) => {
      const url = (e as CustomEvent<{ url?: unknown }>).detail?.url;
      if (typeof url === "string") oeffneShellZiel(url);
    };
    window.addEventListener(COMPANION_NOTIFICATION_CLICK_EVENT, onKlick);
    return () => window.removeEventListener(COMPANION_NOTIFICATION_CLICK_EVENT, onKlick);
  }, []);

  // Monkey-patch openWindow to always include active workspaceId
  useEffect(() => {
    const original = useWindowsStore.getState().openWindow.bind(useWindowsStore.getState());
    const patched = (appId: string, opts?: Record<string, unknown>) => {
      const wsId = useWorkspaceStore.getState().activeId;
      return original(appId, { ...opts, workspaceId: wsId } as never);
    };
    // Replace in store
    useWindowsStore.setState({ openWindow: patched as never });
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const { appId, title } = (e as CustomEvent).detail;
      closeStartMenu();
      openWindow(appId, { title, width: 680, height: 520 });
    };
    window.addEventListener("claraos-open-app", handler);
    return () => window.removeEventListener("claraos-open-app", handler);
  }, [openWindow, closeStartMenu]);

  // Win+Q hotkey from useKeyboardShortcuts dispatches this event
  useEffect(() => {
    const handler = () => setSearchOpen((p) => !p);
    window.addEventListener("claraos-toggle-search", handler);
    return () => window.removeEventListener("claraos-toggle-search", handler);
  }, []);

  const isTopTaskbar = layout.taskbarPosition === "top";

  // Global drag&drop dispatcher. Surfaces register their
  // drop intent via `useDragStore`; the Shell-level drag-end clears any
  // dangling state if the user drops outside any registered zone.
  const handleDragEnd = useCallback(() => {
    useDragStore.getState().endDrag();
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Allow drops everywhere by default — child zones may stopPropagation
    // when they want exclusive handling.
    if (useDragStore.getState().current) {
      e.preventDefault();
    }
  }, []);

  return (
    <KnopfUmgebung.Provider value="desktop">
    <div
      className={styles.shell}
      style={{ flexDirection: isTopTaskbar ? "column-reverse" : "column" }}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDrop={handleDragEnd}
    >
      <div className={styles.desktopArea}>
        <Desktop />
        <WindowsView />
      </div>
      <StartMenu />
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
      <VoiceBubble />
      <AltTabSwitcher />
      <ScreenshotOverlay />
      <ClipboardOverlay />
      <MarkerOverlayModal />
      <ToastContainer />
      <TourProvider />
      <NudgeHost />
      <OpenExternalDialog />
      <GlobalContextMenu />
      <Taskbar layout={layout} onSearchClick={() => setSearchOpen(true)} />
    </div>
    </KnopfUmgebung.Provider>
  );
}
