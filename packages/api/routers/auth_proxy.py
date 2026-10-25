"""Auth Proxy – service-specific login handlers for auto-login in iframe apps."""

from betriebsprofil import NC_FOLDER, PRODUCT_NAME, heim_default  # external cell: no silent home-server fallback
import os
import json
import logging
import base64
import html
import re
import httpx
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import HTMLResponse
from auth import get_current_user

import domains_generated as domains
from database import get_pool, user_tx
from encryption import decrypt_credentials

# Optional login handlers and internal addresses of installation-specific apps
# (not part of the product).
try:
    from routers import auth_proxy_heim as _heim
except ImportError:
    _heim = None

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/auth-proxy", tags=["auth-proxy"])


async def _get_active_credentials(username: str, app_id: str) -> dict | None:
    """Get decrypted credentials for the active account."""
    if not username:
        return None
    async with user_tx(username) as conn:   # row-level security (migrations/042)
        row = await conn.fetchrow("""
            SELECT credentials FROM claraos_app_credentials
            WHERE username = $1 AND app_id = $2 AND is_active = TRUE
        """, username, app_id)
    if not row:
        return None
    return decrypt_credentials(row["credentials"])


async def _get_app_config(app_id: str) -> dict | None:
    """Get app manifest config from DB."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT manifest FROM claraos_apps WHERE id = $1", app_id
        )
    if not row:
        return None
    manifest = json.loads(row["manifest"])
    return manifest.get("config", {})


# ═══════════════════════════════════════
# SERVICE-SPECIFIC LOGIN HANDLERS
# ═══════════════════════════════════════

async def login_paperless(url: str, creds: dict) -> dict:
    """Paperless-ngx: POST /api/token/ → Token as cookie."""
    async with httpx.AsyncClient(timeout=10, verify=False) as c:
        r = await c.post(f"{url}/api/token/",
            json={"username": creds.get("username", ""), "password": creds.get("password", "")})
        if r.status_code != 200:
            return {"error": f"Paperless login failed: {r.status_code}"}
        token = r.json().get("token", "")
        return {"type": "header", "key": "Authorization", "value": f"Token {token}"}


async def login_immich(url: str, creds: dict) -> dict:
    """Immich: POST /api/auth/login → accessToken as cookie."""
    async with httpx.AsyncClient(timeout=10, verify=False) as c:
        r = await c.post(f"{url}/api/auth/login",
            json={"email": creds.get("email", ""), "password": creds.get("password", "")})
        if r.status_code not in (200, 201):
            return {"error": f"Immich login failed: {r.status_code}"}
        token = r.json().get("accessToken", "")
        return {"type": "cookie", "name": "immich_access_token", "value": token, "path": "/"}


async def login_openwebui(url: str, creds: dict) -> dict:
    """Open WebUI: POST /api/v1/auths/signin → JWT as cookie."""
    async with httpx.AsyncClient(timeout=10, verify=False) as c:
        r = await c.post(f"{url}/api/v1/auths/signin",
            json={"email": creds.get("email", ""), "password": creds.get("password", "")})
        if r.status_code != 200:
            return {"error": f"Open WebUI login failed: {r.status_code}"}
        token = r.json().get("token", "")
        return {"type": "cookie", "name": "token", "value": token, "path": "/"}


async def login_basic_auth(_url: str, creds: dict) -> dict:
    """Generic Basic Auth: encode credentials for URL or header."""
    username = creds.get("username", "")
    password = creds.get("password", "")
    b64 = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"type": "basic_auth", "username": username, "password": password, "b64": b64}


async def login_ntfy(url: str, creds: dict) -> dict:
    """ntfy: token-auth via static auth-bootstrap page.

    ntfy's Web UI keeps auth state in localStorage (`token`, `user`),
    not cookies — so we route the iframe to a static page on
    the ntfy host (/_claraos_auth) that reads ?t=&u= and writes them to
    localStorage, then redirects to /. The reverse proxy serves this static
    page next to ntfy.
    """
    token = creds.get("api_key", "") or creds.get("token", "")
    if not token:
        username = creds.get("username", "")
        password = creds.get("password", "")
        if not username:
            return {"error": "ntfy: no api_key, token, or username/password stored"}
        async with httpx.AsyncClient(timeout=10, verify=False) as c:
            r = await c.post(
                f"{url}/v1/account/token",
                auth=(username, password),
            )
            if r.status_code != 200:
                return {"error": f"ntfy token mint failed: {r.status_code} {r.text[:80]}"}
            token = r.json().get("token", "")
            if not token:
                return {"error": "ntfy returned no token"}
    # Return ntfy-specific bootstrap URL on PUBLIC hostname (browser-side).
    # `url` arg is internal Docker URL — we hardcode the public host because
    # iframe runs in the browser, not in claraos-api.
    return {
        "type": "redirect_url",
        "url": domains.url("ntfy", f"/_claraos_auth?t={token}&u={creds.get('username', 'clara')}"),
    }


async def login_mastodon(url: str, creds: dict) -> dict:
    """Mastodon: 2-step OAuth → Bearer token."""
    async with httpx.AsyncClient(timeout=10, verify=False) as c:
        # Step 1: Create app
        r1 = await c.post(f"{url}/api/v1/apps", json={
            "client_name": PRODUCT_NAME, "redirect_uris": "urn:ietf:wg:oauth:2.0:oob", "scopes": "read write"})
        if r1.status_code not in (200, 201):
            return {"error": f"Mastodon app create failed: {r1.status_code}"}
        app = r1.json()
        # Step 2: Get token
        r2 = await c.post(f"{url}/oauth/token", data={
            "grant_type": "password", "client_id": app["client_id"], "client_secret": app["client_secret"],
            "username": creds.get("email", ""), "password": creds.get("password", ""), "scope": "read write"})
        if r2.status_code != 200:
            return {"error": f"Mastodon token failed: {r2.status_code}"}
        return {"type": "header", "key": "Authorization", "value": f"Bearer {r2.json().get('access_token', '')}"}


async def login_peertube(url: str, creds: dict) -> dict:
    """PeerTube: 2-step OAuth → Bearer token."""
    async with httpx.AsyncClient(timeout=10, verify=False) as c:
        r1 = await c.get(f"{url}/api/v1/oauth-clients/local")
        if r1.status_code != 200:
            return {"error": f"PeerTube client fetch failed: {r1.status_code}"}
        client = r1.json()
        r2 = await c.post(f"{url}/api/v1/users/token", data={
            "client_id": client["client_id"], "client_secret": client["client_secret"],
            "grant_type": "password", "username": creds.get("username", ""), "password": creds.get("password", "")})
        if r2.status_code != 200:
            return {"error": f"PeerTube token failed: {r2.status_code}"}
        return {"type": "cookie", "name": "access_token", "value": r2.json().get("access_token", ""), "path": "/"}


async def login_matrix(url: str, creds: dict) -> dict:
    """Matrix/Element: SSO-style admin-mint via clara.bot, no password roundtrip.

    Previously this used m.login.password against the user's stored creds.
    Now clara.bot is a Synapse admin and mints a token for the requested user
    via /admin/v1/users/{user_id}/login. The user's password is no longer
    consulted for ClaraOS auto-login — Authentik forward_auth header
    (X-Authentik-Username) is the trust anchor.
    """
    username = creds.get("username", "")
    if not username:
        return {"error": "no username in creds"}
    try:
        from routers.teams_admin import mint_matrix_token_for_user
        return await mint_matrix_token_for_user(username)
    except Exception as exc:
        # Fallback: legacy password-login for migration period
        logger.warning("admin-mint failed for %s: %s — falling back to password", username, exc)
        hs_url = url.replace("element.", "matrix.")
        async with httpx.AsyncClient(timeout=10, verify=False) as c:
            r = await c.post(f"{hs_url}/_matrix/client/v3/login", json={
                "type": "m.login.password",
                "identifier": {"type": "m.id.user", "user": username},
                "password": creds.get("password", "")})
            if r.status_code != 200:
                return {"error": f"Matrix login failed: {r.status_code}"}
            j = r.json()
            return {
                "type": "matrix_token",
                "access_token": j.get("access_token", ""),
                "user_id": j.get("user_id", ""),
            }


# Internal Docker URLs for services (bypasses Caddy/HTTPS redirects)
# Every entry can be overridden via env INTERNAL_URL_<APP> — the defaults are
# the container DNS names of the reference deployment (12-factor hardening).
def _iu(app: str) -> str:
    return heim_default("INTERNAL_URL_" + app.upper().replace("-", "_"))

INTERNAL_URLS = {
    "paperless": _iu("paperless"),
    "immich": _iu("immich"),
    "open-webui": _iu("open-webui"),
    "mastodon": _iu("mastodon"),
    "peertube": _iu("peertube"),
    "element": _iu("element"),  # Matrix homeserver
    **getattr(_heim, "INTERNAL_URLS", {}),
}

NEXTCLOUD_INTERNAL_URL = heim_default("NEXTCLOUD_INTERNAL_URL")


def _resolve_internal_url(app_id: str, public_url: str) -> str:
    """Convert public Caddy URL to internal Docker URL."""
    return INTERNAL_URLS.get(app_id, public_url)


# Handler registry
LOGIN_HANDLERS = {
    "paperless": login_paperless,
    "immich": login_immich,
    "openwebui": login_openwebui,
    "basic_auth": login_basic_auth,
    "ntfy": login_ntfy,
    "nextcloud": login_basic_auth,
    "mastodon": login_mastodon,
    "peertube": login_peertube,
    "matrix": login_matrix,
    # Login handlers of the installation's own apps (auth_proxy_heim.py).
    **getattr(_heim, "LOGIN_HANDLERS", {}),
}


# Nextcloud scratch file config per app type
NC_SCRATCH_FILES = {
    "writer":   {"path": f"/{NC_FOLDER}/Writer.docx",   "editor": "richdocuments", "template_type": "document"},
    "calc":     {"path": f"/{NC_FOLDER}/Calc.xlsx",     "editor": "richdocuments", "template_type": "spreadsheet"},
    "impress":  {"path": f"/{NC_FOLDER}/Impress.pptx",  "editor": "richdocuments", "template_type": "presentation"},
    "drawio":   {"path": f"/{NC_FOLDER}/Drawing.drawio", "editor": "drawio", "template_type": None},
    "markdown": {"path": f"/{NC_FOLDER}/Notes.md",       "editor": "text", "template_type": None},
}


async def _nc_get_or_create_scratch(nc_url: str, username: str, password: str, doctype: str) -> int | None:
    """Ensure a scratch file exists for the user via WebDAV/OCS, return fileId."""
    cfg = NC_SCRATCH_FILES.get(doctype)
    if not cfg:
        return None

    file_path = cfg["path"]
    auth = (username, password)
    dav_base = f"{nc_url}/remote.php/dav/files/{username}"

    async with httpx.AsyncClient(timeout=15, verify=False, follow_redirects=False, headers={"X-Forwarded-Proto":"https","Host":domains.host("nextcloud")}) as c:
        # Ensure the product folder exists (MKCOL)
        folder_resp = await c.request("MKCOL", f"{dav_base}/{NC_FOLDER}", auth=auth)
        # 201=created, 405=already exists

        propfind_body = (
            '<?xml version="1.0"?>'
            '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
            '<d:prop><oc:fileid/></d:prop></d:propfind>'
        )

        # Check if scratch file exists
        r = await c.request(
            "PROPFIND", f"{dav_base}{file_path}", auth=auth,
            headers={"Depth": "0", "Content-Type": "application/xml"},
            content=propfind_body,
        )

        if r.status_code == 404:
            template_type = cfg.get("template_type")
            if template_type:
                # Use Nextcloud OCS templates API - creates an empty template file
                create_r = await c.post(
                    f"{nc_url}/ocs/v2.php/apps/files/api/v1/templates/create",
                    auth=auth,
                    headers={
                        "OCS-APIRequest": "true",
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    json={
                        "filePath": file_path,
                        "templatePath": "",
                        "templateType": "user",
                    },
                )
                if create_r.status_code == 200:
                    try:
                        file_id = create_r.json()["ocs"]["data"]["fileid"]
                        return int(file_id)
                    except Exception:
                        pass
                else:
                    logger.warning(f"OCS templates create failed {create_r.status_code}: {create_r.text[:300]}")
                    return None
            else:
                # Drawio: create empty mxfile XML via WebDAV
                empty_drawio = b'<mxfile host="Electron"><diagram id="d" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'
                await c.put(f"{dav_base}{file_path}", auth=auth, content=empty_drawio)

            # PROPFIND again to get fileId
            r = await c.request(
                "PROPFIND", f"{dav_base}{file_path}", auth=auth,
                headers={"Depth": "0", "Content-Type": "application/xml"},
                content=propfind_body,
            )

        if r.status_code not in (200, 207):
            return None

        # Parse fileid from XML response
        match = re.search(r'<oc:fileid[^>]*>(\d+)</oc:fileid>', r.text)
        if match:
            return int(match.group(1))
        return None


@router.get("/nc-editor/{doctype}")
async def nc_editor(doctype: str, request: Request):
    """Open or create a scratch Nextcloud file and redirect to the editor."""
    from fastapi.responses import RedirectResponse

    user = get_current_user(request)
    # Use the nextcloud app's credentials (user/pass for the NC account)
    creds = await _get_active_credentials(user["username"], "nextcloud")
    if not creds:
        creds = await _get_active_credentials(user["username"], "nextcloud-writer")
    if not creds:
        return HTMLResponse(
            f"<html><body>No Nextcloud credentials stored. Open the Nextcloud app in {PRODUCT_NAME} and configure credentials.</body></html>",
            status_code=401,
        )

    cfg = NC_SCRATCH_FILES.get(doctype)
    if not cfg:
        return HTMLResponse(f"Unknown doctype: {html.escape(doctype)}", status_code=400)

    # Internal URL bypasses Caddy/Authentik forward_auth (WebDAV needs direct access)
    nc_internal = NEXTCLOUD_INTERNAL_URL
    nc_external = domains.url("nextcloud")
    nc_username = creds.get("username", "")
    nc_password = creds.get("password", "")

    try:
        file_id = await _nc_get_or_create_scratch(nc_internal, nc_username, nc_password, doctype)
    except Exception as e:
        logger.exception("nc-editor error")
        return HTMLResponse(f"Error: {html.escape(str(e))}", status_code=500)

    if not file_id:
        return HTMLResponse("Failed to create/find scratch file in Nextcloud", status_code=502)

    # Redirect to external URL (user's browser needs the public hostname).
    # For .md files we want the Text editor opened directly — use openfile
    # param so Nextcloud auto-launches the editor on page-load.
    editor = cfg.get("editor", "")
    file_path = cfg["path"]
    parent_dir = file_path.rsplit("/", 1)[0] or "/"
    if editor == "text":
        # Open .md files via Files-app with openfile=<id> trigger — NC's
        # Text app auto-launches as the editor for markdown files. Pure
        # /apps/text/* routes don't exist as standalone pages.
        target = (
            f"{nc_external}/index.php/apps/files/?dir={parent_dir}"
            f"&openfile={file_id}"
        )
    else:
        target = f"{nc_external}/index.php/f/{file_id}"
    return RedirectResponse(url=target, status_code=302)


@router.get("/auth-login/{app_id}")
async def get_auth_login(app_id: str, request: Request):
    """Server-side login, return session token via Caddy cookie-setter route on target domain."""
    user = get_current_user(request)
    creds = await _get_active_credentials(user["username"], app_id)
    if not creds:
        return HTMLResponse("<html><body>No credentials stored.</body></html>", status_code=401)

    config = await _get_app_config(app_id)
    if not config:
        return HTMLResponse("<html><body>App not found.</body></html>", status_code=404)

    app_url = config.get("url", "")
    internal_url = _resolve_internal_url(app_id, app_url)

    handler = LOGIN_HANDLERS.get(config.get("authMethod"))
    if not handler:
        return HTMLResponse("Unsupported auth method", status_code=400)

    try:
        result = await handler(internal_url, creds)
    except Exception as e:
        return HTMLResponse(f"Login error: {html.escape(str(e))}", status_code=500)

    if "error" in result:
        return HTMLResponse(f"Login failed: {html.escape(str(result['error']))}", status_code=502)

    # Redirect to a Caddy route on the app's own domain that sets the cookie
    session = result.get("session_cookie", "")
    if not session:
        return HTMLResponse("No session cookie returned", status_code=502)

    from urllib.parse import quote
    from fastapi.responses import RedirectResponse
    return RedirectResponse(
        url=f"{app_url}/_claraos_session?t={quote(session)}",
        status_code=302,
    )


@router.get("/{app_id}")
async def get_auth(app_id: str, request: Request) -> dict:
    """Get authentication for an app. Returns token/cookie for auto-login."""
    user = get_current_user(request)
    creds = await _get_active_credentials(user["username"], app_id)

    config = await _get_app_config(app_id)
    if not config:
        return {"auth": None, "reason": "no_app_config"}

    auth_method = config.get("authMethod")
    app_url = config.get("url", "")

    # nc_editor apps store credentials under "nextcloud", not per sub-app
    if not creds and auth_method == "nc_editor":
        creds = await _get_active_credentials(user["username"], "nextcloud")

    # Matrix/Element: the admin mint needs NO stored credentials — it exists
    # precisely to make them unnecessary. The trust anchor is the logged-in user
    # set by Authentik, not a credential entry. That is why this branch comes
    # BEFORE the no_credentials check.
    # Warning: if it came after, users without matrix entries in
    # claraos_app_credentials (i.e. everyone, once stale entries are cleaned up)
    # would always get `no_credentials`, the mint path would never be reached, and
    # the Teams app would silently stay empty (matrixClient.ts just returns
    # `false`). A guard in front of a door it does not need to guard eventually
    # locks out the people who are entitled to enter.
    if auth_method == "matrix":
        try:
            from routers.teams_admin import mint_matrix_token_for_user
            result = await mint_matrix_token_for_user(user["username"])
        except Exception as exc:
            logger.error("Matrix-Mint fuer %s fehlgeschlagen: %s", user["username"], exc)
            return {"auth": None, "reason": "matrix_mint_failed"}
        return {
            "auth": result,
            "access_token": result.get("access_token", ""),
            "user_id": result.get("user_id", ""),
        }

    if not creds:
        return {"auth": None, "reason": "no_credentials"}

    if not auth_method or auth_method == "sso":
        return {"auth": None, "reason": "sso"}

    if auth_method == "selkies":
        # For selkies apps, return credentials for overlay display
        return {"auth": None, "credentials": creds, "reason": "selkies_overlay"}

    if auth_method == "ha_token":
        # Token-based app: the stored token is used directly
        return {"auth": {"type": "query_param", "key": "auth_callback", "value": "1"}, "credentials": creds}

    if auth_method == "api_key":
        # API key services: return key for header
        return {"auth": {"type": "header", "key": "Authorization", "value": f"Bearer {creds.get('api_key', '')}"}, "credentials": creds}

    # nc_editor: resolve scratch file and return direct Nextcloud URL
    if auth_method == "nc_editor":
        doctype = app_url.rstrip("/").rsplit("/", 1)[-1]  # e.g. "calc" from ".../nc-editor/calc"
        nc_internal = NEXTCLOUD_INTERNAL_URL
        nc_external = domains.url("nextcloud")
        nc_username = creds.get("username", "")
        nc_password = creds.get("password", "")
        try:
            file_id = await _nc_get_or_create_scratch(nc_internal, nc_username, nc_password, doctype)
        except Exception as e:
            logger.error("nc_editor scratch file error for %s: %s", app_id, str(e))
            return {"auth": None, "credentials": creds, "error": str(e)}
        if file_id:
            return {"auth": {"type": "redirect_url", "url": f"{nc_external}/index.php/f/{file_id}"}, "credentials": creds}
        return {"auth": None, "credentials": creds, "error": "scratch_file_failed"}

    handler = LOGIN_HANDLERS.get(auth_method)
    if not handler:
        return {"auth": None, "credentials": creds, "reason": f"unknown_method:{auth_method}"}

    # Resolve internal URL: convert Caddy public URLs to Docker-internal hostnames
    internal_url = _resolve_internal_url(app_id, app_url)
    try:
        result = await handler(internal_url, creds)
        if "error" in result:
            logger.warning("Auth proxy error for %s: %s", app_id, result["error"])
            return {"auth": None, "credentials": creds, "error": result["error"]}
        # Flatten matrix_token fields to top-level so frontend matrixClient.ts
        # (which reads data.access_token + data.user_id) works without rebuild.
        #
        # SECURITY: when the handler successfully minted an admin-token (e.g.
        # matrix_token via clara.bot), the user's stored credentials are NOT
        # needed by the frontend — strip them to avoid leaking plaintext
        # passwords / recovery_keys via this API. Only the legacy fallback
        # path (matrixClient.ts password-login) needed creds, and that path
        # is dead now that mint succeeds.
        if result.get("type") == "matrix_token":
            response = {
                "auth": result,
                "access_token": result.get("access_token", ""),
                "user_id": result.get("user_id", "") or creds.get("user_id", ""),
            }
        else:
            response = {"auth": result, "credentials": creds}
        return response
    except Exception as e:
        logger.error("Auth proxy exception for %s: %s", app_id, str(e))
        return {"auth": None, "credentials": creds, "error": str(e)}
