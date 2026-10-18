"""ClaraOS Teams admin router — Authentik-as-master + NC/Matrix mirrors.

Master-of-truth: Authentik group (prefix `team-{slug}`).
Mirrors: Matrix Space + optional NC Circle. Writes go to Authentik first,
then propagate to mirrors. A failure in one mirror is logged as `sync_error`
and left for the sync-daemon to retry — no half-rollback of Authentik state.
"""
from __future__ import annotations

from betriebsprofil import heim_default  # external deployments: no silent home-server fallback
from betriebsprofil import OWNER_USER  # owner/admin account of this installation
import asyncio
import json
import logging
import os
import re
import ssl
import time

import httpx

from domains_generated import BASE_DOMAIN, MATRIX_SERVER_NAME, url as domain_url
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user
from database import get_pool
from encryption import decrypt_credentials
from services.synapse_admin import _get_synapse_admin_token as _raw_synapse_login


# Cache Synapse admin token for 30 minutes to avoid /login rate-limit (429)
# when a burst of team operations hits in quick succession.
# Uses clara.bot (a Synapse admin) so we can mint tokens for ANY user
# (including the human admin) — the admin API requires admin != target.
_MX_TOKEN_CACHE: dict = {"token": None, "exp": 0}

# ClaraOS username != Matrix localpart. Authentik carries the claim
# `matrix_localpart` (scope `matrix`), and Synapse builds MXIDs from it:
# localpart_template = {{ user.matrix_localpart }}.
# Example: ClaraOS user `jdoe` -> @john.doe:example.com.
# Warning: building `@{username}:{domain}` here addresses a user that does
# not exist — minting fails, a kick hits nothing (the user stays in the
# room!) and an invite reaches nobody.
_MX_LOCALPART_CACHE: dict = {}  # username -> (localpart, exp)
_MX_LOCALPART_TTL = 300


async def _matrix_localpart(username: str) -> str:
    """ClaraOS username -> Matrix localpart (Authentik claim `matrix_localpart`).

    Falls back to the username if the user carries NO such attribute — this
    is the documented rule and matches Synapse's `or user.username`.
    Important: an Authentik error is explicitly NOT a reason to fall back:
    "attribute missing" and "could not check" look alike but have opposite
    correct answers. Guessing would cause silent mis-addressing, so we fail
    loudly instead.
    """
    now = time.time()
    hit = _MX_LOCALPART_CACHE.get(username)
    if hit and hit[1] > now:
        return hit[0]

    user = await ak_get_user_by_username(username)
    if not user:
        raise HTTPException(
            500, f"Matrix-Localpart fuer '{username}' nicht aufloesbar "
                 "(Authentik-Nutzer nicht gefunden oder Authentik nicht erreichbar)"
        )
    localpart = (user.get("attributes") or {}).get("matrix_localpart") or username
    _MX_LOCALPART_CACHE[username] = (localpart, now + _MX_LOCALPART_TTL)
    return localpart


async def _mxid(username: str) -> str:
    """Full MXID for a ClaraOS user."""
    return f"@{await _matrix_localpart(username)}:{MATRIX_DOMAIN}"


async def _get_synapse_admin_token() -> str:
    """Returns clara.bot's Matrix access-token (cached). clara.bot is a
    Synapse admin, so this token can drive admin endpoints AND mint
    user-tokens via /admin/v1/users/{user_id}/login.
    """
    now = time.time()
    if _MX_TOKEN_CACHE["token"] and _MX_TOKEN_CACHE["exp"] > now:
        return _MX_TOKEN_CACHE["token"]
    # Login as clara.bot using its stored password
    from database import get_pool
    from encryption import decrypt_credentials
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT credentials FROM claraos_app_credentials "
            "WHERE app_id=$1 AND username=$2",
            "matrix", "clara.bot",
        )
    if not row:
        # Fallback: legacy admin-password flow
        token = await _raw_synapse_login()
    else:
        creds = decrypt_credentials(bytes(row["credentials"]))
        if isinstance(creds, str):
            creds = json.loads(creds)
        payload = {
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": creds["username"]},
            "password": creds["password"],
            "initial_device_display_name": "ClaraOS Admin (clara.bot)",
            # Fixed device_id: otherwise EVERY login creates a new device and
            # Synapse accumulates them without limit (~48/day with a 30-minute
            # cache). With a fixed ID there is exactly one.
            "device_id": "CLARAOS_ADMIN",
        }
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(f"{SYNAPSE_URL}/_matrix/client/v3/login", json=payload)
            # Synapse rate-limits logins per account. That hits exactly when
            # things are busy (several team operations or users in quick
            # succession) — i.e. at the worst moment. Synapse says how long to
            # wait; waiting once is enough.
            if r.status_code == 429:
                wait_ms = 1000
                try:
                    wait_ms = int(r.json().get("retry_after_ms", 1000))
                except Exception:
                    pass
                logger.info("Synapse-Anmeldung fuer clara.bot gedrosselt, warte %d ms", wait_ms)
                await asyncio.sleep(min(wait_ms, 10000) / 1000 + 0.2)
                r = await c.post(f"{SYNAPSE_URL}/_matrix/client/v3/login", json=payload)
        if r.status_code != 200:
            # Fall back to the legacy admin login if clara.bot's creds drift.
            # Warning: the fallback used to swallow the real reason: it reported
            # "No admin Matrix credentials found" and sent everyone debugging
            # to the credentials — even when the actual cause was a rate limit
            # or a network error. The legacy path may not work at all anymore,
            # so the original reason is passed along explicitly.
            grund = f"clara.bot-Anmeldung: {r.status_code} {r.text[:120]}"
            logger.warning("Synapse-Admin-Anmeldung fehlgeschlagen — %s", grund)
            try:
                token = await _raw_synapse_login()
            except HTTPException as exc:
                raise HTTPException(500, f"{grund} | Ausweichweg: {exc.detail}") from exc
        else:
            token = r.json()["access_token"]
    _MX_TOKEN_CACHE["token"] = token
    _MX_TOKEN_CACHE["exp"] = now + 1800
    return token


async def mint_matrix_token_for_user(username: str) -> dict:
    """Mint a fresh Matrix access-token for a user via the Synapse admin API.

    Replaces the password-based m.login.password flow for ClaraOS auto-login —
    no password ever leaves storage, no OIDC roundtrip, just admin-mint.
    Returns {access_token, user_id, type}.
    """
    bot_token = await _get_synapse_admin_token()
    user_id = await _mxid(username)
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(
            f"{SYNAPSE_URL}/_synapse/admin/v1/users/{user_id}/login",
            headers={"Authorization": f"Bearer {bot_token}",
                     "Content-Type": "application/json"},
            json={},  # default valid_until_ms = no expiry
        )
    if r.status_code != 200:
        logger.warning("mint_matrix_token %s: %s %s", user_id, r.status_code, r.text[:200])
        raise HTTPException(500, f"mint failed: {r.status_code}")
    return {
        "type": "matrix_token",
        "access_token": r.json()["access_token"],
        "user_id": user_id,
    }

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/v1/admin/teams", tags=["teams-admin"])

AUTHENTIK_URL = os.environ.get("AUTHENTIK_URL", f"https://auth.{BASE_DOMAIN}")
AUTHENTIK_TOKEN = os.environ.get("AUTHENTIK_API_TOKEN", "")
SYNAPSE_URL = heim_default("SYNAPSE_INTERNAL_URL", key="SYNAPSE_INTERNAL_URL@teams_admin")
# Comes from the domain registry (domains.yaml -> pinned.matrix_server_name).
# A hard-coded literal here would create MXIDs on a server_name that Synapse
# does not own — and an MXID cannot be changed afterwards.
MATRIX_DOMAIN = MATRIX_SERVER_NAME
# Synapse builds this identifier as "oidc-<idp_id>" from homeserver.yaml.
# It is stored in user_external_ids and is the link between the ClaraOS
# identity and the Matrix account — if it is wrong, the first SSO login
# creates a SECOND account and the person ends up with two identities.
MATRIX_AUTH_PROVIDER = os.environ.get("MATRIX_OIDC_PROVIDER_ID", "oidc-authentik")
NEXTCLOUD_URL = heim_default("NEXTCLOUD_INTERNAL_URL")

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]{0,62}[a-z0-9]$")

GROUP_PREFIX = "team-"  # Authentik group-name convention


def _require_admin(user: dict) -> None:
    if user.get("role") != "admin":
        raise HTTPException(403, "admin role required")


# --------------------------------------------------------------------------
# Authentik helpers (source of truth)
# --------------------------------------------------------------------------

def _ak_headers() -> dict:
    if not AUTHENTIK_TOKEN:
        raise HTTPException(500, "AUTHENTIK_API_TOKEN not configured")
    return {"Authorization": f"Bearer {AUTHENTIK_TOKEN}", "Content-Type": "application/json"}


