"""Server-side publishing to per-user ntfy topics.

Reusable helper: sends a notification to ALL active human ClaraOS users
(except `exclude`). Topic convention = `_safe_ntfy_username(username)` as in
routers/ntfy_proxy.py; publishing uses the ntfy admin token (user ACLs only
allow rw on the user's OWN topic).

Intended as fire-and-forget: `asyncio.create_task(notify_all_users(...))`.
"""

from __future__ import annotations

from betriebsprofil import heim_default  # external deployment: no silent home-network fallback
import base64
import logging
import os
import re
from urllib.parse import quote

import httpx
import domains_generated as domains
from sprache import Text, fuer, sprache_fuer

logger = logging.getLogger(__name__)

AUTHENTIK_URL = heim_default("AUTHENTIK_URL", key="AUTHENTIK_URL@ntfy_publish")
AUTHENTIK_TOKEN = os.environ.get("AUTHENTIK_API_TOKEN", "")
NTFY_INTERNAL_URL = heim_default("NTFY_INTERNAL_URL")
NTFY_ADMIN_TOKEN = os.environ.get("NTFY_ADMIN_TOKEN", "")
CLARAOS_PUBLIC_URL = os.environ.get("CLARAOS_PUBLIC_URL", domains.shell_url())


def _safe_ntfy_username(authentik_username: str) -> str:
    # Identical to routers/ntfy_proxy.py — topic == provisioned ntfy user.
    return "".join(c.lower() if c.isalnum() or c in "-_" else "_" for c in authentik_username)[:64]


# Service/test/bot accounts that do not count as real users
# (Authentik does not always flag them as is_bot).
_SVC_SUFFIXES = ("-svc", "-api", "-service", "-bot", "-test")
_SVC_SUBSTR = ("service", "outpost", "e2e", ".bot", "_svc", "_bot")


def _is_service_account(username: str, attrs: dict | None = None,
                        groups: list | None = None, typ: str | None = None) -> bool:
    """Is this a service account? — `typ` is Authentik's own field and takes precedence.

    Warning: this used to be decided EXCLUSIVELY by name patterns. Accounts such as
    smoke-test or drift-check accounts without a service suffix matched none of them and were therefore
    treated as humans — they received the daily planner digest and showed up in the
    calendar invitation picker and in player lists.
    A deny-list only knows what its author thought of while writing it.

    Authentik already tracks this itself: `type` is `internal`, `service_account` or
    `internal_service_account`. Once misclassified accounts are corrected, the field
    is the source of truth.
    Measured, not assumed: a `service_account` can still log in interactively in
    Authentik — verified with a control case, a real login and a full SSO round trip.

    The name patterns remain as a SECOND barrier: they cost nothing and catch the case
    where someone creates a service account as a regular user again.
    """
    if typ is not None and typ != "internal":
        return True
    u = username.lower()
    if u == "akadmin" or u.startswith("ak-outpost-"):
        return True
    if bool((attrs or {}).get("is_bot", False)) or "claraos-bots" in (groups or []):
        return True
    if any(u.endswith(s) for s in _SVC_SUFFIXES):
        return True
    if any(s in u for s in _SVC_SUBSTR):
        return True
    return False


def konto_art(u: dict) -> str:
    """Returns "dienst" (service) · "mensch" (human) · **"unklar" (unclear)** — the ONE place where this is decided.

    The actual point: a rule with only two outcomes has to guess as soon as the data
    is incomplete — and when in doubt it guesses "human", because that is the default.
    That is exactly how misclassified accounts arise without anyone noticing.

    Hence a third outcome. "unklar" means: Authentik's field says human, the name/bot
    check says service — a contradiction that a person has to look at.
    Important: "unklar" is treated like a service: no notifications, not in pickers.
       That error reports itself ("I am not in the list"), the reverse one never does.
       And the `konten-wache` monitor reports it daily.
    """
    attrs = u.get("attributes") or {}
    gruppen = [g["name"] for g in (u.get("groups_obj") or []) if isinstance(g, dict)]
    name = (u.get("username") or "").lower()
    typ = u.get("type")

    # 1) Authentik's own field.
    if typ is not None and typ != "internal":
        return "dienst"

    # 2) DECLARATIONS, not guesses: Authentik's own infrastructure accounts plus an
    #    explicit `is_bot` or the bot group. That `akadmin` and the outposts are
    #    services is a fact of the software — not guesswork.
    #    Without this distinction the monitor would report `akadmin` as "unklar"
    #    EVERY day. A finding that can never be resolved is exactly the noise this
    #    design is meant to eliminate.
    if name == "akadmin" or name.startswith("ak-outpost-"):
        return "dienst"
    if bool(attrs.get("is_bot", False)) or "claraos-bots" in gruppen:
        return "dienst"

    # 3) Only the GUESSED part triggers a contradiction.
    if _is_service_account(name, attrs, gruppen):
        return "unklar"
    return "mensch"


