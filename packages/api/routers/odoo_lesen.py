"""Odoo tools for Clara in a cell: find contacts and business records, create a contact,
add a note to a contact's history, create an opportunity in the CRM pipeline.

Identity: the tool gateway (`routers/clara_tools.py`, `per_user: true`) sends the
CALLER's own Odoo access as `x-odoo-zugang` (`uid:password`, created by the cell in
services/zellen_zugaenge.py). Every call runs as that Odoo user — record rules and
access rights apply exactly as in Odoo's own UI; there is no shared account.

Only named models and fields are reachable (not a generic RPC bridge), and results
are compact lines with a link instead of Odoo's full records.
"""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import require_caller
from services.zellen_zugaenge import ODOO_DB, OdooFehler, odoo_rpc

BASE_DOMAIN = os.environ.get("CLARAOS_BASE_DOMAIN", "")

router = APIRouter(prefix="/api/claraos/odoo", tags=["odoo"])

# area → (model, fields, field searched by name). Areas only answer when the Odoo app
# that brings the model is installed (CRM, Sales, Invoicing, Project, Inventory).
BEREICHE: dict[str, tuple[str, list[str], str]] = {
    "kontakte":   ("res.partner", ["display_name", "email", "phone", "is_company", "city"], "display_name"),
    "leads":      ("crm.lead", ["display_name", "contact_name", "email_from", "stage_id",
                                "expected_revenue"], "display_name"),
    "angebote":   ("sale.order", ["display_name", "partner_id", "amount_total", "state",
                                  "date_order"], "display_name"),
    "rechnungen": ("account.move", ["display_name", "partner_id", "amount_total", "state",
                                    "payment_state", "invoice_date"], "display_name"),
    "aufgaben":   ("project.task", ["display_name", "project_id", "stage_id",
                                    "date_deadline"], "display_name"),
    "produkte":   ("product.template", ["display_name", "list_price", "default_code"], "display_name"),
}
_APP = {"leads": "CRM", "angebote": "Verkauf", "rechnungen": "Rechnungen",
        "aufgaben": "Projekt", "produkte": "Verkauf oder Lager"}


def _zugang(request: Request) -> tuple[int, str]:
    require_caller(request)
    roh = request.headers.get("x-odoo-zugang", "")
    uid, _, pw = roh.partition(":")
    if not (uid.isdigit() and pw):
        raise HTTPException(409, "Kein Odoo-Zugang für diesen Nutzer.")
    return int(uid), pw


async def _rufe(request: Request, model: str, method: str, *args, **kw):
    uid, pw = _zugang(request)
    try:
        return await odoo_rpc("object", "execute_kw", ODOO_DB, uid, pw, model, method, list(args), kw)
    except PermissionError:
        # 401 lets the gateway renew a stale access once
        raise HTTPException(401, "Odoo lehnt den Zugang ab.")
    except OdooFehler as e:
        # By exception class — the message is in the user's language. A model of an
        # app that is not installed: UserError "Object <model> doesn't exist" (untranslated).
        if "AccessError" in e.name:
            raise HTTPException(403, f"In Odoo fehlt dir dafür die Berechtigung: {e.message}"[:300])
        if "doesn't exist" in e.message:
            raise HTTPException(404, str(e))
        raise HTTPException(502, str(e))


def _link(model: str, rid: int) -> dict:
    return {"link": f"https://odoo.{BASE_DOMAIN}/odoo/{model}/{rid}"} if BASE_DOMAIN else {}


def _zeile(model: str, r: dict) -> dict:
    out = {"id": r["id"]}
    for k, v in r.items():
        if k == "id" or v in (False, None, ""):
            continue
        # many2one fields come as [id, "name"] — the name is what the user needs
        out[k] = v[1] if isinstance(v, list) and len(v) == 2 else v
    return {**out, **_link(model, r["id"])}


class Suche(BaseModel):
    bereich: str = Field(default="kontakte", pattern="^(" + "|".join(BEREICHE) + ")$")
    suche: str = Field(default="", max_length=200)
    anzahl: int = Field(default=10, ge=1, le=50)


@router.post("/suche")
async def suche(body: Suche, request: Request) -> dict:
    """Records of one area, matched by name (empty search: newest first)."""
    model, felder, feld = BEREICHE[body.bereich]
    domain = [[feld, "ilike", body.suche]] if body.suche else []
    if body.bereich == "kontakte" and body.suche:
        # contacts: also by email and company name
        domain = ["|", "|", ["display_name", "ilike", body.suche], ["email", "ilike", body.suche],
                  ["parent_id.name", "ilike", body.suche]]
    try:
        reihen = await _rufe(request, model, "search_read", domain,
                             fields=felder, limit=body.anzahl, order="id desc")
    except HTTPException as e:
        # Not via ir.model: normal users may not read it. The search itself tells.
        if e.status_code == 404 and body.bereich in _APP:
            return {"anzahl": 0, "treffer": [],
                    "hinweis": f"In Odoo ist die App „{_APP[body.bereich]}“ nicht installiert."}
        raise
    return {"anzahl": len(reihen), "treffer": [_zeile(model, r) for r in reihen]}


class KontaktSuche(BaseModel):
    suche: str = Field(default="", max_length=200)
    anzahl: int = Field(default=10, ge=1, le=50)


