import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useWindowsStore, useUIStore, useAppRegistryStore, useMobilePrefs, useDeviceStore, useTranslation, type AppManifest } from "@claraos/core";
import { usePageVolume } from "../usePageVolume";
import { appComponents, getAppManifest } from "../apps/registry";
import { IframeApp } from "../apps/IframeApp";
import { SelkiesApp } from "../apps/SelkiesApp";
import { resolveMobileStrategy } from "../apps/mobileStrategies";
import { useLongPress } from "./useLongPress";
import { appBarColors, barFg } from "./appBarColors";
import { useNtfySubscription } from "../useNtfySubscription";
import { useMeldungen } from "../useMeldungen";
import { OPEN_CLARA_CHAT_EVENT, useBootDeepLink } from "../useBootDeepLink";
import { NOTIF_NAVIGATED_EVENT } from "../Notifications/notificationActions";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import { IconContextMenu, type ContextAction } from "./IconContextMenu";
import { AppIcon } from "../components/AppIcon";
import { skinScenes } from "../skinScenes";
import { Icon } from "../components/Icon";
import ClaraC from "./clara-c.svg?react";
import { Shade } from "./Shade";
import { ClaraOverlay, claraThreadSetzen, claraThreadZuruecksetzen } from "./ClaraOverlay";
import { EckenGriff } from "./EckenGriff";
import { useActionBus, installAppActionHandlers } from "../Chat";

// Register the shell/app action handlers (open_window, navigate_to,
// set_mobile_view, …) once at module load — mobile needs these too.
installAppActionHandlers();
import {
  GRID_COLS, GRID_ROWS, DEFAULT_DOCK,
  loadHomeLayout, saveHomeLayout, withTrailingEmptyPage,
  placeOnGrid, addToDock, addToDockAt, removeFromHome, isOnHome,
  addWidget, moveWidgetDisplacing, removeWidget,
  type HomeLayout, type MobileWidget,
} from "./homeLayout";
import {
  widgetComponents, widgetManifests, widgetName, MOBILE_WIDGET_EMOJI, MOBILE_WIDGET_OPEN_APP,
} from "../widgets/registry";
import { WidgetPicker } from "./WidgetPicker";
import styles from "./MobileShell.module.css";
import { regionLocale } from "@claraos/core";

type MobileView = "home" | "drawer" | "app" | "recents" | "notifications" | "quicksettings";

const REMOVE_ZONE_H = 76;        // top strip = "remove" drop target while dragging
const EDGE_FLIP_MARGIN = 28;     // px from screen edge that flips home page
const EDGE_FLIP_COOLDOWN = 600;  // ms between auto page-flips while dragging

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type DragSource = "drawer" | "home" | "dock";
type DragState =
  | { kind: "icon"; appId: string; source: DragSource; x: number; y: number; originX: number; originY: number }
  | { kind: "widget"; widgetId: string; widgetType: string; w: number; h: number; x: number; y: number; originX: number; originY: number };
const TAP_SLOP = 14; // px; release within this radius = "didn't drag" → open menu
type DropTarget =
  | { type: "remove" }
  | { type: "dock"; slot: number }
  | { type: "cell"; page: number; cell: number }
  | { type: "widgetCell"; page: number; col: number; row: number; valid: boolean };

type MenuState =
  | { kind: "app"; appId: string; source: DragSource; x: number; y: number }
  | { kind: "widget"; widgetId: string; widgetType: string; x: number; y: number }
  | { kind: "home"; page: number; cell: number; x: number; y: number };

