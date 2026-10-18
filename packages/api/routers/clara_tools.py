"""Clara-tools API — exposes the in-memory clara-tools.yaml registry.

Reads from `services.clara_tools_registry` which is populated at startup
(see main.py lifespan) and on demand via `POST /reload`. The
module-loader's `notify_clara_agent_reload()` hits the reload endpoint
right after install/uninstall, so the registry stays in sync without
restarting claraos-api.

Auth: same forward_auth/header pattern as the rest of claraos-api —
the reload-endpoint is also called by the loader (same host) so we
trust the in-cluster network, but if you front-proxy this externally
make sure Authentik gates it.
"""
from __future__ import annotations

from domains_generated import host as _domain_host

import json
import logging
import os
import re
import urllib.parse
from typing import Any

import httpx
import jsonschema
from fastapi import APIRouter, HTTPException, Request

from auth import require_caller
from services import brain_turns
from services.clara_tools_registry import registry

# `{param}` placeholders in tool.endpoint (path templating, see call_tool)
_ENDPOINT_PARAM_RE = re.compile(r"\{([a-zA-Z0-9_]+)\}")

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/tools", tags=["clara-tools"])

_PROXY_TIMEOUT = float(os.environ.get("CLARA_TOOLS_PROXY_TIMEOUT", "30"))


def _find_tool(module: str, tool: str) -> dict[str, Any]:
    """Look up a tool by module/name. Raises 404 if missing."""
    data = registry.get_module(module)
    if data is None:
        raise HTTPException(status_code=404, detail=f"module {module!r} not installed")
    for t in data["tools"]:
        if t.get("name") == tool:
            return t
    raise HTTPException(
        status_code=404,
        detail=f"tool {tool!r} not found in module {module!r}",
    )


def _validate_payload(payload: dict, tool: dict) -> None:
    """Pydantic-style strict validation against the tool's declared schema."""
    schema = tool.get("schema") or {"type": "object"}
    try:
        jsonschema.validate(instance=payload, schema=schema)
    except jsonschema.ValidationError as e:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "tool_payload_invalid",
                "message": e.message,
                "path": list(e.absolute_path),
            },
        )


# Recognise our own API base so the service token is sent ONLY to it.
_SERVICE_TOKEN = os.environ.get("CLARAOS_SERVICE_TOKEN", "").strip()
# `${NAME}` in a tool's static headers — only these names (a cell's own domains, e.g.
# the Host header Mastodon needs internally), never arbitrary environment values.
_HEADER_VAR_RE = re.compile(r"\$\{(SOCIAL_DOMAIN|VIDEO_DOMAIN)\}")
_OWN_API_HOSTS = {"localhost", "127.0.0.1", "::1", "claraos-api"}


