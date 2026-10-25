#!/usr/bin/env python3
"""Aufnahmen für das GitHub-Schaufenster — echter Browser, echtes Gehirn, englische Oberfläche.

Im Playwright-Container:  python3 browser_schaufenster.py <domain> <user> <ausgabe>
Ergebnis: screenshots/*.png, video/*.webm, szenen.json (Zeitmarken der Szenen im Video).
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

DOM, USER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
PW = os.environ["ZELLE_TEST_PW"]
SHELL = f"https://home.{DOM}"
os.makedirs(f"{OUT}/screenshots", exist_ok=True)
os.makedirs(f"{OUT}/video", exist_ok=True)
GROESSE = {"width": 1440, "height": 900}


def anmelden(page) -> None:
    page.goto(SHELL + "/", wait_until="domcontentloaded")
    page.wait_for_selector("input[name=uidField]", timeout=30000)
    page.fill("input[name=uidField]", USER)
    if page.locator("input[name=password]").count():
        page.fill("input[name=password]", PW)
    page.click("button[type=submit]")
    try:
        page.wait_for_selector("text=Not you?", timeout=8000)
    except Exception:
        try:
            page.wait_for_selector("text=Nicht Sie?", timeout=8000)
        except Exception:
            pass
    page.wait_for_timeout(1000)
    for _ in range(3):
        feld = page.locator("input[name=password]")
        if not feld.count():
            break
        feld.fill(PW)
        page.wait_for_timeout(300)
        if feld.input_value() == PW:
            page.click("button[type=submit]")
            break
    for _ in range(90):
        if page.url.startswith(SHELL):
            return
        page.wait_for_timeout(1000)
    raise SystemExit("Anmeldung hängt")


def fenster(page) -> list[str]:
    return page.evaluate("""() => Object.values(window.__claraos.windows.getState().windows)
        .filter(w => !w.minimized).map(w => w.appId)""")


def begruessung_zu(page) -> None:
    """Dismiss the first-run greeting ("Hi, I'm Nolani!") — it covers a corner of every shot."""
    # dispatch_event, not click: with the start menu open its backdrop takes the
    # pointer (take 5 died here after 30 s). Never let the greeting end a take.
    try:
        knopf = page.get_by_role("button", name="Later")
        if not knopf.count():
            knopf = page.locator("text=Later")
        if knopf.count() and knopf.first.is_visible():
            knopf.first.dispatch_event("click")
            page.wait_for_timeout(800)
            print("  greeting dismissed", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"  greeting not dismissed: {type(e).__name__}", flush=True)


def collabora_dialog_zu(page) -> None:
    """Close Collabora's welcome slideshow (shown in every fresh browser; CODE
    ignores welcome.enable). A visitor closes it once the same way."""
    for _ in range(20):
        for f in page.frames:
            try:
                if "collabora." not in (f.url or ""):
                    continue
                if not f.locator("text=Explore The New").count() and not f.locator(
                        "iframe[name*=welcome], iframe[id*=welcome], .iframe-welcome-modal").count():
                    continue
                for sel in (".iframe-welcome-modal .ui-dialog-titlebar-close",
                            ".iframe-welcome-modal button[aria-label=Close]",
                            "#welcome-modal .ui-dialog-close", "[aria-label='Close dialog']",
                            "button.ui-dialog-titlebar-close"):
                    knopf = f.locator(sel)
                    if knopf.count() and knopf.first.is_visible():
                        knopf.first.dispatch_event("click")
                        page.wait_for_timeout(1000)
                        print(f"  collabora welcome closed ({sel})", flush=True)
                        return
                f.locator("body").press("Escape", timeout=3000)
                page.wait_for_timeout(1000)
                if not f.locator(".iframe-welcome-modal").count():
                    print("  collabora welcome closed (Escape)", flush=True)
                    return
            except Exception as e:  # noqa: BLE001 — a dialog must never end a take
                print(f"  collabora frame skipped: {type(e).__name__}", flush=True)
        page.wait_for_timeout(1000)
    print("  collabora welcome: not found or not closable", flush=True)


def foto(page, name: str) -> None:
    page.screenshot(path=f"{OUT}/screenshots/{name}.png")


def ruhig(page, mindest: int = 8, still: int = 6, max_s: int = 150) -> None:
    """Wait until the visible text stops changing (the answer is complete)."""
    page.wait_for_timeout(mindest * 1000)
    letzte, gleich, t0 = "", 0, time.time()
    while time.time() - t0 < max_s:
        jetzt = page.evaluate("() => document.body.innerText.length + ':' + document.body.innerText.slice(-400)")
        gleich = gleich + 1 if jetzt == letzte else 0
        if gleich >= still:
            return
        letzte = jetzt
        page.wait_for_timeout(1000)


def menue(page, offen: bool) -> None:
    """Show or hide the start-menu chat — hidden, the windows Nolani opened are visible."""
    ist = page.evaluate("() => window.__claraos.ui.getState().startMenuOpen")
    if offen and not ist:
        page.evaluate("() => window.dispatchEvent(new CustomEvent('claraos-open-clara-chat', {detail: {}}))")
    elif not offen and ist:
        page.evaluate("() => window.__claraos.ui.getState().toggleStartMenu()")
    page.wait_for_timeout(1200)


def frage(page, text: str) -> None:
    feld = page.locator("textarea:visible:not([readonly])").first
    feld.click()
    feld.type(text, delay=35)  # visibly typed for the video
    page.wait_for_timeout(400)
    feld.press("Enter")


bericht: dict = {"szenen": []}
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    # ── 1. Stills: desktop at 1440×900, English UI ─────────────────────────────
    ctx = b.new_context(viewport=GROESSE, locale="en-US", timezone_id="Europe/Berlin",
                        color_scheme="light")
    page = ctx.new_page()
    anmelden(page)
    page.wait_for_timeout(8000)
    foto(page, "01-desktop")
    for name, app in [("02-planner", "planner"), ("03-files", "files"), ("04-knowledge", "ideas"),
                      ("05-mail", "post"), ("06-teams", "teams-workspace"), ("07-settings", "settings")]:
        page.goto(f"{SHELL}/?app={app}", wait_until="domcontentloaded")
        page.wait_for_timeout(12000)
        foto(page, name)
    # The "Recipes" table collection (seed_demo.py) in the knowledge app.
    page.goto(f"{SHELL}/?app=knowledge", wait_until="domcontentloaded")
    page.wait_for_timeout(10000)
    # The stills above left six windows stacked; keep only the knowledge app, maximized.
    page.evaluate("""() => { const s = window.__claraos.windows.getState();
        for (const w of Object.values(s.windows)) {
            if (w.appId === "knowledge") s.maximizeWindow(w.id); else s.closeWindow(w.id); } }""")
    page.wait_for_timeout(1500)
    try:
        # "Recipes" also appears in hidden places; click the visible collection card.
        page.locator("text=Recipes >> visible=true").first.click(timeout=15000)
        page.wait_for_timeout(6000)
        foto(page, "08-knowledge-table")
    except Exception as e:  # noqa: BLE001 — a missing shot must not end the take
        print(f"  knowledge table not shot: {type(e).__name__}", flush=True)
        foto(page, "08-knowledge-table-fehlt")
    # The demo team (seed_teams.py) in the Teams app, General channel open.
    page.goto(f"{SHELL}/?app=teams-workspace", wait_until="domcontentloaded")
    page.wait_for_timeout(10000)
    page.evaluate("""() => { const s = window.__claraos.windows.getState();
        for (const w of Object.values(s.windows)) {
            if (w.appId === "teams-workspace" || w.appId === "teams") s.maximizeWindow(w.id);
            else s.closeWindow(w.id); } }""")
    page.wait_for_timeout(1500)
    try:
        start = page.locator("text=Let's go >> visible=true")
        if start.count():
            start.first.click(timeout=10000)
            page.wait_for_timeout(4000)
        page.locator("text=Website relaunch >> visible=true").first.click(timeout=20000)
        page.wait_for_timeout(3000)
        page.locator("text=General >> visible=true").first.click(timeout=15000)
        page.wait_for_timeout(6000)
        foto(page, "09-teams-channel")
    except Exception as e:  # noqa: BLE001
        print(f"  teams channel not shot: {type(e).__name__}", flush=True)
        foto(page, "09-teams-channel-fehlt")
    staat = ctx.storage_state()
    ctx.close()

    # ── 2. Mobile stills ───────────────────────────────────────────────────────
    mctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3,
                         is_mobile=True, has_touch=True, locale="en-US",
                         timezone_id="Europe/Berlin", storage_state=staat)
    m = mctx.new_page()
    m.goto(SHELL + "/", wait_until="domcontentloaded")
    m.wait_for_timeout(10000)
    m.screenshot(path=f"{OUT}/screenshots/20-mobile-home.png")
    m.goto(f"{SHELL}/?app=planner", wait_until="domcontentloaded")
    m.wait_for_timeout(10000)
    m.screenshot(path=f"{OUT}/screenshots/21-mobile-planner.png")
    mctx.close()

    # ── 3. The agent at work — recorded ────────────────────────────────────────
    vctx = b.new_context(viewport=GROESSE, locale="en-US", timezone_id="Europe/Berlin",
                         color_scheme="light", storage_state=staat,
                         record_video_dir=f"{OUT}/video", record_video_size=GROESSE)
    v = vctx.new_page()
    t_start = time.time()
    v.goto(f"{SHELL}/?chat=1", wait_until="domcontentloaded")
    v.wait_for_timeout(7000)
    begruessung_zu(v)
    szenen = [
        ("calendar", "Open my calendar for next week."),
        ("task", "Add a task 'Call Sarah about the hero image' to the Website relaunch project, "
                 "due Wednesday, and show it to me."),
        ("document", "Open the project brief from my files."),
        # Nolani cannot read the open .docx (no text tool for office files); a request
        # that needs its content made her insert placeholders (take 4).
        ("write", "Add a 'Next steps' section with three bullet points from my open "
                  "Website relaunch tasks at the end of the open document."),
        ("chart", "Make me a small bar chart of my open tasks per project."),
    ]
    for name, text in szenen:
        beginn = round(time.time() - t_start, 1)
        menue(v, True)
        frage(v, text)
        ruhig(v)
        v.wait_for_timeout(2500)
        begruessung_zu(v)
        if name == "document":
            collabora_dialog_zu(v)
        v.screenshot(path=f"{OUT}/screenshots/agent-{name}-chat.png")
        menue(v, False)  # reveal what Nolani did
        v.wait_for_timeout(5000)
        v.screenshot(path=f"{OUT}/screenshots/agent-{name}.png")
        bericht["szenen"].append({"name": name, "text": text, "beginn_s": beginn,
                                  "ende_s": round(time.time() - t_start, 1), "fenster": fenster(v)})
        print(f"  {name}: {fenster(v)}", flush=True)
    vctx.close()  # writes the video
    b.close()

json.dump(bericht, open(f"{OUT}/szenen.json", "w"), ensure_ascii=False, indent=1)
print("SCHAUFENSTER FERTIG")
