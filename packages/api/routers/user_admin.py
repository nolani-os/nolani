"""User Admin v2: household user management.

Creates users end-to-end (Authentik = source of truth, optionally Nextcloud +
quota), manages groups, resets passwords (including session/token purge,
replacing an older shell script) and controls app visibility per user.

Authentik/Nextcloud access uses the established helpers from teams_admin (one
AUTHENTIK_API_TOKEN, Nextcloud admin = clara.bot credentials from the DB).
Mail account creation (Stalwart) is optional and skipped while the admin secret
is missing.
"""

from domains_generated import BASE_DOMAIN  # per deployment: CLARAOS_BASE_DOMAIN
from betriebsprofil import heim_default  # external deployments: no silent home-server fallback
from betriebsprofil import OWNER_USER  # owner/admin account of this installation
import logging
import os
import re
import secrets as _secrets

import hashlib

import asyncpg
import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import clara_agent_headers, get_current_user
from services import agent_keys, brain_turns, zellen_browser
from database import get_pool
from services.einladungen import ensure_invites_table

# Installation-specific steps of an invite (optional, deployment-specific module).
try:
    from services import einladung_heim as _einladung_heim
except ImportError:
    _einladung_heim = None
from routers.teams_admin import (
    AUTHENTIK_URL,
    NEXTCLOUD_URL,
    _ak_headers,
    _nc_admin_auth,
    ak_get_user_by_username,
    ak_get_group_by_name,
    nc_group_add_user,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/user-admin", tags=["user-admin"])
# Every route here is admin-gated and acts on OTHER users' rows (user apps,
# invites, deletion). They use the plain pool on purpose — the per-user
# row-level security of database.user_tx (migrations/041, 042) does not apply.

# clara-agent admin API for budgets (internal URL, set per deployment).
CLARA_AGENT_ADMIN_URL = heim_default("CLARA_AGENT_ADMIN_URL")

_USERNAME_RE = re.compile(r"^[a-z][a-z0-9._-]{1,31}$")

# Groups/names that mark a technical account (not shown as a human)
_SERVICE_GROUPS = {"claraos-bots", "claraos-backend-svc-group", "module-loader-svc-group", "sso-verify"}
_SERVICE_SUFFIXES = ("-svc", "-bot", "-test")
_SYSTEM_USERS = {"akadmin", "clara.bot"}

# Default preset for household members
FAMILY_GROUPS = ["clara-users", "team-family"]
DEFAULT_NC_QUOTA = "50 GB"


def _require_admin(user: dict):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Nur für Administratoren.")


def _is_service(username: str, groups: list[str], is_bot: bool) -> bool:
    if is_bot or username in _SYSTEM_USERS:
        return True
    if any(g in _SERVICE_GROUPS for g in groups):
        return True
    return any(username.endswith(s) for s in _SERVICE_SUFFIXES)


# ── Models ────────────────────────────────────────────────────

class CreateUser(BaseModel):
    username: str
    name: str
    email: str = ""
    password: str = ""          # empty -> generated
    groups: list[str] = Field(default_factory=lambda: list(FAMILY_GROUPS))
    create_nextcloud: bool = True
    nc_quota: str = DEFAULT_NC_QUOTA
    create_mail: bool = False   # Stalwart; only if the admin secret is available


class GroupChange(BaseModel):
    group: str


class AppOverride(BaseModel):
    app_id: str
    enabled: bool


# ── Raw Authentik access (not in teams_admin) ────────────────

async def _ak_create_user(username: str, name: str, email: str) -> int:
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(
            f"{AUTHENTIK_URL}/api/v3/core/users/",
            headers=_ak_headers(),
            json={"username": username, "name": name, "email": email,
                  "is_active": True, "path": "users", "type": "internal"},
        )
    if r.status_code == 400:
        raise HTTPException(400, f"Authentik lehnt ab: {r.text[:200]}")
    if r.status_code not in (200, 201):
        raise HTTPException(502, f"Authentik create user: {r.status_code} {r.text[:150]}")
    return r.json()["pk"]


async def _ak_set_password(user_pk: int, password: str) -> None:
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(
            f"{AUTHENTIK_URL}/api/v3/core/users/{user_pk}/set_password/",
            headers=_ak_headers(), json={"password": password},
        )
    if r.status_code not in (200, 204):
        raise HTTPException(502, f"Authentik set_password: {r.status_code} {r.text[:150]}")


async def _ak_set_groups(user_pk: int, group_names: list[str]) -> list[str]:
    """Assign the given groups (does NOT create them). Returns the ones actually applied."""
    applied = []
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        for gname in group_names:
            g = await ak_get_group_by_name(gname)
            if not g:
                logger.warning("Gruppe '%s' existiert nicht in Authentik — übersprungen", gname)
                continue
            r = await c.post(
                f"{AUTHENTIK_URL}/api/v3/core/groups/{g['pk']}/add_user/",
                headers=_ak_headers(), json={"pk": user_pk},
            )
            if r.status_code in (200, 204):
                applied.append(gname)
    return applied


async def _ak_purge_sessions(username: str) -> dict:
    """Delete sessions + OAuth tokens (fixes SSO refresh loops, like the old shell script)."""
    counts = {}
    endpoints = {
        "sessions": f"core/authenticated_sessions/?user__username={username}",
        "refresh_tokens": f"oauth2/refresh_tokens/?user__username={username}",
        "access_tokens": f"oauth2/access_tokens/?user__username={username}",
        "authorization_codes": f"oauth2/authorization_codes/?user__username={username}",
    }
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        for kind, q in endpoints.items():
            n = 0
            try:
                lr = await c.get(f"{AUTHENTIK_URL}/api/v3/{q}", headers=_ak_headers())
                for item in lr.json().get("results", []):
                    pk = item.get("pk")
                    base = q.split("?")[0]
                    dr = await c.delete(f"{AUTHENTIK_URL}/api/v3/{base}{pk}/", headers=_ak_headers())
                    if dr.status_code in (200, 204):
                        n += 1
            except Exception as e:
                logger.warning("purge %s für %s: %s", kind, username, e)
            counts[kind] = n
    return counts


# ── Nextcloud user create + quota (not in teams_admin) ───────

async def _nc_create_user(userid: str, password: str, quota: str, display_name: str) -> str:
    """Create a Nextcloud user via OCS. Idempotent: 'user already exists' -> ok. Returns a status."""
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=20) as c:
        r = await c.post(f"{NEXTCLOUD_URL}/ocs/v1.php/cloud/users", auth=auth, headers=headers,
                         data={"userid": userid, "password": password,
                               "quota": quota, "displayName": display_name})
        if "already exists" in r.text or '"statuscode":102' in r.text:
            status = "existierte_bereits"
        elif r.status_code in (200, 201) and ('"statuscode":100' in r.text or '"status":"ok"' in r.text):
            status = "angelegt"
        else:
            logger.warning("NC create %s: %s %s", userid, r.status_code, r.text[:200])
            return f"fehler:{r.status_code}"
        # Always set the quota (also for an existing user)
        try:
            await c.put(f"{NEXTCLOUD_URL}/ocs/v1.php/cloud/users/{userid}", auth=auth, headers=headers,
                        data={"key": "quota", "value": quota})
        except Exception as e:
            logger.warning("NC quota %s: %s", userid, e)
    return status


