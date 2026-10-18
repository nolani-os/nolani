/**
 * ClaraOS iframe app bridge (unified clara-chat).
 *
 * Standardised postMessage protocol that lets iframe-hosted apps participate
 * in the Clara inline-chat ecosystem. Apps that opt-in by including
 * `/claraos-iframe.js` (or implementing the protocol manually) become:
 *  - selectable for inline-chat (the Clara-pill appears in their titlebar)
 *  - context-aware (the chat carries selected file / view / etc. into Clara)
 *  - controllable (Clara can dispatch actions; the iframe executes them)
 *
 * Protocol message shapes — both directions originate the `claraos:`-prefixed
 * `type` field. The shell wraps each iframe in a unique `windowId`; the
 * iframe replies with that windowId in every message so the shell can route
 * concurrent windows.
 *
 * Shell → Iframe:
 *
 *   { type: "claraos:hello",     windowId, userId }
 *   { type: "claraos:get-context", windowId }
 *   { type: "claraos:action",    windowId, action, args, requestId }
 *
 * Iframe → Shell:
 *
 *   { type: "claraos:ready",         windowId, appId, capabilities[] }
 *   { type: "claraos:context",       windowId, context }
 *   { type: "claraos:context-changed", windowId, context }   // delta
 *   { type: "claraos:action-result", windowId, requestId, result?, error? }
 *   { type: "claraos:notify",        windowId, title?, message }
 *   { type: "claraos:close-window",  windowId }
 */
import { useIframeAppStore, useUIStore, requestCloseWindow } from "@claraos/core";

const SHELL_HELLO_DELAY_MS = 400;   // wait for iframe to load its handler
const HELLO_RETRY_MAX = 4;          // 4 hellos at 400/800/1600/3200 ms

/** Origins that may open links in the Clara Browser.
 *
 * Deliberately a short list instead of "all embedded apps": the verb opens
 * addresses in a browser with persistent logins (shopping, parcel services).
 * Currently only the mail app — add further sources (chat, feed reader) here.
 */
const LINK_SOURCE_HOSTS = ["mail."];

export function isLinkSourceAllowed(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && LINK_SOURCE_HOSTS.some((p) => u.hostname.startsWith(p));
  } catch {
    return false;
  }
}

export interface BridgeHandle {
  /** Stop listening + cleanup. */
  dispose(): void;
  /** Force-resend hello (for late-loading apps). */
  hello(): void;
  /** Send an action to the iframe; returns a Promise that resolves on result. */
  invoke(action: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export function attachIframeBridge(iframe: HTMLIFrameElement, windowId: string, userId = ""): BridgeHandle {
  let helloAttempt = 0;
  let disposed = false;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();

  function send(payload: Record<string, unknown>): void {
    if (disposed) return;
    try {
      iframe.contentWindow?.postMessage({ ...payload, windowId }, "*");
    } catch (err) {
      console.warn("[iframeBridge] postMessage failed", err);
    }
  }

  function hello(): void {
    helloAttempt += 1;
    send({ type: "claraos:hello", userId });
    if (helloAttempt < HELLO_RETRY_MAX) {
      window.setTimeout(() => {
        // Only retry if we never got a ready
        const entry = useIframeAppStore.getState().get(windowId);
        if (!entry?.ready && !disposed) hello();
      }, SHELL_HELLO_DELAY_MS * 2 ** (helloAttempt - 1));
    }
  }

  function onMessage(ev: MessageEvent): void {
    if (disposed) return;
    if (!iframe.contentWindow || ev.source !== iframe.contentWindow) return;
    const data = ev.data;
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;
    if (!data.type.startsWith("claraos:")) return;
    if (data.windowId && data.windowId !== windowId) return;

    const store = useIframeAppStore.getState();
    switch (data.type) {
      case "claraos:ready": {
        store.setReady(windowId, String(data.appId ?? "unknown"), Array.isArray(data.capabilities) ? data.capabilities.map(String) : []);
        if (data.context && typeof data.context === "object") {
          store.setContext(windowId, data.context as Record<string, unknown>);
        }
        return;
      }
      case "claraos:context":
      case "claraos:context-changed": {
        if (data.context && typeof data.context === "object") {
          store.setContext(windowId, data.context as Record<string, unknown>);
        }
        return;
      }
      case "claraos:action-result": {
        const reqId = String(data.requestId ?? "");
        const slot = pending.get(reqId);
        if (slot) {
          window.clearTimeout(slot.timer);
          pending.delete(reqId);
          if (data.error) slot.reject(new Error(String(data.error)));
          else slot.resolve(data.result);
        }
        return;
      }
      case "claraos:notify": {
        useUIStore.getState().addNotification({
          title: String(data.title ?? "App"),
          body: String(data.message ?? ""),
          icon: "🔔",
        });
        return;
      }
      case "claraos:close-window": {
        // An embedded app asks to close ITS OWN window: the game stream uses
        // this when the game has ended — otherwise a black screen would remain
        // that the user has to clear away by hand.
        // Important: no origin check, unlike open-external. The bridge only
        // lets through messages from exactly this iframe anyway, and an app
        // closing its own window cannot do any harm with it.
        void requestCloseWindow(windowId);
        return;
      }
      case "claraos:open-external": {
        // Open a link from an embedded app in the Clara Browser.
        // Second layer: only allowed origins may trigger this — the verb opens
        // addresses in a browser with persistent logins. Otherwise the bridge
        // only filters via ev.source (see above), which is not enough here:
        // this is not about mix-ups, it is about authorization.
        if (!isLinkSourceAllowed(ev.origin)) {
          console.warn("[claraos] open-external von nicht erlaubter Herkunft:", ev.origin);
          return;
        }
        const url = String(data.url ?? "");
        if (!/^https?:\/\//i.test(url)) return;
        window.dispatchEvent(new CustomEvent("claraos:open-external", {
          detail: { url, from: String(data.from ?? ""), origin: ev.origin },
        }));
        return;
      }
      default:
        // Forward-compat: ignore unknown verbs
        break;
    }
  }

  window.addEventListener("message", onMessage);

  // Initial handshake — wait a tick for the iframe to register its listener.
  window.setTimeout(hello, SHELL_HELLO_DELAY_MS);

  return {
    dispose(): void {
      disposed = true;
      window.removeEventListener("message", onMessage);
      pending.forEach((p) => {
        window.clearTimeout(p.timer);
        p.reject(new Error("bridge disposed"));
      });
      pending.clear();
      useIframeAppStore.getState().remove(windowId);
    },
    hello,
    invoke(action, args, timeoutMs = 8000) {
      const requestId = `req-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
      return new Promise<unknown>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`iframe action "${action}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        send({ type: "claraos:action", action, args, requestId });
      });
    },
  };
}

/**
 * Forward a fire-and-forget Action-Bus action to the iframe of `windowId` if
 * one is registered + ready. Returns true if delivered.
 */
export function dispatchToIframe(
  windowId: string,
  action: string,
  args: Record<string, unknown>,
): boolean {
  const entry = useIframeAppStore.getState().get(windowId);
  if (!entry || !entry.ready) return false;
  const iframe = document.querySelector<HTMLIFrameElement>(
    `iframe[data-window-id="${CSS.escape(windowId)}"]`,
  );
  if (!iframe || !iframe.contentWindow) return false;
  iframe.contentWindow.postMessage(
    { type: "claraos:action", windowId, action, args },
    "*",
  );
  return true;
}