def _is_own_api(endpoint: str) -> bool:
    """True if the endpoint points at this API itself (loopback/container name)."""
    try:
        host = (urllib.parse.urlsplit(endpoint).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return False
    return host in _OWN_API_HOSTS


def _trusted_caller(request: Request) -> str | None:
    """The authenticated end-user on whose behalf this tool call is made.

    Trusted ONLY when it arrives out-of-band from a trusted upstream — NOT
    from an LLM-controllable tool argument (that would allow impersonation
    via prompt injection). clara-agent sets `X-Claraos-User` from its own
    authenticated chat_user context; forward-auth sets `X-Authentik-Username`.
    Both come from inside the trusted cluster network.

    Security: the header alone is NOT enough. `require_caller` first checks the
    trust anchor (the machine's service token or the reverse proxy's proxy
    secret) — otherwise any device on the network and any logged-in user could
    claim an arbitrary username here.

    An external brain (services/brain_turns.py) never names the user: it sends
    the turn id of the running chat, and the user is looked up here.
    """
    brain_user = brain_turns.brain_caller(request)
    if brain_user is not None:
        return brain_user
    return require_caller(request)


async def _resolve_user_token(tool: dict, request: Request) -> dict | None:
    """Per-user token resolution.

    If the tool opts in via `per_user: true` and the trusted caller has an
    active credential account for `credential_app_id`, return that user's
    token (the `credential_key` field of the decrypted credentials dict).
    Returns None → caller falls back to the gateway's static env token.
    This makes shared app instances tenant-/user-safe: user A's lookup runs
    with A's own app token → A only sees A's data.
    """
    if not tool.get("per_user"):
        return None
    user = _trusted_caller(request)
    if not user:
        return None
    app_id = tool.get("credential_app_id")
    cred_key = tool.get("credential_key")
    if not app_id or not cred_key:
        logger.warning("per_user tool %s missing credential_app_id/credential_key", tool.get("name"))
        return None
    try:
        from database import user_tx
        from encryption import decrypt_credentials
        async with user_tx(user) as conn:   # row-level security (migrations/042)
            row = await conn.fetchrow(
                """
                SELECT credentials FROM claraos_app_credentials
                WHERE username = $1 AND app_id = $2 AND is_active = TRUE
                LIMIT 1
                """,
                user, app_id,
            )
        if not row:
            # A cell creates the access itself (users there have no app passwords).
            from services import zellen_zugaenge
            try:
                if await zellen_zugaenge.anlegen(app_id, user):
                    async with user_tx(user) as conn:
                        row = await conn.fetchrow(
                            """SELECT credentials FROM claraos_app_credentials
                               WHERE username = $1 AND app_id = $2 AND is_active = TRUE LIMIT 1""",
                            user, app_id)
            except zellen_zugaenge.ZugangFehlt as e:
                raise HTTPException(status_code=409, detail=str(e))
        if not row:
            return None
        creds = decrypt_credentials(row["credentials"])
        token = (creds or {}).get(cred_key)
        if not token:
            return None
        result = {"token": str(token).strip()}
        # basic-auth apps (InvenTree) also carry a per-user username.
        ukey = tool.get("credential_user_key")
        if ukey and (creds or {}).get(ukey):
            result["user"] = str(creds[ukey]).strip()
        return result
    except HTTPException:
        raise                                   # a deliberate answer (e.g. "open the app once")
    except Exception as e:  # pragma: no cover — never break the call on cred-store hiccups
        logger.warning("per-user token resolution failed for %s/%s: %s",
                       tool.get("name"), user, e)
        return None


def _build_auth_headers(tool: dict, request: Request, token_override: str | None = None,
                        user_override: str | None = None) -> dict[str, str]:
    """Translate tool's auth declaration to outgoing headers.

    - `oidc_token`: forward the caller's Authentik-forward-auth headers.
      The module decides what to do with them (most accept
      `X-Authentik-Username` directly).
    - `api_key`: the GATEWAY presents a token to the upstream. With per-user
      resolution a `token_override` (the caller's own app token) takes precedence;
      otherwise the static service token from claraos-api's env named by
      `auth_token_env` — the secret never lives in clara-tools.yaml.
      `auth_scheme` controls the wire format:
        * `bearer` (default): `Authorization: Bearer <token>` (personal access tokens, Mastodon)
        * `basic_apikey`:      `Authorization: Basic base64("apikey:<token>")` (apps with an "apikey" user)
        * `basic`:             `Authorization: Basic base64("<auth_user>:<token>")` (InvenTree)
        * `token`:             `Authorization: Token <token>` (Paperless / DRF)
        * `header:<Name>`:     `<Name>: <token>` (Immich `header:x-api-key`)
      If `auth_token_env` is absent (legacy modules), nothing is added — the
      upstream is the module's own already-authed API on the internal network.
    - `basic`: pass through Authorization header from the caller.
    - `none`: no auth header.

    Independently, a tool may declare static `headers:` (e.g. a `Host:` override
    for upstreams reached via host:port that enforce their canonical vhost).
    """
    auth_kind = tool.get("auth", "none")
    headers: dict[str, str] = {}
    # Static per-tool headers (Host override etc.) — applied for every auth kind.
    for k, v in (tool.get("headers") or {}).items():
        headers[str(k)] = _HEADER_VAR_RE.sub(lambda m: os.environ.get(m.group(1), ""), str(v))

    if auth_kind == "oidc_token":
        for h in ("x-authentik-username", "x-authentik-groups",
                  "x-authentik-email", "x-authentik-name", "x-authentik-uid"):
            v = request.headers.get(h)
            if v:
                headers[h] = v
    elif auth_kind == "api_key":
        # Per-user token (caller's own app credential) wins over the static env token.
        token_env = tool.get("auth_token_env")
        token = (token_override or "").strip() or ((os.environ.get(token_env) or "").strip() if token_env else "")
        if token:
            scheme = (tool.get("auth_scheme") or "bearer").lower()
            if scheme == "basic_apikey":
                import base64
                raw = base64.b64encode(f"apikey:{token}".encode()).decode()
                headers["authorization"] = f"Basic {raw}"
            elif scheme == "basic":
                # base64(<auth_user>:<token>) — token holds the password (InvenTree etc.).
                # Per-user username (credential_user_key) overrides the static auth_user.
                import base64
                user = user_override or tool.get("auth_user") or "admin"
                raw = base64.b64encode(f"{user}:{token}".encode()).decode()
                headers["authorization"] = f"Basic {raw}"
            elif scheme == "token":
                headers["authorization"] = f"Token {token}"   # Paperless / DRF-style
            elif scheme.startswith("header:"):
                headers[scheme.split(":", 1)[1]] = token       # e.g. header:x-api-key (Immich)
            else:  # bearer (default)
                headers["authorization"] = f"Bearer {token}"
        # else: legacy api_key (module reads its own env) → add nothing.
    elif auth_kind == "basic":
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("basic "):
            headers["authorization"] = auth
    # `none` → no headers added (beyond static `headers:`)
    return headers


@router.get("")
async def list_all_tools(request: Request):
    """Flat list of every clara-tools.yaml tool across installed modules."""
    require_caller(request)  # the catalogue is not public information
    return {
        "summary": registry.summary(),
        "tools": registry.list_tools(),
    }


@router.get("/ui-hooks")
async def list_ui_hooks():
    """All UI-hooks (rendered as Clara-sidebar buttons per app)."""
    return {
        "summary": registry.summary(),
        "ui_hooks": registry.list_ui_hooks(),
    }


# Apps whose per-user credentials cannot be derived from per_user gateway tools
# (e.g. the planner token). An installation may add its own apps
# (optional clara_tools_heim.py).
# Fields with optional=True do not block saving in the UI; the card then requires
# at least one filled field.
try:
    from routers.clara_tools_heim import WIDGET_CONNECTABLE_OVERLAY as _HEIM_OVERLAY
except ImportError:
    _HEIM_OVERLAY = []

_WIDGET_CONNECTABLE_OVERLAY: list[dict] = [
    {
        "app_id": "vikunja",
        "label": "Planner (Vikunja)",
        "module": "vikunja",
        "hint": f"Token erzeugen: Planner-Backend öffnen ({_domain_host('vikunja')}) → Einstellungen → API-Tokens → Token mit Projekt/Task/Label/Kommentar-Rechten erstellen.",
        "fields": [
            {"key": "api_token", "label": "API-Token", "secret": True},
        ],
    },
] + _HEIM_OVERLAY


@router.get("/connectable-apps")
async def connectable_apps():
    """Apps that support per-user credential connection (per_user lookup tools).

    The Settings → "App-Verbindungen" UI renders one card per app so each user
    can store their own app token (→ claraos_app_credentials). Derived from the
    live registry so it auto-syncs as per_user modules are installed, then
    merged with the static widget overlay above.
    """
    seen: dict[str, dict] = {}
    for t in registry.list_tools():
        if not t.get("per_user"):
            continue
        app_id = t.get("credential_app_id")
        if not app_id or app_id in seen:
            continue
        fields = []
        ukey = t.get("credential_user_key")
        if ukey:
            fields.append({"key": ukey, "label": "Benutzername", "secret": False})
        fields.append({"key": t.get("credential_key") or "api_token", "label": "API-Token", "secret": True})
        seen[app_id] = {
            "app_id": app_id,
            "label": app_id[:1].upper() + app_id[1:],
            "module": t.get("module"),
            "fields": fields,
        }
    for extra in _WIDGET_CONNECTABLE_OVERLAY:
        app = seen.get(extra["app_id"])
        if app is None:
            seen[extra["app_id"]] = {"module": None, **extra}
            continue
        app["label"] = extra.get("label", app["label"])
        if extra.get("hint"):
            app["hint"] = extra["hint"]
        for field in extra["fields"]:
            for i, existing in enumerate(app["fields"]):
                if existing["key"] == field["key"]:
                    app["fields"][i] = field
                    break
            else:
                app["fields"].append(field)
    return sorted(seen.values(), key=lambda a: a["app_id"])


@router.get("/module/{name}")
async def get_module_tools(name: str):
    """Tools + ui_hooks of a single module."""
    data = registry.get_module(name)
    if data is None:
        raise HTTPException(status_code=404, detail=f"no clara-tools for module {name!r}")
    return {"module": name, **data}


@router.post("/call/{module}/{tool}")
async def call_tool(module: str, tool: str, request: Request) -> Any:
    """Proxy a tool call from the tool bridge/Clara-Agent to the module's upstream endpoint.

    Flow:
      1. Look up tool in the registry (404 if absent).
      2. Strict-validate JSON body against `tool.schema` (422 on mismatch).
      3. Translate `tool.auth` into outgoing headers (oidc_token /
         api_key / basic / none — see _build_auth_headers).
      4. POST/GET (default POST) the body to `tool.endpoint`.
      5. Pass through the upstream response (200 / 502 on connect-fail).
    """
    spec = _find_tool(module, tool)

    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="tool body must be a JSON object")

    _validate_payload(payload, spec)
    # Routine runs (services/routinen.py) may only READ. The turn's marking is set by
    # this cell when it issues the turn — the brain cannot set or change it. A changing
    # call is not executed; it is stored on the run for the owner to approve.
    if request.headers.get("X-ClaraOS-Brain-Token") is not None:
        _trusted_caller(request)                       # validates token + turn first
        turn_meta = brain_turns.meta(request.headers.get("X-Claraos-Turn", ""))
        # Tools marked `freigabe: true` (e.g. posting publicly) never run on the brain's
        # word alone — not even when the user "agreed" in the chat (a yes in a chat can
        # be injected). They become a proposal the user approves by button.
        # (In a routine run the routine's own proposal list below takes it.)
        if spec.get("freigabe") and turn_meta.get("art") != "routine" and _trusted_caller(request):
            from services import routinen
            lauf, idx = await routinen.chat_vorschlag(_trusted_caller(request), module, tool, payload)
            logger.info("[clara-tools] approval proposal %s/%s run=%s #%d", module, tool, lauf, idx)
            return {"ok": True, "status": "wartet auf Freigabe",
                    "hinweis": "Noch NICHT ausgeführt. Der Nutzer muss es in der App „Routinen“ "
                               "unter „Wartet auf Freigabe“ freigeben (eine Meldung in der Glocke "
                               "führt dorthin). Sag ihm das so; nicht erneut versuchen."}
        if turn_meta.get("art") == "routine":
            from services import routinen
            if not routinen.ist_lesend(module, tool):
                idx = await routinen.vorschlag_merken(turn_meta["lauf"], module, tool, payload)
                logger.info("[clara-tools] routine proposal %s/%s run=%s #%d",
                            module, tool, turn_meta["lauf"], idx)
                return {"ok": True, "status": "als Vorschlag gespeichert",
                        "hinweis": "Nicht ausgeführt: In einer Routine ändert Clara nichts "
                                   "selbst. Der Nutzer gibt den Vorschlag in der App frei. "
                                   "Nicht erneut versuchen; in der Zusammenfassung erwähnen."}
    # Per-call audit line (INFO — silent at the default WARNING level; raise the
    # logger to INFO to trace which user drives which tool in multi-user setups).
    logger.info("[clara-tools] call %s/%s caller=%s per_user=%s",
                module, tool, _trusted_caller(request) or "-", bool(spec.get("per_user")))
    cred = await _resolve_user_token(spec, request)
    # Hardening: for `per_user` tools, do NOT silently fall back to the service
    # token (`auth_token_env`). Two reasons:
    #
    #  1. Privacy: a shared credential would give EVERY user access to the
    #     account owner's data — with Immich, for example, other users would see
    #     the owner's photos. The fallback is not just unnecessary but wrong.
    #  2. In practice such fallback tokens tend to be stale anyway (401/403), and
    #     the user got a cryptic "Invalid API key" instead of instructions.
    #
    # 409 + a "connect your account" hint is the established pattern (see `mail.py`).
    if spec.get("per_user") and not (cred or {}).get("token"):
        app_id = spec.get("credential_app_id") or module
        raise HTTPException(
            status_code=409,
            detail=(
                f"Kein verbundenes {app_id}-Konto für diesen Nutzer. "
                f"Bitte in ClaraOS unter „Dienste“ das {app_id}-Konto verbinden — "
                f"danach funktioniert dieses Werkzeug."
            ),
        )
    headers = _build_auth_headers(
        spec, request,
        token_override=(cred or {}).get("token"),
        user_override=(cred or {}).get("user"),
    )
    # Forward the trusted caller so loopback claraos-api routes
    # (e.g. nc_pim per-user PIM) can resolve who the call runs as. The value is
    # the out-of-band trusted user (X-Claraos-User / X-Authentik-Username), never
    # an LLM-supplied body field → no impersonation. Harmless for external
    # upstreams (they ignore the unknown header).
    _caller = _trusted_caller(request)
    if _caller:
        headers["X-Claraos-User"] = _caller

    endpoint = spec.get("endpoint")
    if not endpoint:
        raise HTTPException(status_code=500, detail=f"tool {tool!r} has no endpoint")

    # Security: authenticate on the SECOND hop too. Our own loopback routes
    # (nc_pim, knowledge, planner, mail, office, shopping …) require a trust
    # anchor; without this header half of the agent's toolbox would get 401.
    # Deliberately ONLY for loopback/our own API — the service secret must never
    # go to third-party upstreams (immich, mastodon …). Indirect paths
    # like this one are easy to overlook in auth changes.
    if _SERVICE_TOKEN and _is_own_api(endpoint):
        headers["X-ClaraOS-Service-Token"] = _SERVICE_TOKEN

    # Path templating: `{param}` placeholders in the endpoint are filled from the
    # validated payload (URL-encoded) and removed from the body — needed for REST
    # path APIs such as mastodon statuses/{id}/reblog or
    # workflows/{id}/activate. Scalars only; a missing param = 422.
    for _name in _ENDPOINT_PARAM_RE.findall(endpoint):
        if _name not in payload:
            raise HTTPException(status_code=422, detail=f"missing path param {_name!r}")
        _val = payload.pop(_name)
        if not isinstance(_val, (str, int, float)) or isinstance(_val, bool):
            raise HTTPException(status_code=422, detail=f"path param {_name!r} must be a scalar")
        endpoint = endpoint.replace("{" + _name + "}", urllib.parse.quote(str(_val), safe=""))

    method = (spec.get("method") or "POST").upper()

    async def _senden() -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=_PROXY_TIMEOUT) as client:
                if method == "GET":
                    return await client.get(endpoint, params=payload, headers=headers)
                return await client.request(method, endpoint, json=payload, headers=headers)
        except httpx.HTTPError as e:
            logger.warning("tool %s/%s upstream error: %s", module, tool, e)
            raise HTTPException(status_code=502, detail=f"upstream {endpoint!r} unreachable: {e}")

    r = await _senden()
    # A cell creates per-user access itself; when the app no longer accepts it (account
    # re-created, token revoked) renew it once instead of failing for good.
    _app_id = spec.get("credential_app_id") or module
    if r.status_code == 401 and spec.get("per_user") and _caller:
        from services import zellen_zugaenge
        if zellen_zugaenge.kann(_app_id):
            try:
                await zellen_zugaenge.anlegen(_app_id, _caller)
            except zellen_zugaenge.ZugangFehlt as e:
                raise HTTPException(status_code=409, detail=str(e))
            cred = await _resolve_user_token(spec, request)
            headers.update(_build_auth_headers(spec, request,
                                               token_override=(cred or {}).get("token"),
                                               user_override=(cred or {}).get("user")))
            r = await _senden()

    # Errors get ONE shape, so the agent detects failure by `ok`, not by guessing
    # from text, and always sees the reason plus what to do next.
    if r.status_code >= 400:
        return _error_envelope(r)
    # Pass-through. Try JSON first, fall back to plain text.
    try:
        return r.json()
    except ValueError:
        return {
            "_module": module,
            "_tool": tool,
            "_status": r.status_code,
            "_body": r.text[:5000],
        }


