"""Contacts — the ONLY way to contact data.

Security: why everything goes through this module
─────────────────────────────────────────────────
Requirement: no user may see another user's contacts. Two layers, because one
is too few for this kind of data:

  1. **This gate.** `owner` is a required argument in the signature of EVERY
     function. No router builds its own SQL. So there is no place where
     someone *can* forget the filter — not just none where they do.

  2. **Real row-level security** via `_verbindung()`. With a role switch,
     because:
       * If the API's database role is a superuser (or has BYPASSRLS), it
         bypasses RLS entirely — even with `FORCE ROW LEVEL SECURITY`; a
         policy `USING (false)` would still let the row be seen. Policies
         only take effect for a role without those privileges.
       * Therefore every contact transaction switches via `SET LOCAL ROLE` to
         the role `claraos_kontakte` (NOSUPERUSER, NOBYPASSRLS). Only there do
         the policies from migration 033 take effect.
       * `SET LOCAL` means: valid until the end of the transaction and no
         longer. A forgotten value cannot bleed into the next request — with a
         shared connection pool that is the crucial point.

  3. Fail-closed: without an actor set, `current_setting(...)` returns NULL,
     the restrictive policy does not match, and **zero** rows come back.
     Whoever bypasses this path sees nothing — not everything.

Rule of thumb: **being in place != protecting.**
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import uuid
from contextlib import asynccontextmanager
from typing import Any

from database import get_pool

logger = logging.getLogger(__name__)

RLS_ROLLE = "claraos_kontakte"

# Reasons for a new revision (claraos_contact_versions.reason)
GRUND_BEARBEITET = "bearbeitet"
GRUND_IMPORT = "import"
GRUND_ENTFERNT = "entfernt"
GRUND_WIEDERHERGESTELLT = "wiederhergestellt"
GRUND_ZUSAMMENGEFUEHRT = "zusammengefuehrt"


class KontaktFehlt(Exception):
    """Contact does not exist — or it belongs to someone else.

    Deliberately ONE error for both cases. A separate "not yours" error would
    reveal that the ID exists; whoever probes foreign IDs should learn nothing.
    """


# ── Connection with role switch ─────────────────────────────────────────────

@asynccontextmanager
async def _verbindung(owner: str):
    """A transaction in which exactly `owner` acts.

    Warning: this function is the security boundary. Whoever bypasses it and
    goes to the pool directly has NO row-level security — the `clara` role is a
    superuser.
    """
    if not owner or not isinstance(owner, str):
        raise ValueError("kontakte_store: owner ist Pflicht und darf nicht leer sein")
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(f"SET LOCAL ROLE {RLS_ROLLE}")
            await conn.execute("SELECT set_config('claraos.actor', $1, true)", owner)
            yield conn


# ── Derived from `data` ─────────────────────────────────────────────────────

def inhalt_hash(data: dict[str, Any]) -> str:
    """Stable hash over the content — basis for "has anything changed".

    Without this comparison a nightly import of 2000 contacts produces 2000
    revisions per night, even if nothing changed. A history in which you cannot
    find anything is no history.
    """
    roh = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(roh.encode("utf-8")).hexdigest()


def _werte(liste: Any, schluessel: str) -> list[str]:
    if not isinstance(liste, list):
        return []
    out = []
    for e in liste:
        if isinstance(e, dict) and e.get(schluessel):
            out.append(str(e[schluessel]))
        elif isinstance(e, str):
            out.append(e)
    return out


def such_text(data: dict[str, Any], handles: list[dict] | None = None) -> str:
    """The searchable text of a contact.

    Derived, not maintained: can be recomputed at any time. Deliberately also
    includes the **handles** — exactly the fields Nextcloud does not make
    quickly searchable over HTTP (Unified Search knows neither IMPP nor
    X-SOCIALPROFILE). That is one of the reasons ClaraOS holds the truth.
    """
    n = data.get("namen") or {}
    org = data.get("organisation") or {}
    teile: list[str] = [
        n.get("anzeigename", ""), n.get("vorname", ""), n.get("nachname", ""),
        n.get("spitzname", ""), n.get("sortiername", ""),
        org.get("firma", ""), org.get("abteilung", ""), org.get("position", ""),
        data.get("notizen", "") or "",
    ]
    teile += _werte(data.get("mails"), "wert")
    teile += _werte(data.get("telefone"), "wert")
    teile += _werte(data.get("telefone"), "e164")
    teile += _werte(data.get("webseiten"), "url")
    for a in (data.get("adressen") or []):
        if isinstance(a, dict):
            teile += [str(a.get(k, "")) for k in ("strasse", "plz", "ort", "land")]
    kat = data.get("kategorien")
    if isinstance(kat, list):
        teile += [str(k) for k in kat]
    for h in (handles or []):
        teile += [str(h.get("service", "")), str(h.get("handle", ""))]
    return " ".join(t for t in teile if t).lower()[:20000]


def anzeigename(data: dict[str, Any]) -> str:
    n = data.get("namen") or {}
    if n.get("anzeigename"):
        return str(n["anzeigename"])
    zusammen = " ".join(x for x in (n.get("vorname"), n.get("nachname")) if x)
    if zusammen:
        return zusammen
    for m in _werte(data.get("mails"), "wert"):
        return m
    for t in _werte(data.get("telefone"), "wert"):
        return t
    return "(ohne Namen)"


# ── Reading ─────────────────────────────────────────────────────────────────

def _zeile(r) -> dict[str, Any]:
    data = r["data"]
    if isinstance(data, str):
        data = json.loads(data)
    return {
        "id": str(r["id"]),
        "owner": r["owner"],
        "data": data,
        "anzeigename": anzeigename(data),
        "photo_id": str(r["photo_id"]) if r["photo_id"] else None,
        "state": r["state"],
        "created_at": r["created_at"].isoformat(),
        "updated_at": r["updated_at"].isoformat(),
        "fremd": r["owner"] != r.get("_actor", r["owner"]),
    }


async def liste(owner: str, *, suche: str | None = None, entfernte: bool = False,
                limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
    """The caller's contacts (plus those explicitly shared with them)."""
    zustand = "removed" if entfernte else "active"
    async with _verbindung(owner) as conn:
        if suche and suche.strip():
            rows = await conn.fetch(
                "SELECT * FROM claraos_contacts WHERE state = $1 AND such_text ILIKE $2 "
                "ORDER BY such_text LIMIT $3 OFFSET $4",
                zustand, f"%{suche.strip().lower()}%", limit, offset)
        else:
            rows = await conn.fetch(
                "SELECT * FROM claraos_contacts WHERE state = $1 "
                "ORDER BY such_text LIMIT $2 OFFSET $3",
                zustand, limit, offset)
    return [{**_zeile(r), "fremd": r["owner"] != owner} for r in rows]


