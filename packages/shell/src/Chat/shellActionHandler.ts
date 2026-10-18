/**
 * Shell action handler — Action-Bus subscriber for `app_id="shell"`.
 *
 * Lets clara-agent imperatively drive the desktop:
 *
 *   shell.open_window      args: { app_id, opts }
 *   shell.show_artifact    args: { kind, content, mime?, title? }
 *
 * For `open_window`:
 *   - `opts.position === "anchor-chat-right"` (default from claraos_action MCP):
 *     anchor the new window to the right edge of the most-recently-visible
 *     ClaraChatPanel surface, so the result lands next to the chat the user
 *     was just looking at.
 *   - Other position strings or missing position → cascade-default
 *     (existing useWindowsStore.openWindow placement).
 *
 * For `show_artifact`:
 *   - The content is placed in the volatile artifact store and opened in the
 *     viewer — HTML runs there, everything else is shown as source. Previously
 *     this only fired a CustomEvent that NOBODY listened to, plus a
 *     notification with the first 140 characters; Clara took that as success
 *     and claimed in chat that the result was visible.
 *
 * Every action returns a result (`Ergebnis`) that goes back over the bus as
 * an `ack` — so Clara learns whether something was really displayed.
 */
import { useAppRegistryStore, useWindowsStore, useUIStore } from "@claraos/core";
import { registerActionHandler, meldeErgebnis, type ActionPayload } from "./actionBus";
import { navigateIframe } from "../apps/iframeNavigator";
import { merken, istHtml } from "../lib/artefakte";
import { warteAufInhalt, berichtVerwerfen, MELDENDE_APPS } from "../lib/ladeberichte";
import { appComponents, getAppManifest } from "../apps/registry";

/** What a shell action did — sent back to the server as an `ack`. */
export interface Ergebnis {
  ok: boolean;
  detail: string;
}

const CHAT_SURFACE_SELECTOR = "[data-claraos-chat-surface]";
const ANCHOR_GAP_PX = 8;
const ANCHOR_DEFAULT_WIDTH = 800;
const ANCHOR_MIN_WIDTH = 480;

/**
 * Find the most recently-rendered visible ClaraChatPanel and return its
 * bounding box in viewport coordinates. Used to anchor newly-opened windows
 * right next to the chat the user is looking at.
 *
 * Strategy:
 *   1. Prefer an element marked data-claraos-chat-surface-active="true".
 *   2. Else: pick the visible one with the largest area (the "main" chat).
 *   3. Else: null → caller falls back to default cascade placement.
 */
function findActiveChatBounds(): DOMRect | null {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(CHAT_SURFACE_SELECTOR),
  );
  if (all.length === 0) return null;

  // Filter to visible (non-zero, in-viewport-ish)
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visible = all
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(
      ({ r }) =>
        r.width > 100 &&
        r.height > 100 &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < vw &&
        r.top < vh,
    );
  if (visible.length === 0) return null;

  const active = visible.find(
    ({ el }) => el.dataset.claraosChatSurfaceActive === "true",
  );
  if (active) return active.r;

  // Largest-area fallback
  visible.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  return visible[0].r;
}

/**
 * Resolve `position: "anchor-chat-right"` to concrete x/y/width/height
 * values, snapping to the right edge of the active chat surface. If no chat
 * is visible (or the result wouldn't fit), returns null and the caller
 * falls back to default placement.
 */
export function resolveAnchorChatRight(opts?: {
  preferredWidth?: number;
  preferredHeight?: number;
}): { x: number; y: number; width: number; height: number } | null {
  const bounds = findActiveChatBounds();
  if (!bounds) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const desiredWidth = opts?.preferredWidth ?? ANCHOR_DEFAULT_WIDTH;
  const x = Math.round(bounds.right + ANCHOR_GAP_PX);
  const availableWidth = vw - x - ANCHOR_GAP_PX;
  if (availableWidth < ANCHOR_MIN_WIDTH) return null;

  const width = Math.min(desiredWidth, availableWidth);
  const y = Math.max(8, Math.round(bounds.top));
  const desiredHeight = opts?.preferredHeight ?? Math.round(bounds.height);
  const height = Math.min(desiredHeight, vh - y - 16);
  return { x, y, width, height };
}

interface OpenWindowArgs {
  app_id?: string;
  appId?: string;
  opts?: Record<string, unknown> | null;
}

