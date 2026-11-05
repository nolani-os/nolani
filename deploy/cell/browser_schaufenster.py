#!/usr/bin/env python3
"""Aufnahmen für das GitHub-Schaufenster — echter Browser, echte Bedienung, englische Oberfläche,
die Looks (Skins) der Shell.

Im Playwright-Container:  python3 browser_schaufenster.py <domain> <user> <ausgabe> [kern|business]

kern      (Zelle mit Gehirn, z. B. die Demo-Zelle): Bilder der Kern-Apps in verschiedenen Looks,
          ein Bild je Look, Handy, Video „Looks wechseln“ und Video „Nolani bei der Arbeit“.
business  (Zelle mit den Business-Apps): ein Bild je App und Video „Business-Apps öffnen“.

Ergebnis: screenshots/*.png, video/<name>.webm, szenen.json (Zeitmarken je Szene).
"""
import json
import os
import shutil
import sys
import time

from playwright.sync_api import sync_playwright

DOM, USER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
TEIL = sys.argv[4] if len(sys.argv) > 4 else "kern"
PW = os.environ["ZELLE_TEST_PW"]
SHELL = f"https://home.{DOM}"
os.makedirs(f"{OUT}/screenshots", exist_ok=True)
os.makedirs(f"{OUT}/video", exist_ok=True)
GROESSE = {"width": 1440, "height": 900}
# Display names in the quick settings (skin.name) — the video clicks them like a person does.
LOOKS = [("clara-glass", "Glass", "dark"), ("bloom-light", "Bloom Light", "light"),
         ("orchard-light", "Orchard Light", "light"), ("corporate-medical", "The Medical Company", "light"),
         ("meadow", "Meadow", "dark"), ("shore", "Shore", "dark"), ("orchard-dark", "Orchard", "dark"),
         ("bloom-dark", "Bloom", "dark")]
THEMA = {s: t for s, _, t in LOOKS}
# The looks the README pictures show (the dark ones)
BILD_LOOKS = ["bloom-dark", "orchard-dark", "shore"]
NAME = {s: n for s, n, _ in LOOKS}


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


def look(page, skin: str, neu_laden: bool = True) -> None:
    """Set the look the way the personalization does: the server pref wins on load
    (useStateSync), the local store keeps it until then."""
    r = page.request.put(f"{SHELL}/api/claraos/prefs",
                         data={"skin_id": skin, "theme": THEMA.get(skin, "light"), "wallpaper": ""})
    page.evaluate("""(skin) => {
      const k = 'claraos-ui'; let s = {}; try { s = JSON.parse(localStorage.getItem(k) || '{}'); } catch {}
      s.state = Object.assign({}, s.state, { skinId: skin, startMenuOpen: false }); s.version = s.version ?? 0;
      localStorage.setItem(k, JSON.stringify(s)); }""", skin)
    print(f"  look {skin}: prefs {r.status}", flush=True)
    if neu_laden:
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(7000)


def fenster(page) -> list[str]:
    return page.evaluate("""() => Object.values(window.__claraos.windows.getState().windows)
        .filter(w => !w.minimized).map(w => w.appId)""")


def nur(page, app_ids: tuple, maximiert: bool = True) -> None:
    """Keep only the windows of these apps (the last one maximized), close the rest."""
    page.evaluate("""([ids, maxi]) => { const s = window.__claraos.windows.getState();
        for (const w of Object.values(s.windows)) {
            if (ids.includes(w.appId)) { if (maxi) s.maximizeWindow(w.id); } else s.closeWindow(w.id); } }""",
                  [list(app_ids), maximiert])
    page.wait_for_timeout(1500)


def alle_zu(page) -> None:
    page.evaluate("""() => { const s = window.__claraos.windows.getState();
        for (const w of Object.values(s.windows)) s.closeWindow(w.id); }""")
    page.wait_for_timeout(800)


def begruessung_zu(page) -> None:
    """Dismiss the first-run greeting ("Hi, I'm Nolani!") — it covers a corner of every shot."""
    # dispatch_event, not click: with the start menu open its backdrop takes the pointer.
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


def starten(page, name: str) -> None:
    """Open an app the way a person does: start menu, type the name, Enter."""
    ist = page.evaluate("() => window.__claraos.ui.getState().startMenuOpen")
    if not ist:
        page.evaluate("() => window.__claraos.ui.getState().toggleStartMenu()")
    page.wait_for_timeout(900)
    feld = page.locator("[data-testid=start-input]:visible").first
    feld.click()
    feld.fill("")
    feld.type(name, delay=70)
    page.wait_for_timeout(700)
    feld.press("Enter")