# ── Phone number match (caller identification) ──────────────────────────────

# Country code assumed for national numbers ("0151 ...") when building the key.
TELEFON_LANDESVORWAHL = os.environ.get("CLARAOS_PHONE_COUNTRY_CODE", "49").strip() or "49"
# A suffix match needs at least this many digits; shorter numbers must match exactly.
_SUFFIX_MIN = 7
_SUFFIX_MAX = 9


def telefon_schluessel(nummer: str, landesvorwahl: str | None = None) -> str:
    """Canonical digits of a phone number: international form without '+' / '00'.

        +49 151 1234567  -> 491511234567
        0049 1511234567  -> 491511234567
        0151 1234567     -> 491511234567   (national: country code added)
        +49 (0)30 123    -> 4930123        (the "(0)" trunk hint is dropped)
        1234567          -> 1234567        (local, left as is)
    """
    roh = (nummer or "").strip().replace("(0)", "")
    ziffern = re.sub(r"\D", "", roh)
    if not ziffern:
        return ""
    if roh.startswith("+"):
        return ziffern
    if ziffern.startswith("00"):
        return ziffern[2:]
    if ziffern.startswith("0"):
        return (landesvorwahl or TELEFON_LANDESVORWAHL) + ziffern[1:]
    return ziffern


def telefon_gleich(a: str, b: str) -> bool:
    """Do two canonical keys denote the same line?

    Equal keys match. Otherwise the last digits are compared (at most 9, at least
    7) — callers sometimes arrive without area code, or with a country code the
    stored number lacks. Below 7 digits only an exact match counts, so a short
    service number can never match a long one by accident.
    """
    if not a or not b:
        return False
    if a == b:
        return True
    k = min(_SUFFIX_MAX, len(a), len(b))
    return k >= _SUFFIX_MIN and a[-k:] == b[-k:]


def _telefon_werte(telefone: Any) -> list[str]:
    out: list[str] = []
    if not isinstance(telefone, list):
        return out
    for e in telefone:
        if isinstance(e, str):
            out.append(e)
        elif isinstance(e, dict):
            out += [str(e[k]) for k in ("e164", "wert") if e.get(k)]
    return out


async def telefon_treffer(owner: str, nummer: str) -> str | None:
    """Display name of an active contact of `owner` with this phone number, or None.

    Answers only "known / unknown" plus a name — never the list itself. Runs in
    the owner's role switch like every other read, so it sees exactly what the
    owner sees in the contacts app (own contacts plus those shared with them).
    """
    gesucht = telefon_schluessel(nummer)
    if not gesucht:
        return None
    async with _verbindung(owner) as conn:
        rows = await conn.fetch(
            "SELECT data->'namen' AS namen, data->'telefone' AS telefone, "
            "data->'mails' AS mails FROM claraos_contacts "
            "WHERE state = 'active' AND jsonb_typeof(data->'telefone') = 'array' "
            "ORDER BY updated_at DESC")
    for r in rows:
        teile = {k: (json.loads(r[k]) if isinstance(r[k], str) else r[k])
                 for k in ("namen", "telefone", "mails")}
        for wert in _telefon_werte(teile["telefone"]):
            if telefon_gleich(gesucht, telefon_schluessel(wert)):
                return anzeigename({k: v for k, v in teile.items() if v is not None})
    return None


