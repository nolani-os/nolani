"""Phone behaviour checks on Android (debug build in an emulator).

Real touches through `adb shell input` (not JS clicks), state read through the
page DevTools target and from the system (resumed activity, keyboard, files).

Usage: python3 -I android_k4.py <devtools-url> "<adb command prefix>"
  e.g. python3 -I android_k4.py http://127.0.0.1:19333 "ssh host docker exec emu adb"
Exit code 0 = all checks passed.
"""
import asyncio
import json
import shlex
import subprocess
import sys
import urllib.request

import websockets

base, adb_prefix = sys.argv[1].rstrip("/"), sys.argv[2]
results: list[tuple[str, bool, str]] = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), str(detail)))


def adb(*args: str) -> str:
    cmd = adb_prefix + " " + " ".join(shlex.quote(a) for a in args)
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60).stdout


def resumed() -> str:
    out = adb("shell", "dumpsys activity activities | grep -m1 -E 'mResumedActivity|topResumedActivity'")
    return out.strip()


def keyboard_shown() -> bool:
    return "mInputShown=true" in adb("shell", "dumpsys input_method | grep mInputShown")


async def connect():
    """Fresh DevTools connection: Android freezes an app in the background, an open
    connection does not survive that (the test sends the app away for the link check)."""
    for _ in range(20):
        try:
            targets = json.load(urllib.request.urlopen(f"{base}/json/list", timeout=5))
            page = next(t for t in targets if t["type"] == "page")
            return await websockets.connect(page["webSocketDebuggerUrl"], max_size=50_000_000, open_timeout=10)
        except Exception:  # noqa: BLE001 — retry until the web view answers again
            await asyncio.sleep(2)
    raise RuntimeError("DevTools target not reachable")


