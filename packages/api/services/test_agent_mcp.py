"""Tests for the MCP endpoint (services/agent_mcp.py).

The endpoint is driven over real MCP JSON-RPC (Streamable HTTP). The loopback tool
proxy is replaced by a recorder, so these tests cover what the MCP layer decides:
who the call runs as, which tools exist for which key, and how results come back.
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from mcp.server.auth.provider import AccessToken

from services import agent_mcp
from services.clara_tools_registry import registry

TOOLS = {
    "planner": """
tools:
  - name: list_tasks
    description: List tasks
    endpoint: http://localhost:8090/api/claraos/planner/clara/list_tasks
    schema: {type: object, properties: {project: {type: string}}}
  - name: create_task
    description: Create a task
    endpoint: http://localhost:8090/api/claraos/planner/clara/create_task
    schema: {type: object, properties: {title: {type: string}}, required: [title]}
""",
    "mail": """
tools:
  - name: list_messages
    description: List mail
    endpoint: http://localhost:8090/api/claraos/mail/list_messages
  - name: send_mail
    description: Send mail
    endpoint: http://localhost:8090/api/claraos/mail/send_mail
  - name: create_draft
    description: Draft mail
    endpoint: http://localhost:8090/api/claraos/mail/create_draft
""",
    "vault": """
tools:
  - name: list_credentials
    method: GET
    description: Passwords
    endpoint: http://localhost:8090/api/claraos/vault/tools/credentials
""",
    "mastodon": """
tools:
  - name: post_status
    description: Post publicly
    freigabe: true
    endpoint: http://mastodon-web:3000/api/v1/statuses
  - name: get_timeline
    method: GET
    description: Timeline
    endpoint: http://mastodon-web:3000/api/v1/timelines/home
""",
    "routinen": """
tools:
  - name: list_routines
    method: GET
    endpoint: http://localhost:8090/api/claraos/routinen
  - name: create_routine
    endpoint: http://localhost:8090/api/claraos/routinen
