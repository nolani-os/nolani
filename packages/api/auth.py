"""Authentik forward_auth header parsing for ClaraOS.

Security: the X-Authentik-* headers are trustworthy ONLY when they come from
Caddy. Without this check any device on the LAN could send them directly to
the API port and impersonate any user (including an admin) — or, with no
headers at all, get the dev fallback admin.

Two trust anchors, both set via env:

  CLARAOS_PROXY_SECRET   — Caddy appends it as X-ClaraOS-Proxy-Secret; only
                           then are the Authentik headers evaluated.
  CLARAOS_SERVICE_TOKEN  — machine callers (e.g. MCP servers on an internal
                           host) send it as X-ClaraOS-Service-Token and get the
                           fixed service identity (CLARAOS_SERVICE_USER).

If NEITHER variable is set, the legacy dev mode runs (local development
without Caddy). As soon as one is set, fail-closed is enforced.
"""

from betriebsprofil import IS_CELL, OWNER_USER, PRODUCT_NAME  # owner/admin account of this installation
from domains_generated import BASE_DOMAIN  # cell: CLARAOS_BASE_DOMAIN
import hmac
import logging
import os

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

# Role mapping based on Authentik groups
GROUP_ROLE_MAP = {
    "clara-admins": "admin",
    "clara-power-users": "power-user",
    "clara-users": "user",
}

PROXY_SECRET = os.environ.get("CLARAOS_PROXY_SECRET", "").strip()
SERVICE_TOKEN = os.environ.get("CLARAOS_SERVICE_TOKEN", "").strip()
_SERVICE_USERNAME = os.environ.get("CLARAOS_SERVICE_USER", OWNER_USER).strip()

# Fail-closed as soon as one of the anchors is configured.
ENFORCE = bool(PROXY_SECRET or SERVICE_TOKEN)

# Dev fallback user (only when neither proxy secret nor service token is set)
DEV_USER = {
    "username": os.environ.get("CLARAOS_DEV_USER", "dev"),
    "email": os.environ.get("CLARAOS_DEV_EMAIL", "dev@localhost"),
    "name": os.environ.get("CLARAOS_DEV_NAME", "Developer"),
    "uid": "dev",
    "groups": ["clara-admins"],
    "role": "admin",
}

SERVICE_USER = {
    "username": _SERVICE_USERNAME,
    "email": "",
    "name": f"{PRODUCT_NAME} Service",
    "uid": "service",
    "groups": ["clara-admins"],
    "role": "admin",
}

if not ENFORCE and IS_CELL:
    # A cell is reachable from the internet: dev mode there would make every
    # visitor an administrator. Refuse to start instead of warning.
    raise RuntimeError(
        "CLARAOS_PROFILE=cell needs CLARAOS_PROXY_SECRET and/or CLARAOS_SERVICE_TOKEN "
        "(deploy/cell/setup.sh generates both)."
    )
if not ENFORCE:
    logger.warning(
        "AUTH: kein CLARAOS_PROXY_SECRET/CLARAOS_SERVICE_TOKEN gesetzt — "
        "Dev-Modus, JEDE Anfrage gilt als Admin. Nicht für Produktion!"
    )


def _matches(candidate: str, expected: str) -> bool:
    return bool(candidate) and bool(expected) and hmac.compare_digest(candidate, expected)


def _parse_authentik_headers(request: Request) -> dict:
    username = request.headers.get("X-Authentik-Username", "")
    groups_raw = request.headers.get("X-Authentik-Groups", "")
    groups = [g.strip() for g in groups_raw.split("|") if g.strip()]

    role = "guest"
    for group, group_role in GROUP_ROLE_MAP.items():
        if group in groups:
            role = group_role
            break

    return {
        "username": username,
        "email": request.headers.get("X-Authentik-Email", ""),
        "name": request.headers.get("X-Authentik-Name", ""),
        "uid": request.headers.get("X-Authentik-Uid", ""),
        "groups": groups,
        "role": role,
    }


def is_service_call(request: Request) -> bool:
    """Did the request come from a MACHINE (valid service token)?

    Used for headers that grant more than the caller's own identity — above
    all `X-Claraos-Actor`. A browser behind Caddy must NOT be able to declare
    itself a machine this way: in the planner, the actor decides whether
    writes use Clara's (more powerful) Vikunja token.
    """
    if not ENFORCE:
        return True
    return _matches(request.headers.get("X-ClaraOS-Service-Token", ""), SERVICE_TOKEN)


def service_headers(username: str, actor: str | None = None) -> dict:
    """Headers for an **internal** call of this API to itself (loopback).

    Since the per-user routers require a trust anchor, `X-Claraos-User` alone
    is no longer enough — internal forwards (clara-tools gateway,
    knowledge->planner, assistant runner) must identify as a service and state
    on whose behalf they act.

    Warning: use ONLY for this API itself. The service secret must never be
    sent to a foreign upstream.
    """
    h = {"Content-Type": "application/json", "X-Claraos-User": username}
    if SERVICE_TOKEN:
        h["X-ClaraOS-Service-Token"] = SERVICE_TOKEN
    if actor:
        h["X-Claraos-Actor"] = actor
    return h


