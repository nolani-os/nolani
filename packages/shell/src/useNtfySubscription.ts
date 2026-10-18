/**
 * useNtfySubscription — subscribes to the user's ntfy topic via the
 * /api/claraos/ntfy/sse proxy and feeds incoming messages into the
 * ClaraOS notification store (useUIStore.addNotification).
 *
 * Also triggers a native browser Notification if the user granted permission.
 * The hook is idempotent: only one SSE connection is maintained at a time.
 */
import { useEffect, useRef } from "react";
import { useUIStore, useSettingsStore } from "@claraos/core";
import { parseChatDeepLink, parseShellDeepLink } from "./useBootDeepLink";

// Fetch messages from the last 24 h when subscribing (catches today's notifications)
const SSE_SINCE_SECONDS = 86_400;
// Time of the last seen message (ntfy `time`, Unix seconds). On reconnect we
// only catch up from there instead of a blanket 24 h — otherwise every
// connection drop would replay the whole day.
const LAST_SEEN_KEY = "claraos-ntfy-last-seen";
function readLastSeen(): number {
  try {
    const v = Number(localStorage.getItem(LAST_SEEN_KEY));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}
function writeLastSeen(t: number) {
  try {
    if (t > readLastSeen()) localStorage.setItem(LAST_SEEN_KEY, String(t));
  } catch {
    // Storage blocked (private window) — fall back to catching up 24 h.
  }
}
const getSseUrl = () => {
  const dayAgo = Math.floor(Date.now() / 1000) - SSE_SINCE_SECONDS;
  const since = Math.max(dayAgo, readLastSeen());
  return `/api/claraos/ntfy/sse?since=${since}`;
};
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

interface NtfyMessage {
  id?: string;
  time?: number;
  topic?: string;
  title?: string;
  message?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  event?: string;
}

function priorityIcon(priority: number | undefined): string {
  if (!priority) return "🔔";
  if (priority >= 4) return "🚨";
  if (priority === 3) return "🔔";
  return "💬";
}

function requestBrowserPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function showBrowserNotification(title: string, body: string, icon: string) {
  // "Do not disturb" only suppresses the OS browser notification; the in-app
  // shade (useUIStore.addNotification) keeps working. The SERVER-side state
  // notifications.dndUntil is authoritative (as on desktop), so DND applies
  // across devices and expires by itself.
  const notif = useSettingsStore.getState().values["notifications"];
  const dndUntil = typeof notif?.dndUntil === "number" ? notif.dndUntil : 0;
  if (dndUntil > Date.now()) return;
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, { body, icon: icon || "/favicon.ico" });
    } catch {
      // Safari/Firefox may throw in certain contexts
    }
  }
}

