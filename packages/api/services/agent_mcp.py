"""MCP endpoint: lets any MCP-capable agent use a cell's tools.

The tools are the same ones Clara uses — each module declares them in its
clara-tools.yaml (see `services.clara_tools_registry`). This module only adds a
second door to them:

* Transport: MCP Streamable HTTP, stateless, JSON responses, at `/mcp` (core
  toolset), `/mcp/all` and `/mcp/<module>`.
* Identity: a bearer token checked by a `TokenVerifier`. The verified token names
  the user and its scopes (`read`, optionally `write`). Nothing the agent sends in
  a tool argument or header can change who the call runs as.
* Execution: every call goes through the existing tool proxy
  (`POST /api/claraos/tools/call/{module}/{tool}`) on loopback, with the service
  token and the token's user — so schema validation, per-user app credentials and
  the error envelope are exactly the ones Clara gets.
* Exposure: each tool is `read`, `write` or `never` (see `exposure`). `never`
  tools are not listed and not callable; `write` tools need the `write` scope.

Off unless `CLARAOS_MCP=on` (`betriebsprofil.MCP_ENABLED`).
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Iterable

import httpx
import mcp_types as types
from mcp.server.auth.middleware.auth_context import AuthContextMiddleware
from mcp.server.auth.middleware.bearer_auth import (
    AuthenticatedUser,
    BearerAuthBackend,
    RequireAuthMiddleware,
)
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.lowlevel.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPASGIApp, StreamableHTTPSessionManager
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.routing import Route
from starlette.types import ASGIApp

from auth import service_headers
from services.clara_tools_registry import registry


async def record_call(user: str, key_id: str | None, tool: str, ok: bool) -> None:
    """Log a call for the user's overview (services.agent_keys; tests replace this)."""
    from services import agent_keys  # local: keeps this module importable without a DB
    await agent_keys.record_call(user, key_id, tool, ok)

logger = logging.getLogger(__name__)

# Loopback base of this API; the tool proxy lives under it.
SELF_URL = os.environ.get("CLARAOS_SELF_URL", "http://localhost:8090").rstrip("/")
_CALL_TIMEOUT = float(os.environ.get("CLARAOS_MCP_CALL_TIMEOUT", "60"))
_MAX_TEXT = 60_000

SCOPE_READ = "read"
SCOPE_WRITE = "write"

# Modules an outside agent never sees: passwords, the user's live browser screen,
# the assistant's own memory of preferences, pure UI actions, banking.
# The installation adds its own (e.g. sensitive modules) via heim_werte — read
# whenever the file exists, independent of the profile: a deny list stays strict.
try:
    from heim_werte import HEIM_NEVER_MODULES as _HEIM_NEVER_MODULES  # optional, deployment-specific
except ImportError:
    _HEIM_NEVER_MODULES = frozenset()
NEVER_MODULES = frozenset({"vault", "browser", "lernen", "dienste"}) | _HEIM_NEVER_MODULES

# Modules an outside agent may only read (their writes act through the
# cell's own brain, e.g. scheduling routines).
READ_ONLY_MODULES = frozenset({"routinen"})

# Single tools held back until a confirmation step exists (MCP elicitation):
# sending mail on the user's behalf and deleting things.
NEVER_TOOLS = frozenset({
    ("mail", "send_mail"),
    ("mail", "delete_message"),
    ("nc-pim", "delete_event"),
    ("routinen", "delete_routine"),
})

_READ_PREFIXES = ("list_", "get_", "search_", "count_", "read_", "recent_", "query_", "my_")
_READ_NAMES = frozenset({"search", "uebersicht", "photo_statistics", "account_statuses"})

# The default toolset at `/mcp`: the everyday office work across apps.
CORE_MODULES = ("planner", "mail", "post", "nc-pim", "office", "paperless")


