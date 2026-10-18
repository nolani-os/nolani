"""Mail app — business features at household scale.

Builds on the JMAP helpers from `post.py` and adds four things a household
knows from Outlook:

1. **Group mailboxes / shared accounts** — Stalwart offers a user several
   accounts in the JMAP session: their own (`isPersonal`) and every account
   they can reach through a group membership or a folder share.
   `GET /konten` exposes this list; the read routes in `post.py` accept an
   optional `account_id` for it.

2. **Sharing/delegation** — JMAP Sharing (RFC 9670, capability
   `urn:ietf:params:jmap:mail:share`). A folder carries `shareWith`: a map
   principal id → rights. Verified: setting and reading back works,
   `myRights.mayShare` is true on all folders, so every user may share their
   own folders — no administrator needed.

3. **Directory (GAL)** — `Principal/query` + `Principal/get` return all
   accounts on the server with name, description and address. Combined with
   the contacts app this gives a people search across both sources.

4. **Distribution lists** — two different things, which Outlook also keeps
   apart: *personal* lists (only for the user, stored in our database) and
   *server-side* mailing lists (`MailingList` in Stalwart, a real email
   address that delivers to all members — admins only).

Why a separate file rather than `post.py`: that file is edited by several
people in parallel; a second writer in the same 2000-line file costs more
than the few shared imports save here.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from auth import require_caller
from database import get_pool, user_tx
from routers.post import (  # same helpers, so there is ONE way of talking JMAP
    _by_tag,
    _jmap,
    _jmap_session,
    _mailbox_row,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/post", tags=["post"])

CORE = "urn:ietf:params:jmap:core"
MAIL = "urn:ietf:params:jmap:mail"
PRINCIPALS = "urn:ietf:params:jmap:principals"
SHARE = "urn:ietf:params:jmap:mail:share"
USING_SHARE = [CORE, MAIL, SHARE]
USING_PRINCIPALS = [CORE, PRINCIPALS]

_tables_ensured = False


async def _ensure_tables() -> None:
    global _tables_ensured
    if _tables_ensured:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_post_verteiler (
                username    TEXT NOT NULL,
                name        TEXT NOT NULL,
                mitglieder  JSONB NOT NULL DEFAULT '[]'::jsonb,
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (username, name)
            )
        """)
    _tables_ensured = True


# ── Session accounts (own + groups + shared) ─────────────────────────────────

async def _accounts(user: str) -> dict[str, dict[str, Any]]:
    """All accounts Stalwart offers this user.

    `post.py` keeps the raw session in its cache under `accounts`. If the key is
    missing — e.g. because an old cache entry predates that change — the session
    is discarded and fetched again, rather than opening a second, divergent way
    of handling sessions here.
    """
    s = await _jmap_session(user)
    if "accounts" not in s:
        from routers import post as P
        P._sessions.pop(user, None)
        s = await _jmap_session(user)
    return s.get("accounts") or {}


def _account_row(acc_id: str, a: dict[str, Any], primary: str) -> dict[str, Any]:
    name = a.get("name") or acc_id
    return {
        "id": acc_id,
        "name": name,
        "address": name if "@" in name else "",
        "eigenes": bool(a.get("isPersonal")),
        "nur_lesen": bool(a.get("isReadOnly")),
        "primaer": acc_id == primary,
        "kann_senden": "urn:ietf:params:jmap:submission" in (a.get("accountCapabilities") or {}),
    }


@router.get("/konten")
async def post_konten(request: Request, neu: bool = Query(False, description="Session neu holen")):
    """Mailboxes this user may open — own mailbox first.

    A group mailbox (`family@`, `info@`) shows up here as soon as the user is a
    member of the group in Stalwart; a single shared folder brings along the
    owner's account.

    Warning: `neu=1` bypasses the session cache. The share arrives immediately —
    but `post.py` holds the JMAP session for **5 minutes**, and the account list
    lives in it. Without this switch, someone who was just granted access sits
    in front of a UI that knows nothing about it and cannot do anything about it.
    """
    user = require_caller(request)
    if neu:
        from routers import post as P
        P._sessions.pop(user, None)
    try:
        s = await _jmap_session(user)
        accs = await _accounts(user)
    except HTTPException as e:
        if e.status_code in (409, 502):
            return {"konten": [], "eigenes": "", "hinweis": "Kein Postfach verbunden."}
        raise
    rows = [_account_row(aid, a, s["account"]) for aid, a in accs.items()]
    rows = [r for r in rows if r["eigenes"] or await _hat_sichtbare_ordner(user, r["id"])]
    rows.sort(key=lambda r: (not r["eigenes"], r["name"]))
    return {"konten": rows, "eigenes": s["account"]}


