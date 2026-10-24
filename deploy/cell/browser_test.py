#!/usr/bin/env python3
"""Personal browser test for a cell (layer 6) — from the user's side and from inside.

    ZELLE_TEST_PW=… python3 browser_test.py <domain> <user>

1 Opening the tile creates and starts the user's own browser (desktop twin only)
2 browser.<domain> delivers the stream page behind the login; the relay path answers
3 Without a session — even with a forged identity header — nothing is delivered
4 From INSIDE the browser: internet yes; metadata service, the server itself, the
  cell's services and private networks no
Runs on the cell (needs `docker exec`). Never prints passwords.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

from zelle_client import Zelle

DOM, USER = sys.argv[1], sys.argv[2]
BROWSER = f"https://browser.{DOM}"
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])
print("0 Anmeldung                               ok")

# ── 1 lazy creation ─────────────────────────────────────────────────────
t0 = time.time()
st = z.get_json("/api/claraos/apps/selkies/status", form="desktop")
dauer = time.time() - t0
assert st.get("available") is True, f"Browser nicht verfügbar: {st.get('hint') or st}"
assert st.get("url") == BROWSER, f"falsche Adresse: {st.get('url')}"
mob = subprocess.run(["docker", "inspect", "-f", "{{.State.Status}}", f"ubm-{USER}"],
                     capture_output=True, text=True).stdout.strip()
assert mob in ("", "exited", "created"), f"Handy-Browser lief mit, obwohl nur Desktop verlangt: {mob}"
print(f"1 Eigener Browser gestartet ({dauer:.0f} s, nur Desktop)".ljust(41) + "ok")

# ── 2 stream page behind the login ──────────────────────────────────────
ziel = z.oidc_rueckweg(BROWSER + "/")
r = z.get(ziel)
seite = r.read().decode(errors="ignore")
assert r.geturl().startswith(BROWSER), f"nicht beim Browser gelandet: {r.geturl().split('?')[0]}"
assert "claraos-bridge.js" in seite, "keine Stream-Seite mit claraos-bridge ausgeliefert"
# The relay starts only once Chromium has opened its CDP port — on a fresh profile
# that takes a while after the stream page is already up.
for _ in range(45):
    try:
        rs = z.get(BROWSER + "/claraos-cdp").status
    except urllib.error.HTTPError as e:
        rs = e.code
    if rs not in (502, 503, 504):
        break
    time.sleep(2)
if rs in (502, 503, 504):
    log = subprocess.run(["docker", "logs", "--tail", "15", f"ubd-{USER}"], capture_output=True, text=True)
    print((log.stdout + log.stderr)[-1500:])
assert rs not in (502, 503, 504), f"Relay nach 90 s nicht erreichbar: HTTP {rs}"
print(f"2 Stream-Seite + Relay (HTTP {rs})".ljust(41) + "ok")

# ── 3 nothing without a session, forged header is ignored ───────────────
fremd = urllib.request.build_opener()
req = urllib.request.Request(BROWSER + "/", headers={"X-Authentik-Username": USER})
try:
    r = fremd.open(req, timeout=30)
    gelandet, inhalt = r.geturl(), r.read().decode(errors="ignore")
except urllib.error.HTTPError as e:
    gelandet, inhalt = f"HTTP {e.code}", ""
assert "claraos-bridge.js" not in inhalt, "Stream-Seite OHNE Anmeldung ausgeliefert!"
print(f"3 Ohne Anmeldung kein Zugang (→ {gelandet.split('?')[0][-28:]})".ljust(41) + "ok")


# ── 4 egress fence, measured from inside the browser container ─────────
def von_innen(url: str) -> bool:
    """True = connection made (any HTTP answer), False = blocked/timeout."""
    p = subprocess.run(["docker", "exec", f"ubd-{USER}", "curl", "-s", "-o", "/dev/null",
                        "-m", "6", "-w", "%{http_code}", url], capture_output=True, text=True)
    return p.stdout.strip() not in ("", "000")


def ip_von(container: str) -> str:
    nets = json.loads(subprocess.run(["docker", "inspect", "-f", "{{json .NetworkSettings.Networks}}",
                                      container], capture_output=True, text=True).stdout or "{}")
    return next(iter(v["IPAddress"] for k, v in nets.items() if k.endswith("_zelle")), "")


gateway = subprocess.run(["docker", "network", "inspect", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
                          f"ubnet-{USER}"], capture_output=True, text=True).stdout.strip()
auth_ip = ip_von("claraos-authentik-1")
proben = [
    ("Internet (example.com)", "https://example.com/", True),
    ("eigene Zelle (home.<domain>)", f"https://home.{DOM}/", True),
    ("Cloud-Metadaten 169.254.169.254", "http://169.254.169.254/hetzner/v1/metadata", False),
    (f"Server über Gateway {gateway}:22", f"http://{gateway}:22/", False),
    (f"Authentik im Zellennetz {auth_ip}", f"http://{auth_ip}:9000/", False),
    ("Zellendienst per Name (authentik)", "http://authentik:9000/", False),
]
fehler = []
for name, url, soll in proben:
    ist = von_innen(url)
    if ist != soll:
        fehler.append(f"{name}: {'erreichbar' if ist else 'gesperrt'}, soll {'erreichbar' if soll else 'gesperrt'}")
assert not fehler, "Zaun falsch:\n  " + "\n  ".join(fehler)
print(f"4 Zaun: Internet ja, {sum(not s for *_, s in proben)} interne Ziele gesperrt".ljust(41) + "ok")


# ── 5 downloads: narrow key into the user's OWN Files, nobody else's ───
def upload_von_innen(schluessel_ausdruck: str) -> str:
    """Upload a small file from inside the browser container; returns the HTTP code."""
    sh = ('echo zelle-browser-ablage > /tmp/ablage-test.txt && curl -s -o /dev/null -w "%{http_code}" '
          '-F file=@/tmp/ablage-test.txt -H "X-Browser-Upload-Key: ' + schluessel_ausdruck + '" '
          '"$CLARAOS_API_URL/api/claraos/browser-ablage/upload"')
    return subprocess.run(["docker", "exec", f"ubd-{USER}", "sh", "-c", sh],
                          capture_output=True, text=True).stdout.strip()


code = upload_von_innen("$CLARAOS_UPLOAD_KEY")
assert code == "200", f"Ablage aus dem Browser: HTTP {code}"
baum = json.dumps(z.get_json("/api/claraos/files/v2/tree", source="nextcloud",
                             path="/Downloads/Clara Browser", depth=1))
assert "ablage-test.txt" in baum, "Datei nicht in den eigenen Dateien angekommen"
z.send_json("DELETE", "/api/claraos/files/v2/delete", {}, source="nextcloud",
            path="/Downloads/Clara Browser/ablage-test.txt")
# same signature, another user's name — must be refused
code = upload_von_innen('clara.bot.${CLARAOS_UPLOAD_KEY##*.}')
assert code == "401", f"fremder Name mit eigenem Schlüssel: HTTP {code}"
print("5 Download → eigene Dateien, fremd = 401  ok")
