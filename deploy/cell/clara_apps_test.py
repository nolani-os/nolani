#!/usr/bin/env python3
"""Clara operates the cell's apps — through the brain, as the user (grows per app).

    ZELLE_TEST_PW=… python3 clara_apps_test.py <domain> <user>

(Sections: Paperless, routines, browser, Mastodon, Immich, Dienste, PeerTube.)
Paperless:
  1 the user has opened Paperless once (OIDC) and uploads a document with a random code
  2 asked in the chat, Clara finds the document and reads the code — only possible if
    the tool, the automatically created per-user access and reading all work
  3 clean up
The proof is always a fact Clara can only know through the tool, never her wording.
Needs a connected brain (otherwise skipped). Costs a few cents. Never prints passwords.
"""
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from zelle_client import Zelle

DOM, USER = sys.argv[1], sys.argv[2]
PAPERLESS = f"https://paperless.{DOM}"
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])
print("0 Anmeldung                               ok")
if not z.get_json("/api/claraos/routinen/status").get("gehirn"):
    print("CLARA-APPS-TEST ÜBERSPRUNGEN: kein Gehirn angebunden")
    sys.exit(0)


def frage(text: str) -> str:
    """Ask Clara through the shell's chat endpoint (like the frontend)."""
    body = {"model": "clara/everyday", "stream": True, "messages": [{"role": "user", "content": text}]}
    r = urllib.request.Request(z.shell + "/api/claraos/chat/v2/completions", data=json.dumps(body).encode(),
                               method="POST", headers={"Content-Type": "application/json",
                                                       "Accept": "text/event-stream"})
    out = []
    with z.op.open(r, timeout=300) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            try:
                d = json.loads(line[5:].strip())
            except ValueError:
                continue
            for ch in d.get("choices", []):
                out.append((ch.get("delta") or {}).get("content") or "")
    return "".join(out).strip()


def anfrage(method, url, body=None, headers=None):
    h = dict(headers or {})
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    try:
        with z.op.open(urllib.request.Request(url, data=body, method=method, headers=h), timeout=120) as r:
            txt = r.read().decode() or "null"
            return r.status, json.loads(txt) if txt.lstrip()[:1] in "[{\"n" else txt
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def pdf(text: str) -> bytes:
    strom = f"BT /F1 20 Tf 60 720 Td ({text}) Tj ET".encode()
    objekte = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
               b"/Resources << /Font << /F1 5 0 R >> >> >>",
               b"<< /Length " + str(len(strom)).encode() + b" >>\nstream\n" + strom + b"\nendstream",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objekte, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objekte) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offs)
    return out + f"trailer\n<< /Size {len(objekte) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


# ── Paperless ───────────────────────────────────────────────────────────
# 1 open Paperless once (that creates the account), upload a document
r = z.get(f"{PAPERLESS}/")
seite = r.read().decode()
form = re.search(r'<form[^>]*id="social-login"[^>]*>(.*?)</form>', seite, re.S)
if form:
    aktion = re.search(r'action="([^"]+)"', form.group(0)).group(1).replace("&amp;", "&")
    csrf = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', form.group(0)).group(1)
    rueck = z.oidc_rueckweg(urllib.request.Request(
        urllib.parse.urljoin(r.geturl(), aktion), method="POST",
        data=urllib.parse.urlencode({"csrfmiddlewaretoken": csrf}).encode(),
        headers={"Referer": r.geturl(), "Content-Type": "application/x-www-form-urlencoded"}))
    if "/login/callback/" in rueck:
        z.get(rueck)
token = next(c.value for c in z.jar if c.name == "csrftoken" and "paperless" in c.domain)
ph = {"X-CSRFToken": token, "Referer": f"{PAPERLESS}/"}
code = str(random.randint(100000, 999999))
titel = f"Clara-Test {uuid.uuid4().hex[:6]}"
grenze = uuid.uuid4().hex
body = (f'--{grenze}\r\nContent-Disposition: form-data; name="title"\r\n\r\n{titel}\r\n'
        f'--{grenze}\r\nContent-Disposition: form-data; name="document"; filename="test.pdf"\r\n'
        f'Content-Type: application/pdf\r\n\r\n').encode() + pdf(f"Kennzahl {code}") + f"\r\n--{grenze}--\r\n".encode()
