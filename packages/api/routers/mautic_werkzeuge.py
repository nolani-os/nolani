"""Mautic tools for Clara in a cell: find and create contacts, build a segment, draft a
segment email, build a simple campaign.

Identity: the tool gateway (`routers/clara_tools.py`, `per_user: true`) sends the
CALLER's own Mautic access as `x-mautic-zugang` (`username:password`, created by the cell
in services/zellen_zugaenge._mautic). Every call runs as that Mautic user — the role
"Nutzer" applies exactly as in Mautic's UI; there is no shared account.

Nothing here sends mail: emails are drafts, campaigns are created unpublished. Publishing
and sending stay a click in Mautic — the user's decision, not the assistant's.
"""
from __future__ import annotations

import html
import os

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import require_caller

MAUTIC_URL = os.environ.get("MAUTIC_INTERNAL_URL", "http://mautic").rstrip("/")
BASE_DOMAIN = os.environ.get("CLARAOS_BASE_DOMAIN", "")

router = APIRouter(prefix="/api/claraos/mautic", tags=["mautic"])


def proxy_kopf() -> dict:
    """Mautic sits behind the cell's Caddy (TLS ends there) and redirects plain-HTTP
    requests to https — inside the cell there is no TLS, so say what Caddy would say."""
    kopf = {"X-Forwarded-Proto": "https", "Accept": "application/json"}
    if BASE_DOMAIN:
        kopf["Host"] = f"mautic.{BASE_DOMAIN}"
    return kopf


def _auth(request: Request) -> httpx.BasicAuth:
    require_caller(request)
    name, _, pw = request.headers.get("x-mautic-zugang", "").partition(":")
    if not (name and pw):
        raise HTTPException(409, "Kein Mautic-Zugang für diesen Nutzer.")
    return httpx.BasicAuth(name, pw)


async def _rufe(request: Request, methode: str, pfad: str, **kw) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:  # cell-internal, plain HTTP
        r = await c.request(methode, f"{MAUTIC_URL}/api{pfad}", auth=_auth(request),
                            headers=proxy_kopf(), **kw)
    if r.status_code == 401:
        raise HTTPException(401, "Mautic lehnt den Zugang ab.")  # gateway renews once
    if r.status_code == 403:
        raise HTTPException(403, "In Mautic fehlt dir dafür die Berechtigung.")
    if r.status_code >= 400:
        raise HTTPException(502, f"Mautic: {r.status_code} {r.text[:300]}")
    return r.json() if r.content else {}


def _link(art: str, rid: int) -> dict:
    pfade = {"contact": "contacts", "segment": "segments", "email": "emails", "campaign": "campaigns"}
    return {"link": f"https://mautic.{BASE_DOMAIN}/s/{pfade[art]}/view/{rid}"} if BASE_DOMAIN else {}


def _werte(lead: dict) -> dict:
    """Mautic keeps contact fields under fields.all."""
    return (lead.get("fields") or {}).get("all") or {}


def _kontakt_zeile(lead: dict) -> dict:
    f = _werte(lead)
    name = " ".join(x for x in (f.get("firstname"), f.get("lastname")) if x)
    out = {"id": lead["id"], "name": name or None, "email": f.get("email"), "firma": f.get("company"),
           "punkte": lead.get("points")}
    return {k: v for k, v in out.items() if v not in (None, "")} | _link("contact", lead["id"])


def _liste(antwort: dict, schluessel: str) -> list[dict]:
    """Mautic lists come as {id: record} (or, for some versions, a plain list)."""
    werte = antwort.get(schluessel) or {}
    return list(werte.values()) if isinstance(werte, dict) else list(werte)


class Suche(BaseModel):
    suche: str = Field(default="", max_length=200)
    anzahl: int = Field(default=10, ge=1, le=50)


@router.post("/kontakte/suche")
async def kontakte_suchen(body: Suche, request: Request) -> dict:
    """Contacts by name, email or company (Mautic's search syntax works too)."""
    antwort = await _rufe(request, "GET", "/contacts",
                          params={"search": body.suche, "limit": body.anzahl, "orderBy": "id",
                                  "orderByDir": "DESC", "minimal": "true"})
    treffer = [_kontakt_zeile(k) for k in _liste(antwort, "contacts")]
    return {"anzahl": len(treffer), "gesamt": antwort.get("total"), "treffer": treffer}


