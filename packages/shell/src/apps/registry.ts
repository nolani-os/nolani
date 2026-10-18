import { lazy } from "react";
import { useAppRegistryStore } from "@claraos/core";
import type { AppManifest } from "@claraos/core";

// Lazy-loaded app components
const SettingsApp = lazy(() => import("./settings/SettingsApp"));
const FileBrowserApp = lazy(() => import("./file-browser/FileBrowserApp"));
const TextEditorApp = lazy(() => import("./text-editor/TextEditorApp"));
const PdfViewerApp = lazy(() => import("./pdf-viewer/PdfViewerApp"));
const ImageViewerApp = lazy(() => import("./image-viewer/ImageViewerApp"));
const VideoPlayerApp = lazy(() => import("./video-player/VideoPlayerApp"));
const UserAdminApp = lazy(() => import("./user-admin/UserAdminApp"));
const TeamsApp = lazy(() => import("./teams/TeamsApp"));
const TaskManagerApp = lazy(() => import("./task-manager/TaskManagerApp"));
const PlannerApp = lazy(() => import("./planner/PlannerApp"));
// Knowledge Suite and Idea/Strategy Suite are ONE app ("Wissen").
// Both ids remain — they only select the start section, so existing deep
// links (`?app=ideas`, ntfy, Clara) keep working.
const WissenApp = lazy(() => import("./wissen/WissenApp"));
const StrategieEntry = lazy(() => import("./wissen/StrategieEntry"));
const OfficeViewerApp = lazy(() => import("./office-viewer/OfficeViewerApp"));
// Contacts — ClaraOS owns the data itself (superset); external formats are
// projections. Not to be confused with Nextcloud's address book.
const KontakteApp = lazy(() => import("./kontakte/KontakteApp"));
// Post — native mail client (JMAP proxy in the API).
const PostApp = lazy(() => import("./post/PostApp"));
// Services — tiles for third-party sites, opened in the user's own streamed browser.
const ServicesHubApp = lazy(() => import("./services-hub/ServicesHubApp"));
// Routines — recurring tasks for Clara (cells; the API decides where it is offered).
const RoutinenApp = lazy(() => import("./clara-routinen/RoutinenApp"));

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