async def _nc_disable_user(userid: str) -> str:
    """Disable the Nextcloud account (login blocked, data kept). Best effort."""
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    try:
        async with httpx.AsyncClient(verify=False, timeout=15) as c:
            r = await c.put(f"{NEXTCLOUD_URL}/ocs/v1.php/cloud/users/{userid}/disable",
                            auth=auth, headers=headers)
        if '"statuscode":100' in r.text or r.status_code in (200, 201):
            return "deaktiviert"
        if '"statuscode":101' in r.text or "does not exist" in r.text.lower():
            return "nicht_vorhanden"
        return f"fehler:{r.status_code}"
    except Exception as e:
        logger.warning("NC disable %s: %s", userid, e)
        return f"fehler:{e}"


async def _nc_delete_user(userid: str) -> str:
    """HARD-delete the Nextcloud account (data gone). Only for mistaken accounts. Best effort."""
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    try:
        async with httpx.AsyncClient(verify=False, timeout=15) as c:
            r = await c.delete(f"{NEXTCLOUD_URL}/ocs/v1.php/cloud/users/{userid}",
                               auth=auth, headers=headers)
        if '"statuscode":100' in r.text or r.status_code in (200, 201):
            return "gelöscht"
        if '"statuscode":101' in r.text or "does not exist" in r.text.lower() or '"statuscode":998' in r.text:
            return "nicht_vorhanden"
        return f"fehler:{r.status_code}"
    except Exception as e:
        logger.warning("NC delete %s: %s", userid, e)
        return f"fehler:{e}"