async def hole(owner: str, contact_id: str) -> dict[str, Any]:
    async with _verbindung(owner) as conn:
        r = await conn.fetchrow("SELECT * FROM claraos_contacts WHERE id = $1::uuid", contact_id)
        if not r:
            raise KontaktFehlt(contact_id)
        handles = await conn.fetch(
            "SELECT service, handle, klasse, verifiziert FROM claraos_contact_handles "
            "WHERE contact_id = $1::uuid ORDER BY service, handle", contact_id)
        links = await conn.fetch(
            "SELECT username, matched_on, confidence, confirmed_at FROM claraos_contact_links "
            "WHERE contact_id = $1::uuid ORDER BY username", contact_id)
        quellen = await conn.fetch(
            "SELECT source, account, external_id, last_seen_at, state "
            "FROM claraos_contact_sources WHERE contact_id = $1::uuid ORDER BY source", contact_id)
    out = {**_zeile(r), "fremd": r["owner"] != owner}
    out["handles"] = [dict(h) for h in handles]
    out["links"] = [{**dict(l), "confirmed_at": l["confirmed_at"].isoformat() if l["confirmed_at"] else None}
                    for l in links]
    out["quellen"] = [{**dict(q), "last_seen_at": q["last_seen_at"].isoformat()} for q in quellen]
    return out


async def fassungen(owner: str, contact_id: str) -> list[dict[str, Any]]:
    """The revision history. Only for the owner — a share grants the current
    state, not the edit trail (policy in migration 033)."""
    async with _verbindung(owner) as conn:
        rows = await conn.fetch(
            "SELECT id, seq, data, changed_by, changed_at, reason FROM claraos_contact_versions "
            "WHERE contact_id = $1::uuid ORDER BY seq DESC", contact_id)
    out = []
    for r in rows:
        d = r["data"]
        if isinstance(d, str):
            d = json.loads(d)
        out.append({"id": str(r["id"]), "seq": r["seq"], "data": d,
                    "anzeigename": anzeigename(d), "changed_by": r["changed_by"],
                    "changed_at": r["changed_at"].isoformat(), "reason": r["reason"]})
    return out


# ── Writing ─────────────────────────────────────────────────────────────────

async def _fassung_schreiben(conn, owner: str, contact_id: str, alt_data: dict,
                             alt_hash: str, alt_photo, changed_by: str, reason: str) -> None:
    seq = await conn.fetchval(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM claraos_contact_versions WHERE contact_id = $1::uuid",
        contact_id)
    await conn.execute(
        "INSERT INTO claraos_contact_versions "
        "(owner, contact_id, seq, data, photo_id, content_hash, changed_by, reason) "
        "VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6, $7, $8)",
        owner, contact_id, seq, json.dumps(alt_data, ensure_ascii=False),
        alt_photo, alt_hash, changed_by, reason)


async def anlegen(owner: str, data: dict[str, Any], *, changed_by: str | None = None,
                  handles: list[dict] | None = None) -> str:
    """Create a new contact. No initial revision — the initial state IS the
    current state; a revision is only created on the first change."""
    h = inhalt_hash(data)
    async with _verbindung(owner) as conn:
        cid = await conn.fetchval(
            "INSERT INTO claraos_contacts (owner, data, content_hash, such_text) "
            "VALUES ($1, $2::jsonb, $3, $4) RETURNING id",
            owner, json.dumps(data, ensure_ascii=False), h, such_text(data, handles))
        for hd in (handles or []):
            await conn.execute(
                "INSERT INTO claraos_contact_handles (owner, contact_id, service, handle, klasse) "
                "VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
                owner, cid, hd["service"], hd["handle"], hd.get("klasse", "verweis"))
    return str(cid)


async def aendern(owner: str, contact_id: str, data: dict[str, Any], *,
                  changed_by: str | None = None, reason: str = GRUND_BEARBEITET) -> bool:
    """Update. Returns True if something really changed.

    With identical content NOTHING happens — no revision, no `updated_at`.
    This is the guard against a revision explosion during import.
    """
    neu_hash = inhalt_hash(data)
    async with _verbindung(owner) as conn:
        r = await conn.fetchrow(
            "SELECT data, content_hash, photo_id FROM claraos_contacts WHERE id = $1::uuid FOR UPDATE",
            contact_id)
        if not r:
            raise KontaktFehlt(contact_id)
        if r["content_hash"] == neu_hash:
            return False
        alt = r["data"]
        if isinstance(alt, str):
            alt = json.loads(alt)
        await _fassung_schreiben(conn, owner, contact_id, alt, r["content_hash"],
                                 r["photo_id"], changed_by or owner, reason)
        handles = await conn.fetch(
            "SELECT service, handle FROM claraos_contact_handles WHERE contact_id = $1::uuid",
            contact_id)
        await conn.execute(
            "UPDATE claraos_contacts SET data = $2::jsonb, content_hash = $3, such_text = $4, "
            "updated_at = NOW() WHERE id = $1::uuid",
            contact_id, json.dumps(data, ensure_ascii=False), neu_hash,
            such_text(data, [dict(h) for h in handles]))
    return True


async def entfernen(owner: str, contact_id: str, *, changed_by: str | None = None) -> None:
    """Tombstone. The source rows STAY — otherwise the next import simply
    creates the contact again, and "removed" would have no effect."""
    async with _verbindung(owner) as conn:
        r = await conn.fetchrow(
            "SELECT data, content_hash, photo_id, state FROM claraos_contacts "
            "WHERE id = $1::uuid FOR UPDATE", contact_id)
        if not r:
            raise KontaktFehlt(contact_id)
        if r["state"] == "removed":
            return
        alt = r["data"]
        if isinstance(alt, str):
            alt = json.loads(alt)
        await _fassung_schreiben(conn, owner, contact_id, alt, r["content_hash"],
                                 r["photo_id"], changed_by or owner, GRUND_ENTFERNT)
        await conn.execute(
            "UPDATE claraos_contacts SET state = 'removed', removed_at = NOW(), updated_at = NOW() "
            "WHERE id = $1::uuid", contact_id)


