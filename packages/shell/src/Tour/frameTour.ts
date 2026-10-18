/**
 * Element-precise tours in third-party apps.
 *
 * Third-party apps run cross-origin in an iframe — the shell cannot look
 * inside. The reverse proxy, however, injects `claraos-iframe-auto.js` into
 * ~25 apps; its tour bridge answers `claraos:tour-highlight` with ongoing
 * `claraos:tour-rect` ticks (viewport coordinates of the element).
 *
 * Mechanism: ensureFrame opens the app window and places an invisible proxy
 * div with `data-tour=<anchorId>` over the iframe (Joyride targets the
 * proxy). The proxy starts at full iframe size — that IS the frame fallback.
 * As soon as the bridge delivers rects, it shrinks onto the element; if it
 * never answers (no script, CSP, app's own window.claraos, element missing),
 * the frame spotlight remains.
 */
import { useAppRegistryStore, useUIStore, useWindowsStore } from "@claraos/core";

interface Rect { x: number; y: number; w: number; h: number }

let activeCleanup: (() => void) | null = null;

/** End the active frame highlight (step change/tour end). */
export function clearFrameHighlight(): void {
  activeCleanup?.();
  activeCleanup = null;
}

async function waitForIframe(appId: string, timeoutMs: number): Promise<HTMLIFrameElement> {
  const t0 = Date.now();
  for (;;) {
    const win = Object.values(useWindowsStore.getState().windows)
      .find((w) => w.appId === appId);
    if (win) {
      const el = document.querySelector<HTMLIFrameElement>(
        `iframe[data-window-id="${CSS.escape(win.id)}"]`);
      if (el) return el;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`Tour: iframe für App ${appId} nicht gefunden`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function ensureFrame(appId: string, selector: string | null,
                            anchorId: string): () => Promise<void> {
  return async () => {
    clearFrameHighlight();
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
    const iframe = await waitForIframe(appId, 12000);

    const proxy = document.createElement("div");
    proxy.setAttribute("data-tour", anchorId);
    proxy.style.cssText = "position:fixed;pointer-events:none;z-index:1;";
    document.body.appendChild(proxy);

    let elementRect: Rect | null = null;

    const position = () => {
      const ir = iframe.getBoundingClientRect();
      if (!elementRect) {
        proxy.style.left = `${ir.left}px`;
        proxy.style.top = `${ir.top}px`;
        proxy.style.width = `${ir.width}px`;
        proxy.style.height = `${ir.height}px`;
        return;
      }
      // Element rect is iframe-relative (the app's viewport) -> convert to shell
      // coordinates and clamp to the visible iframe area.
      const left = Math.max(ir.left, ir.left + elementRect.x);
      const top = Math.max(ir.top, ir.top + elementRect.y);
      const right = Math.min(ir.right, ir.left + elementRect.x + elementRect.w);
      const bottom = Math.min(ir.bottom, ir.top + elementRect.y + elementRect.h);
      proxy.style.left = `${left}px`;
      proxy.style.top = `${top}px`;
      proxy.style.width = `${Math.max(0, right - left)}px`;
      proxy.style.height = `${Math.max(0, bottom - top)}px`;
    };
    position();

    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== iframe.contentWindow) return;
      const d = ev.data as { type?: string; selector?: string; rect?: Rect } | null;
      if (!d || d.type !== "claraos:tour-rect" || d.selector !== selector) return;
      elementRect = d.rect ?? null;
      position();
    };
    window.addEventListener("message", onMsg);

    const send = () => {
      if (selector) {
        iframe.contentWindow?.postMessage(
          { type: "claraos:tour-highlight", selector }, "*");
      }
    };
    send();
    // The bridge may only load with the app — resend until rects arrive.
    const resend = window.setInterval(() => { if (!elementRect) send(); }, 700);
    // The window can be moved/resized — the proxy follows.
    const reposition = window.setInterval(position, 300);

    activeCleanup = () => {
      window.clearInterval(resend);
      window.clearInterval(reposition);
      window.removeEventListener("message", onMsg);
      try {
        iframe.contentWindow?.postMessage({ type: "claraos:tour-clear" }, "*");
      } catch { /* iframe may be gone */ }
      proxy.remove();
    };
  };
}