# ── Mail (Stalwart): admin secret from env OR Vaultwarden ────

STALWART_VW_ITEM = heim_default("STALWART_VW_ITEM") or "Stalwart Admin"
_stalwart_pw_cache: dict = {"pw": None, "ts": 0.0}


def _stalwart_admin_pw() -> str:
    """Stalwart management password: env first, then the Vaultwarden admin entry
    named by STALWART_VW_ITEM (5 min cache). Empty = not available."""
    env_pw = os.environ.get("STALWART_ADMIN_PASSWORD", "").strip()
    if env_pw:
        return env_pw
    import time as _time
    if _stalwart_pw_cache["pw"] and (_time.time() - _stalwart_pw_cache["ts"]) < 300:
        return _stalwart_pw_cache["pw"]
    try:
        from services import vw_client
        match = next((i for i in vw_client.list_org_items()
                      if i.get("name") == STALWART_VW_ITEM), None)
        if match:
            full = vw_client.get_item_full(match["id"])
            pw = ((full or {}).get("login") or {}).get("password", "") or ""
            if pw:
                _stalwart_pw_cache.update(pw=pw, ts=_time.time())
                return pw
    except Exception as e:
        logger.warning("Stalwart-PW aus Vaultwarden nicht lesbar: %s", e)
    return ""


def _stalwart_available() -> bool:
    return bool(_stalwart_admin_pw())


# Important: the mail domain defaults to the base domain. A hard-coded legacy
# domain here once gave EVERY new user a mailbox in the wrong domain, which kept
# re-creating address drift. Stalwart serves both domains and matches the same
# mailbox via the localpart, so it never showed up as an error, only as
# inconsistency.
STALWART_MAIL_DOMAIN = os.environ.get("STALWART_MAIL_DOMAIN", BASE_DOMAIN)
STALWART_DOMAIN_ID = heim_default("STALWART_DOMAIN_ID")  # each deployment sets its own domain ID
_STALWART_USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]


async def _stalwart_jmap(calls: list) -> dict:
    """POST /jmap with basic auth (recovery admin). Raises on transport/HTTP errors."""
    admin_pw = _stalwart_admin_pw()
    if not admin_pw:
        raise RuntimeError("kein Stalwart-Secret")
    base = heim_default("STALWART_ADMIN_URL")
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{base}/jmap", auth=("admin", admin_pw),
                         json={"using": _STALWART_USING, "methodCalls": calls})
    r.raise_for_status()
    return r.json()


async def _stalwart_create_account(localpart: str, password: str, display_name: str) -> str:
    """Create a Stalwart account <localpart>@<domain> via management JMAP (v0.16).
    Account object = x:Account/set, credentials as a map {"0":{@type:Password,...}}.
    Best effort; the wizard never aborts."""
    if not _stalwart_admin_pw():
        return "übersprungen (kein Stalwart-Secret)"
    create = {"n0": {
        "@type": "User", "name": localpart, "domainId": STALWART_DOMAIN_ID,
        "description": display_name or localpart,
        "credentials": {"0": {"@type": "Password", "secret": password,
                              "expiresAt": None, "allowedIps": {}}},
    }}
    try:
        resp = await _stalwart_jmap([["x:Account/set", {"create": create}, "c0"]])
        mr = resp["methodResponses"][0][1]
        if mr.get("created"):
            return "angelegt"
        nc = (mr.get("notCreated") or {}).get("n0", {})
        detail = f"{nc.get('type', '')} {nc.get('description', '')}".lower()
        if "already" in detail or "exist" in detail or "duplicate" in detail:
            return "existierte_bereits"
        logger.warning("Stalwart create %s: %s", localpart, nc)
        return f"fehler:{nc.get('type') or 'unbekannt'}"
    except Exception as e:
        logger.warning("Stalwart create %s: %s", localpart, e)
        return f"fehler:{e}"