async def wiederherstellen(owner: str, contact_id: str, *, changed_by: str | None = None) -> None:
    async with _verbindung(owner) as conn:
        r = await conn.fetchrow(
            "SELECT data, content_hash, photo_id, state FROM claraos_contacts "
            "WHERE id = $1::uuid FOR UPDATE", contact_id)
        if not r:
            raise KontaktFehlt(contact_id)
        if r["state"] == "active":
            return
        alt = r["data"]
        if isinstance(alt, str):
            alt = json.loads(alt)
        await _fassung_schreiben(conn, owner, contact_id, alt, r["content_hash"],
                                 r["photo_id"], changed_by or owner, GRUND_WIEDERHERGESTELLT)
        await conn.execute(
            "UPDATE claraos_contacts SET state = 'active', removed_at = NULL, updated_at = NOW() "
            "WHERE id = $1::uuid", contact_id)


async def fassung_zurueckholen(owner: str, contact_id: str, seq: int,
                               *, changed_by: str | None = None) -> bool:
    """Make an old revision current again. The previous state itself moves
    into the history — restoring never deletes anything."""
    async with _verbindung(owner) as conn:
        alt = await conn.fetchrow(
            "SELECT data FROM claraos_contact_versions WHERE contact_id = $1::uuid AND seq = $2",
            contact_id, seq)
        if not alt:
            raise KontaktFehlt(f"{contact_id}#{seq}")
    d = alt["data"]
    if isinstance(d, str):
        d = json.loads(d)
    return await aendern(owner, contact_id, d, changed_by=changed_by,
                         reason=GRUND_WIEDERHERGESTELLT)


async def endgueltig_loeschen(owner: str, contact_id: str) -> dict[str, int]:
    """Irrevocable: contact, ALL revisions, source shadows, handles, links,
    blocks, shares.

    Why this MUST exist: an address book mostly contains data of **third
    parties** who were never asked. "We keep everything indefinitely" is not a
    tenable position when faced with a deletion request.

    The photo deliberately stays if another contact uses the same content —
    content-addressed means shared.
    """
    async with _verbindung(owner) as conn:
        r = await conn.fetchrow(
            "SELECT photo_id FROM claraos_contacts WHERE id = $1::uuid", contact_id)
        if not r:
            raise KontaktFehlt(contact_id)
        n_fassungen = await conn.fetchval(
            "SELECT count(*) FROM claraos_contact_versions WHERE contact_id = $1::uuid", contact_id)
        n_quellen = await conn.fetchval(
            "SELECT count(*) FROM claraos_contact_sources WHERE contact_id = $1::uuid", contact_id)
        # ON DELETE CASCADE also removes revisions/sources/handles/links/blocks/shares.
        await conn.execute("DELETE FROM claraos_contacts WHERE id = $1::uuid", contact_id)
        foto_weg = 0
        weg_key = None
        if r["photo_id"]:
            noch_benutzt = await conn.fetchval(
                "SELECT count(*) FROM claraos_contacts WHERE photo_id = $1", r["photo_id"])
            if not noch_benutzt:
                weg_key = await conn.fetchval(
                    "DELETE FROM claraos_contact_photos WHERE id = $1 RETURNING storage_key",
                    r["photo_id"])
                foto_weg = 1
    if weg_key:
        # First the row, then the object. "Permanent" must also hit the bytes —
        # otherwise the face stays in storage although the contact is deleted.
        import storage
        try:
            storage.delete_object(weg_key)
        except Exception as e:
            logger.warning("Foto-Objekt %s nicht entfernt: %s", weg_key, e)
    return {"fassungen": n_fassungen, "quellen": n_quellen, "foto": foto_weg}


# ── Source shadow ───────────────────────────────────────────────────────────

async def quelle_merken(owner: str, contact_id: str, source: str, account: str,
                        external_id: str, payload: dict) -> None:
    """Record the state the source has JUST shown.

    Important: must run on EVERY import. Without this shadow two cases can
    never be told apart again: "Google shows an outdated value that I already
    corrected in ClaraOS" and "newly changed on the phone, arriving via
    Google". They look identical, and comparing by timestamp is wrong in half
    of the cases.
    """
    h = inhalt_hash(payload)
    async with _verbindung(owner) as conn:
        await conn.execute(
            "INSERT INTO claraos_contact_sources "
            "(owner, contact_id, source, account, external_id, last_seen_payload, "
            " last_seen_hash, last_seen_at) "
            "VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7, NOW()) "
            "ON CONFLICT (tenant_id, source, account, external_id) DO UPDATE SET "
            "  contact_id = EXCLUDED.contact_id, last_seen_payload = EXCLUDED.last_seen_payload, "
            "  last_seen_hash = EXCLUDED.last_seen_hash, last_seen_at = NOW(), state = 'linked'",
            owner, contact_id, source, account, external_id,
            json.dumps(payload, ensure_ascii=False), h)


