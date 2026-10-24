"""Sharing, blocking, reachability — and what of it ClaraOS really enforces.

Important: **the core of this module is honesty, not technology.** The
requirement was to block unwanted contacts and be reachable only for
team/contacts. A block in ClaraOS does not switch off WhatsApp, and no setting
here stops anyone from picking up the phone. Whoever hides that is not
building a feature but a sedative.

Therefore every block has a **measured** state, not a claimed one:

  * `durchgesetzt` (enforced) — we control both ends and really did something.
    Today: **ClaraOS's own channels** (sharing contacts, sharing knowledge) and
    **Matrix** (the user's ignore list).
  * `ausgeblendet` (hidden) — we cannot do anything there. The contact
    disappears from our list, nothing more. LinkedIn, X, Facebook, phone.
  * `fehlgeschlagen` (failed) — we wanted to and could not. That must be said,
    not silently booked as "enforced".

The reachability rule is a **server** rule. If it lived in the UI, anyone
could bypass it with a direct API call (a tile is not a permission).
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
import logging
from typing import Any

from services import kontakte_store as store

logger = logging.getLogger(__name__)

# What a block achieved
DURCHGESETZT = "durchgesetzt"
AUSGEBLENDET = "ausgeblendet"
FEHLGESCHLAGEN = "fehlgeschlagen"

# Services where we can really do something
ECHT_BLOCKBAR = {"claraos", "matrix"}

ALLE, TEAM, TEAM_UND_KONTAKTE = "alle", "team", "team_und_kontakte"


class NichtErreichbar(Exception):
    """The recipient has made themselves unreachable for this sender."""


# ── Reachability rule ───────────────────────────────────────────────────────

async def regel_holen(owner: str) -> str:
    return await store.regel_holen(owner)


async def regel_setzen(owner: str, wert: str) -> None:
    if wert not in (ALLE, TEAM, TEAM_UND_KONTAKTE):
        raise ValueError(f"Unbekannte Regel: {wert}")
    await store.regel_setzen(owner, wert)


async def darf_erreichen(absender: str, empfaenger: str) -> tuple[bool, str]:
    """May `absender` (sender) deliver something to `empfaenger` (recipient)? -> (yes, reason)

    Important: this function belongs IN FRONT OF every ClaraOS delivery path.
    It reads the **recipient's** rule — via a `SECURITY DEFINER` function, so
    the sender does not need to see someone else's data for it.
    """
    if absender == empfaenger:
        return True, "man selbst"

    auskunft = await store.auskunft_ueber(empfaenger, absender)

    # 1) Explicitly blocked? That trumps everything.
    if auskunft["geblockt"]:
        return False, "ausdrücklich geblockt"

    if auskunft["regel"] == ALLE:
        return True, "offen für alle"

    # 2) Shared team?
    from services import kontakte_abgleich as abgleich
    try:
        sichtbar = await abgleich.sichtbare_nutzer(empfaenger)
    except Exception as e:
        # Warning: when in doubt, BLOCK, do not let through. A failure must not
        # lift a rule — otherwise the outage is the bypass.
        logger.warning("Teamprüfung fehlgeschlagen (%s→%s): %s", absender, empfaenger, e)
        return False, "Teamzugehörigkeit nicht prüfbar"
    if absender in sichtbar:
        return True, "gemeinsames Team"

    if auskunft["regel"] == TEAM:
        return False, "nicht im selben Team"

    # 3) Is the sender in the recipient's contact list?
    if auskunft["ist_kontakt"]:
        return True, "in der Kontaktliste"
    return False, "weder im Team noch in der Kontaktliste"


# ── Sharing ─────────────────────────────────────────────────────────────────

async def teilen(owner: str, contact_id: str, mit: str,
                 permission: str = "read") -> dict[str, Any]:
    """Explicitly share a contact with someone.

    Security: two barriers:
    1. Only with people the owner **shares a team** with — otherwise sharing
       would be a way to guess and confirm usernames.
    2. The **recipient's reachability rule** has a say too. Whoever made
       themselves unreachable gets nothing delivered — not even a contact.
    """
    if mit == owner:
        raise ValueError("Mit dir selbst musst du nicht teilen.")
    if permission != "read":
        # Only READ shares exist, and that is a deliberate limit, not
        # carelessness: a write share would also need rules for the revision
        # history (whose revision is created when someone else edits?) and for
        # the trash. Building it half-done would be worse than postponing it —
        # the `permission` column is already in place for it.
        raise ValueError(
            "Zurzeit gibt es nur Lese-Freigaben. Wer mitschreiben soll, braucht "
            "einen eigenen Kontakt.")

    from services import kontakte_abgleich as abgleich
    sichtbar = await abgleich.sichtbare_nutzer(owner)
    if mit not in sichtbar:
        raise ValueError(
            f'„{mit}" ist für dich nicht sichtbar. Teilen geht nur mit Leuten, '
            'mit denen du ein Team teilst.')

    darf, grund = await darf_erreichen(owner, mit)
    if not darf:
        raise NichtErreichbar(
            f'„{sichtbar[mit]["name"]}" nimmt derzeit nichts von dir an ({grund}).')

    await store.freigabe_setzen(owner, contact_id, mit, permission)
    return {"shared_with": mit, "name": sichtbar[mit]["name"], "permission": permission}


async def teilen_zuruecknehmen(owner: str, contact_id: str, mit: str) -> None:
    await store.freigabe_loeschen(owner, contact_id, mit)


async def freigaben(owner: str, contact_id: str) -> list[dict[str, Any]]:
    return await store.freigaben(owner, contact_id)


# ── Blocking ────────────────────────────────────────────────────────────────

async def _matrix_ignorieren(owner: str, matrix_id: str, an: bool) -> bool:
    """Really ignore the user in Matrix (`m.ignored_user_list`).

    The token is freshly minted for this one call and **not** stored. Leaving
    a non-expiring Matrix token lying around would be a permanent key to
    someone else's account.
    """
    import httpx
    from routers.teams_admin import SYNAPSE_URL, mint_matrix_token
    try:
        tok = await mint_matrix_token(owner)
    except Exception as e:
        logger.warning("Matrix-Token für %s nicht zu bekommen: %s", owner, e)
        return False
    kopf = {"Authorization": f"Bearer {tok['access_token']}"}
    uid = tok["user_id"]
    url = (f"{SYNAPSE_URL}/_matrix/client/v3/user/{uid}/account_data/m.ignored_user_list")
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(url, headers=kopf)
            liste = (r.json().get("ignored_users") or {}) if r.status_code == 200 else {}
            if an:
                liste[matrix_id] = {}
            else:
                liste.pop(matrix_id, None)
            p = await c.put(url, headers=kopf, json={"ignored_users": liste})
        return p.status_code in (200, 204)
    except Exception as e:
        logger.warning("Matrix-Ignorierliste für %s nicht setzbar: %s", owner, e)
        return False


async def blocken(owner: str, contact_id: str, service: str) -> dict[str, Any]:
    """Block a contact for a service — and say honestly what happened."""
    service = (service or "").strip().lower()
    voll = await store.hole(owner, contact_id)     # raises KontaktFehlt
    if voll.get("fremd"):
        raise ValueError("Geteilte Kontakte kannst du nicht blocken — sie gehören jemand anderem.")

    zustand = AUSGEBLENDET
    hinweis = ""

    if service == "claraos":
        # Here we really take effect: `darf_erreichen` queries this row, and
        # all of ClaraOS's own delivery paths ask `darf_erreichen`.
        verknuepft = [l for l in (voll.get("links") or [])
                      if l.get("confidence") == "bestaetigt"]
        if verknuepft:
            zustand = DURCHGESETZT
            hinweis = (f"{verknuepft[0]['username']} kann dir in {PRODUCT_NAME} nichts mehr "
                       "zustellen (Kontakte, Wissen).")
        else:
            # Without a link to a ClaraOS user there is nobody to block.
            hinweis = (f"Dieser Kontakt ist mit keinem {PRODUCT_NAME}-Nutzer verknüpft — "
                       "es gibt hier niemanden zu sperren. Der Kontakt wird nur "
                       "ausgeblendet.")

    elif service == "matrix":
        handles = [h for h in (voll.get("handles") or []) if h["service"] == "matrix"]
        if not handles:
            hinweis = "Für diesen Kontakt ist keine Matrix-Kennung hinterlegt."
        else:
            ok = await _matrix_ignorieren(owner, handles[0]["handle"], True)
            zustand = DURCHGESETZT if ok else FEHLGESCHLAGEN
            hinweis = ("In Matrix ignoriert — von dort kommt nichts mehr an."
                       if ok else
                       "Matrix konnte nicht erreicht werden. Der Block ist NICHT aktiv.")
    else:
        hinweis = (f"{service} kennt keinen Block, den {PRODUCT_NAME} setzen könnte. "
                   "Der Kontakt wird hier ausgeblendet — mehr ist ehrlicherweise "
                   "nicht drin.")

    await store.block_setzen(owner, contact_id, service, zustand == DURCHGESETZT)
    return {"service": service, "zustand": zustand, "hinweis": hinweis}


async def block_aufheben(owner: str, contact_id: str, service: str) -> dict[str, Any]:
    service = (service or "").strip().lower()
    voll = await store.hole(owner, contact_id)
    if service == "matrix":
        handles = [h for h in (voll.get("handles") or []) if h["service"] == "matrix"]
        if handles:
            await _matrix_ignorieren(owner, handles[0]["handle"], False)
    await store.block_loeschen(owner, contact_id, service)
    return {"service": service, "aufgehoben": True}


async def blocks(owner: str, contact_id: str) -> list[dict[str, Any]]:
    return [{"service": b["service"],
             "zustand": DURCHGESETZT if b["enforced"] else AUSGEBLENDET,
             "since": b["since"]}
            for b in await store.blocks(owner, contact_id)]
