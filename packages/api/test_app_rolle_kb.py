"""Knowledge (claraos_kb_*) under row-level security — through the real routes.

Migration 042 puts RESTRICTIVE policies on the knowledge tables and every
request path of routers/knowledge.py runs in `database.user_tx`. This test
proves both halves over HTTP: user A cannot reach user B's objects, AND the
shares that the app offers (object share, collection share read/write,
'family') keep working. It also checks the structural helpers (cycle check
across a page the mover cannot see).

Needs a THROWAWAY PostgreSQL in which the API role is a superuser (as in
production), with the knowledge schema, 041 and 042 applied. Skipped unless
CLARAOS_TEST_PG_HOST is set (see test_app_rolle.py for the setup). Never point
this at the production database: it writes rows (owner `probe_*`) and deletes
them again.
"""
from __future__ import annotations

import os

import pytest

HOST = os.environ.get("CLARAOS_TEST_PG_HOST", "")
pytestmark = pytest.mark.skipif(not HOST, reason="CLARAOS_TEST_PG_HOST not set (throwaway DB only)")

if HOST:
    os.environ["CLARAOS_DB_HOST"] = HOST
    os.environ["CLARAOS_DB_PORT"] = os.environ.get("CLARAOS_TEST_PG_PORT", "5432")
    os.environ["CLARAOS_DB_PASS"] = os.environ.get("CLARAOS_TEST_PG_PASS", "")
    os.environ["CLARAOS_DB_USER"] = os.environ.get("CLARAOS_TEST_PG_USER", "clara")
    os.environ["CLARAOS_DB_NAME"] = os.environ.get("CLARAOS_TEST_PG_DB", "clara_users")

A, B = "probe_anna", "probe_bodo"
K = "/api/claraos/knowledge"


def _hdr(user: str) -> dict:
    # Dev mode (no proxy secret, no service token): identity from the header.
    return {"X-Authentik-Username": user, "X-Authentik-Groups": "clara-users"}


_AUFRAEUMEN = (
    "DELETE FROM claraos_kb_notifications WHERE username LIKE 'probe_%';"
    "DELETE FROM claraos_kb_favorites WHERE username LIKE 'probe_%';"
    "DELETE FROM claraos_kb_collections WHERE owner LIKE 'probe_%';"
    "DELETE FROM claraos_kb_objects WHERE owner LIKE 'probe_%';"
    "DELETE FROM claraos_kb_templates WHERE owner LIKE 'probe_%';"
    "DELETE FROM claraos_kb_types WHERE owner LIKE 'probe_%'"
)


@pytest.fixture(scope="module")
def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import auth
    if auth.ENFORCE:
        pytest.skip("auth enforced in this environment — test needs dev mode")
    from routers import knowledge
    from services import kb_indexer, kontakte_regeln

    # Outside the database under test: reachability rules, Qdrant, LLM.
    async def _darf(_a, _b):
        return True, "test"

    async def _nichts(*_a, **_k):
        return None

    kontakte_regeln.darf_erreichen = _darf
    for name in ("index_object", "deindex_object", "update_collection_ids"):
        setattr(kb_indexer, name, _nichts)
    knowledge.kb_analyst.analyze_idea = _nichts

    app = FastAPI()
    app.include_router(knowledge.router)

    @app.post("/_probe/sql")
    async def _sql(body: dict):  # test-only helper: superuser cleanup + raw checks
        from database import get_pool, user_tx
        if body.get("als") is not None:
            async with user_tx(body["als"]) as conn:
                return {"n": await conn.fetchval(body["q"])}
        pool = await get_pool()
        await pool.execute(body["q"])
        return {}

    with TestClient(app) as c:
        c.post("/_probe/sql", json={"q": _AUFRAEUMEN})
        yield c
        c.post("/_probe/sql", json={"q": _AUFRAEUMEN})


def _neu(client, user, **kw) -> str:
    body = {"type": "note", "title": kw.pop("title", "probe"), "body": kw.pop("body", "probe text")}
    body.update(kw)
    r = client.post(f"{K}/objects", json=body, headers=_hdr(user))
    assert r.status_code == 200, r.text
    return r.json()["object"]["id"]