async def quelle_finden(owner: str, source: str, account: str,
                        external_id: str) -> dict[str, Any] | None:
    """Fetch the source shadow together with the contact's STATE.

    `kontakt_state` comes from the same join. The importer must know first of
    all whether the contact is a tombstone — and that must not cost an extra
    query per contact (with 2000 cards that would be 2000 queries for
    information that is right here anyway).
    """
    async with _verbindung(owner) as conn:
        r = await conn.fetchrow(
            "SELECT q.contact_id, q.last_seen_payload, q.last_seen_hash, q.state, "
            "       k.state AS kontakt_state "
            "FROM claraos_contact_sources q "
            "LEFT JOIN claraos_contacts k ON k.id = q.contact_id "
            "WHERE q.source = $1 AND q.account = $2 AND q.external_id = $3",
            source, account, external_id)
    if not r:
        return None
    p = r["last_seen_payload"]
    if isinstance(p, str):
        p = json.loads(p)
    return {"contact_id": str(r["contact_id"]), "last_seen_payload": p,
            "last_seen_hash": r["last_seen_hash"], "state": r["state"],
            "kontakt_state": r["kontakt_state"]}


async def quelle_zustand(owner: str, source: str, account: str,
                         external_id: str, zustand: str) -> None:
    """Record the state of the source — `linked` or `source_deleted`.

    `source_deleted` deletes NOTHING in ClaraOS (ClaraOS is the source of
    truth). It is a note on the card: "this no longer exists at Google".
    Without the note it looks like a bug when a contact deleted at Google
    stays in ClaraOS.
    """
    async with _verbindung(owner) as conn:
        await conn.execute(
            "UPDATE claraos_contact_sources SET state = $5, last_seen_at = NOW() "
            "WHERE source = $1 AND account = $2 AND external_id = $3 AND owner = $4",
            source, account, external_id, owner, zustand)


async def vorschlag_merken(owner: str, contact_id: str, source: str, account: str,
                           external_id: str, payload: dict) -> None:
    """Real conflict: the source AND ClaraOS have changed.

    ClaraOS wins — but the foreign state is **kept**, not discarded: it lands
    under `data.vorschlaege[<source>]` on the contact so the UI can offer it
    ("Google says 0171..., you have 0172... — take over?").

    The source shadow is **not** updated in this case. It must stay at the
    state ClaraOS last took over — otherwise the conflict counts as resolved
    in the next run without anyone having decided it.
    """
    async with _verbindung(owner) as conn:
        r = await conn.fetchrow(
            "SELECT data FROM claraos_contacts WHERE id = $1::uuid FOR UPDATE", contact_id)
        if not r:
            raise KontaktFehlt(contact_id)
        d = r["data"]
        if isinstance(d, str):
            d = json.loads(d)
        vorschlaege = d.get("vorschlaege") or {}
        vorschlaege[f"{source}:{account}"] = {"kennung": external_id, "stand": payload}
        d["vorschlaege"] = vorschlaege
        # Deliberately WITHOUT a revision and without changing content_hash: a
        # suggestion is not a change to the contact. Counting it as one would
        # create a revision on every run for something nobody decided.
        await conn.execute(
            "UPDATE claraos_contacts SET data = $2::jsonb WHERE id = $1::uuid",
            contact_id, json.dumps(d, ensure_ascii=False))


# ── Sync token per source (migration 034) ───────────────────────────────────

async def zeiger_holen(owner: str, source: str, account: str) -> str | None:
    async with _verbindung(owner) as conn:
        return await conn.fetchval(
            "SELECT sync_token FROM claraos_contact_sync "
            "WHERE owner = $1 AND source = $2 AND account = $3",
            owner, source, account)


async def zeiger_setzen(owner: str, source: str, account: str,
                        token: str | None, voll: bool = False) -> None:
    async with _verbindung(owner) as conn:
        await conn.execute(
            "INSERT INTO claraos_contact_sync (owner, source, account, sync_token, "
            "  last_full, last_run) VALUES ($1, $2, $3, $4, "
            "  CASE WHEN $5 THEN NOW() END, NOW()) "
            "ON CONFLICT (tenant_id, owner, source, account) DO UPDATE SET "
            "  sync_token = EXCLUDED.sync_token, last_run = NOW(), "
            "  last_full = COALESCE(EXCLUDED.last_full, claraos_contact_sync.last_full)",
            owner, source, account, token, voll)


async def zeiger_stand(owner: str) -> list[dict[str, Any]]:
    async with _verbindung(owner) as conn:
        rows = await conn.fetch(
            "SELECT source, account, sync_token IS NOT NULL AS hat_zeiger, "
            "       last_full, last_run FROM claraos_contact_sync ORDER BY source")
    return [{"source": r["source"], "account": r["account"],
             "inkrementell": r["hat_zeiger"],
             "last_full": r["last_full"].isoformat() if r["last_full"] else None,
             "last_run": r["last_run"].isoformat() if r["last_run"] else None}
            for r in rows]


# ── Handles ─────────────────────────────────────────────────────────────────

async def handle_setzen(owner: str, contact_id: str, service: str, handle: str,
                        klasse: str = "verweis") -> None:
    async with _verbindung(owner) as conn:
        da = await conn.fetchval("SELECT 1 FROM claraos_contacts WHERE id = $1::uuid", contact_id)
        if not da:
            raise KontaktFehlt(contact_id)
        await conn.execute(
            "INSERT INTO claraos_contact_handles (owner, contact_id, service, handle, klasse) "
            "VALUES ($1, $2::uuid, $3, $4, $5) "
            "ON CONFLICT (contact_id, service, handle) DO UPDATE SET klasse = EXCLUDED.klasse",
            owner, contact_id, service, handle, klasse)
        await _such_text_auffrischen(conn, contact_id)


