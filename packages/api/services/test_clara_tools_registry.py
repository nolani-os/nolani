"""Unit tests for the clara-tools drop-in registry."""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
import os
from pathlib import Path

import pytest

from services.clara_tools_registry import ToolsRegistry


@pytest.fixture
def tools_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CLARA_TOOLS_DIR", str(tmp_path))
    return tmp_path


def test_reload_empty_dir(tools_dir):
    r = ToolsRegistry()
    summary = r.reload()
    assert summary["modules"] == []
    assert summary["tools_total"] == 0


def test_reload_loads_valid_yaml(tools_dir):
    (tools_dir / "websearch.yaml").write_text("""
tools:
  - name: websearch_search
    description: Search the web
    endpoint: http://websearch:8080/search
    auth: none
    schema:
      type: object
ui_hooks:
  - location: websearch.results
    label: Summarize
    handler_tool: clara_summarize
    context: [query]
""")
    r = ToolsRegistry()
    r.reload()
    assert r.summary()["tools_total"] == 1
    assert r.summary()["ui_hooks_total"] == 1
    tools = r.list_tools()
    assert tools[0]["name"] == "websearch_search"
    assert tools[0]["module"] == "websearch"


def test_reload_ignores_malformed_files(tools_dir, caplog):
    (tools_dir / "good.yaml").write_text("tools:\n  - {name: ok, description: x, endpoint: y, schema: {}}\nui_hooks: []\n")
    (tools_dir / "bad-syntax.yaml").write_text("tools: [\n  - garbage\n")  # invalid yaml
    (tools_dir / "bad-shape.yaml").write_text("tools: 'should be a list, not a string'\n")
    r = ToolsRegistry()
    r.reload()
    # only `good` loaded
    assert r.summary()["modules"] == ["good"]
    assert r.summary()["tools_total"] == 1


def test_reload_replaces_state(tools_dir):
    (tools_dir / "x.yaml").write_text("tools: [{name: a, description: x, endpoint: y, schema: {}}]\nui_hooks: []\n")
    r = ToolsRegistry()
    r.reload()
    assert "x" in r.summary()["modules"]
    # Remove file + reload
    (tools_dir / "x.yaml").unlink()
    r.reload()
    assert r.summary()["modules"] == []


def test_get_module(tools_dir):
    (tools_dir / "y.yaml").write_text("tools: [{name: t1, description: x, endpoint: y, schema: {}}]\nui_hooks: []\n")
    r = ToolsRegistry()
    r.reload()
    assert r.get_module("y") is not None
    assert r.get_module("nope") is None


def test_openapi_spec_empty_registry(tools_dir):
    r = ToolsRegistry()
    spec = r.to_openapi_spec()
    assert spec["openapi"] == "3.1.0"
    assert spec["info"]["title"] == f"{PRODUCT_NAME} Module Tools"
    assert spec["paths"] == {}
    assert spec["components"]["schemas"] == {}


def test_openapi_spec_with_tool(tools_dir):
    (tools_dir / "websearch.yaml").write_text("""
tools:
  - name: websearch_search
    description: |
      Web-search via Websearch.
      Use for current facts.
    endpoint: http://websearch:8080/search
    auth: none
    schema:
      type: object
      properties:
        q: {type: string}
      required: [q]
ui_hooks: []
""")
    r = ToolsRegistry()
    r.reload()
    spec = r.to_openapi_spec()

    # Tool exposed as POST /call/websearch/websearch_search
    path_key = "/call/websearch/websearch_search"
    assert path_key in spec["paths"]
    op = spec["paths"][path_key]["post"]
    assert op["operationId"] == "call_websearch_websearch_search"
    assert op["tags"] == ["websearch"]
    # First line of description becomes summary, full goes to description
    assert op["summary"].startswith("Web-search via Websearch")
    # Custom x- extensions carry auth + upstream for the proxy
    assert op["x-clara-tool-auth"] == "none"
    assert op["x-clara-tool-upstream"] == "http://websearch:8080/search"
    # Schema is inlined in components, referenced from requestBody
    schema_id = "websearch_websearch_search_request"
    assert schema_id in spec["components"]["schemas"]
    assert spec["components"]["schemas"][schema_id]["required"] == ["q"]
    assert op["requestBody"]["content"]["application/json"]["schema"]["$ref"] == \
        f"#/components/schemas/{schema_id}"


def test_openapi_spec_multiple_modules(tools_dir):
    (tools_dir / "mod1.yaml").write_text(
        "tools: [{name: t1, description: x, endpoint: y, auth: oidc_token, schema: {type: object}}]\nui_hooks: []\n"
    )
    (tools_dir / "mod2.yaml").write_text(
        "tools: [{name: t2, description: y, endpoint: z, auth: api_key, schema: {type: object}}]\nui_hooks: []\n"
    )
    r = ToolsRegistry()
    r.reload()
    spec = r.to_openapi_spec()
    assert "/call/mod1/t1" in spec["paths"]
    assert "/call/mod2/t2" in spec["paths"]
    # Auth type carries through to x-extension
    assert spec["paths"]["/call/mod1/t1"]["post"]["x-clara-tool-auth"] == "oidc_token"
    assert spec["paths"]["/call/mod2/t2"]["post"]["x-clara-tool-auth"] == "api_key"


def test_ui_hooks_aggregation(tools_dir):
    (tools_dir / "mod1.yaml").write_text("tools: []\nui_hooks: [{location: a.b, label: x, handler_tool: y, context: []}]\n")
    (tools_dir / "mod2.yaml").write_text("tools: []\nui_hooks: [{location: c.d, label: z, handler_tool: w, context: []}]\n")
    r = ToolsRegistry()
    r.reload()
    hooks = r.list_ui_hooks()
    assert len(hooks) == 2
    assert {h["module"] for h in hooks} == {"mod1", "mod2"}
