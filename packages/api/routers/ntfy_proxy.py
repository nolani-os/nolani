"""ntfy proxy endpoints for ClaraOS.

GET /api/claraos/ntfy/token  — return (or provision) the user's ntfy Bearer token.
GET /api/claraos/ntfy/sse    — SSE proxy: streams the user's ntfy topic as SSE
                               so the frontend doesn't need to talk to ntfy directly
                               (avoids CORS + auth-header-in-EventSource issues).
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME, heim_default  # external cell: no silent home fallback
import asyncio
import logging
import os
import secrets
import string

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from auth import get_current_user
from database import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/ntfy", tags=["ntfy"])

NTFY_INTERNAL_URL = heim_default("NTFY_INTERNAL_URL")
NTFY_ADMIN_TOKEN = os.environ.get("NTFY_ADMIN_TOKEN", "")

# The bell used to show only the personal topic — but almost only the approval
# service writes there. All system messages (watchdogs, domain drift, DNS anchor,
# hypervisor) go to `clara` and were therefore NEVER visible in ClaraOS.
# ntfy can serve several topics in one subscription (/a,b,c/sse). A user who may not
# read the extra topics would get 403 for the WHOLE subscription — hence the fallback below.
NTFY_EXTRA_TOPICS = [
    t.strip() for t in os.environ.get("NTFY_EXTRA_TOPICS", "clara,clara-alerts").split(",")
    if t.strip()
]


def _safe_ntfy_username(authentik_username: str) -> str:
    return "".join(c.lower() if c.isalnum() or c in "-_" else "_" for c in authentik_username)[:64]


def _gen_password() -> str:
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(40))


_token_cols_ensured = False


async def _ensure_token_columns() -> None:
    """Token cache columns (idempotent). Without them a new ntfy token was
    minted on EVERY SSE connect -> ntfy visitor rate limit (429) -> 500 -> 5s
    frontend retry -> a self-sustaining doom loop for all users (the API
    funnels all of them through one IP)."""
    global _token_cols_ensured
    if _token_cols_ensured:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "ALTER TABLE ntfy_user_credentials"
            " ADD COLUMN IF NOT EXISTS ntfy_token TEXT,"
            " ADD COLUMN IF NOT EXISTS ntfy_token_expires TIMESTAMPTZ"
        )
    _token_cols_ensured = True


# One provisioning at a time per user. On a first login the shell's bell (/sse) and
# the companion app (/device-token) ask at the same moment; both found no row and
# both created the ntfy user — the second got "user already exists" (ntfy 2.31
# answers that with HTTP 500, not 409) and the app's push setup failed.
_provision_locks: dict[str, asyncio.Lock] = {}


async def _get_or_provision_token(auth_user: str, force_new: bool = False) -> tuple[str, str]:
    """Return (ntfy_username, bearer_token) for auth_user, provisioning on first call.

    The token is cached in the DB and reused — a new one is only minted when
    there is no cache, shortly before expiry, or with force_new (upstream 401).
    """
    lock = _provision_locks.setdefault(auth_user, asyncio.Lock())
    async with lock:
        return await _get_or_provision_token_locked(auth_user, force_new)


def _user_exists_response(r: httpx.Response) -> bool:
    """ntfy's "user already exists": 409 in older versions, 500 + text in 2.31."""
    return r.status_code == 409 or (r.status_code == 500 and "already exists" in r.text)