async def _stalwart_delete_account(localpart: str) -> str:
    """Delete the Stalwart account <localpart>@<domain>. Best effort.
    Stalwart's text filter matches the name/localpart, NOT the full address, so
    search by localpart, then match exactly on emailAddress."""
    if not _stalwart_admin_pw():
        return "übersprungen"
    target_email = f"{localpart}@{STALWART_MAIL_DOMAIN}"
    try:
        q = await _stalwart_jmap([
            ["x:Account/query", {"filter": {"text": localpart}}, "c0"],
            ["x:Account/get", {"#ids": {"resultOf": "c0", "name": "x:Account/query", "path": "/ids"}}, "c1"],
        ])
        accts = q["methodResponses"][1][1].get("list") or []
        ids = [a["id"] for a in accts if a.get("emailAddress") == target_email]
        if not ids:
            return "nicht_vorhanden"
        d = await _stalwart_jmap([["x:Account/set", {"destroy": ids}, "c0"]])
        destroyed = d["methodResponses"][0][1].get("destroyed") or []
        return "gelöscht" if destroyed else "fehler:destroy"
    except Exception as e:
        logger.warning("Stalwart delete %s: %s", localpart, e)
        return f"fehler:{e}"


# ── Endpoints ────────────────────────────────────────────────

@router.get("/users")
async def list_users(request: Request, filter: str = "humans") -> dict:
    """Users from Authentik, classified. filter=humans|service|all."""
    _require_admin(get_current_user(request))
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.get(f"{AUTHENTIK_URL}/api/v3/core/users/?page_size=200",
                        headers=_ak_headers())
    if r.status_code != 200:
        raise HTTPException(502, f"Authentik: {r.status_code}")
    humans, service = [], []
    for u in r.json().get("results", []):
        username = u["username"]
        if username.startswith("ak-outpost-"):
            continue
        groups = [g["name"] for g in u.get("groups_obj", [])]
        attrs = u.get("attributes") or {}
        is_bot = bool(attrs.get("is_bot", False))
        entry = {
            "username": username, "name": u.get("name", username),
            "email": u.get("email", ""), "is_active": u.get("is_active", True),
            "groups": groups, "pk": u.get("pk"),
            # owner and system accounts cannot be deleted or deactivated
            "protected": username in _SYSTEM_USERS or username == OWNER_USER,
        }
        (service if _is_service(username, groups, is_bot) else humans).append(entry)
    humans.sort(key=lambda x: x["username"])
    service.sort(key=lambda x: x["username"])
    if filter == "humans":
        return {"users": humans, "count": len(humans)}
    if filter == "service":
        return {"users": service, "count": len(service)}
    return {"humans": humans, "service": service}


@router.get("/groups")
async def list_groups(request: Request) -> dict:
    """Available Authentik groups (for chips/presets)."""
    _require_admin(get_current_user(request))
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.get(f"{AUTHENTIK_URL}/api/v3/core/groups/?page_size=100", headers=_ak_headers())
    groups = [g["name"] for g in r.json().get("results", [])] if r.status_code == 200 else []
    return {"groups": sorted(groups), "family_preset": FAMILY_GROUPS}