interface ShowArtifactArgs {
  kind?: string;
  content?: string;
  mime?: string;
  title?: string;
}

/** Tiles whose id or name contains a word of `gesucht` ("browser" → "selkies-browser"). */
function passendeApps(gesucht: string, max = 5): string[] {
  const woerter = gesucht.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length >= 3);
  if (!woerter.length) return [];
  return useAppRegistryStore.getState().getAllApps()
    .filter((a) => {
      const text = `${a.id} ${a.name ?? ""}`.toLowerCase();
      return woerter.some((w) => text.includes(w));
    })
    .slice(0, max)
    .map((a) => `${a.id} — ${a.name ?? a.id}`);
}

async function shellOpenWindow(args: OpenWindowArgs): Promise<Ergebnis> {
  const targetAppId = String(args.app_id ?? args.appId ?? "");
  if (!targetAppId) {
    console.warn("[shellAction] open_window: missing app_id");
    return { ok: false, detail: "open_window ohne app_id — nichts geoeffnet." };
  }

  // Warning: does the shell know this app at all? Previously the window opened
  // anyway and showed "App <x> has no registered component" — the bus dutifully
  // reported delivered:2, Clara said "done!", and the user saw nothing.
  // The caller now learns this instead of guessing.
  if (!appComponents[targetAppId] && !getAppManifest(targetAppId)) {
    console.warn("[shellAction] open_window: unbekannte App", targetAppId);
    // Name the user's real tiles that match, so the caller can retry with the
    // right id: asked to "open the browser", Clara guessed "browser" while the
    // tile is called something else, and gave up.
    const vorschlaege = passendeApps(targetAppId);
    return {
      ok: false,
      detail: `Es gibt in ClaraOS keine App "${targetAppId}". Fenster NICHT geoeffnet. `
        + (vorschlaege.length
          ? `Passende Apps dieses Nutzers (id — Name): ${vorschlaege.join("; ")}. `
            + "Mit der richtigen id erneut aufrufen. "
          : "")
        + "Bekannte Betrachter: image-viewer (Bilder und laufende HTML-Seiten), "
        + "pdf-viewer, video-player, text-editor, office-viewer, model-viewer, files.",
    };
  }

  const opts = (args.opts ?? {}) as Record<string, unknown>;

  // Focus an existing window instead of opening a duplicate.
  // Match by appId + path so single-instance (iframe) apps and same-document
  // opens focus the existing window, while a text-editor opening a *different*
  // file still gets its own window. focusWindow also un-minimizes + raises.
  const newPath = opts.path !== undefined ? String(opts.path) : undefined;
  const store0 = useWindowsStore.getState();
  const existingWin = Object.values(store0.windows).find(
    (w) => w.appId === targetAppId && (newPath === undefined || w.path === newPath),
  );
  if (existingWin) {
    store0.focusWindow(existingWin.id);
    console.debug("[shellAction] open_window → focused existing", targetAppId, existingWin.id);
    // On mobile, focusing doesn't surface the app — bring it into the cobrowse
    // split-view so the user actually SEES what Clara opened. (Desktop has no
    // listener → harmless no-op. Dispatched AFTER the window exists so the
    // mobile listener never opens a duplicate without our opts.)
    window.dispatchEvent(new CustomEvent("claraos:mobile-cobrowse", { detail: { appId: targetAppId } }));
    return { ok: true, detail: `${targetAppId} war schon offen — Fenster nach vorn geholt.` };
  }

  const position = String(opts.position ?? "anchor-chat-right");

  const passthrough: Record<string, unknown> = {};
  // Pre-populate generic window opts that openWindow understands
  for (const key of ["title", "icon", "x", "y", "width", "height", "path", "source"]) {
    if (opts[key] !== undefined) passthrough[key] = opts[key];
  }

  if (position === "anchor-chat-right") {
    const anchor = resolveAnchorChatRight({
      preferredWidth: typeof opts.width === "number" ? opts.width : undefined,
      preferredHeight: typeof opts.height === "number" ? opts.height : undefined,
    });
    if (anchor) {
      passthrough.x = anchor.x;
      passthrough.y = anchor.y;
      passthrough.width = anchor.width;
      passthrough.height = anchor.height;
    }
    // else: fall through with whatever opts had (cascade default)
  }

  // Forward content/language/etc. as window-init payload via `opts`-as-extra.
  // Concrete viewer apps read them from window.opts (if they need to) — for
  // V1, only path+source are universally supported; richer context flows
  // through the iframe-bridge for iframe-apps.
  for (const key of ["content", "language", "viewer_hint"]) {
    if (opts[key] !== undefined) {
      // Stash on window.path-meta for now; concrete viewer apps can grow
      // their own opts handling. text-editor will read window.path/source
      // via the existing flow.
      passthrough[`__${key}` as keyof typeof passthrough] = opts[key];
    }
  }

  const winId = useWindowsStore.getState().openWindow(targetAppId, passthrough);
  console.debug("[shellAction] open_window →", targetAppId, "win:", winId, "pos:", position);
  // Mobile: surface the freshly opened app in the cobrowse split (see above).
  window.dispatchEvent(new CustomEvent("claraos:mobile-cobrowse", { detail: { appId: targetAppId } }));

  // Viewers report themselves what became of the content — otherwise the
  // acknowledgement would say "window open" even though it shows "file could
  // not be loaded".
  if (newPath && MELDENDE_APPS.has(targetAppId)) {
    const bericht = await warteAufInhalt(winId);
    if (bericht) return bericht;
    return {
      ok: false,
      detail: `${targetAppId} hat ${newPath} nicht rechtzeitig geladen — unklar, `
        + "ob der Nutzer etwas sieht. Nachfragen statt Erfolg melden.",
    };
  }
  return {
    ok: true,
    detail: `${targetAppId} geoeffnet${newPath ? ` mit ${newPath}` : ""} (Fenster ${winId}). `
      + "Die App meldet ihren Inhalt nicht zurueck.",
  };
}

