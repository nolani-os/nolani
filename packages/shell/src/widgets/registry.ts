import { lazy, type LazyExoticComponent, type ComponentType } from "react";
import type { WidgetManifest } from "@claraos/core";

export interface WidgetProps {
  widgetId: string;
  config?: Record<string, unknown>;
  /** True while the widget is being dragged — content clicks early-return so a
   *  drag never triggers an inline action. Provided by MobileWidgetFrame. */
  guardRef?: { current: boolean };
  /** Open the widget's associated app (its ⚙ / row-tap). Pre-bound by the
   *  frame to the right appId; MobileShell stays the single launcher. */
  onOpenApp?: () => void;
}

const ClockWeatherWidget = lazy(() => import("./ClockWeatherWidget"));
const SystemStatsWidget = lazy(() => import("./SystemStatsWidget"));
const ClaraQuickWidget = lazy(() => import("./ClaraQuickWidget"));
const FlipClockWeatherWidget = lazy(() => import("./FlipClockWeatherWidget"));
const CalendarAgendaWidget = lazy(() => import("./CalendarAgendaWidget"));
const TasksWidget = lazy(() => import("./TasksWidget"));
const PhotoFrameWidget = lazy(() => import("./PhotoFrameWidget"));
const StickyNoteWidget = lazy(() => import("./StickyNoteWidget"));
const MailInboxWidget = lazy(() => import("./MailInboxWidget"));
const IdeaCaptureWidget = lazy(() => import("./IdeaCaptureWidget"));

/** Widget components keyed by widget type. Lazy-loaded to keep startup small. */
export const widgetComponents: Record<
  string,
  LazyExoticComponent<ComponentType<WidgetProps>>
> = {
  "clock-weather": ClockWeatherWidget,
  "system-stats": SystemStatsWidget,
  "clara-quick": ClaraQuickWidget,
  "flip-clock-weather": FlipClockWeatherWidget,
  "calendar-agenda": CalendarAgendaWidget,
  "nc-tasks": TasksWidget,
  "photo-frame": PhotoFrameWidget,
  "sticky-note": StickyNoteWidget,
  "mail-inbox": MailInboxWidget,
  "idea-capture": IdeaCaptureWidget,
};

/** Manifests power the "Add widget" picker and surface defaults to the store. */
export const widgetManifests: Record<string, WidgetManifest> = {
  "flip-clock-weather": {
    id: "flip-clock-weather",
    name: "Uhr & Wetter",
    description: "Flip-Uhr mit aktuellem Wetter und 5-Tage-Vorschau",
    icon: "🕑",
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 4, h: 2 },
    maxSize: { w: 4, h: 3 },
    permissions: ["network.weather"],
  },
  "clock-weather": {
    id: "clock-weather",
    name: "Uhr kompakt",
    description: "Uhrzeit, Datum und aktuelles Wetter auf einen Blick",
    icon: "⏰",
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 6, h: 3 },
    permissions: ["network.weather"],
  },
  "calendar-agenda": {
    id: "calendar-agenda",
    name: "Kalender",
    description: "NC-Kalender: Agenda & Monat, Termine anlegen/bearbeiten",
    icon: "📅",
    hasSettings: true,
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 7 },
    permissions: ["nextcloud.calendar"],
  },
  // The type id stays "nc-tasks" (it is stored in saved layouts); the data
  // source is now the ClaraOS Planner instead of Nextcloud Tasks.
  "nc-tasks": {
    id: "nc-tasks",
    name: "Aufgaben",
    description: "Offene Aufgaben aus dem ClaraOS-Planner — abhakbar, zeigt woran Clara arbeitet",
    icon: "✅",
    hasSettings: true,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 5, h: 6 },
    permissions: ["planner.tasks"],
  },
  "photo-frame": {
    id: "photo-frame",
    name: "Fotorahmen",
    description: "Diashow aus deinen Immich-Alben — Zuschnitt, Ken-Burns, Uhr",
    icon: "🖼️",
    hasSettings: true,
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 8, h: 6 },
    permissions: ["nextcloud.files"],
  },
  "sticky-note": {
    id: "sticky-note",
    name: "Notiz",
    description: "Haftnotiz auf dem Desktop — Text bleibt gespeichert",
    icon: "📝",
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 5, h: 5 },
    permissions: [],
  },
  "mail-inbox": {
    id: "mail-inbox",
    name: "Posteingang",
    description: "Neueste E-Mails deines Familien-Postfachs",
    icon: "📬",
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 6, h: 6 },
    permissions: ["mail.read"],
  },
  "system-stats": {
    id: "system-stats",
    name: "System-Monitor",
    description: "Server, VMs und Geräte — Ziele wählbar, mit Verlauf",
    icon: "📊",
    hasSettings: true,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 6, h: 7 },
    permissions: ["system.stats"],
  },
  "idea-capture": {
    id: "idea-capture",
    name: "Ideen-Blitz",
    description: "Idee in einer Zeile festhalten — Clara denkt direkt mit",
    icon: "💡",
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 6, h: 2 },
    permissions: [],
  },
  "clara-quick": {
    id: "clara-quick",
    name: "Clara Schnellchat",
    description: "Clara direkt vom Desktop aus fragen",
    icon: "✨",
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 8, h: 6 },
    permissions: ["clara.chat"],
  },
};

