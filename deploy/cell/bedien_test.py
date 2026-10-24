#!/usr/bin/env python3
"""Operation check of a cell — a real browser clicks through every app like a user.

Runs in the Playwright container (run_tests.sh bedien):
    ZELLE_TEST_PW=… python3 bedien_test.py <domain> <user> <output_dir> [step,step,…]

Where sicht_test.py looks without touching, this test operates: create, open, type,
save, delete. Every step proves its effect by what is VISIBLE afterwards, not by the
click succeeding, and removes what it created (the throwaway account goes anyway).
Windows are addressed by their id: "the newest window" drifts as soon as a step
opens the next one (a file opening in the editor).
Result: one PNG per step + bedien.json in the output directory. Never prints passwords.
"""
import json
import os
import re
import sys
import tempfile
import time
import traceback
import zipfile

from playwright.sync_api import Page, expect, sync_playwright

DOM, USER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
NUR = set(sys.argv[4].split(",")) if len(sys.argv) > 4 else None
PW = os.environ["ZELLE_TEST_PW"]
# Visible product name of the cell (SSO button texts); default as in the API.
PRODUCT = os.environ.get("CLARAOS_PRODUCT_NAME") or "NolaniOS"
SHELL = f"https://home.{DOM}"
MARKE = f"bt{int(time.time()) % 100000}"  # unique per run, part of every created object
CALL_LIMIT_S = 20  # own video tile must appear within this; a missing host capability cost ~35 s
os.makedirs(OUT, exist_ok=True)

ergebnis: dict = {}
probleme: list = []


def notiere(page: Page) -> None:
    page.on("pageerror", lambda e: probleme.append(("pageerror", str(e)[:200])))
    page.on("console", lambda m: probleme.append(("console", m.text[:200])) if m.type == "error" else None)
    page.on("response", lambda r: probleme.append(("http", r.status, r.url.split("?")[0][:140]))
            if r.status >= 400 else None)


def anmelden(page: Page) -> None:
    page.goto(SHELL + "/", wait_until="domcontentloaded")
    page.wait_for_selector("input[name=uidField]", timeout=30000)
    page.fill("input[name=uidField]", USER)
    if page.locator("input[name=password]").count():
        page.fill("input[name=password]", PW)
    page.click("button[type=submit]")
    # Same two-step handling as sicht_test.py: wait for the finished password step,
    # verify the value stuck, only then submit.
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
    else:
        raise SystemExit("Anmeldung nicht abgeschlossen")
    page.wait_for_timeout(6000)
    hinweise_weg(page)


def hinweise_weg(page: Page) -> None:
    """Onboarding toast / tour: answer 'later' like a user who wants to work."""
    for text in ("Später", "Überspringen", "Später einrichten"):
        loc = page.get_by_text(text, exact=True)
        if loc.count() and loc.first.is_visible():
            loc.first.click()
            page.wait_for_timeout(500)


def alle_fenster_zu(page: Page) -> None:
    for _ in range(30):
        zu = page.locator("div[data-window-id] button[aria-label='Schließen']")
        if not zu.count():
            return
        try:
            zu.last.click(timeout=3000)
        except Exception:
            return
        page.wait_for_timeout(300)


def fenster(page: Page, wid: str):
    # `div`: iframe apps carry data-window-id on the <iframe> as well.
    return page.locator(f"div[data-window-id='{wid}']")


def neuestes(page: Page):
    return fenster(page, page.locator("div[data-window-id]").last.get_attribute("data-window-id"))


def app_oeffnen(page: Page, app: str, warte: int = 6000):
    alle_fenster_zu(page)
    page.goto(f"{SHELL}/?app={app}", wait_until="domcontentloaded")
    page.wait_for_timeout(warte)
    hinweise_weg(page)
    expect(page.locator("div[data-window-id]").last).to_be_visible(timeout=15000)
    return neuestes(page)


def zur_wurzel(page: Page, win) -> None:
    """Files remembers the last folder — start every files step at the root."""
    win.locator("button[aria-label='Pfad eingeben']").click()
    page.wait_for_timeout(400)
    page.keyboard.press("Control+A")
    page.keyboard.type("/")
    page.keyboard.press("Enter")
    page.wait_for_timeout(2500)


