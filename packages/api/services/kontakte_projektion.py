"""Projection: ClaraOS contacts -> a dedicated Nextcloud address book.

What this is for: contacts are not used in ClaraOS but when making calls.
Without a way onto the phone the address book would be an archive. Design
decision: ClaraOS writes into a **dedicated** address book `claraos` and is its
**only** writer — the one fed by Google stays untouched.

Warning: THE central safeguard of this module
─────────────────────────────────────────────
`_pruefe_ziel()` only lets through URLs below the self-created `claraos`
address book. Everything else is rejected with `ZielVerboten` BEFORE any
request goes out.

Why so strict: a write error here does not hit our data but the user's
**real** address book — the one where their contacts actually live. A
condition that is only "mostly" right is not enough at this point. And the
safeguard deliberately lives in ONE function so a test can pin it down.

The direction is one-way. This module NEVER reads the ClaraOS address book to
import contacts from it. If it did, we would have two sources of truth and the
whole model would be broken — in the way you only notice when data is missing.
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
import logging
from typing import Any
from urllib.parse import quote as urlquote

from routers.files import NEXTCLOUD_INTERNAL_URL, nc_zugang
from routers.nc_pim import _dav, _etag_of
from services import kontakte_store as store
from services import vcard

logger = logging.getLogger(__name__)

# The name of the address book ClaraOS creates for itself. NOT `contacts` —
# that is Nextcloud's default address book, and that is exactly what we do not
# want to touch.
BUCH = "claraos"
BUCH_TITEL = PRODUCT_NAME
ZIEL = "nextcloud"
_TIMEOUT_HINWEIS = "Nextcloud antwortet nicht."


class ZielVerboten(Exception):
    """An attempt was made to write outside the ClaraOS address book."""


class KeinZugang(Exception):
    """The user has no Nextcloud access of their own stored."""


def buch_url(nc_user: str) -> str:
    return (f"{NEXTCLOUD_INTERNAL_URL}/remote.php/dav/addressbooks/users/"
            f"{urlquote(nc_user, safe='')}/{BUCH}/")


def _pruefe_ziel(url: str, nc_user: str) -> None:
    """The safeguard. Every writing call goes through here first.

    Three checks, each against a different error:

    1. **`..` in any shape** — including percent-encoded. A plain prefix
       comparison falls for it: `.../claraos/../contacts/abc.vcf` *starts*
       with the allowed prefix, and the server then resolves it to
       `contacts/` — i.e. into the user's **real** address book. Exactly this
       case got through during testing and is the reason for this version.
    2. **Server and scheme** must match, otherwise the card would go to a
       foreign host.
    3. **The normalised path** must lie below our own book — compared at a
       segment boundary, not as a string. A `startswith` comparison without a
       boundary would let `.../claraos-alt/` through.
    """
    import posixpath
    from urllib.parse import unquote, urlsplit

    erlaubt = buch_url(nc_user)
    if not url or not isinstance(url, str):
        raise ZielVerboten("Leere Zieladresse abgewiesen.")

    # Decode repeatedly — otherwise `%252e%252e` only becomes `..` on the server
    roh = url
    for _ in range(3):
        neu = unquote(roh)
        if neu == roh:
            break
        roh = neu
    if ".." in roh or "\\" in roh:
        raise ZielVerboten(f"Ausbruchsversuch in der Zieladresse abgewiesen: {url[:120]}")

    z, e = urlsplit(roh), urlsplit(erlaubt)
    if (z.scheme, z.netloc) != (e.scheme, e.netloc):
        raise ZielVerboten(
            f"Fremdes Ziel abgewiesen ({z.scheme}://{z.netloc}). "
            f"Erlaubt ist nur {e.scheme}://{e.netloc}")

    pfad = posixpath.normpath(z.path)
    basis = posixpath.normpath(e.path)
    if pfad != basis and not pfad.startswith(basis + "/"):
        raise ZielVerboten(
            f"Schreibversuch ausserhalb des {PRODUCT_NAME}-Adressbuchs abgewiesen. "
            f"Erlaubt ist nur {erlaubt}")


async def _creds(owner: str) -> tuple[str, str]:
    """The user's Nextcloud access — **without** service account fallback.

    Warning: `_nc_credentials` falls back to an admin service account if the
    user has no access of their own. For the projection that would be fatal: a
    user's contacts would land in the service account's address book, where
    anyone with that account can see them. Here the rule is: own access or none.
    """
    art = await nc_zugang(owner)
    if art != "eigen":
        raise KeinZugang(
            "Für die Übertragung ins Adressbuch brauchst du einen eigenen "
            "Nextcloud-Zugang in den Einstellungen. (Ein geteiltes Dienstkonto "
            "wird hier bewusst nicht verwendet.)")
    from routers.files import _nc_credentials
    return await _nc_credentials(owner)


_MKCOL = (
    '<?xml version="1.0" encoding="utf-8" ?>'
    '<d:mkcol xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">'
    '<d:set><d:prop><d:resourcetype><d:collection/>'
    '<card:addressbook/></d:resourcetype>'
    f'<d:displayname>{BUCH_TITEL}</d:displayname>'
    '</d:prop></d:set></d:mkcol>'
)


async def buch_sicherstellen(nc_user: str, nc_pass: str) -> bool:
    """Create the ClaraOS address book if missing. Returns True if newly created.

    Idempotent: an existing book answers MKCOL with 405 — that is the normal
    case and not an error.
    """
    url = buch_url(nc_user)
    r = await _dav("PROPFIND", url, nc_user, nc_pass,
                   '<?xml version="1.0"?><d:propfind xmlns:d="DAV:">'
                   '<d:prop><d:resourcetype/></d:prop></d:propfind>', depth="0")
    if r.status_code in (207, 200):
        return False
    r = await _dav("MKCOL", url, nc_user, nc_pass, _MKCOL, depth="0")
    if r.status_code in (201, 405):
        return r.status_code == 201
    raise RuntimeError(f"Adressbuch anlegen fehlgeschlagen: {r.status_code} {r.text[:200]}")


def karten_url(nc_user: str, contact_id: str) -> str:
    """One contact, one card, fixed URL. This keeps the mapping unambiguous even
    if the entry in the projection table were lost."""
    return f"{buch_url(nc_user)}{contact_id}.vcf"


# ── A single contact ────────────────────────────────────────────────────────

async def schreiben(owner: str, kontakt: dict[str, Any],
                    nc_user: str, nc_pass: str,
                    href: str | None = None, etag: str | None = None) -> tuple[str, str]:
    """Write one card out. Returns (href, new_etag)."""
    url = href or karten_url(nc_user, kontakt["id"])
    _pruefe_ziel(url, nc_user)

    # Without a picture the address book looks empty on the phone even though ClaraOS has one.
    bild = await store.foto_lesen(owner, kontakt["id"]) if kontakt.get("photo_id") else None
    text = vcard.schreiben(kontakt["data"], uid=kontakt["id"],
                           handles=kontakt.get("handles") or [], foto=bild)
    # With `etag`: only overwrite if the card is still the one we wrote.
    # Without: create, but do not overwrite anything foreign.
    r = await _dav("PUT", url, nc_user, nc_pass, text,
                   content_type="text/vcard; charset=utf-8",
                   if_match=etag or None, if_none_match=not etag)

    if r.status_code == 412:
        # The card has changed or already exists. Both mean: we no longer know
        # what is there — fetch the current state and retry conditionally once.
        # Two 412s in a row are a real conflict.
        jetzt = await _etag_of(url, nc_user, nc_pass)
        if jetzt is None:
            raise RuntimeError("Karte weder vorhanden noch anlegbar.")
        r = await _dav("PUT", url, nc_user, nc_pass, text,
                       content_type="text/vcard; charset=utf-8", if_match=jetzt)
        if r.status_code == 412:
            raise RuntimeError(
                f"Die Karte im {PRODUCT_NAME}-Adressbuch wurde von aussen geändert. "
                f"Dieses Adressbuch beschreibt nur {PRODUCT_NAME} — bitte dort nicht "
                "von Hand bearbeiten.")

    if r.status_code not in (200, 201, 204):
        raise RuntimeError(f"Nextcloud PUT {r.status_code}: {r.text[:200]}")

    neu = r.headers.get("ETag") or r.headers.get("etag") or ""
    if not neu:
        neu = await _etag_of(url, nc_user, nc_pass) or ""
    return url, neu


async def loeschen(owner: str, url: str, nc_user: str, nc_pass: str,
                   etag: str | None = None) -> bool:
    """Remove a card from the ClaraOS address book."""
    _pruefe_ziel(url, nc_user)
    r = await _dav("DELETE", url, nc_user, nc_pass, if_match=etag or None)
    if r.status_code == 404:
        return True          # already gone — goal reached
    if r.status_code == 412:
        # Changed externally: fetch state first, then delete conditionally.
        jetzt = await _etag_of(url, nc_user, nc_pass)
        if jetzt is None:
            return True
        r = await _dav("DELETE", url, nc_user, nc_pass, if_match=jetzt)
    return r.status_code in (200, 204, 404)


# ── Inventory: what is actually in the ClaraOS address book? ────────────────

_INVENTUR = (
    '<?xml version="1.0" encoding="utf-8" ?>'
    '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">'
    '<d:prop><d:getetag/></d:prop></card:addressbook-query>'
)


async def inventur(nc_user: str, nc_pass: str) -> dict[str, tuple[str, str]]:
    """Which cards are in the ClaraOS address book? -> {contact_id: (href, etag)}

    This is NOT an import and does not break the one-way rule. Only `getetag`
    is requested — **never** `address-data`. So we look at WHAT is there, not
    what it contains. External content never becomes the truth; otherwise we
    would have two.

    Why this is needed: on permanent deletion the projection row goes away via
    CASCADE. Without an inventory the sync would no longer know about the card
    — it would stay in the address book, and thus on the phone, forever. A
    contact that is deleted yet still on the phone is exactly the error that
    "permanent" is meant to rule out.
    """
    import xml.etree.ElementTree as ET
    from urllib.parse import unquote

    r = await _dav("REPORT", buch_url(nc_user), nc_user, nc_pass, _INVENTUR)
    if r.status_code not in (207, 200):
        return {}
    out: dict[str, tuple[str, str]] = {}
    try:
        root = ET.fromstring(r.content)
    except ET.ParseError:
        return {}
    for resp in root.findall("{DAV:}response"):
        href_el = resp.find("{DAV:}href")
        if href_el is None or not href_el.text:
            continue
        etag_el = resp.find(".//{DAV:}getetag")
        etag = (etag_el.text or "").strip() if etag_el is not None else ""
        name = unquote(href_el.text.rstrip("/").rsplit("/", 1)[-1])
        if not name.endswith(".vcf"):
            continue
        # The file name IS the contact ID (karten_url). This keeps the mapping
        # unambiguous even if the bookkeeping was lost.
        out[name[:-4]] = (NEXTCLOUD_INTERNAL_URL + href_el.text, etag)
    return out


# ── Sync across all contacts ────────────────────────────────────────────────

async def abgleichen(owner: str, grenze: int = 5000) -> dict[str, Any]:
    """Bring the ClaraOS address book up to date with the contacts.

    Deliberately a **reconciliation** and not a queue: it compares actual and
    desired state and is therefore self-healing. A queue that loses a job stays
    wrong forever — this reconciliation catches up on the next run.

    Only what changed is written (`geschrieben_hash`). Without this comparison
    every run would rewrite all cards; on the phone that would look like
    constant changes, and Nextcloud's change journal would fill up.
    """
    nc_user, nc_pass = await _creds(owner)
    neu_angelegt = await buch_sicherstellen(nc_user, nc_pass)

    stand = await store.projektion_stand(owner, ZIEL)
    z = {"geprueft": 0, "geschrieben": 0, "unveraendert": 0,
         "geloescht": 0, "fehler": 0}
    fehler: list[str] = []

    # 1) Write out active contacts
    for k in await store.liste(owner, limit=grenze):
        if k.get("fremd"):
            # Shared contacts belong to someone else. Writing them into MY
            # address book would mean duplicating other people's data.
            continue
        z["geprueft"] += 1
        try:
            voll = await store.hole(owner, k["id"])
        except store.KontaktFehlt:
            continue
        # Warning: `photo_id` belongs in the comparison: otherwise a contact that
        # later got a picture counts as "unchanged" and the picture never
        # reaches the phone.
        soll = store.inhalt_hash({"data": voll["data"],
                                  "handles": voll.get("handles") or [],
                                  "photo": voll.get("photo_id")})
        eintrag = stand.get(k["id"]) or {}
        if eintrag.get("geschrieben_hash") == soll and eintrag.get("href"):
            z["unveraendert"] += 1
            continue
        try:
            href, etag = await schreiben(owner, voll, nc_user, nc_pass,
                                         eintrag.get("href"), eintrag.get("etag"))
            await store.projektion_merken(owner, k["id"], ZIEL, href, etag, soll)
            z["geschrieben"] += 1
        except Exception as e:
            z["fehler"] += 1
            await store.projektion_fehler(owner, k["id"], ZIEL, str(e)[:300])
            if len(fehler) < 5:
                fehler.append(f"{voll['anzeigename']}: {str(e)[:150]}")
            logger.warning("Projektion %s fehlgeschlagen: %s", k["id"], e)

    # 2) Remove cards that do not (or no longer) belong there.
    #    The comparison is against the INVENTORY, not our bookkeeping: on
    #    permanent deletion the projection row goes away via CASCADE — relying
    #    on it leaves the card in place forever, and the deleted contact stays
    #    on the phone. (That is exactly how this was found.)
    aktiv = {k["id"] for k in await store.liste(owner, limit=grenze)}
    try:
        draussen = await inventur(nc_user, nc_pass)
    except Exception as e:
        logger.warning("Inventur fehlgeschlagen: %s", e)
        draussen = {}
    for cid, (href, etag) in draussen.items():
        if cid in aktiv:
            continue
        try:
            if await loeschen(owner, href, nc_user, nc_pass, etag):
                await store.projektion_vergessen(owner, cid, ZIEL)
                z["geloescht"] += 1
        except Exception as e:
            z["fehler"] += 1
            if len(fehler) < 5:
                fehler.append(f"Löschen: {str(e)[:150]}")

    # 3) Clean up orphaned bookkeeping without an external card
    for cid in list(stand):
        if cid not in aktiv and cid not in draussen:
            await store.projektion_vergessen(owner, cid, ZIEL)

    return {**z, "adressbuch": BUCH, "neu_angelegt": neu_angelegt,
            "fehler_texte": fehler}