export function getWidgetManifest(type: string): WidgetManifest | undefined {
  return widgetManifests[type];
}

/** Tapping/⚙ on a widget opens its associated app (null = no app to open).
 *  Ids verified against api/app_seeds.py; guarded with getApp() at the call
 *  site so a missing id is a silent no-op. Shared by desktop + mobile. */
export const WIDGET_OPEN_APP: Record<string, string | null> = {
  "flip-clock-weather": null,
  "clock-weather": null,
  "calendar-agenda": "nextcloud-calendar",
  "nc-tasks": "planner", // tasks widget → ClaraOS Planner
  "photo-frame": "immich",
  "sticky-note": null,
  "mail-inbox": null, // no webmail tile (Stalwart is IMAP-only)
  "system-stats": "task-manager",
  "clara-quick": null,
  "idea-capture": "ideas",
};

/** Widgets of this installation (optional
 *  heim/widgets/registry.ts). Its manifests are inserted into the picker order right
 *  after the widget named by `after`; `manifestOverrides` replace single fields. */
interface HeimWidgets {
  after?: string;
  components?: Record<string, LazyExoticComponent<ComponentType<WidgetProps>>>;
  manifests?: Record<string, WidgetManifest>;
  manifestOverrides?: Record<string, Partial<WidgetManifest>>;
  openApp?: Record<string, string | null>;
}
for (const mod of Object.values(
  import.meta.glob<{ heimWidgets?: HeimWidgets }>("../heim/widgets/registry.ts", { eager: true }),
)) {
  const h = mod.heimWidgets;
  if (!h) continue;
  Object.assign(widgetComponents, h.components ?? {});
  Object.assign(WIDGET_OPEN_APP, h.openApp ?? {});
  for (const [id, patch] of Object.entries(h.manifestOverrides ?? {})) {
    if (widgetManifests[id]) widgetManifests[id] = { ...widgetManifests[id], ...patch };
  }
  const merged: Record<string, WidgetManifest> = {};
  let inserted = false;
  for (const [id, m] of Object.entries(widgetManifests)) {
    merged[id] = m;
    if (id === h.after) { Object.assign(merged, h.manifests ?? {}); inserted = true; }
  }
  if (!inserted) Object.assign(merged, h.manifests ?? {});
  for (const id of Object.keys(widgetManifests)) delete widgetManifests[id];
  Object.assign(widgetManifests, merged);
}

// --- Mobile homescreen widgets (One-UI style) ---

/** Widget types offered by the mobile homescreen picker. */
export const MOBILE_WIDGET_TYPES = ["flip-clock-weather", "calendar-agenda", "nc-tasks", "photo-frame", "sticky-note", "mail-inbox", "idea-capture"] as const;

/** Emoji used for the mobile picker preview + drag ghost. */
export const MOBILE_WIDGET_EMOJI: Record<string, string> = {
  "flip-clock-weather": "🕑",
  "calendar-agenda": "📅",
  "nc-tasks": "✅",
  "photo-frame": "🖼️",
  "sticky-note": "📝",
  "mail-inbox": "📬",
};

/** @deprecated alias — desktop + mobile share WIDGET_OPEN_APP. */
export const MOBILE_WIDGET_OPEN_APP = WIDGET_OPEN_APP;
