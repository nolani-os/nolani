"""Odoo tools for Clara in a cell: find contacts and business records, create a contact.

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
    zugehoerig_zu: str | None = Field(default=None, max_length=200,
                                      description="company the person belongs to (existing contact)")
    strasse: str | None = Field(default=None, max_length=200)
    plz: str | None = Field(default=None, max_length=20)
    ort: str | None = Field(default=None, max_length=100)
    notiz: str | None = Field(default=None, max_length=2000)


@router.post("/kontakte")
async def kontakt_anlegen(body: NeuerKontakt, request: Request) -> dict:
    """Create a contact (person or company) as the user."""
    werte: dict = {"name": body.name, "is_company": body.firma}
    for feld, wert in (("email", body.email), ("phone", body.telefon), ("street", body.strasse),
                       ("zip", body.plz), ("city", body.ort), ("comment", body.notiz)):
        if wert:
            werte[feld] = wert
    if body.zugehoerig_zu:
        firmen = await _rufe(request, "res.partner", "search_read",
                             [["is_company", "=", True], ["name", "ilike", body.zugehoerig_zu]],
                             fields=["id", "display_name"], limit=2)
        if len(firmen) != 1:
            return {"angelegt": False,
                    "hinweis": f"Firma „{body.zugehoerig_zu}“ "
                               + ("nicht gefunden." if not firmen else "ist nicht eindeutig."),
                    "kandidaten": [f["display_name"] for f in firmen]}
        werte["parent_id"] = firmen[0]["id"]
    rid = await _rufe(request, "res.partner", "create", werte)
    return {"angelegt": True, "id": rid, "name": body.name, **_link("res.partner", rid)}
