/**
 * Wrapp action handler — bridges Action-Bus messages to the local wrapp
 * store mutations. Registered at Shell level for every registered wrapp manifest
 * (the manifest id is the action-bus app id).
 *
 * Supported actions (from a wrapp app's MCP tools):
 *   * select_node       args: { instance_id, node_id }
 *   * set_active_tab    args: { instance_id, tab, object_id? }
 *   * add_child_node    args: { instance_id, parent_id, child: SharedObjectNode }
 *   * update_node_meta  args: { instance_id, node_id, key, value }
 *
 * Also handles a generic `app_id="files"` action `refresh_tree` so that the
 * file-browser reloads after a Clara file mutation.
 */
import { useFileStore, useUIStore, useWrappStore, useIframeAppStore, type SharedObjectNode, getBrand } from "@claraos/core";
import { meldeErgebnis, registerActionHandler, registerFallbackActionHandler, type ActionPayload } from "./actionBus";
import { dispatchToIframe, iframeTargetOrigin } from "./iframeBridge";
import { ausfuehrenLokal, installShellActionHandler, type Ergebnis } from "./shellActionHandler";

/**
 * Find the window-id of a wrapp instance — used to deliver
 * postMessage to the right iframe.
 */
function windowIdForInstance(instanceId: string): string | null {
  const inst = useWrappStore.getState().instances[instanceId];
  return inst?.windowId ?? null;
}

/**
 * Post a typed message to the iframe inside a window content. We look up the
 * iframe by data-window-id attribute; the WrappContainer (and other
 * iframe-apps) render `<iframe data-window-id={windowId}>`.
 */
function postToIframe(windowId: string, message: Record<string, unknown>): boolean {
  const iframe = document.querySelector<HTMLIFrameElement>(
    `iframe[data-window-id="${CSS.escape(windowId)}"]`,
  );
  if (!iframe || !iframe.contentWindow) return false;
  iframe.contentWindow.postMessage(message, iframeTargetOrigin(iframe));
  return true;
}

function wrappAction(action: string, args: Record<string, unknown>): void {
  const store = useWrappStore.getState();

  // notify is instance-agnostic — pipe straight to the global notification
  // store without requiring a wrapp-instance.
  if (action === "notify") {
    const message = String(args.message ?? "");
    const title = String(args.title ?? getBrand().assistant);
    if (!message) return;
    useUIStore.getState().addNotification({ title, body: message, icon: "🤖" });
    return;
  }

  const instanceId = String(args.instance_id ?? "");
  if (!instanceId) {
    console.warn("[wrappAction] missing instance_id", action, args);
    return;
  }

  switch (action) {
    case "select_node": {
      const nodeId = (args.node_id ?? null) as string | null;
      store.setSelectedNode(instanceId, nodeId);
      return;
    }
    case "set_active_tab": {
      const tab = String(args.tab ?? "");
      const objectId = args.object_id ? String(args.object_id) : "";
      if (objectId) {
        store.setActiveTabForObject(instanceId, objectId, tab);
      } else {
        store.setActiveTab(instanceId, tab);
      }
      return;
    }
    case "add_child_node": {
      const parentId = String(args.parent_id ?? "");
      const child = args.child as SharedObjectNode | undefined;
      if (!parentId || !child || !child.id) {
        console.warn("[wrappAction] add_child_node bad args", args);
        return;
      }
      store.addChildNode(instanceId, parentId, child);
      return;
    }
    case "update_node_meta": {
      const nodeId = String(args.node_id ?? "");
      const key = String(args.key ?? "");
      const value = args.value;
      if (!nodeId || !key) {
        console.warn("[wrappAction] update_node_meta bad args", args);
        return;
      }
      store.updateNodeMeta(instanceId, nodeId, key, value);
      return;
    }
    case "load_in_tab": {
      // Switch to the target tab AND postMessage the payload into the iframe.
      const tab = String(args.tab ?? "");
      const payload = args.payload as Record<string, unknown> | undefined;
      const objectId = args.object_id ? String(args.object_id) : "";
      if (!tab) {
        console.warn("[wrappAction] load_in_tab missing tab", args);
        return;
      }
      if (objectId) {
        store.setActiveTabForObject(instanceId, objectId, tab);
      } else {
        store.setActiveTab(instanceId, tab);
      }
      const winId = windowIdForInstance(instanceId);
      if (winId && payload) {
        // Brief delay so React renders the new tab + iframe before postMessage
        setTimeout(() => {
          postToIframe(winId, { type: "claraos:load", tab, payload });
        }, 80);
      }
      return;
    }
    default:
      console.debug("[wrappAction] unknown action", action);
  }
}