async def handle_entfernen(owner: str, contact_id: str, service: str, handle: str) -> None:
    async with _verbindung(owner) as conn:
        await conn.execute(
            "DELETE FROM claraos_contact_handles "
            "WHERE contact_id = $1::uuid AND service = $2 AND handle = $3",
            contact_id, service, handle)
        await _such_text_auffrischen(conn, contact_id)


async def _such_text_auffrischen(conn, contact_id: str) -> None:
    r = await conn.fetchrow("SELECT data FROM claraos_contacts WHERE id = $1::uuid", contact_id)
    if not r:
        return
    d = r["data"]
    if isinstance(d, str):
        d = json.loads(d)
    hs = await conn.fetch(
        "SELECT service, handle FROM claraos_contact_handles WHERE contact_id = $1::uuid",
        contact_id)
    await conn.execute("UPDATE claraos_contacts SET such_text = $2 WHERE id = $1::uuid",
                       contact_id, such_text(d, [dict(h) for h in hs]))


# ── Photos (content-addressed) ──────────────────────────────────────────────
#
# Warning: an earlier version of the import read the photo and THREW IT AWAY.
# Table and column existed, but nothing was ever written — none of the
# pictures from a Takeout export arrived. That contradicts the whole superset
# idea: whatever comes in is kept.
#
# Content-addressed (sha256): the same picture on ten contacts takes space once.
# And the revision history only carries the `photo_id`, never the bytes —
# otherwise correcting a number would cost as much as the picture.

async def foto_ablegen(owner: str, roh: bytes, mime: str) -> str:
    """Store a picture and return its ID. Duplicates are shared."""
    import hashlib as _h
    import storage
    from tenancy import get_tenant_id

    digest = _h.sha256(roh).hexdigest()
    async with _verbindung(owner) as conn:
        vorhanden = await conn.fetchval(
            "SELECT id FROM claraos_contact_photos WHERE owner = $1 AND sha256 = $2",
            owner, digest)
        if vorhanden:
            return str(vorhanden)
        # The key contains the OWNER. Otherwise isolation would depend on a hash
        # being unguessable — and it is identical for identical pictures.
        key = storage.object_key(get_tenant_id(), "kontakte", f"{owner}/{digest}")
        pid = await conn.fetchval(
            "INSERT INTO claraos_contact_photos (owner, sha256, mime, bytes, storage_key) "
            "VALUES ($1, $2, $3, $4, $5) RETURNING id",
            owner, digest, mime, len(roh), key)
    # Store only after the row: an orphaned object costs space, a row without
    # an object costs a broken picture.
    storage.put_object(key, roh, mime)
    return str(pid)


async def foto_setzen(owner: str, contact_id: str, photo_id: str | None) -> None:
    async with _verbindung(owner) as conn:
        await conn.execute(
            "UPDATE claraos_contacts SET photo_id = $2 WHERE id = $1::uuid",
            contact_id, photo_id)


async def foto_lesen(owner: str, contact_id: str) -> tuple[bytes, str] | None:
    """A contact's picture — or None. Respects shares."""
    import storage
    async with _verbindung(owner) as conn:
        r = await conn.fetchrow(
            "SELECT f.storage_key, f.mime FROM claraos_contacts k "
            "JOIN claraos_contact_photos f ON f.id = k.photo_id "
            "WHERE k.id = $1::uuid", contact_id)
    if not r:
        return None
    try:
        return storage.get_object(r["storage_key"]), r["mime"]
    except Exception as e:
        logger.warning("Kontaktfoto %s nicht abrufbar: %s", contact_id, e)
        return None


# ── Sharing, blocking, reachability ─────────────────────────────────────────
#
# These queries live in the gate too — not because it is convenient, but
# because otherwise the rule "contact SQL only lives here" would only almost
# hold. A `services/kontakte_regeln.py` that touches tables itself would have
# neither the role switch nor the guard (`tests/kontakte_tor_waechter.py`).

async def freigabe_setzen(owner: str, contact_id: str, mit: str, permission: str) -> None:
    async with _verbindung(owner) as conn:
        da = await conn.fetchval(
            "SELECT 1 FROM claraos_contacts WHERE id = $1::uuid AND owner = $2",
            contact_id, owner)
        if not da:
            raise KontaktFehlt(contact_id)
        await conn.execute(
            "INSERT INTO claraos_contact_shares "
            "(contact_id, owner, shared_with, permission, created_by) "
            "VALUES ($1::uuid, $2, $3, $4, $2) "
            "ON CONFLICT (contact_id, shared_with) DO UPDATE SET permission = EXCLUDED.permission",
            contact_id, owner, mit, permission)


async def freigabe_loeschen(owner: str, contact_id: str, mit: str) -> None:
    async with _verbindung(owner) as conn:
        await conn.execute(
            "DELETE FROM claraos_contact_shares WHERE contact_id = $1::uuid "
            "AND shared_with = $2 AND owner = $3", contact_id, mit, owner)