async def _hat_sichtbare_ordner(user: str, account_id: str) -> bool:
    """Is there anything to see in this foreign account at all?

    Warning: **when a share is revoked, Stalwart keeps listing the foreign
    account in the session** — even though no folder carries a share any more
    and the guest sees **zero** folders there. Access is cleanly revoked, but the
    shell remains.
    Offering a mailbox with nothing in it is not information but an invitation
    to go looking. So this check costs one call per foreign account — with zero
    to two accounts that is cheaper than the confusion.

    When in doubt (error) the account is **kept**: better to show one too many
    than to hide one somebody really needs.
    """
    try:
        resp = await _jmap(user, [["Mailbox/query", {"accountId": account_id, "limit": 1}, "q"]],
                           using=USING_SHARE, fehler_erlauben=True)
        for name, data, _tag in resp:
            if name == "Mailbox/query":
                return bool(data.get("ids"))
        return True
    except Exception as e:
        logger.info("Konto %s nicht prüfbar, bleibt sichtbar: %s", account_id, e)
        return True


# ── Sharing / delegation ─────────────────────────────────────────────────────

# Outlook has "Reviewer / Author / Editor"; JMAP has nine individual rights.
# Three levels are enough for a household — more choice here just means more mistakes.
STUFEN: dict[str, dict[str, bool]] = {
    "lesen": {"mayReadItems": True, "mayAddItems": False, "mayRemoveItems": False,
              "maySetSeen": False, "maySetKeywords": False, "mayCreateChild": False,
              "mayRename": False, "maySubmit": False, "mayDelete": False, "mayShare": False},
    "mitarbeiten": {"mayReadItems": True, "mayAddItems": True, "mayRemoveItems": False,
                    "maySetSeen": True, "maySetKeywords": True, "mayCreateChild": False,
                    "mayRename": False, "maySubmit": False, "mayDelete": False, "mayShare": False},
    "voll": {"mayReadItems": True, "mayAddItems": True, "mayRemoveItems": True,
             "maySetSeen": True, "maySetKeywords": True, "mayCreateChild": True,
             "mayRename": True, "maySubmit": True, "mayDelete": True, "mayShare": False},
}
STUFEN_NAMEN = {"lesen": "Darf lesen", "mitarbeiten": "Darf lesen und ablegen",
                "voll": "Darf alles außer weiterverteilen"}


def _stufe_von_rechten(r: dict[str, Any]) -> str:
    """Map a rights bundle read from the server to the closest level.

    Important for display: Stalwart may return rights that match none of our
    three levels exactly (e.g. set from another client). Then the UI shows
    "custom" instead of a level it is not — better honestly vague than wrongly
    labelled.
    """
    for name, muster in STUFEN.items():
        if all(bool(r.get(k)) == v for k, v in muster.items()):
            return name
    return "eigene"


async def _principals(user: str) -> dict[str, dict[str, Any]]:
    """All principals on the server as {id: {name, email, typ}}."""
    s = await _jmap_session(user)
    resp = await _jmap(user, [
        ["Principal/query", {"accountId": s["account"]}, "q"],
        ["Principal/get", {"accountId": s["account"],
                           "#ids": {"resultOf": "q", "name": "Principal/query", "path": "/ids"}}, "p"],
    ], using=USING_PRINCIPALS)
    out: dict[str, dict[str, Any]] = {}
    for p in _by_tag(resp, "p").get("list") or []:
        out[p["id"]] = {"id": p["id"], "name": p.get("description") or p.get("name") or p["id"],
                        "email": p.get("email") or "", "typ": p.get("type") or "individual"}
    return out


