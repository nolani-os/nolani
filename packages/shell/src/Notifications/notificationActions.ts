import { i18n, useAppRegistryStore, useUIStore, useWindowsStore } from "@claraos/core";
import type { Notification, NotificationAction } from "@claraos/core";
import { dispatchWhenReady } from "../Chat/actionBus";
import { openClaraChat, parseChatDeepLink, parseShellDeepLink } from "../useBootDeepLink";

/**
 * The action triggered by a tap/click on the notification itself (also used in
 * the mobile shade): preferably the one marked `primary`, otherwise the first
 * one that leads somewhere. `dismiss`/`mark-read`/`snooze`/`http` do not
 * count — otherwise clicking the notification would dismiss it instead of
 * opening it.
 */
const NON_NAVIGATING = new Set(["dismiss", "mark-read", "snooze", "http"]);
export function primaryAction(n: Notification): NotificationAction | undefined {
  const usable = (n.actions ?? []).filter((a) => !NON_NAVIGATING.has(a.id));
  return usable.find((a) => a.primary) ?? usable[0];
}

/**
 * The mobile shell only shows a window when its view is set to "app" —
 * otherwise opening from the shade stayed invisible behind the panel. This
 * event tells it: "there is a target now, show it".
 */
export const NOTIF_NAVIGATED_EVENT = "claraos:notification-navigated";

/** Bring the app's window to the front or open it — never a second window of the same app. */
function showApp(appId: string, opts: Record<string, unknown> = {}) {
  const ws = useWindowsStore.getState();
  const existing = Object.values(ws.windows).find((w) => w.appId === appId);
  if (existing) ws.focusWindow(existing.id);
  else ws.openWindow(appId, opts);
  window.dispatchEvent(new CustomEvent(NOTIF_NAVIGATED_EVENT, { detail: { appId } }));
}

/** Open the target app and, if given, jump to the action (object). */
function openInShell(appId: string, action: string | undefined, args: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  // Important: only real apps get a window. `shell` (and other handlers without
  // their own app) are valid targets, but `openWindow("shell")` would otherwise
  // create an empty window for an app that does not exist in the registry.
  if (useAppRegistryStore.getState().getApp(appId)) showApp(appId, opts);
  if (action) dispatchWhenReady(appId, action, args);
}

/**
 * Click on a system notification of the Companion app. The app passes ntfy's
 * `click` URL in as `claraos:companion-notification-click`; the shell's own
 * targets (`?app=…&do=…`) take the same path as "Open".
 * Foreign URLs are deliberately NOT opened — a click on the system popup
 * should only lead into ClaraOS, never load a foreign page unasked.
 */
export const COMPANION_NOTIFICATION_CLICK_EVENT = "claraos:companion-notification-click";

export function oeffneShellZiel(url: string): boolean {
  const chat = parseChatDeepLink(url);
  if (chat) {
    openClaraChat(chat.chatId);
    return true;
  }
  const ziel = parseShellDeepLink(url);
  if (!ziel) return false;
  openInShell(ziel.appId, ziel.action, ziel.args);
  return true;
}

/**
 * Notification action handlers — referenced by ID from `Notification.actions`.
 * Schema is JSON-serializable so notifications can be persisted/synced;
 * the UI layer maps action.id -> the function below at render time.
 *
 * To add a new action: register a key here, then any caller doing
 * addNotification() can include `actions: [{ id: "open-window", ... }]`.
 */
export type NotificationActionHandler = (
  notification: Notification,
  action: NotificationAction,
) => void;

