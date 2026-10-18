/**
 * Anchor manifest for guided tours (guide assistant).
 *
 * Single source of truth for everything a tour may highlight: each anchor ID
 * corresponds to a `data-tour="<id>"` attribute in the shell. The
 * `description` is meant for the LLM driver: the assistant receives ONLY
 * this manifest as its map of the UI — no DOM scraping. Unknown IDs fail at
 * tour start instead of rendering a broken tour.
 *
 * `ensure` establishes the UI state the anchor needs to exist (e.g. opening
 * the start menu) — runs as Joyride `before` hook ahead of the step.
 */
import { useAppRegistryStore, useUIStore, useWindowsStore } from "@claraos/core";
import { ensureFrame } from "./frameTour";

export interface TourAnchor {
  id: string;
  /** For the LLM driver: what is this element, what can you do here? */
  description: string;
  ensure?: () => Promise<void>;
}

export function tourSelector(anchorId: string): string {
  return `[data-tour="${anchorId}"]`;
}

/** Waits until the anchor is in the DOM (after ensure state changes). */
async function waitForAnchor(anchorId: string, timeoutMs = 2500): Promise<void> {
  const sel = tourSelector(anchorId);
  const t0 = Date.now();
  while (!document.querySelector(sel)) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`Tour-Anker nicht gefunden: ${anchorId}`);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function openStartMenu(anchorId: string): Promise<void> {
  useUIStore.setState({ startMenuOpen: true });
  await waitForAnchor(anchorId);
}

async function closeStartMenu(): Promise<void> {
  useUIStore.getState().closeStartMenu();
}

function openAppWindow(appId: string): void {
  useUIStore.getState().closeStartMenu();
  const ws = useWindowsStore.getState();
  const existing = Object.values(ws.windows).find((w) => w.appId === appId);
  if (existing) {
    ws.focusWindow(existing.id);
  } else {
    const app = useAppRegistryStore.getState().getApp(appId);
    ws.openWindow(appId, app
      ? { title: app.name, width: app.window.defaultWidth, height: app.window.defaultHeight }
      : undefined);
  }
}

/** Opens (or focuses) an app window and waits for the anchor inside it. */
function ensureApp(appId: string, anchorId: string): () => Promise<void> {
  return async () => {
    openAppWindow(appId);
    // App windows load lazily — wait longer than for the start menu.
    await waitForAnchor(anchorId, 6000);
  };
}

/** Open settings AND navigate to the module (SettingsShellV2 listens for the event). */
function ensureSettingsModule(module: string, anchorId: string): () => Promise<void> {
  return async () => {
    openAppWindow("settings");
    // Fire the event several times — the settings shell mounts lazily and
    // attaches its listener only after the first render.
    const t0 = Date.now();
    while (!document.querySelector(tourSelector(anchorId))) {
      window.dispatchEvent(new CustomEvent("claraos-settings-tab",
        { detail: { module } }));
      if (Date.now() - t0 > 8000) {
        throw new Error(`Tour-Anker nicht gefunden: ${anchorId}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  };
}

export const TOUR_ANCHORS: Record<string, TourAnchor> = {
  "taskbar-clara": {
    id: "taskbar-clara",
    description:
      "Clara-Knopf links in der Taskleiste: öffnet das Startmenü mit App-Suche und Clara-Chat.",
    ensure: closeStartMenu,
  },
  "taskbar-voice": {
    id: "taskbar-voice",
    description: "Mikrofon-Knopf in der Taskleiste: startet den Sprachmodus, um mit Clara zu sprechen.",
    ensure: closeStartMenu,
  },
  "taskbar-pinned": {
    id: "taskbar-pinned",
    description: "Angepinnte Lieblings-Apps in der Taskleiste — ein Klick öffnet die App.",
    ensure: closeStartMenu,
  },
  "taskbar-tray": {
    id: "taskbar-tray",
    description:
      "System-Bereich rechts: Schnelleinstellungen (Zahnrad), Lautstärke, je nach Gerät Netzwerk/Akku, Benachrichtigungen (Glocke), Uhr/Kalender.",
    ensure: closeStartMenu,
  },
  // Only the gear gets its own anchor — it is the only tray element that is
  // GUARANTEED to exist. Cap-dependent buttons (network/battery) deliberately
  // only carry data-tray-item, no data-tour: an anchor that may be missing
  // breaks the tour start.
  "tray-quick-settings": {
    id: "tray-quick-settings",
    description:
      "Zahnrad in der Taskleiste: Schnelleinstellungen mit Nicht-stören, Theme, Datenträgern und Abmelden (Win+A).",
    ensure: closeStartMenu,
  },
  "startmenu-input": {
    id: "startmenu-input",
    description:
      "Eingabefeld im Startmenü: Apps suchen und starten ODER Clara direkt eine Frage stellen.",
    ensure: () => openStartMenu("startmenu-input"),
  },
  "startmenu-pinned": {
    id: "startmenu-pinned",
    description: "Angepinnte Apps im Startmenü — die wichtigsten Apps auf einen Blick.",
    ensure: () => openStartMenu("startmenu-pinned"),
  },
  // ── Files app (desktop layout; opens the window itself if needed) ──
  "files-sidebar": {
    id: "files-sidebar",
    description:
      "Seitenleiste der Files-App: Orte und Quellen (eigene Dateien, Familien-Ablage, NAS).",
    ensure: ensureApp("files", "files-sidebar"),
  },
  "files-content": {
    id: "files-content",
    description: "Hauptbereich der Files-App: Ordner und Dateien; Dateien hierher ziehen = hochladen.",
    ensure: ensureApp("files", "files-content"),
  },
  "files-search": {
    id: "files-search",
    description: "Suchfeld der Files-App: tippen filtert, Enter durchsucht auch Unterordner.",
    ensure: ensureApp("files", "files-search"),
  },
  "files-new-folder": {
    id: "files-new-folder",
    description: "Knopf 'Neuer Ordner' in der Files-Toolbar.",
    ensure: ensureApp("files", "files-new-folder"),
  },
  // ── Photos app (Immich, third-party app in an iframe — bridge spotlight with
  //    automatic frame fallback; selectors are href-based = locale-stable) ──
  "immich-frame": {
    id: "immich-frame",
    description: "Die ganze Fotos-App (Immich) — öffnet das Fenster automatisch.",
    ensure: ensureFrame("immich", null, "immich-frame"),
  },
  "immich-photos": {
    id: "immich-photos",
    description: "Navigation „Fotos“ in der Fotos-App: die Zeitleiste aller Aufnahmen.",
    ensure: ensureFrame("immich", 'a[href="/photos"]', "immich-photos"),
  },
  "immich-albums": {
    id: "immich-albums",
    description: "Navigation „Alben“ in der Fotos-App.",
    ensure: ensureFrame("immich", 'a[href="/albums"]', "immich-albums"),
  },
  // ── Settings (phone push module for the device setup tour) ──
  "settings-push": {
    id: "settings-push",
    description:
      "Handy-Push-Bereich in den Einstellungen: QR-Code + Zugangsdaten, um ClaraOS " +
      "und Benachrichtigungen auf dem Handy einzurichten. Öffnet sich automatisch.",
    ensure: ensureSettingsModule("mobile-push", "settings-push"),
  },
  /** Virtual anchor: centered overlay without spotlight (intro/outro). */
  center: {
    id: "center",
    description: "Zentrierte Dialogbox ohne hervorgehobenes Element (Einleitung/Abschluss).",
  },
};
