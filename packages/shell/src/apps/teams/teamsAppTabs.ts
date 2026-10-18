/**
 * ClaraOS apps as channel tabs (adding further ClaraOS apps as tabs).
 *
 * Warning: deliberately NOT the whole registry is offered. Putting an app into
 * a tab means mounting it a second time — next to its own window. Only apps
 * that keep their state locally can handle that. The exclusions are measured,
 * not guessed:
 *
 *  - **Files** (`files`): `useFileStore` is a global singleton with tabs and a
 *    split view. Two instances push each other through the folders ("one
 *    property, one writer"). The Teams app has its own lean files tab instead.
 *  - **Teams itself**: a Teams tab showing the Teams app.
 *  - **Viewers** (pdf/image/video/office/model/text-editor): they read path and
 *    source from the window record. Without an open file they show nothing —
 *    pointless as a tab.
 *  - **Terminal / coding starter / wrapp apps**: their session is tied to the
 *    window (Docker exec or Selkies stream). A second mount opens a second
 *    session.
 *  - **Settings, user admin, network, app center**: system maintenance, not
 *    channel content.
 *
 * Permissions: the selection is intersected with the **signed-in user's
 * catalog** (`useAppRegistryStore` only loads what they may see). This list is
 * a suitability decision, not an access decision — a tile is not a permission,
 * and the intersection happens on the server.
 */

/** Apps that can safely be mounted a second time. */
const heimConfig = import.meta.glob<{ TEAMS_EINBETTBARE_APPS?: string[] }>("../../heim.config.ts", { eager: true });

export const EINBETTBARE_APPS: string[] = [
  "planner",
  "knowledge",   // "Knowledge"
  "ideas",       // strategy entry point of the same app
  "kontakte",
  "post",
  "routines",
  "assistants",
  "services-hub",
  "task-manager",
  "agents-monitor",
  // Site-specific apps (optional heim.config.ts)
  ...(Object.values(heimConfig)[0]?.TEAMS_EINBETTBARE_APPS ?? []),
];

/** Tab ID ↔ app ID. `app:` keeps them apart from `custom:` (web address)
 *  and the fixed tabs. */
export const APP_TAB_PREFIX = "app:";

export function istAppReiter(tabId: string): boolean {
  return tabId.startsWith(APP_TAB_PREFIX);
}

export function appIdAusReiter(tabId: string): string {
  return tabId.slice(APP_TAB_PREFIX.length);
}
