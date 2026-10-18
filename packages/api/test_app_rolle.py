"""User A cannot read user B's rows — through the real API paths (migration 041).

Needs a THROWAWAY PostgreSQL in which the API role is a superuser (as in
production) and migrations/041_app_rolle.sql has been applied on top of the
stage-1 tables. Skipped unless CLARAOS_TEST_PG_HOST is set:

    docker run -d --rm --name rls-test-pg -e POSTGRES_USER=clara \\
        -e POSTGRES_PASSWORD=<pw> -e POSTGRES_DB=clara_users \\
        -p 127.0.0.1:55432:5432 postgres:16-alpine
    # schema of the stage-1 tables (pg_dump --schema-only -t ...), then 041
    CLARAOS_TEST_PG_HOST=127.0.0.1 CLARAOS_TEST_PG_PORT=55432 \\
    CLARAOS_TEST_PG_PASS=<pw> python -m pytest -q test_app_rolle.py

Never point this at the production database: it writes rows (prefixed
`probe_`) and deletes them again.
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


def _hdr(user: str) -> dict:
    # Dev mode (no proxy secret, no service token): identity from the header.
    return {"X-Authentik-Username": user, "X-Authentik-Groups": "clara-users"}


@pytest.fixture(scope="module")
def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import auth
    if auth.ENFORCE:
        pytest.skip("auth enforced in this environment — test needs dev mode")
    from routers import jobs as jobs_router
    from routers import prefs, settings

    app = FastAPI()
    for r in (prefs.router, settings.router, jobs_router.router):
        app.include_router(r)

    @app.post("/_probe/sql")
    async def _sql(body: dict):  # test-only helper: superuser cleanup + raw checks
        from database import get_pool, user_tx
        if body.get("als"):
            async with user_tx(body["als"]) as conn:
                return {"n": await conn.fetchval(body["q"])}
        pool = await get_pool()
        await pool.execute(body["q"])
        return {}

    with TestClient(app) as c:
        aufraeumen = ("DELETE FROM claraos_user_prefs WHERE username LIKE 'probe_%';"
                      "DELETE FROM claraos_desktop_state WHERE username LIKE 'probe_%';"
                      "DELETE FROM claraos_user_settings WHERE username LIKE 'probe_%';"
                      "DELETE FROM claraos_jobs WHERE username LIKE 'probe_%'")
        c.post("/_probe/sql", json={"q": aufraeumen})
        yield c
        c.post("/_probe/sql", json={"q": aufraeumen})


def test_prefs_getrennt(client):
    assert client.put("/api/claraos/prefs", json={"skin": "anna-skin"}, headers=_hdr(A)).json()["status"] == "ok"
    assert client.get("/api/claraos/prefs", headers=_hdr(A)).json()["stored"] is True
    # Bodo has no row of his own and must not get Anna's.
    r = client.get("/api/claraos/prefs", headers=_hdr(B)).json()
    assert r["stored"] is False and r.get("skin") != "anna-skin"


def test_desktop_state_getrennt(client):
    client.put("/api/claraos/prefs/desktop-state", json={"windows": [], "activeWorkspace": 3}, headers=_hdr(A))
    assert client.get("/api/claraos/prefs/desktop-state", headers=_hdr(B)).json().get("activeWorkspace") != 3


def test_settings_getrennt(client):
    r = client.put("/api/claraos/settings/appearance", json={"uiScale": 120}, headers=_hdr(A))
    assert r.status_code == 200, r.text
    assert client.get("/api/claraos/settings/appearance", headers=_hdr(A)).json()["values"]["uiScale"] == 120
    assert client.get("/api/claraos/settings/appearance", headers=_hdr(B)).json()["values"]["uiScale"] == 100
    assert client.get("/api/claraos/settings/diff", headers=_hdr(B)).json()["changed"] == {}
    # Bodo's reset must not touch Anna's value.
    client.delete("/api/claraos/settings/appearance", headers=_hdr(B))
    assert client.get("/api/claraos/settings/appearance", headers=_hdr(A)).json()["values"]["uiScale"] == 120


def test_jobs_getrennt(client):
    # Machine endpoint is service-only; in dev mode every call counts as service.
    r = client.post("/api/claraos/jobs/ereignis",
                    json={"type": "job.started", "job_id": "probe-1", "user": A,
                          "titel": "Annas Auftrag", "chat_id": "chat-a"})
    assert r.status_code == 200, r.text
    assert client.get("/api/claraos/jobs/probe-1", headers=_hdr(A)).json()["status"] == "laeuft"
    assert client.get("/api/claraos/jobs/probe-1", headers=_hdr(B)).status_code == 404
    assert client.get("/api/claraos/jobs", headers=_hdr(B)).json()["jobs"] == []
    # The same job id for another user is refused, not overwritten.
    r = client.post("/api/claraos/jobs/ereignis",
                    json={"type": "job.done", "job_id": "probe-1", "user": B})
    assert r.status_code == 409
    r = client.post("/api/claraos/jobs/ereignis",
                    json={"event": "job.done", "job_id": "probe-1", "user": A,
                          "ergebnis_url": "javascript:alert(1)"})
    j = client.get("/api/claraos/jobs/probe-1", headers=_hdr(A)).json()
    assert j["status"] == "fertig" and j["ergebnis_url"] is None and j["chat_id"] == "chat-a"
    # A late job.started does not reopen a finished job.
    client.post("/api/claraos/jobs/ereignis", json={"type": "job.started", "job_id": "probe-1", "user": A})
    assert client.get("/api/claraos/jobs/probe-1", headers=_hdr(A)).json()["status"] == "fertig"


def test_rls_traegt_ohne_where(client):
    """The policy alone separates: a query WITHOUT a username filter, as the role."""
    n = client.post("/_probe/sql", json={"als": B, "q": "SELECT count(*) FROM claraos_user_prefs"}).json()["n"]
    assert n == 0
    n = client.post("/_probe/sql", json={"als": A, "q": "SELECT count(*) FROM claraos_user_prefs"}).json()["n"]
    assert n == 1
    n = client.post("/_probe/sql", json={"als": B, "q": "SELECT count(*) FROM claraos_jobs"}).json()["n"]
    assert n == 0