def exposure(module: str, tool: dict[str, Any]) -> str:
    """`read`, `write` or `never` for one tool.

    An explicit `mcp:` field in clara-tools.yaml wins, except that it can never
    open a module or tool that is held back above. Tools that need the owner's
    approval in the cell (`freigabe: true`) are never exposed: that approval runs
    through the brain's chat turns, which an outside agent does not have.
    """
    name = str(tool.get("name") or "")
    if module in NEVER_MODULES or (module, name) in NEVER_TOOLS or tool.get("freigabe"):
        return "never"
    declared = str(tool.get("mcp") or "").strip().lower()
    if declared in ("read", "write", "never"):
        derived = declared
    elif (tool.get("method") or "POST").upper() == "GET":
        derived = "read"
    elif name.startswith(_READ_PREFIXES) or name in _READ_NAMES:
        derived = "read"
    else:
        derived = "write"
    if module in READ_ONLY_MODULES and derived == "write":
        return "never"
    return derived


def mcp_name(module: str, tool: str) -> str:
    """Tool name as an agent sees it: `<module>_<tool>`, hyphens folded."""
    return f"{module}_{tool}".replace("-", "_")


def _modules_for(toolset: str) -> Iterable[str] | None:
    """Module names for a toolset path segment; None = all modules."""
    if toolset in ("", "core"):
        return CORE_MODULES
    if toolset == "all":
        return None
    return (toolset,)


def catalog(toolset: str, scopes: Iterable[str]) -> dict[str, tuple[str, dict[str, Any], str]]:
    """Tools visible for a toolset and scopes: mcp name -> (module, tool spec, exposure)."""
    allowed = set(scopes)
    wanted = _modules_for(toolset)
    out: dict[str, tuple[str, dict[str, Any], str]] = {}
    for spec in registry.list_tools():
        module = spec.get("module") or ""
        if wanted is not None and module not in wanted:
            continue
        level = exposure(module, spec)
        if level == "never" or level not in allowed:
            continue
        name = mcp_name(module, str(spec.get("name") or ""))
        out[name] = (module, spec, level)
    return out


def _input_schema(spec: dict[str, Any]) -> dict[str, Any]:
    schema = dict(spec.get("schema") or {})
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    return schema


def _as_tool(name: str, module: str, spec: dict[str, Any], level: str) -> types.Tool:
    return types.Tool(
        name=name,
        description=str(spec.get("description") or spec.get("name") or name).strip(),
        input_schema=_input_schema(spec),
        annotations=types.ToolAnnotations(
            title=f"{module}: {spec.get('name')}",
            read_only_hint=level == "read",
            destructive_hint=False if level == "read" else None,
        ),
    )


def _caller(ctx: Any) -> tuple[str, list[str], str, str | None]:
    """User, scopes, toolset and key id of the HTTP request behind an MCP message."""
    request = getattr(ctx, "request", None)
    if request is None:
        raise PermissionError("no HTTP request")
    user = request.scope.get("user")
    if not isinstance(user, AuthenticatedUser):
        raise PermissionError("not authenticated")
    token: AccessToken = user.access_token
    toolset = str(request.path_params.get("toolset") or "")
    key_id = (token.claims or {}).get("key_id")
    return token.client_id, list(token.scopes), toolset, key_id


def _client() -> httpx.AsyncClient:
    """HTTP client for the loopback call (tests swap it for an in-process transport)."""
    return httpx.AsyncClient(timeout=_CALL_TIMEOUT)


def _text_result(payload: Any, *, error: bool) -> types.CallToolResult:
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, default=str)
    if len(text) > _MAX_TEXT:
        text = text[:_MAX_TEXT] + "\n… (truncated)"
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)], is_error=error)