async def ak_get_group_by_name(name: str) -> dict | None:
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.get(f"{AUTHENTIK_URL}/api/v3/core/groups/?name={name}", headers=_ak_headers())
    if r.status_code != 200:
        return None
    for g in r.json().get("results", []):
        if g["name"] == name:
            return g
    return None


async def ak_create_group(name: str, is_superuser: bool = False) -> dict:
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.post(
            f"{AUTHENTIK_URL}/api/v3/core/groups/",
            headers=_ak_headers(),
            json={"name": name, "is_superuser": is_superuser, "attributes": {"claraos_team": True}},
        )
    if r.status_code not in (200, 201):
        raise HTTPException(500, f"Authentik create group failed: {r.status_code} {r.text[:200]}")
    return r.json()


async def ak_delete_group(pk: str) -> None:
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.delete(f"{AUTHENTIK_URL}/api/v3/core/groups/{pk}/", headers=_ak_headers())
    if r.status_code not in (200, 204):
        raise HTTPException(500, f"Authentik delete group failed: {r.status_code}")


async def ak_get_user_by_username(username: str) -> dict | None:
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.get(f"{AUTHENTIK_URL}/api/v3/core/users/?username={username}", headers=_ak_headers())
    if r.status_code != 200:
        return None
    for u in r.json().get("results", []):
        if u["username"] == username:
            return u
    return None


async def ak_add_user_to_group(group_pk: str, user_pk: int) -> None:
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.post(
            f"{AUTHENTIK_URL}/api/v3/core/groups/{group_pk}/add_user/",
            headers=_ak_headers(),
            json={"pk": user_pk},
        )
    if r.status_code not in (200, 204):
        raise HTTPException(500, f"Authentik add user failed: {r.status_code}")


async def ak_remove_user_from_group(group_pk: str, user_pk: int) -> None:
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.post(
            f"{AUTHENTIK_URL}/api/v3/core/groups/{group_pk}/remove_user/",
            headers=_ak_headers(),
            json={"pk": user_pk},
        )
    if r.status_code not in (200, 204):
        raise HTTPException(500, f"Authentik remove user failed: {r.status_code}")


async def ak_list_group_members(group_pk: str) -> list[str]:
    """Return usernames of direct group members."""
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.get(f"{AUTHENTIK_URL}/api/v3/core/groups/{group_pk}/", headers=_ak_headers())
    if r.status_code != 200:
        return []
    obj = r.json()
    # users_obj has [{pk, username, ...}]
    return [u["username"] for u in obj.get("users_obj", [])]


async def mx_list_room_joined_members(room_id: str) -> list[str]:
    """Return usernames (localpart) of users joined to a Matrix room."""
    token = await _get_synapse_admin_token()
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{SYNAPSE_URL}/_synapse/admin/v1/rooms/{room_id}/members",
                        headers={"Authorization": f"Bearer {token}"})
    if r.status_code != 200:
        return []
    members = r.json().get("members", [])
    # "@user:matrix.example.com" → "user"
    out = []
    for m in members:
        if m.startswith("@") and ":" in m:
            out.append(m[1:m.index(":")])
    return out


async def nc_group_list_members(group_id: str) -> list[str]:
    auth = await _nc_admin_auth()
    h = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.get(f"{NEXTCLOUD_URL}/ocs/v1.php/cloud/groups/{group_id}/users",
                        auth=auth, headers=h)
    if r.status_code != 200:
        return []
    return r.json().get("ocs", {}).get("data", {}).get("users", [])


async def mx_ensure_user(username: str) -> bool:
    """Create a ClaraOS user's Matrix account if it is missing.
    Returns: True = newly created, False = already existed.

    Why this is needed: Matrix accounts are otherwise only created on the
    first SSO login at the homeserver. The Teams app, however, signs in via
    the admin mint, which cannot CREATE an account — it gets a 404. For anyone
    who had never logged into Element directly, the app was unusable.

    Critical: the `external_ids` link to the Authentik PK. Without it, a later
    SSO login does NOT find the existing account: Synapse then creates a second
    one (or fails), and the person would have two identities with separate
    rooms. The account deliberately gets NO password — login goes exclusively
    through ClaraOS/Authentik, like accounts created the normal way.
    """
    localpart = await _matrix_localpart(username)
    mxid = f"@{localpart}:{MATRIX_DOMAIN}"
    token = await _get_synapse_admin_token()
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(timeout=20) as c:
        vorhanden = await c.get(f"{SYNAPSE_URL}/_synapse/admin/v2/users/{mxid}", headers=headers)
        if vorhanden.status_code == 200:
            return False  # never overwrite: a PUT would replace the external_ids
        if vorhanden.status_code != 404:
            raise HTTPException(500, f"mx_ensure {mxid}: Abfrage {vorhanden.status_code}")

        ak_user = await ak_get_user_by_username(username)
        if not ak_user:
            raise HTTPException(
                500, f"mx_ensure {username}: kein Authentik-Nutzer gefunden — "
                     "ohne dessen PK gaebe es keine Verknuepfung und damit eine zweite Identitaet")

        r = await c.put(
            f"{SYNAPSE_URL}/_synapse/admin/v2/users/{mxid}",
            headers=headers,
            json={
                "displayname": ak_user.get("name") or username,
                "external_ids": [{
                    "auth_provider": MATRIX_AUTH_PROVIDER,
                    "external_id": str(ak_user["pk"]),
                }],
            },
        )
    if r.status_code not in (200, 201):
        raise HTTPException(500, f"mx_ensure {mxid}: {r.status_code} {r.text[:160]}")
    logger.info("Matrix-Konto angelegt: %s (Authentik-PK %s)", mxid, ak_user["pk"])
    return True


async def mx_join_user(room_id: str, username: str) -> str:
    """Join a user into a room. Returns: "joined" | "absent".

    Important: this must report the real outcome. If failures were only
    logged, callers would count every attempt as a success — a status that
    is green even when nothing happened is not a measurement.

    "absent" is NOT an error but a state of its own: Matrix accounts are only
    created on the first SSO login. Someone who has never logged in cannot be
    joined into a room — they are waiting for that, not for a fix. Real
    errors (network, permissions) raise instead.
    """
    token = await _get_synapse_admin_token()
    user_id = await _mxid(username)
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{SYNAPSE_URL}/_synapse/admin/v1/join/{room_id}",
                         headers={"Authorization": f"Bearer {token}"},
                         json={"user_id": user_id})
    if r.status_code in (200, 403):  # 403 = already a member
        return "joined"
    if r.status_code == 404 or "M_NOT_FOUND" in r.text:
        logger.info("mx_join %s → %s: Konto existiert noch nicht (kein Matrix-Login bisher)",
                    user_id, room_id)
        return "absent"
    raise HTTPException(500, f"mx_join {user_id} → {room_id}: {r.status_code} {r.text[:160]}")


# --------------------------------------------------------------------------
# Matrix helpers
# --------------------------------------------------------------------------

async def mx_create_space(name: str, alias_localpart: str, topic: str = "") -> tuple[str, str]:
    """Create a Matrix Space + its default text room. Returns (space_id, room_id)."""
    token = await _get_synapse_admin_token()
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=15) as c:
        # 1. Space
        r = await c.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/createRoom",
            headers=headers,
            json={
                "name": name,
                "topic": topic,
                "preset": "private_chat",
                "visibility": "private",
                "creation_content": {"type": "m.space"},
                "power_level_content_override": {
                    "users_default": 0,
                    "events_default": 50,
                    "state_default": 50,
                    "invite": 50,
                    "kick": 50,
                    "ban": 50,
                    "redact": 50,
                    "events": {"m.room.name": 100, "m.room.power_levels": 100},
                },
            },
        )
        if r.status_code != 200:
            raise HTTPException(500, f"Matrix space create failed: {r.status_code} {r.text[:200]}")
        space_id = r.json()["room_id"]

        # 2. Main chat room inside space
        r2 = await c.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/createRoom",
            headers=headers,
            json={
                "name": f"{name} — General",
                "preset": "private_chat",
                "visibility": "private",
                "room_alias_name": f"{alias_localpart}-general",
            },
        )
        if r2.status_code != 200:
            raise HTTPException(500, f"Matrix main-room create failed: {r2.status_code}")
        room_id = r2.json()["room_id"]

        # 3. Link room as child of space
        await c.put(
            f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{room_id}",
            headers=headers,
            json={"via": [MATRIX_DOMAIN]},
        )
    return space_id, room_id


async def mx_link_child_space(parent_space_id: str, child_space_id: str) -> None:
    token = await _get_synapse_admin_token()
    async with httpx.AsyncClient(timeout=10) as c:
        await c.put(
            f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{parent_space_id}/state/m.space.child/{child_space_id}",
            headers={"Authorization": f"Bearer {token}"},
            json={"via": [MATRIX_DOMAIN]},
        )


async def mx_invite_user(room_id: str, username: str) -> None:
    token = await _get_synapse_admin_token()
    user_id = await _mxid(username)
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{room_id}/invite",
            headers={"Authorization": f"Bearer {token}"},
            json={"user_id": user_id},
        )
    if r.status_code not in (200, 403):  # 403 = already joined, OK
        logger.warning("Matrix invite %s to %s: %s", username, room_id, r.status_code)