/**
 * Show a file in the viewer — in the SAME window if one is already open.
 *
 * Warning: a user had an image open and asked, in the VIEWER's chat, to make
 * it brighter. Clara computed the result, stored it and called
 * `open_in_viewer` — which created a SECOND image-viewer window. On phones,
 * however, the split screen shows the window from
 * `windows.find(w => w.appId === …)`, i.e. the FIRST one, i.e. still the old
 * image. Visibly nothing happened for the user. And because no viewer of the
 * new window submitted its load report, `rendered: 0` came back.
 *
 * The flow described in `bilder.yaml` ("and shows the result again in the
 * viewer") means REPLACE, not ADD ALONGSIDE. `setWindowFile` can do that —
 * it just was never used by Clara's path.
 *
 * Order: if a window already shows the path, just bring it to the front.
 * Otherwise re-point the MOST RECENT viewer window (most recent = the one the
 * user dealt with last). Only if none is open, open a new one.
 */
async function betrachterZeigen(pfad: string, quelle: string, titel?: string): Promise<Ergebnis> {
  const store = useWindowsStore.getState();
  const betrachter = store.windowOrder
    .map((id) => store.windows[id])
    .filter((w): w is NonNullable<typeof w> => !!w && w.appId === "image-viewer")
    // Warning: NEVER re-point artifact windows — they run a page whose content
    // only lives in memory (`lib/artefakte.ts`). Replacing it destroys it for
    // good — a game mid-move, a chart nobody can get back. A second window is
    // the lesser evil here.
    .filter((w) => w.source !== "artefakt");

  const schonOffen = betrachter.find((w) => w.path === pfad);
  if (schonOffen) {
    store.focusWindow(schonOffen.id);
    window.dispatchEvent(new CustomEvent("claraos:mobile-cobrowse", { detail: { appId: "image-viewer" } }));
    return { ok: true, detail: `${pfad} war schon im Betrachter offen — Fenster nach vorn geholt.` };
  }

  const juengstes = betrachter[betrachter.length - 1];
  if (juengstes) {
    // First clear the report of the PREVIOUS image — otherwise the switch
    // is acknowledged with the load report of the old file.
    berichtVerwerfen(juengstes.id);
    store.setWindowFile(juengstes.id, quelle, pfad, titel ?? pfad.split("/").pop());
    store.focusWindow(juengstes.id);
    // On phones the split screen follows this window — the switch has to
    // arrive there, otherwise the old image stays on top.
    window.dispatchEvent(new CustomEvent("claraos:mobile-cobrowse", { detail: { appId: "image-viewer" } }));
    const bericht = await warteAufInhalt(juengstes.id);
    if (bericht) return bericht;
    return {
      ok: false,
      detail: `Der Betrachter hat ${pfad} nicht rechtzeitig geladen — unklar, `
        + "ob der Nutzer etwas sieht. Nachfragen statt Erfolg melden.",
    };
  }

  return shellOpenWindow({
    app_id: "image-viewer",
    opts: { path: pfad, source: quelle, title: titel, position: "anchor-chat-right" },
  } as OpenWindowArgs);
}

