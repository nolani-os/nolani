/**
 * officeViewerBridge — postMessage channel between the shell and the directly
 * embedded Collabora iframes of the office viewer.
 *
 * Since the direct embed (own WOPI host in claraos-api) the shell is the host
 * frame of the Collabora session and may speak the postMessage API.
 * The action-bus actions for `app_id="office-viewer"` run through here:
 *
 *   insert  args: { content, mime?, save?, position? }
 *           → Action_Paste at the cursor, or with position "end" at the end of the
 *             document; plain text is read as Markdown and pasted as HTML
 *   save    args: {}                          → Action_Save
 *
 * Collabora only accepts host messages after the handshake
 * (Document_loaded → Host_PostmessageReady) — until then the bridge queues.
 * Addressing: payload.window_id, otherwise the most recently focused
 * office-viewer window.
 */
import { registerActionHandler, meldeErgebnis, type ActionPayload } from "../../Chat/actionBus";
import { useUIStore, appUrl, i18n } from "@claraos/core";
import { markdownToHtml } from "../../lib/markdownHtml";

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
    useUIStore.getState().addNotification({ title: i18n.t("viewers:office.notifyTitle"), body: message, icon: "📄" });
  } catch {
    console.warn("[officeViewer]", message);
  }
}

function officeAction(
  action: string,
  args: Record<string, unknown>,
  payload: ActionPayload,
): void {
  const entry = pickTarget(payload.window_id);
  if (!entry) {
    notify(i18n.t("viewers:office.noDocument"));
    meldeErgebnis(payload, false, "No office document is open — nothing inserted.");
    return;
  }
  switch (action) {
    case "insert": {
      const content = String(args.content ?? "");
      if (!content) {
        meldeErgebnis(payload, false, "insert without content — nothing inserted.");
        return;
      }
      // Plain text (the default) is treated as Markdown and pasted as HTML, so
      // headings and lists arrive formatted; an explicit mime is passed through.
      const html = !args.mime || String(args.mime).startsWith("text/plain");
      const mime = html ? "text/html" : String(args.mime);
      const amEnde = args.position === "end";
      if (amEnde) {
        // A new paragraph after the last one, so the pasted block does not take
        // over the style of whatever line the document ends with.
        send(entry, { MessageId: "Send_UNO_Command", Values: { Command: ".uno:GoToEndOfDoc" } });
        send(entry, { MessageId: "Send_UNO_Command", Values: { Command: ".uno:InsertPara" } });
      }
      send(entry, {
        MessageId: "Action_Paste",
        SendTime: Date.now(),
        Values: { Mimetype: mime, Data: html ? markdownToHtml(content) : content },
      });
      if (args.save === true) {
        send(entry, {
          MessageId: "Action_Save",
          Values: { DontTerminateEdit: true, DontSaveIfUnmodified: true, Notify: false },
        });
      }
      // Without an ack the assistant waited into the timeout and told the user the
      // insert might have failed — although the text was there (showcase takes 3–5).
      meldeErgebnis(payload, true,
        `Pasted ${content.length} characters ${amEnde ? "at the end of" : "at the cursor in"} `
        + `the document${entry.ready ? "" : " (queued until the document has loaded)"}`
        + `${args.save === true ? " and saved" : ""}. Collabora does not report back what it `
        + "rendered; read_screen shows the document.");
      return;
    }
    case "save":
      send(entry, {
        MessageId: "Action_Save",
        Values: { DontTerminateEdit: true, DontSaveIfUnmodified: true, Notify: false },
      });
      meldeErgebnis(payload, true, "Save sent to the document.");
      return;
    default:
      console.debug("[officeViewer] unknown action", action);
      meldeErgebnis(payload, false, `The office viewer does not know the action "${action}".`);
  }
}

let installed = false;

/** Idempotent — installed by the OfficeViewerApp module on import. */
export function installOfficeViewerActionHandler(): void {
  if (installed) return;
  installed = true;
  registerActionHandler("office-viewer", officeAction);
}