async def mx_kick_localpart(room_id: str, localpart: str) -> None:
    """Kick by Matrix localpart. mx_list_room_joined_members returns localparts,
    not ClaraOS usernames — there is no reliable reverse mapping, so we work
    directly on the MXID here."""
    token = await _get_synapse_admin_token()
    user_id = f"@{localpart}:{MATRIX_DOMAIN}"
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{room_id}/kick",
            headers={"Authorization": f"Bearer {token}"},
            json={"user_id": user_id, "reason": "team membership removed"},
        )
    if r.status_code not in (200, 403):
        logger.warning("Matrix kick %s from %s: %s", user_id, room_id, r.status_code)


async def mx_kick_user(room_id: str, username: str) -> None:
    token = await _get_synapse_admin_token()
    user_id = await _mxid(username)
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{room_id}/kick",
            headers={"Authorization": f"Bearer {token}"},
            json={"user_id": user_id, "reason": "team membership removed"},
        )
    if r.status_code not in (200, 403):
        logger.warning("Matrix kick %s from %s: %s", username, room_id, r.status_code)


async def mx_delete_room(room_id: str) -> None:
    """Shutdown a room via Synapse admin API (full purge)."""
    token = await _get_synapse_admin_token()
    async with httpx.AsyncClient(timeout=30) as c:
        # httpx.AsyncClient.delete() does not accept json= — use request() directly.
        r = await c.request(
            "DELETE",
            f"{SYNAPSE_URL}/_synapse/admin/v2/rooms/{room_id}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            content=json.dumps({"purge": True}),
        )
    if r.status_code not in (200, 404):
        logger.warning("Matrix delete room %s: %s %s", room_id, r.status_code, r.text[:200])


# --------------------------------------------------------------------------
# NC Circles helpers
# --------------------------------------------------------------------------

