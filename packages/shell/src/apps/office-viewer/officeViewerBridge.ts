/**
 * officeViewerBridge — postMessage channel between the shell and the directly
 * embedded Collabora iframes of the office viewer.
 *
 * Since the direct embed (own WOPI host in claraos-api) the shell is the host
 * frame of the Collabora session and may speak the postMessage API.
 * The action-bus actions for `app_id="office-viewer"` run through here:
 *
 *   insert  args: { content, mime?, save? }   → Action_Paste at cursor position
 *   save    args: {}                          → Action_Save
 *
 * Collabora only accepts host messages after the handshake
 * (Document_loaded → Host_PostmessageReady) — until then the bridge queues.
 * Addressing: payload.window_id, otherwise the most recently focused
 * office-viewer window.
 */
import { registerActionHandler } from "../../Chat/actionBus";
import { useUIStore, appUrl } from "@claraos/core";

export const COLLABORA_ORIGIN = appUrl("collabora");

interface FrameEntry {
  iframe: HTMLIFrameElement;
  ready: boolean;
  queue: object[];
  lastFocusedAt: number;
}

const frames = new Map<string, FrameEntry>();

function post(entry: FrameEntry, msg: object): void {
  entry.iframe.contentWindow?.postMessage(JSON.stringify(msg), COLLABORA_ORIGIN);
}

function send(entry: FrameEntry, msg: object): void {
  if (entry.ready) post(entry, msg);
  else entry.queue.push(msg);
}

/** Called by OfficeViewerApp on mount; returns the cleanup function. */
export function registerOfficeFrame(windowId: string, iframe: HTMLIFrameElement): () => void {
  frames.set(windowId, { iframe, ready: false, queue: [], lastFocusedAt: Date.now() });
  return () => {
    frames.delete(windowId);
  };
}

export function markOfficeFrameFocused(windowId: string): void {
  const e = frames.get(windowId);
  if (e) e.lastFocusedAt = Date.now();
}

/** Send Host_PostmessageReady — MUST go out on App_LoadingStatus/Initialized,
 * otherwise Collabora never sends Document_loaded (chicken-and-egg). */
export function sendHostReady(windowId: string): void {
  const e = frames.get(windowId);
  if (e) post(e, { MessageId: "Host_PostmessageReady" });
}

/** Called by OfficeViewerApp's message listener on Document_loaded. */
export function markOfficeFrameReady(windowId: string): void {
  const e = frames.get(windowId);
  if (!e || e.ready) return;
  e.ready = true;
  for (const msg of e.queue.splice(0)) post(e, msg);
}

function pickTarget(windowId?: string | null): FrameEntry | undefined {
  if (windowId) return frames.get(windowId);
  let best: FrameEntry | undefined;
  for (const e of frames.values()) {
    if (!best || e.lastFocusedAt > best.lastFocusedAt) best = e;
  }
  return best;
}

function notify(message: string): void {
  try {
    useUIStore.getState().addNotification({ title: "Office", body: message, icon: "📄" });
  } catch {
    console.warn("[officeViewer]", message);
  }
}

function officeAction(
  action: string,
  args: Record<string, unknown>,
  payload: { window_id?: string | null },
): void {
  const entry = pickTarget(payload.window_id);
  if (!entry) {
    notify("Kein Office-Dokument geöffnet — Einfügen nicht möglich.");
    return;
  }
  switch (action) {
    case "insert": {
      const content = String(args.content ?? "");
      if (!content) return;
      const mime = String(args.mime ?? "text/plain;charset=utf-8");
      send(entry, {
        MessageId: "Action_Paste",
        SendTime: Date.now(),
        Values: { Mimetype: mime, Data: content },
      });
      if (args.save === true) {
        send(entry, {
          MessageId: "Action_Save",
          Values: { DontTerminateEdit: true, DontSaveIfUnmodified: true, Notify: false },
        });
      }
      return;
    }
    case "save":
      send(entry, {
        MessageId: "Action_Save",
        Values: { DontTerminateEdit: true, DontSaveIfUnmodified: true, Notify: false },
      });
      return;
    default:
      console.debug("[officeViewer] unknown action", action);
  }
}

let installed = false;

/** Idempotent — installed by the OfficeViewerApp module on import. */
export function installOfficeViewerActionHandler(): void {
  if (installed) return;
  installed = true;
  registerActionHandler("office-viewer", officeAction);
}
