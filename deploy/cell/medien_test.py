#!/usr/bin/env python3
"""Photos/documents test for a cell (layer 5) — from the user's perspective.

    ZELLE_TEST_PW=… python3 medien_test.py <domain> <user>

1 Immich: login via Authentik (OIDC), account created automatically, NOT admin, quota set
2 Immich: upload a photo → visible to the owner → delete it for good
3 Paperless: login via Authentik (OIDC), account in group `nutzer`
4 Paperless: upload a PDF → text recognised → delete it and empty the trash
5 Paperless: workflows are closed to normal users (webhooks from the server)
No third-party libraries. Never prints passwords or tokens.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from medien_test_hilfen import jpeg, multipart
from zelle_client import Zelle

DOM, USER = sys.argv[1], sys.argv[2]
IMMICH = f"https://immich.{DOM}"
PAPERLESS = f"https://paperless.{DOM}"
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])
print("0 Anmeldung                               ok")
marker = f"zelle-test-{uuid.uuid4().hex[:10]}"



def anfrage(method, url, body=None, headers=None):
    h = dict(headers or {})
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    r = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with z.op.open(r, timeout=120) as resp:
            txt = resp.read().decode() or "null"
            return resp.status, json.loads(txt) if txt.lstrip()[:1] in "[{\"n" else txt
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]



def pdf(text: str) -> bytes:
    """One-page PDF with a real text layer (Paperless reads it without OCR)."""
    strom = f"BT /F1 24 Tf 72 720 Td ({text}) Tj ET".encode()
    objekte = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(strom)).encode() + b" >>\nstream\n" + strom + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offs = []
    for i, o in enumerate(objekte, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objekte) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offs)
    out += f"trailer\n<< /Size {len(objekte) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


# ── 1 Immich: OIDC login ────────────────────────────────────────────────
s, d = anfrage("POST", f"{IMMICH}/api/oauth/authorize", {"redirectUri": f"{IMMICH}/auth/login"})
assert s in (200, 201) and "url" in d, f"Immich bietet keine OIDC-Anmeldung an: HTTP {s} {d}"
rueck = z.oidc_rueckweg(d["url"])
assert rueck.startswith(f"{IMMICH}/auth/login?"), f"Rücksprung geht woanders hin: {rueck.split('?')[0]}"
s, d = anfrage("POST", f"{IMMICH}/api/oauth/callback", {"url": rueck})
assert s in (200, 201) and d.get("accessToken"), f"Immich-Callback abgelehnt: HTTP {s} {d}"
assert d.get("isAdmin") is False, "Testkonto ist in Immich ADMIN"
ih = {"Authorization": f"Bearer {d['accessToken']}"}
s, me = anfrage("GET", f"{IMMICH}/api/users/me", headers=ih)
quota = (me or {}).get("quotaSizeInBytes")
assert quota and quota > 0, f"kein Kontingent gesetzt: {quota}"
s, _ = anfrage("GET", f"{IMMICH}/api/admin/users", headers=ih)
assert s in (401, 403), f"Nutzer sieht die Admin-Nutzerliste: HTTP {s}"
print(f"1 Immich: OIDC, kein Admin, {quota / 2**30:.0f} GB Kontingent".ljust(41) + "ok")

# ── 2 Immich: upload → visible → delete ─────────────────────────────────
jetzt = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
body, typ = multipart({"fileCreatedAt": jetzt, "fileModifiedAt": jetzt, "filename": f"{marker}.jpg"},
                      ("assetData", f"{marker}.jpg", "image/jpeg", jpeg(marker)))
s, d = anfrage("POST", f"{IMMICH}/api/assets", body, {**ih, "Content-Type": typ})
assert s in (200, 201) and d.get("id"), f"Upload abgelehnt: HTTP {s} {d}"
aid = d["id"]
s, a = anfrage("GET", f"{IMMICH}/api/assets/{aid}", headers=ih)
assert s == 200 and a.get("originalFileName") == f"{marker}.jpg", f"Foto nicht sichtbar: HTTP {s}"
s, _ = anfrage("DELETE", f"{IMMICH}/api/assets", {"ids": [aid], "force": True}, ih)
assert s in (200, 204), f"Löschen abgelehnt: HTTP {s}"
print("2 Immich: Hochladen → sehen → löschen     ok")

# ── 3 Paperless: OIDC login ─────────────────────────────────────────────
r = z.get(f"{PAPERLESS}/")
seite = r.read().decode()
assert "/accounts/login" in r.geturl(), f"keine Anmeldeseite: {r.geturl()}"
form = re.search(r'<form[^>]*id="social-login"[^>]*>(.*?)</form>', seite, re.S) \
    or re.search(r'<form[^>]*action="[^"]*/accounts/oidc/authentik/login/[^"]*"[^>]*>(.*?)</form>', seite, re.S)
assert form, "kein SSO-Formular auf der Anmeldeseite"
aktion = re.search(r'action="([^"]+)"', form.group(0)).group(1).replace("&amp;", "&")
csrf = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', form.group(0)).group(1)
start = urllib.request.Request(
    urllib.parse.urljoin(r.geturl(), aktion), method="POST",
    data=urllib.parse.urlencode({"csrfmiddlewaretoken": csrf}).encode(),
    headers={"Referer": r.geturl(), "Content-Type": "application/x-www-form-urlencoded"})
rueck = z.oidc_rueckweg(start)
# With an existing consent Authentik redirects straight back and the opener has already
# followed the callback — then `rueck` is the Paperless page after login.
if rueck.startswith(f"{PAPERLESS}/accounts/oidc/authentik/login/callback/"):
    rueck = z.get(rueck).geturl()
assert rueck.startswith(PAPERLESS) and "/accounts/" not in rueck, \
    f"nicht angemeldet: {rueck.split('?')[0]}"
token = next(c.value for c in z.jar if c.name == "csrftoken" and "paperless" in c.domain)
ph = {"X-CSRFToken": token, "Referer": f"{PAPERLESS}/"}
s, profil = anfrage("GET", f"{PAPERLESS}/api/profile/", headers=ph)
assert s == 200, f"Profil nicht lesbar: HTTP {s}"
s, ui = anfrage("GET", f"{PAPERLESS}/api/ui_settings/", headers=ph)
rechte = set((ui or {}).get("permissions") or [])
assert "add_document" in rechte, f"Konto hat keine Rechte (Gruppe nutzer fehlt?): {sorted(rechte)[:5]}"
print("3 Paperless: OIDC, Gruppe nutzer          ok")

# ── 4 Paperless: upload → text → delete ─────────────────────────────────
body, typ = multipart({"title": marker}, ("document", f"{marker}.pdf", "application/pdf", pdf(marker)))
s, task = anfrage("POST", f"{PAPERLESS}/api/documents/post_document/", body, {**ph, "Content-Type": typ})
assert s == 200 and task, f"Upload abgelehnt: HTTP {s} {task}"
doc = None
for _ in range(60):
    s, t = anfrage("GET", f"{PAPERLESS}/api/tasks/?task_id={task}", headers=ph)
    t = (t or [{}])[0] if isinstance(t, list) else {}
    if t.get("status") == "SUCCESS":
        doc = t.get("related_document")
        break
    assert t.get("status") != "FAILURE", f"Verarbeitung gescheitert: {str(t.get('result'))[:200]}"
    time.sleep(3)
assert doc, "Dokument nach 3 Minuten nicht verarbeitet"
s, d = anfrage("GET", f"{PAPERLESS}/api/documents/{doc}/", headers=ph)
assert s == 200 and marker in (d.get("content") or ""), "Text nicht erkannt"
s, _ = anfrage("DELETE", f"{PAPERLESS}/api/documents/{doc}/", headers=ph)
assert s in (200, 204), f"Löschen abgelehnt: HTTP {s}"
s, _ = anfrage("POST", f"{PAPERLESS}/api/trash/", {"action": "empty", "documents": [int(doc)]}, ph)
assert s in (200, 204), f"Papierkorb nicht geleert: HTTP {s}"
print("4 Paperless: Hochladen → Text → löschen   ok")

# ── 5 Paperless: no workflows for normal users ──────────────────────────
s, _ = anfrage("GET", f"{PAPERLESS}/api/workflows/", headers=ph)
assert s == 403, f"Workflows für normale Nutzer offen: HTTP {s}"
print("5 Paperless: Workflows gesperrt           ok")

# ── 6 Paperless: no self-registration from outside ──────────────────────
# Without any real account Paperless offers "first account = admin" to everyone; the
# admin from compose.yml must keep that closed. Checked WITHOUT a session.
fremd = urllib.request.build_opener()
try:
    r = fremd.open(f"{PAPERLESS}/accounts/signup/", timeout=30)
    seite, ziel = r.read().decode(), r.geturl()
except urllib.error.HTTPError as e:
    seite, ziel = "", f"HTTP {e.code}"
assert 'name="password1"' not in seite, "Registrierungsformular von außen erreichbar!"
print(f"6 Paperless: keine Registrierung ({ziel.split('?')[0][-30:]})".ljust(41) + "ok")
