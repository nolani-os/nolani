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

    def __init__(self, installiert=("res.partner", "crm.lead"), abgelehnt=False):
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
        if meth == "search_read" and model == "res.partner" and "name" in kw.get("fields", []):
            # name lookup (_eindeutig): "Bau" matches two, "Bau GmbH" exactly one
            alle = [{"id": 3, "display_name": "Bau GmbH", "name": "Bau GmbH"},
                    {"id": 4, "display_name": "Bau GmbH, Max Maier", "name": "Max Maier"}]
            gesucht = pos[0][0][2].lower()
            treffer = [a for a in alle if gesucht in a["name"].lower()]
            if ["is_company", "=", True] in pos[0]:
                treffer = [t for t in treffer if t["id"] == 3]
            return treffer
        if meth == "search_read":
            return [{"id": 42, "display_name": "Erika Muster", "email": "erika@example.com",
                     "phone": False, "is_company": False, "city": "Köln",
                     "parent_id": [3, "Bau GmbH"]}]
        if meth == "create":
            return 99
        if meth == "message_post":
            return 555
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
            raise AssertionError("no password write: it ends the user's open Odoo sessions")
        if model == "res.users" and meth == "claraos_assistent_schluessel":
            self.geschrieben = pos
            return "k" * 40
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
    uid, _, schluessel = werte["zugang"].partition(":")
    # an API key issued by the admin (module claraos_zugang), never a new password
    assert uid == "9" and schluessel == "k" * 40
    assert fake.geschrieben == [9, zz.ASSISTANT_NAME]


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


def test_kontakt_mit_funktion(client, odoo):
    r = client.post("/api/claraos/odoo/kontakte", headers=ZUGANG,
                    json={"name": "Anna Berg", "funktion": "CEO", "zugehoerig_zu": "Bau GmbH"})
    assert r.json()["angelegt"] is True
    werte = [a for a in odoo.aufrufe if a[3] == "create"][0][4][0]
    assert werte["function"] == "CEO" and werte["parent_id"] == 3


def test_notiz_als_interne_notiz(client, odoo):
    r = client.post("/api/claraos/odoo/notiz", headers=ZUGANG,
                    json={"kontakt": "Bau GmbH", "text": "Auf der Messe getroffen"})
    assert r.status_code == 200 and r.json()["angelegt"] is True
    assert r.json()["link"].endswith("/odoo/res.partner/3")
    post = [a for a in odoo.aufrufe if a[3] == "message_post"][0]
    assert post[0] == 7 and post[4] == [[3]]
    # internal note: never an email to followers
    assert post[5]["subtype_xmlid"] == "mail.mt_note" and post[5]["message_type"] == "comment"


def test_notiz_bei_mehrdeutigem_namen_nennt_kandidaten(client, odoo):
    r = client.post("/api/claraos/odoo/notiz", headers=ZUGANG, json={"kontakt": "a", "text": "x"})
    assert r.json()["angelegt"] is False and len(r.json()["kandidaten"]) == 2
    assert not [a for a in odoo.aufrufe if a[3] == "message_post"]


def test_verkaufschance_fuer_den_nutzer(client, odoo):
    r = client.post("/api/claraos/odoo/verkaufschance", headers=ZUGANG,
                    json={"titel": "50 Sensoren", "kontakt": "Bau GmbH", "erwarteter_umsatz": 12000,
                          "abschluss_bis": "2026-12-15"})
    assert r.status_code == 200 and r.json()["angelegt"] is True
    assert r.json()["link"].endswith("/odoo/crm.lead/99")
    werte = [a for a in odoo.aufrufe if a[2] == "crm.lead" and a[3] == "create"][0][4][0]
    assert werte == {"name": "50 Sensoren", "type": "opportunity", "partner_id": 3, "user_id": 7,
                     "expected_revenue": 12000, "date_deadline": "2026-12-15"}


def test_verkaufschance_ohne_crm_sagt_es(client, odoo):
    odoo.installiert.discard("crm.lead")
    r = client.post("/api/claraos/odoo/verkaufschance", headers=ZUGANG,
                    json={"titel": "x", "kontakt": "Bau GmbH"})
    assert r.json()["angelegt"] is False and "CRM" in r.json()["hinweis"]