def app_bereit(page, host: str, max_s: int = 60, ruhe: bool = True) -> bool:
    for _ in range(max_s):
        if any(f.url.startswith(host) for f in page.frames):
            break
        page.wait_for_timeout(1000)
    for f in page.frames:
        if f.url.startswith(host):
            if not ruhe:
                return True
            try:
                f.wait_for_load_state("networkidle", timeout=25000)
            except Exception:  # noqa: BLE001 — long-polling apps never go idle
                pass
            return True
    return False


def video_ablegen(ctx, page, name: str) -> None:
    pfad = page.video.path()
    ctx.close()  # writes the video
    shutil.move(pfad, f"{OUT}/video/{name}.webm")


bericht: dict = {"teil": TEIL, "szenen": []}


def kern(b) -> None:
    # ── 1. Stills: each core app in its own look ───────────────────────────────
    ctx = b.new_context(viewport=GROESSE, locale="en-US", timezone_id="Europe/Berlin")
    page = ctx.new_page()
    anmelden(page)
    page.wait_for_timeout(6000)
    begruessung_zu(page)
    # Meadow and Shore draw the sky after the real sun at the account's location (a setting
    # per account). Recorded in the evening, both would show night — so this account stands
    # where it is afternoon right now (the recording runs in the European evening).
    ort = os.environ.get("SCHAUFENSTER_ORT", "37.77,-122.42")  # San Francisco
    breite, laenge = (float(x) for x in ort.split(","))
    r = page.request.put(f"{SHELL}/api/claraos/settings/appearance",
                         data={"latitude": breite, "longitude": laenge})
    print(f"  location {ort}: {r.status}", flush=True)
    # One desktop per look, with the planner open in a window (not maximized).
    for skin in BILD_LOOKS:
        look(page, skin)
        begruessung_zu(page)
        alle_zu(page)
        page.goto(f"{SHELL}/?app=planner", wait_until="domcontentloaded")
        page.wait_for_timeout(9000)
        nur(page, ("planner",), maximiert=False)
        foto(page, f"look-{skin}")
    for name, app, skin in [("planner", "planner", "orchard-dark"), ("files", "files", "bloom-dark")]:
        look(page, skin)
        page.goto(f"{SHELL}/?app={app}", wait_until="domcontentloaded")
        page.wait_for_timeout(11000)
        nur(page, (app,))
        foto(page, name)
    # The "Recipes" table collection (seed_demo.py) in the knowledge app.
    look(page, "bloom-dark")
    page.goto(f"{SHELL}/?app=knowledge", wait_until="domcontentloaded")
    page.wait_for_timeout(10000)
    nur(page, ("knowledge",))
    try:
        page.locator("text=Recipes >> visible=true").first.click(timeout=15000)
        page.wait_for_timeout(6000)
        foto(page, "knowledge")
    except Exception as e:  # noqa: BLE001 — a missing shot must not end the take
        print(f"  knowledge table not shot: {type(e).__name__}", flush=True)
    # The demo team (seed_teams.py), General channel open.
    look(page, "orchard-dark")
    page.goto(f"{SHELL}/?app=teams-workspace", wait_until="domcontentloaded")
    page.wait_for_timeout(10000)
    nur(page, ("teams-workspace", "teams"))
    try:
        start = page.locator("text=Let's go >> visible=true")
        if start.count():
            start.first.click(timeout=10000)
            page.wait_for_timeout(4000)
        page.locator("text=Website relaunch >> visible=true").first.click(timeout=20000)
        page.wait_for_timeout(3000)
        page.locator("text=General >> visible=true").first.click(timeout=15000)
        page.wait_for_timeout(6000)
        foto(page, "teams")
    except Exception as e:  # noqa: BLE001
        print(f"  teams channel not shot: {type(e).__name__}", flush=True)
    look(page, "shore", neu_laden=False)
    staat = ctx.storage_state()
    ctx.close()

    # ── 2. Phone ───────────────────────────────────────────────────────────────
    mctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3,
                         is_mobile=True, has_touch=True, locale="en-US",
                         timezone_id="Europe/Berlin", storage_state=staat)
    m = mctx.new_page()
    m.goto(SHELL + "/", wait_until="domcontentloaded")
    m.wait_for_timeout(10000)
    m.screenshot(path=f"{OUT}/screenshots/mobile-home.png")
    m.goto(f"{SHELL}/?app=planner", wait_until="domcontentloaded")
    m.wait_for_timeout(10000)
    m.screenshot(path=f"{OUT}/screenshots/mobile-planner.png")
    mctx.close()

    # ── 3. Video: changing the look in the quick settings ──────────────────────
    vctx = b.new_context(viewport=GROESSE, locale="en-US", timezone_id="Europe/Berlin",
                         storage_state=staat, record_video_dir=f"{OUT}/video/roh",
                         record_video_size=GROESSE)
    v = vctx.new_page()
    v_start = time.time()  # the recording starts with the page
    v.goto(SHELL + "/", wait_until="domcontentloaded")
    v.wait_for_timeout(3000)
    look(v, "orchard-dark")
    begruessung_zu(v)
    alle_zu(v)
    v.goto(f"{SHELL}/?app=planner", wait_until="domcontentloaded")
    v.wait_for_timeout(9000)
    nur(v, ("planner",), maximiert=False)
    t0 = time.time()
    for skin in ("bloom-dark", "shore", "orchard-dark"):
        panel = v.locator('[data-shell-part="quick-settings"]')
        try:
            v.locator('[data-tour="tray-quick-settings"]:visible').first.click(timeout=8000)
            v.wait_for_timeout(1200)
            panel.locator(f'button[title="{NAME[skin]}"]').first.click(timeout=8000)
        except Exception as e:  # noqa: BLE001 — fall back to the pref, the clip goes on
            print(f"  quick settings {skin}: {type(e).__name__}, pref instead", flush=True)
            look(v, skin)
        v.wait_for_timeout(1800)
        # Escape does not close the panel; its × does (or the tray button again).
        try:
            if panel.count() and panel.first.is_visible():
                panel.locator('button:has-text("×")').first.click(timeout=3000)
        except Exception:  # noqa: BLE001
            v.locator('[data-tour="tray-quick-settings"]:visible').first.click(timeout=3000)
        v.wait_for_timeout(3500)
        bericht["szenen"].append({"video": "looks", "name": skin, "beginn_s": round(time.time() - t0, 1)})
    bericht["vorlauf_s_looks"] = round(t0 - v_start, 1)  # cut this off the front
    video_ablegen(vctx, v, "looks")

    # ── 4. Video: Nolani at work (Shore) ──────────────────────────────────────
    vctx = b.new_context(viewport=GROESSE, locale="en-US", timezone_id="Europe/Berlin",
                         storage_state=staat, record_video_dir=f"{OUT}/video/roh",
                         record_video_size=GROESSE)
    v = vctx.new_page()
    v_start = time.time()  # the recording starts with the page
    v.goto(SHELL + "/", wait_until="domcontentloaded")
    v.wait_for_timeout(3000)
    look(v, "shore")
    alle_zu(v)
    begruessung_zu(v)
    t0 = time.time()
    szenen = [
        ("calendar", "Open my calendar for next week."),
        ("task", "Add a task 'Call Sarah about the hero image' to the Website relaunch project, "
                 "due Wednesday, and show it to me."),
        ("document", "Open the project brief from my files."),
        # Nolani cannot read the open .docx (no text tool for office files); a request
        # that needs its content made her insert placeholders.
        ("write", "Add a 'Next steps' section with three bullet points from my open "
                  "Website relaunch tasks at the end of the open document."),
    ]
    for name, text in szenen:
        beginn = round(time.time() - t0, 1)
        menue(v, True)
        frage(v, text)
        ruhig(v)
        v.wait_for_timeout(2000)
        begruessung_zu(v)
        if name == "document":
            collabora_dialog_zu(v)
        menue(v, False)  # reveal what Nolani did
        v.wait_for_timeout(4500)
        v.screenshot(path=f"{OUT}/screenshots/agent-{name}.png")
        bericht["szenen"].append({"video": "agent", "name": name, "text": text, "beginn_s": beginn,
                                  "ende_s": round(time.time() - t0, 1), "fenster": fenster(v)})
        print(f"  {name}: {fenster(v)}", flush=True)
    bericht["vorlauf_s_agent"] = round(t0 - v_start, 1)  # cut this off the front
    video_ablegen(vctx, v, "agent")


