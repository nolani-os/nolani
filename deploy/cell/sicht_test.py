#!/usr/bin/env python3
"""Visual check of a cell — real browser, real shell, from the user's perspective.

Runs in the Playwright container (run_tests.sh sicht):
    ZELLE_TEST_PW=… python3 sicht_test.py <domain> <user> <output_dir>

Principle: the measuring point is a real browser in the shell; click nothing for the
first impression; observe over time.
Per app: start link `?app=<id>`, screenshots after 6 s and 15 s, record console errors
and failed requests (>= 400). Office: the editor is embedded as in the office viewer
(form POST into an iframe on the shell origin) and must report `Document_loaded`.
Chat: ask a question; the answer must become visible.
Result: PNGs + bericht.json in the output directory. Never prints passwords.
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

DOM, USER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
PW = os.environ["ZELLE_TEST_PW"]
SHELL = f"https://home.{DOM}"
os.makedirs(OUT, exist_ok=True)
bericht: dict = {"apps": {}}
probleme: list = []


# Positive checks on what the BROWSER actually talks to. Server-side tests cannot see
# this: a wrong runtime domain once sent the Teams client to a placeholder host while
# every API test stayed green.
anfragen: dict = {"matrix_client": 0, "falsche_hosts": set()}


def zaehle_anfrage(req) -> None:
    host = req.url.split("/")[2] if "://" in req.url else ""
    if host == f"matrix.{DOM}" and "/_matrix/client/" in req.url:
        anfragen["matrix_client"] += 1
    if host.endswith("example.com") or host.endswith(".home"):
        anfragen["falsche_hosts"].add(host)


def notiere(page):
    page.on("request", zaehle_anfrage)
    page.on("console", lambda m: probleme.append(("console", m.type, m.text[:200]))
            if m.type == "error" else None)
    page.on("response", lambda r: probleme.append(("http", r.status, r.url.split("?")[0][:160]))
            if r.status >= 400 else None)
    # Requests that never got a response (blocked, aborted, TLS, CORS) — a "Failed to
    # fetch" in the console does not say WHICH request; this does.
    page.on("requestfailed", lambda r: probleme.append(
        ("netz", r.failure or "?", r.url.split("?")[0][:160])))


def foto(page, name):
    page.screenshot(path=f"{OUT}/{name}.png")


with sync_playwright() as p:
    # Real Google Chrome, not Playwright's Chromium: that build cannot decode H.264,
    # so the streamed browser stayed black although the server streamed fine.
    b = p.chromium.launch(channel="chrome")
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, locale="de-DE")
    page = ctx.new_page()
    notiere(page)

    # ── Login through the real Authentik UI ──────────────────────────────
    page.goto(SHELL + "/", wait_until="domcontentloaded")
    page.wait_for_selector("input[name=uidField]", timeout=30000)
    page.fill("input[name=uidField]", USER)
    if page.locator("input[name=password]").count():
        page.fill("input[name=password]", PW)
    page.click("button[type=submit]")
    # Second step (password). Two observed failure modes: an Enter sent too early, and
    # the form re-rendering AFTER the value was filled so the field was empty on click.
    # Hence: wait for the finished step ("Nicht Sie?"), fill in, verify the value
    # stuck — only then click.
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
    # Warning: use page.wait_for_timeout, not time.sleep: with the sync API time.sleep
    # blocks event processing — page.url stayed stale and the test reported "stuck"
    # while the shell had long since loaded.
    t0 = time.time()
    for _ in range(90):
        if page.url.startswith(SHELL):
            break
        page.wait_for_timeout(1000)
    else:
        foto(page, "login-fehler")
        open(f"{OUT}/login-fehler.txt", "w").write(page.url + "\n" + page.inner_text("body")[:2000])
        raise SystemExit(f"Anmeldung nicht abgeschlossen, hängt bei {page.url.split('?')[0]}")
    bericht["anmeldung_sekunden"] = round(time.time() - t0)
    page.wait_for_timeout(8000)
    foto(page, "00-desktop")
    bericht["desktop"] = {"url": page.url}

    # ── Apps via start link, click nothing ───────────────────────────────
    for app in ["files", "planner", "post", "teams-workspace", "knowledge", "kontakte",
                "vaultwarden", "settings", "immich", "paperless", "services-hub",
                "selkies-browser", "clara-routinen", "mastodon", "peertube"]:
        probleme.clear()
        page.goto(f"{SHELL}/?app={app}", wait_until="domcontentloaded")
        page.wait_for_timeout(6000)
        foto(page, f"{app}-06s")
        page.wait_for_timeout(9000)
        foto(page, f"{app}-15s")
        bericht["apps"][app] = {"probleme": list(dict.fromkeys(probleme))[:12]}

    # ── Editor (BlockNote): create a note via the API, open it, type ──────
    probleme.clear()
    editor: dict = {"angelegt": False, "sichtbar": False, "getippt": False}
    r = page.request.post(f"{SHELL}/api/claraos/knowledge/objects",
                          data={"type": "note", "title": "Browser check editor", "body": "First paragraph."})
    oid = ((r.json() or {}).get("object") or {}).get("id") if r.ok else None
    editor["angelegt"] = bool(oid)
    if oid:
        page.goto(f"{SHELL}/?app=knowledge&do=open_object&object_id={oid}", wait_until="domcontentloaded")
        # The newest window is last in the DOM; earlier knowledge windows may still be open.
        ed = page.locator(".bn-editor").last
        try:
            ed.wait_for(state="visible", timeout=30000)
            editor["sichtbar"] = True
        except Exception:
            pass
        if editor["sichtbar"]:
            # Focus directly: BlockNote's wrapper intercepts pointer events, so a
            # Playwright click on the ProseMirror root never gets through.
            ed.focus()
            page.keyboard.press("Control+End")
            page.keyboard.type(" Typed in the browser check.")
            page.wait_for_timeout(3000)
            text = ed.inner_text()
            editor["text"] = text[:200]
            editor["getippt"] = "Typed in the browser check." in text
        foto(page, "editor")
        page.request.delete(f"{SHELL}/api/claraos/knowledge/objects/{oid}")
    editor["probleme"] = list(dict.fromkeys(probleme))[:12]
    bericht["editor"] = editor

    # ── Office: embedded as in the office viewer ─────────────────────────
    probleme.clear()
    page.goto(SHELL + "/", wait_until="domcontentloaded")
    page.wait_for_timeout(5000)
    doc = page.evaluate("""async () => {
        const r = await fetch('/api/claraos/office/create-document', {method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({filename:'Sichtprüfung.docx', folder:'Dokumente',
            content_markdown:'# Sichtprüfung\\n\\nCollabora in der Shell der Zelle.'})});
        return {status: r.status, body: await r.json().catch(() => ({}))};
    }""")
    pfad = doc["body"].get("path")
    ergebnis = page.evaluate("""async (pfad) => {
        const t = await (await fetch('/api/claraos/wopi/token', {method:'POST',
          headers:{'Content-Type':'application/json'}, body: JSON.stringify({source:'nextcloud', path: pfad})})).json();
        window.__docLoaded = false;
        const origin = new URL(t.editor_url).origin;
        window.addEventListener('message', (ev) => {
          if (ev.origin !== origin) return;
          try { const m = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
                if (m.MessageId === 'App_LoadingStatus' && m.Values && m.Values.Status === 'Document_loaded') window.__docLoaded = true;
          } catch (e) {}
        });
        const f = document.createElement('iframe');
        f.name = 'sicht-office'; f.style = 'position:fixed;left:40px;top:40px;width:1360px;height:820px;z-index:99999;border:2px solid #888;background:#fff';
        document.body.appendChild(f);
        const form = document.createElement('form');
        form.method = 'POST'; form.target = 'sicht-office';
        form.action = t.editor_url + (t.editor_url.includes('?') ? '' : '?') + 'WOPISrc=' + encodeURIComponent(t.wopi_src);
        for (const [k, v] of [['access_token', t.access_token], ['access_token_ttl', String(t.access_token_ttl)]]) {
          const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; form.appendChild(i);
        }
        document.body.appendChild(form); form.submit(); form.remove();
        return {editor: origin};
    }""", pfad)
    geladen = False
    for s in range(40):
        page.wait_for_timeout(1000)
        if page.evaluate("window.__docLoaded === true"):
            geladen = True
            break
    page.wait_for_timeout(3000)
    foto(page, "office")
    bericht["office"] = {"dokument": pfad, "editor": ergebnis.get("editor"),
                         "Document_loaded": geladen, "sekunden": s + 1,
                         "probleme": list(dict.fromkeys(probleme))[:12]}
    page.evaluate("""async (pfad) => { await fetch('/api/claraos/files/v2/delete?source=nextcloud&path='
        + encodeURIComponent(pfad), {method:'DELETE'}); }""", pfad)

    # ── Clara chat: ask; the answer must become visible ──────────────────
    probleme.clear()
    page.goto(f"{SHELL}/?chat=1", wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    foto(page, "chat-offen")
    # Only the VISIBLE input: `textarea.first` hit a hidden one that shares its text
    # with the visible one — the text appeared, but was never sent.
    feld = page.locator("textarea:visible").first
    if feld.count():
        # With an external brain this runs a planner tool (progress display + answer);
        # without one, Clara answers honestly that she has no tools.
        feld.fill("Welche Aufgaben stehen in meinem Planner? Antworte kurz.")
        knopf = page.locator("button[aria-label^='Send']:visible, button[title='Senden']:visible").first
        if knopf.count():
            knopf.click()
        else:
            feld.press("Enter")
        page.wait_for_timeout(8000)
        foto(page, "chat-laeuft")
        page.wait_for_timeout(30000)
    foto(page, "chat-antwort")
    bericht["chat"] = {"eingabefeld": bool(feld.count()), "probleme": list(dict.fromkeys(probleme))[:12]}

    b.close()

bericht["browser"] = {"matrix_client_anfragen": anfragen["matrix_client"],
                      "falsche_hosts": sorted(anfragen["falsche_hosts"])}
json.dump(bericht, open(f"{OUT}/bericht.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps(bericht, ensure_ascii=False, indent=1)[:6000])
ok = (anfragen["matrix_client"] > 0 and not anfragen["falsche_hosts"]
      and bericht.get("editor", {}).get("getippt", False))
print(f"\nBROWSER: {anfragen['matrix_client']} Matrix-Client-Anfragen, "
      f"falsche Hosts: {sorted(anfragen['falsche_hosts']) or 'keine'}")
print(f"EDITOR: {bericht.get('editor', {})}")
print("SICHTPRUEFUNG GRÜN" if ok else "SICHTPRUEFUNG ROT")
sys.exit(0 if ok else 1)
