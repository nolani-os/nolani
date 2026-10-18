"""Tests for agent keys (services/agent_keys.py) and their router (routers/agent_keys.py).

The two connection helpers are replaced by an in-memory store that answers exactly
the statements the module issues, and enforces the owner check that row-level
security would enforce (a user connection only sees its own rows).
"""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import agent_keys


class Store:
    def __init__(self):
        self.keys: dict[str, dict] = {}
        self.calls: list[dict] = []


class Conn:
    def __init__(self, store: Store, user: str | None):
        self.s, self.user = store, user      # user None = plain pool (no RLS)

    def _visible(self, row):
        return self.user is None or row["username"] == self.user

    async def fetch(self, sql, *a):
        if "FROM claraos_agent_keys" in sql:
            rows = [r for r in self.s.keys.values()
                    if self._visible(r) and r["username"] == a[0] and r["revoked"] is None]
            return sorted(rows, key=lambda r: r["created"], reverse=True)
        if "FROM claraos_agent_calls" in sql:
            rows = [dict(c, key_name=self.s.keys.get(c["key_id"], {}).get("name"))
                    for c in self.s.calls if self._visible(c) and c["username"] == a[0]]
            return list(reversed(rows))[: a[1]]
        raise AssertionError(sql)

    async def fetchval(self, sql, *a):
        assert "count(*)" in sql
        return sum(1 for r in self.s.keys.values()
                   if self._visible(r) and r["username"] == a[0] and r["revoked"] is None)

    async def fetchrow(self, sql, *a):
        if sql.startswith("INSERT INTO claraos_agent_keys"):
            assert self.user == a[0], "insert must run as the owner"
            row = {"id": uuid.uuid4(), "username": a[0], "name": a[1], "key_hash": a[2],
                   "key_prefix": a[3], "can_write": a[4], "created": datetime.now(timezone.utc),
                   "last_used": None, "revoked": None}
            self.s.keys[str(row["id"])] = row
            return row
        if "WHERE key_hash = $1" in sql:
            return next((r for r in self.s.keys.values()
                         if r["key_hash"] == a[0] and r["revoked"] is None), None)
        raise AssertionError(sql)

    async def execute(self, sql, *a):
        now = datetime.now(timezone.utc)
        if sql.startswith("UPDATE claraos_agent_keys SET revoked = NOW() \nWHERE id") or \
                ("SET revoked = NOW()" in sql and "id = $1" in sql):
            r = self.s.keys.get(a[0])
            if r and self._visible(r) and r["username"] == a[1] and r["revoked"] is None:
                r["revoked"] = now
                return "UPDATE 1"
            return "UPDATE 0"
        if "SET revoked = NOW() WHERE username" in sql:
            n = 0
            for r in self.s.keys.values():
                if r["username"] == a[0] and r["revoked"] is None:
                    r["revoked"] = now; n += 1
            return f"UPDATE {n}"
        if "SET last_used" in sql:
            self.s.keys[str(a[0])]["last_used"] = now
            return "UPDATE 1"
        if sql.startswith("INSERT INTO claraos_agent_calls"):
            assert self.user == a[1]
            self.s.calls.append({"key_id": a[0], "username": a[1], "tool": a[2], "ok": a[3], "at": now})
            return "INSERT 0 1"
        if sql.startswith("DELETE FROM claraos_agent_calls"):
            return "DELETE 0"
        raise AssertionError(sql)


@pytest.fixture
def store(monkeypatch):
    s = Store()

    @asynccontextmanager
    async def user_conn(username):
        yield Conn(s, username)

    @asynccontextmanager
    async def lookup_conn():
        yield Conn(s, None)

    monkeypatch.setattr(agent_keys, "_user_conn", user_conn)
    monkeypatch.setattr(agent_keys, "_lookup_conn", lookup_conn)
    agent_keys._last_used_written.clear()
    return s


def run(coro):
    return asyncio.run(coro)


# ── service ─────────────────────────────────────────────────────────────

def test_create_stores_only_hash_and_verify_grants_scopes(store):
    rec, key = run(agent_keys.create_key("anna", "Claude Desktop", False))
    assert key.startswith("cak_") and len(key) > 40
    row = store.keys[rec["id"]]
    assert row["key_hash"] == agent_keys.key_hash(key) and key not in row.values()
    tok = run(agent_keys.verify(key))
    assert tok.client_id == "anna" and tok.scopes == ["read"] and tok.claims["key_id"] == rec["id"]
    _, wkey = run(agent_keys.create_key("anna", "Cursor", True))
    assert run(agent_keys.verify(wkey)).scopes == ["read", "write"]


def test_verify_rejects_unknown_malformed_revoked(store):
    rec, key = run(agent_keys.create_key("anna", "x", False))
    assert run(agent_keys.verify("cak_" + "A" * 43)) is None
    assert run(agent_keys.verify("not-a-key")) is None
    assert run(agent_keys.verify("")) is None
    assert run(agent_keys.revoke_key("anna", rec["id"])) is True
    assert run(agent_keys.verify(key)) is None


def test_other_user_cannot_revoke_or_list(store):
    rec, key = run(agent_keys.create_key("anna", "x", False))
    assert run(agent_keys.revoke_key("ben", rec["id"])) is False
    assert run(agent_keys.list_keys("ben")) == []
    assert run(agent_keys.verify(key)) is not None