export const notificationActions: Record<string, NotificationActionHandler> = {
  "open-window": (_n, action) => {
    const appId = action.payload?.appId as string | undefined;
    if (!appId) return;
    const opts = (action.payload?.opts as Record<string, unknown>) ?? {};
    // A tag pointing to an app that does not exist (e.g. a removed app) used to create
    // an empty window. Now: do nothing, but log it visibly.
    if (!useAppRegistryStore.getState().getApp(appId)) { console.warn("[notif-action] unbekannte App", appId); return; }
    showApp(appId, opts);
  },

  /**
   * Open the app AND jump to the referenced object (task, project, file …).
   * `open-window` only gets you to the app's start page — for a notification
   * "Task X due" you would then have to search yourself.
   *
   * payload: { appId, action, args?, opts? }
   */
  "open-object": (_n, action) => {
    const appId = action.payload?.appId as string | undefined;
    if (!appId) return;
    const opts = (action.payload?.opts as Record<string, unknown>) ?? {};
    const target = action.payload?.action as string | undefined;
    const args = (action.payload?.args as Record<string, unknown>) ?? {};
    openInShell(appId, target, args, opts);
  },

  /** Open the Clara chat — payload.chatId opens that chat (job notifications). */
  "open-chat": (_n, action) => {
    const chatId = action.payload?.chatId;
    openClaraChat(typeof chatId === "string" ? chatId : undefined);
  },

  "focus-window": (_n, action) => {
    const winId = action.payload?.windowId as string | undefined;
    if (!winId) return;
    useWindowsStore.getState().focusWindow(winId);
    window.dispatchEvent(new CustomEvent(NOTIF_NAVIGATED_EVENT, { detail: { windowId: winId } }));
  },

  "mark-read": (n) => {
    useUIStore.getState().markRead(n.id);
  },

  "dismiss": (n) => {
    // Equivalent to mark-read in current model — both remove from unread badge
    useUIStore.getState().markRead(n.id);
  },

  "open-url": (_n, action) => {
    const url = action.payload?.url as string | undefined;
    if (!url) return;
    // Run the shell's own URLs (`?app=…&do=…`) in the running shell instead of
    // a new tab — in the Companion WebView `window.open` had no effect, and on
    // desktop it created a second ClaraOS.
    if (oeffneShellZiel(url)) return;
    window.open(url, "_blank", "noopener,noreferrer");
  },

  // Fire ntfy http actions (e.g. Clara approvals "Yes/No") directly from the
  // ClaraOS notification — previously these buttons only existed in the ntfy
  // app, and in ClaraOS the click ended in "app confirm has no component".
  "http": (_n, action) => {
    const url = action.payload?.url as string | undefined;
    if (!url) return;
    const method = ((action.payload?.method as string) || "POST").toUpperCase();
    fetch(url, { method })
      .then((r) => {
        useUIStore.getState().addNotification({
          title: r.ok
            ? i18n.t("shell:notifications.http.sentTitle")
            : i18n.t("shell:notifications.http.errorTitle", { status: r.status }),
          body: r.ok
            ? i18n.t("shell:notifications.http.done", { label: action.label })
            : i18n.t("shell:notifications.http.failed", { label: action.label }),
          icon: r.ok ? "✅" : "⚠️",
        });
      })
      .catch(() => {
        useUIStore.getState().addNotification({
          title: i18n.t("shell:notifications.http.unreachableTitle"),
          body: i18n.t("shell:notifications.http.unreachable", { label: action.label }),
          icon: "⚠️",
        });
      });
  },

  "snooze": (n, action) => {
    const minutes = (action.payload?.minutes as number | undefined) ?? 10;
    // Mark current as read; re-add a copy after `minutes`
    useUIStore.getState().markRead(n.id);
    setTimeout(() => {
      useUIStore.getState().addNotification({
        title: n.title,
        body: n.body,
        icon: n.icon,
        actions: n.actions,
      });
    }, minutes * 60_000);
  },
};

export function runNotificationAction(
  notification: Notification,
  action: NotificationAction,
  opts: { keepUnread?: boolean } = {},
) {
  const handler = notificationActions[action.id];
  if (handler) {
    try { handler(notification, action); } catch (e) { console.error("[notif-action]", e); }
  } else {
    console.warn("[notif-action] no handler for", action.id);
  }
  // Marking read is the implicit "I've dealt with this" semantic.
  // On mobile, Android logic applies — a tap only opens, deletion happens
  // exclusively by swipe (`keepUnread`).
  if (opts.keepUnread) return;
  if (action.id !== "snooze" && action.id !== "open-url") {
    useUIStore.getState().markRead(notification.id);
  }
}