@router.post("/users")
async def create_user(body: CreateUser, request: Request) -> dict:
    """Create a new user: Authentik (+password +groups) -> optional Nextcloud (+quota) -> optional mail.
    Returns the initial password EXACTLY ONCE."""
    _require_admin(get_current_user(request))
    username = body.username.strip().lower()
    if not _USERNAME_RE.match(username):
        raise HTTPException(422, "Ungültiger Benutzername (a-z, 2-32, Punkt/Bindestrich erlaubt).")
    if await ak_get_user_by_username(username):
        raise HTTPException(409, f"Benutzer '{username}' existiert bereits.")

    password = body.password.strip() or _secrets.token_urlsafe(12)
    steps = {}

    user_pk = await _ak_create_user(username, body.name.strip() or username, body.email.strip())
    steps["authentik"] = "angelegt"
    await _ak_set_password(user_pk, password)
    steps["passwort"] = "gesetzt"
    steps["gruppen"] = await _ak_set_groups(user_pk, body.groups)

    if body.create_nextcloud:
        steps["nextcloud"] = await _nc_create_user(username, password, body.nc_quota,
                                                   body.name.strip() or username)
        # Mirror Nextcloud groups (team-<slug> -> nc group team-<slug>)
        for g in body.groups:
            try:
                await nc_group_add_user(f"team-{g.split('team-')[-1]}" if g.startswith("team-") else g, username)
            except Exception:
                pass

    if body.create_mail:
        steps["mail"] = await _stalwart_create_account(username, password, body.name.strip() or username)

    logger.info("USER_CREATE admin=%s target=%s steps=%s",
                get_current_user(request)["username"], username, steps)

    # Trigger 1: provision the new user in the connected apps right away.
    # Deliberately in the BACKGROUND: a failing Immich must not make user
    # creation fail; whatever falls through here is picked up by the nightly
    # run. Immich is not covered here anyway: the account there is only
    # created on the user's first login.
    try:
        import asyncio as _asyncio
        from services import user_provisioning as _prov
        _asyncio.get_event_loop().create_task(_prov.provision_im_hintergrund(
            username, email=body.email.strip()))
        steps["app-provisionierung"] = "angestossen"
    except Exception as exc:  # noqa: BLE001
        logger.warning("Provisionierung fuer %s nicht angestossen: %s", username, exc)

    return {
        "username": username,
        "steps": steps,
        "password": password,           # ONCE ONLY: the frontend shows it once
        "email": f"{username}@{STALWART_MAIL_DOMAIN}" if body.create_mail else body.email,
    }


@router.post("/users/{username}/reset-password")
async def reset_password(username: str, request: Request) -> dict:
    """Set a new initial password + purge sessions/tokens (SSO loop fix)."""
    _require_admin(get_current_user(request))
    u = await ak_get_user_by_username(username)
    if not u:
        raise HTTPException(404, f"Benutzer '{username}' nicht gefunden.")
    if username in _SYSTEM_USERS or username == OWNER_USER:
        raise HTTPException(403, f"'{username}' ist geschützt.")
    password = _secrets.token_urlsafe(12)
    await _ak_set_password(u["pk"], password)
    purged = await _ak_purge_sessions(username)
    logger.info("PW_RESET admin=%s target=%s purged=%s",
                get_current_user(request)["username"], username, purged)
    return {"username": username, "password": password, "purged": purged}


@router.post("/users/{username}/groups")
async def add_group(username: str, body: GroupChange, request: Request) -> dict:
    _require_admin(get_current_user(request))
    u = await ak_get_user_by_username(username)
    if not u:
        raise HTTPException(404, "Benutzer nicht gefunden.")
    applied = await _ak_set_groups(u["pk"], [body.group])
    if not applied:
        raise HTTPException(400, f"Gruppe '{body.group}' nicht zuweisbar (existiert sie?).")
    return {"username": username, "added": body.group}


@router.delete("/users/{username}/groups/{group}")
async def remove_group(username: str, group: str, request: Request) -> dict:
    _require_admin(get_current_user(request))
    u = await ak_get_user_by_username(username)
    if not u:
        raise HTTPException(404, "Benutzer nicht gefunden.")
    g = await ak_get_group_by_name(group)
    if not g:
        raise HTTPException(404, "Gruppe nicht gefunden.")
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(f"{AUTHENTIK_URL}/api/v3/core/groups/{g['pk']}/remove_user/",
                         headers=_ak_headers(), json={"pk": u["pk"]})
    if r.status_code not in (200, 204):
        raise HTTPException(502, f"Entfernen fehlgeschlagen: {r.status_code}")
    return {"username": username, "removed": group}


