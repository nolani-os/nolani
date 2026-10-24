"""Provision users in the connected apps — idempotently.

Background: ClaraOS creates users cleanly in Authentik, but used to set them up
in none of the connected apps. Non-admin users had hardly any entries in
`claraos_app_credentials`, which is why app widgets answered with 409.

Guiding rule learned from real leaks: **a shared account is never the
shortcut.** If a user has no access of their own, the feature fails — it does
NOT fall back to someone else's account. That was exactly the bug with chats
(shared Open WebUI admin token) and with files (shared SSH key).

Every `ensure_*` function is **idempotent**: callable many times without harm.
That is the central property — the same function serves the initial rollout,
catching up existing users and the nightly reconciliation.

What does NOT happen here:
* No output of passwords or keys — neither to the log nor in the response.
  Only WHAT happened is reported.
* No change to existing, working credentials. Whoever already has one is left
  alone (otherwise a nightly run would keep rotating passwords stored
  elsewhere).
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME, heim_default  # external deployment: no silent home-network fallback
from betriebsprofil import OWNER_USER  # owner/admin account of this installation
import asyncio
import logging
import os
import secrets
from typing import Any

import httpx

from database import user_tx
from encryption import encrypt_credentials, decrypt_credentials

logger = logging.getLogger(__name__)

# Identity used for provisioning. Currently the admin's own access, because the
# admin rights in the connected apps are attached to it.
# Note: a dedicated service account per app would be cleaner — then the rollout
# is not tied to a person. Deliberately an env var so switching later is a
# configuration change, not a code change.
PROVISION_ADMIN = os.environ.get("CLARAOS_PROVISION_ADMIN", OWNER_USER)

IMMICH_URL = heim_default("IMMICH_INTERNAL_URL")


# ── Read/write credentials ──────────────────────────────────────────────────

async def _creds(username: str, app_id: str) -> dict:
    if not username:
        return {}
    # Read as that account itself — row-level security (migrations/042).
    async with user_tx(username) as conn:
        row = await conn.fetchrow(
            "SELECT credentials FROM claraos_app_credentials "
            "WHERE username = $1 AND app_id = $2 AND is_active = TRUE",
            username, app_id)
    if not row:
        return {}
    try:
        return decrypt_credentials(row["credentials"])
    except Exception as exc:  # noqa: BLE001 — a broken entry must not abort the run
        logger.warning("Zugangsdaten %s/%s nicht lesbar: %s", username, app_id, type(exc).__name__)
        return {}


async def _store_creds(username: str, app_id: str, data: dict) -> None:
    """Create or replace. The plaintext never leaves this function."""
    encrypted = encrypt_credentials(data)
    async with user_tx(username) as conn:   # row-level security (migrations/042)
        await conn.execute("""
            INSERT INTO claraos_app_credentials
                (username, app_id, account_name, credentials, is_active)
            VALUES ($1, $2, 'ClaraOS', $3, TRUE)
            ON CONFLICT (username, app_id, account_name)
            DO UPDATE SET credentials = EXCLUDED.credentials, is_active = TRUE
        """, username, app_id, encrypted)
    logger.info("PROVISION: Zugangsdaten %s/%s hinterlegt", username, app_id)


def _new_password() -> str:
    return secrets.token_urlsafe(24)


# ── Immich ──────────────────────────────────────────────────────────────────

def _immich_treffer(konten: list[dict], email: str, ak_uid: str) -> dict | None:
    """Find the Immich account for a ClaraOS user.

    Warning: **do not match by email.** Immich may store a user under a different
    address (e.g. an internal domain) than Authentik, and users may have
    registered in Immich with another private address. An email match
    would silently miss most users and report "no account".

    `oauthId` is reliable: Immich stores the OIDC identifier there, and it is
    the **beginning** of Authentik's `uid` (40 of 64 characters in all accounts
    checked). Hence a prefix comparison, not equality.
    Email remains only the fallback for accounts without an OIDC link.
    """
    uid = (ak_uid or "").strip()
    if uid:
        for k in konten:
            oid = (k.get("oauthId") or "").strip()
            if len(oid) >= 20 and uid.startswith(oid):
                return k
    mail = (email or "").strip().lower()
    if mail:
        for k in konten:
            if (k.get("email") or "").lower() == mail:
                return k
    return None


async def ensure_immich(username: str, email: str = "", ak_uid: str = "",
                        **_ignored: Any) -> dict:
    """Ensure an Immich API key per user.

    The account is explicitly NOT created here: Immich creates it itself on the
    first OIDC login and links it correctly to Authentik. A manually created
    account would lack that link and a second one would be created next to it
    on first login.
    """
    vorhandene = await _creds(username, "immich")
    admin_key = (await _creds(PROVISION_ADMIN, "immich")).get("api_token", "")
    if not admin_key:
        raise RuntimeError(f"Kein Immich-Verwaltungszugang unter '{PROVISION_ADMIN}' hinterlegt")

    async with httpx.AsyncClient(timeout=20) as client:
        if vorhandene.get("api_token"):
            r = await client.get(f"{IMMICH_URL}/api/users/me",
                                 headers={"x-api-key": vorhandene["api_token"]})
            if r.status_code == 200:
                return {"app": "immich", "status": "ok", "detail": "war schon eingerichtet"}

        r = await client.get(f"{IMMICH_URL}/api/admin/users", headers={"x-api-key": admin_key})
        if r.status_code != 200:
            raise RuntimeError(f"Immich: Nutzerliste nicht lesbar ({r.status_code})")
        treffer = _immich_treffer(r.json(), email, ak_uid)
        if treffer is None:
            return {"app": "immich", "status": "wartet",
                    "detail": "kein Immich-Konto gefunden — entsteht beim ersten "
                              "Immich-Login des Nutzers"}

        passwort = _new_password()
        r = await client.put(f"{IMMICH_URL}/api/admin/users/{treffer['id']}",
                             headers={"x-api-key": admin_key},
                             json={"password": passwort, "shouldChangePassword": False})
        if r.status_code not in (200, 201):
            raise RuntimeError(f"Immich: Passwort setzen fehlgeschlagen ({r.status_code})")

        r = await client.post(f"{IMMICH_URL}/api/auth/login",
                              json={"email": treffer["email"], "password": passwort})
        if r.status_code not in (200, 201):
            raise RuntimeError(f"Immich: Anmeldung als Nutzer fehlgeschlagen ({r.status_code})")
        access = r.json().get("accessToken", "")

        r = await client.post(f"{IMMICH_URL}/api/api-keys",
                              headers={"Authorization": f"Bearer {access}"},
                              json={"name": PRODUCT_NAME, "permissions": ["all"]})
        if r.status_code not in (200, 201):
            raise RuntimeError(f"Immich: Schluessel anlegen fehlgeschlagen ({r.status_code})")
        api_token = (r.json().get("secret") or "")
        if not api_token:
            raise RuntimeError("Immich: Antwort enthielt keinen Schluessel")

    await _store_creds(username, "immich", {
        "email": treffer["email"], "password": passwort, "api_token": api_token,
    })
    return {"app": "immich", "status": "geaendert", "detail": "Schluessel angelegt"}


# ── Combined call ───────────────────────────────────────────────────────────

# Installation-specific apps that are not part of the product come first
# (optional module services/user_provisioning_heim.py).
try:
    from services.user_provisioning_heim import HEIM_APPS as _HEIM_APPS
except ImportError:
    _HEIM_APPS = {}
APPS = {**_HEIM_APPS, "immich": ensure_immich}


async def provision_user(username: str, email: str = "", ak_uid: str = "",
                         apps: list[str] | None = None) -> dict:
    """Set up all (or selected) apps for a user.

    An error in one app does NOT abort the others — otherwise the whole rollout
    depends on whichever service happens to be misbehaving.
    """
    bericht: list[dict] = []
    for name in (apps or list(APPS)):
        fn = APPS.get(name)
        if fn is None:
            bericht.append({"app": name, "status": "unbekannt"})
            continue
        try:
            bericht.append(await fn(username, email=email, ak_uid=ak_uid))
        except Exception as exc:  # noqa: BLE001 — catch per app, see docstring
            logger.warning("PROVISION %s/%s: %s", username, name, exc)
            bericht.append({"app": name, "status": "fehler", "detail": str(exc)[:200]})
    return {"username": username, "ergebnis": bericht}


# ── Paperless ───────────────────────────────────────────────────────────────
#
# **No password is needed here.** Paperless runs with
# `PAPERLESS_ENABLE_HTTP_REMOTE_USER_API=true` and the header name
# `HTTP_X_AUTHENTIK_USERNAME` — so the API accepts `X-Authentik-Username`
# directly. The originally planned approach (set a password, `POST /api/token/`)
# would have been a detour with an extra secret nobody needs.
#
# Three steps, each idempotent on its own:
#   1. Call `/api/profile/` as the user — this CREATES the Paperless account if
#      missing (Django's RemoteUserBackend creates it on authentication).
#   2. As Paperless admin, ensure the `ClaraOS Users` group. Without it a user
#      has an account but no group = no permissions = errors in the UI.
#   3. Create a DRF token — the companion app needs it, since it talks to
#      Paperless directly and cannot set a trusted header.
#      Warning: only if we have no working one: the call creates the token
#      ANEW and thereby invalidates the old one.
PAPERLESS_URL = os.environ.get("PAPERLESS_INTERNAL_URL", "http://claraos-mod-paperless:8000")
PAPERLESS_ADMIN = os.environ.get("CLARAOS_PAPERLESS_ADMIN", "admin")
PAPERLESS_GRUPPE = os.environ.get("CLARAOS_PAPERLESS_GROUP", "ClaraOS Users")


async def ensure_paperless(username: str, **_ignored: Any) -> dict:
    getan: list[str] = []
    async with httpx.AsyncClient(timeout=20) as client:
        alsNutzer = {"X-Authentik-Username": username}
        alsAdmin = {"X-Authentik-Username": PAPERLESS_ADMIN}

        # 1. Ensure the account (the call creates it if needed)
        r = await client.get(f"{PAPERLESS_URL}/api/profile/", headers=alsNutzer)
        if r.status_code != 200:
            raise RuntimeError(f"Paperless: Profil nicht abrufbar ({r.status_code})")

        # 2. Ensure the group
        r = await client.get(f"{PAPERLESS_URL}/api/groups/", headers=alsAdmin)
        if r.status_code != 200:
            raise RuntimeError(f"Paperless: Gruppen nicht lesbar ({r.status_code}) — "
                               f"ist '{PAPERLESS_ADMIN}' dort Administrator?")
        gruppe = next((g for g in r.json().get("results", [])
                       if g["name"] == PAPERLESS_GRUPPE), None)
        if gruppe is None:
            raise RuntimeError(f"Paperless: Gruppe '{PAPERLESS_GRUPPE}' existiert nicht")

        r = await client.get(f"{PAPERLESS_URL}/api/users/?page_size=200", headers=alsAdmin)
        if r.status_code != 200:
            raise RuntimeError(f"Paperless: Nutzerliste nicht lesbar ({r.status_code})")
        konto = next((u for u in r.json().get("results", [])
                      if u["username"] == username), None)
        if konto is None:
            raise RuntimeError("Paperless: Konto trotz Profilaufruf nicht gefunden")

        if gruppe["id"] not in (konto.get("groups") or []):
            neue = sorted(set((konto.get("groups") or []) + [gruppe["id"]]))
            r = await client.patch(f"{PAPERLESS_URL}/api/users/{konto['id']}/",
                                   headers=alsAdmin, json={"groups": neue})
            if r.status_code not in (200, 202):
                raise RuntimeError(f"Paperless: Gruppe setzen fehlgeschlagen ({r.status_code})")
            getan.append(f"Gruppe '{PAPERLESS_GRUPPE}' zugewiesen")

        # 3. Only create a token if none works
        vorhandene = await _creds(username, "paperless")
        token = vorhandene.get("api_token", "")
        if token:
            r = await client.get(f"{PAPERLESS_URL}/api/documents/?page_size=1",
                                 headers={"Authorization": f"Token {token}"})
            if r.status_code == 200:
                return {"app": "paperless", "status": "geaendert" if getan else "ok",
                        "detail": ", ".join(getan) or "war schon eingerichtet"}

        r = await client.post(f"{PAPERLESS_URL}/api/profile/generate_auth_token/",
                              headers=alsNutzer)
        if r.status_code not in (200, 201):
            raise RuntimeError(f"Paperless: Token erzeugen fehlgeschlagen ({r.status_code})")
        neu = r.text.strip().strip('"')
        if len(neu) < 20:
            raise RuntimeError("Paperless: Antwort enthielt keinen brauchbaren Token")

    await _store_creds(username, "paperless", {"username": username, "api_token": neu})
    getan.append("Token erzeugt")
    return {"app": "paperless", "status": "geaendert", "detail": ", ".join(getan)}


# Note: `APPS` is defined above, `ensure_paperless` only down here.
# So register it here instead of referencing it above — otherwise NameError on
# import (py_compile does not catch this, it only checks syntax).
APPS["paperless"] = ensure_paperless


# ── Bulk run + nightly run ──────────────────────────────────────────────────
#
# Three triggers, deliberately redundant — each alone has a gap:
#   1. On creation (user_admin.create_user) — fastest feedback, but does not
#      cover accounts created directly in Authentik.
#   2. On completion of the setup wizard — does not apply without the wizard.
#   3. This nightly run — THE safety net. It is also the only trigger that
#      catches cases that only become possible LATER: the Immich account is
#      created on the user's first login, often days after creation.
#
# The run is cheap because `ensure_*` is idempotent: where nothing is missing it
# costs one status request. So it may run more often than necessary.

# Patterns for accounts that are never part of a rollout (`_is_service()` did not
# recognise test accounts that are members of the regular users group).
TESTKONTO_MUSTER = ("test", "e2e", "smoke", "probe", "playwright", "demo")

_INITIAL_DELAY_S = int(os.environ.get("CLARAOS_PROVISION_INITIAL_DELAY", "300"))
_INTERVAL_S = int(os.environ.get("CLARAOS_PROVISION_INTERVAL", str(24 * 3600)))
_task = None


def ist_rollout_nutzer(username: str, groups: list[str], is_bot: bool,
                       is_active: bool) -> bool:
    """Does this account belong in the rollout?"""
    if not is_active or is_bot:
        return False
    if "clara-users" not in groups:
        return False
    if username.startswith("ak-outpost-"):
        return False
    return not any(m in username.lower() for m in TESTKONTO_MUSTER)


async def provision_all() -> dict:
    """Catch up all real users. Idempotent, safe to repeat."""
    from routers.teams_admin import AUTHENTIK_URL, _ak_headers
    async with httpx.AsyncClient(verify=False, timeout=25) as c:
        r = await c.get(f"{AUTHENTIK_URL}/api/v3/core/users/?page_size=200",
                        headers=_ak_headers())
    if r.status_code != 200:
        raise RuntimeError(f"Authentik nicht erreichbar ({r.status_code})")

    berichte, uebersprungen = [], []
    for u in r.json().get("results", []):
        name = u["username"]
        attrs = u.get("attributes") or {}
        groups = [g["name"] for g in u.get("groups_obj", [])]
        if not ist_rollout_nutzer(name, groups, bool(attrs.get("is_bot", False)),
                                  bool(u.get("is_active", True))):
            uebersprungen.append(name)
            continue
        berichte.append(await provision_user(
            name, email=u.get("email", ""), ak_uid=u.get("uid", "")))
    return {"nutzer": len(berichte), "berichte": berichte,
            "uebersprungen": uebersprungen}


def _zusammenfassung(ergebnis: dict) -> tuple[int, int, list[str]]:
    geaendert = fehler = 0
    details: list[str] = []
    for b in ergebnis["berichte"]:
        for e in b["ergebnis"]:
            if e["status"] == "geaendert":
                geaendert += 1
                details.append(f"{b['username']}/{e['app']}: {e.get('detail','')}")
            elif e["status"] == "fehler":
                fehler += 1
                details.append(f"{b['username']}/{e['app']}: FEHLER {e.get('detail','')}")
    return geaendert, fehler, details


async def _loop() -> None:
    logger.warning("[provisioning] Nachtlauf aktiv (Takt %ss, Start in %ss)",
                   _INTERVAL_S, _INITIAL_DELAY_S)
    await asyncio.sleep(_INITIAL_DELAY_S)
    while True:
        try:
            ergebnis = await provision_all()
            geaendert, fehler, details = _zusammenfassung(ergebnis)
            # Only report when something actually happened. A run that finds
            # nothing is the normal case and does not belong in the log — otherwise
            # the one run where something was missing gets lost in the noise.
            if geaendert or fehler:
                logger.warning("[provisioning] %d nachgezogen, %d Ausfaelle: %s",
                               geaendert, fehler, details[:10])
            else:
                logger.info("[provisioning] %d Nutzer, nichts zu tun",
                            ergebnis["nutzer"])
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[provisioning] Nachtlauf gescheitert")
        await asyncio.sleep(_INTERVAL_S)


def start_background() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.get_event_loop().create_task(_loop())


async def provision_im_hintergrund(username: str, email: str = "",
                                   ak_uid: str = "") -> None:
    """Triggers 1+2: provision in the background.

    Deliberately without feedback to the caller and with its own safety net:
    if Immich is down, neither user creation nor completing the setup wizard
    may fail because of it. Whatever falls through here is caught by the
    nightly run.
    """
    try:
        ergebnis = await provision_user(username, email=email, ak_uid=ak_uid)
        for e in ergebnis["ergebnis"]:
            if e["status"] == "fehler":
                logger.warning("[provisioning] %s/%s: %s", username, e["app"],
                               e.get("detail", ""))
    except Exception:
        logger.exception("[provisioning] Hintergrundlauf fuer %s gescheitert", username)