def require_caller(request: Request) -> str:
    """The user on whose behalf this request runs — **authenticated**.

    Security: per-user routers (planner, nc_pim, knowledge, mail, office,
    clara_tools) used to have their own `_caller()` that simply
    read `X-Claraos-User`. That had two holes:

      1. **From the LAN**: the API port accepted the request without any
         anchor — a self-set header was enough to read and write as any user.
         `get_current_user` was fail-closed, but these routers never called it.
      2. **Through Caddy**: Caddy strips incoming `X-ClaraOS-Service-Token`
         and proxy-secret headers, but `X-Claraos-User` passed through
         unfiltered. Since the routers PREFERRED that header, any signed-in
         user could impersonate the admin with a single header line.

    Current rule:
      * **Service token** (machine: tool bridge, clara-agent, runner) may act on
        behalf of a user => `X-Claraos-User`/`X-Authentik-Username` applies.
      * **Proxy secret** (request came through Caddy) => ONLY the Authentik
        identity counts. A `X-Claraos-User` sent along is deliberately ignored,
        not rejected: in practice it comes from legacy clients with the correct
        value, and a 400 would only hurt ourselves.
      * Neither => 401.

    Dev mode (neither secret nor token set) behaves as before.
    """
    if not ENFORCE:
        return (request.headers.get("x-claraos-user")
                or request.headers.get("x-authentik-username")
                or DEV_USER["username"])

    if _matches(request.headers.get("X-ClaraOS-Service-Token", ""), SERVICE_TOKEN):
        user = (request.headers.get("x-claraos-user")
                or request.headers.get("x-authentik-username")
                or SERVICE_USER["username"])
        return user.strip()

    if _matches(request.headers.get("X-ClaraOS-Proxy-Secret", ""), PROXY_SECRET):
        user = (request.headers.get("x-authentik-username") or "").strip()
        if not user:
            raise HTTPException(status_code=401, detail="Anfrage ohne Benutzerkennung.")
        return user

    raise HTTPException(
        status_code=401,
        detail=f"Nicht authentifiziert. Bitte über https://home.{BASE_DOMAIN} anmelden — "
               "der direkte Zugriff auf diesen Port ist nicht erlaubt.",
    )


def clara_agent_headers(extra: dict | None = None) -> dict:
    """Headers for a direct call to clara-agent: its bearer token plus `extra`.

    The agent checks `Authorization: Bearer <CLARA_AGENT_TOKEN>` at its entrance.
    The token is read at call time (secrets may be loaded after import) and is
    sent ONLY to clara-agent, never to any other upstream. Without the variable
    no header is added (the agent then decides: warn or reject).
    """
    h = dict(extra or {})
    token = os.environ.get("CLARA_AGENT_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def require_browser_user(request: Request) -> str:
    """The signed-in person, for actions only a human may trigger by button.

    Some actions (sending a stored mail draft) must never be reachable for a
    machine, not even for the assistant acting on the user's behalf. So the
    service token is REJECTED here, and only a request that came through the
    reverse proxy (proxy secret + Authentik identity) counts. A JSON content
    type is required as well: a cross-site HTML form cannot send one without a
    CORS preflight, which the API does not grant.
    """
    if ENFORCE and _matches(request.headers.get("X-ClaraOS-Service-Token", ""), SERVICE_TOKEN):
        raise HTTPException(status_code=403,
                            detail="Nur per Knopf in der Oberfläche, nicht für Werkzeuge.")
    if "application/json" not in (request.headers.get("content-type") or "").lower():
        raise HTTPException(status_code=415, detail="JSON erwartet.")
    site = (request.headers.get("sec-fetch-site") or "").lower()
    if site and site not in ("same-origin", "none"):
        raise HTTPException(status_code=403, detail="Nur aus der eigenen Oberfläche.")
    if not ENFORCE:
        return (request.headers.get("x-authentik-username") or DEV_USER["username"]).strip()
    if not _matches(request.headers.get("X-ClaraOS-Proxy-Secret", ""), PROXY_SECRET):
        raise HTTPException(status_code=401, detail="Nicht authentifiziert.")
    user = (request.headers.get("x-authentik-username") or "").strip()
    if not user:
        raise HTTPException(status_code=401, detail="Anfrage ohne Benutzerkennung.")
    return user


def get_current_user(request: Request) -> dict:
    """Identity of the request. Raises 401 unless it comes from Caddy or from a
    service with a valid service token."""
    if not ENFORCE:
        user = _parse_authentik_headers(request)
        return user if user["username"] else DEV_USER.copy()

    # Service callers may — like Caddy — act on behalf of a user
    # (files/text-editor MCP set X-Authentik-Username). Without a user header
    # the service identity applies.
    if _matches(request.headers.get("X-ClaraOS-Service-Token", ""), SERVICE_TOKEN):
        user = _parse_authentik_headers(request)
        if user["username"]:
            return user
        # Acting on behalf of a user (tool proxy, routines): that user, not the
        # owner — otherwise every user's tool call would read and write the
        # owner's data. Groups are unknown here, so the least role applies; only
        # the owner keeps the service identity's role.
        acting = (request.headers.get("x-claraos-user") or "").strip()
        if acting and acting != SERVICE_USER["username"]:
            return {"username": acting, "email": "", "name": acting, "uid": "",
                    "groups": [], "role": "user"}
        return SERVICE_USER.copy()

    if not _matches(request.headers.get("X-ClaraOS-Proxy-Secret", ""), PROXY_SECRET):
        raise HTTPException(
            status_code=401,
            detail=f"Nicht authentifiziert. Bitte über https://home.{BASE_DOMAIN} anmelden — "
                   "der direkte Zugriff auf diesen Port ist nicht erlaubt.",
        )

    user = _parse_authentik_headers(request)
    if not user["username"]:
        raise HTTPException(status_code=401, detail="Anfrage ohne Benutzerkennung.")
    return user
