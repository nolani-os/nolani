"""Per-user app access in a cell, created on demand.

At home every user connects their own app accounts in ClaraOS (the encrypted
credentials store), and Clara's tools use that user's own token
(routers/clara_tools.py, `per_user`). In a cell people only sign in through ClaraOS
(OIDC) and have no app passwords or keys. So when Clara needs app X for user U and
no stored access exists, the cell creates one itself through X's admin interface and
stores it exactly like a user-connected account. From then on the normal per-user
path applies — the tool sees only what U may see in X.

Rules:
  * only for accounts that already exist in the app (the user opened it once via
    the tile) — creating app accounts here would collide with the app's own OIDC
    sign-up;
  * never for administrators of the app;
  * the stored value is the app's own per-user token, never an admin credential.
"""
from __future__ import annotations

import logging
import os
import secrets

import httpx

from betriebsprofil import ASSISTANT_NAME, IS_CELL
from tlsverify import TLS_VERIFY  # central switch: CLARAOS_TLS_VERIFY / CLARAOS_TLS_CA

logger = logging.getLogger(__name__)


class ZugangFehlt(Exception):
    """The app account does not exist yet — the message tells the user what to do."""


# ── Paperless ─────────────────────────────────────────────────────────────────
PAPERLESS_URL = os.environ.get("PAPERLESS_INTERNAL_URL", "http://paperless:8000").rstrip("/")


async def _paperless(username: str) -> dict:
    """A Paperless API token for `username`.

    Paperless has no admin endpoint to issue a token for someone else. The user signs
    in only via OIDC and has no usable password, so: the admin sets a random password
    for that (non-admin) account, the token is obtained once with it, and the password
    is forgotten. Interactive login stays OIDC-only (PAPERLESS_DISABLE_REGULAR_LOGIN)."""
    admin_pw = os.environ.get("PAPERLESS_ADMIN_PASSWORD", "")
    if not admin_pw:
        raise ZugangFehlt(f"Paperless ist in dieser Zelle nicht für {ASSISTANT_NAME} eingerichtet.")
    admin = ("admin", admin_pw)
    async with httpx.AsyncClient(base_url=PAPERLESS_URL, timeout=30) as c:
        r = await c.get("/api/users/", params={"username__iexact": username}, auth=admin)
        r.raise_for_status()
        treffer = [u for u in r.json().get("results", []) if u.get("username") == username]
        if not treffer:
            raise ZugangFehlt(f"Öffne Paperless einmal über die Kachel — danach kann {ASSISTANT_NAME} "
                              "auf deine Dokumente zugreifen.")
        u = treffer[0]
        if u.get("is_superuser") or u.get("is_staff"):
            raise ZugangFehlt(f"Für Paperless-Administratoren legt {ASSISTANT_NAME} keinen Zugang an.")
        pw = secrets.token_urlsafe(32)
        r = await c.patch(f"/api/users/{u['id']}/", json={"password": pw}, auth=admin)
        r.raise_for_status()
        r = await c.post("/api/token/", data={"username": username, "password": pw})
        r.raise_for_status()
        token = r.json().get("token")
    if not token:
        raise RuntimeError("Paperless hat keinen Schlüssel ausgegeben")
    return {"api_token": token}


# ── Mastodon ──────────────────────────────────────────────────────────────────

async def _ueber_ctl(app: str, name: str, username: str) -> str:
    """A per-user key from the browser controller (deploy/cell/browser/ctl.py /zugang) —
    for apps without an admin API to issue one (Mastodon: rails, Immich: its database)."""
    from services import zellen_browser
    if not zellen_browser.CTL_URL:
        raise ZugangFehlt(f"{name} ist in dieser Zelle nicht für {ASSISTANT_NAME} eingerichtet.")
    async with httpx.AsyncClient(timeout=260) as c:          # Mastodon boots rails: ~1 min
        r = await c.post(f"{zellen_browser.CTL_URL}/zugang", json={"user": username, "app": app},
                         headers={"X-Browser-Ctl-Token": zellen_browser.CTL_TOKEN})
    d = r.json() if r.content else {}
    if r.status_code == 200 and d.get("token"):
        return d["token"]
    grund = d.get("reason")
    if grund == "KEIN_KONTO":
        raise ZugangFehlt(f"Öffne {name} einmal über die Kachel und melde dich an — danach "
                          f"kann {ASSISTANT_NAME} dort für dich lesen.")
    if grund == "PRIVILEGIERT":
        raise ZugangFehlt(f"Für {name}-Konten mit Admin- oder Moderationsrechten legt {ASSISTANT_NAME} "
                          f"keinen Zugang an.")
    if grund == "no_app":
        raise ZugangFehlt(f"In dieser Zelle läuft kein {name}.")
    raise RuntimeError(f"{name}-Zugang: HTTP {r.status_code}")


async def _mastodon(username: str) -> dict:
    """Mastodon: read + post (posting waits for the user's approval, `freigabe`)."""
    return {"access_token": await _ueber_ctl("mastodon", "Mastodon", username)}


async def _immich(username: str) -> dict:
    """Immich: read-only key (photos, albums, people) — no upload, delete or share."""
    return {"api_key": await _ueber_ctl("immich", "Immich", username)}


# ── Odoo ──────────────────────────────────────────────────────────────────────
ODOO_URL = os.environ.get("ODOO_INTERNAL_URL", "http://odoo:8069").rstrip("/")
ODOO_DB = os.environ.get("ODOO_DB", "odoo")