async def _nc_auth_as(username: str) -> tuple[str, str]:
    """Fetch (user, pass) from claraos_app_credentials for a specific user."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT credentials FROM claraos_app_credentials WHERE app_id=$1 AND username=$2",
            "nextcloud", username,
        )
    if not row:
        raise HTTPException(500, f"No NC credentials for {username}")
    creds = decrypt_credentials(bytes(row["credentials"]))
    if isinstance(creds, str):
        creds = json.loads(creds)
    # Warning: password MUST be the real NC login password, not an app token —
    # only password logins set last-password-confirm; token logins fail with
    # 403 on EVERY PasswordConfirmationRequired endpoint in NC>=32.
    return creds["username"], creds["password"]


async def _nc_auth() -> tuple[str, str]:
    """Regular (non-admin) NC auth as the owner account — for Circles + profile queries."""
    return await _nc_auth_as(OWNER_USER)


async def _nc_admin_auth() -> tuple[str, str]:
    """NC admin auth as clara.bot — required for Groups + GroupFolders operations."""
    return await _nc_auth_as("clara.bot")


async def nc_list_circles() -> list[dict]:
    auth = await _nc_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.get(f"{NEXTCLOUD_URL}/ocs/v2.php/apps/circles/circles", auth=auth, headers=headers)
    if r.status_code != 200:
        return []
    return r.json().get("ocs", {}).get("data", [])


async def nc_create_circle(name: str) -> str:
    auth = await _nc_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(
            f"{NEXTCLOUD_URL}/ocs/v2.php/apps/circles/circles",
            auth=auth, headers=headers,
            json={"name": name, "personal": False, "local": True},
        )
    if r.status_code not in (200, 201):
        raise HTTPException(500, f"NC circle create failed: {r.status_code} {r.text[:200]}")
    return r.json().get("ocs", {}).get("data", {}).get("id", "")


async def nc_add_member(circle_id: str, username: str) -> None:
    auth = await _nc_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(
            f"{NEXTCLOUD_URL}/ocs/v2.php/apps/circles/circles/{circle_id}/members",
            auth=auth, headers=headers,
            json={"userId": username, "type": 1},  # type=1 = user
        )
    if r.status_code not in (200, 201):
        logger.warning("NC add %s to %s: %s %s", username, circle_id, r.status_code, r.text[:200])


async def nc_remove_member(circle_id: str, member_id: str) -> None:
    """member_id is the NC-internal id, not username. Caller must resolve first."""
    auth = await _nc_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.delete(
            f"{NEXTCLOUD_URL}/ocs/v2.php/apps/circles/circles/{circle_id}/members/{member_id}",
            auth=auth, headers=headers,
        )
    if r.status_code not in (200, 204):
        logger.warning("NC remove %s from %s: %s", member_id, circle_id, r.status_code)


async def nc_list_members(circle_id: str) -> list[dict]:
    auth = await _nc_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.get(
            f"{NEXTCLOUD_URL}/ocs/v2.php/apps/circles/circles/{circle_id}/members",
            auth=auth, headers=headers,
        )
    if r.status_code != 200:
        return []
    return r.json().get("ocs", {}).get("data", [])


async def nc_delete_circle(circle_id: str) -> None:
    auth = await _nc_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.delete(
            f"{NEXTCLOUD_URL}/ocs/v2.php/apps/circles/circles/{circle_id}",
            auth=auth, headers=headers,
        )
    if r.status_code not in (200, 204, 404):
        logger.warning("NC delete circle %s: %s", circle_id, r.status_code)


# --------------------------------------------------------------------------
# NC Groups + GroupFolders — separate from Circles; required because
# GroupFolders only accept classic NC-Groups for ACL, not Circles.
# Convention: team-{slug} NC-Group is kept in sync with Authentik-Group.
# --------------------------------------------------------------------------

def nc_group_name(slug: str) -> str:
    return f"team-{slug}"


async def nc_group_exists(group_id: str) -> bool:
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.get(f"{NEXTCLOUD_URL}/ocs/v1.php/cloud/groups?search={group_id}",
                        auth=auth, headers=headers)
    groups = r.json().get("ocs", {}).get("data", {}).get("groups", []) if r.status_code == 200 else []
    return group_id in groups


async def nc_group_create(group_id: str) -> None:
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.post(f"{NEXTCLOUD_URL}/ocs/v1.php/cloud/groups",
                         auth=auth, headers=headers,
                         data={"groupid": group_id})
    if r.status_code not in (200, 201):
        # 102 = group already exists
        if "already exists" not in r.text:
            raise HTTPException(500, f"NC create group {group_id}: {r.status_code} {r.text[:200]}")


async def nc_group_add_user(group_id: str, username: str) -> None:
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.post(f"{NEXTCLOUD_URL}/ocs/v1.php/cloud/users/{username}/groups",
                         auth=auth, headers=headers,
                         data={"groupid": group_id})
    if r.status_code not in (200, 201):
        logger.warning("NC group add %s → %s: %s %s", username, group_id, r.status_code, r.text[:150])


async def nc_group_remove_user(group_id: str, username: str) -> None:
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.request("DELETE",
                            f"{NEXTCLOUD_URL}/ocs/v1.php/cloud/users/{username}/groups",
                            auth=auth, headers=headers,
                            data={"groupid": group_id})
    if r.status_code not in (200, 204):
        logger.warning("NC group remove %s ← %s: %s", username, group_id, r.status_code)


async def nc_group_delete(group_id: str) -> None:
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.delete(f"{NEXTCLOUD_URL}/ocs/v1.php/cloud/groups/{group_id}",
                           auth=auth, headers=headers)
    if r.status_code not in (200, 204, 404):
        logger.warning("NC delete group %s: %s", group_id, r.status_code)


async def nc_gf_create(mountpoint: str) -> int:
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(f"{NEXTCLOUD_URL}/apps/groupfolders/folders",
                         auth=auth, headers=headers,
                         data={"mountpoint": mountpoint})
    if r.status_code not in (200, 201):
        raise HTTPException(500, f"NC groupfolder create failed: {r.status_code} {r.text[:200]}")
    data = r.json().get("ocs", {}).get("data", {})
    return int(data.get("id", 0))


async def nc_gf_assign_group(folder_id: int, group_id: str) -> None:
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(f"{NEXTCLOUD_URL}/apps/groupfolders/folders/{folder_id}/groups",
                         auth=auth, headers=headers,
                         data={"group": group_id})
    if r.status_code not in (200, 201):
        logger.warning("NC gf assign %s → folder %s: %s", group_id, folder_id, r.status_code)
    # Grant full permissions (read+write+share+delete = 31)
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r2 = await c.post(f"{NEXTCLOUD_URL}/apps/groupfolders/folders/{folder_id}/groups/{group_id}",
                          auth=auth, headers=headers,
                          data={"permissions": 31})
    if r2.status_code not in (200, 201):
        logger.warning("NC gf perms %s on folder %s: %s", group_id, folder_id, r2.status_code)


async def nc_gf_delete(folder_id: int) -> None:
    auth = await _nc_admin_auth()
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.delete(f"{NEXTCLOUD_URL}/apps/groupfolders/folders/{folder_id}",
                           auth=auth, headers=headers)
    if r.status_code not in (200, 204, 404):
        logger.warning("NC delete groupfolder %s: %s", folder_id, r.status_code)


# --------------------------------------------------------------------------
# NC Deck — Kanban board per team, shared with team-{slug} NC-Group
# --------------------------------------------------------------------------

async def nc_deck_create(title: str, color: str = "0082c9") -> int | None:
    auth = await _nc_admin_auth()
    h = {"OCS-APIRequest": "true", "Accept": "application/json", "Content-Type": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(f"{NEXTCLOUD_URL}/apps/deck/api/v1.0/boards",
                         auth=auth, headers=h, json={"title": title, "color": color})
    if r.status_code not in (200, 201):
        logger.warning("Deck create: %s %s", r.status_code, r.text[:200])
        return None
    return r.json().get("id")


async def nc_deck_share_group(board_id: int, group_id: str) -> None:
    auth = await _nc_admin_auth()
    h = {"OCS-APIRequest": "true", "Accept": "application/json", "Content-Type": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(f"{NEXTCLOUD_URL}/apps/deck/api/v1.0/boards/{board_id}/acl",
                         auth=auth, headers=h,
                         json={"type": 1, "participant": group_id,
                               "permissionEdit": True, "permissionShare": False, "permissionManage": False})
    if r.status_code not in (200, 201):
        logger.warning("Deck share %s → %s: %s", group_id, board_id, r.status_code)


async def nc_deck_delete(board_id: int) -> None:
    auth = await _nc_admin_auth()
    h = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.delete(f"{NEXTCLOUD_URL}/apps/deck/api/v1.0/boards/{board_id}",
                           auth=auth, headers=h)
    if r.status_code not in (200, 204, 404):
        logger.warning("Deck delete %s: %s", board_id, r.status_code)


# --------------------------------------------------------------------------
# NC Collectives — wiki per team. Creates its own auto-Circle (not linked to
# our team-{slug} Circle from B.1; known MVP limitation, member-sync manual).
# --------------------------------------------------------------------------

async def nc_collective_create(name: str) -> tuple[int | None, str | None]:
    """Create Collective. Returns (id, circleId) — Collective creates its own
    auto-Circle that must be tracked to sync members.
    """
    auth = await _nc_admin_auth()
    h = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(f"{NEXTCLOUD_URL}/ocs/v2.php/apps/collectives/api/v1.0/collectives",
                         auth=auth, headers=h, data={"name": name})
    if r.status_code != 200:
        logger.warning("Collective create %s: %s %s", name, r.status_code, r.text[:200])
        return None, None
    d = r.json().get("ocs", {}).get("data", {}).get("collective", {})
    return d.get("id"), d.get("circleId")


async def nc_circle_add_member_by_circle_id(circle_id: str, username: str) -> bool:
    """Add a NC user to an existing Circle (used for Collective's auto-Circle).

    Warning: runs as clara.bot, NOT as the regular owner account. "The circles
    API works as a regular user" is only half true: it works for Circles the
    caller is a member of. A Collective's auto-Circle, however, is created by
    `nc_collective_create` via `_nc_admin_auth()`, i.e. clara.bot — which is its
    sole owner. As any other user, every call returns 403 and the Circle never
    gains members beyond clara.bot.
    Rule: whoever created the resource must also maintain it.
    """
    auth = await _nc_admin_auth()
    h = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        r = await c.post(f"{NEXTCLOUD_URL}/ocs/v2.php/apps/circles/circles/{circle_id}/members",
                         auth=auth, headers=h, json={"userId": username, "type": 1})
    if r.status_code not in (200, 201):
        logger.warning("Circle add %s → %s: %s %s", username, circle_id,
                       r.status_code, r.text[:120])
        return False
    return True


async def nc_circle_remove_member_by_username(circle_id: str, username: str) -> None:
    """Resolve member-id by username then remove from Circle.
    Runs as clara.bot — see nc_circle_add_member_by_circle_id for why."""
    auth = await _nc_admin_auth()
    h = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=10) as c:
        rl = await c.get(f"{NEXTCLOUD_URL}/ocs/v2.php/apps/circles/circles/{circle_id}/members",
                         auth=auth, headers=h)
        if rl.status_code != 200:
            return
        for m in rl.json().get("ocs", {}).get("data", []):
            if m.get("userId") == username and "id" in m:
                await c.delete(f"{NEXTCLOUD_URL}/ocs/v2.php/apps/circles/circles/{circle_id}/members/{m['id']}",
                               auth=auth, headers=h)
                return


async def nc_collective_delete(cid: int) -> None:
    """Two-step: move to trash, then permanent delete."""
    auth = await _nc_admin_auth()
    h = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        await c.delete(f"{NEXTCLOUD_URL}/ocs/v2.php/apps/collectives/api/v1.0/collectives/{cid}",
                       auth=auth, headers=h)  # → trash
        r = await c.delete(f"{NEXTCLOUD_URL}/ocs/v2.php/apps/collectives/api/v1.0/collectives/trash/{cid}",
                           auth=auth, headers=h)  # → purge
    if r.status_code not in (200, 204, 404):
        logger.warning("Collective delete %s: %s", cid, r.status_code)


# --------------------------------------------------------------------------
# NC Calendar (CalDAV MKCALENDAR). Owner = clara.bot, users subscribe/share
# manually via NC UI. Auto-group-sharing is TODO (CalDAV SHARE draft or
# NC-specific davxml+share).
# --------------------------------------------------------------------------

CALDAV_OWNER = "clara.bot"


def _caldav_uri(cal_id: str) -> str:
    return f"/remote.php/dav/calendars/{CALDAV_OWNER}/{cal_id}/"


async def nc_calendar_create(cal_id: str, display_name: str) -> str | None:
    auth = await _nc_admin_auth()
    xml_body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
        '<D:set><D:prop>'
        f'<D:displayname>{display_name}</D:displayname>'
        '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>'
        '</D:prop></D:set>'
        '</C:mkcalendar>'
    )
    url = NEXTCLOUD_URL + _caldav_uri(cal_id)
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.request("MKCALENDAR", url, auth=auth,
                            headers={"Content-Type": "application/xml; charset=utf-8"},
                            content=xml_body)
    if r.status_code not in (200, 201):
        logger.warning("MKCALENDAR %s: %s %s", cal_id, r.status_code, r.text[:200])
        return None
    return _caldav_uri(cal_id)


async def nc_calendar_share_group(cal_uri: str, group_id: str, common_name: str) -> None:
    """Share a NC Calendar (owned by clara.bot) with an NC-Group read-write.

    Uses NC's custom DAV POST + <OC:share> XML body (not standard CalDAV).
    Discovery: PROPPATCH + <OC:invite> fails (500), but POST + <OC:share> works
    (200). NC 32/Calendar-6.2.2.
    """
    auth = await _nc_admin_auth()
    xml = (
        '<?xml version="1.0"?>'
        '<OC:share xmlns:OC="http://owncloud.org/ns" xmlns:D="DAV:">'
        '<OC:set>'
        f'<D:href>principal:principals/groups/{group_id}</D:href>'
        f'<OC:common-name>{common_name}</OC:common-name>'
        '<OC:read-write/>'
        '</OC:set>'
        '</OC:share>'
    )
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.post(NEXTCLOUD_URL + cal_uri, auth=auth,
                         content=xml,
                         headers={"Content-Type": "application/xml; charset=utf-8"})
    if r.status_code not in (200, 201):
        logger.warning("Calendar share %s → %s: %s %s", cal_uri, group_id, r.status_code, r.text[:200])


async def nc_calendar_delete(cal_uri: str) -> None:
    auth = await _nc_admin_auth()
    async with httpx.AsyncClient(verify=False, timeout=15) as c:
        r = await c.delete(NEXTCLOUD_URL + cal_uri, auth=auth)
    if r.status_code not in (200, 204, 404):
        logger.warning("Calendar delete %s: %s", cal_uri, r.status_code)


# --------------------------------------------------------------------------
# DB helpers
# --------------------------------------------------------------------------

async def _audit(team_id, actor: str, event_type: str, target: str | None = None, details: dict | None = None) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO claraos_team_audit(team_id, actor_username, event_type, target_username, details)"
            " VALUES ($1,$2,$3,$4,$5)",
            team_id, actor, event_type, target, json.dumps(details or {}),
        )


async def _get_team_by_slug(slug: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchrow("SELECT * FROM claraos_teams WHERE slug=$1", slug)


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------

class CreateTeamBody(BaseModel):
    slug: str = Field(..., description="lowercase a-z0-9.- — used for Authentik group name + Matrix alias")
    name: str
    description: str | None = None
    parent_slug: str | None = None
    inherit_members: bool = False
    include_clara_bot: bool = False
    with_nc_circle: bool = True
    with_groupfolder: bool = False
    with_calendar: bool = False
    with_deck: bool = False
    with_collective: bool = False


class AddMemberBody(BaseModel):
    username: str


@router.post("")
async def create_team(body: CreateTeamBody, request: Request) -> dict:
    user = get_current_user(request)
    _require_admin(user)

    if not SLUG_RE.match(body.slug):
        raise HTTPException(400, "slug must match ^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$")

    pool = await get_pool()
    async with pool.acquire() as conn:
        # Parent lookup
        parent_id = None
        if body.parent_slug:
            prow = await conn.fetchrow("SELECT id FROM claraos_teams WHERE slug=$1", body.parent_slug)
            if not prow:
                raise HTTPException(404, f"parent slug '{body.parent_slug}' not found")
            parent_id = prow["id"]
        # Duplicate check
        if await conn.fetchval("SELECT 1 FROM claraos_teams WHERE slug=$1", body.slug):
            raise HTTPException(409, "slug already exists")

    # 1. Authentik group (master) — creator auto-joins as first member so they
    # see the team in /me/resources and count as member for all mirror ops.
    group_name = f"{GROUP_PREFIX}{body.slug}"
    existing = await ak_get_group_by_name(group_name)
    if existing:
        ak_group = existing
    else:
        ak_group = await ak_create_group(group_name)
    creator_ak = await ak_get_user_by_username(user["username"])
    if creator_ak:
        try:
            await ak_add_user_to_group(ak_group["pk"], creator_ak["pk"])
        except Exception as exc:
            logger.warning("creator self-add to group failed: %s", exc)

    # 2. Matrix space + main room
    try:
        space_id, main_room_id = await mx_create_space(
            name=body.name,
            alias_localpart=f"team-{body.slug.replace('.', '-')}",
            topic=body.description or "",
        )
        # Link to parent space if hierarchical
        if parent_id:
            async with pool.acquire() as conn:
                parent_space = await conn.fetchval(
                    "SELECT matrix_space_id FROM claraos_teams WHERE id=$1", parent_id
                )
            if parent_space:
                await mx_link_child_space(parent_space, space_id)
    except Exception as exc:
        logger.error("Matrix space create failed: %s", exc)
        # Leave Authentik group standing — sync-daemon will retry or admin removes manually
        space_id, main_room_id = None, None

    # 3. Optional NC circle
    nc_circle_id = None
    if body.with_nc_circle:
        try:
            nc_circle_id = await nc_create_circle(body.name)
        except Exception as exc:
            logger.error("NC circle create failed: %s", exc)

    # 4. Optional GroupFolder — requires a classic NC-Group (not Circle) for ACL.
    # We create `team-{slug}` NC-Group and keep it in sync alongside the Circle.
    # (NC-Group is also reused by Deck-share below, so we create it once here
    #  when ANY NC-Group-based resource is requested.)
    nc_groupfolder_id = None
    # NC-Group is prerequisite for GroupFolder-ACL, Deck-share, and Calendar-share.
    nc_group_needed = body.with_groupfolder or body.with_deck or body.with_calendar
    if nc_group_needed:
        try:
            await nc_group_create(nc_group_name(body.slug))
            await nc_group_add_user(nc_group_name(body.slug), user["username"])
        except Exception as exc:
            logger.error("NC group create failed: %s", exc)
    if body.with_groupfolder:
        try:
            nc_groupfolder_id = await nc_gf_create(body.name)
            if nc_groupfolder_id:
                await nc_gf_assign_group(nc_groupfolder_id, nc_group_name(body.slug))
        except Exception as exc:
            logger.error("NC groupfolder create failed: %s", exc)

    # 4b. Optional Deck board — shared with team-{slug} NC-Group
    nc_deck_board_id = None
    if body.with_deck:
        try:
            nc_deck_board_id = await nc_deck_create(body.name)
            if nc_deck_board_id:
                await nc_deck_share_group(nc_deck_board_id, nc_group_name(body.slug))
        except Exception as exc:
            logger.error("Deck create failed: %s", exc)

    # 4c. Optional Calendar — owner clara.bot, auto-shared with team-{slug}
    # NC-Group (always present if with_calendar, see nc_group_needed above).
    nc_calendar_uri = None
    if body.with_calendar:
        try:
            nc_calendar_uri = await nc_calendar_create(f"team-{body.slug}", body.name)
            if nc_calendar_uri:
                await nc_calendar_share_group(nc_calendar_uri, nc_group_name(body.slug), body.name)
        except Exception as exc:
            logger.error("Calendar create/share failed: %s", exc)

    # 4d. Optional Collective — auto-creates own Circle; we persist its
    # circleId to keep members in sync with Authentik-group.
    nc_collective_id = None
    nc_collective_circle_id = None
    if body.with_collective:
        try:
            nc_collective_id, nc_collective_circle_id = await nc_collective_create(f"team-{body.slug}")
        except Exception as exc:
            logger.error("Collective create failed: %s", exc)

    # 5. DB row
    async with pool.acquire() as conn:
        team_id = await conn.fetchval(
            """
            INSERT INTO claraos_teams
                (slug, name, description, parent_team_id, authentik_group_pk,
                 matrix_space_id, matrix_main_room_id, nc_circle_id, nc_groupfolder_id,
                 nc_calendar_uri, nc_deck_board_id, nc_collective_id, nc_collective_circle_id,
                 inherit_members, include_clara_bot, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
            RETURNING id
            """,
            body.slug, body.name, body.description, parent_id, ak_group["pk"],
            space_id, main_room_id, nc_circle_id, nc_groupfolder_id,
            nc_calendar_uri, nc_deck_board_id, nc_collective_id, nc_collective_circle_id,
            body.inherit_members, body.include_clara_bot, user["username"],
        )

    await _audit(team_id, user["username"], "create",
                 details={"slug": body.slug, "ak_group_pk": ak_group["pk"],
                          "matrix_space_id": space_id, "nc_circle_id": nc_circle_id,
                          "nc_groupfolder_id": nc_groupfolder_id,
                          "nc_calendar_uri": nc_calendar_uri,
                          "nc_deck_board_id": nc_deck_board_id,
                          "nc_collective_id": nc_collective_id})

    return {"id": str(team_id), "slug": body.slug,
            "authentik_group_pk": ak_group["pk"],
            "matrix_space_id": space_id,
            "matrix_main_room_id": main_room_id,
            "nc_circle_id": nc_circle_id,
            "nc_groupfolder_id": nc_groupfolder_id,
            "nc_calendar_uri": nc_calendar_uri,
            "nc_deck_board_id": nc_deck_board_id,
            "nc_collective_id": nc_collective_id,
            "nc_collective_circle_id": nc_collective_circle_id}


# --------------------------------------------------------------------------
# Sync Daemon — heals drift between Authentik (source) and Matrix/NC mirrors
# --------------------------------------------------------------------------

async def sync_one_team(team: dict) -> dict:
    """Apply Authentik members as source-of-truth to Matrix-space + main-room
    + NC-Group (for groupfolder/deck). Idempotent; returns delta-summary.

    Does NOT touch Circles or Collective member-sync — those have their own
    patterns (Circle is created via OCS, Collective has its own auto-Circle).
    """
    # `pending` = requested, but the user has no Matrix account yet (it is only
    # created on the first SSO login). Deliberately separate from `errors`:
    # there is nothing to fix, only a login is missing.
    summary = {"slug": team["slug"], "added": [], "removed": [], "pending": [],
               "created": [], "errors": []}
    ak_pk = team["authentik_group_pk"]
    if not ak_pk:
        return summary
    try:
        ak_members = set(await ak_list_group_members(ak_pk))
    except Exception as exc:
        summary["errors"].append(f"ak_list: {exc}")
        return summary

    # Matrix-Space + Main-Room
    #
    # Warning: TWO namespaces meet here: ak_members holds ClaraOS usernames
    # (`jdoe`), mx_list_room_joined_members returns Matrix localparts
    # (`john.doe`). They are not necessarily identical. Comparing them directly
    # causes two bugs at once: EVERY member counts as missing (endless invites)
    # and EVERY Matrix member as surplus (kick) — and the protected list does
    # not apply because the user has a different name there.
    # Therefore both sides are mapped to ONE namespace before comparing.
    lp_by_user: dict[str, str] = {}
    for u in ak_members:
        try:
            lp_by_user[u] = await _matrix_localpart(u)
        except Exception as exc:
            summary["errors"].append(f"localpart_{u}: {exc}")
    ak_localparts = set(lp_by_user.values())

    # Never kick service/owner accounts from rooms — also as localparts,
    # otherwise the list protects a name that does not exist in Matrix.
    protected_lp: set[str] = set()
    for svc in (OWNER_USER, "clara.bot"):
        try:
            protected_lp.add(await _matrix_localpart(svc))
        except Exception:
            protected_lp.add(svc)  # no Authentik account (e.g. the bot)

    for rid, label in [(team["matrix_space_id"], "space"), (team["matrix_main_room_id"], "room")]:
        if not rid:
            continue
        try:
            mx_members = set(await mx_list_room_joined_members(rid))
        except Exception as exc:
            summary["errors"].append(f"mx_list_{label}: {exc}")
            continue
        for u, lp in lp_by_user.items():
            if lp in mx_members:
                continue
            try:
                ergebnis = await mx_join_user(rid, u)
                if ergebnis == "absent":
                    # No Matrix account — create one and retry.
                    # Just "waiting for the first login" would be a dead end:
                    # the Teams app signs in via the admin mint, which cannot
                    # create an account. Anyone who never logged into Element
                    # directly could otherwise never use the app.
                    if await mx_ensure_user(u):
                        summary["created"].append(u)
                    ergebnis = await mx_join_user(rid, u)
                if ergebnis == "joined":
                    summary["added"].append(f"mx_{label}:{u}")
                else:
                    summary["pending"].append(f"mx_{label}:{u}")
            except Exception as exc:
                summary["errors"].append(f"mx_join_{label}_{u}: {exc}")
        for lp in mx_members - ak_localparts:
            if lp in protected_lp:
                continue
            try:
                await mx_kick_localpart(rid, lp)
                summary["removed"].append(f"mx_{label}:{lp}")
            except Exception as exc:
                summary["errors"].append(f"mx_kick_{label}_{lp}: {exc}")

    # Collective-auto-Circle (if team has a Collective)
    if team.get("nc_collective_circle_id"):
        coll_cid = team["nc_collective_circle_id"]
        try:
            auth = await _nc_admin_auth()
            h = {"OCS-APIRequest": "true", "Accept": "application/json"}
            async with httpx.AsyncClient(verify=False, timeout=15) as c:
                rr = await c.get(f"{NEXTCLOUD_URL}/ocs/v2.php/apps/circles/circles/{coll_cid}/members",
                                 auth=auth, headers=h)
            # Warning: do not write `... if rr.status_code == 200 else []`: an
            # error would become an empty member list. The sync would conclude
            # that NOBODY is in the Circle and re-add everyone on EVERY run. Each
            # of those adds may be a 403, and Nextcloud's BruteForceMiddleware
            # counts them: after ~30 attempts it blocks the entire Circles API for
            # this address (429 "Reached maximum delay"), so reading fails too —
            # a self-sustaining loop.
            # An error that looks like "empty" is the most dangerous kind: it
            # looks like "nothing to do" and yet triggers action.
            if rr.status_code != 200:
                raise RuntimeError(
                    f"Mitglieder des Collective-Circle nicht lesbar: HTTP {rr.status_code} "
                    f"{rr.text[:120]} — NICHT als leere Liste behandelt")
            coll_members_data = rr.json().get("ocs", {}).get("data", [])
            coll_members = {m["userId"] for m in coll_members_data if m.get("userId") and m.get("userType") == 1}
            for u in ak_members - coll_members:
                if await nc_circle_add_member_by_circle_id(coll_cid, u):
                    summary["added"].append(f"coll_circle:{u}")
                else:
                    summary["pending"].append(f"coll_circle:{u}")
            for u in coll_members - ak_members:
                if u in (OWNER_USER, "clara.bot"):
                    continue
                await nc_circle_remove_member_by_username(coll_cid, u)
                summary["removed"].append(f"coll_circle:{u}")
        except Exception as exc:
            summary["errors"].append(f"coll_sync: {exc}")

    # NC-Group (only if groupfolder or deck uses it)
    if team["nc_groupfolder_id"] or team["nc_deck_board_id"]:
        gn = nc_group_name(team["slug"])
        try:
            nc_members = set(await nc_group_list_members(gn))
        except Exception as exc:
            summary["errors"].append(f"nc_group_list: {exc}")
            nc_members = set()
        for u in ak_members - nc_members:
            try:
                await nc_group_add_user(gn, u)
                summary["added"].append(f"nc_group:{u}")
            except Exception as exc:
                summary["errors"].append(f"nc_group_add_{u}: {exc}")
        for u in nc_members - ak_members:
            if u in (OWNER_USER, "clara.bot"):
                continue
            try:
                await nc_group_remove_user(gn, u)
                summary["removed"].append(f"nc_group:{u}")
            except Exception as exc:
                summary["errors"].append(f"nc_group_rm_{u}: {exc}")
    return summary


async def sync_all_teams_once() -> list[dict]:
    """Iterate all active teams, sync each, return summaries."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        teams = await conn.fetch("SELECT * FROM claraos_teams WHERE status='active'")
    results = []
    for t in teams:
        s = await sync_one_team(dict(t))
        results.append(s)
        # Audit entry only if there were changes or errors
        if s["added"] or s["removed"] or s["errors"] or s["created"]:
            await _audit(t["id"], "sync-daemon",
                         "sync_ok" if not s["errors"] else "sync_error",
                         details=s)
    return results


_SYNC_TASK: asyncio.Task | None = None


async def _sync_loop():
    """Background loop: every 300s sync all teams."""
    interval = int(os.environ.get("TEAMS_SYNC_INTERVAL", "300"))
    logger.info("Teams sync-daemon started, interval=%ss", interval)
    while True:
        try:
            await asyncio.sleep(interval)
            results = await sync_all_teams_once()
            n_changes = sum(1 for r in results if r["added"] or r["removed"])
            n_errors = sum(1 for r in results if r["errors"])
            if n_changes or n_errors:
                logger.info("Sync pass: %d teams, %d with changes, %d with errors",
                            len(results), n_changes, n_errors)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Sync loop error: %s", exc)


def start_sync_daemon() -> None:
    global _SYNC_TASK
    import asyncio as _a
    if _SYNC_TASK is None or _SYNC_TASK.done():
        _SYNC_TASK = _a.create_task(_sync_loop())


@router.post("/sync-all")
async def sync_all_now(request: Request) -> dict:
    """Admin-triggered immediate sync of every team."""
    user = get_current_user(request)
    _require_admin(user)
    results = await sync_all_teams_once()
    total_added = sum(len(r["added"]) for r in results)
    total_removed = sum(len(r["removed"]) for r in results)
    total_errors = sum(len(r["errors"]) for r in results)
    return {
        "teams": len(results),
        "added": total_added,
        "removed": total_removed,
        "errors": total_errors,
        "per_team": results,
    }


@router.post("/{slug}/sync")
async def sync_one(slug: str, request: Request) -> dict:
    user = get_current_user(request)
    _require_admin(user)
    team = await _get_team_by_slug(slug)
    if not team:
        raise HTTPException(404, "team not found")
    summary = await sync_one_team(dict(team))
    if summary["added"] or summary["removed"] or summary["errors"] or summary["created"]:
        await _audit(team["id"], user["username"],
                     "sync_ok" if not summary["errors"] else "sync_error",
                     details=summary)
    return summary


@router.get("/me/resources")
async def get_my_resources(request: Request) -> list[dict]:
    """Return all teams (with resources) where caller is an Authentik-group member.
    Used by the Teams-App Mobile/Desktop channel tabs to know which NC URLs to render.
    NOTE: must be registered BEFORE /{slug} routes below, otherwise FastAPI
    matches `slug=me` and returns 404.
    """
    user = get_current_user(request)
    username = user.get("username")
    if not username:
        return []
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM claraos_teams WHERE status='active'")
    out = []
    nc_public = domain_url("nextcloud")
    for t in rows:
        if not t["authentik_group_pk"]:
            continue
        members = await ak_list_group_members(t["authentik_group_pk"])
        if username not in members:
            continue
        item = {
            "slug": t["slug"],
            "name": t["name"],
            "matrix_space_id": t["matrix_space_id"],
            "matrix_main_room_id": t["matrix_main_room_id"],
            "files_url": f"{nc_public}/apps/files/?dir=/{t['name']}" if t["nc_groupfolder_id"] else None,
            "calendar_url": None,
            "deck_url": f"{nc_public}/apps/deck/board/{t['nc_deck_board_id']}" if t["nc_deck_board_id"] else None,
            "collective_url": f"{nc_public}/apps/collectives/{t['slug']}" if t["nc_collective_id"] else None,
        }
        if t["nc_calendar_uri"]:
            cal_id = t["nc_calendar_uri"].rstrip("/").rsplit("/", 1)[-1]
            item["calendar_url"] = f"{nc_public}/apps/calendar/p/{CALDAV_OWNER}/{cal_id}"
        out.append(item)
    return out


@router.get("")
async def list_teams(request: Request) -> list[dict]:
    user = get_current_user(request)
    _require_admin(user)
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, slug, name, description, parent_team_id, depth, "
            "authentik_group_pk, matrix_space_id, nc_circle_id, "
            "inherit_members, include_clara_bot, status, created_at, created_by "
            "FROM claraos_teams ORDER BY slug"
        )
    return [dict(r) | {"id": str(r["id"]),
                       "parent_team_id": str(r["parent_team_id"]) if r["parent_team_id"] else None,
                       "created_at": r["created_at"].isoformat()} for r in rows]


@router.get("/{slug}")
async def get_team(slug: str, request: Request) -> dict:
    user = get_current_user(request)
    _require_admin(user)
    team = await _get_team_by_slug(slug)
    if not team:
        raise HTTPException(404, "team not found")
    members = []
    if team["authentik_group_pk"]:
        members = await ak_list_group_members(team["authentik_group_pk"])
    return {"id": str(team["id"]), "slug": team["slug"], "name": team["name"],
            "description": team["description"], "parent_team_id": str(team["parent_team_id"]) if team["parent_team_id"] else None,
            "depth": team["depth"], "authentik_group_pk": team["authentik_group_pk"],
            "matrix_space_id": team["matrix_space_id"], "nc_circle_id": team["nc_circle_id"],
            "inherit_members": team["inherit_members"], "include_clara_bot": team["include_clara_bot"],
            "status": team["status"], "members": members,
            "created_at": team["created_at"].isoformat(), "created_by": team["created_by"]}


@router.delete("/{slug}")
async def delete_team(slug: str, request: Request) -> dict:
    user = get_current_user(request)
    _require_admin(user)
    team = await _get_team_by_slug(slug)
    if not team:
        raise HTTPException(404, "team not found")

    pool = await get_pool()
    async with pool.acquire() as conn:
        child_count = await conn.fetchval(
            "SELECT COUNT(*) FROM claraos_teams WHERE parent_team_id=$1", team["id"]
        )
    if child_count:
        raise HTTPException(409, f"team has {child_count} sub-team(s); delete those first")

    # Tear down mirrors first (safe even if references dangle or backends are down).
    # We tolerate failures on mirrors — DB row deletion still proceeds because the
    # row is the authoritative record for "is this team known". Any orphaned mirror
    # gets cleaned up on next sync-daemon pass.
    errors: list[str] = []
    # NC-Group lives if either groupfolder or deck used it.
    nc_group_present = bool(team["nc_groupfolder_id"] or team["nc_deck_board_id"])
    for label, coro in [
        ("nc_collective", nc_collective_delete(team["nc_collective_id"]) if team["nc_collective_id"] else None),
        ("nc_calendar", nc_calendar_delete(team["nc_calendar_uri"]) if team["nc_calendar_uri"] else None),
        ("nc_deck", nc_deck_delete(team["nc_deck_board_id"]) if team["nc_deck_board_id"] else None),
        ("nc_groupfolder", nc_gf_delete(team["nc_groupfolder_id"]) if team["nc_groupfolder_id"] else None),
        ("nc_group", nc_group_delete(nc_group_name(team["slug"])) if nc_group_present else None),
        ("nc_circle", nc_delete_circle(team["nc_circle_id"]) if team["nc_circle_id"] else None),
        ("matrix_main_room", mx_delete_room(team["matrix_main_room_id"]) if team["matrix_main_room_id"] else None),
        ("matrix_space", mx_delete_room(team["matrix_space_id"]) if team["matrix_space_id"] else None),
        ("authentik_group", ak_delete_group(team["authentik_group_pk"]) if team["authentik_group_pk"] else None),
    ]:
        if coro is None:
            continue
        try:
            await coro
        except Exception as exc:
            errors.append(f"{label}: {exc}")
            logger.warning("delete_team mirror teardown %s failed: %s", label, exc)

    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM claraos_teams WHERE id=$1", team["id"])
    # Audit row cascades via FK ON DELETE CASCADE — tombstone intentionally skipped.
    return {"deleted": slug, "mirror_errors": errors}


@router.post("/{slug}/members")
async def add_member(slug: str, body: AddMemberBody, request: Request) -> dict:
    user = get_current_user(request)
    _require_admin(user)
    team = await _get_team_by_slug(slug)
    if not team:
        raise HTTPException(404, "team not found")
    ak_user = await ak_get_user_by_username(body.username)
    if not ak_user:
        raise HTTPException(404, f"user '{body.username}' not in Authentik")

    await ak_add_user_to_group(team["authentik_group_pk"], ak_user["pk"])

    # Ensure the Matrix account exists BEFORE inviting: an invite to an MXID
    # that does not exist goes nowhere and is only logged. Otherwise every newly
    # added member would hit the same problem until the next sync pass fixes it.
    if team["matrix_space_id"] or team["matrix_main_room_id"]:
        try:
            await mx_ensure_user(body.username)
        except Exception as exc:
            logger.warning("mx_ensure fuer %s: %s", body.username, exc)

    # Propagate to mirrors (best-effort)
    if team["matrix_space_id"]:
        await mx_invite_user(team["matrix_space_id"], body.username)
    if team["matrix_main_room_id"]:
        await mx_invite_user(team["matrix_main_room_id"], body.username)
    if team["nc_circle_id"]:
        await nc_add_member(team["nc_circle_id"], body.username)
    if team["nc_groupfolder_id"] or team["nc_deck_board_id"]:
        await nc_group_add_user(nc_group_name(team["slug"]), body.username)
    if team["nc_collective_circle_id"]:
        await nc_circle_add_member_by_circle_id(team["nc_collective_circle_id"], body.username)

    await _audit(team["id"], user["username"], "member_add", target=body.username)
    return {"added": body.username}


@router.delete("/{slug}/members/{username}")
async def remove_member(slug: str, username: str, request: Request) -> dict:
    user = get_current_user(request)
    _require_admin(user)
    team = await _get_team_by_slug(slug)
    if not team:
        raise HTTPException(404, "team not found")
    ak_user = await ak_get_user_by_username(username)
    if ak_user:
        await ak_remove_user_from_group(team["authentik_group_pk"], ak_user["pk"])
    if team["matrix_main_room_id"]:
        await mx_kick_user(team["matrix_main_room_id"], username)
    if team["matrix_space_id"]:
        await mx_kick_user(team["matrix_space_id"], username)
    if team["nc_circle_id"]:
        members = await nc_list_members(team["nc_circle_id"])
        for m in members:
            if m.get("userId") == username and "id" in m:
                await nc_remove_member(team["nc_circle_id"], m["id"])
                break
    if team["nc_groupfolder_id"] or team["nc_deck_board_id"]:
        await nc_group_remove_user(nc_group_name(team["slug"]), username)
    if team["nc_collective_circle_id"]:
        await nc_circle_remove_member_by_username(team["nc_collective_circle_id"], username)
    await _audit(team["id"], user["username"], "member_remove", target=username)
    return {"removed": username}


class UpgradeBody(BaseModel):
    enable_groupfolder: bool = False
    enable_calendar: bool = False
    enable_deck: bool = False
    enable_collective: bool = False
    enable_matrix: bool = False


@router.post("/{slug}/upgrade")
async def upgrade_team(slug: str, body: UpgradeBody, request: Request) -> dict:
    """Retroactively add NC resources to an existing team — idempotent.

    Called after team-create if team was originally created without a resource
    flag. Skips resources already provisioned (no-op). Returns what was added.
    """
    user = get_current_user(request)
    _require_admin(user)
    team = await _get_team_by_slug(slug)
    if not team:
        raise HTTPException(404, "team not found")
    pool = await get_pool()
    added: dict[str, int | str | None] = {}
    nc_gr = nc_group_name(slug)

    # Retrofit the Matrix space + main room.
    # Why this is needed: rebuilding Matrix invalidates all room IDs — the
    # columns are then rightly cleared, but without this there would be no way
    # to fill them again. `create` creates rooms, `sync` skips missing ones
    # (`if not rid: continue`), so a team would stay without a room
    # indefinitely. A rebuild must not require manual follow-up work.
    if body.enable_matrix and not team["matrix_space_id"]:
        try:
            space_id, main_room_id = await mx_create_space(
                name=team["name"],
                alias_localpart=f"team-{slug.replace('.', '-')}",
                topic=team.get("description") or "",
            )
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE claraos_teams SET matrix_space_id=$1, matrix_main_room_id=$2 WHERE id=$3",
                    space_id, main_room_id, team["id"])
            added["matrix_space_id"] = space_id
            added["matrix_main_room_id"] = main_room_id
        except Exception as exc:
            logger.error("upgrade matrix space: %s", exc)

    # NC-Group is prerequisite for groupfolder + deck member access.
    # Create if needed, seed current Authentik-group members so existing
    # members get access immediately.
    nc_group_needed = (
        (body.enable_groupfolder and not team["nc_groupfolder_id"]) or
        (body.enable_deck and not team["nc_deck_board_id"])
    )
    if nc_group_needed:
        try:
            await nc_group_create(nc_gr)
            ak_members = await ak_list_group_members(team["authentik_group_pk"]) if team["authentik_group_pk"] else []
            for u in ak_members:
                await nc_group_add_user(nc_gr, u)
        except Exception as exc:
            logger.warning("upgrade nc_group_create: %s", exc)

    if body.enable_groupfolder and not team["nc_groupfolder_id"]:
        try:
            gf_id = await nc_gf_create(team["name"])
            if gf_id:
                await nc_gf_assign_group(gf_id, nc_gr)
                async with pool.acquire() as conn:
                    await conn.execute("UPDATE claraos_teams SET nc_groupfolder_id=$1 WHERE id=$2", gf_id, team["id"])
                added["nc_groupfolder_id"] = gf_id
        except Exception as exc:
            logger.error("upgrade groupfolder: %s", exc)

    if body.enable_deck and not team["nc_deck_board_id"]:
        try:
            deck_id = await nc_deck_create(team["name"])
            if deck_id:
                await nc_deck_share_group(deck_id, nc_gr)
                async with pool.acquire() as conn:
                    await conn.execute("UPDATE claraos_teams SET nc_deck_board_id=$1 WHERE id=$2", deck_id, team["id"])
                added["nc_deck_board_id"] = deck_id
        except Exception as exc:
            logger.error("upgrade deck: %s", exc)

    if body.enable_calendar and not team["nc_calendar_uri"]:
        try:
            cal_uri = await nc_calendar_create(f"team-{slug}", team["name"])
            if cal_uri:
                # Share with team NC-Group if we have one
                if nc_group_needed or team["nc_groupfolder_id"] or team["nc_deck_board_id"]:
                    await nc_calendar_share_group(cal_uri, nc_gr, team["name"])
                async with pool.acquire() as conn:
                    await conn.execute("UPDATE claraos_teams SET nc_calendar_uri=$1 WHERE id=$2", cal_uri, team["id"])
                added["nc_calendar_uri"] = cal_uri
        except Exception as exc:
            logger.error("upgrade calendar: %s", exc)

    if body.enable_collective and not team["nc_collective_id"]:
        try:
            coll_id, coll_circle_id = await nc_collective_create(f"team-{slug}")
            if coll_id:
                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE claraos_teams SET nc_collective_id=$1, nc_collective_circle_id=$2 WHERE id=$3",
                        coll_id, coll_circle_id, team["id"],
                    )
                added["nc_collective_id"] = coll_id
                # Seed existing Authentik-group members into the Collective-Circle
                if coll_circle_id and team["authentik_group_pk"]:
                    for u in await ak_list_group_members(team["authentik_group_pk"]):
                        await nc_circle_add_member_by_circle_id(coll_circle_id, u)
        except Exception as exc:
            logger.error("upgrade collective: %s", exc)

    await _audit(team["id"], user["username"], "upgrade", details={"added": added, "requested": body.model_dump()})
    return {"team": slug, "added": added}