s, task = anfrage("POST", f"{PAPERLESS}/api/documents/post_document/", body,
                  {**ph, "Content-Type": f"multipart/form-data; boundary={grenze}"})
assert s == 200, f"Upload abgelehnt: {s}"
doc = None
for _ in range(60):
    s, t = anfrage("GET", f"{PAPERLESS}/api/tasks/?task_id={task}", headers=ph)
    t = (t or [{}])[0] if isinstance(t, list) else {}
    if t.get("status") == "SUCCESS":
        doc = t.get("related_document")
        break
    time.sleep(3)
assert doc, "Dokument nicht verarbeitet"
print(f"1 Paperless: Dokument „{titel}“ abgelegt".ljust(41) + "ok")

try:
    # 2 Clara finds and reads it
    antwort = frage(f"Suche in meinem Paperless das Dokument mit dem Titel „{titel}“, lies es "
                    f"und nenne mir nur die Kennzahl, die darin steht.")
    assert code in antwort, f"Clara nannte die Kennzahl nicht: {antwort[:300]!r}"
    print(f"2 Clara liest Paperless: Kennzahl {code} genannt".ljust(41) + "ok")
finally:
    # 3 clean up
    anfrage("DELETE", f"{PAPERLESS}/api/documents/{doc}/", headers=ph)
    anfrage("POST", f"{PAPERLESS}/api/trash/", {"action": "empty", "documents": [int(doc)]}, ph)
    print("3 aufgeräumt")

# ── Routines by chat ────────────────────────────────────────────────────
R = "/api/claraos/routinen"
rname = f"Testroutine {uuid.uuid4().hex[:6]}"
try:
    frage(f"Lege eine Routine mit dem Titel „{rname}“ an: werktags um 08:15 soll sie mir meine "
          f"offenen Aufgaben im Planner zusammenfassen.")
    r = next((x for x in z.get_json(R) if x["titel"] == rname), None)
    assert r, "Clara hat keine Routine angelegt"
    assert (r["rhythmus"], r["uhrzeit"], r["aktiv"]) == ("werktags", "08:15", True), \
        f"falsch angelegt: {r['rhythmus']} {r['uhrzeit']} aktiv={r['aktiv']}"
    print("4 Routine per Chat angelegt (werktags 08:15) ok")
    frage(f"Pausiere bitte meine Routine „{rname}“.")
    r = next(x for x in z.get_json(R) if x["titel"] == rname)
    assert r["aktiv"] is False, "Routine nicht pausiert"
    print("5 Routine per Chat pausiert               ok")
finally:
    for x in z.get_json(R):
        if x["titel"] == rname:
            z.send_json("DELETE", f"{R}/{x['id']}", {})

# ── Browser ─────────────────────────────────────────────────────────────
import subprocess  # noqa: E402 — the browser is checked from inside its container


def browser_tabs() -> list[str]:
    """Open pages in the user's desktop browser (CDP from inside its own container)."""
    p = subprocess.run(["docker", "exec", f"ubd-{USER}", "curl", "-s", "-m", "5",
                        "http://127.0.0.1:9222/json/list"], capture_output=True, text=True)
    try:
        return [t.get("url", "") for t in json.loads(p.stdout or "[]") if t.get("type") == "page"]
    except ValueError:
        return []


ziel = f"https://example.com/?clara={uuid.uuid4().hex[:8]}"
antwort = frage(f"Öffne bitte {ziel} in meinem Browser.")
tabs = []
for _ in range(20):
    tabs = browser_tabs()
    if any(t.startswith(ziel) for t in tabs):
        break
    time.sleep(3)