_ERROR_HINTS = {
    400: "The request was malformed — check the arguments against the tool description.",
    401: "Not signed in for this service — tell the user; do not retry.",
    403: "Not allowed for this user — tell the user; do not try another way around it.",
    404: "Not found — look it up again (list/search) instead of guessing an id or name.",
    409: "Conflict or missing connection — read the error, tell the user what is needed.",
    412: "Changed elsewhere in the meantime — read the current state and try again.",
    422: "Invalid value — fix the argument named in the error and call again once.",
    424: "A required account is not connected — tell the user how to connect it.",
}


def _error_envelope(r: httpx.Response) -> dict:
    """{ok: false, status, error, hint} for an upstream HTTP error (text capped at 800)."""
    detail: Any
    try:
        body = r.json()
        detail = body.get("detail", body) if isinstance(body, dict) else body
        if isinstance(body, dict) and body.get("hint"):
            hint = str(body["hint"])
        else:
            hint = ""
    except ValueError:
        detail, hint = r.text, ""
    text = detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False, default=str)
    if not hint:
        hint = _ERROR_HINTS.get(r.status_code) or (
            "The service failed — tell the user it did not work; do not claim success.")
    return {"ok": False, "status": r.status_code, "error": text[:800], "hint": hint}


@router.get("/openapi.json")
async def openapi_spec(request: Request):
    """OpenAPI 3.1 tool spec — Clara-Agent / its OpenAPI tool bridge consumes this.

    Every module's tools become POST endpoints under
    `/api/claraos/tools/call/{module}/{tool}`. The tool bridge's config gets
    one static entry pointing at this URL — tool discovery happens
    dynamically as modules are installed/uninstalled.

    Authenticated: the tool bridge fetches the catalogue with the service token
    (`claraos_modules_mcp_server._fetch_spec`), an external brain with its
    token plus the turn id of the running chat.
    """
    _trusted_caller(request)
    return registry.to_openapi_spec()


@router.get("/turn")
async def brain_turn(request: Request):
    """External brain: whose chat turn is this? (brain token + turn id required)."""
    user = brain_turns.brain_caller(request)
    if user is None:
        raise HTTPException(status_code=401, detail="brain token required")
    return {"user": user}


@router.post("/reload")
async def reload_registry(request: Request):
    """Re-scan the drop-in dir. Called by module-loader after install/uninstall."""
    require_caller(request)  # must not be triggerable anonymously from the network
    summary = registry.reload()
    logger.warning("[clara-tools] reload triggered → %s", summary)
    return {"status": "ok", **summary}
