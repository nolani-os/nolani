"""End-to-end check through a page-level DevTools target only.

Android's WebView exposes per-page DevTools targets but none of the
browser-level commands Playwright needs to attach, so this variant drives the
page with plain `Runtime.evaluate`: the reported case (collection from a
template, through the UI) and the same API contract block as e2e.py.

Usage (debug build, `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`):
  python3 -I packages/app-knowledge/test/e2e_page_cdp.py http://127.0.0.1:9333
Exit code 0 = all checks passed.
"""
import asyncio
import json
import sys
import urllib.request
from pathlib import Path

import websockets

base = sys.argv[1].rstrip("/")
src = Path(__file__).with_name("e2e.py").read_text()
API_SCRIPT = src.split('API_SCRIPT = r"""', 1)[1].split('"""', 1)[0]

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))


async def main() -> None:
    targets = json.load(urllib.request.urlopen(f"{base}/json/list"))
    page = next(t for t in targets if t.get("type") == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=50_000_000) as ws:
        seq = 0

        async def ev(expr: str, timeout: float = 120):
            nonlocal seq
            seq += 1
            await ws.send(json.dumps({"id": seq, "method": "Runtime.evaluate", "params": {
                "expression": expr, "awaitPromise": True, "returnByValue": True}}))
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
                if msg.get("id") == seq:
                    res = msg.get("result", {})
                    if "exceptionDetails" in res:
                        raise RuntimeError(json.dumps(res["exceptionDetails"])[:500])
                    return res.get("result", {}).get("value")

        click = """(t) => { const el = [...document.querySelectorAll('button, a, [role=button], span, div')]
              .filter(e => e.offsetParent !== null && e.textContent.trim() === t).pop();
              if (!el) return false; el.click(); return true; }"""
        sleep = "new Promise(r => setTimeout(r, %d))"
        await ev("location.reload()")
        await asyncio.sleep(6)
        await ev("window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m)); "
                 "window.confirm = () => true; true")
        check("Vorlage öffnen", await ev(f"({click})('Mit einer Vorlage anfangen')"))
        await ev(sleep % 800)
        check("Vorlage wählen", await ev(f"({click})('Urlaub & Ausflüge')"))
        await ev(sleep % 3500)
        text = await ev("document.body.innerText")
        alerts = await ev("window.__alerts")
        check("Vorlage ohne Fehlerdialog", not alerts, str(alerts))
        check("kein 'nicht verfügbar'", "nicht verfügbar" not in text)
        for col in ("Kosten ca.", "Nach Status", "Kalender"):
            check(f"{col} sichtbar", col in text, text[:300].replace("\n", " | "))
        R = await ev(f"({API_SCRIPT})()", timeout=300)
        check("Formel gerechnet", any((r.get("formulas") or {}).get("brutto") for r in R["rowsAll"]["rows"]))
        check("Ansicht filtert+sortiert", [r["title"] for r in R["rowsView"]["data"]["rows"]][:2] == ["Strom", "Internet"])
        check("Summe Ansicht = 120.5", R["aggSumView"]["value"] == 120.5, str(R["aggSumView"]))
        check("Rollup 980.5 / 2", (R["projRows"][0].get("rollups") or {}) == {"summe": 980.5, "anzahl": 2},
              str(R["projRows"][0].get("rollups")))
        check("Rückverweise", ["Notiz mit Verweis", "mention"] in R["backlinksA2"])
        check("Verlauf 3/2/1 + Wiederherstellen", R["histVersions"] == [3, 2, 1]
              and R["afterRestore"] == "Erste Fassung des Textes")
        check("Anhang hoch/runter", R["upload"] == 200 and R["download"][2] == R["download"][3], str(R["download"]))
        check("Export + Import", R["export"][0] == 200 and R["import"][0] == 200, str(R["import"]))
        check("kaputter Filter 400", R["badFilter"]["status"] == 400)
        driver = await ev("window.__knowledgeDriver")
        check("nativer SQLite-Treiber", driver == "native", str(driver))


asyncio.run(main())
bad = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(("✅" if ok else "❌"), name, ("" if ok else f"→ {detail}"))
print(f"\n{len(results) - len(bad)}/{len(results)} grün")
sys.exit(1 if bad else 0)
