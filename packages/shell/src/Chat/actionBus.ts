/**
 * useActionBus — single WS connection that listens for backend-pushed actions
 * targeted at the current user, and dispatches each to a per-app handler.
 *
 * Mounted once at Shell-level. Apps register handlers by calling
 * `registerActionHandler(appId, fn)` on mount. On disconnect (browser tab
 * closed, server restart) the bus auto-reconnects with exponential backoff.
 *
 * Action payload (from claraos-api/routers/actions.py):
 *
 *     { type: "action", app_id, action, args, instance_id?, window_id?, ts }
 *
 * Handler signature: `(action: string, args: object, payload: full message)`.
 */
import { useEffect, useRef } from "react";

export interface ActionPayload {
  type: "action" | "hello" | "pong";
  /** ID for the result acknowledgement. Missing for local actions. */
  action_id?: string;
  app_id?: string;
  action?: string;
  args?: Record<string, unknown>;
  instance_id?: string | null;
  window_id?: string | null;
  from?: string;
  user?: string;
  ts?: number;
}

export type ActionHandler = (
  action: string,
  args: Record<string, unknown>,
  payload: ActionPayload,
) => void;

const handlers = new Map<string, Set<ActionHandler>>();
const fallbackHandlers = new Set<ActionHandler>();

/**
 * The current connection — module-wide, so `meldeErgebnis` can acknowledge
 * from anywhere without being passed down through the React tree.
 */
let verbindung: WebSocket | null = null;

/**
 * Acknowledge what an action actually did.
 *
 * Why this is needed: `/dispatch` only answered with `delivered: N` — the
 * number of browsers reached. Clara read that as "the user sees it" and
 * reported "done!" in chat repeatedly, while in reality an empty window
 * saying "App browser has no registered component" was on screen.
 */
export function meldeErgebnis(payload: ActionPayload, ok: boolean, detail: string): void {
  const id = payload?.action_id;
  if (!id) return;                 // local action — nobody is waiting for it
  if (!verbindung || verbindung.readyState !== WebSocket.OPEN) return;
  try {
    verbindung.send(JSON.stringify({ type: "ack", action_id: id, ok, detail }));
  } catch (err) {
    console.warn("[actionBus] ack fehlgeschlagen", err);
  }
}

/** Register a handler for a given `app_id`. Returns an unsubscribe fn. */
export function registerActionHandler(appId: string, handler: ActionHandler): () => void {
  const set = handlers.get(appId) ?? new Set();
  set.add(handler);
  handlers.set(appId, set);
  return () => {
    set.delete(handler);
    if (set.size === 0) handlers.delete(appId);
  };
}

/**
 * Register a fallback handler that runs when no specific app_id handler
 * matched. Used by the iframe-bridge to forward generic actions to whichever
 * iframe is currently registered for the target window.
 */
export function registerFallbackActionHandler(handler: ActionHandler): () => void {
  fallbackHandlers.add(handler);
  return () => {
    fallbackHandlers.delete(handler);
  };
}

function dispatch(payload: ActionPayload): void {
  if (payload.type !== "action") return;
  const appId = payload.app_id;
  const action = payload.action;
  if (!appId || !action) return;
  const set = handlers.get(appId);
  if (set && set.size > 0) {
    set.forEach((h) => {
      try {
        h(action, payload.args ?? {}, payload);
      } catch (err) {
        console.error("[actionBus] handler threw", err);
      }
    });
    return;
  }
  // Fall back: any subscribers (e.g. iframe-bridge) get a chance to forward.
  if (fallbackHandlers.size > 0) {
    fallbackHandlers.forEach((h) => {
      try {
        h(action, payload.args ?? {}, payload);
      } catch (err) {
        console.error("[actionBus] fallback threw", err);
      }
    });
    meldeErgebnis(payload, true, `An ${appId} weitergereicht (die App meldet selbst nichts zurueck).`);
    return;
  }
  console.debug("[actionBus] no handler for app", appId, "action", action);
  meldeErgebnis(payload, false,
    `Keine App "${appId}" haengt gerade am Aktionsbus — die Aktion "${action}" ist verpufft.`);
}