class OdooFehler(RuntimeError):
    """An error Odoo reported: `name` is the exception class (e.g.
    odoo.exceptions.AccessError) — classify by it, the message is translated."""

    def __init__(self, name: str, message: str):
        super().__init__(f"Odoo: {message}"[:300])
        self.name = name
        self.message = message


async def odoo_rpc(service: str, method: str, *args):
    """One JSON-RPC call to Odoo (`/jsonrpc`). Raises PermissionError on a rejected
    login, OdooFehler on any other Odoo error (message without the traceback)."""
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{ODOO_URL}/jsonrpc", json={
            "jsonrpc": "2.0", "method": "call", "id": 1,
            "params": {"service": service, "method": method, "args": list(args)}})
    r.raise_for_status()
    d = r.json()
    if "error" in d:
        data = d["error"].get("data") or {}
        name = data.get("name", "")
        if "AccessDenied" in name:
            raise PermissionError("Odoo lehnt die Anmeldung ab")
        raise OdooFehler(name, str(data.get("message") or d["error"].get("message") or ""))
    return d.get("result")


async def _email(username: str) -> str:
    """The cell account's email address — Odoo accounts created through the cell's
    login use it as their login."""
    from routers.teams_admin import AUTHENTIK_URL, _ak_headers
    async with httpx.AsyncClient(verify=TLS_VERIFY, timeout=15) as c:
        r = await c.get(f"{AUTHENTIK_URL}/api/v3/core/users/", headers=_ak_headers(),
                        params={"username": username})
    r.raise_for_status()
    treffer = [u for u in r.json().get("results", []) if u.get("username") == username]
    mail = (treffer[0].get("email") or "").strip() if treffer else ""
    if not mail:
        raise ZugangFehlt(f"Dein Konto hat keine E-Mail-Adresse — ohne sie findet {ASSISTANT_NAME} "
                          "dein Odoo-Konto nicht.")
    return mail


async def _odoo(username: str) -> dict:
    """Odoo: the user's own account, with exactly the rights it has in Odoo.

    Odoo issues API keys only to the signed-in user themselves (behind an identity
    check), not through an admin. The user signs in via OIDC and has no password, so —
    as for Paperless — the admin sets a random password for that (internal, non-admin)
    account and the cell stores `uid:password` as the user's access. JSON-RPC calls
    with it run as that user: record rules and access rights apply as in the UI."""
    admin_pw = os.environ.get("ODOO_ADMIN_PASSWORD", "")
    if not admin_pw:
        raise ZugangFehlt(f"Odoo ist in dieser Zelle nicht für {ASSISTANT_NAME} eingerichtet.")
    mail = await _email(username)
    admin_uid = await odoo_rpc("common", "authenticate", ODOO_DB, "admin", admin_pw, {})
    if not admin_uid:
        raise RuntimeError("Odoo: Verwaltungszugang abgelehnt")

    async def als_admin(model, method, *args, **kw):
        return await odoo_rpc("object", "execute_kw", ODOO_DB, admin_uid, admin_pw,
                              model, method, list(args), kw)

    konten = await als_admin("res.users", "search_read", [["login", "=ilike", mail]],
                             fields=["id", "share", "groups_id"], limit=2)
    if not konten:
        raise ZugangFehlt(f"Öffne Odoo einmal über die Kachel und melde dich an — danach kann "
                          f"{ASSISTANT_NAME} dort für dich arbeiten.")
    konto = konten[0]
    if konto.get("share"):
        raise ZugangFehlt("Dein Odoo-Konto ist ein Portal-Konto ohne Zugriff auf die Firmendaten.")
    gruppen = await als_admin("ir.model.data", "search_read",
                              [["model", "=", "res.groups"], ["module", "=", "base"],
                               ["name", "in", ["group_system", "group_erp_manager"]]],
                              fields=["res_id"])
    if {g["res_id"] for g in gruppen} & set(konto.get("groups_id") or []):
        raise ZugangFehlt(f"Für Odoo-Administratoren legt {ASSISTANT_NAME} keinen Zugang an.")
    pw = secrets.token_urlsafe(32)
    await als_admin("res.users", "write", [konto["id"]], {"password": pw})
    return {"zugang": f"{konto['id']}:{pw}"}


_ERZEUGER = {"paperless": _paperless, "mastodon": _mastodon, "immich": _immich, "odoo": _odoo}


def kann(app_id: str) -> bool:
    """Does this cell create access for `app_id` itself (so a stale one can be renewed)?"""
    return bool(IS_CELL and app_id in _ERZEUGER)


async def anlegen(app_id: str, username: str) -> bool:
    """Create and store access for (`app_id`, `username`) if this cell knows how.

    Returns False when there is nothing to do here (not a cell / unknown app).
    Raises ZugangFehlt when the user has to do something first."""
    erzeuger = _ERZEUGER.get(app_id)
    if not (IS_CELL and erzeuger and username):
        return False
    from database import user_tx
    from encryption import encrypt_credentials
    werte = await erzeuger(username)
    async with user_tx(username) as conn:          # row-level security (migrations/042)
        await conn.execute(
            """INSERT INTO claraos_app_credentials (username, app_id, account_name, credentials, is_active)
               VALUES ($1, $2, 'Clara', $3, TRUE)
               ON CONFLICT (username, app_id, account_name)
               DO UPDATE SET credentials = EXCLUDED.credentials, is_active = TRUE, updated_at = NOW()""",
            username, app_id, encrypt_credentials(werte))
    logger.info("cell access created: %s for %s", app_id, username)
    return True
