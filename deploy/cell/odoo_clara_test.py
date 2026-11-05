"""Clara's Odoo tools in a cell, through the real tool gateway — as the brain calls them.

    docker compose exec -T claraos-api python3 - zelle-test < odoo_clara_test.py

Runs inside the API container (service token + `X-Claraos-User`, the trust path of
an external brain). The account must have signed in to Odoo once (odoo_test.py) —
the first tool call then creates the user's own Odoo access (zellen_zugaenge).
The contact created here starts with "Nolani-Test", odoo_konto_weg.py removes it.
Prints no passwords or tokens.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

USER = sys.argv[1] if len(sys.argv) > 1 else "zelle-test"
API = "http://localhost:8090/api/claraos/tools/call/odoo"
H = {"Content-Type": "application/json", "X-ClaraOS-Service-Token": os.environ["CLARAOS_SERVICE_TOKEN"],
     "X-Claraos-User": USER}
MARKE = f"Nolani-Test {int(time.time())}"


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
    print(f"{nr} {text}".ljust(52) + ("ok" if bedingung else f"FEHLER {info}"))
    ok = ok and bool(bedingung)


s, d = werkzeug("search_contacts", {"suche": ""})
pruefe(1, "Zugang beim ersten Aufruf angelegt, Suche läuft", s == 200, f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("create_contact", {"name": MARKE, "email": "nolani-test@invalid.example", "ort": "Köln"})
neu = antwort(d)
pruefe(2, "Kontakt angelegt (als der Nutzer)", s == 200 and neu.get("angelegt") and neu.get("id"),
       f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("search_contacts", {"suche": MARKE})
treffer = antwort(d).get("treffer", []) if s == 200 else []
pruefe(3, "neuer Kontakt gefunden, mit Link", len(treffer) == 1 and "/odoo/res.partner/" in treffer[0].get("link", ""),
       f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("search_records", {"bereich": "rechnungen"})
pruefe(4, "Bereich ohne installierte App: Hinweis statt Fehler",
       s == 200 and "nicht installiert" in antwort(d).get("hinweis", ""), f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("search_records", {"bereich": "res.users"})
pruefe(5, "fremdes Modell abgelehnt (422)", s == 422, f"HTTP {s}")

# A customer with a contact person, a note and an opportunity — the demo story
FIRMA = f"{MARKE} GmbH"
s, d = werkzeug("create_contact", {"name": FIRMA, "firma": True, "ort": "Köln"})
pruefe(6, "Firma angelegt", s == 200 and antwort(d).get("angelegt"), f"HTTP {s} {str(d)[:200]}")
s, d = werkzeug("create_contact", {"name": f"{MARKE} Anna", "funktion": "CEO", "zugehoerig_zu": FIRMA})
pruefe(7, "Ansprechpartnerin mit Funktion an der Firma", s == 200 and antwort(d).get("angelegt"),
       f"HTTP {s} {str(d)[:200]}")
s, d = werkzeug("add_note", {"kontakt": FIRMA, "text": "Auf der Messe getroffen (Nolani-Test)."})
pruefe(8, "interne Notiz im Verlauf der Firma", s == 200 and antwort(d).get("angelegt"),
       f"HTTP {s} {str(d)[:200]}")
s, d = werkzeug("create_opportunity", {"titel": f"{MARKE} 50 Sensoren", "kontakt": FIRMA,
                                       "erwarteter_umsatz": 12000})
chance = antwort(d)
pruefe(9, "Verkaufschance in der Pipeline (CRM, als der Nutzer)",
       s == 200 and chance.get("angelegt") and "/odoo/crm.lead/" in chance.get("link", ""),
       f"HTTP {s} {str(d)[:200]}")
s, d = werkzeug("search_records", {"bereich": "leads", "suche": MARKE})
pruefe(10, "Verkaufschance wiederfindbar", s == 200 and antwort(d).get("anzahl") == 1,
       f"HTTP {s} {str(d)[:200]}")

print("\nODOO-CLARA-TEST " + ("GRÜN" if ok else "ROT"))
sys.exit(0 if ok else 1)
