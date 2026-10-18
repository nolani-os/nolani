/**
 * Top-level Marker Bridge — wires the global useMarkerStore to drivers in
 * same-origin iframe apps via postMessage.
 *
 * Flow:
 *   1. User clicks 📍 in the ChatPanel → `mode='picking'`.
 *   2. Bridge broadcasts `{ type: 'marker:enable' }` to every iframe in the
 *      document. Same-origin filter keeps third-party iframes (auth proxies
 *      etc.) untouched. Each driver decides whether to react.
 *   3. The driver captures a selection and posts back
 *      `{ type: 'marker:selection', payload: MarkerPayload }`.
 *   4. The bridge validates origin and calls `setPinned(payload)`. The mode
 *      flips back to `idle` automatically (setPinned does it).
 *   5. If the user cancels in the ChatPanel, mode flips to idle → bridge
 *      broadcasts `marker:disable`.
 *
 * Mounted once from main.tsx — install() is idempotent.
 */
import { useMarkerStore, type MarkerPayload } from "@claraos/core";

let installed = false;

function broadcast(type: "marker:enable" | "marker:disable"): void {
  const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe");
  iframes.forEach((iframe) => {
    try {
      // Same-origin filter: skip iframes whose contentWindow throws on access
      // (cross-origin) — those can't host our driver anyway.
      const win = iframe.contentWindow;
      if (!win) return;
      try { void win.location.href; } catch { return; }  // cross-origin → skip
      win.postMessage({ type }, window.location.origin);
    } catch {
      // ignore — driver-less iframes shouldn't crash the bridge
    }
  });
}

function isMarkerPayload(data: unknown): data is MarkerPayload {
  if (!data || typeof data !== "object") return false;
  const o = data as Record<string, unknown>;
  if (typeof o.kind !== "string") return false;
  if (typeof o.appId !== "string") return false;
  if (typeof o.snapshotB64 !== "string") return false;
  return ["bbox-img", "svg-element", "geojson", "cad-object"].includes(o.kind);
}

function onMessage(ev: MessageEvent): void {
  if (ev.origin !== window.location.origin) return;  // same-origin only
  const data = ev.data;
  if (!data || typeof data !== "object") return;
  const type = (data as { type?: unknown }).type;

  if (type === "marker:selection") {
    const payload = (data as { payload?: unknown }).payload;
    if (!isMarkerPayload(payload)) {
      console.warn("[markerBridge] dropped invalid selection payload", payload);
      return;
    }
    useMarkerStore.getState().setPinned(payload);
    return;
  }

  if (type === "marker:snapshot") {
    const o = data as Record<string, unknown>;
    const snap = typeof o.snapshotB64 === "string" ? o.snapshotB64 : "";
    const appId = typeof o.appId === "string" ? o.appId : "";
    const objectUri = typeof o.objectUri === "string" ? o.objectUri : undefined;
    if (!snap || !appId) {
      console.warn("[markerBridge] dropped invalid snapshot payload", o);
      return;
    }
    useMarkerStore.getState().requestMarkup({
      snapshotB64: snap,
      base: { appId, objectUri },
    });
  }
}

export function installMarkerBridge(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("message", onMessage);

  let lastMode: string | null = null;
  useMarkerStore.subscribe((state) => {
    if (state.mode === lastMode) return;
    lastMode = state.mode;
    if (state.mode === "picking") broadcast("marker:enable");
    else broadcast("marker:disable");
  });
}