@router.get("/freigaben")
async def post_freigaben(request: Request):
    """Own folders, with the question: who may access them?"""
    user = require_caller(request)
    try:
        s = await _jmap_session(user)
    except HTTPException as e:
        if e.status_code in (409, 502):
            return {"ordner": [], "stufen": [{"id": k, "name": v} for k, v in STUFEN_NAMEN.items()],
                    "hinweis": "Ohne verbundenes Postfach gibt es keine Ordner zum Freigeben."}
        raise
    resp = await _jmap(user, [["Mailbox/get", {"accountId": s["account"], "properties":
                               ["id", "name", "role", "parentId", "shareWith", "myRights",
                                "totalEmails", "unreadEmails"]}, "m"]], using=USING_SHARE)
    prin = await _principals(user)
    rows = []
    for m in _by_tag(resp, "m").get("list") or []:
        basis = _mailbox_row(m)
        basis.pop("sort", None)
        geteilt = []
        for pid, rechte in (m.get("shareWith") or {}).items():
            p = prin.get(pid) or {"id": pid, "name": pid, "email": "", "typ": "individual"}
            geteilt.append({**p, "stufe": _stufe_von_rechten(rechte or {})})
        geteilt.sort(key=lambda x: x["name"].lower())
        rows.append({**basis, "darf_freigeben": bool((m.get("myRights") or {}).get("mayShare")),
                     "geteilt_mit": geteilt})
    rows.sort(key=lambda r: (0 if r.get("role") == "inbox" else 1, (r.get("name") or "").lower()))
    return {"ordner": rows, "stufen": [{"id": k, "name": v} for k, v in STUFEN_NAMEN.items()]}


class FreigabeIn(BaseModel):
    mailbox_id: str
    person: str          # principal id OR email address
    stufe: str = "lesen"  # lesen | mitarbeiten | voll | keine


@router.put("/freigaben")
async def post_freigabe_setzen(body: FreigabeIn, request: Request):
    """Share one of the user's folders or revoke the share.

    Important: Stalwart replaces `shareWith` as a **whole map**, it does not
    merge. To change a single entry you have to read the current map first and
    send it along — otherwise setting one share removes all the others.
    """
    user = require_caller(request)
    if body.stufe not in STUFEN and body.stufe != "keine":
        raise HTTPException(status_code=400, detail=f"Unbekannte Stufe {body.stufe!r}")
    s = await _jmap_session(user)

    pid = body.person
    if "@" in body.person:
        prin = await _principals(user)
        treffer = [p for p in prin.values() if p["email"].lower() == body.person.lower()]
        if not treffer:
            raise HTTPException(status_code=404, detail=f"{body.person} ist im Verzeichnis nicht bekannt")
        pid = treffer[0]["id"]

    resp = await _jmap(user, [["Mailbox/get", {"accountId": s["account"], "ids": [body.mailbox_id],
                               "properties": ["id", "name", "shareWith", "myRights"]}, "m"]],
                       using=USING_SHARE)
    treffer = _by_tag(resp, "m").get("list") or []
    if not treffer:
        raise HTTPException(status_code=404, detail="Ordner nicht gefunden")
    ordner = treffer[0]
    if not (ordner.get("myRights") or {}).get("mayShare"):
        raise HTTPException(status_code=403, detail="Dieser Ordner darf nicht freigegeben werden")

    bestand = dict(ordner.get("shareWith") or {})
    if body.stufe == "keine":
        bestand.pop(pid, None)
    else:
        bestand[pid] = dict(STUFEN[body.stufe])

    resp = await _jmap(user, [["Mailbox/set", {"accountId": s["account"],
                               "update": {body.mailbox_id: {"shareWith": bestand or {}}}}, "u"]],
                       using=USING_SHARE)
    d = _by_tag(resp, "u")
    if d.get("notUpdated"):
        raise HTTPException(status_code=502, detail=f"Freigabe abgelehnt: {json.dumps(d['notUpdated'])[:200]}")
    await _session_verwerfen(body.person if "@" in body.person else
                             (await _principals(user)).get(pid, {}).get("email", ""))
    return {"ok": True, "ordner": ordner.get("name"), "anzahl_freigaben": len(bestand)}