async def _get_or_provision_token_locked(auth_user: str, force_new: bool) -> tuple[str, str]:
    ntfy_user = _safe_ntfy_username(auth_user)
    pool = await get_pool()
    await _ensure_token_columns()

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT ntfy_username, ntfy_password, ntfy_token, ntfy_token_expires,"
            " (ntfy_token_expires IS NULL OR ntfy_token_expires > NOW() + interval '5 minutes') AS token_fresh"
            " FROM ntfy_user_credentials WHERE authentik_username=$1",
            auth_user,
        )

    if row and row["ntfy_token"] and row["token_fresh"] and not force_new:
        return row["ntfy_username"], row["ntfy_token"]

    async with httpx.AsyncClient(timeout=10.0) as client:
        if not row:
            password = _gen_password()
            if NTFY_ADMIN_TOKEN:
                # Admin API (POST /v1/users) instead of public signup (POST /v1/account):
                # bypasses ntfy's non-configurable account creation limit (~3 per window,
                # NOT covered by exempt-hosts), which would otherwise block onboarding
                # of more than 3 users per day.
                r = await client.post(
                    f"{NTFY_INTERNAL_URL}/v1/users",
                    headers={"Authorization": f"Bearer {NTFY_ADMIN_TOKEN}"},
                    json={"username": ntfy_user, "password": password, "role": "user"},
                )
            else:
                r = await client.post(
                    f"{NTFY_INTERNAL_URL}/v1/account",
                    json={"username": ntfy_user, "password": password},
                )
            if _user_exists_response(r) and NTFY_ADMIN_TOKEN:
                # Orphan: the ntfy user exists, but there is no claraos DB row
                # (e.g. after a partial failure/retry during onboarding). Delete via admin
                # and create once from scratch instead of blocking the user permanently.
                await client.request(
                    "DELETE", f"{NTFY_INTERNAL_URL}/v1/users",
                    headers={"Authorization": f"Bearer {NTFY_ADMIN_TOKEN}"},
                    json={"username": ntfy_user},
                )
                r = await client.post(
                    f"{NTFY_INTERNAL_URL}/v1/users",
                    headers={"Authorization": f"Bearer {NTFY_ADMIN_TOKEN}"},
                    json={"username": ntfy_user, "password": password, "role": "user"},
                )
            if r.status_code not in (200, 201):
                if r.status_code == 409:
                    raise HTTPException(409, f"ntfy user '{ntfy_user}' already exists outside claraos-DB")
                raise HTTPException(500, f"ntfy user creation failed: {r.status_code}")
            async with pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO ntfy_user_credentials (authentik_username, ntfy_username, ntfy_password) "
                    "VALUES ($1, $2, $3) ON CONFLICT (authentik_username) DO UPDATE SET ntfy_password=$3",
                    auth_user, ntfy_user, password,
                )
            # Grant rw access to the user's own topic via admin API
            if NTFY_ADMIN_TOKEN:
                try:
                    acl_r = await client.put(
                        f"{NTFY_INTERNAL_URL}/v1/users/access",
                        headers={"Authorization": f"Bearer {NTFY_ADMIN_TOKEN}"},
                        json={"username": ntfy_user, "topic": ntfy_user, "permission": "rw"},
                    )
                    if acl_r.status_code not in (200, 201):
                        logger.warning("ntfy ACL grant failed: %s %s", acl_r.status_code, acl_r.text[:200])
                except Exception as exc:
                    logger.warning("ntfy ACL grant exception: %s", exc)
            logger.info("Provisioned ntfy user %s for %s", ntfy_user, auth_user)
        else:
            password = row["ntfy_password"]
            ntfy_user = row["ntfy_username"]

        r = await client.post(
            f"{NTFY_INTERNAL_URL}/v1/account/token",
            auth=(ntfy_user, password),
            json={},
        )
        if r.status_code == 401 and NTFY_ADMIN_TOKEN and ntfy_user != "admin":
            # Credential drift (ntfy user was recreated elsewhere or similar) —
            # self-heal: delete the user via admin + provision from scratch.
            # Guard: NEVER touch the reserved admin user (owner of the admin
            # token!). Such a 401 can stay hidden for a long time behind the
            # rate-limit 429.
            logger.warning("ntfy token 401 für %s — reprovisioniere User", ntfy_user)
            await client.request(
                "DELETE", f"{NTFY_INTERNAL_URL}/v1/users",
                headers={"Authorization": f"Bearer {NTFY_ADMIN_TOKEN}"},
                json={"username": ntfy_user},
            )  # status irrelevant — signup follows
            password = _gen_password()
            # Admin API (no rate limit); NTFY_ADMIN_TOKEN is set in this branch.
            r2 = await client.post(
                f"{NTFY_INTERNAL_URL}/v1/users",
                headers={"Authorization": f"Bearer {NTFY_ADMIN_TOKEN}"},
                json={"username": ntfy_user, "password": password, "role": "user"},
            )
            if r2.status_code not in (200, 201):
                raise HTTPException(500, f"ntfy reprovision failed: {r2.status_code}")
            await client.put(
                f"{NTFY_INTERNAL_URL}/v1/users/access",
                headers={"Authorization": f"Bearer {NTFY_ADMIN_TOKEN}"},
                json={"username": ntfy_user, "topic": ntfy_user, "permission": "rw"},
            )
            async with pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO ntfy_user_credentials (authentik_username, ntfy_username, ntfy_password) "
                    "VALUES ($1, $2, $3) ON CONFLICT (authentik_username) DO UPDATE"
                    " SET ntfy_password=$3, ntfy_token=NULL, ntfy_token_expires=NULL",
                    auth_user, ntfy_user, password,
                )
            r = await client.post(
                f"{NTFY_INTERNAL_URL}/v1/account/token",
                auth=(ntfy_user, password),
                json={},
            )
        if r.status_code == 429:
            # NEVER pass a rate limit through as 500 — 503 + Retry-After so the
            # frontend backoff kicks in instead of draining the bucket further.
            raise HTTPException(
                503, "ntfy rate-limited (429) — bitte später erneut",
                headers={"Retry-After": "30"},
            )
        if r.status_code not in (200, 201):
            raise HTTPException(500, f"ntfy token request failed: {r.status_code}")
        data = r.json()
        token = data["token"]
        # ntfy returns expires as epoch seconds (0/missing = never expires)
        expires_epoch = data.get("expires") or 0

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE ntfy_user_credentials SET last_token_at=NOW(),"
            " ntfy_token=$2,"
            " ntfy_token_expires=CASE WHEN $3::bigint > 0 THEN to_timestamp($3::bigint) ELSE NULL END"
            " WHERE authentik_username=$1",
            auth_user, token, int(expires_epoch),
        )

    return ntfy_user, token