/** Poll until `bedingung` holds or `ms` elapse. Returns whether it held. */
async function warteBis(bedingung: () => boolean, ms: number): Promise<boolean> {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (bedingung()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return bedingung();
}

/**
 * Drive the Files-app to a folder and optionally select a file.
 *
 * This used to only mutate the file store: with no Files window open nothing
 * appeared on screen, and it never acknowledged — so every call came back as
 * `rendered: 0` and Clara retried the same dead end. Now it opens (or raises)
 * the window, waits for the listing and reports what the user actually sees.
 */
async function filesNavigieren(args: Record<string, unknown>): Promise<Ergebnis> {
  const fenster = await ausfuehrenLokal("open_window", { app_id: "files" });
  if (!fenster.ok) return fenster;
  const store = useFileStore;
  const source = String(args.source || store.getState().activeSource);
  const roh = String(args.path ?? "/").trim() || "/";
  const path = roh.startsWith("/") ? roh : `/${roh}`;
  const ziel = path.replace(/\/+$/, "") || "/";
  const amZiel = () => {
    const s = store.getState();
    return !s.loading && s.activeSource === source && (s.currentPath.replace(/\/+$/, "") || "/") === ziel;
  };

  // navigateTo also cancels the Files-app's pending session restore, which
  // would otherwise land after us on a freshly opened window.
  store.getState().navigateTo(source, path);
  await new Promise((r) => setTimeout(r, 150));
  await warteBis(amZiel, 3500);

  const s = store.getState();
  if (s.error) {
    return { ok: false, detail: `Dateien-App zeigt einen Fehler für ${source}:${path}: ${s.error.message}` };
  }
  if (!amZiel()) {
    return { ok: false, detail: `Dateien-App hat ${source}:${path} nicht rechtzeitig geladen — nichts behaupten.` };
  }

  const kinder = s.tree?.children ?? [];
  const select = String(args.select_filename ?? "").trim();
  if (!select) {
    return { ok: true, detail: `Dateien-App zeigt ${source}:${path} (${kinder.length} Einträge).` };
  }
  // Callers often pass a partial name — accept an exact match first, then a
  // single unambiguous partial match.
  const klein = select.toLowerCase();
  const exakt = kinder.find((c) => c.name === select);
  const teil = kinder.filter((c) => c.name.toLowerCase().includes(klein));
  const treffer = exakt ?? (teil.length === 1 ? teil[0] : undefined);
  if (!treffer) {
    const namen = (teil.length ? teil : kinder).slice(0, 8).map((c) => c.name).join(", ");
    return {
      ok: false,
      detail: `Ordner ${path} ist offen, aber "${select}" ist ${teil.length > 1 ? "nicht eindeutig" : "nicht darin"}. `
        + `${teil.length > 1 ? "Kandidaten" : "Einträge"}: ${namen || "(leer)"}.`,
    };
  }
  s.selectFile(treffer.path, "single");
  return {
    ok: true,
    detail: `Dateien-App zeigt ${path}, "${treffer.name}" ist markiert (nicht geöffnet). `
      + "Zum Anzeigen des Inhalts claraos_action_open_in_viewer verwenden.",
  };
}

async function filesAusfuehren(action: string, args: Record<string, unknown>): Promise<Ergebnis> {
  if (action === "refresh_tree") {
    const fs = useFileStore.getState();
    const source = (args.source as string | undefined) ?? fs.activeSource;
    const path = (args.path as string | undefined) ?? fs.currentPath;
    await fs.loadTree(source, path).catch(() => undefined);
    return { ok: true, detail: `Dateiliste ${source}:${path} neu geladen.` };
  }
  if (action === "navigate") return filesNavigieren(args);
  return { ok: false, detail: `Die Dateien-App kennt die Aktion "${action}" nicht.` };
}

function filesAction(action: string, args: Record<string, unknown>, payload: ActionPayload): void {
  filesAusfuehren(action, args)
    .catch((err): Ergebnis => ({ ok: false, detail: `Fehler in der Dateien-App: ${String(err)}` }))
    .then((e) => meldeErgebnis(payload, e.ok, e.detail));
}

/**
 * Generic fallback for app_ids that aren't natively handled — forwards the
 * action to a registered iframe-bridge if one is open for the target window.
 * Useful for nextcloud-files / code-server / etc. once they ship the helper.
 */
function iframeFallback(action: string, args: Record<string, unknown>): void {
  const windowId = String(args.window_id ?? args.windowId ?? "");
  if (windowId) {
    if (dispatchToIframe(windowId, action, args)) return;
  }
  // No window_id provided — attempt to broadcast to any iframe whose appId
  // matches `args.app_id`-or-similar; for V1 just log and skip.
  const apps = useIframeAppStore.getState().apps;
  for (const [winId, info] of Object.entries(apps)) {
    if (info.appId && info.appId === args.app_id) {
      dispatchToIframe(winId, action, args);
      return;
    }
  }
  console.debug("[iframeFallback] no target iframe found for action", action);
}

let installed = false;

/** Install the handlers once at app startup. Idempotent. */
export function installAppActionHandlers(): void {
  if (installed) return;
  installed = true;
  // Every wrapp manifest, now and registered later, routes to the wrapp store.
  const handled = new Set<string>();
  const registerWrapps = (ids: string[]) => {
    for (const id of ids) {
      if (handled.has(id)) continue;
      handled.add(id);
      registerActionHandler(id, wrappAction);
    }
  };
  registerWrapps(useWrappStore.getState().manifests.map((m) => m.id));
  useWrappStore.subscribe((s) => registerWrapps(s.manifests.map((m) => m.id)));
  registerActionHandler("files", filesAction);
  registerFallbackActionHandler(iframeFallback);
  // Context-aware Clara: shell-level open_window/show_artifact
  installShellActionHandler();
}