async def freigaben(owner: str, contact_id: str) -> list[dict[str, Any]]:
    async with _verbindung(owner) as conn:
        rows = await conn.fetch(
            "SELECT shared_with, permission, created_at FROM claraos_contact_shares "
            "WHERE contact_id = $1::uuid ORDER BY shared_with", contact_id)
    return [{"shared_with": r["shared_with"], "permission": r["permission"],
             "created_at": r["created_at"].isoformat()} for r in rows]


async def block_setzen(owner: str, contact_id: str, service: str, wirksam: bool) -> None:
    async with _verbindung(owner) as conn:
        await conn.execute(
            "INSERT INTO claraos_contact_blocks (owner, contact_id, service, enforced, since) "
            "VALUES ($1, $2::uuid, $3, $4, NOW()) "
            "ON CONFLICT (contact_id, service) DO UPDATE SET "
            "  enforced = EXCLUDED.enforced, since = NOW()",
            owner, contact_id, service, wirksam)


async def block_loeschen(owner: str, contact_id: str, service: str) -> None:
    async with _verbindung(owner) as conn:
        await conn.execute(
            "DELETE FROM claraos_contact_blocks WHERE contact_id = $1::uuid AND service = $2",
            contact_id, service)


async def blocks(owner: str, contact_id: str) -> list[dict[str, Any]]:
    async with _verbindung(owner) as conn:
        rows = await conn.fetch(
            "SELECT service, enforced, since FROM claraos_contact_blocks "
            "WHERE contact_id = $1::uuid ORDER BY service", contact_id)
    return [{"service": r["service"], "enforced": r["enforced"],
             "since": r["since"].isoformat()} for r in rows]


async def regel_holen(owner: str) -> str:
    async with _verbindung(owner) as conn:
        r = await conn.fetchval(
            "SELECT erreichbar FROM claraos_contact_policy WHERE owner = $1", owner)
    return r or "alle"


async def regel_setzen(owner: str, wert: str) -> None:
    async with _verbindung(owner) as conn:
        await conn.execute(
            "INSERT INTO claraos_contact_policy (owner, erreichbar, updated_at) "
            "VALUES ($1, $2, NOW()) ON CONFLICT (owner) DO UPDATE SET "
            "  erreichbar = EXCLUDED.erreichbar, updated_at = NOW()",
            owner, wert)


