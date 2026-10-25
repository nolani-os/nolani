"""People in the Teams app — profile, search, ways to reach them.

A "profile" here is **not a new data store**. It is a view onto what ClaraOS
already knows:

  * **Who someone is** comes from Authentik (name, email, picture) — the place
    where users are actually maintained.
  * **How to reach them** comes from two sources: the services every ClaraOS
    user has by virtue of their account (Matrix, Nextcloud/Talk), and the
    handles of a linked contact, if there is one.

Security: **visibility**: only users with a **shared team** are shown
(`kontakte_abgleich.sichtbare_nutzer`). A free people search across all
accounts would be a directory oracle: whoever may guess whether "m.mueller"
exists can read out the user directory. The same rule applies in contact
matching; it is reused here, not reinvented.

**What ClaraOS does not know, it does not claim.** A way only appears if it
really exists, and carries the class from `kontakte_dienste` —
`foederiert` means "chat works from here", `verweis`/`bridge` mean "leads
outside or is currently unusable". The UI must be able to show this without
guessing itself.
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
import logging
from typing import Any

from services import kontakte_abgleich as abgleich
from services import kontakte_dienste as dienste_mod
from sprache import sprache_jetzt

logger = logging.getLogger(__name__)


async def _matrix_mxid(username: str) -> str | None:
    """The user's MXID — via the Authentik claim, not the username.

    Warning: ClaraOS username != Matrix localpart (e.g. `jdoe` ->
    `@john.doe`). Using the username here builds an ID that does not
    exist.
    """
    try:
        from routers.teams_admin import _mxid
        return await _mxid(username)
    except Exception as exc:
        logger.warning("MXID für %s nicht auflösbar: %s", username, exc)
        return None


def _weg(dienst_id: str, handle: str, quelle: str, lang: str = "de") -> dict[str, Any]:
    """A way to reach someone, enriched with what ClaraOS can do there."""
    name, klasse, _platzhalter, hinweis = dienste_mod.texte(dienst_id, lang)
    return {
        "dienst": dienst_id,
        "name": name,
        "handle": handle,
        "klasse": klasse,                       # foederiert | bridge | verweis
        "chat_moeglich": klasse == dienste_mod.FOEDERIERT and dienst_id in CHAT_DIENSTE,
        "anruf_moeglich": dienst_id in ANRUF_DIENSTE,
        "hinweis": hinweis,
        "quelle": quelle,                       # konto | kontakt
    }


# Where ClaraOS can really start a chat or call. Deliberately kept narrow:
# `foederiert` alone is not enough — Mastodon is federated but not a messenger.
CHAT_DIENSTE = {"matrix", "nctalk"}
ANRUF_DIENSTE = {"matrix", "nctalk"}


async def _wege_fuer_konto(username: str) -> list[dict[str, Any]]:
    """The ways every ClaraOS user has purely by virtue of their account."""
    wege: list[dict[str, Any]] = []
    lang = await sprache_jetzt()
    mxid = await _matrix_mxid(username)
    if mxid:
        wege.append(_weg("matrix", mxid, "konto", lang))
    # The Nextcloud account is named like the ClaraOS user; Talk is installed
    # (spreed). Both are bound to the account, not to a contact entry.
    wege.append(_weg("nctalk", username, "konto", lang))
    return wege


async def _wege_aus_kontakt(caller: str, username: str) -> list[dict[str, Any]]:
    """Additional ways from a linked contact of the caller.

    Only from the caller's OWN contacts — other people's contact data is their
    property, even if it describes the same person.
    """
    try:
        from services import kontakte_store as store
        lang = await sprache_jetzt()
        return [
            _weg(h["service"], h["handle"], "kontakt", lang)
            for h in await store.handles_fuer_verknuepften_nutzer(caller, username)
        ]
    except AttributeError:
        # The store function does not exist (yet) — then we stick to the
        # account ways. No reason to fail the whole people view.
        return []
    except Exception as exc:
        logger.warning("Kontakt-Wege für %s: %s", username, exc)
        return []


async def personen(caller: str, q: str | None = None) -> list[dict[str, Any]]:
    """All people visible to `caller`, optionally filtered.

    The filter applies to display name, username and email — deliberately
    ONLY within the already visible set. A search that filters first and
    checks afterwards would be an oracle.
    """
    sichtbar = await abgleich.sichtbare_nutzer(caller)
    treffer = list(sichtbar.values())

    if q:
        n = q.strip().lower()
        treffer = [
            p for p in treffer
            if n in (p.get("name") or "").lower()
            or n in (p.get("username") or "").lower()
            or n in (p.get("email") or "").lower()
        ]

    return sorted(treffer, key=lambda p: (p.get("name") or p["username"]).lower())


async def profil(caller: str, username: str) -> dict[str, Any] | None:
    """Full profile of a person — or None if not visible.

    Security: None explicitly also means that "does not exist" and "you may
    not see this" are indistinguishable from the outside. Otherwise the
    distinction would reveal which accounts exist.
    """
    sichtbar = await abgleich.sichtbare_nutzer(caller)
    p = sichtbar.get(username)
    if not p:
        return None

    wege = await _wege_fuer_konto(username)
    wege += await _wege_aus_kontakt(caller, username)

    # Show the same handle from two sources only once
    gesehen: set[tuple[str, str]] = set()
    eindeutig = []
    for w in wege:
        schluessel = (w["dienst"], w["handle"])
        if schluessel in gesehen:
            continue
        gesehen.add(schluessel)
        eindeutig.append(w)

    return {**p, "wege": eindeutig}


# ── Start chat and call ────────────────────────────────────────────────────

async def talk_gespraech(caller: str, ziel: str) -> dict[str, Any]:
    """Open a Nextcloud Talk conversation with `ziel` — existing or new.

    Runs with the **caller's** credentials, not those of a service account:
    the conversation belongs to them, it appears in their Talk list, and the
    other side sees them as the sender. A conversation created via clara.bot
    would be a third conversation in which the bot reads along.

    With `roomType=1` (one-to-one) Talk does not create a second one if one
    already exists — it returns the same one. So no prior search is needed
    here; the API is already idempotent.
    """
    import httpx
    from routers.teams_admin import _nc_auth_as, NEXTCLOUD_URL
    from domains_generated import url as domain_url

    try:
        auth = await _nc_auth_as(caller)
    except Exception as exc:
        raise RuntimeError(
            f"Für {caller} sind keine Nextcloud-Zugangsdaten hinterlegt — "
            f"ohne sie kann {PRODUCT_NAME} kein Talk-Gespräch in seinem Namen öffnen."
        ) from exc

    kopf = {"OCS-APIRequest": "true", "Accept": "application/json"}
    async with httpx.AsyncClient(verify=False, timeout=20) as c:
        r = await c.post(
            f"{NEXTCLOUD_URL}/ocs/v2.php/apps/spreed/api/v4/room",
            auth=auth, headers=kopf,
            json={"roomType": 1, "invite": ziel},
        )
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Talk antwortete {r.status_code}: {r.text[:160]}")

    daten = r.json().get("ocs", {}).get("data", {})
    token = daten.get("token")
    if not token:
        raise RuntimeError("Talk lieferte kein Gesprächskennzeichen")

    basis = domain_url("nextcloud")
    return {
        "dienst": "nctalk",
        "token": token,
        # Both ways: land in the conversation, or ring directly.
        "url": f"{basis}/index.php/call/{token}",
        "anruf_url": f"{basis}/index.php/call/{token}#direct-call",
    }


async def talk_gespraeche(caller: str) -> list[dict[str, Any]]:
    """The caller's Talk conversations — for the chat overview.

    Why this is needed at all: the overview used to list only Matrix rooms. A
    "which messenger" icon would have been pointless there — it would have
    shown the same everywhere. Only when two services stand side by side does
    the icon answer a real question.

    Empty one-to-one conversations are omitted: Talk itself does not show them
    to the other side either, and in an overview they would be ghost rows —
    someone once pressed "chat" and never wrote.
    """
    import httpx
    from routers.teams_admin import _nc_auth_as, NEXTCLOUD_URL
    from domains_generated import url as domain_url

    try:
        auth = await _nc_auth_as(caller)
    except Exception:
        # No Nextcloud account stored: then there are simply no Talk rows.
        # That is not an error of the overview — Matrix keeps working.
        return []

    kopf = {"OCS-APIRequest": "true", "Accept": "application/json"}
    try:
        async with httpx.AsyncClient(verify=False, timeout=15) as c:
            r = await c.get(f"{NEXTCLOUD_URL}/ocs/v2.php/apps/spreed/api/v4/room",
                            auth=auth, headers=kopf)
        if r.status_code != 200:
            logger.warning("Talk-Gespräche für %s: HTTP %s", caller, r.status_code)
            return []
        roh = r.json().get("ocs", {}).get("data", [])
    except Exception as exc:
        logger.warning("Talk-Gespräche für %s: %s", caller, exc)
        return []

    basis = domain_url("nextcloud")
    out: list[dict[str, Any]] = []
    for g in roh:
        letzte = g.get("lastMessage") or {}
        if g.get("type") == 1 and not letzte:
            continue                      # empty one-to-one conversation, see docstring
        out.append({
            "dienst": "nctalk",
            "id": g.get("token"),
            "name": g.get("displayName") or g.get("name") or "Gespräch",
            "ungelesen": int(g.get("unreadMessages") or 0),
            "letzte_nachricht": (letzte.get("message") or "")[:140],
            "zeit": g.get("lastActivity"),
            "url": f"{basis}/index.php/call/{g.get('token')}",
        })
    out.sort(key=lambda x: x.get("zeit") or 0, reverse=True)
    return out