@router.get("/{slug}/resources")
async def get_resources(slug: str, request: Request) -> dict:
    """Return UI-ready URLs for team resources (used by Teams-app Channel-Tabs)."""
    user = get_current_user(request)
    # Members of the team may read this (not just admins) — for later UI.
    # For now: admin-only.
    _require_admin(user)
    team = await _get_team_by_slug(slug)
    if not team:
        raise HTTPException(404, "team not found")
    nc_public = domain_url("nextcloud")
    resources: dict = {
        "posts_room_id": team["matrix_main_room_id"],
        "files_url": None,
        "calendar_url": None,
        "deck_url": None,
        "collective_url": None,
    }
    if team["nc_groupfolder_id"]:
        resources["files_url"] = f"{nc_public}/apps/files/?dir=/{team['name']}"
    if team["nc_calendar_uri"]:
        # Calendar-App public link uses cal_id (last segment of caldav URI)
        cal_id = team["nc_calendar_uri"].rstrip("/").rsplit("/", 1)[-1]
        resources["calendar_url"] = f"{nc_public}/apps/calendar/p/{CALDAV_OWNER}/{cal_id}"
    if team["nc_deck_board_id"]:
        resources["deck_url"] = f"{nc_public}/apps/deck/board/{team['nc_deck_board_id']}"
    if team["nc_collective_id"]:
        resources["collective_url"] = f"{nc_public}/apps/collectives/{team['slug']}"  # slug matches collective name we used
    return resources