BUSINESS = [("odoo", "Odoo", "orchard-dark"), ("inventree", "InvenTree", "bloom-dark"),
            ("superset", "Superset", "shore"), ("mautic", "Mautic", "bloom-dark"),
            ("orangehrm", "OrangeHRM", "orchard-dark")]
# The login button of apps that show their own login page first (one click, no password).
ANMELDEKNOPF = {"odoo": "a[href*='/application/o/authorize/']",
                "inventree": "button:has-text('{0}'), a:has-text('{0}')".format(
                    os.environ.get("CLARAOS_PRODUCT_NAME") or "NolaniOS"),
                "superset": "a[href*='/login/authentik'], button:has-text('authentik')"}
# The page each still shows (the demo data of seed_business.sh).
BILDSEITE = {"odoo": "/odoo",  # the account opens on Contacts (seed_business.sh)
             "inventree": "/web/part/category/index/parts",
             "superset": "/superset/dashboard/world_health/", "mautic": "/s/contacts",
             "orangehrm": "/web/index.php/directory/viewDirectory"}


def app_frame(page, app: str):
    return next((f for f in page.frames if f.url.startswith(f"https://{app}.{DOM}")), None)


def app_anmelden(page, app: str) -> bool:
    """Open the tile; where the app shows its login page, click the cell's button once."""
    page.goto(f"{SHELL}/?app={app}", wait_until="domcontentloaded")
    app_bereit(page, f"https://{app}.{DOM}", 90)
    page.wait_for_timeout(3000)
    frame = app_frame(page, app)
    if frame and app in ANMELDEKNOPF:
        try:
            frame.wait_for_selector(ANMELDEKNOPF[app], timeout=20000)
            frame.locator(ANMELDEKNOPF[app]).first.click()
            print(f"  {app}: login button clicked", flush=True)
        except Exception:  # noqa: BLE001 — already signed in
            pass
    for _ in range(60):
        frame = app_frame(page, app)
        if frame and "login" not in frame.url and "auth." not in frame.url:
            break
        page.wait_for_timeout(1000)
    page.wait_for_timeout(4000)
    frame = app_frame(page, app)
    return bool(frame and "login" not in frame.url)


