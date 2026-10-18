import { useEffect } from "react";
import {
  useWindowsStore, useUIStore, useAuthStore, useAppCenterStore, useAppRegistryStore,
  useSettingsStore, commandForEvent, type BindingMap,
} from "@claraos/core";
import { getSnapBounds } from "@claraos/core/wm/useSnapToEdge";
import { openAltTab, cycleAltTab, commitAltTab, closeAltTab } from "./Window/AltTabSwitcher";

/**
 * Global keyboard shortcuts for ClaraOS.
 * Win+←/→ = snap left/right
 * Win+↑ = maximize
 * Win+↓ = restore/minimize
 * Alt+Tab = cycle windows (basic)
 */
/**
 * Run rebindable commands from the registry.
 *
 * Deliberately NOT here: Alt+Tab, Win alone and Win+, — they depend on key
 * states (hold/release), not on a combination, and therefore stay further down
 * in the event handling.
 */
function runCommand(id: string): boolean {
  const W = useWindowsStore.getState();
  switch (id) {
    case "open-files":
      W.openWindow("files", { title: "Dateien", width: 750, height: 520 });
      return true;
    case "open-settings":
      W.openWindow("settings", { title: "Einstellungen", width: 680, height: 520 });
      return true;
    case "open-search":
      window.dispatchEvent(new CustomEvent("claraos-toggle-search"));
      return true;
    case "open-clipboard":
      window.dispatchEvent(new CustomEvent("claraos-toggle-clipboard"));
      return true;
    case "quick-settings":
      // Toggle semantics live in the store (the same id closes it).
      useUIStore.getState().setTrayPopover("quick-settings");
      return true;
    case "screenshot":
      window.dispatchEvent(new CustomEvent("claraos-screenshot"));
      return true;
    case "show-desktop":
      W.toggleShowDesktop();
      return true;
    case "task-manager":
      W.openWindow("task-manager", { title: "Task-Manager", width: 720, height: 480 });
      return true;
    case "logout":
      useAuthStore.getState().logout();
      return true;
    default:
      return false;
  }
}