async function shellShowArtifact(args: ShowArtifactArgs): Promise<Ergebnis> {
  const kind = String(args.kind ?? "");
  const content = String(args.content ?? "");
  if (!kind || !content) {
    console.warn("[shellAction] show_artifact: missing kind/content");
    return { ok: false, detail: "show_artifact ohne kind/content — nichts angezeigt." };
  }
  const mime = args.mime ?? "";
  const html = kind === "html" || istHtml(content, mime);
  const title = args.title || (html ? "Seite von Clara" : `${kind[0].toUpperCase()}${kind.slice(1)} von Clara`);

  // Keep the content in volatile memory (not in the persisted window store!)
  // and open it in the viewer: HTML runs there, everything else is shown as source.
  const id = merken({ inhalt: content, mime, titel: title, art: kind });
  const ergebnis = await shellOpenWindow({
    app_id: "image-viewer",
    opts: { path: id, source: "artefakt", title, position: "anchor-chat-right" },
  });
  if (!ergebnis.ok) return ergebnis;

  // Also fire the event — ClaraChatPanel can later build a card in the chat
  // history from it. Without a listener this has no effect; the user sees the
  // artifact in the viewer either way.
  try {
    window.dispatchEvent(
      new CustomEvent("claraos:artifact", {
        detail: { kind, content, mime, title, artefaktId: id },
      }),
    );
  } catch (err) {
    console.warn("[shellAction] artifact event failed", err);
  }
  return {
    ok: true,
    detail: html
      ? `Seite "${title}" laeuft jetzt im Betrachter.`
      : `"${title}" wird im Betrachter als Quelltext gezeigt.`,
  };
}

interface NavigateToArgs {
  app_id?: string;
  url?: string;
}

/**
 * Deep-link an iframe-app to a view. If a window for the app
 * is already open, focus it and navigate its iframe. Otherwise open the window
 * (it loads the app's base url) and navigate once the IframeApp has mounted and
 * registered its navigator — polled for up to ~6s.
 */
function shellNavigateTo(args: NavigateToArgs): Ergebnis {
  const appId = String(args.app_id ?? "");
  const url = String(args.url ?? "");
  if (!appId || !url) {
    console.warn("[shellAction] navigate_to: missing app_id/url");
    return { ok: false, detail: "navigate_to ohne app_id/url — nichts passiert." };
  }

  // On mobile, opening a window doesn't surface it — ask the mobile shell to
  // bring the app into the cobrowse split-view so the user actually SEES it.
  // (Desktop has no listener → harmless no-op there.)
  window.dispatchEvent(new CustomEvent("claraos:mobile-cobrowse", { detail: { appId, url } }));

  const store = useWindowsStore.getState();
  const existing = Object.values(store.windows).find((w) => w.appId === appId);
  if (existing) {
    store.focusWindow(existing.id);
    if (navigateIframe(appId, url)) return { ok: true, detail: `${appId} zeigt jetzt ${url}.` };
    // Window exists but navigator not registered yet (still mounting) → poll.
  } else {
    store.openWindow(appId);
  }

  let tries = 0;
  const timer = window.setInterval(() => {
    if (navigateIframe(appId, url) || ++tries > 40) {
      window.clearInterval(timer);
    }
  }, 150);
  return { ok: true, detail: `${appId} wird geoeffnet und auf ${url} geschickt.` };
}

/** shell.set_mobile_view — open (and optionally deep-link) an app, then ask the
 *  mobile shell to show it in the cobrowse split-view (app on top, chat below) so
 *  the user watches Clara work while chatting. On desktop the window just opens +
 *  navigates (the CustomEvent has no listener) — safe no-op there. */
async function shellSetMobileView(args: Record<string, unknown>): Promise<Ergebnis> {
  const appId = String(args.app_id ?? "");
  const url = args.url ? String(args.url) : "";
  if (!appId) {
    console.warn("[shellAction] set_mobile_view: missing app_id");
    return { ok: false, detail: "set_mobile_view ohne app_id — nichts passiert." };
  }
  const ergebnis = url
    ? shellNavigateTo({ app_id: appId, url } as NavigateToArgs)
    : await shellOpenWindow({ app_id: appId } as OpenWindowArgs);
  if (!ergebnis.ok) return ergebnis;
  window.dispatchEvent(new CustomEvent("claraos:mobile-cobrowse", { detail: { appId, url } }));
  return ergebnis;
}

