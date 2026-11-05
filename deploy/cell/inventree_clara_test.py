"""Clara's InvenTree tools in a cell, through the real tool gateway — as the brain calls them.

    docker compose exec -T claraos-api python3 - zelle-test < inventree_clara_test.py

Runs inside the API container (service token + `X-Claraos-User`, the trust path of an
external brain). The account must have signed in to InvenTree once (inventree_test.py) —
the first tool call then creates the user's own InvenTree token (zellen_zugaenge).
A test location and supplier are set up with the admin login first (a fresh cell has
neither); everything starts with "Nolani-Test", inventree_konto_weg.py removes it.
Prints no passwords or tokens.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from base64 import b64encode

USER = sys.argv[1] if len(sys.argv) > 1 else "zelle-test"
API = "http://localhost:8090/api/claraos/tools/call/inventree"
H = {"Content-Type": "application/json", "X-ClaraOS-Service-Token": os.environ["CLARAOS_SERVICE_TOKEN"],
     "X-Claraos-User": USER}
MARKE = f"Nolani-Test {int(time.time())}"
INV = os.environ.get("INVENTREE_INTERNAL_URL", "http://inventree-server:8000")
ADMIN = "Basic " + b64encode(f"admin:{os.environ['INVENTREE_ADMIN_PASSWORD']}".encode()).decode()


def werkzeug(name, args):
    r = urllib.request.Request(f"{API}/{name}", data=json.dumps(args).encode(), headers=H, method="POST")
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def als_admin(pfad, daten):
    r = urllib.request.Request(f"{INV}{pfad}", data=json.dumps(daten).encode(), method="POST",
                               headers={"Content-Type": "application/json", "Authorization": ADMIN})
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode())


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


LAGER = als_admin("/api/stock/location/", {"name": f"{MARKE} Lager"})["name"]
LIEFERANT = als_admin("/api/company/", {"name": f"{MARKE} Lieferant", "is_supplier": True})["name"]

s, d = werkzeug("search_parts", {"suche": ""})
pruefe(1, "Zugang beim ersten Aufruf angelegt, Suche läuft", s == 200, f"HTTP {s} {str(d)[:200]}")

TEIL = f"{MARKE} Sensor"
s, d = werkzeug("create_part", {"name": TEIL, "anfangsbestand": 5, "lagerort": LAGER, "mindestbestand": 20})
neu = antwort(d)
pruefe(2, "Teil mit Anfangsbestand angelegt (als der Nutzer)",
       s == 200 and neu.get("angelegt") and neu.get("bestand") == 5, f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("search_parts", {"suche": TEIL, "nur_knapp": True})
treffer = antwort(d).get("treffer", []) if s == 200 else []
pruefe(3, "unter Mindestbestand gefunden, mit Link",
       len(treffer) == 1 and treffer[0].get("unter_mindestbestand") and "/web/part/" in treffer[0].get("link", ""),
       f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("book_stock", {"teil": TEIL, "menge": 50, "notiz": "Wareneingang (Nolani-Test)"})
pruefe(4, "Wareneingang gebucht: Bestand 55", s == 200 and float(antwort(d).get("bestand_jetzt") or 0) == 55,
       f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("book_stock", {"teil": TEIL, "menge": -100})
pruefe(5, "Abbuchung über den Bestand abgelehnt", s == 200 and antwort(d).get("gebucht") is False,
       f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("create_purchase_order", {"lieferant": LIEFERANT, "teil": TEIL, "menge": 30, "preis": 2.5})
po = antwort(d)
pruefe(6, "Bestellung als Entwurf beim Lieferanten",
       s == 200 and po.get("angelegt") and "/web/purchasing/purchase-order/" in po.get("link", ""),
       f"HTTP {s} {str(d)[:200]}")

s, d = werkzeug("create_purchase_order", {"lieferant": f"{MARKE} Unbekannt", "teil": TEIL, "menge": 1})
pruefe(7, "unbekannter Lieferant: Hinweis statt Bestellung",
       s == 200 and antwort(d).get("angelegt") is False and "nicht gefunden" in antwort(d).get("hinweis", ""),
       f"HTTP {s} {str(d)[:200]}")

print("\nINVENTREE-CLARA-TEST " + ("GRÜN" if ok else "ROT"))
sys.exit(0 if ok else 1)
