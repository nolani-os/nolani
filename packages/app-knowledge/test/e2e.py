"""End-to-end check of the standalone Knowledge app in a headless browser (WASM driver).

Build first, then (from projects/claraos):
  node ../shell/node_modules/vite/bin/vite.js build --outDir /tmp/kb-dist   (in packages/app-knowledge)
  python3 -I packages/app-knowledge/test/e2e.py /tmp/kb-dist /tmp/kb-shots

Against the installed native app instead (its WebView started with
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222, port reachable here):
  python3 -I packages/app-knowledge/test/e2e.py cdp:http://127.0.0.1:9222 /tmp/kb-shots
The checks create test data in that app's database.

Needs the playwright Python package with Chromium. Exit code 0 = all checks passed.
"""
import functools
import http.server
import json
import sys
import threading

from playwright.sync_api import sync_playwright

dist, out = sys.argv[1], sys.argv[2]
cdp = dist[4:] if dist.startswith("cdp:") else None
srv = None
url = ""
if not cdp:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=dist)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_port}/"

results: list[tuple[str, bool, str]] = []
dialogs: list[str] = []
errors: list[str] = []
network_api: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))


API_SCRIPT = r"""
async () => {
  const K = "/api/claraos/knowledge";
  const j = async (method, path, body) => {
    const r = await fetch(K + path, { method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
  const R = {};
  // Collection with fields of every relevant kind
  const coll = (await j("POST", "/collections", { name: "E2E Ausgaben", default_type: "note" })).data.collection;
  R.coll = coll.id;
  const f = async (key, name, field_type, type_option) =>
    (await j("POST", `/collections/${coll.id}/fields`, { key, name, field_type, type_option }));
  R.fNum = (await f("betrag", "Betrag", 1)).status;
  R.fSel = (await f("status", "Status", 3, { options: [{ value: "offen" }, { value: "bezahlt" }] })).status;
  R.fDate = (await f("faellig", "Fällig", 2)).status;
  R.fBad = await f("kaputt", "Kaputt", 14, { expression: "1 +* (" });
  R.fFormula = (await f("brutto", "Brutto", 14, { expression: "prop(\"betrag\") * 1.19" })).status;
  const mk = async (title, properties) => {
    const o = (await j("POST", "/objects", { type: "note", title, properties })).data.object;
    await j("POST", `/collections/${coll.id}/items`, { object_id: o.id });
    return o.id;
  };
  const a = await mk("Miete", { betrag: 900, status: "bezahlt", faellig: "2026-11-01" });
  const b = await mk("Strom", { betrag: 80.5, status: "offen", faellig: "2026-11-15" });
  const c = await mk("Internet", { betrag: 40, status: "offen" });
  const d = await mk("Ohne Betrag", { status: "offen" });
  R.ids = { a, b, c, d };
  // Views: default + a filtered/sorted one
  R.views0 = (await j("GET", `/collections/${coll.id}/views`)).data.views.map((v) => v.name);
  const view = (await j("POST", `/collections/${coll.id}/views`, {
    name: "Offen nach Betrag", layout: "table",
    filters: { op: "and", children: [{ key: "status", op: "is", value: "offen" }] },
    sorts: [{ key: "betrag", dir: "desc" }],
  }));
  R.viewCreate = view.status;
  const vid = view.data.view?.id;
  R.rowsAll = (await j("GET", `/collections/${coll.id}/rows`)).data;
  R.rowsView = await j("GET", `/collections/${coll.id}/rows?view_id=${vid}`);
  R.aggSum = (await j("GET", `/collections/${coll.id}/aggregate?key=betrag&agg=sum`)).data;
  R.aggSumView = (await j("GET", `/collections/${coll.id}/aggregate?key=betrag&agg=sum&view_id=${vid}`)).data;
  R.preview = (await j("POST", `/collections/${coll.id}/formula/preview`, { expression: "prop(\"betrag\") / 2" })).data;
  R.previewBad = (await j("POST", `/collections/${coll.id}/formula/preview`, { expression: "((" })).data;
  // Relation + rollup in a second collection
  const proj = (await j("POST", "/collections", { name: "E2E Projekte", default_type: "note" })).data.collection;
  await j("POST", `/collections/${proj.id}/fields`, { key: "kosten", name: "Kosten", field_type: 10, type_option: { collection_id: coll.id } });
  await j("POST", `/collections/${proj.id}/fields`, { key: "summe", name: "Summe", field_type: 11,
    type_option: { relation_field: "kosten", target_field: "betrag", aggregate: "sum" } });
  await j("POST", `/collections/${proj.id}/fields`, { key: "anzahl", name: "Anzahl", field_type: 11,
    type_option: { relation_field: "kosten", aggregate: "count" } });
  const p = (await j("POST", "/objects", { type: "note", title: "Wohnung" })).data.object.id;
  await j("POST", `/collections/${proj.id}/items`, { object_id: p });
  R.rel = (await j("PUT", `/objects/${p}/relations`, { field_key: "kosten", target_ids: [a, b, "00000000-0000-0000-0000-000000000000"] })).data;
  R.projRows = (await j("GET", `/collections/${proj.id}/rows`)).data.rows;
  R.backlinksA = (await j("GET", `/objects/${a}/backlinks`)).data.backlinks.map((x) => [x.title, x.kind]);
  // Mentions → backlinks; unlinked mention → backmentions
  const n1 = (await j("POST", "/objects", { type: "note", title: "Notiz mit Verweis", body: `Siehe [Miete](#kb-${a}) und Strom` })).data.object.id;
  R.backlinksA2 = (await j("GET", `/objects/${a}/backlinks`)).data.backlinks.map((x) => [x.title, x.kind]);
  R.backmentionsB = (await j("GET", `/objects/${b}/backmentions`)).data.backmentions.map((x) => x.title);
  // Links (sidebar)
  R.link = (await j("POST", `/objects/${n1}/links`, { to_id: b, rel: "relates_to" })).status;
  R.linkSelf = (await j("POST", `/objects/${n1}/links`, { to_id: n1 })).status;
  R.detailLinks = (await j("GET", `/objects/${b}`)).data.object.links.map((l) => [l.direction, l.other_title]);
  // History: two edits → versions, diff, rename, restore
  await j("PATCH", `/objects/${n1}`, { body: "Erste Fassung des Textes" });
  await j("PATCH", `/objects/${n1}`, { body: "Zweite Fassung des Textes mit mehr" });
  await j("PATCH", `/objects/${n1}`, { body: "Zweite Fassung des Textes mit mehr" }); // unchanged → no version
  const hist = (await j("GET", `/objects/${n1}/history`)).data.history;
  R.histVersions = hist.map((h) => h.version);
  R.diff = (await j("GET", `/objects/${n1}/history/2/diff`)).data;
  R.rename = (await j("PATCH", `/objects/${n1}/history/2`, { name: "vor dem Umbau" })).status;
  R.histName = (await j("GET", `/objects/${n1}/history`)).data.history.find((h) => h.version === 2)?.name;
  await j("POST", `/objects/${n1}/history/2/restore`);
  R.afterRestore = (await j("GET", `/objects/${n1}`)).data.object.body;
  // Attachment upload (FormData) and binary download
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));
  const form = new FormData();
  form.append("file", new File([png], "punkt.png", { type: "image/png" }));
  const up = await fetch(`${K}/objects/${n1}/attachments`, { method: "POST", body: form });
  R.upload = up.status;
  const att = (await up.json()).attachment;
  R.attUrl = att?.url;
  const dl = await fetch(att.url);
  R.download = [dl.status, dl.headers.get("Content-Type"), (await dl.arrayBuffer()).byteLength, png.length];
  R.attList = (await j("GET", `/objects/${n1}/attachments`)).data.attachments.length;
  await j("PATCH", `/objects/${n1}`, { body: `Bild:\n\n![punkt](${att.url})\n` });
  R.imgObject = n1;
  // Page templates
  const t = (await j("POST", "/templates", { name: "Besprechung", target_type: "note", body: "## Agenda\n- ", is_default: true })).data.template;
  R.templates = (await j("GET", "/templates")).data.templates.map((x) => x.name);
  const ft = (await j("POST", "/objects/from-template", { type: "note", title: "Montag", collection_id: coll.id })).data;
  R.fromTemplate = [ft.from_template === t.id, ft.object.body];
  // Export (whole + one collection) and import back
  const ex = await fetch(`${K}/export?collection_id=${coll.id}`);
  R.export = [ex.status, ex.headers.get("Content-Type"), ex.headers.get("Content-Disposition")];
  const zipBytes = new Uint8Array(await ex.arrayBuffer());
  R.exportSize = zipBytes.length;
  const imp = new FormData();
  imp.append("file", new File([zipBytes], "export.zip", { type: "application/zip" }));
  const ir = await fetch(`${K}/import`, { method: "POST", body: imp });
  R.import = [ir.status, await ir.json()];
  // Field/view lifecycle and errors
  const fields = (await j("GET", `/collections/${coll.id}/fields`)).data.fields;
  const fStatus = fields.find((x) => x.key === "status");
  R.patchField = (await j("PATCH", `/collections/${coll.id}/fields/${fStatus.id}`, { name: "Zustand" })).data.field?.name;
  R.deleteField = (await j("DELETE", `/collections/${coll.id}/fields/${fStatus.id}`)).status;
  R.valueKept = (await j("GET", `/objects/${a}`)).data.object.properties.status;
  const views = (await j("GET", `/collections/${coll.id}/views`)).data.views;
  R.deleteView = (await j("DELETE", `/collections/${coll.id}/views/${vid}`)).status;
  R.deleteLastView = (await j("DELETE", `/collections/${coll.id}/views/${views[0].id}`)).status;
  const bad = (await j("POST", `/collections/${coll.id}/views`, { name: "x", filters: { op: "and", children: [{ key: "nope", op: "zzz", value: 1 }] } })).data.view;
  R.badFilter = await j("GET", `/collections/${coll.id}/rows?view_id=${bad.id}`);
  return R;
}
"""