function userBindings(): BindingMap {
  const v = useSettingsStore.getState().values["shortcuts"]?.bindings;
  return (v as BindingMap) ?? {};
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { focusedWindowId, windows, maximizeWindow, restoreWindow, minimizeWindow, focusWindow, updatePositionAndSize, windowOrder } =
        useWindowsStore.getState();
      const { toggleStartMenu } = useUIStore.getState();

      // User bindings first: the registry only takes over when someone has
      // actually changed a shortcut. Otherwise the proven path below stays
      // unchanged — this keeps the special cases (window snapping with a focus
      // condition) untouched.
      const overrides = userBindings();
      if (Object.keys(overrides).length > 0) {
        const cmd = commandForEvent(e, overrides);
        if (cmd && runCommand(cmd)) {
          e.preventDefault();
          return;
        }
      }

      // Meta/Win key shortcuts
      if (e.metaKey || e.key === "Meta") {
        if (e.key === "ArrowLeft" && focusedWindowId) {
          e.preventDefault();
          const snap = getSnapBounds("left");
          if (snap) updatePositionAndSize(focusedWindowId, snap.x, snap.y, snap.width, snap.height);
          return;
        }
        if (e.key === "ArrowRight" && focusedWindowId) {
          e.preventDefault();
          const snap = getSnapBounds("right");
          if (snap) updatePositionAndSize(focusedWindowId, snap.x, snap.y, snap.width, snap.height);
          return;
        }
        if (e.key === "ArrowUp" && focusedWindowId) {
          e.preventDefault();
          maximizeWindow(focusedWindowId);
          return;
        }
        if (e.key === "ArrowDown" && focusedWindowId) {
          e.preventDefault();
          const win = windows[focusedWindowId];
          // Leave fullscreen first — otherwise there would be no way out of
          // the game desktop.
          if (win?.fullscreen) {
            useWindowsStore.getState().toggleWindowFullscreen(focusedWindowId);
            return;
          }
          if (win?.maximized) {
            restoreWindow(focusedWindowId);
          } else {
            minimizeWindow(focusedWindowId);
          }
          return;
        }

        const k = e.key.toLowerCase();

        // Win+E → Files
        if (k === "e") {
          e.preventDefault();
          useWindowsStore.getState().openWindow("files", { title: "Dateien", width: 750, height: 520 });
          return;
        }
        // Win+I → Settings
        if (k === "i") {
          e.preventDefault();
          useWindowsStore.getState().openWindow("settings", { title: "Einstellungen", width: 680, height: 520 });
          return;
        }
        // Win+L → Authentik logout
        if (k === "l") {
          e.preventDefault();
          useAuthStore.getState().logout();
          return;
        }
        // Win+D → Show-Desktop toggle (same as taskbar button)
        if (k === "d") {
          e.preventDefault();
          useWindowsStore.getState().toggleShowDesktop();
          return;
        }
        // Win+Q → Search overlay
        if (k === "q") {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("claraos-toggle-search"));
          return;
        }
        // Win+A → Quick Settings (also in the registry — this branch is the
        // default path without overrides)
        if (k === "a" && !e.shiftKey && !e.altKey && !e.ctrlKey) {
          e.preventDefault();
          useUIStore.getState().setTrayPopover("quick-settings");
          return;
        }
        // Win+Shift+S → Screenshot tool
        if (e.shiftKey && k === "s") {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("claraos-screenshot"));
          return;
        }
        // Win+V → Clipboard manager
        if (k === "v") {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("claraos-toggle-clipboard"));
          return;
        }
        // Win+1..9 → launch / focus pinned-app slot N
        if (/^[1-9]$/.test(e.key)) {
          e.preventDefault();
          const slot = parseInt(e.key, 10) - 1;
          const pinIds = useAppCenterStore.getState().pinnedAppIds;
          const id = pinIds[slot];
          if (!id) return;
          const app = useAppRegistryStore.getState().getApp(id);
          if (!app) return;
          const existing = Object.values(useWindowsStore.getState().windows).find((w) => w.appId === id);
          if (existing) {
            useWindowsStore.getState().focusWindow(existing.id);
          } else {
            useWindowsStore.getState().openWindow(id, {
              title: app.name,
              width: app.window.defaultWidth,
              height: app.window.defaultHeight,
              maximized: app.window.startMaximized,
              fullscreen: app.window.startFullscreen,
            });
          }
          return;
        }
        // Win+, → Aero-Peek hold (keydown)
        if (e.key === ",") {
          e.preventDefault();
          useWindowsStore.getState().setPeek(true);
          return;
        }
      }

      // Ctrl+Shift+Esc → Task-Manager
      if (e.ctrlKey && e.shiftKey && e.key === "Escape") {
        e.preventDefault();
        useWindowsStore.getState().openWindow("task-manager", {
          title: "Task-Manager", width: 720, height: 520,
        });
        return;
      }

      // Alt+Tab (with shift = backward): hold-mode visual switcher.
      // First Alt+Tab opens the overlay and pre-selects the next window;
      // each subsequent Tab while Alt is held cycles selection. Alt-release
      // commits the highlighted window to focus.
      if (e.altKey && e.key === "Tab") {
        e.preventDefault();
        const visibleOrder = windowOrder.filter((id) => !windows[id]?.minimized);
        if (visibleOrder.length < 2) return;
        // Suppress unused-var lint
        void focusWindow;
        const direction: 1 | -1 = e.shiftKey ? -1 : 1;
        if (!_altActive) {
          _altActive = true;
          openAltTab(direction);
        } else {
          cycleAltTab(direction);
        }
        return;
      }

      // Ctrl+W: close focused window
      if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        if (focusedWindowId) {
          useWindowsStore.getState().closeWindow(focusedWindowId);
        }
        return;
      }

      // Single Meta key press (on keyup) → toggle start menu
      // This is handled separately to avoid conflicts
    };

    const metaHandler = (e: KeyboardEvent) => {
      // Meta key alone (no combo) → toggle StartMenu
      if (e.key === "Meta" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        // Check if it was a solo press (no other keys during the press)
        toggleStartMenu();
      }
    };

    // Track if Meta was pressed alone
    let metaAlone = false;
    const downHandler = (e: KeyboardEvent) => {
      if (e.key === "Meta") metaAlone = true;
      else metaAlone = false;
      handler(e);
    };
    const upHandler = (e: KeyboardEvent) => {
      if (e.key === "Meta" && metaAlone) {
        useUIStore.getState().toggleStartMenu();
      }
      metaAlone = false;
      // Win+, peek release
      if (e.key === ",") {
        useWindowsStore.getState().setPeek(false);
      }
      // Releasing Meta also clears any active peek so the user can't get stuck
      if (e.key === "Meta") {
        useWindowsStore.getState().setPeek(false);
      }
      // Alt-release commits the Alt+Tab switcher selection
      if (e.key === "Alt" && _altActive) {
        _altActive = false;
        commitAltTab();
      }
      // Escape closes the switcher without committing
      if (e.key === "Escape" && _altActive) {
        _altActive = false;
        closeAltTab();
      }
    };

    window.addEventListener("keydown", downHandler);
    window.addEventListener("keyup", upHandler);
    return () => {
      window.removeEventListener("keydown", downHandler);
      window.removeEventListener("keyup", upHandler);
    };
  }, []);
}

// Module-local — survives function re-renders, used by Alt+Tab hold-mode
let _altActive = false;