@router.post("/users/{username}/deactivate")
async def deactivate_user(username: str, request: Request) -> dict:
    """Deactivate a user (is_active=false): data kept, login blocked."""
    _require_admin(get_current_user(request))
    if username in _SYSTEM_USERS or username == OWNER_USER:
        raise HTTPException(403, f"'{username}' ist geschützt.")
    u = await ak_get_user_by_username(username)
    if not u:
        raise HTTPException(404, "Benutzer nicht gefunden.")
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.patch(f"{AUTHENTIK_URL}/api/v3/core/users/{u['pk']}/",
                          headers=_ak_headers(), json={"is_active": False})
    if r.status_code not in (200, 204):
        raise HTTPException(502, f"Deaktivieren fehlgeschlagen: {r.status_code}")
    await _ak_purge_sessions(username)
    # Deactivate the Nextcloud account too (login blocked everywhere, data kept)
    nextcloud = await _nc_disable_user(username)
    # Agent keys are not Authentik sessions: without this an agent would keep
    # acting for a deactivated account. Revoked keys stay revoked on reactivation.
    try:
        agent_keys_revoked = await agent_keys.revoke_all(username)
    except asyncpg.UndefinedTableError:
        agent_keys_revoked = 0
    logger.info("USER_DEACTIVATE admin=%s target=%s nc=%s agent_keys=%s",
                get_current_user(request)["username"], username, nextcloud, agent_keys_revoked)
    return {"username": username, "is_active": False, "nextcloud": nextcloud,
            "agent_keys_revoked": agent_keys_revoked}


@router.delete("/users/{username}")
async def delete_user(username: str, request: Request, purge_nextcloud: bool = False) -> dict:
    """HARD-delete a user from Authentik (+ mail account). The Nextcloud account is
    only DEACTIVATED by default (data kept); with ?purge_nextcloud=true it is
    hard-deleted too (only for mistaken accounts)."""
    _require_admin(get_current_user(request))
    if username in _SYSTEM_USERS or username == OWNER_USER:
        raise HTTPException(403, f"'{username}' ist geschützt.")
    u = await ak_get_user_by_username(username)
    if not u:
        raise HTTPException(404, "Benutzer nicht gefunden.")
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.delete(f"{AUTHENTIK_URL}/api/v3/core/users/{u['pk']}/", headers=_ak_headers())
    if r.status_code not in (200, 204):
        raise HTTPException(502, f"Löschen fehlgeschlagen: {r.status_code}")
    # Remove per-user app overrides as well
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM claraos_user_apps WHERE username=$1", username)
        # Clara's per-user state goes too: routines would keep running for a deleted
        # account, and a later account with the same name would inherit them and the
        # stored app access. Tables may be missing in older installations.
        for tabelle in ("claraos_routine_laeufe", "claraos_routinen", "claraos_meldungen",
                        "claraos_app_credentials", "claraos_agent_calls", "claraos_agent_keys"):
            try:
                await conn.execute(f"DELETE FROM {tabelle} WHERE username=$1", username)
            except asyncpg.UndefinedTableError:
                pass
    # Remove the mail account; deactivate (default, data kept) or purge the Nextcloud account. Best effort.
    mail = await _stalwart_delete_account(username)
    nextcloud = await (_nc_delete_user(username) if purge_nextcloud else _nc_disable_user(username))
    # A connected external brain forgets the user too (memories, chat sessions).
    brain = await brain_turns.forget_user(username)
    # Cell: the personal browser (profile with cookies and logins) goes with the account.
    browser = await zellen_browser.remove(username)
    logger.info("USER_DELETE admin=%s target=%s mail=%s nc=%s purge_nc=%s brain=%s browser=%s",
                get_current_user(request)["username"], username, mail, nextcloud, purge_nextcloud,
                brain, browser)
    return {"username": username, "deleted": True, "mail": mail, "nextcloud": nextcloud,
            "brain": brain, "browser": browser}


# ── Onboarding invites (setup wizard / onboarding portal) ──

ONBOARDING_PORTAL_URL = heim_default("ONBOARDING_PORTAL_URL")
INVITE_TTL_DAYS = 7


