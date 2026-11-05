"""Clara's Mautic tools in a cell, through the real tool gateway — as the brain calls them.

    docker compose exec -T claraos-api python3 - zelle-test < mautic_clara_test.py

Runs inside the API container (service token + `X-Claraos-User`, the trust path of an
external brain). The account must have signed in to Mautic once (mautic_test.py) — the
first tool call then creates the user's own Mautic access (zellen_zugaenge). Nothing is
sent: emails stay drafts, the campaign stays unpublished. Everything starts with
"Nolani-Test"; mautic_konto_weg.php removes it. Prints no passwords.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

USER = sys.argv[1] if len(sys.argv) > 1 else "zelle-test"
API = "http://localhost:8090/api/claraos/tools/call/mautic"
H = {"Content-Type": "application/json", "X-ClaraOS-Service-Token": os.environ["CLARAOS_SERVICE_TOKEN"],
     "X-Claraos-User": USER}
T = int(time.time())
MARKE = f"Nolani-Test {T}"
MAIL = f"nolani-test-{T}@invalid.example"


def werkzeug(name, args):
    r = urllib.request.Request(f"{API}/{name}", data=json.dumps(args).encode(), headers=H, method="POST")
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def antwort(d):
    """The gateway wraps the route's answer; accept both shapes."""
    if isinstance(d, dict) and isinstance(d.get("result"), dict):
        return d["result"]
    return d


ok = True


def pruefe(nr, text, bedingung, info=""):
    global ok
    print(f"{nr} {text}".ljust(56) + ("ok" if bedingung else f"FEHLER {info}"))
    ok = ok and bool(bedingung)


s, d = werkzeug("search_mautic_contacts", {"suche": ""})
pruefe(1, "Zugang beim ersten Aufruf angelegt, Suche läuft", s == 200, f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("create_mautic_contact", {"email": MAIL, "vorname": "Anna", "nachname": MARKE,
                                          "firma": f"{MARKE} GmbH"})
pruefe(2, "Kontakt angelegt (als der Nutzer)", s == 200 and antwort(d).get("angelegt"), f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("create_mautic_contact", {"email": MAIL})
pruefe(3, "zweites Mal: vorhandener Kontakt, kein Duplikat",
       s == 200 and antwort(d).get("vorhanden") is True, f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("create_segment", {"name": MARKE, "kontakte": [MAIL, f"fehlt-{T}@invalid.example"]})
seg = antwort(d)
pruefe(4, "Segment mit dem Kontakt, fehlende Adresse genannt",
       s == 200 and seg.get("mitglieder") == 1 and len(seg.get("nicht_gefunden", [])) == 1,
       f"HTTP {s} {str(d)[:200]}")

for nr, name in ((5, "Willkommen"), (6, "Nachfassen")):
    s, d = werkzeug("draft_segment_email", {"name": f"{MARKE} {name}", "betreff": f"{name} (Test)",
                                            "text": "Hallo,\n\ndas ist ein Test.", "segment": MARKE})
    pruefe(nr, f"E-Mail „{name}“ als Entwurf", s == 200 and antwort(d).get("angelegt")
           and "Entwurf" in antwort(d).get("status", ""), f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("create_campaign", {"name": MARKE, "segment": MARKE, "tage_dazwischen": 3,
                                    "emails": [f"{MARKE} Willkommen", f"{MARKE} Nachfassen"]})
k = antwort(d)
pruefe(7, "Kampagne mit zwei Schritten, unveröffentlicht",
       s == 200 and k.get("angelegt") and k.get("schritte") == 2 and "nicht veröffentlicht" in k.get("status", ""),
       f"HTTP {s} {str(d)[:200]}")

print("\nMAUTIC-CLARA-TEST " + ("GRÜN" if ok else "ROT"))
sys.exit(0 if ok else 1)