export function useNtfySubscription() {
  const addNotification = useUIStore((s) => s.addNotification);
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Exponential backoff — a fixed 5 s retry kept a doom loop alive under ntfy
  // rate limiting (429→500), since every retry consumed exactly the bucket
  // refill rate.
  const backoffRef = useRef(RECONNECT_DELAY_MS);

  useEffect(() => {
    mountedRef.current = true;
    requestBrowserPermission();

    function connect() {
      if (!mountedRef.current) return;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      const es = new EventSource(getSseUrl(), { withCredentials: true });
      esRef.current = es;

      es.onopen = () => {
        backoffRef.current = RECONNECT_DELAY_MS; // success → reset backoff
      };

      es.addEventListener("message", (e) => {
        let msg: NtfyMessage;
        try {
          msg = JSON.parse(e.data) as NtfyMessage;
        } catch {
          return;
        }

        // ntfy sends keepalive events with type "keepalive" — ignore them
        if (msg.event === "keepalive" || msg.event === "open") return;

        const title = msg.title || msg.topic || "ntfy";
        const body = msg.message || "";
        const icon = priorityIcon(msg.priority);
        if (typeof msg.time === "number") writeLastSeen(msg.time);
        // Source id — the store creates the same ntfy message only once
        // (replay after reload/reconnect). Do not bulk-clear the history here:
        // that would make this de-duplication impossible; the store caps
        // itself at 100 entries.
        const sourceId = msg.id ? `ntfy:${msg.id}` : undefined;

        // Translate real ntfy actions (http = e.g. Clara approval yes/no,
        // view = link) into ClaraOS buttons — they arrive in the SSE JSON under
        // msg.actions. They take precedence over the app tag.
        type NtfyAction = { action?: string; label?: string; url?: string; method?: string };
        const ntfyActions = (Array.isArray((msg as { actions?: NtfyAction[] }).actions)
          ? (msg as { actions?: NtfyAction[] }).actions! : [])
          .flatMap((a) => {
            if (a?.action === "http" && a.url) {
              return [{ id: "http", label: a.label || "OK",
                        payload: { url: a.url, method: a.method || "POST" } }];
            }
            if (a?.action === "view" && a.url) {
              return [{ id: "open-url", label: a.label || "Öffnen", payload: { url: a.url } }];
            }
            return [];
          });

        // Tag `claraos-app=<id>` (set server-side via services/ntfy_publish.py)
        // → an "Open" action that launches the app.
        // Defensive: all other notifications stay exactly as they are.
        const appTag = (msg.tags ?? []).find((t) => t.startsWith("claraos-app="));
        const appId = appTag?.slice("claraos-app=".length);

        // In addition to the app tag, an OBJECT target. Convention:
        //   claraos-app=planner  ·  claraos-action=open_task  ·  claraos-arg-task_id=75
        // This way the click lands on the task instead of the app's start page.
        const tags = msg.tags ?? [];
        const objAction = tags.find((t) => t.startsWith("claraos-action="))
          ?.slice("claraos-action=".length);
        const objArgs: Record<string, unknown> = {};
        for (const t of tags) {
          if (!t.startsWith("claraos-arg-")) continue;
          const eq = t.indexOf("=");
          if (eq < 0) continue;
          const key = t.slice("claraos-arg-".length, eq);
          const raw = t.slice(eq + 1);
          if (!key) continue;
          // Numbers as numbers — `open_task` expects a numeric task_id.
          objArgs[key] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
        }

        // Precedence: real object target > ntfy's own actions > app only > nothing.
        // Important: the object target deliberately comes BEFORE the ntfy
        // actions: a sender setting both means the object, and the actions stay
        // as additional buttons.
        if (appId && objAction) {
          addNotification({
            title, body, icon, sourceId,
            actions: [
              { id: "open-object", label: "Öffnen", primary: true,
                payload: { appId, action: objAction, args: objArgs } },
              ...ntfyActions,
            ],
          });
        } else if (ntfyActions.length > 0) {
          addNotification({ title, body, icon, sourceId, actions: ntfyActions });
        } else if (appId) {
          addNotification({
            title, body, icon, sourceId,
            actions: [{ id: "open-window", label: "Öffnen", primary: true, payload: { appId } }],
          });
        } else if (msg.click) {
          // Senders without ClaraOS tags (hypervisors, monitors, third-party services)
          // often only set ntfy's standard `click` field. That is a usable target.
          // If it points at this shell, it becomes an in-shell target
          // (app + optional action) instead of a new tab.
          // `/?chat=<id>` (job finished) leads into that chat.
          const chat = parseChatDeepLink(msg.click);
          const ziel = chat ? null : parseShellDeepLink(msg.click);
          addNotification({
            title, body, icon, sourceId,
            actions: [chat
              ? { id: "open-chat", label: "Zum Chat", primary: true, payload: { chatId: chat.chatId } }
              : ziel
              ? { id: "open-object", label: "Öffnen", primary: true,
                  payload: { appId: ziel.appId, action: ziel.action, args: ziel.args } }
              : { id: "open-url", label: "Öffnen", primary: true, payload: { url: msg.click } }],
          });
        } else {
          addNotification({ title, body, icon, sourceId });
        }
        showBrowserNotification(title, body, icon);
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (!mountedRef.current) return;
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        reconnectRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
  }, [addNotification]);
}