/**
 * Trigger the same action from the UI, without the round trip through the
 * server. This lets one app open another directly — e.g. a goal's action
 * plan opening the matching planner project.
 *
 * Deliberately via the existing bus instead of sessionStorage: the app-side
 * handlers (`planner.open_project` etc.) already exist and also work when the
 * target window is already open — a session-storage key is only read on
 * remount and is otherwise silently lost.
 */
export function dispatchLocalAction(
  appId: string,
  action: string,
  args: Record<string, unknown> = {},
): void {
  dispatch({ type: "action", app_id: appId, action, args, ts: Date.now() });
}

/** Has the app registered a handler yet? (= is it mounted) */
export function hasActionHandler(appId: string): boolean {
  return (handlers.get(appId)?.size ?? 0) > 0;
}

/**
 * Send an action as soon as the target app is ready.
 *
 * Why not `setTimeout(…, 150)` as before: that only works if the app is
 * already loaded in memory. When the call comes from a notification or a
 * deep link, the page is often **cold** — the app is lazy-loaded and takes
 * seconds. At that moment the bus has no handler yet, the action is lost
 * **silently** (only a `console.debug`), and the user lands in the app but
 * not at the object. So we actively wait for the handler instead of guessing.
 *
 * Returns a cancel function.
 */
export function dispatchWhenReady(
  appId: string,
  action: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
): () => void {
  if (hasActionHandler(appId)) {
    dispatchLocalAction(appId, action, args);
    return () => {};
  }
  const started = Date.now();
  const timer = setInterval(() => {
    if (hasActionHandler(appId)) {
      clearInterval(timer);
      dispatchLocalAction(appId, action, args);
    } else if (Date.now() - started > timeoutMs) {
      clearInterval(timer);
      console.warn("[actionBus] App", appId, "kam nicht — Aktion", action, "verworfen");
    }
  }, 100);
  return () => clearInterval(timer);
}

export interface UseActionBusOptions {
  /** Override the WS path (default `/api/claraos/actions/ws`). */
  url?: string;
  /** Pause/resume the connection externally. Default true. */
  enabled?: boolean;
}

export function useActionBus(options: UseActionBusOptions = {}): void {
  const { url = "/api/claraos/actions/ws", enabled = true } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);
  const reconnectAttemptRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    cancelledRef.current = false;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}${url}`;

    const connect = () => {
      if (cancelledRef.current) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        console.warn("[actionBus] WS construct failed", err);
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        verbindung = ws;
        console.debug("[actionBus] connected");
      };
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as ActionPayload;
          dispatch(data);
        } catch (err) {
          console.warn("[actionBus] bad message", ev.data, err);
        }
      };
      ws.onerror = () => {
        // ignore; close handler will trigger reconnect
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (verbindung === ws) verbindung = null;
        if (!cancelledRef.current) scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      const attempt = ++reconnectAttemptRef.current;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      setTimeout(() => {
        if (!cancelledRef.current) connect();
      }, delay);
    };

    connect();

    // Periodic ping so proxies don't kill idle connections (every 30s)
    const pingTimer = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* will reconnect on close */
        }
      }
    }, 30_000);

    // "This device is in front": the API opens pages in the browser twin of the
    // shell the user is actually looking at (phone vs. desktop both connected).
    let zuletztGemeldet = 0;
    const imVordergrund = () => {
      const ws = wsRef.current;
      const jetzt = Date.now();
      if (jetzt - zuletztGemeldet < 10_000) return; // a tap storm needs one report
      if (document.visibilityState === "visible" && ws && ws.readyState === WebSocket.OPEN) {
        zuletztGemeldet = jetzt;
        try {
          ws.send(JSON.stringify({ type: "aktiv" }));
        } catch {
          /* will reconnect on close */
        }
      }
    };
    document.addEventListener("visibilitychange", imVordergrund);
    window.addEventListener("focus", imVordergrund);
    window.addEventListener("pointerdown", imVordergrund, { passive: true });

    return () => {
      cancelledRef.current = true;
      clearInterval(pingTimer);
      document.removeEventListener("visibilitychange", imVordergrund);
      window.removeEventListener("focus", imVordergrund);
      window.removeEventListener("pointerdown", imVordergrund);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [url, enabled]);
}