@router.post("/kontakte/suche")
async def kontakte_suchen(body: KontaktSuche, request: Request) -> dict:
    """Contacts by name, email or company."""
    return await suche(Suche(bereich="kontakte", suche=body.suche, anzahl=body.anzahl), request)


class NeuerKontakt(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: str | None = Field(default=None, max_length=200)
    telefon: str | None = Field(default=None, max_length=60)
    firma: bool = False
    funktion: str | None = Field(default=None, max_length=120, description="job title of a person")
    zugehoerig_zu: str | None = Field(default=None, max_length=200,
                                      description="company the person belongs to (existing contact)")
    strasse: str | None = Field(default=None, max_length=200)
    plz: str | None = Field(default=None, max_length=20)
    ort: str | None = Field(default=None, max_length=100)
    notiz: str | None = Field(default=None, max_length=2000)


async def _eindeutig(request: Request, name: str, nur_firmen: bool = False) -> tuple[dict | None, dict | None]:
    """The one contact (or company) of that name — exact match wins over partial ones."""
    domain = [["name", "ilike", name]] + ([["is_company", "=", True]] if nur_firmen else [])
    treffer = await _rufe(request, "res.partner", "search_read", domain,
                          fields=["id", "display_name", "name"], limit=10)
    genau = [t for t in treffer if t["name"].strip().lower() == name.strip().lower()]
    if len(genau) == 1:
        return genau[0], None
    if len(treffer) == 1:
        return treffer[0], None
    was = "Firma" if nur_firmen else "Kontakt"
    return None, {"hinweis": f"{was} „{name}“ " + ("nicht gefunden." if not treffer else "ist nicht eindeutig."),
                  "kandidaten": [t["display_name"] for t in treffer]}


@router.post("/kontakte")
async def kontakt_anlegen(body: NeuerKontakt, request: Request) -> dict:
    """Create a contact (person or company) as the user."""
    werte: dict = {"name": body.name, "is_company": body.firma}
    for feld, wert in (("email", body.email), ("phone", body.telefon), ("function", body.funktion),
                       ("street", body.strasse),
                       ("zip", body.plz), ("city", body.ort), ("comment", body.notiz)):
        if wert:
            werte[feld] = wert
    if body.zugehoerig_zu:
        firma, hinweis = await _eindeutig(request, body.zugehoerig_zu, nur_firmen=True)
        if hinweis:
            return {"angelegt": False, **hinweis}
        werte["parent_id"] = firma["id"]
    rid = await _rufe(request, "res.partner", "create", werte)
    return {"angelegt": True, "id": rid, "name": body.name, **_link("res.partner", rid)}


class Notiz(BaseModel):
    kontakt: str = Field(min_length=1, max_length=200, description="name of the contact or company")
    text: str = Field(min_length=1, max_length=4000)


@router.post("/notiz")
async def notiz_anlegen(body: Notiz, request: Request) -> dict:
    """An internal note in the contact's history (chatter) — not sent to anyone."""
    kontakt, hinweis = await _eindeutig(request, body.kontakt)
    if hinweis:
        return {"angelegt": False, **hinweis}
    # message_post with the note subtype: internal, no follower gets an email.
    mid = await _rufe(request, "res.partner", "message_post", [kontakt["id"]],
                      body=body.text, message_type="comment", subtype_xmlid="mail.mt_note")
    return {"angelegt": True, "nachricht": mid, "kontakt": kontakt["display_name"],
            **_link("res.partner", kontakt["id"])}


class Verkaufschance(BaseModel):
    titel: str = Field(min_length=1, max_length=200)
    kontakt: str = Field(min_length=1, max_length=200, description="customer (contact or company)")
    erwarteter_umsatz: float | None = Field(default=None, ge=0, le=1e10)
    wahrscheinlichkeit: float | None = Field(default=None, ge=0, le=100)
    abschluss_bis: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    notiz: str | None = Field(default=None, max_length=2000)


@router.post("/verkaufschance")
async def verkaufschance_anlegen(body: Verkaufschance, request: Request) -> dict:
    """An opportunity in the user's CRM pipeline, assigned to the user."""
    kontakt, hinweis = await _eindeutig(request, body.kontakt)
    if hinweis:
        return {"angelegt": False, **hinweis}
    uid, _ = _zugang(request)
    werte: dict = {"name": body.titel, "type": "opportunity", "partner_id": kontakt["id"], "user_id": uid}
    if body.erwarteter_umsatz is not None:
        werte["expected_revenue"] = body.erwarteter_umsatz
    if body.wahrscheinlichkeit is not None:
        werte["probability"] = body.wahrscheinlichkeit
    if body.abschluss_bis:
        werte["date_deadline"] = body.abschluss_bis
    if body.notiz:
        werte["description"] = body.notiz
    try:
        rid = await _rufe(request, "crm.lead", "create", werte)
    except HTTPException as e:
        if e.status_code == 404:
            return {"angelegt": False, "hinweis": "In Odoo ist die App „CRM“ nicht installiert."}
        raise
    return {"angelegt": True, "id": rid, "titel": body.titel, "kunde": kontakt["display_name"],
            **_link("crm.lead", rid)}