def business(b) -> None:
    ctx = b.new_context(viewport=GROESSE, locale="en-US", timezone_id="Europe/Berlin")
    page = ctx.new_page()
    anmelden(page)
    page.wait_for_timeout(6000)
    begruessung_zu(page)
    # First visit of each app: accounts are created on the first login.
    for app, _, _ in BUSINESS:
        print(f"  {app} signed in: {app_anmelden(page, app)}", flush=True)
    # Stills: one app per shot, maximized, each in a look, on a page with demo data.
    for app, _, skin in BUSINESS:
        look(page, skin)
        page.goto(f"{SHELL}/?app={app}", wait_until="domcontentloaded")
        app_bereit(page, f"https://{app}.{DOM}")
        page.wait_for_timeout(3000)
        nur(page, (app,))
        frame = app_frame(page, app)
        if frame:
            try:
                frame.goto(f"https://{app}.{DOM}{BILDSEITE[app]}", wait_until="domcontentloaded",
                           timeout=30000)
                frame.wait_for_load_state("networkidle", timeout=20000)
            except Exception as e:  # noqa: BLE001
                print(f"  {app} page: {type(e).__name__}", flush=True)
            page.wait_for_timeout(3000)
            if app in ANMELDEKNOPF and frame.locator(ANMELDEKNOPF[app]).count():
                frame.locator(ANMELDEKNOPF[app]).first.click()
                print(f"  {app}: signed in again", flush=True)
                page.wait_for_timeout(8000)
                frame = app_frame(page, app)
                frame.goto(f"https://{app}.{DOM}{BILDSEITE[app]}", wait_until="domcontentloaded",
                           timeout=30000)
        page.wait_for_timeout(6000)
        foto(page, f"business-{app}")
    look(page, "orchard-dark", neu_laden=False)
    staat = ctx.storage_state()
    ctx.close()

    # Video: open the five apps from the start menu — one sign-in, no second login.
    vctx = b.new_context(viewport=GROESSE, locale="en-US", timezone_id="Europe/Berlin",
                         storage_state=staat, record_video_dir=f"{OUT}/video/roh",
                         record_video_size=GROESSE)
    v = vctx.new_page()
    v_start = time.time()  # the recording starts with the page
    v.goto(SHELL + "/", wait_until="domcontentloaded")
    v.wait_for_timeout(6000)
    alle_zu(v)
    begruessung_zu(v)
    t0 = time.time()
    for app, name, _ in BUSINESS:
        beginn = round(time.time() - t0, 1)
        starten(v, name)
        bereit = app_bereit(v, f"https://{app}.{DOM}", 45, ruhe=False)
        v.wait_for_timeout(5500)
        bericht["szenen"].append({"video": "business", "name": app, "beginn_s": beginn, "bereit": bereit})
        print(f"  video {app}: {bereit}", flush=True)
    v.wait_for_timeout(1500)
    bericht["vorlauf_s_business"] = round(t0 - v_start, 1)  # cut this off the front
    video_ablegen(vctx, v, "business")