async def mint_device_token(auth_user: str, device_label: str = "",
                            reuse: bool = True) -> tuple[str, str]:
    """Issue a PERMANENT, labelled ntfy token for a device.

    Warning — the bug this fixes: `app-provision` used to hand out the CACHED token
    from `_get_or_provision_token()`. With an empty request body ntfy issues tokens
    valid for **72 hours** (measured: exactly 72.0 h, no sliding extension on use).
    The companion app, however, stores the Authorization header **once** in its
    SharedPreferences when pairing and **never** renews it — there is no write to
    `ntfy_auth` outside provisioning. Result: three days after pairing ntfy answered
    `401`, and the app permanently showed "server rejects (HTTP 401)".

    Why it hit ONLY the phone: server-side consumers (the SSE proxy for the bell in
    the shell) re-mint shortly before expiry themselves — so the web UI kept working
    and masked the outage.

    Why `401` and not `403`: ntfy answers `401` when *authentication* fails (token
    unknown/expired) and `403` when a valid user merely lacks *permissions*. Verified
    on the server — the ACL was correct all along.

    The token here gets `expires: 0` (= never expires; verified) and a label with the
    device name, so `ntfy user list` shows which device holds which token and each
    can be revoked individually. The 72-hour cycle of the API's own token is
    deliberately left alone — it renews itself.
    """
    # Ensures the ntfy user + credentials exist (including all self-healing paths
    # for credential drift) — only then can we mint a dedicated token.
    ntfy_user, _ = await _get_or_provision_token(auth_user)

    pool = await get_pool()
    async with pool.acquire() as conn:
        password = await conn.fetchval(
            "SELECT ntfy_password FROM ntfy_user_credentials WHERE authentik_username=$1",
            auth_user,
        )
    if not password:
        raise HTTPException(500, "ntfy: kein Passwort für den Nutzer hinterlegt")

    label = f"{PRODUCT_NAME} Companion — {device_label}".strip(" —") if device_label else f"{PRODUCT_NAME} Companion"
    label = label[:64]
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Important: first check whether this device already has a token.
        # Otherwise EVERY renewal creates another non-expiring token — a device
        # that lost its value would create a new one on each attempt and fill
        # the token list without limit.
        if reuse:
            try:
                acc = await client.get(f"{NTFY_INTERNAL_URL}/v1/account",
                                       auth=(ntfy_user, password))
                if acc.status_code == 200:
                    passend = [t for t in acc.json().get("tokens", [])
                               if t.get("label") == label and not t.get("expires")]
                    if passend:
                        logger.info("NTFY_DEVICE_TOKEN wiederverwendet user=%s label=%s",
                                    ntfy_user, label)
                        return ntfy_user, passend[0]["token"]
            except Exception as exc:  # noqa: BLE001 — reuse is optional, not required
                logger.warning("ntfy Token-Wiederverwendung fehlgeschlagen: %s", exc)

        r = await client.post(
            f"{NTFY_INTERNAL_URL}/v1/account/token",
            auth=(ntfy_user, password),
            json={"expires": 0, "label": label},
        )
    if r.status_code == 429:
        raise HTTPException(503, "ntfy rate-limited (429) — bitte später erneut",
                            headers={"Retry-After": "30"})
    if r.status_code not in (200, 201):
        raise HTTPException(500, f"ntfy device token failed: {r.status_code}")
    data = r.json()
    if data.get("expires"):
        # Never silently give an expiring token to a device that cannot renew
        # it — that is exactly the bug described above.
        logger.error("ntfy lieferte für %s einen ABLAUFENDEN Geräte-Token (expires=%s)",
                     ntfy_user, data.get("expires"))
        raise HTTPException(500, "ntfy stellte keinen dauerhaften Geräte-Token aus")
    logger.info("NTFY_DEVICE_TOKEN neu user=%s label=%s", ntfy_user, label)
    return ntfy_user, data["token"]


