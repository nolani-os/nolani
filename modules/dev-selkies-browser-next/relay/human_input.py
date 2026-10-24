"""OS-level input inside the user's own Selkies browser: pointer via X, keyboard via Wayland.

WHY THIS EXISTS
---------------
The assistant fills in forms in the signed-in user's own browser, on the user's
request. CDP `Input.dispatchMouseEvent` creates events *inside* the browser, and some
pages do not accept such synthetic events: a form then fails with a generic error.

This module delivers input one level lower, the same way the user's own input
arrives through the Selkies stream: Chromium receives ordinary pointer and keyboard
events.

KEY PROPERTY: **two paths, not one**
   Chromium runs here as a **Wayland** client (`--ozone-platform=wayland` under labwc),
   next to an X server. Consequently:
   - **Pointer:** `xdotool` (X/XTEST) works, clicks arrive.
   - **Keyboard:** `xdotool` does NOT reach the browser. The X input focus sits on the
     pseudo window `1`, and even after `windowfocus` typed keys have no effect.
     **`wtype`** (Wayland virtual keyboard) is required.
   The failure mode is deceptive: the mouse visibly works while the keyboard stays
   silent, so one tends to suspect the coordinates instead of the protocol.

PITFALLS
   1. **Compositor focus**: `wtype` delivers to the surface the compositor has focused,
      not to "the browser". After opening a new tab, keystrokes land **nowhere**, not
      even in the old tab. `element.focus()` (DOM) and `tabs.activate` do NOT help:
      that is focus *within* the page.
      ⇒ **`wlrctl toplevel focus app_id:chromium`** before every input (`focus_window`).
   2. **Lost characters**: a `wtype` call with several characters delivers only the
      first ~3, regardless of `-d`.
      ⇒ **One call per character.**
   3. **Known limitation**: after a container restart the keyboard channel works
      reliably; after prolonged use it can stop delivering keys on every page (the
      page receives no `keydown` events at all, while DOM focus, window focus and
      `wlrctl` all look correct). Ruled out: number of `wtype` processes, navigation
      within or across domains, CDP mouse clicks. The cause is not known. Working rule:
      fill a form in one go, ideally soon after a container restart.

ACCESS
------
- The X server has **no** `.Xauthority`; it admits the user **`abc`**. Setting
  `XAUTHORITY` does not help, **as root it fails** ("Authorization required").
  The relay runs as root ⇒ `setpriv --reuid=abc`.
- `wtype` needs `XDG_RUNTIME_DIR=/config/.XDG` + `WAYLAND_DISPLAY=wayland-0`.
- `/dev/uinput` is missing ⇒ ydotool is not an option.

SECURITY
--------
This path types into a browser with signed-in sessions, therefore:
- **No shell invocation**: always `exec` with an argument list. Typed text never ends up
  in a command line that something interprets.
- **Key names are allowlisted**, otherwise a typing command could reach `ctrl+shift+q`
  (quit the browser) or `ctrl+alt+F2` (VT switch).
- Text length is limited, every call has a timeout.
- Passwords are passed through but **never logged** (see `type_text`).
"""
from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger(__name__)

DISPLAY = ":0"
XUSER = "abc"
WL_RUNTIME = os.environ.get("CLARAOS_WL_RUNTIME", "/config/.XDG")
WL_DISPLAY = os.environ.get("CLARAOS_WL_DISPLAY", "wayland-0")
MAX_TEXT = 4096
TIMEOUT = 20

# The keys a form needs, nothing more. Values are wtype syntax:
# ("keysym",) for single keys, ("mod", "keysym") for combinations.
ALLOWED_KEYS: dict[str, tuple[str, ...]] = {
    "Return": ("Return",), "Tab": ("Tab",), "Escape": ("Escape",),
    "BackSpace": ("BackSpace",), "Delete": ("Delete",), "space": ("space",),
    "Home": ("Home",), "End": ("End",), "Up": ("Up",), "Down": ("Down",),
    "Left": ("Left",), "Right": ("Right",),
    "Page_Up": ("Prior",), "Page_Down": ("Next",),
    "ctrl+a": ("ctrl", "a"), "ctrl+c": ("ctrl", "c"), "ctrl+v": ("ctrl", "v"),
    "shift+Tab": ("shift", "Tab"),
}
_ALIASES = {"enter": "Return", "esc": "Escape", "escape": "Escape",
            "backspace": "BackSpace", "del": "Delete", "delete": "Delete",
            "tab": "Tab", "home": "Home", "end": "End"}


