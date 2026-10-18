"""Iframe bootstrap — fresh-auth wrapper to defeat cookie pollution.

Problem: When user A was logged into Service X in this browser, the browser
caches Service X session cookies. When user B later opens Service X in an
iframe from the same browser, those cookies are still sent and Service X shows
user A's view.

Solution: Instead of loading the service URL directly, load this bootstrap
endpoint which serves a small HTML page that:
  1. Clears known service session cookies (best-effort, same-origin only)
  2. Optionally fetches the service's logout endpoint
  3. Redirects to the service login URL (which triggers fresh OIDC with the
     current Authentik session)

The result: The current Authentik user (which Caddy forward_auth validates)
gets a fresh service session, replacing any stale cookies.

Per-app config in `claraos_apps.manifest.config`:
  - logoutPath: e.g., "/index.php/logout" (Nextcloud)
  - loginPath:  e.g., "/" or "/login" — where to redirect after logout
  - sessionCookies: list of cookie names to clear, e.g., ["app_session"]
  - forceFreshAuth: bool — if true, IframeApp uses this bootstrap
"""

import json
import logging
import urllib.parse
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import HTMLResponse

from auth import get_current_user
from database import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/iframe-bootstrap", tags=["iframe-bootstrap"])


async def _get_app_manifest(app_id: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT manifest FROM claraos_apps WHERE id = $1 AND enabled = TRUE",
            app_id,
        )
    if not row:
        return None
    return json.loads(row["manifest"])


def _build_bootstrap_html(
    service_url: str,
    logout_url: str | None,
    login_url: str,
    session_cookies: list[str],
    user_hint: str,
    app_id: str,
) -> str:
    """Build the bootstrap HTML page.

    The page runs JS that:
      1. Marks the iframe as "bootstrap mode" (so debuggers can identify it)
      2. Clears known service cookies (set with empty value + past expiry)
      3. Fetches the logout URL with credentials (to invalidate server session)
      4. Navigates to the login URL (triggers fresh OIDC dance via Caddy)

    Cookie clearing is best-effort: cross-origin cookies cannot be set from
    here, but `fetch(..., {credentials: "omit"})` followed by a navigation
    forces the browser to re-establish the service session via Authentik.
    """
    cookies_js = json.dumps(session_cookies)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Authenticating as {user_hint}…</title>
<style>
  html, body {{ margin: 0; padding: 0; height: 100%; background: #1e1e2e; color: #cdd6f4; font-family: system-ui, sans-serif; }}
  .wrap {{ display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 16px; }}
  .spinner {{ width: 44px; height: 44px; border: 4px solid #313244; border-top-color: #89b4fa; border-radius: 50%; animation: spin 0.8s linear infinite; }}
  @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
  .label {{ font-size: 14px; color: #a6adc8; }}
  .user {{ font-size: 13px; color: #89b4fa; font-family: monospace; }}
  .app {{ font-size: 12px; color: #6c7086; }}
</style>
</head>
<body>
<div class="wrap">
  <div class="spinner"></div>
  <div class="label">Loading <span class="app">{app_id}</span></div>
  <div class="user">{user_hint}</div>
</div>
<script>
(async function() {{
  const SERVICE_URL = {json.dumps(service_url)};
  const LOGOUT_URL  = {json.dumps(logout_url) if logout_url else 'null'};
  const LOGIN_URL   = {json.dumps(login_url)};
  const COOKIES     = {cookies_js};

  // Step 1: best-effort cookie clear (only same-origin will succeed)
  try {{
    for (const name of COOKIES) {{
      document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    }}
  }} catch (e) {{ /* ignore */ }}

  // Step 2: fetch logout to invalidate server session (best-effort)
  if (LOGOUT_URL) {{
    try {{
      await fetch(LOGOUT_URL, {{
        method: "GET",
        credentials: "include",
        mode: "no-cors",
        cache: "no-store",
        redirect: "manual",
      }});
    }} catch (e) {{ /* ignore CORS errors */ }}
  }}

  // Step 3: tiny delay so cookies clear, then redirect
  setTimeout(() => {{
    window.location.replace(LOGIN_URL);
  }}, 200);
}})();
</script>
</body>
</html>"""


@router.get("/{app_id}")
async def iframe_bootstrap(app_id: str, request: Request) -> HTMLResponse:
    """Serve the bootstrap HTML page for an app iframe.

    Clears stale cookies, hits the service logout endpoint, then redirects
    the iframe to the service URL where Authentik OIDC will reauth as the
    current user.
    """
    user = get_current_user(request)
    manifest = await _get_app_manifest(app_id)
    if not manifest:
        raise HTTPException(status_code=404, detail=f"App not found: {app_id}")

    # Check user has access (requiredGroups)
    req_groups = manifest.get("requiredGroups") or []
    if req_groups and not any(g in user["groups"] for g in req_groups):
        raise HTTPException(status_code=403, detail="App not accessible to this user")

    config = manifest.get("config") or {}
    service_url = config.get("url", "").rstrip("/")
    if not service_url:
        raise HTTPException(status_code=400, detail="App has no URL configured")

    logout_path = config.get("logoutPath", "")
    login_path = config.get("loginPath")  # if not set, use full service_url as login URL
    session_cookies = config.get("sessionCookies") or []

    # Extract host root for logout URL — service_url may include a sub-path
    # (e.g. "https://media.example.com/sso/OID/start/authentik")
    parsed = urllib.parse.urlparse(service_url)
    host_root = f"{parsed.scheme}://{parsed.netloc}"

    logout_url = f"{host_root}{logout_path}" if logout_path else None
    # Login URL: if loginPath is set, append to host_root; otherwise use full service_url
    login_url = f"{host_root}{login_path}" if login_path else service_url

    html = _build_bootstrap_html(
        service_url=service_url,
        logout_url=logout_url,
        login_url=login_url,
        session_cookies=session_cookies,
        user_hint=user["username"],
        app_id=app_id,
    )

    headers = {
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        "Pragma": "no-cache",
        "Content-Security-Policy": "default-src 'self' 'unsafe-inline'",
    }
    return HTMLResponse(content=html, headers=headers)
