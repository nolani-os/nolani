"""Vaultwarden client — bw CLI wrapper, used by routers/vault.py.

Authenticates as Clara (Org Owner) via API-key + master-password from env.
Caches the unlock-session in memory; lazy refresh if locked.

Public surface (used by routers/vault.py):
  - get_user_collection_id(username, kind)        — Personal-{username} | "Family-Shared"
  - list_items_for(username, *, include_family)   — items the user is allowed to see
  - get_item_full(item_id)                        — item incl. password (Clara has access)
  - create_item(username, name, login_user, login_pwd, uri, notes, kind)
  - update_item(item_id, name?, login_user?, login_pwd?, uri?, notes?)
  - delete_item(item_id)                          — soft-delete (move to trash)

All operations run as Clara — there is no per-user bw session. The router is
responsible for filtering items by collection-membership BEFORE returning
to the user.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
from typing import Any, Optional

from domains_generated import BASE_DOMAIN  # cell: CLARAOS_BASE_DOMAIN

log = logging.getLogger("vw-client")

VW_URL = os.environ.get("VW_URL", f"https://vault.{BASE_DOMAIN}")
VW_ORG_ID = os.environ.get("VW_ORG_ID", "")
BW_CLIENTID = os.environ.get("BW_CLIENTID", "")
BW_CLIENTSECRET = os.environ.get("BW_CLIENTSECRET", "")
BW_PASSWORD = os.environ.get("BW_PASSWORD", "")
BW_DATA_DIR = os.environ.get("BW_DATA_DIR", "/app/.bw_data")

_session_lock = threading.Lock()
_session_token: str = ""
_last_sync: float = 0.0
SYNC_INTERVAL = 60  # re-sync at most once per minute
KEEPALIVE_INTERVAL = 300  # background ping every 5 min to keep session warm

# Short-TTL caches — avoid paying 3–4 s `bw` subprocess cost on every call
_ITEMS_CACHE_TTL = 15.0       # /items hot for 15 s
_COLLS_CACHE_TTL = 120.0      # collections change rarely
_items_cache: dict[str, Any] = {"data": None, "ts": 0.0}
_colls_cache: dict[str, Any] = {"data": None, "ts": 0.0}

_keepalive_thread: Optional[threading.Thread] = None
_keepalive_stop = threading.Event()


def invalidate_caches() -> None:
    """Force-refresh on next read. Called after create/update/delete."""
    _items_cache["ts"] = 0.0
    _colls_cache["ts"] = 0.0


def _env() -> dict[str, str]:
    e = os.environ.copy()
    e["BITWARDENCLI_APPDATA_DIR"] = BW_DATA_DIR
    e["BW_CLIENTID"] = BW_CLIENTID
    e["BW_CLIENTSECRET"] = BW_CLIENTSECRET
    e["BW_PASSWORD"] = BW_PASSWORD
    e["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"
    return e


def _bw(args: list[str], session: Optional[str] = None, input_text: Optional[str] = None,
        timeout: int = 30) -> dict[str, Any]:
    e = _env()
    if session:
        e["BW_SESSION"] = session
    try:
        r = subprocess.run(
            ["bw"] + args,
            capture_output=True, text=True, env=e,
            input=input_text, timeout=timeout,
        )
        return {"out": r.stdout.strip(), "err": r.stderr.strip(), "rc": r.returncode}
    except subprocess.TimeoutExpired:
        return {"out": "", "err": f"bw timeout after {timeout}s", "rc": -1}



def _tail_error(text: str, limit: int = 200) -> str:
    """Last meaningful line of a bw error output.

    With NODE_TLS_REJECT_UNAUTHORIZED=0, `bw` writes a multi-line Node warning to
    stderr — a blunt err[:200] only shows that warning and swallows the real
    reason.
    """
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    noise = ("warning:", "(use `", "(node:")
    useful = [l for l in lines if not l.lower().startswith(noise)]
    return (useful[-1] if useful else (lines[-1] if lines else ""))[:limit]

def _ensure_session() -> str:
    """Return an unlocked session-token, refreshing if needed. Thread-safe."""
    global _session_token, _last_sync
    with _session_lock:
        if _session_token:
            st = _bw(["status", "--raw"], session=_session_token)
            try:
                if json.loads(st["out"]).get("status") == "unlocked":
                    # opportunistic sync
                    if time.time() - _last_sync > SYNC_INTERVAL:
                        _bw(["sync"], session=_session_token)
                        _last_sync = time.time()
                    return _session_token
            except Exception:
                pass

        # Cold-start: logout/login/unlock
        _bw(["logout"])
        _bw(["config", "server", VW_URL])
        li = _bw(["login", "--apikey"])
        if li["rc"] != 0:
            # `bw logout` does not always clear the state; then `login` reports
            # "You are already logged in" — that is not an error, we only need an
            # unlock. Everything else remains a real error.
            # (Without this, the vault app kept returning empty lists after the
            # session expired.)
            combined = (li["err"] or "") + (li["out"] or "")
            if "already logged in" not in combined.lower():
                raise RuntimeError(f"bw login failed: {_tail_error(combined)}")
        un = _bw(["unlock", "--raw"], input_text=BW_PASSWORD + "\n")
        tok = un["out"].strip()
        if not tok:
            raise RuntimeError(f"bw unlock failed: {_tail_error(un['err'])}")
        _session_token = tok
        _bw(["sync"], session=tok)
        _last_sync = time.time()
        return tok


# ── Public API ─────────────────────────────────────────────────────


def list_org_collections() -> list[dict]:
    now = time.time()
    if _colls_cache["data"] is not None and (now - _colls_cache["ts"]) < _COLLS_CACHE_TTL:
        return _colls_cache["data"]
    sess = _ensure_session()
    r = _bw(["list", "org-collections", "--organizationid", VW_ORG_ID], session=sess)
    if r["rc"] != 0:
        raise RuntimeError(f"list collections: {r['err'][:200]}")
    data = json.loads(r["out"])
    _colls_cache["data"] = data
    _colls_cache["ts"] = now
    return data


def get_user_collection_id(username: str, kind: str = "personal") -> Optional[str]:
    """Return collection-id for "Personal-{username}" or "Family-Shared" or "Admin-Only"."""
    target = f"Personal-{username}" if kind == "personal" else \
             "Family-Shared" if kind == "family" else \
             "Admin-Only" if kind == "admin" else \
             kind
    for c in list_org_collections():
        if c.get("name") == target:
            return c["id"]
    return None


def list_org_items() -> list[dict]:
    now = time.time()
    if _items_cache["data"] is not None and (now - _items_cache["ts"]) < _ITEMS_CACHE_TTL:
        return _items_cache["data"]
    sess = _ensure_session()
    r = _bw(["list", "items", "--organizationid", VW_ORG_ID], session=sess)
    if r["rc"] != 0:
        raise RuntimeError(f"list items: {r['err'][:200]}")
    data = json.loads(r["out"])
    _items_cache["data"] = data
    _items_cache["ts"] = now
    return data


def list_items_for(username: str, *, include_family: bool = True,
                   include_admin: bool = False) -> list[dict]:
    """Return items in user's accessible collections.

    If `include_family=True` and the user is in Family-Shared (which the API
    knows because the caller has decided so), include those items too.
    """
    personal_id = get_user_collection_id(username, "personal")
    family_id = get_user_collection_id(username, "family") if include_family else None
    admin_id = get_user_collection_id(username, "admin") if include_admin else None
    allowed = {c for c in (personal_id, family_id, admin_id) if c}

    # Warning: third-party service credentials live in a SEPARATE collection
    # ("Drittdienste") so the service hub can keep them apart from internal entries.
    # Without this line they were missing from EVERY vault view of the app —
    # entries were invisible even though they existed in Vaultwarden (noticed via an
    # empty selection list in the hub form).
    # Deliberately ONLY in the `include_admin` branch: only callers that have checked
    # admin rights beforehand set this flag — visibility for non-admin users cannot
    # change because of it.
    # ID from the same variable as the hub filter, so there is ONE source of truth.
    if include_admin:
        hub_col = os.environ.get("CLARAOS_HUB_VAULT_COLLECTION", "").strip()
        if hub_col:
            allowed.add(hub_col)

    if not allowed:
        return []
    out = []
    for it in list_org_items():
        item_colls = set(it.get("collectionIds") or [])
        if item_colls & allowed:
            out.append(it)
    return out


def get_item_full(item_id: str) -> Optional[dict]:
    """Return single item incl. login.password (decrypted by Clara's session)."""
    sess = _ensure_session()
    r = _bw(["get", "item", item_id], session=sess)
    if r["rc"] != 0:
        return None
    return json.loads(r["out"])


def _get_template(name: str) -> dict:
    sess = _ensure_session()
    r = _bw(["get", "template", name], session=sess)
    if r["rc"] != 0:
        return {}
    return json.loads(r["out"])


def create_item(username: str, name: str, login_user: str, login_pwd: str,
                uri: str = "", notes: str = "", kind: str = "personal") -> dict:
    """Create an item in the requested collection (default: Personal-{username})."""
    coll_id = get_user_collection_id(username, kind)
    if not coll_id:
        raise RuntimeError(f"collection not found for user={username} kind={kind}")
    sess = _ensure_session()
    tpl_item = _get_template("item")
    tpl_login = _get_template("item.login")
    tpl_uri = _get_template("item.login.uri")

    body = dict(tpl_item)
    body["organizationId"] = VW_ORG_ID
    body["collectionIds"] = [coll_id]
    body["name"] = name
    body["notes"] = notes or None
    body["type"] = 1  # login
    login = dict(tpl_login)
    login["username"] = login_user
    login["password"] = login_pwd
    if uri:
        u = dict(tpl_uri); u["uri"] = uri; u["match"] = None
        login["uris"] = [u]
    body["login"] = login

    enc = _bw(["encode"], session=sess, input_text=json.dumps(body))
    cr = _bw(["create", "item"], session=sess, input_text=enc["out"])
    if cr["rc"] != 0:
        raise RuntimeError(f"create item: {cr['err'][:200]}")
    invalidate_caches()
    return json.loads(cr["out"])


def update_item(item_id: str, *, name: Optional[str] = None,
                login_user: Optional[str] = None, login_pwd: Optional[str] = None,
                uri: Optional[str] = None, notes: Optional[str] = None) -> dict:
    sess = _ensure_session()
    cur = get_item_full(item_id)
    if not cur:
        raise RuntimeError("item not found")
    if name is not None:
        cur["name"] = name
    if notes is not None:
        cur["notes"] = notes or None
    login = cur.get("login") or {}
    if login_user is not None:
        login["username"] = login_user
    if login_pwd is not None:
        login["password"] = login_pwd
    if uri is not None:
        login["uris"] = [{"uri": uri, "match": None}] if uri else []
    cur["login"] = login

    enc = _bw(["encode"], session=sess, input_text=json.dumps(cur))
    er = _bw(["edit", "item", item_id], session=sess, input_text=enc["out"])
    if er["rc"] != 0:
        raise RuntimeError(f"edit item: {er['err'][:200]}")
    invalidate_caches()
    return json.loads(er["out"])


def delete_item(item_id: str) -> bool:
    """Soft-delete (move to trash). Use --permanent for hard delete."""
    sess = _ensure_session()
    r = _bw(["delete", "item", item_id], session=sess)
    if r["rc"] == 0:
        invalidate_caches()
    return r["rc"] == 0


def is_user_in_family_shared(username: str) -> bool:
    """Heuristic: family-shared membership inferred from VW DB indirectly.
    For the MVP we say: only PROTECTED_USERS (admin/clara) + members of
    'team-family' Authentik-group see Family-Shared. The router should pass
    in the user's groups; this helper just exists for completeness.
    """
    return False  # router decides — see vault.py


# ── Background keep-alive ──────────────────────────────────────────


def _keepalive_loop() -> None:
    """Background thread: keeps the bw session unlocked + opportunistically
    syncs + pre-warms items/collections caches. Runs in claraos-api's
    lifespan startup hook so the first user /items call is hot."""
    while not _keepalive_stop.is_set():
        try:
            _ensure_session()
            # pre-warm caches so first /items GET is <1s
            list_org_collections()
            list_org_items()
        except Exception as e:
            log.warning("keep-alive cycle failed: %s", e)
        _keepalive_stop.wait(KEEPALIVE_INTERVAL)


def start_keepalive() -> None:
    """Idempotent start; called from lifespan."""
    global _keepalive_thread
    if _keepalive_thread and _keepalive_thread.is_alive():
        return
    if not (BW_CLIENTID and BW_PASSWORD and VW_ORG_ID):
        log.info("keep-alive not started: BW_*/VW_ORG_ID env-vars missing")
        return
    _keepalive_stop.clear()
    _keepalive_thread = threading.Thread(target=_keepalive_loop, daemon=True, name="vw-keepalive")
    _keepalive_thread.start()
    log.info("vault-keepalive started (interval=%ds)", KEEPALIVE_INTERVAL)


def stop_keepalive() -> None:
    _keepalive_stop.set()