async def _list_human_usernames(client: httpx.AsyncClient) -> list[str]:
    """Active human Authentik users (pattern from routers/impersonate.py)."""
    if not AUTHENTIK_TOKEN:
        logger.warning("ntfy_publish: AUTHENTIK_API_TOKEN fehlt — kein Broadcast")
        return []
    resp = await client.get(
        f"{AUTHENTIK_URL}/api/v3/core/users/?page_size=200&is_active=true",
        headers={"Authorization": f"Bearer {AUTHENTIK_TOKEN}"},
    )
    if resp.status_code != 200:
        logger.warning("ntfy_publish: Authentik API %s", resp.status_code)
        return []
    users = []
    for u in resp.json().get("results", []):
        attrs = u.get("attributes") or {}
        groups = [g["name"] for g in u.get("groups_obj", [])]
        if konto_art(u) != "mensch":
            continue
        users.append(u["username"])
    return users


async def list_human_usernames() -> list[str]:
    """Public helper: active human ClaraOS users (for the contact picker)."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        return await _list_human_usernames(client)


async def list_human_people() -> list[dict]:
    """Active human users as {username, name} — for the invitation picker.
    Deliberately NO email (no leak to regular users)."""
    if not AUTHENTIK_TOKEN:
        return []
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{AUTHENTIK_URL}/api/v3/core/users/?page_size=200&is_active=true",
            headers={"Authorization": f"Bearer {AUTHENTIK_TOKEN}"})
        if resp.status_code != 200:
            return []
        people = []
        for u in resp.json().get("results", []):
            attrs = u.get("attributes") or {}
            groups = [g["name"] for g in u.get("groups_obj", [])]
            if konto_art(u) != "mensch":
                continue
            people.append({"username": u["username"], "name": u.get("name") or u["username"]})
        return people


def _hdr(value: str) -> str:
    """HTTP-header-safe value: non-ASCII (umlauts, emoji like "🁩") raises
    UnicodeEncodeError in httpx -> the publish fails SILENTLY (this once swallowed
    every game invitation unnoticed). ntfy decodes RFC 2047 B-encoding server-side
    (verified empirically) — so encode here instead of truncating."""
    try:
        value.encode("ascii")
        return value
    except UnicodeEncodeError:
        return "=?UTF-8?B?" + base64.b64encode(value.encode("utf-8")).decode("ascii") + "?="


_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _object_target(app_id: str | None, action: str | None,
                   args: dict | None) -> tuple[list[str], str]:
    """Tags + query part for an object target.

    Produces the convention that `useNtfySubscription.ts` and `useBootDeepLink.ts`
    read: `claraos-action=<a>` + per argument `claraos-arg-<k>=<v>`, and for the
    phone app the same jump as a query `&do=<a>&<k>=<v>`.

    Commas are the separator in ntfy tags and values with a comma would break the
    tag list — such arguments are therefore dropped instead of silently producing
    a broken target.
    """
    if not app_id or not action or not _ID_RE.match(action):
        return [], ""
    tags = [f"claraos-action={action}"]
    query = f"&do={quote(action)}"
    for key, value in (args or {}).items():
        if not _ID_RE.match(str(key)):
            continue
        val = str(value)
        if "," in val or not val:
            logger.warning("ntfy_publish: Argument %r übersprungen (leer oder Komma)", key)
            continue
        tags.append(f"claraos-arg-{key}={val}")
        query += f"&{quote(str(key))}={quote(val)}"
    return tags, query


async def _publish_topic(client: httpx.AsyncClient, topic: str, title: str,
                         message: str, app_id: str | None, priority: str,
                         click: str | None = None, action: str | None = None,
                         args: dict | None = None) -> bool:
    headers = {"Authorization": f"Bearer {NTFY_ADMIN_TOKEN}", "X-Title": _hdr(title), "X-Priority": priority}
    obj_tags, obj_query = _object_target(app_id, action, args)
    if app_id:
        headers["X-Tags"] = ",".join([f"claraos-app={app_id}", *obj_tags])
    if not click and app_id:
        # Every app push should be tappable on the phone: fallback click to the
        # shell deep link (useBootDeepLink.ts waits for the registry and silently
        # drops unknown IDs). With an object target the tap jumps straight to the
        # task/project instead of the app's start page.
        click = f"{CLARAOS_PUBLIC_URL}/?app={app_id}{obj_query}"
    if click:
        headers["X-Click"] = click
    try:
        r = await client.post(f"{NTFY_INTERNAL_URL}/{topic}", content=message.encode("utf-8"), headers=headers)
        if r.status_code == 200:
            return True
        # WARNING instead of INFO: silently lost pushes were once invisible for a
        # long time (INFO is not emitted in the container log).
        logger.warning("ntfy_publish: %s → %s", topic, r.status_code)
    except Exception as exc:
        logger.warning("ntfy_publish: %s → %s", topic, exc)
    return False


def _fest(x: object) -> bool:
    return isinstance(x, str) and not isinstance(x, Text)


async def _in_sprache(username: str, title, message) -> tuple[str, str]:
    """Title and message for one recipient. Plain text passes unchanged; a
    `sprache.Text` or a `lang -> str` callable is resolved in the recipient's
    language (looked up only then)."""
    if _fest(title) and _fest(message):
        return title, message
    lang = await sprache_fuer(username)
    return fuer(lang, title), fuer(lang, message)


async def notify_users(usernames: list[str], title: str, message: str,
                       app_id: str | None = None, priority: str = "default",
                       click: str | None = None, action: str | None = None,
                       args: dict | None = None) -> int:
    """Targeted at specific user topics. Target usernames are validated
    server-side against the real human user list (no topic spam).

    `click` = URL for the tap in the ntfy phone app (the `claraos-app` tag only
    produces an open action in the desktop shell)."""
    if not NTFY_ADMIN_TOKEN or not usernames:
        return 0
    sent = 0
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            valid = set(await _list_human_usernames(client))
            for username in usernames:
                if username not in valid:
                    continue
                kopf, text = await _in_sprache(username, title, message)
                if await _publish_topic(client, _safe_ntfy_username(username), kopf,
                                        text, app_id, priority, click, action, args):
                    sent += 1
    except Exception as exc:
        logger.warning("ntfy_publish: notify_users fehlgeschlagen: %s", exc)
    return sent


async def notify_all_users(
    title: str,
    message: str,
    exclude: set[str] | None = None,
    app_id: str | None = None,
    priority: str = "default",
    click: str | None = None,
    action: str | None = None,
    args: dict | None = None,
) -> int:
    """Publish to all user topics; returns the number of successful publishes.

    `app_id` is sent as tag `claraos-app=<id>` — the shell renders an "open"
    action (open-window) from it, see useNtfySubscription.ts.
    `click` = tap URL in the ntfy phone app (fallback: `?app=<app_id>`).
    Never raises — notification is best effort and must not block game logic.
    """
    if not NTFY_ADMIN_TOKEN:
        logger.warning("ntfy_publish: NTFY_ADMIN_TOKEN fehlt — kein Broadcast")
        return 0
    exclude = {e.lower() for e in (exclude or set())}
    sent = 0
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            for username in await _list_human_usernames(client):
                if username.lower() in exclude:
                    continue
                kopf, text = await _in_sprache(username, title, message)
                if await _publish_topic(client, _safe_ntfy_username(username), kopf,
                                        text, app_id, priority, click, action, args):
                    sent += 1
    except Exception as exc:
        logger.warning("ntfy_publish: Broadcast fehlgeschlagen: %s", exc)
    return sent