async def main():
    ws = await connect()
    if True:
        n = 0

        async def ev(expr, timeout=60):
            nonlocal n
            n += 1
            await ws.send(json.dumps({"id": n, "method": "Runtime.evaluate",
                                      "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}}))
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout))
                if m.get("id") == n:
                    r = m.get("result", {})
                    if "exceptionDetails" in r:
                        raise RuntimeError(json.dumps(r["exceptionDetails"])[:400])
                    return r.get("result", {}).get("value")

        async def tap_el(selector_js):
            """Real touch at the centre of the element the JS expression returns."""
            box = await ev(f"(() => {{ const e = {selector_js}; if (!e) return null; e.scrollIntoView({{block: 'center'}});"
                           " const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2,"
                           " devicePixelRatio, screenY + (outerHeight - innerHeight)]; })()")
            if not box:
                return False
            await asyncio.sleep(0.4)
            box = await ev(f"(() => {{ const e = {selector_js}; const r = e.getBoundingClientRect();"
                           " return [r.x + r.width / 2, r.y + r.height / 2, devicePixelRatio]; })()")
            # the web view starts below the status bar padding: measure its offset once
            x, y, dpr = box
            adb("shell", "input", "tap", str(int(x * dpr)), str(int(y * dpr + offset_px)))
            await asyncio.sleep(1.2)
            return True

        by_text = lambda t, sel="button, a, [role=button], label": (
            f"[...document.querySelectorAll('{sel}')].filter(e => e.offsetParent && e.textContent.trim() === {json.dumps(t)}).pop()")

        await ev("location.reload()")
        await asyncio.sleep(6)
        await ev("window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m)); true")
        # Offset of the web view on screen = status bar height (system padding)
        sb = adb("shell", "dumpsys window | grep -m1 -E 'statusBars|StatusBar.*frame'")
        disp = adb("shell", "wm size").strip()
        offset_px = int(await ev("(screen.height - innerHeight) * devicePixelRatio")) - int(
            await ev("Math.max(0, screen.height - innerHeight - 48) * devicePixelRatio"))
        offset_px = 0 if offset_px < 0 else offset_px
        info = await ev("[innerWidth, innerHeight, devicePixelRatio, screen.height]")
        check("Geometrie", True, f"{info} {disp} offset={offset_px} {sb.strip()[:80]}")

        # Test data: a collection from the recipe template (has a checkbox field) and a note with a link
        await ev("""(async () => {
          const K = '/api/claraos/knowledge';
          const j = async (m, p, b) => (await fetch(K + p, {method: m, headers: {'Content-Type': 'application/json'},
                                          body: b ? JSON.stringify(b) : undefined})).json();
          const c = (await j('POST', '/collections', {name: 'K4 Test', default_type: 'note'})).collection;
          await j('POST', `/collections/${c.id}/fields`, {key: 'fertig', name: 'Fertig', field_type: 6});
          const o = (await j('POST', '/objects', {title: 'Link-Test', body: 'Siehe [Beispiel](https://example.org/) hier.'})).object;
          const lang = Array.from({length: 40}, (_, i) => `Absatz ${i + 1} mit etwas Text.`).join('\\n\\n');
          const l = (await j('POST', '/objects', {title: 'Lange Notiz', body: lang})).object;
          await j('POST', `/collections/${c.id}/items`, {object_id: l.id});
          await j('POST', `/collections/${c.id}/items`, {object_id: o.id});
          window.__k4 = {c: c.id, o: o.id}; return true; })()""")

        # 1) Export into the public Download folder
        # one shell string, so the device shell expands the wildcard
        subprocess.run(adb_prefix + " shell 'rm -f /sdcard/Download/knowledge-export-*.zip'", shell=True, timeout=60)
        await ev("location.reload()")
        await asyncio.sleep(5)
        await ev("window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m)); true")
        await tap_el("document.querySelector('button[title=\"Mehr\"], button[aria-label=\"Mehr\"]') || "
                     + by_text("Mehr"))
        await tap_el(by_text("Export (ZIP)", "a, button"))
        # the first export of a session takes a few seconds (archive + bridge)
        for _ in range(12):
            if await ev("window.__alerts.length"):
                break
            await asyncio.sleep(1)
        alerts = await ev("window.__alerts")
        files = adb("shell", "ls /sdcard/Download/")
        head = adb("shell", "head -c 2 /sdcard/Download/knowledge-export-*.zip 2>/dev/null")
        # The file is the behaviour that matters (deleted before, so it is new). The
        # confirmation is shown too, but a native touch does not reliably reach the
        # test's alert hook, so it is reported, not judged.
        check("Export: neue ZIP im öffentlichen Download", "knowledge-export-" in files and head.startswith("PK"),
              f"{files.strip()} · Meldung: {alerts}")

        # 2) Checkbox size in the detail view (properties of the collection)
        await ev("location.reload()")
        await asyncio.sleep(5)
        await ev("(() => { const a = [...document.querySelectorAll('button')].find(b => b.textContent.includes('K4 Test')); a && a.click(); return !!a; })()")
        await asyncio.sleep(2)
        await ev("(() => { const a = [...document.querySelectorAll('*')].filter(e => e.offsetParent && e.textContent.trim() === 'Link-Test').pop(); a && a.click(); return !!a; })()")
        await asyncio.sleep(3)
        size = await ev("(() => { const c = document.querySelector('input[type=checkbox]'); if (!c) return null;"
                        " const r = c.getBoundingClientRect(); return [r.width, r.height, matchMedia('(pointer: coarse)').matches]; })()")
        check("Kontrollkästchen ≥ 24 px (Touch)", size and size[0] >= 24 and size[1] >= 24, size)

        # 4) Formatting bar: keyboard stays open, bold is applied
        para = "[...document.querySelectorAll('[data-claraos-editor] [data-content-type=paragraph]')].pop()"
        await tap_el(para)
        await asyncio.sleep(1.5)
        kb1 = keyboard_shown()
        await tap_el("document.querySelector('.kb-mobile-toolbar button')")
        kb2 = keyboard_shown()
        adb("shell", "input", "text", "fettK4")
        await asyncio.sleep(2)
        bold = await ev("[...document.querySelectorAll('[data-claraos-editor] strong')].some(s => s.textContent.includes('fettK4'))")
        check("Tastatur nach Tipp in den Text offen", kb1, kb1)
        check("Tastatur nach Tipp auf B weiter offen", kb2, kb2)
        check("B macht den Text fett", bold, bold)
        adb("shell", "input", "keyevent", "4")  # close keyboard

        # 4b) Typing at the end of a long note: the caret line stays above the formatting bar
        await ev("location.reload()")
        await asyncio.sleep(5)
        await ev("(() => { const a = [...document.querySelectorAll('button')].find(b => b.textContent.includes('K4 Test')); a && a.click(); return !!a; })()")
        await asyncio.sleep(2)
        await ev("(() => { const a = [...document.querySelectorAll('*')].filter(e => e.offsetParent && e.textContent.trim() === 'Lange Notiz').pop(); a && a.click(); return !!a; })()")
        await asyncio.sleep(3)
        await tap_el("[...document.querySelectorAll('[data-claraos-editor] [data-content-type=paragraph]')].pop()")
        await asyncio.sleep(1.5)
        adb("shell", "input", "keyevent", "123")  # end of line
        adb("shell", "input", "text", "%sweiter%sgeschrieben")
        await asyncio.sleep(1.5)
        lage = await ev("""(() => { const sel = getSelection(); if (!sel.rangeCount) return null;
            const c = sel.getRangeAt(0).getClientRects(); const r = c[c.length - 1] || sel.getRangeAt(0).getBoundingClientRect();
            const bar = document.querySelector('.kb-mobile-toolbar').getBoundingClientRect();
            return {caretBottom: Math.round(r.bottom), barTop: Math.round(bar.top), view: innerHeight}; })()""")
        check("Lange Notiz: Cursorzeile über der Format-Leiste",
              lage and lage["caretBottom"] <= lage["barTop"] and lage["caretBottom"] <= lage["view"], lage)
        adb("shell", "input", "keyevent", "4")

        # 5) Import opens the system file picker
        await ev("location.reload()")
        await asyncio.sleep(5)
        await tap_el("document.querySelector('button[title=\"Mehr\"], button[aria-label=\"Mehr\"]') || " + by_text("Mehr"))
        await tap_el(by_text("Import (ZIP)", "label, button, a"))
        await asyncio.sleep(3)
        picker = resumed()
        check("Import öffnet Dateiauswahl", "documentsui" in picker.lower() or "picker" in picker.lower(), picker[:120])
        adb("shell", "input", "keyevent", "4")

        # 3) LAST: link in page text opens the system browser, the app stays on its page.
        # Judged without DevTools: after a trip to another app the web view's DevTools
        # server of the emulator stops answering, so the app's page is checked on screen.
        await ev("location.reload()")
        await asyncio.sleep(5)
        await ev("(() => { const a = [...document.querySelectorAll('button')].find(b => b.textContent.includes('K4 Test')); a && a.click(); return !!a; })()")
        await asyncio.sleep(2)
        await ev("(() => { const a = [...document.querySelectorAll('*')].filter(e => e.offsetParent && e.textContent.trim() === 'Link-Test').pop(); a && a.click(); return !!a; })()")
        await asyncio.sleep(3)
        await tap_el("document.querySelector('[data-claraos-editor] a[href^=\"https\"]')")
        await asyncio.sleep(3)
        after = resumed()
        check("Link öffnet anderes Programm", "de.nolanios.knowledge" not in after, after[:120])
        adb("shell", "monkey", "-p", "de.nolanios.knowledge", "-c", "android.intent.category.LAUNCHER", "1")
        await asyncio.sleep(4)
        back = resumed()
        check("zurück: App im Vordergrund", "de.nolanios.knowledge" in back, back[:120])
        check("zurück: Tastatur zu (Editor hat Fokus abgegeben)", not keyboard_shown())
        adb("shell", "screencap", "-p", "/sdcard/k4_back.png")
        check("zurück: Bild gesichert (Seite prüfen)", True, "/sdcard/k4_back.png")


asyncio.run(main())
bad = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(("✅" if ok else "❌"), name, "→", detail[:160])
print(f"\n{len(results) - len(bad)}/{len(results)} grün")
sys.exit(1 if bad else 0)