/**
 * What is the user currently seeing?
 *
 * Why this exists: asked to "check yourself with screenshots", Clara ran
 * `docker_ps` — she reported on containers instead of the screen, because
 * she simply had no way to look there. She cannot read an image, but she can
 * read a **report**, and it names exactly what was missing before: the error
 * text in the window.
 */
export function berichtVomSchirm(): Ergebnis {
  const s = useWindowsStore.getState();
  const zeilen: string[] = [];
  const breite = window.innerWidth;
  const hoehe = window.innerHeight;
  zeilen.push(`Bildschirm: ${breite < 768 ? "Handy" : "Rechner"} (${breite}x${hoehe}px)`);

  const fenster = s.windowOrder.map((id) => s.windows[id]).filter(Boolean);
  if (fenster.length === 0) {
    zeilen.push("Kein Fenster offen — der Nutzer sieht den Schreibtisch.");
  } else {
    zeilen.push(`${fenster.length} Fenster:`);
    for (const w of fenster) {
      const zustand = w.minimized
        ? "minimiert (NICHT sichtbar)"
        : w.id === s.focusedWindowId ? "im Vordergrund" : "offen, im Hintergrund";
      zeilen.push(`- ${w.appId} "${w.title}"${w.path ? ` [${w.path}]` : ""} — ${zustand}`);
    }
  }

  // Text of the frontmost window — that is where it says what went wrong.
  const vorn = fenster.find((w) => w.id === s.focusedWindowId && !w.minimized)
    ?? fenster.find((w) => !w.minimized);
  if (vorn) {
    // On phones there are no window nodes — there MobileShell renders the app
    // as a "surface" (data-surf-id). Try both paths, otherwise the report on
    // phones would always say "no readable text".
    const knoten = (document.querySelector(`[data-window-id="${vorn.id}"]`)
      ?? document.querySelector('[data-surf-id][data-active="true"]')
      ?? document.querySelector("[data-surf-id]")) as HTMLElement | null;
    const rahmen = knoten?.querySelector("iframe");
    const text = knoten?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    if (rahmen) {
      zeilen.push(`Das vorderste Fenster (${vorn.appId}) zeigt eine laufende Seite in einem `
        + "Rahmen. Ihr Inhalt ist von aussen nicht lesbar (eigener Ursprung) — sie laeuft aber."
        + (text ? ` Drumherum steht: "${text.slice(0, 300)}"` : ""));
    } else if (text) {
      zeilen.push(`Im vordersten Fenster (${vorn.appId}) steht: "${text.slice(0, 900)}"`);
    } else {
      zeilen.push(`Das vorderste Fenster (${vorn.appId}) zeigt keinen lesbaren Text `
        + "(vermutlich ein Bild oder Video).");
    }
  }

  // Explicitly highlight the shell's error displays.
  const seitentext = document.body.innerText || "";
  if (seitentext.includes("has no registered component")) {
    zeilen.push("🔴 ACHTUNG: Es steht ein Fenster mit \"App … has no registered component\" " +
      "auf dem Schirm — eine Aktion hat eine App angesprochen, die es nicht gibt.");
  }
  if (/konnte nicht geladen werden|liess sich nicht laden/i.test(seitentext)) {
    zeilen.push("🔴 ACHTUNG: Auf dem Schirm steht eine Lade-Fehlermeldung.");
  }

  const toasts = useUIStore.getState().notifications ?? [];
  if (toasts.length) {
    zeilen.push(`Offene Benachrichtigungen: ${toasts.slice(0, 3)
      .map((n: { title?: string }) => n.title ?? "(ohne Titel)").join(" · ")}`);
  }

  return { ok: true, detail: zeilen.join("\n") };
}

/** Close every window of an app ("*" = all app windows; the chat stays).
 *  Missing until the user asked Clara to restart a hanging app and she could
 *  only tell them to swipe it away themselves. */