assert any(t.startswith(ziel) for t in tabs), \
    f"Seite nicht im eigenen Browser offen: {tabs[:5]} — Clara: {antwort[:300]!r}"
print("6 Clara öffnet eine Seite im eigenen Browser ok")

# ── Mastodon (shared social cell) ───────────────────────────────────────
import html  # noqa: E402

SOCIAL = f"https://social.{DOM.split('.', 1)[1]}"
s_inst, _ = anfrage("GET", f"{SOCIAL}/api/v1/instance")
if s_inst != 200:
    print("7 Mastodon: keine Social-Zelle hier — übersprungen")
else:
    # the user signs in once (that creates the account), like social_test
    seite = z.get(f"{SOCIAL}/auth/sign_in").read().decode()
    if 'href="/auth/auth/openid_connect"' in seite:
        csrf = re.search(r'<meta name="csrf-token" content="([^"]+)"', seite).group(1)
        rueck = z.oidc_rueckweg(urllib.request.Request(
            f"{SOCIAL}/auth/auth/openid_connect", method="POST",
            data=urllib.parse.urlencode({"authenticity_token": html.unescape(csrf)}).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Referer": f"{SOCIAL}/auth/sign_in"}))
        if "/auth/auth/openid_connect/callback" in rueck:
            z.get(rueck)
    m = re.search(r'<script[^>]*id="initial-state"[^>]*>(.*?)</script>',
                  z.get(f"{SOCIAL}/home").read().decode(), re.S)
    mh = {"Authorization": f"Bearer {json.loads(m.group(1))['meta']['access_token']}"}
    s, me = anfrage("GET", f"{SOCIAL}/api/v1/accounts/verify_credentials", headers=mh)
    assert s == 200, f"Mastodon-Anmeldung: {s}"
    eigene = []
    try:
        # 7 Clara reads: a private post with a random code
        code = str(random.randint(100000, 999999))
        s, st = anfrage("POST", f"{SOCIAL}/api/v1/statuses",
                        {"status": f"Notiz für Clara: Kennzahl {code}", "visibility": "private"}, mh)
        assert s == 200, f"Beitrag abgelehnt: {s}"
        eigene.append(st["id"])
        antwort = frage("Was habe ich zuletzt auf Mastodon gepostet? Nenne mir nur die Kennzahl daraus.")
        assert code in antwort, f"Clara nannte die Kennzahl nicht: {antwort[:300]!r}"
        print(f"7 Clara liest Mastodon: Kennzahl {code}".ljust(41) + "ok")

        # 8 Clara posts: only a proposal, nothing on Mastodon yet
        code2 = uuid.uuid4().hex[:8]
        antwort = frage(f"Poste bitte auf Mastodon nur für meine Follower genau diesen Text: "
                        f"Clara-Freigabe {code2}")
        f = next((lauf for lauf in z.get_json("/api/claraos/routinen/freigaben")
                  for v in lauf["vorschlaege"]
                  if v["status"] == "offen" and code2 in json.dumps(v["argumente"])), None)
        assert f, f"kein Freigabe-Vorschlag — Clara: {antwort[:300]!r}"
        s, liste = anfrage("GET", f"{SOCIAL}/api/v1/accounts/{me['id']}/statuses?limit=5", headers=mh)
        assert not any(code2 in x.get("content", "") for x in liste), "OHNE Freigabe gepostet!"
        print("8 Posten wartet auf Freigabe, nichts gepostet ok")

        # 9 the user approves by button -> posted
        idx = next(i for i, v in enumerate(f["vorschlaege"]) if code2 in json.dumps(v["argumente"]))
        erg = z.send_json("POST", f"/api/claraos/routinen/laeufe/{f['id']}/vorschlaege/{idx}",
                          {"freigeben": True})
        assert erg.get("status") == "ausgefuehrt", f"Freigabe: {str(erg)[:300]}"
        s, liste = anfrage("GET", f"{SOCIAL}/api/v1/accounts/{me['id']}/statuses?limit=5", headers=mh)
        neu = [x for x in liste if code2 in x.get("content", "")]
        assert neu, "nach Freigabe nicht gepostet"
        eigene += [x["id"] for x in neu]
        print("9 nach Freigabe gepostet                  ok")
    finally:
        for sid in eigene:
            anfrage("DELETE", f"{SOCIAL}/api/v1/statuses/{sid}", headers=mh)

# ── Immich ──────────────────────────────────────────────────────────────
from medien_test_hilfen import jpeg, multipart  # noqa: E402

IMMICH = f"https://immich.{DOM}"
s, d = anfrage("POST", f"{IMMICH}/api/oauth/authorize", {"redirectUri": f"{IMMICH}/auth/login"})
assert s in (200, 201) and "url" in d, f"Immich-Anmeldung: {s}"
s, d = anfrage("POST", f"{IMMICH}/api/oauth/callback", {"url": z.oidc_rueckweg(d["url"])})
assert s in (200, 201) and d.get("accessToken"), f"Immich-Callback: {s}"
ih = {"Authorization": f"Bearer {d['accessToken']}"}
marker = f"clara-foto-{uuid.uuid4().hex[:8]}"
jetzt = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
body, typ = multipart({"fileCreatedAt": jetzt, "fileModifiedAt": jetzt, "filename": f"{marker}.jpg"},
                      ("assetData", f"{marker}.jpg", "image/jpeg", jpeg(marker)))
s, d = anfrage("POST", f"{IMMICH}/api/assets", body, {**ih, "Content-Type": typ})
assert s in (200, 201) and d.get("id"), f"Upload abgelehnt: {s}"
aid = d["id"]
try:
    time.sleep(10)          # metadata extraction (the search lists processed assets)
    antwort = frage("Wie heißt die Datei meines neuesten Fotos in Immich? Nenne nur den Dateinamen.")
    assert marker in antwort, f"Clara nannte das Foto nicht: {antwort[:300]!r}"
    print("10 Clara findet das neueste Foto in Immich ok")
    # Clara's key must be read-only: reading the photo works, deleting/uploading does not
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "immich_rechte_probe.py"), "rb") as f:
        p = subprocess.run(["docker", "exec", "-i", "claraos-claraos-api-1", "python3", "-", USER, aid],
                           input=f.read(), capture_output=True)
    probe = p.stdout.decode().strip().splitlines()[-1:] or [p.stderr.decode()[-200:]]
    assert probe[0].startswith("LESEN 200 LOESCHEN 403 HOCHLADEN 403"), f"Schlüssel nicht nur lesend: {probe[0]}"
    print("11 Claras Immich-Schlüssel: nur lesen   ok")