async def _session_verwerfen(adresse: str) -> None:
    """Drop the cached JMAP session of the person receiving (or losing) the
    share — so the change reaches THEM immediately.

    Important: the person sharing never notices the cache; it always hits the
    other one. That is exactly why the cleanup has to happen here and not on read.
    Best effort: if no ClaraOS account matches the address, the share simply went
    to someone without a connected mailbox.
    """
    if not adresse:
        return
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT username FROM claraos_app_credentials "
                "WHERE app_id = 'mail' AND account_name = $1", adresse)
        from routers import post as P
        for r in rows:
            P._sessions.pop(r["username"], None)
    except Exception as e:      # failed cache upkeep must not break anything
        logger.info("Session-Cache nicht verworfen (%s): %s", adresse, e)


# ── Directory (GAL): server principals + contacts app ────────────────────────

_DIENSTKONTEN = re.compile(r"^(admin|noreply|nextcloud|imip-probe|playwright|sso-|pwtest|e2e-)", re.I)


@router.get("/verzeichnis")
async def post_verzeichnis(request: Request, q: str = Query("", max_length=80),
                           mit_diensten: bool = Query(False)):
    """People search across the mail server **and** the contacts app in one field.

    Outlook's "Global Address List" is the mail server's principal directory
    here: every account, every group. Service and test accounts are hidden by
    default — they are addresses, but not people.
    """
    user = require_caller(request)
    nadel = q.strip().lower()

    # Important: the directory has two sources, and one must not take the other
    # down with it. For a user without a connected mailbox `Principal/query`
    # returned 409 — and the UI showed "nobody found" although the contacts app
    # was full. A directory that is EMPTY instead of INCOMPLETE when the mailbox
    # is missing is lying.
    hinweis = None
    try:
        prin = await _principals(user)
    except HTTPException as e:
        prin = {}
        hinweis = ("Ohne verbundenes Postfach zeigt das Verzeichnis nur die Kontakte-App — "
                   "die Postfächer des Servers bleiben verborgen."
                   if e.status_code == 409 else f"Mailserver nicht erreichbar ({e.status_code})")
        logger.info("Verzeichnis ohne Mailserver für %s: %s", user, e.detail)

    treffer: list[dict[str, Any]] = []
    for p in prin.values():
        lokal = (p["email"].split("@")[0] or "")
        if not mit_diensten and _DIENSTKONTEN.match(lokal):
            continue
        if nadel and nadel not in p["name"].lower() and nadel not in p["email"].lower():
            continue
        treffer.append({"name": p["name"], "email": p["email"], "typ": p["typ"],
                        "quelle": "verzeichnis", "id": p["id"]})

    # Add the contacts app (the same source the composer uses for suggestions)
    try:
        from routers.post import _internal
        async with _internal(user) as cl:
            r = await cl.get("/api/claraos/contacts", params={"limit": 300})
        if r.status_code == 200:
            bekannt = {t["email"].lower() for t in treffer}
            for k in (r.json().get("contacts") or []):
                namen = k.get("namen") or {}
                name = (namen.get("anzeige") or " ".join(
                    x for x in [namen.get("vorname"), namen.get("nachname")] if x) or "").strip()
                for m in (k.get("mails") or []):
                    adr = (m.get("wert") or "").strip()
                    if not adr or adr.lower() in bekannt:
                        continue
                    if nadel and nadel not in name.lower() and nadel not in adr.lower():
                        continue
                    bekannt.add(adr.lower())
                    treffer.append({"name": name or adr, "email": adr, "typ": "kontakt",
                                    "quelle": "kontakte", "id": k.get("id") or adr})
    except Exception as e:  # contacts are an extra — the directory works on its own
        logger.info("Verzeichnis ohne Kontakte-App: %s", e)

    treffer.sort(key=lambda x: (x["quelle"] != "verzeichnis", x["name"].lower()))
    return {"eintraege": treffer[:200], "anzahl": len(treffer), "hinweis": hinweis}


