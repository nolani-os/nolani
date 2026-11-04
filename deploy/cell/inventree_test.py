"""InvenTree in a cell, through the real browser path: shell login → InvenTree tile →
sign in with <product> → logged in as a normal user of group `nutzer` → may create a part.

    ZELLE_TEST_PW=… python3 inventree_test.py <domain> <user> <output dir>

The account must exist in the cell's Authentik (testkonto.py); run_tests.sh starts this
in the Playwright container and removes the InvenTree account and the test part
afterwards (inventree_konto_weg.py). Prints no passwords.
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

DOM, USER = sys.argv[1], sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else "inventree-test"
PW = os.environ["ZELLE_TEST_PW"]
PRODUCT = os.environ.get("CLARAOS_PRODUCT_NAME") or "NolaniOS"
SHELL = f"https://home.{DOM}"
APP = f"https://inventree.{DOM}"
os.makedirs(OUT, exist_ok=True)
bericht: dict = {"schritte": {}}


def schritt(name, ok, **info):
    bericht["schritte"][name] = {"ok": bool(ok), **info}
    print(("✓ " if ok else "✗ ") + name + (f" — {info}" if info else ""))
    return ok


def app_frame(page):
    return next((f for f in page.frames if f.url.startswith(APP)), None)


def ich(frame) -> dict:
    """Who is signed in, as InvenTree's own API sees it (inside the frame)."""
    return frame.evaluate("""async () => {
        const r = await fetch('/api/user/me/', {credentials: 'include'});
        if (!r.ok) return {status: r.status};
        const j = await r.json();
        return {status: r.status, username: j.username, email: j.email,
                staff: j.is_staff, superuser: j.is_superuser, vor: j.first_name, nach: j.last_name,
                gruppen: (j.groups || []).map(g => g.name || g)};
    }""")


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, locale="de-DE")
    page = ctx.new_page()

    # 1. Shell login through Authentik (same pattern as sicht_test.py)
    page.goto(SHELL + "/", wait_until="domcontentloaded")
    page.wait_for_selector("input[name=uidField]", timeout=60000)
    page.fill("input[name=uidField]", USER)
    if page.locator("input[name=password]").count():
        page.fill("input[name=password]", PW)
    page.click("button[type=submit]")
    try:
        page.wait_for_selector("text=Nicht Sie?", timeout=15000)
        page.wait_for_timeout(1000)
        for _ in range(3):
            feld = page.locator("input[name=password]")
            feld.fill(PW)
            page.wait_for_timeout(300)
            if feld.input_value() == PW:
                page.click("button[type=submit]")
                break
    except Exception:
        pass
    for _ in range(90):
        if page.url.startswith(SHELL):
            break
        page.wait_for_timeout(1000)
    if not schritt("anmeldung_shell", page.url.startswith(SHELL)):
        page.screenshot(path=f"{OUT}/fehler-anmeldung.png")
        sys.exit(1)
    page.wait_for_timeout(5000)

    # 2. Tile opens InvenTree in an iframe
    page.goto(f"{SHELL}/?app=inventree", wait_until="domcontentloaded")
    frame = None
    for _ in range(40):
        frame = app_frame(page)
        if frame:
            break
        page.wait_for_timeout(1000)
    page.screenshot(path=f"{OUT}/01-kachel.png")
    if not schritt("kachel_oeffnet_inventree", frame is not None):
        sys.exit(1)

    # 3. Login page with our provider button → click it (inside the iframe)
    t0 = time.time()
    knopf = None
    try:
        frame.wait_for_selector(f"button:has-text('{PRODUCT}'), a:has-text('{PRODUCT}')", timeout=90000)
        knopf = frame.locator(f"button:has-text('{PRODUCT}'), a:has-text('{PRODUCT}')").first
    except Exception:
        pass
    page.screenshot(path=f"{OUT}/02-login.png")
    if not schritt("anmeldeknopf_da", knopf is not None,
                   text=(knopf.inner_text().strip()[:60] if knopf else None)):
        sys.exit(1)
    knopf.click()

    # 4. Back in InvenTree, signed in (Authentik knows the user from step 1)
    wer: dict = {}
    for _ in range(90):
        frame = app_frame(page)
        if frame and "/login" not in frame.url:
            try:
                wer = ich(frame)
                if wer.get("status") == 200:
                    break
            except Exception:
                pass
        page.wait_for_timeout(1000)
    page.wait_for_timeout(4000)
    page.screenshot(path=f"{OUT}/03-angemeldet.png")
    if not schritt("angemeldet", wer.get("status") == 200, sekunden=round(time.time() - t0),
                   url=(frame.url.split("?")[0] if frame else None)):
        sys.exit(1)

    # 5. A normal account of group `nutzer` — not staff, not superuser
    schritt("normales_konto_gruppe_nutzer",
            not wer.get("staff") and not wer.get("superuser") and "nutzer" in (wer.get("gruppen") or []),
            **{k: wer.get(k) for k in ("email", "staff", "superuser", "gruppen")})

    # 5b. The name arrives split once: testkonto.py names the account "Zelle Test"
    # (allauth filled an empty family_name from the name again: "Zelle Test Test")
    schritt("name_einmal", (wer.get("vor"), wer.get("nach")) == ("Zelle", "Test"),
            vorname=wer.get("vor"), nachname=wer.get("nach"))

    # 6. The rights work: create a part through InvenTree's API, as the user
    marke = f"Nolani-Test {int(time.time())}"
    neu = frame.evaluate("""async (name) => {
        const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
        const r = await fetch('/api/part/', {method: 'POST', credentials: 'include',
            headers: {'Content-Type': 'application/json', 'X-CSRFToken': csrf},
            body: JSON.stringify({name: name, description: 'Ende-zu-Ende-Test', component: true})});
        const j = await r.json().catch(() => ({}));
        return {status: r.status, pk: j.pk, name: j.name, detail: r.ok ? null : JSON.stringify(j).slice(0, 200)};
    }""", marke)
    schritt("teil_anlegen", neu.get("status") == 201 and neu.get("name") == marke,
            status=neu.get("status"), detail=neu.get("detail"))

    # 7. Second visit: straight in, no login (InvenTree session kept)
    page.goto(f"{SHELL}/?app=inventree", wait_until="domcontentloaded")
    zweit = False
    for _ in range(40):
        frame = app_frame(page)
        if frame and "/login" not in frame.url:
            try:
                zweit = ich(frame).get("status") == 200
                if zweit:
                    break
            except Exception:
                pass
        page.wait_for_timeout(1000)
    page.screenshot(path=f"{OUT}/04-zweiter-aufruf.png")
    schritt("zweiter_aufruf_ohne_login", zweit)
    b.close()

json.dump(bericht, open(f"{OUT}/bericht.json", "w"), indent=2, ensure_ascii=False)
sys.exit(0 if all(s["ok"] for s in bericht["schritte"].values()) else 1)