class NeuerKontakt(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    vorname: str | None = Field(default=None, max_length=100)
    nachname: str | None = Field(default=None, max_length=100)
    firma: str | None = Field(default=None, max_length=200)
    tags: list[str] = Field(default_factory=list, max_length=10)


async def _kontakt_per_mail(request: Request, email: str) -> dict | None:
    antwort = await _rufe(request, "GET", "/contacts",
                          params={"search": f"email:{email}", "limit": 2, "minimal": "true"})
    treffer = [k for k in _liste(antwort, "contacts")
               if str(_werte(k).get("email", "")).lower() == email.strip().lower()]
    return treffer[0] if treffer else None


@router.post("/kontakte")
async def kontakt_anlegen(body: NeuerKontakt, request: Request) -> dict:
    """A contact (or the existing one with that email address)."""
    da = await _kontakt_per_mail(request, body.email)
    if da:
        return {"angelegt": False, "vorhanden": True, **_kontakt_zeile(da)}
    werte = {"email": body.email, "firstname": body.vorname or "", "lastname": body.nachname or "",
             "company": body.firma or ""}
    if body.tags:
        werte["tags"] = body.tags
    neu = (await _rufe(request, "POST", "/contacts/new", json=werte)).get("contact") or {}
    return {"angelegt": True, **_kontakt_zeile(neu)}


class Segment(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    beschreibung: str | None = Field(default=None, max_length=500)
    kontakte: list[str] = Field(default_factory=list, max_length=200, description="email addresses")


@router.post("/segmente")
async def segment_anlegen(body: Segment, request: Request) -> dict:
    """A segment (contact list) with the given contacts as members."""
    seg = (await _rufe(request, "POST", "/segments/new",
                       json={"name": body.name, "description": body.beschreibung or "",
                             "isPublished": True})).get("list") or {}
    drin, fehlen = [], []
    for mail in body.kontakte:
        k = await _kontakt_per_mail(request, mail)
        if not k:
            fehlen.append(mail)
            continue
        await _rufe(request, "POST", f"/segments/{seg['id']}/contact/{k['id']}/add")
        drin.append(mail)
    antwort = {"angelegt": True, "id": seg["id"], "name": seg.get("name"), "mitglieder": len(drin),
               **_link("segment", seg["id"])}
    if fehlen:
        antwort["nicht_gefunden"] = fehlen
        antwort["hinweis"] = "Diese Adressen sind keine Kontakte — erst mit create_mautic_contact anlegen."
    return antwort


async def _segment(request: Request, name: str) -> tuple[dict | None, dict | None]:
    antwort = await _rufe(request, "GET", "/segments", params={"search": name, "limit": 10})
    treffer = _liste(antwort, "lists")
    genau = [t for t in treffer if t.get("name", "").strip().lower() == name.strip().lower()]
    if len(genau) == 1 or len(treffer) == 1:
        return (genau or treffer)[0], None
    return None, {"hinweis": f"Segment „{name}“ " + ("nicht gefunden." if not treffer else "ist nicht eindeutig."),
                  "kandidaten": [t.get("name") for t in treffer]}


def _html(text: str) -> str:
    """Plain text paragraphs → a simple, safe HTML body (no user markup passes through)."""
    absaetze = [a.strip() for a in text.replace("\r", "").split("\n\n") if a.strip()]
    inhalt = "".join(f"<p>{html.escape(a).replace(chr(10), '<br>')}</p>" for a in absaetze)
    return ("<!DOCTYPE html><html><body style=\"font-family:Arial,sans-serif;font-size:15px;"
            f"line-height:1.5;color:#222;max-width:600px;margin:auto\">{inhalt}"
            # Mautic's token, a link only at sending time: an <a href> here makes Mautic 7.2
            # validate links with symfony/dom-crawler, which its image lacks (500).
            "<p style=\"font-size:12px;color:#888\">{unsubscribe_text}</p>"
            "</body></html>")


class Mail(BaseModel):
    name: str = Field(min_length=1, max_length=150, description="internal name")
    betreff: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=10000, description="plain text, paragraphs by blank lines")
    segment: str = Field(min_length=1, max_length=150)


@router.post("/emails")
async def email_entwerfen(body: Mail, request: Request) -> dict:
    """A segment email as a DRAFT (unpublished, not sent)."""
    seg, hinweis = await _segment(request, body.segment)
    if hinweis:
        return {"angelegt": False, **hinweis}
    mail = (await _rufe(request, "POST", "/emails/new",
                        json={"name": body.name, "subject": body.betreff, "customHtml": _html(body.text),
                              "emailType": "list", "lists": [seg["id"]], "isPublished": False,
                              "template": "blank"})).get("email") or {}
    return {"angelegt": True, "id": mail["id"], "name": mail.get("name"), "segment": seg.get("name"),
            "status": "Entwurf (nicht versendet)", **_link("email", mail["id"])}


async def _email(request: Request, name: str) -> tuple[dict | None, dict | None]:
    antwort = await _rufe(request, "GET", "/emails", params={"search": name, "limit": 10})
    treffer = _liste(antwort, "emails")
    genau = [t for t in treffer if t.get("name", "").strip().lower() == name.strip().lower()]
    if len(genau) == 1 or len(treffer) == 1:
        return (genau or treffer)[0], None
    return None, {"hinweis": f"E-Mail „{name}“ " + ("nicht gefunden." if not treffer else "ist nicht eindeutig."),
                  "kandidaten": [t.get("name") for t in treffer]}


class Kampagne(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    beschreibung: str | None = Field(default=None, max_length=500)
    segment: str = Field(min_length=1, max_length=150)
    emails: list[str] = Field(min_length=1, max_length=5, description="names of existing emails, in order")
    tage_dazwischen: int = Field(default=3, ge=0, le=90)


@router.post("/kampagnen")
async def kampagne_anlegen(body: Kampagne, request: Request) -> dict:
    """A linear campaign: segment → email 1 → wait N days → email 2 …, UNPUBLISHED.

    Only this simple shape: Mautic's campaign API is known to drop decisions and
    conditions it is given (they would then fire for everyone)."""
    seg, hinweis = await _segment(request, body.segment)
    if hinweis:
        return {"angelegt": False, **hinweis}
    mails = []
    for name in body.emails:
        m, hinweis = await _email(request, name)
        if hinweis:
            return {"angelegt": False, **hinweis}
        mails.append(m)
    ereignisse, knoten, verbindungen = [], [{"id": "lists", "positionX": "650", "positionY": "50"}], []
    vorher = None
    for i, m in enumerate(mails, start=1):
        eid = f"new{i}"
        e = {"id": eid, "name": f"E-Mail: {m.get('name')}", "type": "email.send", "eventType": "action",
             "order": i, "properties": {"email": m["id"], "email_type": "marketing"},
             "parent": vorher, "decisionPath": None, "children": []}
        if i == 1:
            e["triggerMode"] = "immediate"
        else:
            e.update(triggerMode="interval", triggerInterval=body.tage_dazwischen, triggerIntervalUnit="d")
        ereignisse.append(e)
        knoten.append({"id": eid, "positionX": "550", "positionY": str(50 + 150 * i)})
        verbindungen.append({"sourceId": vorher or "lists", "targetId": eid,
                             "anchors": {"source": "bottom" if vorher else "leadsource", "target": "top"}})
        vorher = eid
    kampagne = (await _rufe(request, "POST", "/campaigns/new",
                            json={"name": body.name, "description": body.beschreibung or "",
                                  "isPublished": False, "lists": [{"id": seg["id"]}], "events": ereignisse,
                                  "canvasSettings": {"nodes": knoten, "connections": verbindungen}}
                            )).get("campaign") or {}
    return {"angelegt": True, "id": kampagne["id"], "name": kampagne.get("name"), "segment": seg.get("name"),
            "schritte": len(kampagne.get("events") or ereignisse),
            "status": "nicht veröffentlicht — startet erst, wenn du sie in Mautic veröffentlichst",
            **_link("campaign", kampagne["id"])}
