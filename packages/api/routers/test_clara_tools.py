"""Tests for the clara-tools call-proxy + openapi endpoints."""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import clara_tools as ct_router
from services.clara_tools_registry import registry


@pytest.fixture
def app(monkeypatch, tmp_path):
    monkeypatch.setenv("CLARA_TOOLS_DIR", str(tmp_path))
    # Seed the registry
    (tmp_path / "websearch.yaml").write_text("""
tools:
  - name: websearch_search
    description: Web search
    endpoint: http://websearch-upstream/search
    auth: none
    schema:
      type: object
      properties:
        q: {type: string}
      required: [q]
  - name: oidc_action
    description: Needs user identity
    endpoint: http://app/api/action
    auth: oidc_token
    schema:
      type: object
      properties:
        what: {type: string}
ui_hooks: []
""")
    registry.reload()
    a = FastAPI()
    a.include_router(ct_router.router)
    return a


@pytest.fixture
def client(app):
    return TestClient(app)


def test_openapi_lists_tools(client):
    r = client.get("/api/claraos/tools/openapi.json")
    assert r.status_code == 200
    spec = r.json()
    assert "/call/websearch/websearch_search" in spec["paths"]
    assert "/call/websearch/oidc_action" in spec["paths"]


def test_call_unknown_module_404(client):
    r = client.post("/api/claraos/tools/call/nope/x", json={})
    assert r.status_code == 404


def test_call_unknown_tool_404(client):
    r = client.post("/api/claraos/tools/call/websearch/nope", json={})
    assert r.status_code == 404


def test_call_invalid_payload_422(client):
    # Missing required `q`
    r = client.post("/api/claraos/tools/call/websearch/websearch_search", json={})
    assert r.status_code == 422
    body = r.json()
    assert body["detail"]["error"] == "tool_payload_invalid"


@respx.mock
def test_call_proxies_to_upstream(client):
    respx.post("http://websearch-upstream/search").mock(
        return_value=httpx.Response(200, json={"results": [{"title": "x"}]})
    )
    r = client.post(
        "/api/claraos/tools/call/websearch/websearch_search",
        json={"q": "test"},
    )
    assert r.status_code == 200
    assert r.json() == {"results": [{"title": "x"}]}


@respx.mock
def test_call_forwards_authentik_headers_for_oidc_tools(client):
    capture = respx.post("http://app/api/action").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    r = client.post(
        "/api/claraos/tools/call/websearch/oidc_action",
        json={"what": "delete"},
        headers={"X-Authentik-Username": "alice", "X-Authentik-Groups": "admin,users"},
    )
    assert r.status_code == 200
    fwd = capture.calls[0].request.headers
    assert fwd["x-authentik-username"] == "alice"
    assert fwd["x-authentik-groups"] == "admin,users"


@respx.mock
def test_call_does_not_forward_authentik_headers_for_none_auth(client):
    capture = respx.post("http://websearch-upstream/search").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    r = client.post(
        "/api/claraos/tools/call/websearch/websearch_search",
        json={"q": "x"},
        headers={"X-Authentik-Username": "alice"},
    )
    assert r.status_code == 200
    fwd = capture.calls[0].request.headers
    assert "x-authentik-username" not in fwd


@respx.mock
def test_call_upstream_unreachable_502(client):
    respx.post("http://websearch-upstream/search").mock(
        side_effect=httpx.ConnectError("connect failed")
    )
    r = client.post(
        "/api/claraos/tools/call/websearch/websearch_search",
        json={"q": "x"},
    )
    assert r.status_code == 502
    assert "unreachable" in r.json()["detail"]


@respx.mock
def test_call_upstream_non_json_passes_through_as_meta(client):
    respx.post("http://websearch-upstream/search").mock(
        return_value=httpx.Response(200, content=b"<html>nope</html>",
                                    headers={"content-type": "text/html"})
    )
    r = client.post(
        "/api/claraos/tools/call/websearch/websearch_search",
        json={"q": "x"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["_module"] == "websearch"
    assert body["_tool"] == "websearch_search"
    assert "<html>" in body["_body"]
