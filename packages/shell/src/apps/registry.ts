import { lazy, type ComponentType } from "react";
import { useAppRegistryStore, i18n } from "@claraos/core";
import type { AppManifest } from "@claraos/core";

/**
 * Lazy app whose texts live in their own catalog namespace: the namespace is
 * loaded together with the code, so the window never renders raw keys.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyWithTexts<T extends ComponentType<any>>(ns: string | string[], load: () => Promise<{ default: T }>) {
  return lazy(() => Promise.all([load(), i18n.loadNamespaces(ns).catch(() => undefined)]).then(([m]) => m));
}

// Lazy-loaded app components
const SettingsApp = lazy(() => import("./settings/SettingsApp"));
const FileBrowserApp = lazyWithTexts("files", () => import("./file-browser/FileBrowserApp"));
const TextEditorApp = lazyWithTexts("textEditor", () => import("./text-editor/TextEditorApp"));
const PdfViewerApp = lazyWithTexts("viewers", () => import("./pdf-viewer/PdfViewerApp"));
const ImageViewerApp = lazyWithTexts("imageViewer", () => import("./image-viewer/ImageViewerApp"));
const VideoPlayerApp = lazyWithTexts("viewers", () => import("./video-player/VideoPlayerApp"));
const UserAdminApp = lazyWithTexts("userAdmin", () => import("./user-admin/UserAdminApp"));
// Teams embeds the planner calendar, so it needs the planner texts too.
const TeamsApp = lazyWithTexts(["planner", "teams"], () => import("./teams/TeamsApp"));
const TaskManagerApp = lazyWithTexts("taskManager", () => import("./task-manager/TaskManagerApp"));
const PlannerApp = lazyWithTexts("planner", () => import("./planner/PlannerApp"));
// Knowledge Suite and Idea/Strategy Suite are ONE app ("Wissen").
// Both ids remain — they only select the start section, so existing deep
// links (`?app=ideas`, ntfy, Clara) keep working.
const WissenApp = lazyWithTexts("wissen", () => import("./wissen/WissenApp"));
const StrategieEntry = lazyWithTexts("wissen", () => import("./wissen/StrategieEntry"));
const OfficeViewerApp = lazyWithTexts("viewers", () => import("./office-viewer/OfficeViewerApp"));
// Contacts — ClaraOS owns the data itself (superset); external formats are
// projections. Not to be confused with Nextcloud's address book.
const KontakteApp = lazyWithTexts("kontakte", () => import("./kontakte/KontakteApp"));
// Post — native mail client (JMAP proxy in the API).
const PostApp = lazyWithTexts("post", () => import("./post/PostApp"));
// Services — tiles for third-party sites, opened in the user's own streamed browser.
const ServicesHubApp = lazyWithTexts("servicesHub", () => import("./services-hub/ServicesHubApp"));
// Routines — recurring tasks for Clara (cells; the API decides where it is offered).
const RoutinenApp = lazyWithTexts("claraRoutines", () => import("./clara-routinen/RoutinenApp"));

// Map appId → lazy React component (for internal apps)
export const appComponents: Record<string, React.LazyExoticComponent<React.ComponentType<{ windowId: string }>>> = {
  settings: SettingsApp,
  files: FileBrowserApp,
  "text-editor": TextEditorApp,
  "pdf-viewer": PdfViewerApp,
  "image-viewer": ImageViewerApp,
  "video-player": VideoPlayerApp,
  "user-admin": UserAdminApp,
  "teams-workspace": TeamsApp,
  teams: TeamsApp,  // alias — historic shortcut id used by some entry points
  "task-manager": TaskManagerApp,
  planner: PlannerApp,
  ideas: StrategieEntry,
  knowledge: WissenApp,
  "office-viewer": OfficeViewerApp,
  kontakte: KontakteApp,
  post: PostApp,
  "services-hub": ServicesHubApp,
  "clara-routinen": RoutinenApp,
};

// Site-specific apps live in registry.heim.ts. The glob is empty when that file
// is missing, so the build does not depend on it.
const homeRegistries = import.meta.glob<{ heimAppComponents: typeof appComponents }>(
  "./registry.heim.ts", { eager: true },
);
for (const mod of Object.values(homeRegistries)) Object.assign(appComponents, mod.heimAppComponents);

/* Removed: several unused widget apps.
 *
 * They were listed here but had **no entry in `claraos_apps`** and were opened
 * from **nowhere in the code** (0 hits for `openWindow`), so nobody could
 * reach them — not even via a deep link, which looks the id up in the catalog.
 *
 * Important: an entry HERE does not make an app reachable. It also needs a
 * catalog entry (`claraos_apps`) — otherwise you get exactly this kind of dead
 * code: source that is maintained and translated but never shown to anyone.
 *
 * The components were deleted (the whole `apps/mcp/` folder) together with
 * `GmailApp`, `GContactsApp` and `GCalendarApp`, which were never registered,
 * and the shared stylesheet `McpApp.module.css`.
 * To restore them: `git show <commit>^:<path>` — and then add both an entry
 * here AND one in the catalog.
 */

/** Get manifest by appId from the app registry store */
export function getAppManifest(appId: string): AppManifest | undefined {
  return useAppRegistryStore.getState().getApp(appId);
}
