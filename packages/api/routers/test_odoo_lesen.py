"""Odoo tools for Clara in a cell: route logic and the per-user access, offline (Odoo mocked)."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth
from routers import odoo_lesen as ol
from services import zellen_zugaenge as zz

ZUGANG = {"x-odoo-zugang": "7:geheim"}


class FakeOdoo:
    """Answers execute_kw like Odoo would for one user; records every call."""

    def __init__(self, installiert=("res.partner",), abgelehnt=False):
        self.installiert = set(installiert)
        self.abgelehnt = abgelehnt
        self.aufrufe: list[tuple] = []

    async def __call__(self, service, method, *args):
        db, uid, pw, model, meth, pos, kw = args
        self.aufrufe.append((uid, pw, model, meth, pos, kw))
        if self.abgelehnt:
            raise PermissionError("Odoo lehnt die Anmeldung ab")
        if model not in self.installiert:
            raise zz.OdooFehler("odoo.exceptions.UserError", f"Object {model} doesn't exist")
        if getattr(self, "verboten", None) == meth:
            raise zz.OdooFehler("odoo.exceptions.AccessError", "Sie sind nicht berechtigt …")
        if meth == "search_read" and model == "res.partner" and kw.get("fields") == ["id", "display_name"]:
            return [{"id": 3, "display_name": "Bau GmbH"}]
        if meth == "search_read":
            return [{"id": 42, "display_name": "Erika Muster", "email": "erika@example.com",
                     "phone": False, "is_company": False, "city": "Köln",
                     "parent_id": [3, "Bau GmbH"]}]
        if meth == "create":
            return 99
        raise AssertionError(f"unerwartet: {model}.{meth}")


@pytest.fixture
def odoo(monkeypatch):
    fake = FakeOdoo()
    monkeypatch.setattr(ol, "odoo_rpc", fake)
    monkeypatch.setattr(ol, "BASE_DOMAIN", "demo.example.com")
    monkeypatch.setattr(auth, "ENFORCE", False)
    return fake


@pytest.fixture
def client(odoo):
    app = FastAPI()
    app.include_router(ol.router)
    return TestClient(app)


def test_kontaktsuche_als_der_nutzer_mit_link(client, odoo):
    r = client.post("/api/claraos/odoo/kontakte/suche", json={"suche": "erika"}, headers=ZUGANG)
    assert r.status_code == 200
    t = r.json()["treffer"][0]
    assert t["display_name"] == "Erika Muster" and t["parent_id"] == "Bau GmbH"   # many2one → name
    assert "phone" not in t                                                       # empty fields dropped
    assert t["link"] == "https://odoo.demo.example.com/odoo/res.partner/42"
    uid, pw, model, meth, pos, kw = odoo.aufrufe[0]
    domain = pos[0]                                          # execute_kw: args = [domain]
    assert (uid, pw) == (7, "geheim")                       # the caller's own access, not an admin
    assert model == "res.partner" and meth == "search_read"
    assert ["email", "ilike", "erika"] in domain            # contacts also match by email


def test_bereich_ohne_installierte_app_sagt_es(client):
    r = client.post("/api/claraos/odoo/suche", json={"bereich": "rechnungen"}, headers=ZUGANG)
    assert r.status_code == 200
    assert r.json()["anzahl"] == 0 and "Rechnungen" in r.json()["hinweis"]


def test_fehlendes_recht_wird_403_mit_klarer_meldung(client, odoo):
    odoo.verboten = "create"
    r = client.post("/api/claraos/odoo/kontakte", headers=ZUGANG, json={"name": "X"})
    assert r.status_code == 403 and "Berechtigung" in r.json()["detail"]


def test_unbekannter_bereich_wird_abgelehnt(client):
    r = client.post("/api/claraos/odoo/suche", json={"bereich": "res.users"}, headers=ZUGANG)
    assert r.status_code == 422                             # not a generic RPC bridge


def test_ohne_zugang_409_und_abgelehnt_401(client, odoo):
    assert client.post("/api/claraos/odoo/kontakte/suche", json={}).status_code == 409
    assert client.post("/api/claraos/odoo/kontakte/suche", json={},
                       headers={"x-odoo-zugang": "kaputt"}).status_code == 409
    odoo.abgelehnt = True
    # 401 lets the gateway renew a stale access once
    assert client.post("/api/claraos/odoo/kontakte/suche", json={}, headers=ZUGANG).status_code == 401


def test_kontakt_anlegen_mit_firma(client, odoo):
    r = client.post("/api/claraos/odoo/kontakte", headers=ZUGANG,
                    json={"name": "Max Maier", "email": "max@example.com", "zugehoerig_zu": "Bau"})
    assert r.status_code == 200 and r.json()["angelegt"] is True and r.json()["id"] == 99
    werte = [a for a in odoo.aufrufe if a[3] == "create"][0][4][0]
    assert werte == {"name": "Max Maier", "is_company": False, "email": "max@example.com", "parent_id": 3}


# ── Per-user access (services/zellen_zugaenge._odoo) ──────────────────────────

class FakeAdmin:
    def __init__(self, konto):
        self.konto = konto
        self.geschrieben = None

    async def __call__(self, service, method, *args):
        if method == "authenticate":
            return 2
        db, uid, pw, model, meth, pos, kw = args
        if model == "res.users" and meth == "search_read":
            return [self.konto] if self.konto else []
        if model == "ir.model.data":
            return [{"res_id": 4}, {"res_id": 5}]           # group_system, group_erp_manager
        if model == "res.users" and meth == "write":
            self.geschrieben = pos
            return True
        raise AssertionError(f"unerwartet: {model}.{meth}")


@pytest.fixture
def admin(monkeypatch):
    monkeypatch.setenv("ODOO_ADMIN_PASSWORD", "admin-pw")

    async def email(_u):
        return "erika@example.com"
    monkeypatch.setattr(zz, "_email", email)

    def mit(konto):
        fake = FakeAdmin(konto)
        monkeypatch.setattr(zz, "odoo_rpc", fake)
        return fake
    return mit


def test_zugang_fuer_internes_konto(admin):
    fake = admin({"id": 9, "share": False, "groups_id": [1, 2]})
    werte = asyncio.run(zz._odoo("erika"))
    uid, _, pw = werte["zugang"].partition(":")
    assert uid == "9" and len(pw) >= 32
    assert fake.geschrieben == [[9], {"password": pw}]


@pytest.mark.parametrize("konto,grund", [
    (None, "einmal über die Kachel"),
    ({"id": 9, "share": True, "groups_id": []}, "Portal"),
    ({"id": 9, "share": False, "groups_id": [1, 4]}, "Administratoren"),
])
def test_kein_zugang_fuer_fehlende_portal_und_admin_konten(admin, konto, grund):
    fake = admin(konto)
    with pytest.raises(zz.ZugangFehlt, match=grund):
        asyncio.run(zz._odoo("erika"))
    assert fake.geschrieben is None                          # no password was set