class InputError(RuntimeError):
    pass


async def _run(cmd: list[str], timeout: int = TIMEOUT, quiet_err: bool = False) -> str:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise InputError(f"Zeitüberschreitung: {cmd[-2] if len(cmd) > 1 else cmd[0]}")
    if proc.returncode != 0:
        # stderr may contain typed text: show nothing for keyboard calls.
        detail = "" if quiet_err else (err or b"").decode(errors="replace").splitlines()[:1]
        raise InputError(f"Eingabe fehlgeschlagen (rc={proc.returncode}) {detail}")
    return (out or b"").decode(errors="replace").strip()


def _as_abc(*cmd: str) -> list[str]:
    return ["setpriv", "--reuid=" + XUSER, "--regid=" + XUSER, "--clear-groups", *cmd]


async def _xdo(*args: str, timeout: int = TIMEOUT) -> str:
    """Pointer/window via X."""
    return await _run(_as_abc("env", "DISPLAY=" + DISPLAY, "xdotool", *args), timeout)


async def _wtype(*args: str, timeout: int = TIMEOUT) -> str:
    """Keyboard via Wayland. Error output is suppressed (it could contain text)."""
    return await _run(
        _as_abc("env", "XDG_RUNTIME_DIR=" + WL_RUNTIME, "WAYLAND_DISPLAY=" + WL_DISPLAY,
                "wtype", *args), timeout, quiet_err=True)


# ── Geometry ─────────────────────────────────────────────────────────────────

async def screen_size() -> tuple[int, int]:
    w, h = (await _xdo("getdisplaygeometry")).split()
    return int(w), int(h)


async def browser_window() -> dict:
    """Geometry of the browser window.

    Do NOT search via `--class chromium`: the window has **no WM_CLASS** here, so the
    class search returns nothing. Use the largest visible window instead; labwc pins
    the browser full-screen at 0,0 anyway.
    """
    ids = (await _xdo("search", "--onlyvisible", "--classname", "")).split()
    best = None
    for wid in ids:
        try:
            geo = await _xdo("getwindowgeometry", "--shell", wid)
        except InputError:
            continue
        v = dict(line.split("=", 1) for line in geo.splitlines() if "=" in line)
        win = {"id": wid, "x": int(v["X"]), "y": int(v["Y"]),
               "w": int(v["WIDTH"]), "h": int(v["HEIGHT"])}
        if best is None or win["w"] * win["h"] > best["w"] * best["h"]:
            best = win
    if best is None:
        raise InputError("kein sichtbares Fenster gefunden")
    return best


