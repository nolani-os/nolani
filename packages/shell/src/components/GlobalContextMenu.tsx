/**
  * GlobalContextMenu — the shell-wide right-click safety net.
 *
 * Everywhere a component has NO specific context menu, the native browser
 * menu used to appear. This listener (document, bubble phase) catches every
 * unhandled right-click and shows a ClaraOS menu instead. Resolution order:
 *
 *   1. e.defaultPrevented          → a Radix menu already handled it, do nothing
 *   2. input/textarea/contenteditable/[data-native-menu]
 *                                  → keep the NATIVE menu (paste/spellcheck
 *                                    only work reliably through it)
 *   3. [data-ctx="…"]              → element-specific items (e.g. tray bell)
 *   4. [data-window-id]            → window actions (min/max/close)
 *   5. [data-shell-part="taskbar"] → taskbar items
 *   6. otherwise                   → generic ClaraOS menu
 *
 * Iframe caveat: right-clicks INSIDE cross-origin iframes never reach this
 * document — embedded apps keep their own menus (structural browser limit).
 */
import { useCallback, useEffect, useState } from "react";
import { useUIStore, useWindowsStore } from "@claraos/core";
import { PopupMenu } from "./PopupMenu";
import type { ContextMenuItem } from "./WindowContextMenu";
import { isFullscreen, toggleFullscreen } from "../fullscreen";

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

function openApp(appId: string, title: string, width = 900, height = 640) {
  useWindowsStore.getState().openWindow(appId, { title, width, height });
}

/** Fullscreen entry: in a browser tab only allowed via a user gesture —
 *  the context menu IS the gesture. */
function fullscreenItem(): ContextMenuItem {
  return {
    id: "fullscreen",
    label: isFullscreen() ? "Vollbild beenden" : "Vollbild",
    icon: isFullscreen() ? "🗗" : "⛶",
    shortcut: "F11",
    onSelect: () => void toggleFullscreen(),
  };
}

function genericItems(): ContextMenuItem[] {
  return [
    { id: "settings", label: "Einstellungen", icon: "⚙", onSelect: () => openApp("settings", "Einstellungen") },
    { id: "taskman", label: "Task-Manager", icon: "📊", onSelect: () => openApp("task-manager", "Task-Manager", 760, 560) },
    { id: "sep", label: "---" },
    fullscreenItem(),
    { id: "reload", label: "ClaraOS neu laden", onSelect: () => window.location.reload() },
  ];
}

function taskbarItems(): ContextMenuItem[] {
  return [
    { id: "start", label: "Startmenü öffnen", icon: "✦", onSelect: () => useUIStore.getState().toggleStartMenu() },
    { id: "taskman", label: "Task-Manager", icon: "📊", onSelect: () => openApp("task-manager", "Task-Manager", 760, 560) },
    { id: "sep", label: "---" },
    fullscreenItem(),
    { id: "settings", label: "Einstellungen", icon: "⚙", onSelect: () => openApp("settings", "Einstellungen") },
  ];
}

function windowItems(windowId: string): ContextMenuItem[] {
  const ws = useWindowsStore.getState();
  return [
    { id: "min", label: "Minimieren", onSelect: () => ws.minimizeWindow(windowId) },
    { id: "max", label: "Maximieren/Wiederherstellen", onSelect: () => ws.toggleMaximize(windowId) },
    { id: "sep", label: "---" },
    { id: "close", label: "Schließen", shortcut: "Strg+W", variant: "destructive", onSelect: () => ws.closeWindow(windowId) },
  ];
}

/** Edit menu for text inputs (replaces the native browser menu).
 *  Paste uses the async Clipboard API; on plain-http test hosts it fails,
 *  then we hint at Strg+V instead of silently doing nothing. */
function editItems(el: HTMLInputElement | HTMLTextAreaElement): ContextMenuItem[] {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const hasSelection = end > start;
  const readOnly = el.readOnly || el.disabled;
  const fireInput = () => el.dispatchEvent(new Event("input", { bubbles: true }));
  return [
    {
      id: "cut",
      label: "Ausschneiden",
      shortcut: "Strg+X",
      disabled: !hasSelection || readOnly,
      onSelect: () => {
        const sel = el.value.slice(start, end);
        navigator.clipboard?.writeText(sel).catch(() => undefined);
        el.setRangeText("", start, end, "start");
        fireInput();
        el.focus();
      },
    },
    {
      id: "copy",
      label: "Kopieren",
      shortcut: "Strg+C",
      disabled: !hasSelection,
      onSelect: () => {
        navigator.clipboard?.writeText(el.value.slice(start, end)).catch(() => undefined);
        el.focus();
      },
    },
    {
      id: "paste",
      label: "Einfügen",
      shortcut: "Strg+V",
      disabled: readOnly,
      onSelect: async () => {
        try {
          const text = await navigator.clipboard.readText();
          el.setRangeText(text, start, end, "end");
          fireInput();
        } catch {
          useUIStore.getState().addNotification({
            title: "Einfügen nicht möglich",
            body: "Bitte Strg+V benutzen — der Browser erlaubt hier keinen Zwischenablage-Zugriff.",
            icon: "📋",
          });
        }
        el.focus();
      },
    },
    { id: "sep", label: "---" },
    {
      id: "select-all",
      label: "Alles auswählen",
      shortcut: "Strg+A",
      disabled: !el.value,
      onSelect: () => {
        el.focus();
        el.select();
      },
    },
  ];
}

/** Element-specific menus, declared via data-ctx="<id>" on the element. */
function ctxItems(ctxId: string): ContextMenuItem[] | null {
  switch (ctxId) {
    case "tray-bell":
      return [
        { id: "clear", label: "Alle Benachrichtigungen löschen", onSelect: () => useUIStore.getState().clearNotifications() },
      ];
    case "tray-clock":
      return [
        {
          id: "copy-date",
          label: "Datum kopieren",
          onSelect: () => {
            const d = new Date().toLocaleString("de-DE");
            navigator.clipboard?.writeText(d).catch(() => undefined);
          },
        },
      ];
    default:
      return null;
  }
}

export function GlobalContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const handler = useCallback((e: MouseEvent) => {
    // 1. A specific (Radix) menu already handled this right-click.
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // 2. Escape hatches keep the NATIVE menu: explicitly marked elements and
    //    contenteditable surfaces (Monaco/xterm bring their own handling).
    if (target.closest('[data-native-menu], [contenteditable="true"]')) {
      return;
    }
    // Text inputs get a ClaraOS EDIT menu (instead of the native one).
    const inputEl = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    if (inputEl) {
      if (inputEl instanceof HTMLInputElement) {
        const t = (inputEl.type || "text").toLowerCase();
        if (!["text", "search", "url", "email", "tel", "password", "number"].includes(t)) return;
      }
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, items: editItems(inputEl) });
      return;
    }
    e.preventDefault();

    // 3-6. Resolve the most specific ClaraOS menu.
    let items: ContextMenuItem[] | null = null;
    const ctxEl = target.closest<HTMLElement>("[data-ctx]");
    if (ctxEl?.dataset.ctx) items = ctxItems(ctxEl.dataset.ctx);
    if (!items) {
      const winEl = target.closest<HTMLElement>("[data-window-id]");
      if (winEl?.dataset.windowId) items = windowItems(winEl.dataset.windowId);
    }
    if (!items && target.closest('[data-shell-part="taskbar"]')) items = taskbarItems();
    if (!items) items = genericItems();

    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  useEffect(() => {
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, [handler]);

  if (!menu) return null;
  return <PopupMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />;
}
