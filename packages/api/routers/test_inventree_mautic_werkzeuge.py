"""Clara's InvenTree and Mautic tools in a cell: route logic offline (the apps mocked)."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth
from routers import inventree_werkzeuge as iw
from routers import mautic_werkzeuge as mw


class App:
    """Records every request; answers from a table {(METHOD, path): json or callable}."""

    def __init__(self, antworten):
        self.antworten = antworten
        self.anfragen: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.anfragen.append(request)
        key = (request.method, request.url.path)
        a = self.antworten.get(key)
        if a is None:
            return httpx.Response(404, json={"detail": f"unerwartet {key}"})
        a = a(request) if callable(a) else a
        return httpx.Response(200, json=a)

    def gesendet(self, methode, pfad):
        return [json.loads(r.content or b"{}") for r in self.anfragen
                if r.method == methode and r.url.path == pfad]


def _client(monkeypatch, modul, app):
    original = httpx.AsyncClient
    monkeypatch.setattr(modul.httpx, "AsyncClient",
                        lambda **kw: original(transport=httpx.MockTransport(app), **kw))
    monkeypatch.setattr(modul, "BASE_DOMAIN", "demo.example.com")
    monkeypatch.setattr(auth, "ENFORCE", False)
    f = FastAPI()
    f.include_router(modul.router)
    return TestClient(f)


# ── InvenTree ──────────────────────────────────────────────────────────────────
TOKEN = {"x-inventree-token": "tok"}


@pytest.fixture
def inventree():
    return App({
        ("GET", "/api/part/category/"): {"results": [{"pk": 2, "name": "Electronics"}]},
        ("GET", "/api/stock/location/"): {"results": [{"pk": 5, "name": "Main warehouse"}]},
        ("POST", "/api/part/"): {"pk": 77, "name": "Sensor X"},
        ("POST", "/api/stock/"): [{"pk": 900}],
        ("GET", "/api/part/"): {"results": [{"pk": 77, "name": "Sensor X", "in_stock": 4, "minimum_stock": 10}]},
        ("GET", "/api/stock/"): {"results": [{"pk": 900, "quantity": 4}, {"pk": 901, "quantity": 1}]},
        ("POST", "/api/stock/add/"): {},
        ("GET", "/api/part/77/"): {"pk": 77, "in_stock": 54},
        ("GET", "/api/company/"): {"results": [{"pk": 8, "name": "Sensor Supply Ltd"}]},
        ("GET", "/api/company/part/"): {"results": []},
        ("POST", "/api/company/part/"): {"pk": 31},
        ("POST", "/api/order/po/"): {"pk": 12, "reference": "PO-0012"},
        ("POST", "/api/order/po-line/"): {"pk": 1},
    })


def test_inventree_ohne_token_409(monkeypatch, inventree):
    c = _client(monkeypatch, iw, inventree)
    assert c.post("/api/claraos/inventree/teile/suche", json={}).status_code == 409


def test_inventree_als_der_nutzer_und_knapp_markiert(monkeypatch, inventree):
    c = _client(monkeypatch, iw, inventree)
    r = c.post("/api/claraos/inventree/teile/suche", headers=TOKEN, json={"suche": "Sensor"})
    t = r.json()["treffer"][0]
    assert t["unter_mindestbestand"] is True and t["link"].endswith("/web/part/77/details")
    assert inventree.anfragen[0].headers["authorization"] == "Token tok"


def test_teil_mit_anfangsbestand(monkeypatch, inventree):
    c = _client(monkeypatch, iw, inventree)
    r = c.post("/api/claraos/inventree/teile", headers=TOKEN,
               json={"name": "Sensor X", "kategorie": "Electronics", "anfangsbestand": 40,
                     "lagerort": "Main warehouse", "mindestbestand": 10})
    assert r.json()["angelegt"] is True and r.json()["bestand"] == 40
    assert inventree.gesendet("POST", "/api/part/")[0]["category"] == 2
    assert inventree.gesendet("POST", "/api/stock/")[0] == {"part": 77, "quantity": 40, "location": 5}


def test_buchung_auf_den_groessten_posten(monkeypatch, inventree):
    c = _client(monkeypatch, iw, inventree)
    r = c.post("/api/claraos/inventree/bestand", headers=TOKEN, json={"teil": "Sensor X", "menge": 50})
    assert r.json()["gebucht"] is True and r.json()["bestand_jetzt"] == 54
    assert inventree.gesendet("POST", "/api/stock/add/")[0]["items"] == [{"pk": 900, "quantity": 50.0}]


def test_abbuchung_mehr_als_vorhanden_abgelehnt(monkeypatch, inventree):
    c = _client(monkeypatch, iw, inventree)
    r = c.post("/api/claraos/inventree/bestand", headers=TOKEN, json={"teil": "Sensor X", "menge": -9})
    assert r.json()["gebucht"] is False and not inventree.gesendet("POST", "/api/stock/remove/")


def test_bestellung_als_entwurf_mit_lieferantenteil(monkeypatch, inventree):
    c = _client(monkeypatch, iw, inventree)
    r = c.post("/api/claraos/inventree/bestellung", headers=TOKEN,
               json={"lieferant": "Sensor Supply Ltd", "teil": "Sensor X", "menge": 50, "preis": 3.2})
    assert r.json()["angelegt"] is True and r.json()["nummer"] == "PO-0012"
    assert inventree.gesendet("POST", "/api/company/part/")[0]["supplier"] == 8
    assert inventree.gesendet("POST", "/api/order/po-line/")[0] == {"order": 12, "part": 31, "quantity": 50.0,
                                                                     "purchase_price": 3.2}
    assert not [a for a in inventree.anfragen if a.url.path.endswith("/issue/")]  # stays a draft


# ── Mautic ─────────────────────────────────────────────────────────────────────
ZUGANG = {"x-mautic-zugang": "anna:pw"}


def _kontakte(request):
    suche = request.url.params.get("search", "")
    if suche == "email:anna@kunde.example":
        return {"total": 1, "contacts": {"4": {"id": 4, "points": 3,
                                                "fields": {"all": {"email": "anna@kunde.example"}}}}}
    return {"total": 0, "contacts": []}


@pytest.fixture
def mautic():
    return App({
        ("GET", "/api/contacts"): _kontakte,
        ("POST", "/api/contacts/new"): {"contact": {"id": 9, "fields": {"all": {"email": "tom@kunde.example"}}}},
        ("POST", "/api/segments/new"): {"list": {"id": 3, "name": "Messe 2026"}},
        ("POST", "/api/segments/3/contact/4/add"): {"success": 1},
        ("GET", "/api/segments"): {"lists": {"3": {"id": 3, "name": "Messe 2026"}}},
        ("POST", "/api/emails/new"): {"email": {"id": 21, "name": "Willkommen"}},
        ("GET", "/api/emails"): lambda r: {"emails": {
            "21": {"id": 21, "name": "Willkommen"}, "22": {"id": 22, "name": "Nachfassen"}}},
        ("POST", "/api/campaigns/new"): {"campaign": {"id": 5, "name": "Messe-Nachfass", "events": [1, 2]}},
    })


def test_mautic_segment_mit_vorhandenen_kontakten(monkeypatch, mautic):
    c = _client(monkeypatch, mw, mautic)
    r = c.post("/api/claraos/mautic/segmente", headers=ZUGANG,
               json={"name": "Messe 2026", "kontakte": ["anna@kunde.example", "neu@kunde.example"]})
    assert r.json()["mitglieder"] == 1 and r.json()["nicht_gefunden"] == ["neu@kunde.example"]
    assert mautic.anfragen[0].headers["authorization"].startswith("Basic ")


def test_mautic_kontakt_vorhanden_wird_nicht_doppelt_angelegt(monkeypatch, mautic):
    c = _client(monkeypatch, mw, mautic)
    r = c.post("/api/claraos/mautic/kontakte", headers=ZUGANG, json={"email": "anna@kunde.example"})
    assert r.json()["vorhanden"] is True and not mautic.gesendet("POST", "/api/contacts/new")


def test_mautic_email_ist_entwurf_und_text_escaped(monkeypatch, mautic):
    c = _client(monkeypatch, mw, mautic)
    r = c.post("/api/claraos/mautic/emails", headers=ZUGANG,
               json={"name": "Willkommen", "betreff": "Schön, Sie kennenzulernen",
                     "text": "Hallo <b>Anna</b>,\n\ndanke für das Gespräch.", "segment": "Messe 2026"})
    assert r.json()["angelegt"] is True
    neu = mautic.gesendet("POST", "/api/emails/new")[0]
    assert neu["isPublished"] is False and neu["emailType"] == "list" and neu["lists"] == [3]
    assert "&lt;b&gt;Anna&lt;/b&gt;" in neu["customHtml"] and "{unsubscribe_text}" in neu["customHtml"]
    assert "<a " not in neu["customHtml"]  # no links: Mautic 7.2 would answer 500


def test_mautic_kampagne_linear_und_unveroeffentlicht(monkeypatch, mautic):
    c = _client(monkeypatch, mw, mautic)
    r = c.post("/api/claraos/mautic/kampagnen", headers=ZUGANG,
               json={"name": "Messe-Nachfass", "segment": "Messe 2026",
                     "emails": ["Willkommen", "Nachfassen"], "tage_dazwischen": 3})
    assert r.json()["angelegt"] is True and r.json()["link"].endswith("/s/campaigns/view/5")
    k = mautic.gesendet("POST", "/api/campaigns/new")[0]
    assert k["isPublished"] is False and k["lists"] == [{"id": 3}]
    e1, e2 = k["events"]
    assert e1["properties"]["email"] == 21 and e1["triggerMode"] == "immediate" and e1["parent"] is None
    assert e2["parent"] == "new1" and e2["triggerInterval"] == 3 and e2["triggerIntervalUnit"] == "d"
    assert [v["sourceId"] for v in k["canvasSettings"]["connections"]] == ["lists", "new1"]


# ── Per-user access (services/zellen_zugaenge._inventree) ──────────────────────
def test_inventree_zugang_per_admin_token_ohne_passwortwechsel(monkeypatch):
    import asyncio

    from services import zellen_zugaenge as zz
    app = App({
        ("GET", "/api/user/"): {"results": [{"pk": 7, "username": "anna", "is_staff": False}]},
        ("GET", "/api/user/tokens/"): {"results": [{"id": 3, "name": zz.ASSISTANT_NAME, "user": 7}]},
        ("DELETE", "/api/user/tokens/3/"): {},
        ("POST", "/api/user/tokens/"): {"token": "inv-tok"},
    })
    original = httpx.AsyncClient
    monkeypatch.setattr(zz.httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(app), **kw))
    monkeypatch.setenv("INVENTREE_ADMIN_PASSWORD", "admin-pw")
    assert asyncio.run(zz._inventree("anna")) == {"token": "inv-tok"}
    assert app.gesendet("POST", "/api/user/tokens/")[0] == {"name": zz.ASSISTANT_NAME, "user": 7}
    # the old token of that name is revoked, and the password is never touched
    assert [r.url.path for r in app.anfragen if r.method == "DELETE"] == ["/api/user/tokens/3/"]
    assert not [r for r in app.anfragen if "set-password" in r.url.path]