async def _forward(module: str, tool: str, arguments: dict[str, Any], user: str) -> types.CallToolResult:
    """Run one tool through the cell's tool proxy as `user`."""
    # No actor header: in some routers the actor `clara` unlocks the assistant's own,
    # wider app access. An outside agent acts as the user and nothing more.
    headers = service_headers(user)
    url = f"{SELF_URL}/api/claraos/tools/call/{module}/{tool}"
    try:
        async with _client() as client:
            r = await client.post(url, json=arguments, headers=headers)
    except httpx.HTTPError as e:
        logger.warning("[mcp] %s/%s for %s: proxy unreachable: %s", module, tool, user, e)
        return _text_result({"ok": False, "error": "tool proxy unreachable"}, error=True)
    try:
        body: Any = r.json()
    except ValueError:
        body = r.text
    if r.status_code >= 400:
        detail = body.get("detail", body) if isinstance(body, dict) else body
        return _text_result({"ok": False, "status": r.status_code, "error": detail}, error=True)
    failed = isinstance(body, dict) and body.get("ok") is False
    return _text_result(body, error=failed)


async def _on_list_tools(ctx: Any, _params: types.PaginatedRequestParams | None) -> types.ListToolsResult:
    _user, scopes, toolset, _key = _caller(ctx)
    tools = [_as_tool(n, m, s, lvl) for n, (m, s, lvl) in sorted(catalog(toolset, scopes).items())]
    return types.ListToolsResult(tools=tools)


async def _on_call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
    user, scopes, toolset, key_id = _caller(ctx)
    entry = catalog(toolset, scopes).get(params.name)
    if entry is None:
        # Same answer for "does not exist", "held back" and "needs write scope":
        # an agent learns nothing about tools it may not use.
        logger.info("[mcp] %s refused %r (toolset=%r scopes=%s)", user, params.name, toolset, scopes)
        await record_call(user, key_id, params.name[:120], False)
        return _text_result({"ok": False, "error": f"unknown tool {params.name!r}"}, error=True)
    module, spec, level = entry
    logger.info("[mcp] call %s/%s by %s (%s)", module, spec.get("name"), user, level)
    result = await _forward(module, str(spec.get("name")), dict(params.arguments or {}), user)
    await record_call(user, key_id, params.name, not result.is_error)
    return result


class RejectAllVerifier:
    """Fail-closed default when no verifier is given: every token is refused."""

    async def verify_token(self, token: str) -> AccessToken | None:  # noqa: ARG002
        return None


server: Server = Server(
    "claraos",
    instructions=(
        f"Tools of a {PRODUCT_NAME} workspace (mail, planner, calendar, contacts, documents, "
        "knowledge). Every call runs as the user who owns the access key. Look things "
        "up (list/search) before changing them; never guess ids."
    ),
    on_list_tools=_on_list_tools,
    on_call_tool=_on_call_tool,
)

_manager: StreamableHTTPSessionManager | None = None


def _new_manager() -> StreamableHTTPSessionManager:
    # Stateless + JSON: tools only, no server-initiated messages, nothing to resume.
    # DNS-rebinding protection is the reverse proxy's job (fixed host names).
    return StreamableHTTPSessionManager(app=server, stateless=True, json_response=True)


def asgi_app(verifier: TokenVerifier | None = None) -> ASGIApp:
    """The MCP endpoint behind bearer authentication (one per process)."""
    global _manager
    _manager = _new_manager()
    inner: ASGIApp = RequireAuthMiddleware(StreamableHTTPASGIApp(_manager), [SCOPE_READ], None)
    inner = AuthContextMiddleware(inner)
    return AuthenticationMiddleware(inner, backend=BearerAuthBackend(verifier or RejectAllVerifier()))


def routes(verifier: TokenVerifier | None = None, prefix: str = "/mcp") -> list[Route]:
    """Routes for `prefix` (core toolset) and `prefix/{toolset}`."""
    app = asgi_app(verifier)
    return [Route(prefix, endpoint=app), Route(prefix + "/{toolset}", endpoint=app)]


@asynccontextmanager
async def running() -> AsyncIterator[None]:
    """Run the session manager for the app's lifetime (call from the lifespan)."""
    if _manager is None:
        yield
        return
    async with _manager.run():
        yield