def eintrag(win, name: str):
    """A file/folder tile or row — not the sidebar tree, not the heading of an open folder."""
    return win.locator("[draggable=true], [role=gridcell], [role=row]").filter(has_text=name).last


def kontextmenue(page: Page, ziel, eintrag_re: str) -> None:
    ziel.click(button="right")
    page.wait_for_timeout(500)
    page.get_by_role("menuitem", name=re.compile(eintrag_re)).or_(
        page.locator("[role=menu] button").filter(has_text=re.compile(eintrag_re))).first.click()
    page.wait_for_timeout(800)


def frame_von(page: Page, app: str):
    fr = page.locator(f"iframe[data-app-id='{app}']").last
    expect(fr).to_be_visible(timeout=15000)
    return fr.element_handle().content_frame()


def monaco_text(win) -> str:
    # Monaco renders into .view-lines; its textarea stays empty.
    return win.locator(".view-lines").first.inner_text().replace(" ", " ")


def schritt(page: Page, name: str):
    """Run a step right away; record ok/failure, screenshot and browser errors."""
    def deko(fn):
        if NUR and name not in NUR:
            return fn
        probleme.clear()
        t0 = time.time()
        try:
            eintrag_ = {"ok": True, **(fn() or {})}
        except Exception as e:  # noqa: BLE001 — every failure is a finding
            eintrag_ = {"ok": False, "fehler": f"{type(e).__name__}: {str(e).splitlines()[0][:300]}",
                        "wo": " / ".join(z.strip() for z in traceback.format_exc().splitlines()
                                         if "bedien_test.py" in z)[-200:]}
        try:
            page.screenshot(path=f"{OUT}/{name}.png")
        except Exception:
            pass
        eintrag_["sekunden"] = round(time.time() - t0, 1)
        eintrag_["probleme"] = list(dict.fromkeys(map(str, probleme)))[:8]
        ergebnis[name] = eintrag_
        print(f"{'✓' if eintrag_['ok'] else '✗'} {name:20} {eintrag_.get('fehler', '')[:160]}", flush=True)
        return fn
    return deko