async def viewport_origin(viewport_w: int, viewport_h: int) -> tuple[int, int]:
    """Offset from page coordinates to screen coordinates.

    Solvable without free JS: xdotool knows the window size, the relay supplies the
    viewport size (`tabs.thumb` IS the viewport). The difference is the height of the
    browser bars, so there is no hard-coded value that breaks with the next Chromium
    update. Example: window 1920×856, viewport 1920×732 ⇒ offset (0, 124).
    """
    win = await browser_window()
    return win["x"] + max(0, (win["w"] - viewport_w) // 2), win["y"] + (win["h"] - viewport_h)


# ── Pointer ──────────────────────────────────────────────────────────────────

async def move(x: int, y: int, steps: int = 12, ms: int = 12) -> None:
    """Move the pointer in small steps, like a user's pointer.

    Pages react to hover (menus, buttons that appear on hover); a single jump to the
    target can skip those states, so the pointer passes intermediate points.
    """
    steps = max(1, min(steps, 60))
    cur = await _xdo("getmouselocation", "--shell")
    v = dict(line.split("=", 1) for line in cur.splitlines() if "=" in line)
    x0, y0 = int(v.get("X", x)), int(v.get("Y", y))
    for i in range(1, steps + 1):
        await _xdo("mousemove", str(x0 + (x - x0) * i // steps),
                   str(y0 + (y - y0) * i // steps))
        await asyncio.sleep(ms / 1000)


async def click(x: int, y: int, button: int = 1, settle: float = 0.25) -> None:
    await move(x, y)
    await asyncio.sleep(settle)
    await _xdo("click", str(int(button)))
    await asyncio.sleep(settle)


# ── Keyboard ─────────────────────────────────────────────────────────────────

async def type_text(text: str, delay_ms: int = 90) -> int:
    """Type text. The content is NOT logged (passwords!).

    The delay is needed: typing too fast loses keystrokes.
    """
    if not isinstance(text, str) or not text:
        raise InputError("leerer Text")
    if len(text) > MAX_TEXT:
        raise InputError(f"Text zu lang ({len(text)} > {MAX_TEXT})")
    d = max(20, min(delay_ms, 400))
    await focus_window()
    # ONE call per character, see module docstring, pitfall 2. A combined call loses
    # everything after the third character, silently and regardless of `-d`.
    for ch in text:
        await _wtype("--", ch)
        await asyncio.sleep(d / 1000)
    logger.info("human.type: %d Zeichen", len(text))
    return len(text)


async def _wlrctl(*args: str, timeout: int = TIMEOUT) -> str:
    return await _run(
        _as_abc("env", "XDG_RUNTIME_DIR=" + WL_RUNTIME, "WAYLAND_DISPLAY=" + WL_DISPLAY,
                "wlrctl", *args), timeout)


async def focus_window(app_id: str = "chromium") -> str:
    """Put the compositor's keyboard focus on the browser window.

    Without it, typing goes nowhere (see module docstring, pitfall 1), and silently:
    `wtype` reports success but the characters land nowhere. Hence BEFORE every input.
    """
    await _wlrctl("toplevel", "focus", "app_id:" + app_id)
    await asyncio.sleep(0.2)
    return app_id


async def key(name: str) -> str:
    """A single key/combination from the allowlist."""
    await focus_window()
    raw = str(name).strip()
    k = _ALIASES.get(raw.lower(), raw)
    combo = ALLOWED_KEYS.get(k)
    if combo is None:
        raise InputError(f"Taste nicht erlaubt: {k[:32]!r}")
    if len(combo) == 1:
        await _wtype("-k", combo[0])
    else:
        mod, sym = combo
        await _wtype("-M", mod, "-k", sym, "-m", mod)
    return k


async def clear_field() -> None:
    """Clear the field content; requires focus in the field."""
    await key("ctrl+a")
    await asyncio.sleep(0.12)
    await key("Delete")


async def fill(x: int, y: int, text: str, clear: bool = True,
               delay_ms: int = 90) -> dict:
    """Click a field, optionally clear it, type: the normal case.

    After the click, a pause and `Escape`: completion lists (browser autofill, password
    manager) open with a delay and would otherwise swallow the first keystrokes.
    """
    await click(x, y)
    await asyncio.sleep(0.4)
    await key("Escape")
    await asyncio.sleep(0.15)
    if clear:
        await clear_field()
        await asyncio.sleep(0.15)
    n = await type_text(text, delay_ms=delay_ms)
    return {"ok": True, "chars": n}


async def available() -> dict:
    """Self-test: answers "does this work here?" without side effects on the page."""
    out: dict = {"ok": False}
    try:
        out["toplevels"] = (await _wlrctl("toplevel", "list")).splitlines()[:3]
        await focus_window()
    except Exception as e:  # noqa: BLE001
        out["error"] = f"Fokus/wlrctl fehlt: {str(e)[:100]}"
        return out
    try:
        await _wtype("-k", "Escape")          # harmless: closes a menu at most
        out["keyboard"] = "wayland/wtype"
        out["ok"] = True
    except Exception as e:  # noqa: BLE001
        out["error"] = f"Tastatur/wtype: {str(e)[:100]}"
    return out