@router.post("/users/{username}/invite")
async def create_invite(username: str, request: Request) -> dict:
    """Create an invite link for the setup wizard. The plaintext token appears
    ONLY in this response (the DB stores sha256). Existing open invites of the
    user are revoked; the installation may prepare more (einladung_heim)."""
    admin = get_current_user(request)
    _require_admin(admin)
    username = username.strip().lower()
    u = await ak_get_user_by_username(username)
    if not u:
        raise HTTPException(404, f"Benutzer '{username}' nicht gefunden.")

    # Installation-specific preparation from the optional module
    # services/einladung_heim.py; its status fields are added to the response.
    extra: dict = {}
    if _einladung_heim is not None:
        extra = await _einladung_heim.einladung_vorbereiten(username)

    token = _secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    await ensure_invites_table()
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            UPDATE claraos_invites SET revoked_at = NOW()
            WHERE username = $1 AND used_at IS NULL AND revoked_at IS NULL
        """, username)
        row = await conn.fetchrow("""
            INSERT INTO claraos_invites (token_hash, username, display_name, created_by, expires_at)
            VALUES ($1, $2, $3, $4, NOW() + make_interval(days => $5))
            RETURNING expires_at
        """, token_hash, username, (u.get("name") or username).split(" ")[0], admin["username"], INVITE_TTL_DAYS)
    logger.info("INVITE_CREATE admin=%s target=%s", admin["username"], username)
    return {
        "username": username,
        "invite_url": f"{ONBOARDING_PORTAL_URL}/i/{token}",   # ONCE ONLY: never retrievable again
        "expires_at": row["expires_at"].isoformat(),
        **extra,
    }


@router.get("/invites")
async def list_invites(request: Request) -> dict:
    """Status of all invites (without tokens; those cannot be reconstructed)."""
    _require_admin(get_current_user(request))
    await ensure_invites_table()
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT username, display_name, created_by, created_at, expires_at,
                   used_at, revoked_at, preauth_issues
            FROM claraos_invites ORDER BY created_at DESC LIMIT 100
        """)
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    invites = []
    for r in rows:
        if r["used_at"]:
            status = "verwendet"
        elif r["revoked_at"]:
            status = "widerrufen"
        elif r["expires_at"] and r["expires_at"] <= now:
            status = "abgelaufen"
        else:
            status = "offen"
        invites.append({
            "username": r["username"], "display_name": r["display_name"],
            "created_by": r["created_by"], "created_at": r["created_at"].isoformat(),
            "expires_at": r["expires_at"].isoformat(), "status": status,
            "preauth_issues": r["preauth_issues"],
        })
    return {"invites": invites}


@router.delete("/users/{username}/invite")
async def revoke_invite(username: str, request: Request) -> dict:
    """Revoke all open invites of a user."""
    admin = get_current_user(request)
    _require_admin(admin)
    await ensure_invites_table()
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute("""
            UPDATE claraos_invites SET revoked_at = NOW()
            WHERE username = $1 AND used_at IS NULL AND revoked_at IS NULL
        """, username.strip().lower())
    n = int(result.split(" ")[-1] or 0)
    logger.info("INVITE_REVOKE admin=%s target=%s n=%d", admin["username"], username, n)
    return {"username": username, "revoked": n}


class BudgetSet(BaseModel):
    monthly_budget_eur: float = Field(ge=0, le=10000)


@router.get("/users/{username}/budget")
async def get_user_budget(username: str, request: Request) -> dict:
    """Budget + monthly usage of a user (proxy to clara-agent /v1/admin/budget)."""
    admin = get_current_user(request)
    _require_admin(admin)
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.get(f"{CLARA_AGENT_ADMIN_URL}/v1/admin/budget/{username}",
                            headers=clara_agent_headers({"X-User-Role": "admin", "X-User-Id": admin["username"]}))
        if r.status_code == 200:
            return r.json()
        return {"available": False, "detail": f"clara-agent {r.status_code}"}
    except Exception as e:
        # Budget system unreachable -> UI shows "not available", no hard error
        return {"available": False, "detail": str(e)}