@router.get("/token")
async def get_ntfy_token(request: Request) -> JSONResponse:
    """Return the user's ntfy credentials (Bearer token + app password).

    app_password is the login for the ntfy Android app: the app cannot use
    access tokens and requires a username (ntfy-android, issue #695); Basic
    with user:tk_... returns 401 on the server (tokens only work via Bearer or
    with an empty username — verified empirically).
    """
    user = get_current_user(request)
    auth_user = user.get("username", "")
    if not auth_user:
        raise HTTPException(401, "Not authenticated")
    ntfy_user, token = await _get_or_provision_token(auth_user)
    pool = await get_pool()
    async with pool.acquire() as conn:
        app_password = await conn.fetchval(
            "SELECT ntfy_password FROM ntfy_user_credentials WHERE authentik_username=$1",
            auth_user,
        )
    return JSONResponse(
        {"ntfy_username": ntfy_user, "token": token, "app_password": app_password}
    )


@router.get("/device-token")
async def get_ntfy_device_token(request: Request) -> JSONResponse:
    """Hand out fresh push credentials for a device — the self-healing path.

    Without this endpoint the companion app stores its ntfy credentials when pairing
    and has **no way** to ever renew them. An expired or revoked credential thus
    disabled push permanently — curable only by re-pairing.

    Important: authentication uses the **existing ClaraOS session** (the same path as
    every other shell call). Deliberately NO new trust path: the app sends the session
    cookies it already has for loading the shell. So this endpoint cannot give
    anything to a device that is not already signed in as this user.

    Returns the same token as long as the device already has one (label match) —
    otherwise every renewal attempt would keep filling the token list.
    """
    user = get_current_user(request)
    auth_user = user.get("username", "")
    if not auth_user:
        raise HTTPException(401, "Not authenticated")
    geraet = (request.query_params.get("device") or "").strip()[:40]
    ntfy_user, token = await mint_device_token(auth_user, geraet)
    return JSONResponse({
        "ntfy_username": ntfy_user,
        "ntfy_topic": ntfy_user,
        "ntfy_server": os.environ.get("NTFY_APP_HOST", ""),
        "auth": f"Bearer {token}",
    })


@router.get("/sse")
async def ntfy_sse_proxy(request: Request) -> StreamingResponse:
    """SSE proxy: subscribe to the user's ntfy topic and forward events.

    The frontend connects here; we forward from {NTFY_INTERNAL_URL}/{ntfy_user}/sse
    with Bearer auth. This avoids browser CORS and EventSource header limitations.
    """
    user = get_current_user(request)
    auth_user = user.get("username", "")
    if not auth_user:
        raise HTTPException(401, "Not authenticated")

    # Optional since= from query string (frontend may pass "0" to replay all)
    since = request.query_params.get("since", "")
    ntfy_user, token = await _get_or_provision_token(auth_user)

    def _url(topics: list[str]) -> str:
        u = f"{NTFY_INTERNAL_URL}/{','.join(topics)}/sse"
        return f"{u}?since={since}" if since else u

    # Try with the extra topics first, then only the personal one. A user without
    # read access to `clara` (non-admin users) would otherwise get no messages at all.
    kandidaten = []
    if NTFY_EXTRA_TOPICS:
        kandidaten.append([ntfy_user] + [t for t in NTFY_EXTRA_TOPICS if t != ntfy_user])
    kandidaten.append([ntfy_user])

    async def event_stream():
        # The cached token may have died upstream (account reset, manual token
        # delete) -> on 401/403 re-mint exactly ONCE.
        # If it is still 403 after that, the extra topics are the cause -> next
        # candidate (fall back to the personal topic) instead of leaving the user blind.
        current_token = token
        neu_gemintet = False
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                for topics in kandidaten:
                    url = _url(topics)
                    for _ in (1, 2):
                        async with client.stream(
                            "GET", url,
                            headers={"Authorization": f"Bearer {current_token}",
                                     "Accept": "text/event-stream"},
                        ) as resp:
                            if resp.status_code in (401, 403) and not neu_gemintet:
                                logger.info("ntfy SSE: cached token stale for %s — re-mint",
                                            auth_user)
                                _, current_token = await _get_or_provision_token(
                                    auth_user, force_new=True
                                )
                                neu_gemintet = True
                                continue
                            if resp.status_code in (401, 403) and len(topics) > 1:
                                logger.info(
                                    "ntfy SSE: %s darf %s nicht lesen — Rueckfall auf "
                                    "das persoenliche Topic", auth_user, ",".join(topics[1:])
                                )
                                break                       # next candidate
                            if resp.status_code != 200:
                                yield f"event: error\ndata: ntfy upstream {resp.status_code}\n\n"
                                return

                            logger.info("ntfy SSE: %s abonniert %s", auth_user, ",".join(topics))
                            async for chunk in resp.aiter_bytes():
                                if await request.is_disconnected():
                                    break
                                yield chunk
                            return
        except (httpx.ReadError, asyncio.CancelledError):
            pass
        except Exception as exc:
            logger.warning("ntfy SSE proxy error for %s: %s", auth_user, exc)
            yield f"event: error\ndata: {exc}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