finally:
    anfrage("DELETE", f"{IMMICH}/api/assets", {"ids": [aid], "force": True}, ih)

# ── Dienste (third-party services) ──────────────────────────────────────
HIER = os.path.dirname(os.path.abspath(__file__))


def im_api(skript: str, *args: str) -> str:
    with open(os.path.join(HIER, skript), "rb") as f:
        p = subprocess.run(["docker", "exec", "-i", "claraos-claraos-api-1", "python3", "-", *args],
                           input=f.read(), capture_output=True)
    return p.stdout.decode().strip()


kennung = uuid.uuid4().hex[:6]
dienst, versteckt = f"testdienst-{kennung}", f"testdienst-{kennung}-x"
d_url = f"https://example.org/?dienst={kennung}"
im_api("dienst_test_hilfe.py", "an", dienst, f"Testdienst {kennung}", d_url)
im_api("dienst_test_hilfe.py", "an", versteckt, f"Geheimdienst {kennung}", "https://example.org/x",
       "gruppe-die-es-nicht-gibt")
try:
    ids = [x["id"] for x in z.get_json("/api/claraos/apps/dienste")["dienste"]]
    assert dienst in ids and versteckt not in ids, f"Sichtbarkeit falsch: {ids}"
    print("12 Dienste: eigener sichtbar, fremder nicht ok")
    antwort = frage(f"Öffne bitte meinen Dienst „Testdienst {kennung}“.")
    tabs = []
    for _ in range(20):
        tabs = browser_tabs()
        if any(t.startswith(d_url) for t in tabs):
            break
        time.sleep(3)
    assert any(t.startswith(d_url) for t in tabs), f"Dienst nicht geöffnet: {tabs[:5]} — Clara: {antwort[:300]!r}"
    print("13 Clara öffnet den Dienst im Browser     ok")