def nolani_business(b) -> None:
    """Video: Nolani works in the business apps — a new customer in Odoo, a small campaign
    in Mautic, stock check and purchase order in InvenTree. Needs a cell with a brain."""
    ctx = b.new_context(viewport=GROESSE, locale="en-US", timezone_id="Europe/Berlin")
    page = ctx.new_page()
    anmelden(page)
    page.wait_for_timeout(6000)
    begruessung_zu(page)
    # The assistant works with the user's own app accounts — they come with the first visit.
    for app in ("odoo", "inventree", "mautic"):
        print(f"  {app} signed in: {app_anmelden(page, app)}", flush=True)
    # Warm-up, not recorded: the first tool call per app creates the user's access, and that
    # sets a new password — Odoo, InvenTree and Mautic then end the user's open sessions. So
    # let Nolani touch each app once, then sign in to each again.
    menue(page, True)
    frage(page, "Look up the newest contact in Odoo, the parts below minimum stock in InvenTree "
                "and the newest contact in Mautic. Just list them, do not change anything.")
    ruhig(page, mindest=10, still=8, max_s=240)
    menue(page, False)
    # The brain may set the accesses only after its answer looked finished — wait, then sign
    # in until each app really is signed in (a password set later would end it again).
    page.wait_for_timeout(45000)
    for app in ("odoo", "inventree", "mautic"):
        for versuch in range(3):
            if app_anmelden(page, app):
                break
            page.wait_for_timeout(15000)
        print(f"  {app} signed in again after {versuch + 1} attempt(s)", flush=True)
    alle_zu(page)
    look(page, "orchard-dark", neu_laden=False)
    staat = ctx.storage_state()
    ctx.close()

    vctx = b.new_context(viewport=GROESSE, locale="en-US", timezone_id="Europe/Berlin",
                         storage_state=staat, record_video_dir=f"{OUT}/video/roh",
                         record_video_size=GROESSE)
    v = vctx.new_page()
    v_start = time.time()  # the recording starts with the page
    v.goto(SHELL + "/", wait_until="domcontentloaded")
    v.wait_for_timeout(3000)
    # A dark look: in Bloom Light and Orchard Light the chat bubbles are hard to read
    # (grey text on grey) — to be fixed in the skins.
    look(v, "orchard-dark")
    alle_zu(v)
    begruessung_zu(v)
    t0 = time.time()
    szenen = [
        ("odoo-kunde", "In Odoo, create the company Miller Sensors Ltd in Hamburg with two contacts: "
                       "Anna Becker, CEO, anna.becker@millersensors.example, and Tom Weiss, purchasing, "
                       "tom.weiss@millersensors.example. Add a note that we met them at the trade fair, "
                       "then show me the company."),
        ("odoo-chance", "Create an opportunity '50 temperature sensors' for Miller Sensors worth 12,000 euros "
                        "and show me the pipeline."),
        ("mautic", "Add Anna and Tom to Mautic, put them into a new segment 'Trade fair 2026', draft a "
                   "short welcome email and a follow-up, and build a campaign that sends the follow-up "
                   "three days later. Show me the campaign."),
        ("inventree", "Miller Sensors wants 50 TMP117 temperature sensors. Check our stock in InvenTree "
                      "and if it is too low, create a purchase order for 100 at Sensor Supply Ltd. "
                      "Show me the order."),
    ]
    for name, text in szenen:
        beginn = round(time.time() - t0, 1)
        menue(v, True)
        frage(v, text)
        ruhig(v, mindest=10, still=8, max_s=240)
        v.wait_for_timeout(2000)
        begruessung_zu(v)
        v.screenshot(path=f"{OUT}/screenshots/nolani-{name}-chat.png")
        menue(v, False)  # reveal what Nolani did
        v.wait_for_timeout(6000)
        v.screenshot(path=f"{OUT}/screenshots/nolani-{name}.png")
        bericht["szenen"].append({"video": "nolani-business", "name": name, "text": text, "beginn_s": beginn,
                                  "ende_s": round(time.time() - t0, 1), "fenster": fenster(v)})
        print(f"  {name}: {fenster(v)}", flush=True)
    bericht["vorlauf_s_nolani-business"] = round(t0 - v_start, 1)  # cut this off the front
    video_ablegen(vctx, v, "nolani-business")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    {"business": business, "nolani-business": nolani_business}.get(TEIL, kern)(browser)
    browser.close()
shutil.rmtree(f"{OUT}/video/roh", ignore_errors=True)
json.dump(bericht, open(f"{OUT}/szenen.json", "w"), ensure_ascii=False, indent=1)
print("SCHAUFENSTER FERTIG")