def test_privates_objekt_getrennt(client):
    oid = _neu(client, A, title="probe annas geheimnis", body="nur fuer anna")
    assert client.get(f"{K}/objects/{oid}", headers=_hdr(A)).status_code == 200
    assert client.get(f"{K}/objects/{oid}", headers=_hdr(B)).status_code == 404
    ids = [o["id"] for o in client.get(f"{K}/objects", headers=_hdr(B)).json()["objects"]]
    assert oid not in ids
    assert client.patch(f"{K}/objects/{oid}", json={"title": "gekapert"}, headers=_hdr(B)).status_code == 404
    assert client.delete(f"{K}/objects/{oid}", headers=_hdr(B)).status_code == 404
    assert client.put(f"{K}/objects/{oid}/favorite", headers=_hdr(B)).status_code == 404
    assert client.post(f"{K}/objects/{oid}/comments", json={"body": "x"}, headers=_hdr(B)).status_code == 404
    assert client.get(f"{K}/objects/{oid}/history", headers=_hdr(B)).status_code == 404
    hits = client.get(f"{K}/search", params={"q": "geheimnis"}, headers=_hdr(B)).json()
    assert all(h.get("id") != oid for h in hits.get("results", []))
    # unchanged for the owner
    assert client.get(f"{K}/objects/{oid}", headers=_hdr(A)).json()["object"]["title"] == "probe annas geheimnis"


def test_objektfreigabe_und_kommentar(client):
    oid = _neu(client, A, title="probe geteilt")
    r = client.post(f"{K}/objects/{oid}/shares", json={"username": B}, headers=_hdr(A))
    assert r.status_code == 200, r.text
    assert client.get(f"{K}/objects/{oid}", headers=_hdr(B)).status_code == 200
    # a viewer may comment; the owner gets a notification written by the viewer's request
    r = client.post(f"{K}/objects/{oid}/comments", json={"body": "schoen"}, headers=_hdr(B))
    assert r.status_code == 200, r.text
    noti = client.get(f"{K}/notifications", headers=_hdr(A)).json()["notifications"]
    assert any(n["object_id"] == oid and n["actor"] == B for n in noti)
    assert client.get(f"{K}/notifications", headers=_hdr(B)).json()["notifications"] == [] or all(
        n["object_id"] != oid for n in client.get(f"{K}/notifications", headers=_hdr(B)).json()["notifications"])
    # only the owner edits a shared object
    assert client.patch(f"{K}/objects/{oid}", json={"title": "x"}, headers=_hdr(B)).status_code == 403
    # revoke -> gone again
    assert client.delete(f"{K}/objects/{oid}/shares/{B}", headers=_hdr(A)).status_code == 200
    assert client.get(f"{K}/objects/{oid}", headers=_hdr(B)).status_code == 404