# ── Personal distribution lists ──────────────────────────────────────────────

class VerteilerIn(BaseModel):
    name: str
    mitglieder: list[str]


@router.get("/verteiler")
async def post_verteiler(request: Request):
    """The user's own lists — "Family", "Neighbours", whatever they create."""
    user = require_caller(request)
    await _ensure_tables()
    async with user_tx(user) as conn:
        rows = await conn.fetch("SELECT name, mitglieder FROM claraos_post_verteiler "
                                "WHERE username = $1 ORDER BY name", user)
    return {"verteiler": [{"name": r["name"], "mitglieder": json.loads(r["mitglieder"])
                           if isinstance(r["mitglieder"], str) else r["mitglieder"]} for r in rows]}


@router.put("/verteiler")
async def post_verteiler_setzen(body: VerteilerIn, request: Request):
    user = require_caller(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name fehlt")
    adressen = [a.strip() for a in body.mitglieder if a and a.strip()]
    if not adressen:
        raise HTTPException(status_code=400, detail="Ein Verteiler ohne Mitglieder ist keiner")
    await _ensure_tables()
    async with user_tx(user) as conn:
        await conn.execute("""
            INSERT INTO claraos_post_verteiler (username, name, mitglieder, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (username, name) DO UPDATE
              SET mitglieder = EXCLUDED.mitglieder, updated_at = NOW()
        """, user, name, json.dumps(adressen))
    return {"ok": True, "name": name, "anzahl": len(adressen)}


@router.delete("/verteiler/{name}")
async def post_verteiler_loeschen(name: str, request: Request):
    user = require_caller(request)
    await _ensure_tables()
    async with user_tx(user) as conn:
        weg = await conn.execute("DELETE FROM claraos_post_verteiler WHERE username = $1 AND name = $2",
                                 user, name)
    return {"ok": True, "geloescht": weg.endswith("1")}


@router.post("/verteiler/aufloesen")
async def post_verteiler_aufloesen(request: Request, body: dict):
    """Replace list names in a recipient list with their members.

    The composer calls this before sending. Duplicate addresses are dropped —
    a list containing an address that is already in the field directly must
    not lead to two deliveries.
    """
    user = require_caller(request)
    await _ensure_tables()
    eingabe = [str(x).strip() for x in (body.get("empfaenger") or []) if str(x).strip()]
    async with user_tx(user) as conn:
        rows = await conn.fetch("SELECT name, mitglieder FROM claraos_post_verteiler WHERE username = $1", user)
    verteiler = {r["name"].lower(): (json.loads(r["mitglieder"]) if isinstance(r["mitglieder"], str)
                                     else r["mitglieder"]) for r in rows}
    raus: list[str] = []
    benutzt: list[str] = []
    for e in eingabe:
        treffer = verteiler.get(e.lower())
        if treffer:
            benutzt.append(e)
            raus.extend(treffer)
        else:
            raus.append(e)
    gesehen, sauber = set(), []
    for a in raus:
        k = a.lower()
        if k not in gesehen:
            gesehen.add(k)
            sauber.append(a)
    return {"empfaenger": sauber, "aufgeloest": benutzt}


# ── Server side: group mailboxes and mailing lists (admin only) ──────────────

async def _admin_pflicht(request: Request) -> str:
    """Only admins may create server objects — same rule as user_admin."""
    user = require_caller(request)
    from routers.user_admin import _require_admin
    from auth import get_current_user
    _require_admin(get_current_user(request))
    return user


@router.get("/admin/gruppenpostfaecher")
async def admin_gruppenpostfaecher(request: Request):
    """Group accounts and mailing lists as the mail server knows them."""
    await _admin_pflicht(request)
    from routers.user_admin import _stalwart_jmap, STALWART_MAIL_DOMAIN
    try:
        resp = await _stalwart_jmap([
            ["x:Account/query", {"filter": {}}, "q"],
            ["x:Account/get", {"#ids": {"resultOf": "q", "name": "x:Account/query", "path": "/ids"}}, "a"],
            ["x:MailingList/query", {"filter": {}}, "lq"],
            ["x:MailingList/get", {"#ids": {"resultOf": "lq", "name": "x:MailingList/query", "path": "/ids"}}, "l"],
        ])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Mailserver nicht erreichbar: {e}") from e
    mr = {c[2]: c[1] for c in resp.get("methodResponses") or []}
    gruppen, listen = [], []
    for a in (mr.get("a") or {}).get("list") or []:
        if (a.get("@type") or a.get("type")) == "Group":
            gruppen.append({"id": a.get("id"), "name": a.get("name"),
                            "adresse": a.get("emailAddress"), "beschreibung": a.get("description") or ""})
    for l in (mr.get("l") or {}).get("list") or []:
        listen.append({"id": l.get("id"), "name": l.get("name"), "adresse": l.get("emailAddress"),
                       "beschreibung": l.get("description") or "",
                       "empfaenger": l.get("recipients") or []})
    return {"gruppenpostfaecher": gruppen, "verteilerlisten": listen, "domain": STALWART_MAIL_DOMAIN}


class GruppenpostfachIn(BaseModel):
    name: str                       # localpart, e.g. "family"
    beschreibung: str = ""
    mitglieder: list[str] = []      # localparts or addresses of the members


@router.post("/admin/gruppenpostfaecher")
async def admin_gruppenpostfach_anlegen(body: GruppenpostfachIn, request: Request):
    """Create a group mailbox and add the members.

    Important: a group account in Stalwart has **no credentials** — nobody logs
    in as `family@`. Access comes solely from membership: the `memberGroupIds`
    field on the *user* account. That is why there are two steps here, and the
    second one is the one that matters.
    """
    await _admin_pflicht(request)
    from routers.user_admin import _stalwart_jmap, STALWART_DOMAIN_ID, STALWART_MAIL_DOMAIN
    localpart = body.name.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,30}", localpart):
        raise HTTPException(status_code=400, detail="Ungültiger Name für ein Gruppenpostfach")

    resp = await _stalwart_jmap([["x:Account/set", {"create": {"g0": {
        "@type": "Group", "name": localpart, "domainId": STALWART_DOMAIN_ID,
        "description": body.beschreibung or localpart,
    }}}, "c"]])
    mr = resp["methodResponses"][0][1]
    gid = ((mr.get("created") or {}).get("g0") or {}).get("id")
    if not gid:
        nc = (mr.get("notCreated") or {}).get("g0") or {}
        text = f"{nc.get('type', '')} {nc.get('description', '')}".strip()
        if "exist" in text.lower() or "duplicate" in text.lower():
            q = await _stalwart_jmap([
                ["x:Account/query", {"filter": {"text": localpart}}, "q"],
                ["x:Account/get", {"#ids": {"resultOf": "q", "name": "x:Account/query", "path": "/ids"}}, "a"],
            ])
            for a in q["methodResponses"][1][1].get("list") or []:
                if a.get("emailAddress") == f"{localpart}@{STALWART_MAIL_DOMAIN}":
                    gid = a["id"]
        if not gid:
            raise HTTPException(status_code=502, detail=f"Gruppenpostfach abgelehnt: {text or 'unbekannt'}")

    ergebnis = await _mitglieder_setzen(gid, body.mitglieder)
    return {"ok": True, "id": gid, "adresse": f"{localpart}@{STALWART_MAIL_DOMAIN}", "mitglieder": ergebnis}