@router.get("/{slug}/audit")
async def get_audit(slug: str, request: Request, limit: int = 50) -> list[dict]:
    user = get_current_user(request)
    _require_admin(user)
    team = await _get_team_by_slug(slug)
    if not team:
        raise HTTPException(404, "team not found")
    limit = max(1, min(200, limit))
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT actor_username, event_type, target_username, details, occurred_at"
            " FROM claraos_team_audit WHERE team_id=$1 ORDER BY occurred_at DESC LIMIT $2",
            team["id"], limit,
        )
    return [{"actor": r["actor_username"], "event": r["event_type"],
             "target": r["target_username"], "details": r["details"],
             "at": r["occurred_at"].isoformat()} for r in rows]


# --------------------------------------------------------------------------
# NC Import Wizard (D1)
# --------------------------------------------------------------------------

@router.get("/nc-import/preview")
async def nc_import_preview(request: Request) -> list[dict]:
    """List NC circles that are not yet mapped to a claraos_team."""
    user = get_current_user(request)
    _require_admin(user)
    pool = await get_pool()
    async with pool.acquire() as conn:
        mapped = {r["nc_circle_id"] for r in await conn.fetch(
            "SELECT nc_circle_id FROM claraos_teams WHERE nc_circle_id IS NOT NULL")}
    out = []
    for circle in await nc_list_circles():
        cid = circle.get("id")
        if cid in mapped:
            continue
        out.append({
            "id": cid,
            "name": circle.get("name"),
            "population": circle.get("population"),
            "creation": circle.get("creation"),
            "owner_username": circle.get("owner", {}).get("userId"),
        })
    return out