export function MobileShell() {
  const { t } = useTranslation("mobile");
  const windows = useWindowsStore((s) => s.windows);
  const windowOrder = useWindowsStore((s) => s.windowOrder);
  const openWindow = useWindowsStore((s) => s.openWindow);
  const closeWindow = useWindowsStore((s) => s.closeWindow);
  const focusWindow = useWindowsStore((s) => s.focusWindow);
  // Connect to the backend action-bus WS so Clara can drive the mobile UI
  // (open apps, navigate, cobrowse split-view). Without this, dispatches are
  // delivered:0 on mobile and nothing Clara does becomes visible.
  // `form` tells the API this is the phone: pages Clara opens go to the
  // mobile browser twin, the one this shell shows.
  useActionBus({ url: "/api/claraos/actions/ws?form=mobile" });
  const skinId = useUIStore((st) => st.skinId);
  // Animated scene of the active skin (if any) as the background.
  const SkinScene = skinScenes[skinId]?.Scene;
  // The mobile shell never loaded the server prefs (skin/theme) — `useStateSync` only runs in
  // the desktop shell. So the skin chosen on desktop never arrived on mobile. Adopt it here
  // read-only (no writing back; that stays with the desktop sync).
  useEffect(() => {
    let alive = true;
    fetch("/api/claraos/prefs").then((r) => (r.ok ? r.json() : null)).then((prefs) => {
      if (!alive || !prefs?.stored) return;
      const ui = useUIStore.getState();
      if (prefs.skin_id && prefs.skin_id !== ui.skinId) ui.setSkin(prefs.skin_id);
      if (prefs.theme && prefs.theme !== ui.theme) ui.setTheme(prefs.theme);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const notifications = useUIStore((s) => s.notifications);

  // ntfy SSE feed → useUIStore.notifications. Mounted only in the desktop
  // Shell before; on mobile it never ran, so the shade was always empty.
  useNtfySubscription();
  useMeldungen();
  // Device state + page volume — mobile previously had no media volume at
  // all; the store degrades cleanly without a bridge.
  useEffect(() => { useDeviceStore.getState().init(); }, []);
  usePageVolume();

  const apps = useAppRegistryStore((s) => s.apps);
  const appsLoaded = useAppRegistryStore((s) => s.loaded);
  useEffect(() => {
    if (!appsLoaded) useAppRegistryStore.getState().loadApps();
  }, [appsLoaded]);
  const activatedApps = useMemo(
    () => Object.values(apps).filter((a) => a.activated !== false),
    [apps],
  );

  const [view, setView] = useState<MobileView>("home");
  const [claraOpen, setClaraOpen] = useState(false);
  // Tapping the grip = text chat; swiping toward the center or long-pressing
  // home = voice. Previously EVERY path started in voice mode — without a
  // microphone a red bar was left standing.
  const [claraVoice, setClaraVoice] = useState(false);
  // Glow at the grip: closing no longer interrupts Clara. While an answer is
  // running, the sheet stays mounted invisibly (the stream lives in the
  // panel) and the grip pulses; when it is done, the grip shows a dot until
  // the chat is opened again.
  const [claraArbeitet, setClaraArbeitet] = useState(false);
  const [claraUngelesen, setClaraUngelesen] = useState(false);
  useEffect(() => { if (claraOpen) setClaraUngelesen(false); }, [claraOpen]);

  // Warning: every open starts fresh — the old conversation thread is
  // discarded. Previously a module singleton PLUS localStorage held on to it,
  // and "New chat" could not win against that (see comment in
  // ClaraOverlay.tsx); an old chat kept coming back on every open for days.
  //
  // Important: TWO exceptions, otherwise "fresh" would be data loss instead of help:
  //   * Clara is working right now — the stream belongs to the running conversation.
  //   * An answer arrived while the sheet was closed: the corner grip reports
  //     "done", and tapping it should show exactly that answer.
  //
  // All ways of opening go through THIS function. Previously each of the four
  // callers had its own `setClaraOpen(true)` — one of them would surely have
  // been forgotten in the next refactor.
  const claraZustandRef = useRef({ arbeitet: false, ungelesen: false });
  claraZustandRef.current = { arbeitet: claraArbeitet, ungelesen: claraUngelesen };
  const claraOeffnen = useCallback((opts?: { voice?: boolean; fortsetzen?: boolean }) => {
    const { arbeitet, ungelesen } = claraZustandRef.current;
    if (!opts?.fortsetzen && !arbeitet && !ungelesen) claraThreadZuruecksetzen();
    setClaraVoice(!!opts?.voice);
    setClaraOpen(true);
  }, []);
  // Open a specific chat (job notification, `?chat=<id>`), keeping it instead
  // of starting fresh.
  const claraChatOeffnen = useCallback((chatId: string) => {
    claraThreadSetzen(chatId);
    claraOeffnen({ fortsetzen: true });
  }, [claraOeffnen]);
  useEffect(() => {
    const oeffnen = (e: Event) => {
      const chatId = (e as CustomEvent<{ chatId?: unknown }>).detail?.chatId;
      if (typeof chatId === "string" && chatId) claraChatOeffnen(chatId);
      else claraOeffnen();
    };
    window.addEventListener(OPEN_CLARA_CHAT_EVENT, oeffnen);
    return () => window.removeEventListener(OPEN_CLARA_CHAT_EVENT, oeffnen);
  }, [claraOeffnen, claraChatOeffnen]);
  // Cobrowse split-view: Clara operates an app (top) while the user watches +
  // chats (bottom). Triggered from the action-bus via shell.set_mobile_view.
  const [cobrowseAppId, setCobrowseAppId] = useState<string | null>(null);
  const [layout, setLayout] = useState<HomeLayout>(loadHomeLayout);
  const [pageIdx, setPageIdx] = useState(0);
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(() => new Date());

  // Separate shade (like Android 16 / One UI 7): swipe from top LEFT
  // = notifications, top RIGHT = quick settings. The boundary is at 60 %
  // (some Android vendors split 70/30 — notifications are more frequent). In the
  // "combined" layout every spot opens the single shared panel.
  const shadeAufbau = useMobilePrefs((s) => s.shadeAufbau);
  const oeffneShade = useCallback((x: number) => {
    const rechts = x > window.innerWidth * 0.6;
    setView(shadeAufbau === "getrennt" && rechts ? "quicksettings" : "notifications");
  }, [shadeAufbau]);
  const shadeOffen = view === "notifications" || view === "quicksettings";

  // Always keep one trailing empty page available as a drop target.
  const pages = useMemo(() => withTrailingEmptyPage(layout).pages, [layout]);
  const clampedPage = Math.min(pageIdx, pages.length - 1);

  const commitLayout = useCallback((next: HomeLayout) => {
    setLayout(next);
    saveHomeLayout(next);
  }, []);

  // --- PWA install prompt ---
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches,
  );
  useEffect(() => {
    const onBeforeInstall = (e: Event) => { e.preventDefault(); setInstallEvent(e as BeforeInstallPromptEvent); };
    const onInstalled = () => { setIsInstalled(true); setInstallEvent(null); };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const handleInstall = useCallback(async () => {
    if (!installEvent) return;
    try { await installEvent.prompt(); setInstallEvent(null); } catch { /* ignore */ }
  }, [installEvent]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;
  const activeId = windowOrder[windowOrder.length - 1] || null;
  const activeWindow = activeId ? windows[activeId] : null;
  // Warning: the MOST RECENT window of this app, not the first one found.
  // `Object.values(windows).find(…)` returned the OLDEST — and thus, in split
  // screen, permanently the one opened first. Symptom: an edit
  // request on the open image put the result into a second image-viewer
  // window while the old image stayed on top. `windowOrder` is
  // sorted by last use; the last element is the one the user touched last.
  const cobrowseWindow = cobrowseAppId
    ? [...windowOrder].reverse().map((id) => windows[id]).find((w) => w?.appId === cobrowseAppId) ?? null
    : null;

  // Enter the cobrowse split-view when Clara calls shell.set_mobile_view.
  useEffect(() => {
    const onCobrowse = (e: Event) => {
      const appId = (e as CustomEvent).detail?.appId as string | undefined;
      if (!appId) return;
      // Apps with mobile strategy "redirect" can't embed — their split would
      // only show the "open in browser" landing page. Skip those.
      const app = useAppRegistryStore.getState().getApp(appId);
      if (app && resolveMobileStrategy(app).strategy === "redirect") return;
      const existing = Object.values(useWindowsStore.getState().windows).find((w) => w.appId === appId);
      if (!existing) {
        const app = useAppRegistryStore.getState().getApp(appId);
        // Warning: `maximized`/`fullscreen` MUST be passed along — otherwise the
        //    window does not carry the manifest default. While the mobile view fills
        //    the app itself this goes unnoticed; but if the user rotates to > 768 px,
        //    the DESKTOP shell renders the same window — without the fullscreen flag,
        //    i.e. with title bar and taskbar. It looked like "dropping out of fullscreen".
        openWindow(appId, app ? { title: app.name, width: app.window.defaultWidth, height: app.window.defaultHeight, maximized: app.window.startMaximized, fullscreen: app.window.startFullscreen } : undefined);
      }
      setCobrowseAppId(appId);
      // Explicitly continue: the split is the SAME conversation, just with an app.
      claraOeffnen({ fortsetzen: true });
    };
    window.addEventListener("claraos:mobile-cobrowse", onCobrowse);
    return () => window.removeEventListener("claraos:mobile-cobrowse", onCobrowse);
  }, [openWindow, claraOeffnen]);

  // --- App bar colours: while an app is open, the transparent ClaraOS bars
  // adopt the app's own header/content colours (appBarColors map) ---
  const activeBarApp = view === "app" && activeId ? windows[activeId]?.appId : null;
  const barCols = activeBarApp ? appBarColors(activeBarApp) : null;


  // --- Dynamic theme-color per view ---
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (!meta) return;
    // home: exact average of the wallpaper's top edge — the status bar (and on
    // newer Android the nav bar) blends into the wallpaper, looking transparent
    let color = "#0b1929";
    if (view === "drawer") color = "#0a0f1e";
    else if (shadeOffen) color = "#080d1a";
    else if (view === "app") color = barCols ? barCols.top : "#1a1f2e";
    meta.content = color;
  }, [view, barCols]);

  // The drawer does not show third-party services (hubService) — they live in the
  // services hub. During an active search they are mixed back in (otherwise typing a service name would find nothing).
  const sortedApps = useMemo(
    () => [...activatedApps].filter((a) => !a.hubService).sort((a, b) => a.name.localeCompare(b.name)),
    [activatedApps],
  );
  const filteredApps = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedApps;
    return [...activatedApps]
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((a) => a.name.toLowerCase().includes(q) || a.id.includes(q));
  }, [activatedApps, sortedApps, search]);

  const getApp = useCallback((id: string): AppManifest | undefined => apps[id], [apps]);

  const haptics = useMobilePrefs((s) => s.haptics);
  const vibrate = useCallback((ms = 8) => {
    if (!haptics) return;
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try { navigator.vibrate?.(ms); } catch { /* ignore */ }
    }
  }, [haptics]);

  // Warning: the font size is NO LONGER set here.
  // Previously this effect wrote `document.documentElement.style.fontSize`
  // — the same property the `AppearanceManager` sets from the account value
  // `appearance.uiScale`. Two writers on one property: on reload the
  // AppearanceManager ran last and reset it to "" with uiScale=100, and the
  // mobile setting was gone. In addition, the cleanup reset the size on
  // unmount.
  // => The only owner is now the AppearanceManager; the slider in quick
  // settings writes the same account value.

  const resetDock = useCallback(() => {
    setLayout((prev) => {
      const next = { ...prev, dock: [...DEFAULT_DOCK] };
      saveHomeLayout(next);
      return next;
    });
    vibrate();
  }, [vibrate]);

  const handleLaunch = useCallback((appId: string) => {
    const app = useAppRegistryStore.getState().getApp(appId);
    if (!app) return;
    const existing = Object.values(windows).find((w) => w.appId === appId);
    if (existing) focusWindow(existing.id);
    // Warning: pass the manifest flags along, see the reasoning above.
    else openWindow(appId, { title: app.name, width: app.window.defaultWidth, height: app.window.defaultHeight, maximized: app.window.startMaximized, fullscreen: app.window.startFullscreen });
    setView("app");
  }, [windows, openWindow, focusWindow]);

  // A notification (shade card, "Open" pill) opened a window or brought one to
  // the front -> switch the view to "app", otherwise the target stays invisible
  // behind the shade. Desktop does not know this event and does not need it.
  useEffect(() => {
    const zeigen = () => {
      if (useWindowsStore.getState().windowOrder.length > 0) setView("app");
    };
    window.addEventListener(NOTIF_NAVIGATED_EVENT, zeigen);
    return () => window.removeEventListener(NOTIF_NAVIGATED_EVENT, zeigen);
  }, []);

  // ?app=<id> from ntfy click URLs (tap on an invitation on the phone) -> open the app;
  // ?chat=1 -> ClaraOverlay (e.g. tap on a Clara answer push)
  useBootDeepLink(handleLaunch, (chatId) => (chatId ? claraChatOeffnen(chatId) : claraOeffnen()));

  // ===================== Drag & Drop =====================
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const pageRef = useRef(clampedPage);
  // Layout via ref so the drag effect doesn't re-subscribe on every commit
  // (mirrors pageRef — the window-level listeners stay stable mid-drag).
  const layoutRef = useRef(layout);
  const lastFlip = useRef(0);
  dragRef.current = drag;
  pageRef.current = clampedPage;
  layoutRef.current = layout;

  const computeDropTarget = useCallback((x: number, y: number, d: DragState): DropTarget => {
    if ((d.kind === "widget" || d.source !== "drawer") && y < REMOVE_ZONE_H) return { type: "remove" };
    const dockRect = dockRef.current?.getBoundingClientRect();
    const gridRect = gridRef.current?.getBoundingClientRect();
    if (d.kind === "widget") {
      // Anchor the widget's top-left so the finger sits at its centre; clamp
      // into the grid; validity = the pure-transform overlap check.
      if (!gridRect) return { type: "widgetCell", page: pageRef.current, col: 0, row: 0, valid: false };
      const cellW = gridRect.width / GRID_COLS;
      const cellH = gridRect.height / GRID_ROWS;
      const col = Math.min(GRID_COLS - d.w, Math.max(0, Math.round((x - gridRect.left) / cellW - d.w / 2)));
      const row = Math.min(GRID_ROWS - d.h, Math.max(0, Math.round((y - gridRect.top) / cellH - d.h / 2)));
      const inDock = !!dockRect && y >= dockRect.top; // widgets can't dock
      // Occupied targets are VALID: the drop displaces whatever lies there
      // (moveWidgetDisplacing) — col/row are already clamped into bounds.
      const valid = !inDock;
      return { type: "widgetCell", page: pageRef.current, col, row, valid };
    }
    if (dockRect && y >= dockRect.top) {
      // 4 dock columns; column 0 is the fixed Clara button → app slots 0..2
      const col = Math.min(3, Math.max(0, Math.floor((x - dockRect.left) / (dockRect.width / 4))));
      return { type: "dock", slot: Math.max(0, col - 1) };
    }
    if (gridRect && x >= gridRect.left && x <= gridRect.right && y >= gridRect.top && y <= gridRect.bottom) {
      const col = Math.min(GRID_COLS - 1, Math.max(0, Math.floor((x - gridRect.left) / (gridRect.width / GRID_COLS))));
      const row = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((y - gridRect.top) / (gridRect.height / GRID_ROWS))));
      return { type: "cell", page: pageRef.current, cell: row * GRID_COLS + col };
    }
    return { type: "cell", page: pageRef.current, cell: -1 };
  }, []);

  const startDrag = useCallback((appId: string, source: DragSource, x: number, y: number) => {
    // Dragging from the drawer: reveal the home grid to drop onto.
    if (source === "drawer") setView("home");
    setMenu(null);
    setDrag({ kind: "icon", appId, source, x, y, originX: x, originY: y });
    setDropTarget(null);
    vibrate(15);
  }, [vibrate]);

  const startWidgetDrag = useCallback((wg: MobileWidget, x: number, y: number) => {
    setMenu(null);
    setDrag({ kind: "widget", widgetId: wg.id, widgetType: wg.type, w: wg.w, h: wg.h, x, y, originX: x, originY: y });
    setDropTarget(null);
    vibrate(15);
  }, [vibrate]);

  // Long-press on the page BACKGROUND (dead zone below the height-capped grid,
  // grid gaps) also opens the home menu: on a page whose cells are fully
  // covered by widgets there is no EmptyCell left to long-press, which locked
  // the user out of the widget picker. cell:-1 → addWidget auto-places at the
  // first free spot. Guarded to background targets so cells/icons/widgets keep
  // their own long-press handlers (their events bubble through here too).
  const bgLongPress = useLongPress({
    onLongPress: (x, y) => {
      vibrate(15);
      setMenu({ kind: "home", page: pageRef.current, cell: -1, x, y });
    },
  });
  const bgHandlers = {
    ...bgLongPress,
    onPointerDown: (e: React.PointerEvent) => {
      const target = e.target as HTMLElement;
      const isBg = [styles.gridViewport, styles.gridPage, styles.grid].some((c) => target.classList.contains(c));
      if (isBg) bgLongPress.onPointerDown(e);
    },
  };

  // Window-level pointer tracking while a drag is active.
  useEffect(() => {
    if (!drag) return;
    const trackMove = (x: number, y: number) => {
      const d = dragRef.current;
      if (!d) return;
      setDrag({ ...d, x, y });
      setDropTarget(computeDropTarget(x, y, d));
      // Edge flip between home pages while dragging.
      const vw = window.innerWidth;
      const ts = Date.now();
      if (ts - lastFlip.current > EDGE_FLIP_COOLDOWN) {
        if (x > vw - EDGE_FLIP_MARGIN && pageRef.current < pages.length - 1) {
          lastFlip.current = ts; setPageIdx((p) => Math.min(pages.length - 1, p + 1)); vibrate();
        } else if (x < EDGE_FLIP_MARGIN && pageRef.current > 0) {
          lastFlip.current = ts; setPageIdx((p) => Math.max(0, p - 1)); vibrate();
        }
      }
    };
    const onMove = (e: PointerEvent) => trackMove(e.clientX, e.clientY);
    // On-device the pointer stream dies with Android's pointercancel the
    // moment Chrome claims the pan (scrollable drawer source, view switch
    // under the finger). Native touchmove with preventDefault keeps the
    // drag alive — same workaround as the drawer/shade/recents gestures.
    const onTouchMove = (e: TouchEvent) => {
      if (!dragRef.current) return;
      if (e.cancelable) e.preventDefault();
      const touch = e.touches[0];
      if (touch) trackMove(touch.clientX, touch.clientY);
    };
    const onUp = () => {
      if (!dragRef.current) return; // pointerup + touchend both fire — run once
      const d = dragRef.current;
      dragRef.current = null;
      if (d) {
        const moved = Math.hypot(d.x - d.originX, d.y - d.originY);
        const target = computeDropTarget(d.x, d.y, d);
        if (d.kind === "widget") {
          if (moved < TAP_SLOP) {
            // Long-press without a drag → widget context menu.
            setMenu({ kind: "widget", widgetId: d.widgetId, widgetType: d.widgetType, x: d.x, y: d.y });
          } else if (target.type === "remove") {
            commitLayout(removeWidget(layout, d.widgetId));
          } else if (target.type === "widgetCell" && target.valid) {
            commitLayout(moveWidgetDisplacing(layout, d.widgetId, target.page, target.col, target.row));
          }
          // invalid drop → no commit → the widget snaps back
        } else if (moved < TAP_SLOP) {
          // Long-press without a drag: on a placed icon → open context menu;
          // on a drawer icon → just cancel (icon stays in the drawer).
          if (d.source !== "drawer") setMenu({ kind: "app", appId: d.appId, source: d.source, x: d.x, y: d.y });
        } else {
          if (target.type === "remove") {
            if (d.source !== "drawer") commitLayout(removeFromHome(layout, d.appId));
          } else if (target.type === "dock") {
            commitLayout(addToDockAt(layout, d.appId, target.slot));
          } else if (target.type === "cell" && target.cell >= 0) {
            commitLayout(placeOnGrid(layout, d.appId, target.page, target.cell));
          }
        }
      }
      setDrag(null);
      setDropTarget(null);
      vibrate();
    };
    // NOTE: pointercancel is deliberately NOT treated as a drop — dragging out
    // of the drawer unmounts the source element and Chrome cancels the POINTER
    // stream mid-drag while the TOUCH stream keeps flowing (tracked above).
    // touchend commits, touchcancel aborts without committing.
    const onTouchCancel = () => {
      dragRef.current = null;
      setDrag(null);
      setDropTarget(null);
    };
    // Touch events keep TARGETING the touchstart element for the whole
    // gesture. When that element is unmounted mid-drag (drawer → home), its
    // events no longer bubble to window — so the touch listeners must sit on
    // the SOURCE ELEMENT itself (captured at touchstart below); they keep
    // firing even on the detached node.
    const touchTarget: EventTarget = touchSrcRef.current ?? window;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    touchTarget.addEventListener("touchmove", onTouchMove as EventListener, { passive: false });
    touchTarget.addEventListener("touchend", onUp);
    touchTarget.addEventListener("touchcancel", onTouchCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      touchTarget.removeEventListener("touchmove", onTouchMove as EventListener);
      touchTarget.removeEventListener("touchend", onUp);
      touchTarget.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [drag, layout, pages.length, commitLayout, computeDropTarget, vibrate]);

  // Remember the element every touch gesture starts on (see drag effect above:
  // touch events target this element for the whole gesture, even if detached).
  const touchSrcRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onTS = (e: TouchEvent) => { touchSrcRef.current = e.target as HTMLElement; };
    document.addEventListener("touchstart", onTS, { capture: true, passive: true });
    return () => document.removeEventListener("touchstart", onTS, { capture: true } as EventListenerOptions);
  }, []);

  // ===================== Context menu =====================
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Widget picker: where the new widget should be anchored (long-pressed cell).
  const [pickerAt, setPickerAt] = useState<{ page: number; cell: number } | null>(null);

  const menuActions: ContextAction[] = useMemo(() => {
    if (menu?.kind === "widget") return [
      { key: "pin-top", label: t("menu.pinTop"), icon: "📌" },
      { key: "remove", label: t("menu.removeWidget"), icon: "🗑️", danger: true },
    ];
    if (menu?.kind === "home") return [
      { key: "widgets", label: t("menu.widgets"), icon: "🧩" },
    ];
    return [
      { key: "open", label: t("menu.open"), icon: "▶️" },
      { key: "remove", label: t("menu.removeFromHome"), icon: "🗑️", danger: true },
      { key: "info", label: t("menu.appInfo"), icon: "ⓘ" },
    ];
  }, [menu?.kind, t]);

  const menuTitle = useMemo(() => {
    if (!menu) return "";
    if (menu.kind === "widget") { const wm = widgetManifests[menu.widgetType]; return wm ? widgetName(wm) : t("menu.widget"); }
    if (menu.kind === "home") return t("menu.homeScreen");
    return getApp(menu.appId)?.name ?? menu.appId;
  }, [menu, getApp, t]);

  const onMenuAction = useCallback((key: string) => {
    const m = menu;
    if (!m) return;
    setMenu(null);
    if (m.kind === "widget") {
      if (key === "remove") { commitLayout(removeWidget(layout, m.widgetId)); vibrate(); }
      // One-tap escape hatch: pin the widget to the TOP of the first screen —
      // no cross-page drag + edge-flip gymnastics needed; occupants make way.
      if (key === "pin-top") {
        commitLayout(moveWidgetDisplacing(layout, m.widgetId, 0, 0, 0));
        setPageIdx(0);
        vibrate();
      }
      return;
    }
    if (m.kind === "home") {
      if (key === "widgets") setPickerAt({ page: m.page, cell: m.cell });
      return;
    }
    if (key === "open") handleLaunch(m.appId);
    else if (key === "remove") { commitLayout(removeFromHome(layout, m.appId)); vibrate(); }
    else if (key === "info") handleLaunch("settings");
  }, [menu, handleLaunch, commitLayout, layout, vibrate]);

  const onPickWidget = useCallback((type: string, w: number, h: number) => {
    const at = pickerAt
      ? { page: pickerAt.page, col: pickerAt.cell % GRID_COLS, row: Math.floor(pickerAt.cell / GRID_COLS) }
      : undefined;
    commitLayout(addWidget(layout, type, w, h, at));
    setPickerAt(null);
    vibrate(15);
  }, [pickerAt, commitLayout, layout, vibrate]);

  // ===================== View navigation =====================
  const handleHome = useCallback(() => { setMenu(null); setView("home"); }, []);
  const handleDrawer = useCallback(() => setView("drawer"), []);
  const handleRecents = useCallback(() => setView("recents"), []);
  const handleBack = useCallback(() => {
    if (view === "app" && windowOrder.length > 1) {
      focusWindow(windowOrder[windowOrder.length - 2]);
    } else setView("home");
  }, [view, windowOrder, focusWindow]);

  // ===================== Recents carousel + keep-alive surfaces =====================
  // The last KEEPALIVE_MAX windows stay MOUNTED (stable keys) — switching apps
  // is instant (no iframe reload), and the recents view shows the LIVE app
  // surfaces as One-UI-style cards. Older windows render placeholder cards.
  const KEEPALIVE_MAX = 5;
  const keepAliveIds = useMemo(
    () => new Set(windowOrder.slice(-KEEPALIVE_MAX)),
    [windowOrder],
  );
  const surfacesMode: "app" | "recents" | "hidden" =
    view === "app" ? "app" : view === "recents" ? "recents" : "hidden";
  const [recentIdx, setRecentIdx] = useState(0);
  const surfTrackRef = useRef<HTMLDivElement>(null);

  const RECENT_CARD_FRAC = 0.72;
  const RECENT_GAP = 20;
  const recentCardW = useCallback(() => window.innerWidth * RECENT_CARD_FRAC, []);
  const recentTrackX = useCallback(
    (idx: number) => (window.innerWidth - recentCardW()) / 2 - idx * (recentCardW() + RECENT_GAP),
    [recentCardW],
  );

  // entering recents: focus the card of the currently active app (MRU last)
  useEffect(() => {
    if (view === "recents") setRecentIdx(Math.max(0, windowOrder.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  // keep the index valid when windows close
  useEffect(() => {
    setRecentIdx((i) => Math.min(i, Math.max(0, windowOrder.length - 1)));
  }, [windowOrder.length]);

  // One gesture handler (home-swiper pattern; container has touch-action:none
  // in recents mode, so pointermove is reliable — no pointercancel issue):
  // direction-locks after 12px; X pans the track 1:1 with snap-on-release,
  // Y-up flings the touched card away (close), <10px movement = tap (focus).
  const surfGes = useRef<{
    x: number; y: number; lock: "" | "x" | "y";
    cardId: string | null; cardEl: HTMLElement | null;
    lastX: number; lastT: number; vx: number; done: boolean;
  } | null>(null);

  const dismissRecentCard = useCallback((id: string, el: HTMLElement | null) => {
    vibrate();
    const wasLast = windowOrder.length <= 1;
    if (el) {
      el.style.transition = "transform 0.18s ease-in, opacity 0.18s ease-in";
      el.style.transform = "translateY(-120%)";
      el.style.opacity = "0";
      setTimeout(() => {
        el.style.transition = "width 0.14s ease-out, margin 0.14s ease-out";
        el.style.width = "0px";
        el.style.marginRight = `-${RECENT_GAP}px`;
        setTimeout(() => {
          closeWindow(id);
          if (wasLast) setView("home");
        }, 140);
      }, 170);
    } else {
      closeWindow(id);
      if (wasLast) setView("home");
    }
  }, [vibrate, closeWindow, windowOrder.length]);

  const onSurfDown = useCallback((e: React.PointerEvent) => {
    if (view !== "recents") return;
    const cardEl = (e.target as HTMLElement).closest("[data-surf-id]") as HTMLElement | null;
    surfGes.current = {
      x: e.clientX, y: e.clientY, lock: "",
      cardId: cardEl?.dataset.surfId ?? null, cardEl,
      lastX: e.clientX, lastT: performance.now(), vx: 0, done: false,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, [view]);

  const onSurfMove = useCallback((e: React.PointerEvent) => {
    const s = surfGes.current;
    if (!s || s.done) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.lock) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      s.lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (s.lock === "x") {
      const now = performance.now();
      if (now > s.lastT) s.vx = (e.clientX - s.lastX) / (now - s.lastT);
      s.lastX = e.clientX; s.lastT = now;
      const track = surfTrackRef.current;
      if (track) {
        track.style.transition = "none";
        track.style.transform = `translateX(${recentTrackX(recentIdx) + dx}px)`;
      }
    } else if (s.cardEl && dy < 0) {
      // card follows the finger upward, fading out
      s.cardEl.style.transition = "none";
      s.cardEl.style.transform = `translateY(${dy}px)`;
      s.cardEl.style.opacity = String(Math.max(0.25, 1 + dy / 320));
      if (dy < -140) {
        s.done = true;
        if (s.cardId) dismissRecentCard(s.cardId, s.cardEl);
      }
    }
  }, [recentIdx, recentTrackX, dismissRecentCard]);

  const onSurfUp = useCallback((e: React.PointerEvent) => {
    const s = surfGes.current;
    surfGes.current = null;
    if (!s || s.done) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.lock) {
      // tap: bring the touched card's app to the foreground
      if (s.cardId && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        vibrate();
        focusWindow(s.cardId);
        setView("app");
      }
      return;
    }
    if (s.lock === "x") {
      const w = recentCardW() + RECENT_GAP;
      let next = recentIdx;
      if (Math.abs(dx) > w * 0.25 || Math.abs(s.vx) > 0.4) next = recentIdx + (dx < 0 ? 1 : -1);
      next = Math.max(0, Math.min(windowOrder.length - 1, next));
      const track = surfTrackRef.current;
      if (track) {
        track.style.transition = "transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)";
        track.style.transform = `translateX(${recentTrackX(next)}px)`;
      }
      if (next !== recentIdx) { vibrate(); setRecentIdx(next); }
    } else if (s.cardEl) {
      if (dy < -96) {
        if (s.cardId) dismissRecentCard(s.cardId, s.cardEl);
      } else {
        // spring back
        s.cardEl.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out";
        s.cardEl.style.transform = "";
        s.cardEl.style.opacity = "1";
      }
    }
  }, [recentIdx, recentCardW, recentTrackX, windowOrder.length, vibrate, focusWindow, dismissRecentCard]);

  const closeAllRecents = useCallback(() => {
    vibrate();
    [...windowOrder].forEach((id) => closeWindow(id));
    setView("home");
  }, [windowOrder, closeWindow, vibrate]);

  // Browser-history back integration.
  // Warning: the entry used to be pushed only on a VIEW change. Opening another
  // app from a running one (file list -> image viewer) keeps `view === "app"` —
  // NO new entry was created. Android's back then had nothing left to pop and
  // left the app instead of returning to the list ("no back to open another
  // image"). Therefore the push now also depends on the number of open windows.
  const ignorePop = useRef(false);
  useEffect(() => {
    if (ignorePop.current) { ignorePop.current = false; return; }
    window.history.pushState({ view, tiefe: windowOrder.length }, "");
  }, [view, windowOrder.length]);
  useEffect(() => {
    const onPop = () => {
      ignorePop.current = true;
      if (menu) { setMenu(null); return; }
      // Important: close instead of just focusing: previously the viewer stayed
      // open and the next forward gesture landed in it again. Whoever goes back
      // from the viewer wants to be rid of it.
      if (view === "app" && windowOrder.length > 1) closeWindow(windowOrder[windowOrder.length - 1]);
      else if (view !== "home") setView("home");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [view, windowOrder, closeWindow, menu]);

  // ===================== Home-screen gestures =====================
  // The swipe is recognised DURING the move, not on pointerup. On some Android
  // devices the gesture navigation can claim an upward swipe mid-gesture and fire
  // `pointercancel` (no pointerup ever arrives) — so any up-based detection
  // silently fails. Acting on pointermove fires before Android can cancel.
  // The home surface carries `touch-action: none` so moves stream reliably.
  const swipeStart = useRef<{ x: number; y: number; fired: boolean; inWidget: boolean } | null>(null);
  const onHomePointerDown = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) return;
    // Gestures starting inside a widget belong to the widget (vertical scroll,
    // button taps) — never to the page-swipe handler.
    const inWidget = !!(e.target as HTMLElement).closest?.("[data-widget-id]");
    swipeStart.current = { x: e.clientX, y: e.clientY, fired: false, inWidget };
  }, []);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const s = swipeStart.current;
      if (!s || s.fired) return;
      if (dragRef.current) { swipeStart.current = null; return; }
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      const absX = Math.abs(dx), absY = Math.abs(dy);
      // Vertical gestures starting inside a widget belong to the widget
      // (list scroll, check-off) — but HORIZONTAL swipes over widgets still
      // switch the home page (widgets only scroll vertically).
      if (!s.inWidget) {
        // Swipe-up → app drawer (vertical dominates).
        if (dy < -44 && absY > absX) {
          s.fired = true; vibrate(); setView("drawer"); return;
        }
        // Pull-down from the top → notifications.
        if (dy > 56 && absY > absX && s.y < 90) {
          s.fired = true; vibrate(); oeffneShade(s.x); return;
        }
      }
      // Horizontal swipe → switch home page (dock stays fixed).
      if (absX > 52 && absX > absY) {
        s.fired = true; vibrate();
        setPageIdx((i) => dx < 0 ? Math.min(pages.length - 1, i + 1) : Math.max(0, i - 1));
      }
    };
    const onEnd = () => { swipeStart.current = null; };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [pages.length, vibrate, oeffneShade]);

  // ===================== Top-edge pull-down → notification shade =====================
  // Works from ANY view: the status bar is parent-rendered above the app iframe,
  // and pointer-capture keeps the gesture tracked even as the finger moves over
  // the iframe below. Tap still opens (onClick fallback on the status bar).
  const statusPull = useRef<{ x: number; y: number; fired: boolean } | null>(null);
  const onStatusDown = useCallback((e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    statusPull.current = { x: e.clientX, y: e.clientY, fired: false };
  }, []);
  const onStatusMove = useCallback((e: React.PointerEvent) => {
    const s = statusPull.current;
    if (!s || s.fired) return;
    if (e.clientY - s.y > 40) { s.fired = true; vibrate(); oeffneShade(s.x); }
  }, [vibrate, oeffneShade]);
  const onStatusEnd = useCallback(() => { statusPull.current = null; }, []);

  // ===================== Drawer dismiss (swipe) =====================
  // The app drawer is full-screen, so the finger stays on it and element-level
  // pointermove is reliable (detect on move, per the Android pointercancel
  // lesson). Swipe DOWN while the app list is at the top closes it (overscroll).
  // If the list fits without scrolling, swipe in EITHER direction closes.
  const drawerScrollRef = useRef<HTMLDivElement>(null);
  const drawerPull = useRef<{ y: number; fired: boolean; atTop: boolean; scrollable: boolean } | null>(null);
  const onDrawerDown = useCallback((e: React.PointerEvent) => {
    const el = drawerScrollRef.current;
    drawerPull.current = {
      y: e.clientY,
      fired: false,
      atTop: !el || el.scrollTop <= 0,
      scrollable: !!el && el.scrollHeight > el.clientHeight + 4,
    };
  }, []);
  const onDrawerMove = useCallback((e: React.PointerEvent) => {
    const s = drawerPull.current;
    if (!s || s.fired) return;
    const dy = e.clientY - s.y;
    if (s.atTop && dy > 64) { s.fired = true; vibrate(); handleHome(); }
    else if (!s.scrollable && dy < -64) { s.fired = true; vibrate(); handleHome(); }
  }, [vibrate, handleHome]);
  const onDrawerEnd = useCallback(() => { drawerPull.current = null; }, []);

  // On-device the pointer handlers above die on Android's pointercancel: the
  // moment Chrome claims the pan for (over)scroll, no more pointermove fires
  // and the close threshold is never reached. Native touch listeners with
  // {passive:false} let us preventDefault() exactly the CLOSE pulls (down
  // while the list is at its top / up while it cannot scroll), so the gesture
  // stays ours; real list scrolling is untouched.
  const drawerPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view !== "drawer") return;
    const panel = drawerPanelRef.current;
    if (!panel) return;
    let s: { y: number; atTop: boolean; scrollable: boolean; fired: boolean } | null = null;
    const down = (e: TouchEvent) => {
      const el = drawerScrollRef.current;
      s = {
        y: e.touches[0].clientY,
        fired: false,
        atTop: !el || el.scrollTop <= 0,
        scrollable: !!el && el.scrollHeight > el.clientHeight + 4,
      };
    };
    const move = (e: TouchEvent) => {
      if (!s || s.fired) return;
      const dy = e.touches[0].clientY - s.y;
      const closingPull = (s.atTop && dy > 0) || (!s.scrollable && dy < 0);
      if (closingPull && e.cancelable) e.preventDefault();
      if ((s.atTop && dy > 64) || (!s.scrollable && dy < -64)) {
        s.fired = true; vibrate(); handleHome();
      }
    };
    const end = () => { s = null; };
    panel.addEventListener("touchstart", down, { passive: true });
    panel.addEventListener("touchmove", move, { passive: false });
    panel.addEventListener("touchend", end);
    panel.addEventListener("touchcancel", end);
    return () => {
      panel.removeEventListener("touchstart", down);
      panel.removeEventListener("touchmove", move);
      panel.removeEventListener("touchend", end);
      panel.removeEventListener("touchcancel", end);
    };
  }, [view, vibrate, handleHome]);

  // ===================== Shade dismiss (swipe up) =====================
  const notifListRef = useRef<HTMLDivElement>(null);
  const shadePull = useRef<{ y: number; fired: boolean; atTop: boolean } | null>(null);
  const onShadeDown = useCallback((e: React.PointerEvent) => {
    // Quick settings controls (slider, tile pager) own their drags
    // themselves — the close gesture must not even arm there
    // (data-qs-control is set by QuickSettings.tsx).
    if ((e.target as HTMLElement).closest?.("[data-qs-control]")) {
      shadePull.current = null;
      return;
    }
    const el = notifListRef.current;
    shadePull.current = { y: e.clientY, fired: false, atTop: !el || el.scrollTop <= 0 };
  }, []);
  const onShadeMove = useCallback((e: React.PointerEvent) => {
    const s = shadePull.current;
    if (!s || s.fired) return;
    if (s.atTop && e.clientY - s.y < -56) { s.fired = true; vibrate(); handleHome(); }
  }, [vibrate, handleHome]);
  const onShadeEnd = useCallback(() => { shadePull.current = null; }, []);

  // Same pointercancel workaround for the shade: swipe UP closes it — only
  // treated as a close pull when the notification list cannot scroll further
  // down (not scrollable or already at its bottom), so list scrolling wins.
  const notifPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shadeOffen) return;
    const panel = notifPanelRef.current;
    if (!panel) return;
    let s: { y: number; closable: boolean; fired: boolean } | null = null;
    const down = (e: TouchEvent) => {
      // Same guard as in the React path: drags on QS sliders/pager
      // belong to the control, never to the close gesture.
      if ((e.target as HTMLElement).closest?.("[data-qs-control]")) {
        s = null;
        return;
      }
      const el = notifListRef.current;
      const scrollable = !!el && el.scrollHeight > el.clientHeight + 4;
      const atBottom = !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      s = { y: e.touches[0].clientY, fired: false, closable: !scrollable || atBottom };
    };
    const move = (e: TouchEvent) => {
      if (!s || s.fired) return;
      const dy = e.touches[0].clientY - s.y;
      if (s.closable && dy < 0 && e.cancelable) e.preventDefault();
      if (s.closable && dy < -56) { s.fired = true; vibrate(); handleHome(); }
    };
    const end = () => { s = null; };
    panel.addEventListener("touchstart", down, { passive: true });
    panel.addEventListener("touchmove", move, { passive: false });
    panel.addEventListener("touchend", end);
    panel.addEventListener("touchcancel", end);
    return () => {
      panel.removeEventListener("touchstart", down);
      panel.removeEventListener("touchmove", move);
      panel.removeEventListener("touchend", end);
      panel.removeEventListener("touchcancel", end);
    };
  }, [shadeOffen, vibrate, handleHome]);

  const draggingApp = drag?.kind === "icon" ? getApp(drag.appId) : null;
  const kompakt = view === "app" && !claraOpen;

  return (
    <div className={styles.shell}>
      {SkinScene && (
        <div className={styles.skinSceneBg} aria-hidden="true">
          <Suspense fallback={null}>
            <SkinScene />
          </Suspense>
        </div>
      )}
      {/* Status Bar — tap or pull down to open the notification shade */}
      <div
        className={styles.statusBar}
        style={{
          touchAction: "none",
          background: barCols ? barCols.top : undefined,
          ["--bar-fg" as string]: barCols ? barFg(barCols.top) : undefined,
        } as CSSProperties}
        onClick={(e) => oeffneShade(e.clientX)}
        onPointerDown={onStatusDown}
        onPointerMove={onStatusMove}
        onPointerUp={onStatusEnd}
        onPointerCancel={onStatusEnd}
      >
        <span className={styles.statusTime}>
          {now.toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" })}
        </span>
        <span className={styles.statusRight}>
          {unreadCount > 0 && <span className={styles.statusBadge}>{unreadCount}</span>}
          <Icon name="battery" size={16} />
        </span>
      </div>

      {/* Content Area */}
      <div className={styles.content}>
        {/* Keep-alive app surfaces — PERSISTENT (outside AnimatePresence, stable
            keys): the last KEEPALIVE_MAX windows stay mounted so app switching
            is instant, and in recents mode the SAME live surfaces become the
            One-UI-style carousel cards. Placeholder cards for older windows. */}
        <div
          className={styles.appSurfaces}
          data-mode={surfacesMode}
          onPointerDown={onSurfDown}
          onPointerMove={onSurfMove}
          onPointerUp={onSurfUp}
          onPointerCancel={onSurfUp}
        >
          <div
            className={styles.surfTrack}
            ref={surfTrackRef}
            style={surfacesMode === "recents" ? {
              transform: `translateX(${recentTrackX(recentIdx)}px)`,
              transition: "transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)",
            } : undefined}
          >
            {windowOrder.map((id) => {
              const win = windows[id];
              if (!win) return null;
              const app = getApp(win.appId);
              const kept = keepAliveIds.has(id);
              const cols = appBarColors(win.appId);
              return (
                <div
                  key={id}
                  className={styles.surfCard}
                  data-surf-id={id}
                  data-active={id === activeId ? "true" : "false"}
                >
                  {surfacesMode === "recents" && (
                    <div className={styles.surfChrome}>
                      <AppIcon appId={win.appId} fallback={app?.icon ?? "▦"} forceLogos pixelSize={26} />
                      <span className={styles.surfName}>{app?.name ?? win.title}</span>
                    </div>
                  )}
                  <div className={styles.surfClip}>
                    {kept ? (
                      <div className={`${styles.surfScale} window-content-selectable`}>
                        <AppContent appId={win.appId} windowId={win.id} />
                      </div>
                    ) : (
                      <div
                        className={styles.surfPlaceholder}
                        style={{ background: `linear-gradient(165deg, ${cols.top} 0%, #0b1220 90%)` }}
                      >
                        <AppIcon appId={win.appId} fallback={app?.icon ?? "▦"} forceLogos pixelSize={56} />
                        <span>{app?.name ?? win.title}</span>
                      </div>
                    )}
                    {surfacesMode === "recents" && <div className={styles.surfShield} />}
                  </div>
                </div>
              );
            })}
          </div>
          {surfacesMode === "recents" && windowOrder.length === 0 && (
            <p className={styles.emptyMsg}>{t("recents.empty")}</p>
          )}
          {surfacesMode === "recents" && windowOrder.length > 0 && (
            <button className={styles.clearAllPill} onClick={closeAllRecents}>{t("recents.closeAll")}</button>
          )}
          {surfacesMode === "app" && !activeWindow && (
            <p className={styles.emptyMsg}>{t("recents.noApp")}</p>
          )}
        </div>
        <AnimatePresence>
          {view === "home" && (
            <motion.div
              key="home"
              className={styles.home}
              onPointerDown={onHomePointerDown}
              style={{ touchAction: "none" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {/* Big header clock only when no clock widget covers that job */}
              {!layout.widgets.some((w) => w.type === "flip-clock-weather") && (
                <>
                  <div className={styles.clockBig}>
                    {now.toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <div className={styles.clockDate}>
                    {now.toLocaleDateString(regionLocale(), { weekday: "long", day: "numeric", month: "long" })}
                  </div>
                </>
              )}

              {/* Home grid — pages slide horizontally, dock below stays fixed.
                  Icons AND widgets are CSS-grid items of the same .grid; every
                  cell is explicitly placed so auto-placement never reflows
                  icons around the multi-cell widget items. */}
              <div className={styles.gridViewport} {...bgHandlers}>
                {pages.map((page, p) => (
                  <div
                    key={p}
                    className={styles.gridPage}
                    style={{ transform: `translateX(${(p - clampedPage) * 100}%)` }}
                  >
                    <div className={styles.grid} ref={p === clampedPage ? gridRef : undefined}>
                      {page.map((appId, cell) => {
                        const isDropCell = dropTarget?.type === "cell"
                          && dropTarget.page === clampedPage && dropTarget.cell === cell && p === clampedPage;
                        const app = appId ? getApp(appId) : null;
                        const hidden = drag?.kind === "icon" && appId === drag.appId;
                        const cellStyle = {
                          gridColumn: (cell % GRID_COLS) + 1,
                          gridRow: Math.floor(cell / GRID_COLS) + 1,
                        };
                        return (
                          <div
                            key={cell}
                            style={cellStyle}
                            className={`${styles.gridCell} ${isDropCell ? styles.gridCellTarget : ""}`}
                          >
                            {app && !hidden ? (
                              <HomeIcon
                                app={app}
                                onTap={() => handleLaunch(app.id)}
                                onLongPress={(x, y) => startDrag(app.id, "home", x, y)}
                              />
                            ) : !app ? (
                              <EmptyCell
                                onLongPress={(x, y) => { vibrate(15); setMenu({ kind: "home", page: p, cell, x, y }); }}
                              />
                            ) : null}
                          </div>
                        );
                      })}
                      {layout.widgets.filter((wg) => wg.page === p).map((wg) => (
                        <MobileWidgetFrame
                          key={wg.id}
                          widget={wg}
                          hidden={drag?.kind === "widget" && drag.widgetId === wg.id}
                          dragRef={dragRef}
                          onOpenApp={(appId) => { if (getApp(appId)) handleLaunch(appId); }}
                          onLongPress={(x, y) => startWidgetDrag(wg, x, y)}
                        />
                      ))}
                      {drag?.kind === "widget" && dropTarget?.type === "widgetCell"
                        && dropTarget.page === clampedPage && p === clampedPage && (
                        <div
                          className={`${styles.widgetDropPreview} ${!dropTarget.valid ? styles.widgetDropInvalid : ""}`}
                          style={{
                            gridColumn: `${dropTarget.col + 1} / span ${drag.w}`,
                            gridRow: `${dropTarget.row + 1} / span ${drag.h}`,
                          }}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Page dots */}
              <div className={styles.pageDots}>
                {pages.map((_, i) => (
                  <button
                    key={i}
                    className={`${styles.pageDot} ${i === clampedPage ? styles.pageDotActive : ""}`}
                    onClick={() => setPageIdx(i)}
                    aria-label={t("home.page", { number: i + 1 })}
                  />
                ))}
              </div>

              {/* Drawer hint (tappable + swipe-up affordance) */}
              <div className={styles.drawerHint} onClick={handleDrawer}>
                <div className={styles.drawerHintBar} />
              </div>

              {/* Dock — favourite apps flanking the central Clara button */}
              <div className={styles.dock} ref={dockRef}>
                {(() => {
                  const ids = layout.dock.slice(0, 3);
                  const renderSlot = (appId: string | undefined, slot: number) => {
                    const app = appId ? getApp(appId) : undefined;
                    const isTarget = dropTarget?.type === "dock" && dropTarget.slot === slot;
                    const hidden = !!app && drag?.kind === "icon" && drag.appId === app.id;
                    return (
                      <div key={slot} className={`${styles.dockSlot} ${isTarget ? styles.dockSlotTarget : ""}`}>
                        {app && !hidden && (
                          <HomeIcon
                            app={app}
                            hideLabel
                            onTap={() => handleLaunch(app.id)}
                            onLongPress={(x, y) => startDrag(app.id, "dock", x, y)}
                          />
                        )}
                      </div>
                    );
                  };
                  return (
                    <>
                      {/* Clara — fixed leftmost, styled like a grid icon */}
                      <button
                        className={styles.homeIcon}
                        onClick={() => { vibrate(15); claraOeffnen(); }}
                        aria-label={t("home.askClara")}
                      >
                        <span className={`${styles.iconSquircle} ${styles.claraDockOrb}`}>
                          <span className={styles.claraDockGlow} />
                          <ClaraC className={styles.claraDockIcon} />
                        </span>
                      </button>
                      {[0, 1, 2].map((slot) => renderSlot(ids[slot], slot))}
                    </>
                  );
                })()}
              </div>
            </motion.div>
          )}

          {view === "drawer" && (
            <motion.div
              key="drawer"
              ref={drawerPanelRef}
              className={styles.drawer}
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              onPointerDown={onDrawerDown}
              onPointerMove={onDrawerMove}
              onPointerUp={onDrawerEnd}
              onPointerCancel={onDrawerEnd}
            >
              <div className={styles.drawerHandle} onClick={handleHome} />
              <div className={styles.drawerHeaderRow}>
                <input
                  className={styles.drawerSearch}
                  type="search"
                  placeholder={t("drawer.searchPlaceholder")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {installEvent && !isInstalled && (
                  <button className={styles.installBtn} onClick={handleInstall}>📲 Installieren</button>
                )}
              </div>
              <div className={styles.drawerGrid} ref={drawerScrollRef}>
                {!appsLoaded && <div className={styles.emptyMsg}>{t("drawer.loading")}</div>}
                {appsLoaded && filteredApps.length === 0 && <div className={styles.emptyMsg}>{t("drawer.noResults")}</div>}
                {filteredApps.map((app) => (
                  <DrawerTile
                    key={app.id}
                    app={app}
                    onHome={isOnHome(layout, app.id)}
                    onLaunch={() => handleLaunch(app.id)}
                    onLongPress={(x, y) => startDrag(app.id, "drawer", x, y)}
                  />
                ))}
              </div>
              <div className={styles.drawerFooterHint}>{t("drawer.hint")}</div>
            </motion.div>
          )}

          {shadeOffen && (
            <Shade
              modus={shadeAufbau === "kombiniert" ? "kombiniert" : (view === "quicksettings" ? "schnell" : "meldungen")}
              panelRef={notifPanelRef}
              listRef={notifListRef}
              gesten={{ onPointerDown: onShadeDown, onPointerMove: onShadeMove, onPointerUp: onShadeEnd, onPointerCancel: onShadeEnd }}
              onWechsel={(ziel) => setView(ziel === "schnell" ? "quicksettings" : "notifications")}
              onSchliessen={handleHome}
              onResetDock={resetDock}
              vibrate={vibrate}
            />
          )}

        </AnimatePresence>
      </div>

      {/* Remove zone (only visible while dragging a home/dock icon or a widget) */}
      <AnimatePresence>
        {drag && (drag.kind === "widget" || drag.source !== "drawer") && (
          <motion.div
            className={`${styles.removeZone} ${dropTarget?.type === "remove" ? styles.removeZoneActive : ""}`}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            🗑️ Zum Entfernen hierher ziehen
          </motion.div>
        )}
      </AnimatePresence>

      {/* Drag ghost — live app icon for icons, lightweight placeholder for widgets */}
      {drag && drag.kind === "icon" && draggingApp && (
        <div className={styles.dragGhost} style={{ left: drag.x, top: drag.y }}>
          <span className={styles.iconSquircle}>
            <AppIcon appId={draggingApp.id} fallback={draggingApp.icon} iconUrl={draggingApp.config?.iconUrl} forceLogos pixelSize={34} className={styles.appLogo} />
          </span>
        </div>
      )}
      {drag && drag.kind === "widget" && (
        <div className={`${styles.dragGhost} ${styles.widgetGhost}`} style={{ left: drag.x, top: drag.y }}>
          <span className={styles.widgetGhostEmoji}>{MOBILE_WIDGET_EMOJI[drag.widgetType] ?? "🧩"}</span>
          <span className={styles.widgetGhostName}>{widgetManifests[drag.widgetType] ? widgetName(widgetManifests[drag.widgetType]) : drag.widgetType}</span>
        </div>
      )}

      {/* Context menu (app / widget / empty home cell) */}
      {menu && (menu.kind !== "app" || getApp(menu.appId)) && (
        <IconContextMenu
          x={menu.x}
          y={menu.y}
          title={menuTitle}
          actions={menuActions}
          onAction={onMenuAction}
          onClose={() => setMenu(null)}
        />
      )}

      {/* Widget picker bottom sheet */}
      <AnimatePresence>
        {pickerAt && (
          <WidgetPicker onSelect={onPickWidget} onClose={() => setPickerAt(null)} />
        )}
      </AnimatePresence>

      {/* Bottom Navigation */}
      <div
        className={styles.bottomNav}
        data-kompakt={kompakt ? "ja" : undefined}
        style={{
          background: barCols ? barCols.bottom : undefined,
          ["--bar-fg" as string]: barCols ? barFg(barCols.bottom) : undefined,
        } as CSSProperties}
      >
        {/* Corners: Clara on the left, camera on the right — the three navigation
            buttons stay untouched in the middle. The corners are the only
            spot no app uses (measured across 23 apps). */}
        <EckenGriff
          seite="links"
          signal={claraArbeitet && !claraOpen ? "arbeitet" : claraUngelesen && !claraOpen ? "fertig" : null}
          label={t("grip.clara")}
          icon={<ClaraC className={styles.eckenIcon} />}
          onAusloesen={(art) => {
            // Inside a running app Clara gets it as context
            // (split view), otherwise the chat opens on its own.
            if (view === "app" && activeWindow) {
              const app = getApp(activeWindow.appId);
              if (!app || resolveMobileStrategy(app).strategy !== "redirect") {
                setCobrowseAppId(activeWindow.appId);
              }
            }
            claraOeffnen({ voice: art === "wisch" });
          }}
        />

        {/* Inside a running app the bar shrinks to a gesture pill — like
            Android's own. Tap = home, long press = overview; back is handled by
            the Android gesture (popstate, see above). So instead of ~200 px of
            bars only the app's toolbar and these 30 px remain. */}
        {kompakt ? (
          <HomeButton
            active={false}
            pille
            onTap={handleHome}
            onLongPress={() => { vibrate(20); handleRecents(); }}
          />
        ) : (
          <>
            <button className={`${styles.navBtn} ${view === "recents" ? styles.navActive : ""}`} onClick={handleRecents} aria-label={t("nav.recents")}><Icon name="recents" size={20} /></button>
            <HomeButton
              active={view === "home"}
              onTap={handleHome}
              onLongPress={() => { vibrate(20); claraOeffnen(); }}
            />
            <button className={styles.navBtn} onClick={handleBack} aria-label={t("nav.back")}><Icon name="back" size={22} /></button>
          </>
        )}

        <EckenGriff
          seite="rechts"
          label={t("grip.camera")}
          icon={<CameraGlyph />}
          onAusloesen={() => handleLaunch("kamera")}
        />
      </div>

      {/* The floating Clara button has been removed. It sat bottom right —
          exactly where apps have their main button — and, measured, covered a
          control in 5 of 23 apps. Clara now sits as a corner grip in the
          navigation bar and can no longer cover anything. */}

      {/* Clara fullscreen assistant overlay (Gemini-style). With a cobrowse app it
          splits: app on top, the SAME quick-chat below (Clara operates, user watches). */}
      <ClaraOverlay
        cobrowseAppId={cobrowseWindow ? cobrowseAppId : null}
        open={claraOpen || claraArbeitet}
        versteckt={!claraOpen}
        onStreamingChange={(s) => {
          setClaraArbeitet(s);
          if (!s && !claraOpen) setClaraUngelesen(true);
        }}
        voice={claraVoice}
        onClose={() => {
          // Cobrowse: closing the chat keeps the app running full screen —
          // the Clara FAB brings the chat back.
          if (cobrowseWindow) {
            focusWindow(cobrowseWindow.id);
            setView("app");
          }
          setClaraOpen(false);
          setCobrowseAppId(null);
        }}
        appSlot={claraOpen && cobrowseWindow ? <AppContent appId={cobrowseWindow.appId} windowId={cobrowseWindow.id} forceInline /> : null}
        onExitCobrowse={() => setCobrowseAppId(null)}
      />
    </div>
  );
}

// ----- Icon used on the home grid + dock (tap = launch, long-press = menu) -----
// One-UI look: the emoji sits on a translucent squircle plate.
function HomeIcon({
  app, compact, hideLabel, onTap, onLongPress,
}: {
  app: AppManifest;
  compact?: boolean;
  hideLabel?: boolean;   // dock: full-size icon, no caption
  onTap: () => void;
  onLongPress: (x: number, y: number) => void;
}) {
  const handlers = useLongPress({ onTap, onLongPress });
  return (
    <button className={`${styles.homeIcon} ${compact ? styles.homeIconCompact : ""}`} data-app-id={app.id} {...handlers}>
      <span className={styles.iconSquircle}>
        <AppIcon appId={app.id} fallback={app.icon} iconUrl={app.config?.iconUrl} forceLogos pixelSize={compact ? 27 : 32} className={styles.appLogo} />
      </span>
      {!compact && !hideLabel && <span className={styles.appName}>{app.name}</span>}
    </button>
  );
}

// ----- Empty home cell: long-press opens the homescreen menu (widgets) -----
// useLongPress cancels on >10px movement, so page swipes stay unaffected.
function EmptyCell({ onLongPress }: { onLongPress: (x: number, y: number) => void }) {
  const handlers = useLongPress({ onTap: () => { /* empty cell: no-op */ }, onLongPress });
  return <div className={styles.emptyCell} {...handlers} />;
}

// ----- Home-screen widget frame -----
// Placed as a CSS-grid item spanning the widget's rect. The widget CONTENT is
// not interactive (pointer-events:none) — all pointer input lands on the
// frame: tap opens the associated app, long-press starts the drag. This keeps
// v1 free of drag-vs-inner-tap ambiguity and matches Android's feel.
// The widget content is now INTERACTIVE (scroll, buttons, check-off). The
// frame only owns long-press → drag: React pointer events bubble, so a hold
// anywhere (incl. on a row) still starts the timer, while a short tap or a
// >10px move cancels it and reaches the content. No frame-level onTap — that
// would fight content clicks; "open app" lives in the widget header instead.
// `dragRef` lets content handlers early-return during a drag.
function MobileWidgetFrame({
  widget, hidden, onLongPress, dragRef, onOpenApp,
}: {
  widget: MobileWidget;
  hidden?: boolean;
  onLongPress: (x: number, y: number) => void;
  dragRef: { current: unknown };
  onOpenApp: (appId: string) => void;
}) {
  const Comp = widgetComponents[widget.type];
  const handlers = useLongPress({ onLongPress });
  const guardRef = { current: false };
  Object.defineProperty(guardRef, "current", { get: () => !!dragRef.current });
  const openThisApp = () => {
    const appId = MOBILE_WIDGET_OPEN_APP[widget.type];
    if (appId) onOpenApp(appId);
  };
  return (
    <div
      className={`${styles.mWidget} ${widget.type === "flip-clock-weather" ? styles.mWidgetBare : ""}`}
      data-widget-id={widget.id}
      style={{
        gridColumn: `${widget.col + 1} / span ${widget.w}`,
        gridRow: `${widget.row + 1} / span ${widget.h}`,
        visibility: hidden ? "hidden" : undefined,
      }}
      {...handlers}
    >
      <div className={styles.mWidgetContent}>
        {Comp ? (
          <AppErrorBoundary appName={`Widget ${widget.type}`}>
            <Suspense fallback={<div className={styles.loading}>…</div>}>
              <Comp widgetId={widget.id} config={widget.config} guardRef={guardRef} onOpenApp={openThisApp} />
            </Suspense>
          </AppErrorBoundary>
        ) : (
          <div className={styles.loading}>{widget.type}</div>
        )}
      </div>
    </div>
  );
}

// ----- Drawer tile (tap = launch, long-press = start drag onto home) -----
function DrawerTile({
  app, onHome, onLaunch, onLongPress,
}: {
  app: AppManifest;
  onHome: boolean;
  onLaunch: () => void;
  onLongPress: (x: number, y: number) => void;
}) {
  const handlers = useLongPress({ onTap: onLaunch, onLongPress });
  return (
    <button className={`${styles.drawerTile} ${onHome ? styles.drawerTilePinned : ""}`} data-app-id={app.id} {...handlers}>
      <span className={styles.iconSquircle}>
        <AppIcon appId={app.id} fallback={app.icon} iconUrl={app.config?.iconUrl} forceLogos pixelSize={32} className={styles.appLogo} />
      </span>
      <span className={styles.appName}>{app.name}</span>
      {onHome && <span className={styles.pinBadge}>●</span>}
    </button>
  );
}

function CameraGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5h3.2l1.4-2h7.8l1.4 2H20a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.2" r="3.4" />
    </svg>
  );
}

function HomeButton({ active, pille, onTap, onLongPress }: { active: boolean; pille?: boolean; onTap: () => void; onLongPress: () => void; }) {
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const { t } = useTranslation("mobile");
  return (
    <button
      className={pille ? styles.gestenPille : `${styles.navBtn} ${styles.homeBtn} ${active ? styles.navActive : ""}`}
      aria-label={pille ? t("nav.homePill") : t("nav.homeButton")}
      onPointerDown={() => {
        longPressed.current = false;
        clear();
        timer.current = window.setTimeout(() => { longPressed.current = true; onLongPress(); }, 500);
      }}
      onPointerUp={() => { clear(); if (!longPressed.current) onTap(); }}
      onPointerLeave={clear}
      onPointerCancel={clear}
    >{pille ? <span className={styles.gestenLinie} /> : <span className={styles.homePunkt} />}</button>
  );
}

/**
 * Error boundary around every app on mobile. Previously a render error in one
 * app (e.g. `x.map is not a function` on unexpected API data) took down the
 * WHOLE mobile shell — empty body, no status bar, no way back.
 * The desktop has had this boundary in its window; here it was missing.
 */
function AppContent(props: { appId: string; windowId: string; forceInline?: boolean }) {
  const manifest = getAppManifest(props.appId);
  return (
    <AppErrorBoundary
      appName={manifest?.name ?? props.appId}
      onClose={() => useWindowsStore.getState().closeWindow(props.windowId)}
    >
      <AppContentInner {...props} />
    </AppErrorBoundary>
  );
}

function AppContentInner({ appId, windowId, forceInline }: { appId: string; windowId: string; forceInline?: boolean }) {
  const Component = appComponents[appId];
  const manifest = getAppManifest(appId);
  const { t } = useTranslation("mobile");
  if (Component) {
    return <Suspense fallback={<div className={styles.loading}>{t("app.loading")}</div>}><Component windowId={windowId} /></Suspense>;
  }
  if (manifest?.type === "selkies") {
    // Mobile streams the mobile-tuned browser twin (SelkiesApp picks the
    // instance via useIsMobile). Breaking out into a native tab would mix the
    // session with the private browser — can be re-enabled per app only via
    // mobileStrategy:"redirect".
    if (manifest.mobileStrategy === "redirect" && manifest.config?.url) {
      return (
        <IframeApp
          appId={appId}
          windowId={windowId}
          url={manifest.config.url}
          title={manifest.name}
        />
      );
    }
    return (
      <SelkiesApp
        appId={appId}
        windowId={windowId}
        targetUrl={manifest.config?.url}
        title={manifest.name}
      />
    );
  }
  if (manifest?.type === "iframe" && manifest.config?.url) {
    return (
      <IframeApp
        appId={appId}
        windowId={windowId}
        url={manifest.config.url}
        title={manifest.name}
        forceFreshAuth={manifest.config?.forceFreshAuth === true}
        forceInline={forceInline}
      />
    );
  }
  return <div className={styles.loading}>{appId}</div>;
}