class MitgliederIn(BaseModel):
    mitglieder: list[str]


@router.put("/admin/gruppenpostfaecher/{gid}/mitglieder")
async def admin_gruppenpostfach_mitglieder(gid: str, body: MitgliederIn, request: Request):
    await _admin_pflicht(request)
    return {"ok": True, "mitglieder": await _mitglieder_setzen(gid, body.mitglieder)}


async def _mitglieder_setzen(gid: str, mitglieder: list[str]) -> list[dict[str, Any]]:
    """Add `gid` to `memberGroupIds` of the given user accounts.

    Existing memberships in other groups are preserved: read, extended, written
    back. Setting blindly would throw a user out of every other group — the same
    mistake as with `shareWith`.
    """
    from routers.user_admin import _stalwart_jmap, STALWART_MAIL_DOMAIN
    if not mitglieder:
        return []
    gesucht = {m.strip().lower().split("@")[0] for m in mitglieder if m.strip()}
    q = await _stalwart_jmap([
        ["x:Account/query", {"filter": {}}, "q"],
        ["x:Account/get", {"#ids": {"resultOf": "q", "name": "x:Account/query", "path": "/ids"}}, "a"],
    ])
    konten = q["methodResponses"][1][1].get("list") or []
    out: list[dict[str, Any]] = []
    updates: dict[str, Any] = {}
    for a in konten:
        lokal = (a.get("emailAddress") or "").split("@")[0].lower()
        if lokal not in gesucht:
            continue
        if (a.get("@type") or a.get("type")) != "User":
            out.append({"konto": lokal, "stand": "übersprungen (kein Nutzerkonto)"})
            continue
        bestand = list(a.get("memberGroupIds") or [])
        if gid in bestand:
            out.append({"konto": lokal, "stand": "war schon Mitglied"})
            continue
        updates[a["id"]] = {"memberGroupIds": bestand + [gid]}
        out.append({"konto": lokal, "stand": "eingetragen"})
    gefunden = {o["konto"] for o in out}
    for fehlt in gesucht - gefunden:
        out.append({"konto": fehlt, "stand": "kein Postfach auf dem Server"})
    if updates:
        r = await _stalwart_jmap([["x:Account/set", {"update": updates}, "u"]])
        nu = r["methodResponses"][0][1].get("notUpdated") or {}
        if nu:
            for o in out:
                if o["stand"] == "eingetragen":
                    o["stand"] = "abgelehnt"
            logger.warning("Mitgliedschaft abgelehnt: %s", nu)
        else:
            # Important: same trap as with sharing: the account list lives in
            # the cached JMAP session. Without this, a newly added member does not
            # see the group mailbox for up to five minutes — and assumes adding
            # them failed.
            for a in konten:
                if a["id"] in updates:
                    await _session_verwerfen(a.get("emailAddress") or "")
    return out