class NcImportBody(BaseModel):
    slug: str
    name: str | None = None  # optional override, default circle name
    parent_slug: str | None = None


@router.post("/nc-import/{circle_id}")
async def nc_import_commit(circle_id: str, body: NcImportBody, request: Request) -> dict:
    user = get_current_user(request)
    _require_admin(user)
    if not SLUG_RE.match(body.slug):
        raise HTTPException(400, "invalid slug")

    # Find the circle
    circles = await nc_list_circles()
    circle = next((c for c in circles if c.get("id") == circle_id), None)
    if not circle:
        raise HTTPException(404, "NC circle not found")

    pool = await get_pool()
    async with pool.acquire() as conn:
        if await conn.fetchval("SELECT 1 FROM claraos_teams WHERE slug=$1", body.slug):
            raise HTTPException(409, "slug already taken")
        if await conn.fetchval("SELECT 1 FROM claraos_teams WHERE nc_circle_id=$1", circle_id):
            raise HTTPException(409, "nc circle already imported")

    team_name = body.name or circle.get("name") or body.slug

    # 1. Authentik group
    group_name = f"{GROUP_PREFIX}{body.slug}"
    ak_group = await ak_get_group_by_name(group_name) or await ak_create_group(group_name)

    # 2. Add NC members to Authentik group (skip users without AK account)
    nc_members = await nc_list_members(circle_id)
    matched_users, missing = [], []
    for m in nc_members:
        uname = m.get("userId")
        if not uname or m.get("userType") != 1:
            continue
        ak_user = await ak_get_user_by_username(uname)
        if not ak_user:
            missing.append(uname)
            continue
        try:
            await ak_add_user_to_group(ak_group["pk"], ak_user["pk"])
            matched_users.append(uname)
        except Exception as exc:
            logger.warning("import: ak add %s failed: %s", uname, exc)

    # 3. Matrix space + main room, invite matched users
    try:
        space_id, main_room_id = await mx_create_space(
            name=team_name,
            alias_localpart=f"team-{body.slug.replace('.', '-')}",
            topic=circle.get("description", "") or "",
        )
        for uname in matched_users:
            await mx_invite_user(space_id, uname)
            await mx_invite_user(main_room_id, uname)
    except Exception as exc:
        logger.error("import: matrix space create failed: %s", exc)
        space_id, main_room_id = None, None

    # 4. Parent linkage
    parent_id = None
    if body.parent_slug:
        async with pool.acquire() as conn:
            prow = await conn.fetchrow("SELECT id, matrix_space_id FROM claraos_teams WHERE slug=$1", body.parent_slug)
        if prow and space_id and prow["matrix_space_id"]:
            await mx_link_child_space(prow["matrix_space_id"], space_id)
            parent_id = prow["id"]

    # 5. DB row
    async with pool.acquire() as conn:
        team_id = await conn.fetchval(
            """INSERT INTO claraos_teams
               (slug, name, description, parent_team_id, authentik_group_pk,
                matrix_space_id, matrix_main_room_id, nc_circle_id, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id""",
            body.slug, team_name, circle.get("description"), parent_id, ak_group["pk"],
            space_id, main_room_id, circle_id, user["username"],
        )

    await _audit(team_id, user["username"], "nc_import",
                 details={"circle_id": circle_id, "imported_users": matched_users,
                          "missing_authentik_users": missing})

    return {"id": str(team_id), "slug": body.slug, "name": team_name,
            "imported_users": matched_users, "missing_authentik_users": missing,
            "matrix_space_id": space_id, "nc_circle_id": circle_id,
            "authentik_group_pk": ak_group["pk"]}
