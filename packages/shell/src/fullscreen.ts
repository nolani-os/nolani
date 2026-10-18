// Fullscreen toggle. In installed PWA mode the manifest (display: fullscreen)
// controls startup; in a normal browser tab the platform forbids automatic
// fullscreen — there it works ONLY via a real user gesture. Hence this helper:
// context menu entry + F11 or Ctrl/Cmd+Shift+F.

const KEY = "claraos:fullscreenPreferred";

export function isFullscreen(): boolean {
  return document.fullscreenElement != null;
}

export async function toggleFullscreen(): Promise<boolean> {
  try {
    if (isFullscreen()) {
      await document.exitFullscreen();
      localStorage.setItem(KEY, "0");
      return false;
    }
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    localStorage.setItem(KEY, "1");
    return true;
  } catch {
    return isFullscreen();
  }
}

/** Remembers the preference: after reload/restart, the FIRST click/tap
 *  switches back to fullscreen (the browser requires the gesture). */
export function installFullscreenRestore(): void {
  if (localStorage.getItem(KEY) !== "1") return;
  const restore = () => {
    if (!isFullscreen()) void document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
    window.removeEventListener("pointerdown", restore);
    window.removeEventListener("keydown", restore);
  };
  window.addEventListener("pointerdown", restore, { once: true });
  window.addEventListener("keydown", restore, { once: true });
}

export function installFullscreenHotkey(): void {
  window.addEventListener("keydown", (e) => {
    const combo =
      e.key === "F11" ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "F" || e.key === "f"));
    if (!combo) return;
    e.preventDefault();
    void toggleFullscreen();
  });
}
