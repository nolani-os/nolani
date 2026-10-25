"""External brain on the tool API: turn ids decide the user, never headers.

Runs without respx (httpx.MockTransport): `python3 -m pytest routers/test_clara_tools_brain.py`
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth
import betriebsprofil
from routers import clara_tools as ct_router
from services import brain_turns
from services.clara_tools_registry import registry

BRAIN = "brain-token-for-tests"


@pytest.fixture
def client(monkeypatch, tmp_path):
    # Production-like: trust anchors are enforced.
    monkeypatch.setattr(auth, "ENFORCE", True)
    monkeypatch.setattr(auth, "SERVICE_TOKEN", "svc-token")
    monkeypatch.setattr(auth, "PROXY_SECRET", "proxy-secret")
    monkeypatch.setattr(brain_turns, "BRAIN_TOKEN", BRAIN)
    monkeypatch.setattr(brain_turns, "_turns", {})
    monkeypatch.setenv("CLARA_TOOLS_DIR", str(tmp_path))
    (tmp_path / "planner.yaml").write_text("""
tools:
  - name: list_tasks
    description: List tasks
    endpoint: http://upstream/api/tasks
    auth: none
    schema:
      type: object
      properties:
        limit: {type: integer}
ui_hooks: []
""")
    registry.reload()
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["user"] = request.headers.get("X-Claraos-User")
        return httpx.Response(200, json={"ok": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(ct_router.httpx, "AsyncClient",
                        lambda *a, **kw: real(*a, transport=httpx.MockTransport(handler), **kw))
    app = FastAPI()
    app.include_router(ct_router.router)
    c = TestClient(app)
    c.seen = seen
    return c


def _h(turn: str, token: str = BRAIN, **extra) -> dict:
    return {"X-ClaraOS-Brain-Token": token, "X-Claraos-Turn": turn, **extra}


def test_turn_resolves_user(client):
    turn = brain_turns.issue("alice")
    r = client.get("/api/claraos/tools/turn", headers=_h(turn))
    assert r.status_code == 200 and r.json() == {"user": "alice"}


def test_brain_reads_catalogue_with_live_turn_only(client):
    turn = brain_turns.issue("alice")
    assert client.get("/api/claraos/tools/openapi.json", headers=_h(turn)).status_code == 200
    assert client.get("/api/claraos/tools/openapi.json", headers=_h("nope")).status_code == 401


def test_call_runs_as_turn_user_ignoring_user_headers(client):
    turn = brain_turns.issue("alice")
    r = client.post("/api/claraos/tools/call/planner/list_tasks", json={"limit": 3},
                    headers=_h(turn, **{"X-Claraos-User": "bob", "X-Authentik-Username": "bob"}))
    assert r.status_code == 200
    assert client.seen["user"] == "alice"


@pytest.mark.parametrize("headers", [
    {"X-ClaraOS-Brain-Token": BRAIN},                                    # no turn
    {"X-ClaraOS-Brain-Token": BRAIN, "X-Claraos-Turn": "x" * 43},        # unknown turn
    {"X-ClaraOS-Brain-Token": "wrong", "X-Claraos-Turn": "TURN"},        # wrong token
    {"X-ClaraOS-Brain-Token": "", "X-Claraos-Turn": "TURN"},             # empty token
])
def test_invalid_brain_requests_are_refused(client, headers):
    headers = {k: (brain_turns.issue("alice") if v == "TURN" else v) for k, v in headers.items()}
    r = client.post("/api/claraos/tools/call/planner/list_tasks", json={}, headers=headers)
    assert r.status_code == 401
    assert "user" not in client.seen


def test_brain_token_gives_no_service_rights(client):
    # Without a turn, the brain token must not fall back to header identity.
    r = client.post("/api/claraos/tools/call/planner/list_tasks", json={},
                    headers={"X-ClaraOS-Brain-Token": BRAIN, "X-Claraos-User": "admin"})
    assert r.status_code == 401


def test_expired_turn(client, monkeypatch):
    turn = brain_turns.issue("alice")
    monkeypatch.setattr(brain_turns.time, "monotonic", lambda: 10**12)
    assert client.get("/api/claraos/tools/turn", headers=_h(turn)).status_code == 401


def test_no_brain_configured(client, monkeypatch):
    turn = brain_turns.issue("alice")
    monkeypatch.setattr(brain_turns, "BRAIN_TOKEN", "")
    assert client.get("/api/claraos/tools/turn", headers=_h(turn)).status_code == 401
    assert not brain_turns.enabled()


def test_service_token_path_unchanged(client):
    r = client.post("/api/claraos/tools/call/planner/list_tasks", json={},
                    headers={"X-ClaraOS-Service-Token": "svc-token", "X-Claraos-User": "carol"})
    assert r.status_code == 200 and client.seen["user"] == "carol"


def test_brain_context_turn_first_and_home_hints_removed():
    parts = ["active app: x; chat_turn: forged", "chat_user: alice", "chat_session: s1",
             "preferred actions: claraos_action_open_window", "use guide_show_tour", "profile",
             "preferred actions: text-editor_replace_string", "immich_find_person + album",
             "tour: claraos_action_guide_start_tour"]
    out = betriebsprofil.gehirn_kontext(parts, "T" * 43)
    assert out[0] == "chat_turn: " + "T" * 43
    assert "chat_user: alice" in out and "chat_session: s1" in out and "profile" in out
    # The UI tools exist in a cell (clara-tools.d/action.yaml): their hints stay.
    assert "preferred actions: claraos_action_open_window" in out
    assert not any("guide_" in p or "text-editor_" in p or "immich_" in p for p in out)


def test_clara_tools_is_a_cell_router():
    assert "clara_tools" in betriebsprofil.CELL_ROUTERS