with sync_playwright() as pw:
    if cdp:
        browser = pw.chromium.connect_over_cdp(cdp)
        page = browser.contexts[0].pages[0]
    else:
        browser = pw.chromium.launch()
        ctx = browser.new_context(locale="de-DE", viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
    page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("request", lambda r: network_api.append(r.url) if "/api/" in r.url else None)
    if cdp:
        page.reload()
    else:
        page.goto(url)
    page.wait_for_timeout(3500)

    # 1) The reported case: a collection from a template, through the UI
    page.get_by_text("Mit einer Vorlage anfangen").first.click()
    page.wait_for_timeout(600)
    page.get_by_text("Urlaub & Ausflüge", exact=True).first.click()
    page.wait_for_timeout(3000)
    page.screenshot(path=f"{out}/k3_1_vorlage.png")
    text = page.evaluate("() => document.body.innerText")
    check("Vorlage ohne Fehlerdialog", not dialogs, " | ".join(dialogs))
    check("kein 'nicht verfügbar'", "nicht verfügbar" not in text)
    for col in ("Wann", "Kosten ca.", "Status", "Mit wem"):
        check(f"Spalte {col} sichtbar", col in text)
    for v in ("Nach Status", "Kalender"):
        check(f"Ansicht {v} vorhanden", v in text)

    # 2) API contract through the same fetch path the UI uses
    R = page.evaluate(API_SCRIPT)
    json.dump(R, open(f"{out}/k3_api.json", "w"), ensure_ascii=False, indent=1, default=str)
    ids = R["ids"]
    check("Felder anlegen 200", R["fNum"] == R["fSel"] == R["fDate"] == R["fFormula"] == 200)
    check("kaputte Formel → 400", R["fBad"]["status"] == 400, str(R["fBad"]["data"]))
    check("Standardansicht 'Alle Einträge'", R["views0"] == ["Alle Einträge"], str(R["views0"]))
    rows_all = R["rowsAll"]["rows"]
    check("Zeilen: 4", len(rows_all) == 4, str(len(rows_all)))
    brutto = {r["title"]: (r.get("formulas") or {}).get("brutto") for r in rows_all}
    check("Formel gerechnet", brutto.get("Miete") is not None, json.dumps(brutto, ensure_ascii=False))
    rv = R["rowsView"]
    check("Ansicht filtert+sortiert", rv["status"] == 200 and [r["title"] for r in rv["data"]["rows"]][:2] == ["Strom", "Internet"],
          json.dumps([r["title"] for r in rv["data"].get("rows", [])], ensure_ascii=False) if rv["status"] == 200 else str(rv))
    check("Summe alle = 1020.5", R["aggSum"]["value"] == 1020.5, str(R["aggSum"]))
    check("Summe Ansicht = 120.5", R["aggSumView"]["value"] == 120.5, str(R["aggSumView"]))
    check("Formelvorschau ok", R["preview"]["ok"] and len(R["preview"]["proben"]) == 3, str(R["preview"]))
    check("Formelvorschau Fehlertext", (not R["previewBad"]["ok"]) and bool(R["previewBad"]["fehler"]), str(R["previewBad"]))
    check("Relation: unbekanntes Ziel übersprungen", R["rel"]["skipped"] == 1 and len(R["rel"]["linked"]) == 2, str(R["rel"]))
    pr = R["projRows"][0] if R["projRows"] else {}
    check("Rollup Summe 980.5 / Anzahl 2", (pr.get("rollups") or {}).get("summe") == 980.5 and (pr.get("rollups") or {}).get("anzahl") == 2,
          str(pr.get("rollups")))
    check("Relation erzeugt Rückverweis", ["Wohnung", "relation_prop"] in R["backlinksA"], str(R["backlinksA"]))
    check("Erwähnung erzeugt Rückverweis", ["Notiz mit Verweis", "mention"] in R["backlinksA2"], str(R["backlinksA2"]))
    check("unverlinkte Erwähnung gefunden", "Notiz mit Verweis" in R["backmentionsB"], str(R["backmentionsB"]))
    check("Verknüpfung anlegen / Selbstverweis 400", R["link"] == 200 and R["linkSelf"] == 400)
    check("Verknüpfung im Detail (eingehend)", ["in", "Notiz mit Verweis"] in R["detailLinks"], str(R["detailLinks"]))
    check("Verlauf: 3 Versionen, keine Dublette", R["histVersions"] == [3, 2, 1], str(R["histVersions"]))
    check("Diff hat Änderungen", R["diff"]["summary"]["changed"], str(R["diff"].get("summary")))
    check("Version benennen", R["rename"] == 200 and R["histName"] == "vor dem Umbau", str(R["histName"]))
    check("Wiederherstellen", R["afterRestore"] == "Erste Fassung des Textes", repr(R["afterRestore"]))
    check("Anhang hoch/runter", R["upload"] == 200 and R["download"][0] == 200 and R["download"][1] == "image/png"
          and R["download"][2] == R["download"][3], str(R["download"]))
    check("Seitenvorlage", R["fromTemplate"][0] and R["fromTemplate"][1].startswith("## Agenda"), str(R["fromTemplate"]))
    check("Export ZIP", R["export"][0] == 200 and R["export"][1] == "application/zip" and R["exportSize"] > 100, str(R["export"]))
    check("Import ZIP", R["import"][0] == 200 and R["import"][1].get("collections") == 1, str(R["import"]))
    check("Feld umbenennen/löschen, Wert bleibt", R["patchField"] == "Zustand" and R["deleteField"] == 200
          and R["valueKept"] == "bezahlt", f'{R["patchField"]} {R["valueKept"]}')
    check("kaputter Filter → 400 mit Meldung", R["badFilter"]["status"] == 400, str(R["badFilter"]))
    check("Ansicht löschen / letzte nicht", R["deleteView"] == 200 and R["deleteLastView"] == 400,
          f'{R["deleteView"]} {R["deleteLastView"]}')

    # 3) Attachment shown in the editor (blob address via resolveFileUrl)
    page.reload()
    page.wait_for_timeout(3000)
    page.get_by_text("Alle", exact=True).first.click()
    page.wait_for_timeout(800)
    page.get_by_text("Notiz mit Verweis").first.click()
    page.wait_for_timeout(3000)
    src = page.evaluate("() => [...document.querySelectorAll('[data-claraos-editor] img')].map(i => i.src)")
    page.screenshot(path=f"{out}/k3_2_bild.png")
    check("Bild im Editor über blob:", any(s.startswith("blob:") for s in src), str(src))

    # 4) History panel in the UI
    browser.close()

if srv:
    srv.shutdown()
bad = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(("✅" if ok else "❌"), name, ("" if ok else f"→ {detail}"))
print(f"\n{len(results) - len(bad)}/{len(results)} grün · Netzaufrufe an /api: {len(network_api)} · Fehler: {errors[:4]}")
sys.exit(1 if bad else 0)