function shellCloseWindow(args: Record<string, unknown>): Ergebnis {
  const ziel = String(args.app_id ?? args.appId ?? "").trim();
  if (!ziel) return { ok: false, detail: "close_window ohne app_id — nichts geschlossen." };
  const store = useWindowsStore.getState();
  const istChat = (id: string) => id === "clara" || id.startsWith("clara-chat");
  const treffer = Object.values(store.windows).filter((w) =>
    ziel === "*" ? !istChat(w.appId) : w.appId === ziel);
  if (!treffer.length) {
    const offen = Object.values(store.windows).map((w) => w.appId).filter((id) => !istChat(id));
    return {
      ok: false,
      detail: `Kein offenes Fenster von "${ziel}". Offen sind: ${offen.length ? [...new Set(offen)].join(", ") : "keine Apps"}.`,
    };
  }
  treffer.forEach((w) => store.closeWindow(w.id));
  return { ok: true, detail: `Geschlossen: ${treffer.map((w) => w.appId).join(", ")} (${treffer.length} Fenster).` };
}

function shellAusfuehren(action: string, args: Record<string, unknown>): Ergebnis | Promise<Ergebnis> {
  switch (action) {
    case "open_window":
      return shellOpenWindow(args as OpenWindowArgs);
    case "close_window":
      return shellCloseWindow(args);
    case "show_artifact":
      return shellShowArtifact(args as ShowArtifactArgs);
    case "navigate_to":
      return shellNavigateTo(args as NavigateToArgs);
    case "set_mobile_view":
      return shellSetMobileView(args);
    case "read_screen":
      return berichtVomSchirm();
    // Open an image/file in the viewer. This case was missing — clicking an
    // image tile in the chat (BlockRenderer) AND Clara's own
    // `claraos_action_open_in_viewer` silently fell into the default ("unknown
    // action"), so the image could not be opened from the chat.
    case "open_in_viewer": {
      const pfad = String(args.path ?? args.pfad ?? "");
      if (!pfad) return { ok: false, detail: "open_in_viewer ohne path — nichts geöffnet." };
      return betrachterZeigen(
        pfad,
        String(args.source ?? "nextcloud"),
        args.title !== undefined ? String(args.title) : undefined,
      );
    }
    // Open/close a tray popover: Clara can show the quick settings ("turn up
    // the volume") — and the E2E/demo remote control uses the same path
    // (action-bus pattern).
    // id: quick-settings | volume | connectivity | power | notifications |
    // calendar; empty/missing = close.
    case "set_tray_popover":
      useUIStore.getState().setTrayPopover(args.id ? String(args.id) : null);
      return { ok: true, detail: args.id ? `Popover ${args.id} offen.` : "Popover zu." };
    // Guide assistant: start tours from within the chat.
    case "start_tour":
      window.dispatchEvent(new CustomEvent("claraos-start-tour", {
        detail: { tourId: String(args.tour_id ?? "") },
      }));
      return { ok: true, detail: `Tour ${String(args.tour_id ?? "")} gestartet.` };
    case "show_tour":
      window.dispatchEvent(new CustomEvent("claraos-show-tour", {
        detail: { name: args.name, steps: args.steps },
      }));
      return { ok: true, detail: "Tour angezeigt." };
    default:
      console.debug("[shellAction] unknown action", action);
      return { ok: false, detail: `Die Shell kennt die Aktion "${action}" nicht.` };
  }
}

/**
 * Bus entry point: execute and report the result back as an `ack`.
 * Without this acknowledgement the caller only saw `delivered: N` — i.e.
 * "delivered to N browsers", which it wrongly read as "the user sees it".
 */
function shellAction(
  action: string,
  args: Record<string, unknown>,
  payload: ActionPayload,
): void {
  Promise.resolve()
    .then(() => shellAusfuehren(action, args))
    .catch((err): Ergebnis => {
      console.error("[shellAction] warf", err);
      return { ok: false, detail: `Fehler in der Oberflaeche: ${String(err)}` };
    })
    .then((ergebnis) => meldeErgebnis(payload, ergebnis.ok, ergebnis.detail));
}

let installed = false;

/** Install the shell action handler. Idempotent. */
/** Run a shell action locally — the result card uses this to replay "Open"
 *  (the same action that Clara had triggered). */
export async function ausfuehrenLokal(action: string, args: Record<string, unknown>): Promise<Ergebnis> {
  try {
    return await shellAusfuehren(action, args);
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

export function installShellActionHandler(): void {
  if (installed) return;
  installed = true;
  registerActionHandler("shell", shellAction);
}