finally:
    im_api("dienst_test_hilfe.py", "weg", dienst)
    im_api("dienst_test_hilfe.py", "weg", versteckt)

# ── PeerTube (public videos) ────────────────────────────────────────────
VIDEO = f"https://video.{DOM.split('.', 1)[1]}"
s_cfg, cfg = anfrage("GET", f"{VIDEO}/api/v1/config")
if s_cfg != 200:
    print("14 PeerTube: keine Social-Zelle hier — übersprungen")
else:
    # sign in once (creates the account), as in social_test
    ext = [a for a in (cfg.get("plugin") or {}).get("registeredExternalAuths", []) if "openid" in a.get("npmName", "")][0]
    rueck = z.oidc_rueckweg(f"{VIDEO}/plugins/{ext['name']}/{ext['version']}/auth/{ext['authName']}")
    if "/router/code-cb" in rueck:
        rueck = z.get(rueck).geturl()
    q = urllib.parse.parse_qs(urllib.parse.urlparse(rueck).query)
    s, cl = anfrage("GET", f"{VIDEO}/api/v1/oauth-clients/local")
    tok_req = urllib.request.Request(
        f"{VIDEO}/api/v1/users/token", method="POST",
        data=urllib.parse.urlencode({"client_id": cl["client_id"], "client_secret": cl["client_secret"],
                                     "grant_type": "password", "response_type": "code",
                                     "username": q["username"][0],
                                     "externalAuthToken": q["externalAuthToken"][0]}).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    pth = {"Authorization": f"Bearer {json.loads(z.op.open(tok_req, timeout=60).read())['access_token']}"}
    s, ich = anfrage("GET", f"{VIDEO}/api/v1/users/me", headers=pth)
    kanal = ich["videoChannels"][0]["id"]
    # a one-second clip, made by PeerTube's own ffmpeg
    clip = subprocess.run(["docker", "exec", "claraos-peertube-1", "sh", "-c",
                           "ffmpeg -loglevel error -f lavfi -i color=c=blue:s=64x64:d=1 -pix_fmt yuv420p "
                           "-movflags frag_keyframe+empty_moov -f mp4 -"], capture_output=True).stdout
    assert len(clip) > 500, "kein Testvideo erzeugt"
    code, wort = str(random.randint(100000, 999999)), random.choice(["Tulpenfeld", "Leuchtturm", "Kastanie"])
    body, typ = multipart({"name": f"Clara {code} {wort}", "channelId": kanal, "privacy": 1,
                           "waitTranscoding": "false"}, ("videofile", "clip.mp4", "video/mp4", clip))
    s, vid = anfrage("POST", f"{VIDEO}/api/v1/videos/upload", body, {**pth, "Content-Type": typ})
    assert s == 200 and vid.get("video"), f"Video-Upload: {s} {str(vid)[:200]}"
    vuuid = vid["video"]["uuid"]
    try:
        time.sleep(8)
        antwort = frage(f"Suche auf PeerTube nach dem Video mit {code} im Titel. Welches Wort steht "
                        f"im Titel nach der Zahl? Nur das Wort.")
        assert wort in antwort, f"Clara fand das Video nicht: {antwort[:300]!r}"
        print(f"14 Clara findet das PeerTube-Video ({wort})".ljust(41) + "ok")
    finally:
        anfrage("DELETE", f"{VIDEO}/api/v1/videos/{vuuid}", headers=pth)

print("\nCLARA-APPS-TEST GRÜN")