class VerteilerlisteIn(BaseModel):
    name: str
    beschreibung: str = ""
    empfaenger: list[str]


@router.post("/admin/verteilerlisten")
async def admin_verteilerliste_anlegen(body: VerteilerlisteIn, request: Request):
    """Server-side mailing list: an address that delivers to all members.

    Difference to a group mailbox: a list **stores nothing**. It distributes and
    forgets. Anyone who wants a shared store needs a group mailbox; anyone who
    just wants to reach everybody needs a list.
    """
    await _admin_pflicht(request)
    from routers.user_admin import _stalwart_jmap, STALWART_DOMAIN_ID, STALWART_MAIL_DOMAIN
    localpart = body.name.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,30}", localpart):
        raise HTTPException(status_code=400, detail="Ungültiger Name für eine Verteilerliste")
    adressen = [a.strip() for a in body.empfaenger if a and a.strip()]
    if not adressen:
        raise HTTPException(status_code=400, detail="Eine Verteilerliste ohne Empfänger ist keine")
    resp = await _stalwart_jmap([["x:MailingList/set", {"create": {"l0": {
        "name": localpart, "domainId": STALWART_DOMAIN_ID,
        "description": body.beschreibung or localpart, "recipients": adressen,
    }}}, "c"]])
    mr = resp["methodResponses"][0][1]
    lid = ((mr.get("created") or {}).get("l0") or {}).get("id")
    if not lid:
        nc = (mr.get("notCreated") or {}).get("l0") or {}
        raise HTTPException(status_code=502,
                            detail=f"Liste abgelehnt: {nc.get('type', '')} {nc.get('description', '')}".strip())
    return {"ok": True, "id": lid, "adresse": f"{localpart}@{STALWART_MAIL_DOMAIN}",
            "empfaenger": len(adressen)}
