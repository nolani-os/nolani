"""Contact <-> ClaraOS user: suggestions, never automatic.

Important: **no automatic linking, with reason.** The obvious design would be:
"Link automatically only on an exact match with a **verified** ClaraOS email
address." But Authentik has **no verification flag** for
email addresses (user objects have `email` and `is_active`, nothing else). So
there is nothing to check — and basing automation on an *unverified* address
would be exactly the mistake the rule is meant to prevent.
=> **Nothing is ever linked automatically.** Every match is a suggestion that a
person confirms. That is stricter and costs one click.

Security: **visibility boundary.** Matching is only done against users with
whom the caller **shares a team** — the same rule Nextcloud enforces with
`shareapi_restrict_user_enumeration_to_group` (set to `yes` there). Otherwise
this service would be a directory oracle: whoever writes arbitrary emails into
their address book would find out who has an account here.

Why a wrong link is worse than a missing match: it does not mean "wrong name",
but **someone gains visibility into team content**. Households share email
addresses, numbers get recycled, company distribution lists match several
people. When in doubt, no suggestion.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any

from database import get_pool
from services import kontakte_store as store

logger = logging.getLogger(__name__)

# Cache the user directory briefly — matching 500 contacts would otherwise make
# the same Authentik calls 500 times.
_CACHE: dict[str, tuple[float, dict[str, dict]]] = {}
_CACHE_SEK = 300


def _mail(v: str) -> str:
    return (v or "").strip().lower()


def _ziffern(v: str) -> str:
    """Digits only — for a rough comparison of two numbers.

    Deliberately rough and ONLY a weak hint: `+49 30 12345` and `030 12345` are
    the same number, but that cannot be decided reliably without a country
    code. For the reliable version there is Nextcloud's `by-phone` endpoint,
    which uses libphonenumber.
    """
    return re.sub(r"\D", "", v or "")


async def sichtbare_nutzer(caller: str) -> dict[str, dict[str, Any]]:
    """Users with whom `caller` shares at least one team — with email and name.

    Security: this is the visibility boundary. Whoever shares no team with me
    appears in no suggestion, no matter what is in my address book.
    """
    jetzt = time.time()
    treffer = _CACHE.get(caller)
    if treffer and jetzt - treffer[0] < _CACHE_SEK:
        return treffer[1]

    from routers.teams_admin import ak_get_user_by_username, ak_list_group_members

    pool = await get_pool()
    async with pool.acquire() as conn:
        teams = await conn.fetch(
            "SELECT slug, name, authentik_group_pk FROM claraos_teams "
            "WHERE status = 'active' AND authentik_group_pk IS NOT NULL")

    meine: dict[str, set[str]] = {}      # username -> team names
    for t in teams:
        try:
            mitglieder = await ak_list_group_members(t["authentik_group_pk"])
        except Exception as e:
            logger.warning("Teamliste %s nicht abrufbar: %s", t["slug"], e)
            continue
        if caller not in mitglieder:
            continue
        for m in mitglieder:
            if m == caller:
                continue
            meine.setdefault(m, set()).add(t["name"] or t["slug"])

    out: dict[str, dict[str, Any]] = {}
    for username, teamnamen in meine.items():
        try:
            u = await ak_get_user_by_username(username)
        except Exception:
            u = None
        if not u or not u.get("is_active"):
            continue
        out[username] = {
            "username": username,
            "name": u.get("name") or username,
            "email": _mail(u.get("email", "")),
            "teams": sorted(teamnamen),
        }
    _CACHE[caller] = (jetzt, out)
    return out


async def _per_telefon(owner: str, nummern: list[str]) -> dict[str, str]:
    """Nextcloud's built-in phone number matching.

    Do not rebuild this: the endpoint normalises via libphonenumber with country
    code (`+49 171 ...` == `0171 ...`) and respects Nextcloud's own visibility
    rules. Getting both right by hand is work that has already been done.

    Returns {number: nc_username}. Simply empty without access — email matching
    still runs.
    """
    if not nummern:
        return {}
    try:
        from routers.files import _nc_credentials, NEXTCLOUD_INTERNAL_URL, _auth_header, nc_zugang
        if (await nc_zugang(owner)) != "eigen":
            return {}
        u, p = await _nc_credentials(owner)
    except Exception:
        return {}

    import httpx
    kopf = _auth_header(u, p)
    kopf["OCS-APIRequest"] = "true"
    kopf["Accept"] = "application/json"
    suche = {str(i): [n] for i, n in enumerate(nummern[:500])}
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(
                f"{NEXTCLOUD_INTERNAL_URL}/ocs/v2.php/cloud/users/search/by-phone",
                headers=kopf, data={"location": "DE",
                                    **{f"search[{k}][]": v[0] for k, v in suche.items()}})
    except Exception as e:
        logger.warning("Telefon-Abgleich nicht möglich: %s", e)
        return {}
    if r.status_code != 200:
        return {}
    try:
        daten = r.json().get("ocs", {}).get("data", {}) or {}
    except Exception:
        return {}
    out: dict[str, str] = {}
    for k, cloud_id in daten.items():
        try:
            nummer = suche[str(k)][0]
        except (KeyError, IndexError):
            continue
        # `user@https://nc.example` → `user`
        out[nummer] = str(cloud_id).split("@http")[0]
    return out


async def vorschlaege(owner: str, limit: int = 1000) -> list[dict[str, Any]]:
    """For every contact without a confirmed link: does a ClaraOS user match?

    Returns at most ONE suggestion per contact — the one with the strongest
    signal. Several equally good matches are a reason to make **no**
    suggestion at all: when two people share the same address (common in
    households), guessing is worse than staying silent.
    """
    nutzer = await sichtbare_nutzer(owner)
    if not nutzer:
        return []
    nach_mail: dict[str, list[str]] = {}
    for un, u in nutzer.items():
        if u["email"]:
            nach_mail.setdefault(u["email"], []).append(un)

    kontakte = await store.liste(owner, limit=limit)
    alle_nummern: list[str] = []
    voll_cache: dict[str, dict] = {}
    for k in kontakte:
        if k.get("fremd"):
            continue
        try:
            voll = await store.hole(owner, k["id"])
        except store.KontaktFehlt:
            continue
        voll_cache[k["id"]] = voll
        for t in (voll["data"].get("telefone") or []):
            if t.get("wert"):
                alle_nummern.append(t["wert"])

    per_tel = await _per_telefon(owner, alle_nummern)

    out: list[dict[str, Any]] = []
    for cid, voll in voll_cache.items():
        # Do not suggest already decided contacts again — neither confirmed
        # nor rejected ones. A "no" must stay a no.
        if voll.get("links"):
            continue
        d = voll["data"]

        # 1) Email — the strongest signal
        kandidaten: list[str] = []
        merkmal = ""
        for m in (d.get("mails") or []):
            treffer = nach_mail.get(_mail(m.get("wert", "")), [])
            if treffer:
                kandidaten, merkmal = treffer, "email"
                break

        # 2) Phone via Nextcloud (libphonenumber)
        if not kandidaten:
            for t in (d.get("telefone") or []):
                un = per_tel.get(t.get("wert", ""))
                if un and un in nutzer:
                    kandidaten, merkmal = [un], "phone"
                    break

        # 3) Name — only a hint, never more
        if not kandidaten:
            anzeige = (d.get("namen") or {}).get("anzeigename", "").strip().lower()
            if anzeige:
                gleich = [un for un, u in nutzer.items()
                          if (u["name"] or "").strip().lower() == anzeige]
                if gleich:
                    kandidaten, merkmal = gleich, "name"

        if len(kandidaten) != 1:
            # 0 = no match · >1 = ambiguous, and then silence is right
            continue
        un = kandidaten[0]
        out.append({
            "contact_id": cid,
            "anzeigename": voll["anzeigename"],
            "username": un,
            "nutzer_name": nutzer[un]["name"],
            "teams": nutzer[un]["teams"],
            "matched_on": merkmal,
            # The text explains WHAT the suggestion is based on. "Probably
            # matches" without a reason invites dismissing it.
            "begruendung": {
                "email": "gleiche E-Mail-Adresse",
                "phone": "gleiche Telefonnummer (über Nextcloud abgeglichen)",
                "name": "gleicher Name — nur ein Hinweis, bitte genau prüfen",
            }[merkmal],
            "schwach": merkmal == "name",
        })
    return out
