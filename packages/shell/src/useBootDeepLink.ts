import { useEffect } from "react";
import { useAppRegistryStore } from "@claraos/core";
import { dispatchWhenReady } from "./Chat/actionBus";

/** Reserved parameters — everything else becomes an argument of the action. */
const RESERVED = new Set(["app", "chat", "do"]);

export interface ShellDeepLink {
  appId: string;
  action?: string;
  args: Record<string, unknown>;
}

/**
 * Does a URL point at this shell (`…/?app=<id>[&do=<action>&<arg>=…]`)?
 * If so, return its target — the same convention as the boot deep link.
 * ntfy notifications from monitors and services often carry only such a `click`
 * URL; opening it via `window.open` would create a new tab (desktop) or do
 * nothing at all (companion WebView without multi-window). Instead it is
 * handled inside the running shell.
 */
export function parseShellDeepLink(url: string): ShellDeepLink | null {
  let u: URL;
  try {
    u = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  const eigeneHost = u.host === window.location.host || /(^|\.)claraos\.de$/i.test(u.hostname);
  if (!eigeneHost) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  const appId = u.searchParams.get("app");
  if (!appId || !/^[a-z0-9_-]{1,64}$/i.test(appId)) return null;
  const doAction = u.searchParams.get("do");
  const action = doAction && /^[a-z0-9_]{1,64}$/i.test(doAction) ? doAction : undefined;
  const args: Record<string, unknown> = {};
  if (action) {
    u.searchParams.forEach((v, k) => {
      if (RESERVED.has(k)) return;
      args[k] = /^-?\d+$/.test(v) ? Number(v) : v;
    });
  }
  return { appId, action, args };
}

/** Event that opens the Clara chat; `detail.chatId` (optional) names the chat.
 *  Desktop: StartMenu listens; mobile: MobileShell. */
export const OPEN_CLARA_CHAT_EVENT = "claraos-open-clara-chat";

const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `?chat=1` (just open) or `?chat=<id>` (open that chat) -> the chat id, "" or null. */
function chatParam(value: string | null): string | null {
  if (!value) return null;
  if (value === "1") return "";
  return CHAT_ID_RE.test(value) ? value : "";
}

/**
 * Does a URL of this shell point at the Clara chat (`…/?chat=1` or
 * `…/?chat=<chat id>`)? Returns `{ chatId }` ("" = just open the chat) or null.
 * Used for job notifications: the click leads into the chat where the job ran.
 */
export function parseChatDeepLink(url: string): { chatId: string } | null {
  let u: URL;
  try {
    u = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  const eigeneHost = u.host === window.location.host || /(^|\.)claraos\.de$/i.test(u.hostname);
  if (!eigeneHost || (u.pathname !== "/" && u.pathname !== "")) return null;
  if (u.searchParams.get("app")) return null;
  const chatId = chatParam(u.searchParams.get("chat"));
  return chatId === null ? null : { chatId };
}

/** Open the Clara chat — a specific one if `chatId` is given. */
export function openClaraChat(chatId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_CLARA_CHAT_EVENT, { detail: { chatId: chatId || undefined } }));
}

/**
 * Boot deep link: `?app=<appId>` in the shell URL opens the app after loading —
 * the convention of ntfy click URLs (backend services such as routines.py:
 * `{CLARAOS_PUBLIC_URL}/?app=<id>`). `?chat=1` opens the Clara chat instead
 * (desktop: start menu chat, mobile: ClaraOverlay), `?chat=<chat id>` opens that
 * chat (job notifications). The parameters are removed
 * from the URL immediately (no re-open on reload); we wait up to 30 s for the
 * asynchronously loaded app registry.
 */
export function useBootDeepLink(launch: (appId: string) => void, openChat?: (chatId?: string) => void) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const appId = params.get("app");
    const chat = params.get("chat");
    const appValid = !!appId && /^[a-z0-9_-]{1,64}$/i.test(appId);
    if (!appValid && !chat) return;

    // `&do=<action>` plus free parameters as arguments — so a notification leads
    // not just into the app but to the specific object:
    //   /?app=planner&do=open_task&task_id=75
    const doAction = params.get("do");
    const doValid = !!doAction && /^[a-z0-9_]{1,64}$/i.test(doAction);
    const doArgs: Record<string, unknown> = {};
    if (doValid) {
      params.forEach((v, k) => {
        if (RESERVED.has(k)) return;
        doArgs[k] = /^-?\d+$/.test(v) ? Number(v) : v;
      });
    }

    params.delete("app");
    params.delete("chat");
    params.delete("do");
    if (doValid) Object.keys(doArgs).forEach((k) => params.delete(k));
    const qs = params.toString();
    window.history.replaceState(
      null, "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );

    const chatId = chatParam(chat);
    if (chatId !== null && openChat) openChat(chatId || undefined);
    if (!appValid || !appId) return;

    const tryLaunch = () => {
      if (!useAppRegistryStore.getState().getApp(appId)) return false;
      launch(appId);
      // The handler only takes effect once the app is actually mounted — on a
      // cold start via a link that takes seconds, not milliseconds.
      if (doValid && doAction) dispatchWhenReady(appId, doAction, doArgs);
      return true;
    };
    if (tryLaunch()) return;
    const unsub = useAppRegistryStore.subscribe(() => {
      if (tryLaunch()) {
        unsub();
        clearTimeout(giveUp);
      }
    });
    const giveUp = setTimeout(unsub, 30_000);
    return () => { clearTimeout(giveUp); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