def test_sammlungsfreigabe_lesen_dann_schreiben(client):
    cid = client.post(f"{K}/collections", json={"name": "probe sammlung"}, headers=_hdr(A)).json()["collection"]["id"]
    oid = _neu(client, A, title="probe in sammlung")
    assert client.post(f"{K}/collections/{cid}/items", json={"object_id": oid}, headers=_hdr(A)).status_code == 200
    assert client.get(f"{K}/collections/{cid}/rows", headers=_hdr(B)).status_code == 404
    assert client.get(f"{K}/objects/{oid}", headers=_hdr(B)).status_code == 404

    r = client.post(f"{K}/collections/{cid}/shares", json={"username": B, "permission": "read"}, headers=_hdr(A))
    assert r.status_code == 200, r.text
    assert client.get(f"{K}/objects/{oid}", headers=_hdr(B)).status_code == 200
    rows = client.get(f"{K}/collections/{cid}/rows", headers=_hdr(B))
    assert rows.status_code == 200 and any(o["id"] == oid for o in rows.json().get("rows", rows.json().get("objects", [])))
    assert client.patch(f"{K}/objects/{oid}", json={"title": "von bodo"}, headers=_hdr(B)).status_code == 403
    # Bodo sees who has access (members see the member list)
    shares = client.get(f"{K}/collections/{cid}/shares", headers=_hdr(B)).json()["shares"]
    assert [s["username"] for s in shares] == [B]

    r = client.patch(f"{K}/collections/{cid}/shares/{B}", json={"permission": "write"}, headers=_hdr(A))
    assert r.status_code == 200, r.text
    r = client.patch(f"{K}/objects/{oid}", json={"title": "probe von bodo"}, headers=_hdr(B))
    assert r.status_code == 200, r.text
    # write member creates a field and a note in the collection
    r = client.post(f"{K}/collections/{cid}/fields", json={"key": "probe_k", "name": "K"}, headers=_hdr(B))
    assert r.status_code == 200, r.text
    bid = _neu(client, B, title="probe bodos notiz")
    assert client.post(f"{K}/collections/{cid}/items", json={"object_id": bid}, headers=_hdr(B)).status_code == 200
    # ... which Anna then sees through her own collection
    assert client.get(f"{K}/objects/{bid}", headers=_hdr(A)).status_code == 200
    # Bodo leaves on his own; afterwards nothing is visible any more
    assert client.delete(f"{K}/collections/{cid}/shares/{B}", headers=_hdr(B)).status_code == 200
    assert client.get(f"{K}/objects/{oid}", headers=_hdr(B)).status_code == 404


def test_family_und_fremder_typ(client):
    tid = "probe_annatyp"
    r = client.post(f"{K}/types", json={"id": tid, "name": "Annas Typ"}, headers=_hdr(A))
    assert r.status_code == 200, r.text
    oid = _neu(client, A, title="probe familie", visibility="family", type=tid)
    o = client.get(f"{K}/objects/{oid}", headers=_hdr(B))
    assert o.status_code == 200 and o.json()["object"]["can_edit"] is False
    # the code resolves types by id without an owner filter: Bodo may use Anna's type
    assert _neu(client, B, title="probe mit annas typ", type=tid)
    # but not change it
    assert client.patch(f"{K}/types/{tid}", json={"name": "gekapert"}, headers=_hdr(B)).status_code in (403, 404)


def test_zyklenpruefung_ueber_unsichtbare_seite(client):
    p = _neu(client, A, title="probe wurzel", visibility="family")
    c = _neu(client, B, title="probe bodos private unterseite", parent_id=p)   # invisible to Anna
    d = _neu(client, B, title="probe sichtbare enkelseite", parent_id=c, visibility="family")
    assert client.get(f"{K}/objects/{c}", headers=_hdr(A)).status_code == 404
    r = client.patch(f"{K}/objects/{p}/move", json={"parent_id": d}, headers=_hdr(A))
    assert r.status_code == 400 and "Zyklus" in r.text, r.text


def test_rls_traegt_ohne_where(client):
    """The policy alone separates: queries WITHOUT a user filter, as the role."""
    q_priv = "SELECT count(*) FROM claraos_kb_objects WHERE title = 'probe annas geheimnis'"
    assert client.post("/_probe/sql", json={"als": B, "q": q_priv}).json()["n"] == 0
    assert client.post("/_probe/sql", json={"als": A, "q": q_priv}).json()["n"] == 1
    q_hist = ("SELECT count(*) FROM claraos_kb_history h JOIN claraos_kb_objects o ON o.id = h.object_id "
              "WHERE o.title = 'probe annas geheimnis'")
    # history rows of Anna's private object (written by the post-save as superuser)
    assert client.post("/_probe/sql", json={"als": A, "q": q_hist}).json()["n"] >= 1
    assert client.post("/_probe/sql", json={"als": B, "q": "SELECT count(*) FROM claraos_kb_favorites "
                                                         "WHERE username = 'probe_anna'"}).json()["n"] == 0
    assert client.post("/_probe/sql", json={"als": B, "q": q_hist}).json()["n"] == 0