def test_revoke_all_on_deactivation(store):
    keys = [run(agent_keys.create_key("anna", f"k{i}", False))[1] for i in range(3)]
    _, ben = run(agent_keys.create_key("ben", "b", False))
    assert run(agent_keys.revoke_all("anna")) == 3
    assert all(run(agent_keys.verify(k)) is None for k in keys)
    assert run(agent_keys.verify(ben)) is not None


def test_key_limit(store):
    for i in range(agent_keys.MAX_KEYS_PER_USER):
        run(agent_keys.create_key("anna", f"k{i}", False))
    with pytest.raises(agent_keys.TooManyKeys):
        run(agent_keys.create_key("anna", "one too many", False))


def test_name_is_normalised(store):
    rec, _ = run(agent_keys.create_key("anna", "  a\n  b  " + "x" * 200, False))
    assert rec["name"].startswith("a b") and len(rec["name"]) == agent_keys.NAME_MAX


def test_calls_logged_per_user(store):
    rec, _ = run(agent_keys.create_key("anna", "Claude", False))
    run(agent_keys.record_call("anna", rec["id"], "planner_list_tasks", True))
    run(agent_keys.record_call("ben", None, "mail_list_messages", False))
    calls = run(agent_keys.recent_calls("anna"))
    assert calls == [{"tool": "planner_list_tasks", "ok": True, "at": calls[0]["at"], "key": "Claude"}]


def test_record_call_never_raises(monkeypatch):
    @asynccontextmanager
    async def broken(_u):
        raise RuntimeError("db down")
        yield  # pragma: no cover
    monkeypatch.setattr(agent_keys, "_user_conn", broken)
    run(agent_keys.record_call("anna", None, "x", True))


def test_verify_fails_closed_on_db_error(monkeypatch):
    @asynccontextmanager
    async def broken():
        raise RuntimeError("db down")
        yield  # pragma: no cover
    monkeypatch.setattr(agent_keys, "_lookup_conn", broken)
    assert run(agent_keys.verify("cak_" + "A" * 43)) is None


# ── router ──────────────────────────────────────────────────────────────

JSON = {"Content-Type": "application/json"}


@pytest.fixture
def client(store, monkeypatch):
    import auth
    import betriebsprofil
    from routers import agent_keys as router_mod
    monkeypatch.setattr(auth, "ENFORCE", True)
    monkeypatch.setattr(auth, "SERVICE_TOKEN", "svc")
    monkeypatch.setattr(auth, "PROXY_SECRET", "proxy")
    monkeypatch.setattr(betriebsprofil, "MCP_ENABLED", True)
    monkeypatch.setenv("CLARAOS_PUBLIC_URL", "https://home.example.org")
    app = FastAPI()
    app.include_router(router_mod.router)
    return TestClient(app)


def browser(user="anna"):
    return {**JSON, "X-ClaraOS-Proxy-Secret": "proxy", "X-Authentik-Username": user}


def test_router_create_list_revoke(client):
    r = client.post("/api/claraos/agent-keys", json={"name": "Claude", "can_write": False}, headers=browser())
    assert r.status_code == 200, r.text
    created = r.json()
    assert created["key"].startswith("cak_") and created["endpoint"] == "https://home.example.org/mcp"
    ov = client.get("/api/claraos/agent-keys", headers=browser()).json()
    assert ov["enabled"] is True and [k["id"] for k in ov["keys"]] == [created["id"]]
    assert "key" not in ov["keys"][0] and "key_hash" not in ov["keys"][0]
    assert client.delete(f"/api/claraos/agent-keys/{created['id']}", headers=browser("ben")).status_code == 404
    assert client.delete(f"/api/claraos/agent-keys/{created['id']}", headers=browser()).status_code == 200
    assert client.get("/api/claraos/agent-keys", headers=browser()).json()["keys"] == []


def test_router_refuses_machines(client):
    # The assistant (service token) must never mint itself a key — not even "as" a user.
    h = {**JSON, "X-ClaraOS-Service-Token": "svc", "X-Claraos-User": "anna"}
    assert client.post("/api/claraos/agent-keys", json={"name": "x"}, headers=h).status_code == 403
    assert client.get("/api/claraos/agent-keys", headers=h).status_code == 403


def test_router_requires_proxy_and_json(client):
    assert client.get("/api/claraos/agent-keys", headers={**JSON, "X-Authentik-Username": "anna"}).status_code == 401
    assert client.get("/api/claraos/agent-keys",
                      headers={"X-ClaraOS-Proxy-Secret": "proxy", "X-Authentik-Username": "anna"}).status_code == 415


def test_router_refuses_create_when_endpoint_off(client, monkeypatch):
    import betriebsprofil
    monkeypatch.setattr(betriebsprofil, "MCP_ENABLED", False)
    assert client.post("/api/claraos/agent-keys", json={"name": "x"}, headers=browser()).status_code == 409
    assert client.get("/api/claraos/agent-keys", headers=browser()).json()["enabled"] is False


def test_router_bad_id(client):
    assert client.delete("/api/claraos/agent-keys/not-a-uuid", headers=browser()).status_code == 400
