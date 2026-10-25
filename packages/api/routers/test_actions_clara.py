"""Assistant UI tools (routers/actions.py, /clara/*): always the caller's own screen.

`python3 -m pytest routers/test_actions_clara.py`
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth
from routers import actions


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(auth, "ENFORCE", True)
    monkeypatch.setattr(auth, "SERVICE_TOKEN", "svc-token")
    monkeypatch.setattr(auth, "PROXY_SECRET", "proxy-secret")
    sent: list = []

    async def zustellen(target, app_id, action, args, instance_id=None, window_id=None,
                        sender=None):
        sent.append({"target": target, "app_id": app_id, "action": action, "args": args,
                     "window_id": window_id})
        return {"delivered": 1, "target_user": target, "rendered": 1, "detail": "angezeigt"}

    async def broadcast(target, payload, _from_bus=False):
        sent.append({"target": target, **payload})
        return 1

    monkeypatch.setattr(actions, "zustellen", zustellen)
    monkeypatch.setattr(actions, "_broadcast", broadcast)
    app = FastAPI()
    app.include_router(actions.router)
    c = TestClient(app)
    c.sent = sent
    return c


SVC = {"X-ClaraOS-Service-Token": "svc-token", "X-Claraos-User": "Alice"}


def test_open_window_goes_to_caller_not_to_target_user(client):
    r = client.post("/api/claraos/actions/clara/open_window",
                    json={"app_id": "planner", "target_user": "bob"}, headers=SVC)
    assert r.status_code == 200 and r.json()["ok"] is True
    assert client.sent == [{"target": "alice", "app_id": "shell", "action": "open_window",
                            "args": {"app_id": "planner",
                                     "opts": {"position": "anchor-chat-right"}},
                            "window_id": None}]


def test_without_trust_anchor_refused(client):
    r = client.post("/api/claraos/actions/clara/open_window", json={"app_id": "planner"},
                    headers={"X-Claraos-User": "alice"})
    assert r.status_code == 401 and client.sent == []


def test_viewer_hint_known_and_unknown(client):
    client.post("/api/claraos/actions/clara/open_in_viewer",
                json={"path": "/a/b.log", "viewer_hint": "text-editor"}, headers=SVC)
    r = client.post("/api/claraos/actions/clara/open_in_viewer",
                    json={"path": "/a/c.pdf", "viewer_hint": "browser"}, headers=SVC)
    assert client.sent[0]["action"] == "open_window"
    assert client.sent[0]["args"]["app_id"] == "text-editor"
    assert client.sent[1]["action"] == "open_in_viewer"
    assert client.sent[1]["args"] == {"path": "/a/c.pdf", "source": "nextcloud", "title": "c.pdf"}
    assert "hinweis" in r.json()


def test_no_browser_is_not_success(client, monkeypatch):
    async def niemand(*a, **kw):
        return {"delivered": 0, "target_user": "alice", "rendered": 0}
    monkeypatch.setattr(actions, "zustellen", niemand)
    r = client.post("/api/claraos/actions/clara/read_screen", json={}, headers=SVC)
    assert r.json()["ok"] is False and "NICHTS" in r.json()["detail"]


def test_navigate_to_accepts_params_as_json_string(client):
    r = client.post("/api/claraos/actions/clara/navigate_to",
                    json={"app_id": "paperless", "pattern_key": "document",
                          "params": '{"id": 7}'}, headers=SVC)
    assert r.status_code == 200, r.json()
    assert client.sent[-1]["target"] == "alice"
    assert "7" in client.sent[-1]["args"]["url"]


def test_unknown_tool(client):
    assert client.post("/api/claraos/actions/clara/rm_rf", json={}, headers=SVC).status_code == 404


def test_every_tool_in_the_catalogue_has_an_endpoint(client):
    katalog = yaml.safe_load(
        (Path(__file__).resolve().parents[3] / "clara-tools.d" / "action.yaml").read_text())
    for tool in katalog["tools"]:
        werkzeug = tool["endpoint"].rsplit("/", 1)[-1]
        assert werkzeug == tool["name"]
        pflicht = {k: ("x" if v.get("type") == "string" else {})
                   for k, v in tool["schema"]["properties"].items()
                   if k in tool["schema"].get("required", [])}
        r = client.post(f"/api/claraos/actions/clara/{werkzeug}", json=pflicht, headers=SVC)
        assert r.status_code != 404, werkzeug


def test_navigate_to_fills_the_pattern_placeholder_from_id(client):
    r = client.post("/api/claraos/actions/clara/navigate_to",
                    json={"app_id": "planner", "pattern_key": "task", "id": "42"}, headers=SVC)
    assert r.status_code == 200, r.json()
    assert client.sent[-1]["args"]["url"].endswith("/task/42")