with sync_playwright() as p:
    # Real Chrome where installed (run_tests.sh): Playwright's Chromium cannot decode
    # H.264, so the sample .mp4 stayed at width 0 although the player worked.
    medien = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
    try:
        b = p.chromium.launch(channel="chrome", args=medien)
    except Exception:
        b = p.chromium.launch(args=medien)
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, locale="de-DE",
                        permissions=["camera", "microphone", "clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    notiere(page)
    # Confirm dialogs (window.confirm) like a user — Playwright dismisses them by default,
    # which silently cancels every delete that asks first.
    page.on("dialog", lambda d: d.accept())
    anmelden(page)
    page.screenshot(path=f"{OUT}/00-desktop.png")

    # ── Shell ────────────────────────────────────────────────────────────
    @schritt(page, "uebersetzungen")
    def _():
        """No raw i18n keys anywhere in the frame. A build without catalogs is green —
        vite does not care — and the UI then shows `shell.quick`, `quick.mode.title`."""
        roh_js = """() => {
            const KEY = /^[a-z][A-Za-z0-9]*(\\.[A-Za-z][A-Za-z0-9_]*)+$/;
            const ENDE = new Set(['de','com','org','net','io','eu','app','dev','txt','pdf','png','jpg','jpeg','md',
              'mp4','mov','docx','xlsx','pptx','odt','json','csv','svg','zip','webp','heic','yaml','yml','ts','tsx','js','py','html']);
            const roh = s => { s = (s || '').trim(); if (!KEY.test(s)) return false;
              return !ENDE.has(s.split('.').pop().toLowerCase()); };
            const funde = new Set();
            const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n = w.nextNode(); n; n = w.nextNode()) if (roh(n.nodeValue)) funde.add(n.nodeValue.trim());
            for (const e of document.querySelectorAll('[aria-label],[title],[placeholder]'))
              for (const a of ['aria-label', 'title', 'placeholder']) if (roh(e.getAttribute(a))) funde.add(e.getAttribute(a).trim());
            return [...funde].slice(0, 15);
        }"""
        funde = set()
        alle_fenster_zu(page)
        funde.update(page.evaluate(roh_js))
        page.locator("button[data-tour='taskbar-clara']").click(); page.wait_for_timeout(1200)
        funde.update(page.evaluate(roh_js))
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        app_oeffnen(page, "settings")
        funde.update(page.evaluate(roh_js))
        assert not funde, f"rohe Übersetzungsschlüssel sichtbar: {sorted(funde)[:10]}"

    @schritt(page, "startmenue")
    def _():
        alle_fenster_zu(page)
        page.locator("button[data-tour='taskbar-clara']").click()
        feld = page.locator("[data-tour='startmenu-input'] textarea, [data-tour='startmenu-input'] input").first
        expect(feld).to_be_visible(timeout=5000)
        feld.fill("Kontakte")
        page.wait_for_timeout(1200)
        page.get_by_role("button", name=re.compile("^Kontakte")).first.click()
        expect(neuestes(page)).to_contain_text("Kontakte", timeout=10000)

    @schritt(page, "fenster")
    def _():
        w = app_oeffnen(page, "kontakte")
        box0 = w.bounding_box()
        tbb = w.locator("button[aria-label='Minimieren']").bounding_box()
        page.mouse.move(box0["x"] + 120, tbb["y"] + tbb["height"] / 2)
        page.mouse.down()
        page.mouse.move(box0["x"] + 320, tbb["y"] + 120, steps=8)
        page.mouse.up()
        page.wait_for_timeout(500)
        werte = {"verschoben": abs(w.bounding_box()["x"] - box0["x"]) > 50}
        w.locator("button[aria-label='Maximieren']").click(); page.wait_for_timeout(600)
        werte["maximiert"] = w.bounding_box()["width"] > 1300
        w.locator("button[aria-label='Wiederherstellen']").click(); page.wait_for_timeout(600)
        werte["wiederhergestellt"] = w.bounding_box()["width"] < 1300
        w.locator("button[aria-label='Minimieren']").click(); page.wait_for_timeout(600)
        werte["minimiert"] = not w.is_visible()
        page.locator("[data-shell-part='taskbar'] button[title='Kontakte']").last.click(); page.wait_for_timeout(800)
        werte["aus_taskleiste"] = w.is_visible()
        w.locator("button[aria-label='Schließen']").click(); page.wait_for_timeout(600)
        werte["geschlossen"] = w.count() == 0
        falsch = [k for k, v in werte.items() if not v]
        assert not falsch, f"nicht erfüllt: {falsch}"
        return werte

    @schritt(page, "taskleiste")
    def _():
        alle_fenster_zu(page)

        def neu_sichtbar(klick):
            vorher = page.evaluate("document.body.innerText")
            klick()
            page.wait_for_timeout(900)
            neu = [z for z in page.evaluate("document.body.innerText").splitlines() if z.strip() and z not in vorher]
            page.keyboard.press("Escape"); page.mouse.click(700, 60); page.wait_for_timeout(500)
            return neu[:6]

        werte = {
            "benachrichtigungen": neu_sichtbar(lambda: page.locator(
                "[data-shell-part='taskbar'] button[title^='Benachrichtigungen']").click()),
            "schnelleinstellungen": neu_sichtbar(lambda: page.locator(
                "[data-shell-part='taskbar'] button[title^='Schnelleinstellungen']").click()),
            "kalender": neu_sichtbar(lambda: page.locator("[data-ctx='tray-clock']").click()),
        }
        leer = [k for k, v in werte.items() if not v]
        assert not leer, f"öffnet nichts Sichtbares: {leer}"
        return werte

    # ── Files ────────────────────────────────────────────────────────────
    @schritt(page, "dateien")
    def _():
        win = app_oeffnen(page, "files")
        zur_wurzel(page, win)
        ordner = f"Ordner {MARKE}"
        win.locator("button[title='Neuer Ordner']").click()
        feld = page.get_by_placeholder("Ordnername …")
        feld.fill(ordner); feld.press("Enter")
        expect(eintrag(win, ordner)).to_be_visible(timeout=10000)
        eintrag(win, ordner).dblclick()
        expect(win.get_by_text(re.compile(r"\b0 Elemente|leer", re.I)).first).to_be_visible(timeout=10000)
        pfad = os.path.join(tempfile.mkdtemp(), f"notiz-{MARKE}.txt")
        open(pfad, "w").write("Hochgeladen im Bedientest.\n")
        with page.expect_file_chooser() as fc:
            win.locator("button[title='Hochladen']").click()
        fc.value.set_files(pfad)
        page.wait_for_timeout(2500)  # let the upload toast go: it repeats the file name
        expect(eintrag(win, f"notiz-{MARKE}.txt")).to_be_visible(timeout=15000)
        eintrag(win, f"notiz-{MARKE}.txt").dblclick()
        page.wait_for_timeout(5000)
        editor = neuestes(page)
        inhalt = monaco_text(editor) if editor.locator(".view-lines").count() else editor.inner_text()
        if editor.get_attribute("data-window-id") != win.get_attribute("data-window-id"):
            editor.locator("button[aria-label='Schließen']").click(); page.wait_for_timeout(500)
        zur_wurzel(page, win)
        kontextmenue(page, eintrag(win, ordner), "Papierkorb|Löschen")
        expect(win.locator("[draggable=true], [role=gridcell], [role=row]").filter(has_text=ordner)) \
            .to_have_count(0, timeout=10000)
        assert "Hochgeladen im Bedientest" in inhalt, f"Datei öffnet nicht mit ihrem Inhalt: {inhalt[:120]!r}"

    @schritt(page, "betrachter")
    def _():
        """The cell's sample files by double click: small + large PDF, image, video."""
        win = app_oeffnen(page, "files")
        zur_wurzel(page, win)
        werte = {}
        for name, art in (("Reasons to use", "pdf_klein"), ("Nextcloud Manual", "pdf_gross"),
                          ("Nextcloud.png", "bild"), ("Nextcloud intro", "video")):
            win.locator("[draggable=true], [role=gridcell], [role=row]").filter(has_text=name).first.dblclick()
            page.wait_for_timeout(6000)
            neu = neuestes(page)
            werte[art] = neu.evaluate("""w => ({
                canvas: [...w.querySelectorAll('canvas')].filter(c => c.width > 100).length,
                frames: [...w.querySelectorAll('iframe,embed,object')].length,
                bilder: [...w.querySelectorAll('img')].filter(i => i.naturalWidth > 50).length,
                video: Math.max(0, ...[...w.querySelectorAll('video')].map(v => v.videoWidth))})""")
            page.screenshot(path=f"{OUT}/betrachter-{art}.png")
            neu.locator("button[aria-label='Schließen']").click(); page.wait_for_timeout(600)
        ok = {"pdf_klein": werte["pdf_klein"]["canvas"] + werte["pdf_klein"]["frames"] > 0,
              "pdf_gross": werte["pdf_gross"]["canvas"] + werte["pdf_gross"]["frames"] > 0,
              "bild": werte["bild"]["bilder"] > 0, "video": werte["video"]["video"] > 0}
        assert all(ok.values()), f"zeigt nichts: {[k for k, v in ok.items() if not v]}"
        return werte

    @schritt(page, "office")
    def _():
        """Upload a .docx, open it by double click, Collabora must render it."""
        win = app_oeffnen(page, "files")
        zur_wurzel(page, win)
        pfad = os.path.join(tempfile.mkdtemp(), f"Brief-{MARKE}.docx")
        w = "http://schemas.openxmlformats.org"
        with zipfile.ZipFile(pfad, "w") as z:  # minimal valid WordprocessingML document
            z.writestr("[Content_Types].xml", f'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="{w}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
            z.writestr("_rels/.rels", f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{w}/package/2006/relationships"><Relationship Id="r1" Type="{w}/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
            z.writestr("word/document.xml", f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{w}/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Brief aus dem Bedientest</w:t></w:r></w:p></w:body></w:document>')
        with page.expect_file_chooser() as fc:
            win.locator("button[title='Hochladen']").click()
        fc.value.set_files(pfad)
        page.wait_for_timeout(3000)
        expect(eintrag(win, f"Brief-{MARKE}")).to_be_visible(timeout=15000)
        eintrag(win, f"Brief-{MARKE}").dblclick()
        geladen = False
        for _i in range(45):
            page.wait_for_timeout(1000)
            fr = next((f for f in page.frames if "cool.html" in f.url or "/browser/" in f.url), None)
            if fr and fr.locator("#document-container, .leaflet-layer, canvas").count():
                geladen = True
                break
        page.wait_for_timeout(3000)
        page.screenshot(path=f"{OUT}/office-offen.png")
        neuestes(page).locator("button[aria-label='Schließen']").click(); page.wait_for_timeout(800)
        kontextmenue(page, eintrag(win, f"Brief-{MARKE}"), "Papierkorb|Löschen")
        assert geladen, "Collabora zeigt das Dokument nicht"

    @schritt(page, "texteditor")
    def _():
        win = app_oeffnen(page, "text-editor")
        win.locator(".monaco-editor").first.click(position={"x": 200, "y": 40})
        page.keyboard.type(f"Text {MARKE}")
        page.wait_for_timeout(800)
        assert f"Text {MARKE}" in monaco_text(win), "getippter Text nicht sichtbar"
        # A new file has no path: "Speichern" must lead to "save as", not to an error.
        win.get_by_role("button", name=re.compile("^Speichern")).first.click()
        dialog = win.get_by_role("dialog", name="Speichern unter")
        expect(dialog).to_be_visible(timeout=5000)
        name = dialog.get_by_label("Dateiname")
        name.fill(f"Text-{MARKE}.txt")
        dialog.get_by_role("button", name="Speichern").click()
        expect(win.get_by_text(re.compile(f"Gespeichert: .*Text-{MARKE}.txt"))).to_be_visible(timeout=10000)
        titel = win.locator("button[aria-label='Schließen']").locator("xpath=ancestor::*[3]").inner_text()
        # "Neu" must forget the saved file: typing + saving now asks again instead of
        # silently overwriting Text-<marke>.txt.
        win.get_by_role("button", name="Neu", exact=True).click()
        win.locator(".monaco-editor").first.click(position={"x": 200, "y": 40})
        page.keyboard.type("anderer Inhalt")
        win.get_by_role("button", name=re.compile("^Speichern")).first.click()
        expect(dialog).to_be_visible(timeout=5000)
        dialog.get_by_role("button", name="Abbrechen").click()
        return {"fenstertitel": titel.split("\n")[0][:60]}

    # ── Productivity ─────────────────────────────────────────────────────
    @schritt(page, "planner")
    def _():
        win = app_oeffnen(page, "planner")
        titel = f"Aufgabe {MARKE}"
        feld = win.get_by_placeholder(re.compile("Aufgabe .*hinzufügen"))
        feld.fill(titel); feld.press("Enter")
        zeile = win.get_by_text(titel, exact=True).first
        expect(zeile).to_be_visible(timeout=10000)
        # The round check button has no text and sits left of the title in the same row.
        box = zeile.bounding_box()
        mitte = box["y"] + box["height"] / 2
        knoepfe = [k for k in win.locator("button:visible").filter(has_not_text=re.compile(".")).all()
                   if (bb := k.bounding_box()) and abs(bb["y"] + bb["height"] / 2 - mitte) < 14 and bb["x"] < box["x"]]
        assert knoepfe, "kein Abhak-Knopf neben der Aufgabe"
        knoepfe[-1].click()
        page.wait_for_timeout(2500)
        rest = win.get_by_text(titel, exact=True)
        assert rest.count() == 0 or "line-through" in rest.first.evaluate(
            "e => getComputedStyle(e).textDecorationLine"), "Aufgabe nach dem Abhaken unverändert"

    @schritt(page, "kontakte")
    def _():
        win = app_oeffnen(page, "kontakte")
        win.get_by_role("button", name="+ Neu").click()
        win.locator("input[placeholder='Vorname']:visible").fill("Erika")
        win.locator("input[placeholder='Nachname']:visible").fill(MARKE)
        win.get_by_role("button", name="+ E-Mail").click()
        win.locator("input[placeholder='name@example.org']:visible").last.fill(f"erika.{MARKE}@example.org")
        win.get_by_role("button", name="Speichern").click()
        page.wait_for_timeout(1500)
        win.get_by_placeholder(re.compile("^Suchen — Name")).fill(MARKE)
        page.wait_for_timeout(1000)
        expect(win.get_by_text(f"Erika {MARKE}").first).to_be_visible(timeout=10000)
        win.get_by_text(f"Erika {MARKE}").first.click(); page.wait_for_timeout(800)
        expect(win.get_by_text(f"erika.{MARKE}@example.org").first).to_be_visible(timeout=5000)
        win.get_by_role("button", name=re.compile("^(Entfernen|Löschen|In den Papierkorb)$")).first.click()
        page.wait_for_timeout(1500)
        expect(win.locator("[class*=list], [class*=List]").get_by_text(f"Erika {MARKE}")).to_have_count(0, timeout=10000)

    @schritt(page, "ideen")
    def _():
        win = app_oeffnen(page, "ideas")
        win.locator("button[title='Neue Idee (N)']").click()
        feld = page.get_by_placeholder(re.compile("Worum geht"))
        feld.fill(f"Idee {MARKE}"); feld.press("Enter")
        # Quick capture keeps the dialog open and counts ("1 erfasst ✓").
        expect(page.get_by_text(re.compile(r"\d+ erfasst"))).to_be_visible(timeout=10000)
        page.keyboard.press("Escape"); page.wait_for_timeout(500)
        win.locator("button[title='Ideen-Liste']").click(); page.wait_for_timeout(2000)
        expect(win.get_by_text(f"Idee {MARKE}").first).to_be_visible(timeout=10000)

    @schritt(page, "wissen")
    def _():
        win = app_oeffnen(page, "knowledge")
        win.locator("button[title='Neue Notiz (N)']").click()
        feld = page.get_by_placeholder(re.compile("Worum geht"))
        feld.fill(f"Notiz {MARKE}"); feld.press("Enter")
        page.wait_for_timeout(1500)
        page.keyboard.press("Escape"); page.wait_for_timeout(500)
        win.locator("button[title='Notizen']").click(); page.wait_for_timeout(2000)
        expect(win.get_by_text(f"Notiz {MARKE}").first).to_be_visible(timeout=10000)
        win.get_by_text(f"Notiz {MARKE}").first.click(); page.wait_for_timeout(2500)
        ed = page.locator(".bn-editor:visible").last
        expect(ed).to_be_visible(timeout=15000)
        # Focus directly: BlockNote's wrapper intercepts pointer events.
        ed.focus(); page.keyboard.press("Control+End")
        page.keyboard.type(" Absatz aus dem Bedientest.")
        page.wait_for_timeout(2500)
        assert "Absatz aus dem Bedientest." in ed.inner_text(), "getippter Text erscheint nicht im Editor"

    @schritt(page, "routinen")
    def _():
        win = app_oeffnen(page, "clara-routinen")
        win.get_by_role("button", name="+ Neue Routine").click()
        win.get_by_label("Titel").fill(f"Routine {MARKE}")
        win.get_by_label(re.compile(r"^Auftrag an ")).fill("Sag mir kurz das Datum von heute.")
        win.get_by_role("button", name="Speichern").click()
        expect(win.get_by_text(f"Routine {MARKE}").first).to_be_visible(timeout=10000)
        karte = win.locator("li, [class*=karte], [class*=Karte], [class*=card], [class*=row]").filter(
            has=page.get_by_text(f"Routine {MARKE}")).last
        karte.get_by_role("button", name="Löschen").click()
        expect(win.get_by_text(f"Routine {MARKE}")).to_have_count(0, timeout=10000)

    @schritt(page, "post")
    def _():
        win = app_oeffnen(page, "post", 8000)
        betreff = f"Bedientest {MARKE}"
        win.locator("button[title^='Neue E-Mail']").click()
        page.wait_for_timeout(1500)
        an = page.get_by_placeholder(re.compile("Name oder Adresse|adresse@beispiel")).first
        an.fill(f"{USER}@{DOM}"); an.press("Enter")
        page.get_by_placeholder("Betreff hinzufügen").fill(betreff)
        page.locator("[contenteditable=true]:visible").last.click()
        page.keyboard.type("Hallo aus dem Bedientest.")
        page.get_by_role("button", name=re.compile("Senden$")).last.click()
        for _i in range(30):  # undo window, then delivery to ourselves
            page.wait_for_timeout(2000)
            win.locator("button[title='Aktualisieren']").click()
            if win.get_by_text(betreff).count():
                break
        expect(win.get_by_text(betreff).first).to_be_visible(timeout=5000)
        win.get_by_text(betreff).first.click()
        expect(win.get_by_text("Hallo aus dem Bedientest.").first).to_be_visible(timeout=10000)

    @schritt(page, "einstellungen")
    def _():
        win = app_oeffnen(page, "settings")
        farbe = lambda: page.evaluate("getComputedStyle(document.body).backgroundColor")  # noqa: E731
        win.get_by_role("button", name="Immer hell").click(); page.wait_for_timeout(1200)
        hell = farbe()
        win.get_by_role("button", name="Immer dunkel").click(); page.wait_for_timeout(1200)
        dunkel = farbe()
        win.get_by_role("button", name="Wie das Design").click(); page.wait_for_timeout(800)
        win.get_by_placeholder("Einstellungen durchsuchen…").fill("Sprache")
        page.wait_for_timeout(1000)
        assert hell != dunkel, f"Hell/Dunkel ändert nichts sichtbar: {hell} / {dunkel}"
        assert win.get_by_text("Sprache & Formate").count(), "Suche findet „Sprache & Formate“ nicht"

    @schritt(page, "taskmanager")
    def _():
        app_oeffnen(page, "kontakte")
        page.goto(f"{SHELL}/?app=task-manager", wait_until="domcontentloaded"); page.wait_for_timeout(6000)
        tm = neuestes(page)
        zeile = tm.locator("tr, li, [class*=row], [class*=Row]").filter(has_text="Kontakte").last
        zeile.click()
        zeile.get_by_role("button", name="Beenden").or_(tm.get_by_role("button", name="Beenden").first).first.click()
        page.wait_for_timeout(1500)
        offen = [t.split("\n")[0] for t in page.locator("div[data-window-id]").all_inner_texts()]
        assert "Kontakte" not in offen, f"Kontakte-Fenster nach „Beenden“ noch offen: {offen}"

    # ── Teams ────────────────────────────────────────────────────────────
    @schritt(page, "teams_nachricht")
    def _():
        win = app_oeffnen(page, "teams-workspace", 9000)
        win.locator("button[title='Chat']").click(); page.wait_for_timeout(1500)
        win.locator("[title='Neue Nachricht']").first.click(); page.wait_for_timeout(1000)
        page.get_by_placeholder(re.compile("Person suchen oder @name")).fill(f"@clara.bot:{DOM}")
        page.wait_for_timeout(2500)
        page.get_by_text(re.compile("clara.bot", re.I)).last.click(); page.wait_for_timeout(4000)
        text = f"Hallo aus dem Bedientest {MARKE}"
        win.locator("textarea:visible, [contenteditable=true]:visible").last.click()
        page.keyboard.type(text); page.keyboard.press("Enter")
        expect(win.get_by_text(text).first).to_be_visible(timeout=15000)
        page.wait_for_timeout(3000)
        assert not win.get_by_text(re.compile("nicht gesendet|Senden fehlgeschlagen", re.I)).count(), \
            "Nachricht als nicht gesendet markiert"

    @schritt(page, "teams_anruf")
    def _():
        win = app_oeffnen(page, "teams-workspace", 9000)
        win.locator("button[title='Calls']").click(); page.wait_for_timeout(1500)
        t0 = time.time()
        win.get_by_text("Sofortbesprechung starten").click()
        sek = None
        for _i in range(90):
            page.wait_for_timeout(1000)
            fr = next((f for f in page.frames if f.url.startswith(f"https://call.{DOM}")), None)
            if fr and fr.evaluate("() => [...document.querySelectorAll('video')].some(v => v.videoWidth > 0)"):
                sek = round(time.time() - t0, 1)
                break
        win.get_by_text("Leave Call").click(); page.wait_for_timeout(3000)
        assert sek is not None and sek < CALL_LIMIT_S, f"eigenes Bild nach {sek} s (Grenze {CALL_LIMIT_S} s)"
        return {"sekunden_bis_bild": sek}

    # ── Embedded apps: SSO must end inside the app ───────────────────────
    @schritt(page, "immich")
    def _():
        app_oeffnen(page, "immich", 12000); page.wait_for_timeout(5000)
        f = frame_von(page, "immich")
        klicks = []
        for _i in range(8):  # Immich's own first-run wizard (theme, language, …)
            if "onboarding" not in f.url or not f.locator("button:visible").count():
                break
            knopf = f.locator("button:visible").last
            klicks.append(knopf.inner_text()[:20]); knopf.click(); page.wait_for_timeout(1500)
        page.wait_for_timeout(2000)
        text = f.evaluate("() => document.body.innerText.slice(0, 300)")
        assert "onboarding" not in f.url and re.search("Fotos|Photos|Hochladen|Upload|Erkunden|Explore", text), \
            f"{f.url.split('?')[0]} — {text[:160]!r}"
        return {"assistent": klicks}

    @schritt(page, "paperless")
    def _():
        app_oeffnen(page, "paperless", 12000); page.wait_for_timeout(6000)
        f = frame_von(page, "paperless")
        text = f.evaluate("() => document.body.innerText.slice(0, 300)")
        assert re.search("Dokumente|Documents|Dashboard|Übersicht", text), f"{f.url.split('?')[0]} — {text[:160]!r}"

    @schritt(page, "vaultwarden")
    def _():
        app_oeffnen(page, "vaultwarden", 10000)
        f = frame_von(page, "vaultwarden")
        if f.get_by_text("Single Sign-On verwenden").count():
            f.locator("input:visible:not([type=checkbox])").first.fill(os.environ.get("ZELLE_MAIL", f"{USER}@invalid.example"))
            f.get_by_text("Single Sign-On verwenden").click(); page.wait_for_timeout(9000)
            f = frame_von(page, "vaultwarden")
        text = f.evaluate("() => document.body.innerText.slice(0, 400)")
        # A vault always asks for its master password; SSO only replaces the account login.
        # End states that count: set the master password (first time), unlock, the vault.
        assert re.search("Master-Passwort|Masterpasswort|master password|Entsperren|Unlock|Tresor", text, re.I), \
            f"{f.url.split('?')[0]} — {text[:200]!r}"

    @schritt(page, "mastodon")
    def _():
        app_oeffnen(page, "mastodon", 12000); page.wait_for_timeout(4000)
        f = frame_von(page, "mastodon")
        vorher = f.url.split("?")[0]
        if "sign_in" in f.url:
            f.get_by_role("button", name=re.compile(re.escape(PRODUCT))).or_(
                f.get_by_role("link", name=re.compile(re.escape(PRODUCT)))).first.click()
            page.wait_for_timeout(9000)
            f = frame_von(page, "mastodon")
        text = f.evaluate("() => document.body.innerText.slice(0, 300)")
        assert "sign_in" not in f.url and re.search("Startseite|Home|Veröffentlichen|Publish|Folge Profilen", text), \
            f"{f.url.split('?')[0]} — {text[:160]!r}"
        return {"zusatzklick": "sign_in" in vorher}

    @schritt(page, "peertube")
    def _():
        app_oeffnen(page, "peertube", 12000); page.wait_for_timeout(6000)
        f = frame_von(page, "peertube")
        text = f.evaluate("() => document.body.innerText.slice(0, 300)")
        assert re.search("Videos|Entdecken|Discover|Hochladen|Upload", text), f"{f.url.split('?')[0]} — {text[:160]!r}"

    @schritt(page, "browser")
    def _():
        app_oeffnen(page, "selkies-browser", 15000)
        page.wait_for_timeout(10000)
        # The stream is drawn into a <video> or a <canvas> inside the browser's frame
        # (depends on the decoder); width 0 everywhere = no picture.
        breiten = {f.url.split("?")[0][:60]: f.evaluate(
            "() => Math.max(0, ...[...document.querySelectorAll('video,canvas')].map(v => v.videoWidth || v.width || 0))")
            for f in page.frames if f != page.main_frame}
        assert any(v > 0 for v in breiten.values()), f"kein Bild im Browser-Fenster: {breiten}"
        return {"stream": breiten}

    # ── Assistant ───────────────────────────────────────────────────────
    @schritt(page, "clara_chat")
    def _():
        alle_fenster_zu(page)
        page.goto(f"{SHELL}/?chat=1", wait_until="domcontentloaded"); page.wait_for_timeout(6000)
        feld = page.locator("textarea:visible").first
        feld.fill("Wie viel ist 17 mal 3? Antworte nur mit der Zahl.")
        feld.press("Enter")
        expect(page.get_by_text("51").last).to_be_visible(timeout=90000)

    b.close()

json.dump(ergebnis, open(f"{OUT}/bedien.json", "w"), ensure_ascii=False, indent=1)
gut = sum(1 for e in ergebnis.values() if e["ok"])
print(f"\nBEDIENUNG: {gut}/{len(ergebnis)} Schritte grün")
print("BEDIENTEST GRÜN" if gut == len(ergebnis) else "BEDIENTEST ROT")
sys.exit(0 if gut == len(ergebnis) else 1)
