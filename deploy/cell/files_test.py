#!/usr/bin/env python3
"""Files/office test for a cell (layer 2) — from the user's perspective.

    ZELLE_TEST_PW=… python3 files_test.py <domain> <user>

1 Nextcloud file source connected (own credentials, no service account)
2 Write a file → see it in the listing → read its content
3 Create a document from Markdown (Collabora convert-to)
4 Get a WOPI token; the editor URL points to collabora.<domain>
5 Fetch CheckFileInfo the way Collabora does (access_token only, no session)
6 Editor page (cool.html) loads
7 Clean up
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from zelle_client import Zelle

DOM, USER = sys.argv[1], sys.argv[2]
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])
print("0 Anmeldung                               ok")

src = {s.get("id") or s.get("source"): s for s in z.get_json("/api/claraos/files/v2/sources")}
nc = next((s for s in src.values() if (s.get("type") or s.get("id")) == "nextcloud"), None)
assert nc and nc.get("connected"), f"Nextcloud-Quelle nicht verbunden: {nc}"
assert nc.get("zugang", nc.get("access", "eigen")) != "dienstkonto", "läuft über ein Dienstkonto!"
print(f"1 Quelle Nextcloud verbunden ({nc.get('zugang', 'eigen')})".ljust(41) + "ok")

marker = f"zelle-test {time.time():.0f}"
pfad = f"/zelle-test-{int(time.time())}.txt"
z.send_json("POST", "/api/claraos/files/v2/write", {"source": "nextcloud", "path": pfad, "content": marker})
baum = z.get_json("/api/claraos/files/v2/tree", source="nextcloud", path="/", depth=1)
namen = json.dumps(baum)
assert pfad.strip("/") in namen, "geschriebene Datei nicht im Verzeichnis"
inhalt = z.get_json("/api/claraos/files/v2/read", source="nextcloud", path=pfad)
assert marker in json.dumps(inhalt, ensure_ascii=False), "Inhalt stimmt nicht"
print("2 Schreiben → Verzeichnis → Lesen         ok")

doc = z.send_json("POST", "/api/claraos/office/create-document", {
    "filename": "Zelle-Test.docx", "folder": "Dokumente",
    "content_markdown": "# Zelle\n\nDieses Dokument hat Collabora aus Markdown gebaut."})
doc_pfad = doc.get("path") or doc.get("file", {}).get("path")
assert doc_pfad, f"kein Pfad in der Antwort: {list(doc)}"
print(f"3 Dokument erzeugt: {doc_pfad}".ljust(41) + "ok")

tok = z.send_json("POST", "/api/claraos/wopi/token", {"source": "nextcloud", "path": doc_pfad})
editor = tok.get("editor_url") or ""
assert urllib.parse.urlparse(editor).hostname == f"collabora.{DOM}", f"Editor-Host: {editor[:80]}"
print("4 WOPI-Token, Editor auf collabora." + DOM.split(".")[0] + "…".ljust(3) + "ok")

# Collabora has NO session — only the access_token. Hence a fresh client.
info_url = tok["wopi_src"] + "?access_token=" + urllib.parse.quote(tok["access_token"])
with urllib.request.urlopen(info_url, timeout=30) as r:
    info = json.loads(r.read().decode())
assert info.get("BaseFileName", "").endswith(".docx") and int(info.get("Size", 0)) > 0, info
print(f"5 CheckFileInfo ohne Sitzung: {info['BaseFileName']}, {info['Size']} B".ljust(41) + "ok")

code = urllib.request.urlopen(editor, timeout=30).status
assert code == 200, f"Editor HTTP {code}"
print("6 Editor-Seite (cool.html) lädt           ok")

for p in (pfad, doc_pfad):
    try:
        z.send_json("DELETE", "/api/claraos/files/v2/delete", {}, source="nextcloud", path=p)
    except Exception as e:  # cleanup must not mask the test result
        print(f"  (Aufräumen {p}: {e})")
print("7 aufgeräumt")
print("\nDATEIEN-/OFFICE-TEST GRÜN")