async def auskunft_ueber(empfaenger: str, absender: str) -> dict[str, Any]:
    """The three facts a SENDER needs about a RECIPIENT.

    # TOR-AUSNAHME: This function deliberately does NOT act on behalf of the caller.
    # A sender must be allowed to know whether they may deliver — otherwise they
    # would need to see the recipient's rows, which is exactly what they must
    # not. Instead of a role switch, three `SECURITY DEFINER` functions from
    # migration 036 are used, which return ONLY yes/no or the rule — never a
    # row, never a name, never which contact is behind it.
    # The guard lists this exception on every run so it is not forgotten.

    Deliberately NOT in the sender's role switch: they may not see the
    recipient's rows — and should not. Instead three `SECURITY DEFINER`
    functions from migration 036 that return **only** yes/no or the rule.
    Never a row, never a name, never which contact is behind it.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        return {
            "geblockt": await conn.fetchval(
                "SELECT claraos_ist_geblockt($1, $2)", empfaenger, absender),
            "regel": await conn.fetchval(
                "SELECT claraos_erreichbarkeit($1)", empfaenger),
            "ist_kontakt": await conn.fetchval(
                "SELECT claraos_ist_kontakt($1, $2)", empfaenger, absender),
        }


# ── Link contact <-> ClaraOS user ───────────────────────────────────────────

async def link_setzen(owner: str, contact_id: str, username: str, matched_on: str,
                      confidence: str, confirmed_by: str) -> None:
    """Record a link — confirmed OR rejected.

    **Rejecting** is stored too. Otherwise matching suggests the same hit again
    in the next run, and a "no" would have no effect. A question that you
    dismiss and that keeps coming back gets blindly confirmed the third time —
    exactly what must not happen here.
    """
    async with _verbindung(owner) as conn:
        da = await conn.fetchval("SELECT 1 FROM claraos_contacts WHERE id = $1::uuid", contact_id)
        if not da:
            raise KontaktFehlt(contact_id)
        await conn.execute(
            "INSERT INTO claraos_contact_links "
            "(owner, contact_id, username, matched_on, confidence, confirmed_by, confirmed_at) "
            "VALUES ($1, $2::uuid, $3, $4, $5, $6, NOW()) "
            "ON CONFLICT (contact_id, username) DO UPDATE SET "
            "  confidence = EXCLUDED.confidence, matched_on = EXCLUDED.matched_on, "
            "  confirmed_by = EXCLUDED.confirmed_by, confirmed_at = NOW()",
            owner, contact_id, username, matched_on, confidence, confirmed_by)


async def link_loesen(owner: str, contact_id: str, username: str) -> None:
    """Remove a link entirely — afterwards it may be suggested again."""
    async with _verbindung(owner) as conn:
        await conn.execute(
            "DELETE FROM claraos_contact_links WHERE contact_id = $1::uuid AND username = $2",
            contact_id, username)


async def links_von(owner: str, username: str) -> list[str]:
    """Which contacts are linked (confirmed) to this user?"""
    async with _verbindung(owner) as conn:
        rows = await conn.fetch(
            "SELECT contact_id FROM claraos_contact_links "
            "WHERE username = $1 AND confidence = 'bestaetigt'", username)
    return [str(r["contact_id"]) for r in rows]


# ── Outbound projection (migration 035) ─────────────────────────────────────

async def projektion_stand(owner: str, ziel: str) -> dict[str, dict[str, Any]]:
    """What is out there — per contact URL, ETag and last written content.
    Basis of the reconciliation: desired vs. actual, without a queue."""
    async with _verbindung(owner) as conn:
        rows = await conn.fetch(
            "SELECT contact_id, href, etag, geschrieben_hash, zuletzt, fehler "
            "FROM claraos_contact_projection WHERE ziel = $1", ziel)
    return {str(r["contact_id"]): {
        "href": r["href"], "etag": r["etag"],
        "geschrieben_hash": r["geschrieben_hash"],
        "zuletzt": r["zuletzt"].isoformat() if r["zuletzt"] else None,
        "fehler": r["fehler"]} for r in rows}


async def projektion_merken(owner: str, contact_id: str, ziel: str,
                            href: str, etag: str, inhalt_hash_wert: str) -> None:
    async with _verbindung(owner) as conn:
        await conn.execute(
            "INSERT INTO claraos_contact_projection "
            "(owner, contact_id, ziel, href, etag, geschrieben_hash, zuletzt, fehler) "
            "VALUES ($1, $2::uuid, $3, $4, $5, $6, NOW(), NULL) "
            "ON CONFLICT (contact_id, ziel) DO UPDATE SET "
            "  href = EXCLUDED.href, etag = EXCLUDED.etag, "
            "  geschrieben_hash = EXCLUDED.geschrieben_hash, zuletzt = NOW(), fehler = NULL",
            owner, contact_id, ziel, href, etag, inhalt_hash_wert)


async def projektion_fehler(owner: str, contact_id: str, ziel: str, text: str) -> None:
    """Record a failure — visible instead of silent.

    `geschrieben_hash` is NOT set in this case. Otherwise the contact would
    count as done in the next reconciliation although it never went out.
    """
    async with _verbindung(owner) as conn:
        await conn.execute(
            "INSERT INTO claraos_contact_projection (owner, contact_id, ziel, fehler, zuletzt) "
            "VALUES ($1, $2::uuid, $3, $4, NOW()) "
            "ON CONFLICT (contact_id, ziel) DO UPDATE SET fehler = EXCLUDED.fehler, zuletzt = NOW()",
            owner, contact_id, ziel, text)


async def projektion_vergessen(owner: str, contact_id: str, ziel: str) -> None:
    async with _verbindung(owner) as conn:
        await conn.execute(
            "DELETE FROM claraos_contact_projection WHERE contact_id = $1::uuid AND ziel = $2",
            contact_id, ziel)


async def projektion_uebersicht(owner: str, ziel: str) -> dict[str, Any]:
    async with _verbindung(owner) as conn:
        r = await conn.fetchrow(
            "SELECT count(*) AS gesamt, "
            "       count(*) FILTER (WHERE fehler IS NOT NULL) AS mit_fehler, "
            "       max(zuletzt) AS zuletzt FROM claraos_contact_projection WHERE ziel = $1",
            ziel)
        aktiv = await conn.fetchval(
            "SELECT count(*) FROM claraos_contacts WHERE state = 'active' AND owner = $1", owner)
    return {"draussen": r["gesamt"], "mit_fehler": r["mit_fehler"],
            "kontakte": aktiv,
            "zuletzt": r["zuletzt"].isoformat() if r["zuletzt"] else None}


# ── Import runs ─────────────────────────────────────────────────────────────

async def lauf_beginnen(owner: str, source: str, account: str = "") -> str:
    async with _verbindung(owner) as conn:
        lid = await conn.fetchval(
            "INSERT INTO claraos_contact_imports (owner, source, account) "
            "VALUES ($1, $2, $3) RETURNING id", owner, source, account)
    return str(lid)


async def lauf_abschliessen(owner: str, lauf_id: str, zahlen: dict[str, int],
                            fehler: str | None = None) -> None:
    async with _verbindung(owner) as conn:
        await conn.execute(
            "UPDATE claraos_contact_imports SET finished_at = NOW(), gesehen = $2, neu = $3, "
            "geaendert = $4, unveraendert = $5, uebersprungen = $6, fehler = $7 "
            "WHERE id = $1::uuid",
            lauf_id, zahlen.get("gesehen", 0), zahlen.get("neu", 0),
            zahlen.get("geaendert", 0), zahlen.get("unveraendert", 0),
            zahlen.get("uebersprungen", 0), fehler)


async def laeufe(owner: str, limit: int = 20) -> list[dict[str, Any]]:
    async with _verbindung(owner) as conn:
        rows = await conn.fetch(
            "SELECT * FROM claraos_contact_imports ORDER BY started_at DESC LIMIT $1", limit)
    return [{"id": str(r["id"]), "source": r["source"], "account": r["account"],
             "started_at": r["started_at"].isoformat(),
             "finished_at": r["finished_at"].isoformat() if r["finished_at"] else None,
             "gesehen": r["gesehen"], "neu": r["neu"], "geaendert": r["geaendert"],
             "unveraendert": r["unveraendert"], "uebersprungen": r["uebersprungen"],
             "fehler": r["fehler"]} for r in rows]
