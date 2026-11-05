"""InvenTree tools for Clara in a cell: find parts, create a part with stock, book stock,
create a purchase order at a supplier.

Identity: the tool gateway (`routers/clara_tools.py`, `per_user: true`) sends the
CALLER's own InvenTree API token as `x-inventree-token` (created by the cell in
services/zellen_zugaenge._inventree). Every call runs as that InvenTree user — the
roles of their group apply exactly as in InvenTree's own UI; there is no shared account.

Only these operations are reachable (not a generic REST bridge); answers are compact
and carry a `link` to the record in InvenTree.
"""
from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import require_caller

INVENTREE_URL = os.environ.get("INVENTREE_INTERNAL_URL", "http://inventree-server:8000").rstrip("/")
BASE_DOMAIN = os.environ.get("CLARAOS_BASE_DOMAIN", "")

router = APIRouter(prefix="/api/claraos/inventree", tags=["inventree"])


def _token(request: Request) -> str:
    require_caller(request)
    token = request.headers.get("x-inventree-token", "")
    if not token:
        raise HTTPException(409, "Kein InvenTree-Zugang für diesen Nutzer.")
    return token


async def _rufe(request: Request, methode: str, pfad: str, **kw):
    headers = {"Authorization": f"Token {_token(request)}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30) as c:  # cell-internal, plain HTTP
        r = await c.request(methode, f"{INVENTREE_URL}{pfad}", headers=headers, **kw)
    if r.status_code == 401:
        raise HTTPException(401, "InvenTree lehnt den Zugang ab.")  # gateway renews once
    if r.status_code == 403:
        raise HTTPException(403, "In InvenTree fehlt dir dafür die Berechtigung.")
    if r.status_code >= 400:
        raise HTTPException(502, f"InvenTree: {r.status_code} {r.text[:300]}")
    return r.json() if r.content else {}


def _link(art: str, pk: int) -> dict:
    pfade = {"part": f"/web/part/{pk}/details", "stock": f"/web/stock/item/{pk}/details",
             "po": f"/web/purchasing/purchase-order/{pk}/detail"}
    return {"link": f"https://inventree.{BASE_DOMAIN}{pfade[art]}"} if BASE_DOMAIN else {}


def _liste(antwort) -> list:
    """InvenTree lists come paginated ({results: [...]}) or plain."""
    return antwort.get("results", []) if isinstance(antwort, dict) else antwort


async def _eins(request: Request, pfad: str, name: str, was: str, feld: str = "name",
                **filter_) -> tuple[dict | None, dict | None]:
    """The one record of that name — an exact match wins over partial ones."""
    treffer = _liste(await _rufe(request, "GET", pfad, params={"search": name, "limit": 10, **filter_}))
    genau = [t for t in treffer if str(t.get(feld, "")).strip().lower() == name.strip().lower()]
    if len(genau) == 1:
        return genau[0], None
    if len(treffer) == 1:
        return treffer[0], None
    return None, {"hinweis": f"{was} „{name}“ " + ("nicht gefunden." if not treffer else "ist nicht eindeutig."),
                  "kandidaten": [t.get(feld) for t in treffer]}


def _teil_zeile(t: dict) -> dict:
    out = {"id": t["pk"], "name": t.get("full_name") or t.get("name"),
           "bestand": t.get("in_stock"), "mindestbestand": t.get("minimum_stock"),
           "kategorie": (t.get("category_detail") or {}).get("name") or t.get("category_name")}
    if t.get("IPN"):
        out["ipn"] = t["IPN"]
    if t.get("minimum_stock") and (t.get("in_stock") or 0) < t["minimum_stock"]:
        out["unter_mindestbestand"] = True
    return {k: v for k, v in out.items() if v not in (None, "")} | _link("part", t["pk"])


class TeileSuche(BaseModel):
    suche: str = Field(default="", max_length=200)
    nur_knapp: bool = Field(default=False, description="only parts below their minimum stock")
    anzahl: int = Field(default=10, ge=1, le=50)


@router.post("/teile/suche")
async def teile_suchen(body: TeileSuche, request: Request) -> dict:
    """Parts by name/IPN/description, with stock; optionally only those running low."""
    params: dict = {"search": body.suche, "limit": body.anzahl, "category_detail": "true"}
    if body.nur_knapp:
        params["low_stock"] = "true"
    teile = _liste(await _rufe(request, "GET", "/api/part/", params=params))
    return {"anzahl": len(teile), "treffer": [_teil_zeile(t) for t in teile]}


class NeuesTeil(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    beschreibung: str | None = Field(default=None, max_length=250)
    kategorie: str | None = Field(default=None, max_length=100, description="existing category")
    anfangsbestand: float | None = Field(default=None, ge=0, le=1e9)
    lagerort: str | None = Field(default=None, max_length=100, description="existing location")
    mindestbestand: float | None = Field(default=None, ge=0, le=1e9)


@router.post("/teile")
async def teil_anlegen(body: NeuesTeil, request: Request) -> dict:
    """A new purchasable part, optionally with initial stock at a location."""
    werte: dict = {"name": body.name, "description": body.beschreibung or "", "purchaseable": True,
                   "component": True, "active": True}
    if body.kategorie:
        kat, hinweis = await _eins(request, "/api/part/category/", body.kategorie, "Kategorie")
        if hinweis:
            return {"angelegt": False, **hinweis}
        werte["category"] = kat["pk"]
    if body.mindestbestand is not None:
        werte["minimum_stock"] = body.mindestbestand
    ort = None
    if body.anfangsbestand:
        if not body.lagerort:
            return {"angelegt": False, "hinweis": "Für einen Anfangsbestand fehlt der Lagerort."}
        ort, hinweis = await _eins(request, "/api/stock/location/", body.lagerort, "Lagerort")
        if hinweis:
            return {"angelegt": False, **hinweis}
    teil = await _rufe(request, "POST", "/api/part/", json=werte)
    antwort = {"angelegt": True, "id": teil["pk"], "name": teil.get("name"), **_link("part", teil["pk"])}
    if ort:
        posten = await _rufe(request, "POST", "/api/stock/",
                             json={"part": teil["pk"], "quantity": body.anfangsbestand, "location": ort["pk"]})
        posten = posten[0] if isinstance(posten, list) else posten
        antwort["bestand"] = body.anfangsbestand
        antwort["lagerort"] = ort.get("name")
    return antwort


class Buchung(BaseModel):
    teil: str = Field(min_length=1, max_length=100)
    menge: float = Field(description="positive = into stock, negative = out of stock", ge=-1e9, le=1e9)
    notiz: str | None = Field(default=None, max_length=250)


@router.post("/bestand")
async def bestand_buchen(body: Buchung, request: Request) -> dict:
    """Book stock in or out on the part's largest stock item (no new locations)."""
    if body.menge == 0:
        return {"gebucht": False, "hinweis": "Menge 0 — nichts zu buchen."}
    teil, hinweis = await _eins(request, "/api/part/", body.teil, "Teil")
    if hinweis:
        return {"gebucht": False, **hinweis}
    posten = _liste(await _rufe(request, "GET", "/api/stock/",
                                params={"part": teil["pk"], "in_stock": "true", "limit": 50}))
    if not posten:
        return {"gebucht": False, "hinweis": f"„{teil['name']}“ hat noch keinen Lagerbestand — "
                                             "lege ihn beim Anlegen des Teils mit an."}
    groesster = max(posten, key=lambda p: float(p.get("quantity") or 0))
    if body.menge < 0 and float(groesster.get("quantity") or 0) < -body.menge:
        return {"gebucht": False, "hinweis": f"Nur {groesster.get('quantity')} auf Lager."}
    pfad = "/api/stock/add/" if body.menge > 0 else "/api/stock/remove/"
    await _rufe(request, "POST", pfad, json={"items": [{"pk": groesster["pk"], "quantity": abs(body.menge)}],
                                             "notes": body.notiz or ""})
    neu = await _rufe(request, "GET", f"/api/part/{teil['pk']}/")
    return {"gebucht": True, "teil": teil["name"], "menge": body.menge, "bestand_jetzt": neu.get("in_stock"),
            **_link("part", teil["pk"])}


class Bestellung(BaseModel):
    lieferant: str = Field(min_length=1, max_length=100, description="existing supplier company")
    teil: str = Field(min_length=1, max_length=100)
    menge: float = Field(gt=0, le=1e9)
    preis: float | None = Field(default=None, ge=0, le=1e9, description="unit price")
    notiz: str | None = Field(default=None, max_length=250)


@router.post("/bestellung")
async def bestellung_anlegen(body: Bestellung, request: Request) -> dict:
    """A purchase order (draft, not sent) at a supplier with one line for the part."""
    firma, hinweis = await _eins(request, "/api/company/", body.lieferant, "Lieferant", is_supplier="true")
    if hinweis:
        return {"angelegt": False, **hinweis}
    teil, hinweis = await _eins(request, "/api/part/", body.teil, "Teil")
    if hinweis:
        return {"angelegt": False, **hinweis}
    # Order lines point to a supplier part (part at this supplier) — create it once.
    sp = _liste(await _rufe(request, "GET", "/api/company/part/",
                            params={"supplier": firma["pk"], "part": teil["pk"], "limit": 1}))
    if sp:
        sp_pk = sp[0]["pk"]
    else:
        sku = (teil.get("IPN") or teil["name"])[:100]
        sp_pk = (await _rufe(request, "POST", "/api/company/part/",
                             json={"supplier": firma["pk"], "part": teil["pk"], "SKU": sku}))["pk"]
    po = await _rufe(request, "POST", "/api/order/po/",
                     json={"supplier": firma["pk"], "description": (body.notiz or f"{body.teil}")[:250]})
    zeile: dict = {"order": po["pk"], "part": sp_pk, "quantity": body.menge}
    if body.preis is not None:
        zeile["purchase_price"] = body.preis
    await _rufe(request, "POST", "/api/order/po-line/", json=zeile)
    return {"angelegt": True, "id": po["pk"], "nummer": po.get("reference"), "lieferant": firma["name"],
            "teil": teil["name"], "menge": body.menge, "status": "Entwurf (nicht versendet)",
            **_link("po", po["pk"])}