""",
}

KEYS = {
    "key-anna-read": AccessToken(token="key-anna-read", client_id="anna", scopes=["read"],
                                 claims={"key_id": "k-anna-read"}),
    "key-anna-write": AccessToken(token="key-anna-write", client_id="anna", scopes=["read", "write"]),
    "key-ben-read": AccessToken(token="key-ben-read", client_id="ben", scopes=["read"]),
}


class FakeVerifier:
    async def verify_token(self, token: str) -> AccessToken | None:
        return KEYS.get(token)


calls_log: list = []


@pytest.fixture
def proxy_calls(monkeypatch):
    """Stand-in for the loopback tool proxy; records what the MCP layer sent."""
    calls: list[dict] = []
    proxy = FastAPI()

    @proxy.post("/api/claraos/tools/call/{module}/{tool}")
    async def call(module: str, tool: str, request: Request):
        body = await request.json()
        calls.append({"module": module, "tool": tool, "body": body,
                      "headers": {k.lower(): v for k, v in request.headers.items()}})
        if body.get("fail"):
            return {"ok": False, "error": "upstream said no"}
        if body.get("http_error"):
            from fastapi import HTTPException
            raise HTTPException(status_code=409, detail="connect your account first")
        return {"ok": True, "echo": body}

    monkeypatch.setattr(agent_mcp, "_client",
                        lambda: httpx.AsyncClient(transport=httpx.ASGITransport(app=proxy),
                                                  base_url="http://proxy"))
    monkeypatch.setattr(agent_mcp, "SELF_URL", "http://proxy")
    logged: list[tuple] = []

    async def record(user, key_id, tool, ok):
        logged.append((user, key_id, tool, ok))
    monkeypatch.setattr(agent_mcp, "record_call", record)
    calls_log.clear()
    calls_log.extend([logged])
    monkeypatch.setenv("CLARAOS_SERVICE_TOKEN", "svc-test")
    import auth
    monkeypatch.setattr(auth, "SERVICE_TOKEN", "svc-test")
    return calls


@pytest.fixture
def client(monkeypatch, tmp_path, proxy_calls):
    monkeypatch.setenv("CLARA_TOOLS_DIR", str(tmp_path))
    for name, text in TOOLS.items():
        (tmp_path / f"{name}.yaml").write_text(text)
    registry.reload()

    @asynccontextmanager
    async def lifespan(_app):
        async with agent_mcp.running():
            yield

    app = FastAPI(lifespan=lifespan)
    app.router.routes.extend(agent_mcp.routes(FakeVerifier()))
    with TestClient(app) as c:
        yield c


def rpc(client, method, params=None, key="key-anna-read", path="/mcp", rid=1):
    headers = {"Accept": "application/json, text/event-stream",
               "Content-Type": "application/json",
               "MCP-Protocol-Version": "2025-06-18"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    msg = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
    return client.post(path, headers=headers, content=json.dumps(msg))


def tool_names(client, **kw):
    r = rpc(client, "tools/list", **kw)
    assert r.status_code == 200, r.text
    return {t["name"] for t in r.json()["result"]["tools"]}


def call(client, name, arguments, **kw):
    r = rpc(client, "tools/call", {"name": name, "arguments": arguments}, **kw)
    assert r.status_code == 200, r.text
    return r.json()["result"]


# ── authentication ──────────────────────────────────────────────────────

def test_without_key_401(client):
    r = rpc(client, "tools/list", key=None)
    assert r.status_code == 401


def test_unknown_key_401(client):
    r = rpc(client, "tools/list", key="made-up")
    assert r.status_code == 401


def test_initialize(client):
    r = rpc(client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                   "clientInfo": {"name": "t", "version": "0"}})
    assert r.status_code == 200, r.text
    assert r.json()["result"]["serverInfo"]["name"] == "claraos"


# ── which tools exist ───────────────────────────────────────────────────

def test_core_read_key_sees_only_reading_tools(client):
    assert tool_names(client) == {"planner_list_tasks", "mail_list_messages"}


def test_core_write_key_adds_writes_but_never_send_mail(client):
    names = tool_names(client, key="key-anna-write")
    assert {"planner_create_task", "mail_create_draft"} <= names
    assert "mail_send_mail" not in names


def test_all_toolset_never_shows_vault_or_approval_tools(client):
    names = tool_names(client, key="key-anna-write", path="/mcp/all")
    assert "vault_list_credentials" not in names
    assert "mastodon_post_status" not in names          # needs the owner's approval
    assert "mastodon_get_timeline" in names
    assert "routinen_list_routines" in names
    assert "routinen_create_routine" not in names       # read-only module


def test_module_toolset(client):
    assert tool_names(client, path="/mcp/planner") == {"planner_list_tasks"}
    assert tool_names(client, path="/mcp/vault") == set()


# ── calls ───────────────────────────────────────────────────────────────

def test_call_runs_as_key_owner_through_proxy(client, proxy_calls):
    res = call(client, "planner_list_tasks", {"project": "Home"})
    assert res.get("isError") is not True
    assert json.loads(res["content"][0]["text"]) == {"ok": True, "echo": {"project": "Home"}}
    sent = proxy_calls[-1]
    assert (sent["module"], sent["tool"]) == ("planner", "list_tasks")
    assert sent["headers"]["x-claraos-user"] == "anna"
    assert sent["headers"]["x-claraos-service-token"] == "svc-test"
    assert "x-claraos-actor" not in sent["headers"]


def test_identity_cannot_come_from_arguments(client, proxy_calls):
    call(client, "planner_list_tasks", {"project": "x", "user": "ben"}, key="key-ben-read")
    assert proxy_calls[-1]["headers"]["x-claraos-user"] == "ben"
    call(client, "planner_list_tasks", {"X-Claraos-User": "ben"})
    assert proxy_calls[-1]["headers"]["x-claraos-user"] == "anna"


def test_write_with_read_key_refused_without_proxy_call(client, proxy_calls):
    res = call(client, "planner_create_task", {"title": "x"})
    assert res["isError"] is True
    assert proxy_calls == []


def test_never_tools_refused_even_with_write_key(client, proxy_calls):
    for name in ("mail_send_mail", "vault_list_credentials"):
        res = call(client, name, {}, key="key-anna-write", path="/mcp/all")
        assert res["isError"] is True
    assert proxy_calls == []


def test_write_with_write_key(client, proxy_calls):
    res = call(client, "planner_create_task", {"title": "Buy milk"}, key="key-anna-write")
    assert res.get("isError") is not True
    assert proxy_calls[-1]["body"] == {"title": "Buy milk"}


def test_tool_failure_is_error(client):
    res = call(client, "planner_list_tasks", {"fail": True})
    assert res["isError"] is True


def test_http_error_is_error_with_detail(client):
    res = call(client, "planner_list_tasks", {"http_error": True})
    assert res["isError"] is True
    body = json.loads(res["content"][0]["text"])
    assert body["status"] == 409 and "connect" in body["error"]


# ── policy ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("module,tool,expected", [
    ("planner", {"name": "list_tasks"}, "read"),
    ("planner", {"name": "uebersicht"}, "read"),
    ("planner", {"name": "create_task"}, "write"),
    ("planner", {"name": "whatever", "method": "GET"}, "read"),
    ("knowledge", {"name": "run_five_why"}, "write"),          # unknown => write
    ("planner", {"name": "list_x", "mcp": "write"}, "write"),  # explicit wins
    ("vault", {"name": "list_credentials", "mcp": "read"}, "never"),
    ("mail", {"name": "send_mail", "mcp": "write"}, "never"),
    ("mastodon", {"name": "post_status", "freigabe": True}, "never"),
    ("routinen", {"name": "run_routine_now"}, "never"),
    ("action", {"name": "read_screen", "mcp": "read"}, "never"),  # the user's live screen
])
def test_exposure(module, tool, expected):
    assert agent_mcp.exposure(module, tool) == expected


def test_default_verifier_rejects_everything():
    import asyncio
    assert asyncio.run(agent_mcp.RejectAllVerifier().verify_token("anything")) is None


# ── call log ────────────────────────────────────────────────────────────

def test_calls_are_logged_with_key_and_outcome(client):
    call(client, "planner_list_tasks", {})
    call(client, "planner_list_tasks", {"fail": True})
    call(client, "planner_create_task", {"title": "x"})            # refused: read key
    assert calls_log[0] == [
        ("anna", "k-anna-read", "planner_list_tasks", True),
        ("anna", "k-anna-read", "planner_list_tasks", False),
        ("anna", "k-anna-read", "planner_create_task", False),
    ]