@router.put("/users/{username}/budget")
async def set_user_budget(username: str, body: BudgetSet, request: Request) -> dict:
    """Set the monthly budget (proxy to clara-agent PATCH /v1/admin/users/{username})."""
    admin = get_current_user(request)
    _require_admin(admin)
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.patch(f"{CLARA_AGENT_ADMIN_URL}/v1/admin/users/{username}",
                              headers=clara_agent_headers({"X-User-Role": "admin", "X-User-Id": admin["username"],
                                                           "Content-Type": "application/json"}),
                              json={"monthly_budget_eur": body.monthly_budget_eur})
        if r.status_code == 200:
            return {"username": username, "monthly_budget_eur": body.monthly_budget_eur}
        raise HTTPException(502, f"clara-agent: {r.status_code} {r.text[:150]}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Budget-Update fehlgeschlagen: {e}")


@router.get("/users/{username}/apps")
async def get_user_apps(username: str, request: Request) -> dict:
    """App visibility for a user: all apps + group gate + per-user override."""
    _require_admin(get_current_user(request))
    u = await ak_get_user_by_username(username)
    if not u:
        raise HTTPException(404, "Benutzer nicht gefunden.")
    user_groups = [g["name"] for g in u.get("groups_obj", [])]
    pool = await get_pool()
    async with pool.acquire() as conn:
        app_rows = await conn.fetch("SELECT id, manifest FROM claraos_apps WHERE enabled = TRUE")
        ov_rows = await conn.fetch(
            "SELECT app_id, enabled FROM claraos_user_apps WHERE username = $1", username)
    overrides = {r["app_id"]: r["enabled"] for r in ov_rows}
    import json as _json
    apps = []
    for r in app_rows:
        m = _json.loads(r["manifest"])
        req = m.get("requiredGroups") or []
        req_users = m.get("requiredUsernames") or []
        gate_ok = (not req or any(g in user_groups for g in req)) and \
                  (not req_users or username.lower() in [x.lower() for x in req_users])
        apps.append({
            "id": r["id"], "name": m.get("name", r["id"]),
            "category": m.get("category", ""),
            "gate_allowed": gate_ok,
            "override": overrides.get(r["id"]),  # None|True|False
            "effective": overrides.get(r["id"], gate_ok),
        })
    apps.sort(key=lambda a: (a["category"], a["name"]))
    return {"username": username, "apps": apps}


@router.put("/users/{username}/apps")
async def set_user_app(username: str, body: AppOverride, request: Request) -> dict:
    """Set a per-user override (enabled True/False). To reset to the group default, use the DELETE endpoint, which removes the override."""
    _require_admin(get_current_user(request))
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO claraos_user_apps (username, app_id, enabled)
            VALUES ($1, $2, $3)
            ON CONFLICT (username, app_id) DO UPDATE SET enabled = EXCLUDED.enabled
        """, username, body.app_id, body.enabled)
    return {"username": username, "app_id": body.app_id, "enabled": body.enabled}


@router.delete("/users/{username}/apps/{app_id}")
async def clear_user_app(username: str, app_id: str, request: Request) -> dict:
    """Remove the override -> the app falls back to the group default."""
    _require_admin(get_current_user(request))
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM claraos_user_apps WHERE username=$1 AND app_id=$2",
                           username, app_id)
    return {"username": username, "app_id": app_id, "cleared": True}


# ── Provisioning in the connected apps ──────────────────────────────────────
#
# Why an API endpoint rather than a script: the same call serves the initial
# rollout, catching up existing users AND the nightly reconciliation. A script
# would have been built three times.

@router.post("/users/{username}/provision")
async def provision_user_apps(username: str, request: Request) -> dict:
    """Provision a user in the connected apps (idempotent)."""
    _require_admin(get_current_user(request))
    username = username.strip().lower()
    u = await ak_get_user_by_username(username)
    if not u:
        raise HTTPException(404, f"Benutzer '{username}' nicht gefunden.")
    from services import user_provisioning
    return await user_provisioning.provision_user(
        username, email=u.get("email", ""), ak_uid=u.get("uid", ""))


@router.post("/provision-all")
async def provision_all_users(request: Request) -> dict:
    """Catch up all real users; service and test accounts are left out.

    Pure delegation: the nightly run uses the same function
    (`services/user_provisioning._loop`). Two selection logics would be two
    chances to diverge.
    """
    _require_admin(get_current_user(request))
    from services import user_provisioning
    return await user_provisioning.provision_all()
