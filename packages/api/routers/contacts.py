"""Contacts — ClaraOS is the source of truth.

Security: two rules that must NEVER be broken in this router:

  1. **Identity only via `auth.require_caller`.** Never read an identity header
     raw — otherwise a logged-in user could impersonate someone else.

  2. **No SQL here.** All access goes through `services/kontakte_store.py`;
     there `owner` is a mandatory argument, and that is where the role switch
     lives without which row-level security would be ineffective (the API role
     is a superuser and bypasses RLS). Building a query "quickly by hand" here
     would break user separation.
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
from domains_generated import BASE_DOMAIN  # cell: CLARAOS_BASE_DOMAIN
import hashlib
import logging
import os
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from auth import require_caller
from sprache import Text, sprache_jetzt, t as _t, tx
from services import google_kontakte as google
from services import kontakte_abgleich as abgleich
from services import kontakte_dienste as dienste
from services import kontakte_import as einspielen_mod
from services import kontakte_projektion as projektion
from services import kontakte_regeln as regeln
from services import kontakte_store as store
from services import vcard

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/contacts", tags=["contacts"])

# An upload a human makes by hand. 25 MB is enough for several thousand cards
# WITH photos; anything larger is not an address book but a mistake.
MAX_UPLOAD = 25 * 1024 * 1024


def _ich(request: Request) -> str:
    return require_caller(request)


def _nicht_gefunden(e: store.KontaktFehlt) -> HTTPException:
    # Deliberately 404 also for "belongs to someone else". A separate 403 would
    # reveal that the ID exists.
    return HTTPException(status_code=404, detail=Text("contacts.notFound"))


# ── Models ──────────────────────────────────────────────────────────────────

class KontaktSchreiben(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)


class HandleSchreiben(BaseModel):
    service: str = Field(min_length=1, max_length=64)
    handle: str = Field(min_length=1, max_length=500)
    # Important: NO `klasse` field. The server derives the class from the service
    # (services/kontakte_dienste.py). If it came from the client, someone could
    # declare LinkedIn as "federated" — and the contact card would promise a
    # capability that does not exist.


# ── Read ────────────────────────────────────────────────────────────────────

@router.get("")
async def liste(request: Request,
                q: str | None = Query(None, description="Suchbegriff"),
                papierkorb: bool = Query(False),
                limit: int = Query(200, ge=1, le=1000),
                offset: int = Query(0, ge=0)) -> dict:
    ich = _ich(request)
    kontakte = await store.liste(ich, suche=q, entfernte=papierkorb,
                                 limit=limit, offset=offset)
    return {"count": len(kontakte), "contacts": kontakte}


@router.get("/imports")
async def import_laeufe(request: Request) -> dict:
    return {"laeufe": await store.laeufe(_ich(request))}


@router.get("/export.vcf", response_class=PlainTextResponse)
async def export_vcf(request: Request) -> PlainTextResponse:
    """Everything as .vcf — the backup and migration path.

    This is the safety net for switching over on the phone: back up first,
    then switch.
    """
    ich = _ich(request)
    kontakte = await store.liste(ich, limit=10000)
    teile = []
    for k in kontakte:
        voll = await store.hole(ich, k["id"])
        # The photo belongs in the backup. An export without photos looks
        # complete but is not — exactly the loss a backup is meant to prevent.
        bild = await store.foto_lesen(ich, k["id"]) if voll.get("photo_id") else None
        teile.append(vcard.schreiben(voll["data"], uid=voll["id"],
                                     handles=voll.get("handles") or [], foto=bild))
    return PlainTextResponse(
        "".join(teile), media_type="text/vcard; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="claraos-kontakte.vcf"'})


@router.get("/dienste")
async def dienste_katalog() -> dict:
    """Which services ClaraOS knows — and what it can really do there.

    The UI builds its selection list from this. That way there is ONE source of
    truth about services and classes instead of two that drift apart.

    Warning: MUST be declared before `/{contact_id}`. FastAPI takes the FIRST
    matching route and does not fall back: if `/{contact_id}` comes first,
    `/dienste` is read as a contact ID and dies with a 500 on the UUID
    comparison. The same trap is documented in `teams_admin` for
    `/me/resources`. `tests/kontakte_routen_test.py` pins this down.
    """
    return {"dienste": dienste.katalog(await sprache_jetzt())}


@router.get("/regel")
async def regel_lesen(request: Request) -> dict:
    """The caller's reachability rule — and what it honestly does."""
    ich = _ich(request)
    lang = await sprache_jetzt()
    return {
        "erreichbar": await regeln.regel_holen(ich),
        # The UI should not have to guess where the rule applies. It applies in
        # the channels ClaraOS itself controls — and nowhere else. That needs
        # to be stated.
        "greift_in": [_t(lang, "contacts.appliesIn.shareContacts"), _t(lang, "contacts.appliesIn.shareKnowledge")],
        "greift_nicht_in": [_t(lang, "contacts.notIn.phone"), _t(lang, "contacts.notIn.email"), "WhatsApp", "SMS",
                            _t(lang, "contacts.notIn.outside", product=PRODUCT_NAME)],
    }


@router.put("/regel")
async def regel_schreiben(request: Request, wert: str = Query(...)) -> dict:
    ich = _ich(request)
    try:
        await regeln.regel_setzen(ich, wert)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"erreichbar": wert}


@router.get("/{contact_id}")
async def einer(contact_id: str, request: Request) -> dict:
    try:
        return await store.hole(_ich(request), contact_id)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)


@router.get("/{contact_id}/versions")
async def versionen(contact_id: str, request: Request) -> dict:
    ich = _ich(request)
    try:
        await store.hole(ich, contact_id)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    return {"versions": await store.fassungen(ich, contact_id)}


# ── Write ─────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
async def anlegen(body: KontaktSchreiben, request: Request) -> dict:
    ich = _ich(request)
    cid = await store.anlegen(ich, body.data, changed_by=ich)
    return {"id": cid}


@router.put("/{contact_id}")
async def aendern(contact_id: str, body: KontaktSchreiben, request: Request) -> dict:
    ich = _ich(request)
    try:
        geaendert = await store.aendern(ich, contact_id, body.data, changed_by=ich)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    # `geaendert=False` is NOT an error: same content, hence no new version.
    return {"id": contact_id, "geaendert": geaendert}


@router.delete("/google")
async def google_trennen(request: Request) -> dict:
    """Disconnect the Google account.

    Warning: MUST be declared before `DELETE /{contact_id}` — otherwise `/google`
    is read as a contact ID and the endpoint is unreachable. The route test
    (`tests/kontakte_routen_test.py`) guards this.
    Does NOT delete any contacts — they belong to ClaraOS.

    The source shadow also stays in place: whoever reconnects later should
    continue where they left off instead of duplicating everything.
    """
    ich = _ich(request)
    from database import user_tx
    async with user_tx(ich) as conn:   # row-level security (migrations/042)
        await conn.execute(
            "UPDATE claraos_app_credentials SET is_active = FALSE "
            "WHERE username = $1 AND app_id = $2", ich, GOOGLE_APP_ID)
    return {"verbunden": False,
            "hinweis": await tx("contacts.unlinked", product=PRODUCT_NAME)}


@router.delete("/{contact_id}")
async def entfernen(contact_id: str, request: Request) -> dict:
    """Tombstone — restorable, and the next import does NOT resurrect it
    (the source rows stay in place)."""
    ich = _ich(request)
    try:
        await store.entfernen(ich, contact_id, changed_by=ich)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    return {"id": contact_id, "state": "removed", "wiederherstellbar": True}


@router.post("/{contact_id}/restore")
async def wiederherstellen(contact_id: str, request: Request) -> dict:
    ich = _ich(request)
    try:
        await store.wiederherstellen(ich, contact_id, changed_by=ich)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    return {"id": contact_id, "state": "active"}


@router.post("/{contact_id}/versions/{seq}/restore")
async def fassung_zurueck(contact_id: str, seq: int, request: Request) -> dict:
    ich = _ich(request)
    try:
        geaendert = await store.fassung_zurueckholen(ich, contact_id, seq, changed_by=ich)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    return {"id": contact_id, "seq": seq, "geaendert": geaendert}


@router.delete("/{contact_id}/purge")
async def endgueltig(contact_id: str, request: Request,
                     bestaetigt: bool = Query(False)) -> dict:
    """Irreversible: contact, ALL versions, source shadow, handles.

    Why this must exist: an address book mostly contains data of **third
    parties** who were never asked. "We keep everything forever" is not a
    tenable position when faced with an erasure request.

    `?bestaetigt=true` is mandatory — an irreversible step must not look the
    same as a reversible one.
    """
    ich = _ich(request)
    if not bestaetigt:
        raise HTTPException(
            status_code=400,
            detail="Endgueltiges Loeschen braucht `?bestaetigt=true`. "
                   "Kontakt, alle Fassungen und die Quellenherkunft sind danach weg.")
    try:
        weg = await store.endgueltig_loeschen(ich, contact_id)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    return {"id": contact_id, "geloescht": True, **weg}


# ── Handles ─────────────────────────────────────────────────────────────────

@router.post("/{contact_id}/handles")
async def handle_setzen(contact_id: str, body: HandleSchreiben, request: Request) -> dict:
    ich = _ich(request)
    service = body.service.strip().lower()
    handle = dienste.normalisieren(service, body.handle)
    if not handle:
        raise HTTPException(status_code=400, detail="Die Kennung ist leer.")
    # Important: the class comes from the table, not from the request. Unknown
    # services are "verweis" (link only) — the cautious promise, never the generous one.
    klasse = dienste.klasse_von(service)
    try:
        await store.handle_setzen(ich, contact_id, service, handle, klasse)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    return {"ok": True, "service": service, "handle": handle, "klasse": klasse}


@router.delete("/{contact_id}/handles")
async def handle_weg(contact_id: str, request: Request,
                     service: str = Query(...), handle: str = Query(...)) -> dict:
    await store.handle_entfernen(_ich(request), contact_id, service.lower(), handle)
    return {"ok": True}


@router.get("/{contact_id}/foto")
async def foto(contact_id: str, request: Request):
    """Serve a contact's photo.

    Security: goes through the same gate as everything else — whoever may not
    see the contact does not get the photo either. Row-level security decides,
    not the unguessability of an ID.
    """
    from fastapi.responses import Response
    treffer = await store.foto_lesen(_ich(request), contact_id)
    if not treffer:
        raise HTTPException(status_code=404, detail="Kein Bild hinterlegt.")
    roh, mime = treffer
    return Response(content=roh, media_type=mime,
                    headers={"Cache-Control": "private, max-age=3600"})


# ── Import ──────────────────────────────────────────────────────────────────

@router.post("/import/vcf")
async def import_vcf(request: Request, datei: UploadFile = File(...)) -> dict:
    """Import a `.vcf` — the path that fills the address book FIRST.

    The source shadow is recorded from the first import on. That makes a second
    upload of the same file a no-op (instead of duplicating everything), and a
    **removed** contact is NOT resurrected.
    """
    ich = _ich(request)
    roh = await datei.read()
    if len(roh) > MAX_UPLOAD:
        raise HTTPException(status_code=413,
                            detail=Text("contacts.fileTooLarge", mb=MAX_UPLOAD // 1024 // 1024))
    try:
        text = roh.decode("utf-8")
    except UnicodeDecodeError:
        # Older exports (Outlook, old Android versions) are often latin-1.
        text = roh.decode("latin-1", errors="replace")

    bloecke = vcard.karten(text)
    if not bloecke:
        raise HTTPException(status_code=400,
                            detail=Text("contacts.noVcard"))

    quelle, konto = "vcf", (datei.filename or "upload")[:120]
    lauf = await store.lauf_beginnen(ich, quelle, konto)
    z = einspielen_mod.zaehler()
    fehler: list[str] = []
    bilder = 0

    for block in bloecke:
        try:
            data, handles, foto, uid = vcard.lesen(block)
            if not data:
                einspielen_mod.zaehlen(z, einspielen_mod.UEBERSPRUNGEN)
                continue
            # Without a UID: derive the ID from the content — otherwise every
            # re-upload of the same file would create everything again.
            kennung = uid or hashlib.sha256(
                store.inhalt_hash(data).encode()).hexdigest()[:32]
            ergebnis = await einspielen_mod.einspielen(
                ich, quelle, konto, kennung, data, handles)
            einspielen_mod.zaehlen(z, ergebnis)

            # Important: store the photo, do not just parse and discard it. A
            # photo is part of the contact — the superset keeps it.
            if foto and ergebnis in (einspielen_mod.NEU, einspielen_mod.GEAENDERT):
                try:
                    treffer = await store.quelle_finden(ich, quelle, konto, kennung)
                    if treffer and treffer.get("contact_id"):
                        pid = await store.foto_ablegen(ich, foto[0], foto[1])
                        await store.foto_setzen(ich, treffer["contact_id"], pid)
                        bilder += 1
                except Exception as e:      # a bad photo does not sink the contact
                    logger.warning("Foto zu %s nicht abgelegt: %s", kennung, e)
        except Exception as e:            # a broken card does not sink the run
            logger.warning("vcf-Import: Karte uebersprungen: %s", e)
            einspielen_mod.zaehlen(z, einspielen_mod.UEBERSPRUNGEN)
            if len(fehler) < 5:
                fehler.append(str(e)[:200])

    await store.lauf_abschliessen(ich, lauf, z, "; ".join(fehler) or None)
    return {"lauf": lauf, **z, "bilder": bilder, "fehler": fehler}


# ── Google ──────────────────────────────────────────────────────────────────
#
# Security: read-only. We request only `contacts.readonly`, so ClaraOS CANNOT
#    write to Google — the no-data-loss guarantee rests on a capability that
#    does not exist, not on our carefulness.

GOOGLE_APP_ID = "google-kontakte"


def _google_konfig() -> tuple[str, str, str]:
    """client_id / client_secret / redirect_uri — from the environment.

    If any of them is missing, the Google path simply does not exist. The user
    should be told so in a clear sentence, not with a 500.
    """
    cid = os.environ.get("GOOGLE_CLIENT_ID", "")
    secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    basis = os.environ.get("CLARAOS_PUBLIC_URL", f"https://home.{BASE_DOMAIN}").rstrip("/")
    return cid, secret, f"{basis}/api/claraos/contacts/google/callback"


async def _google_zugang(owner: str) -> dict:
    """Fetch the stored Google access (refresh token, account)."""
    from database import user_tx
    from encryption import decrypt_credentials
    import json as _json
    if not owner:
        raise google.GoogleFehlt(Text("contacts.noGoogleAccess"))
    async with user_tx(owner) as conn:   # row-level security (migrations/042)
        r = await conn.fetchrow(
            "SELECT credentials FROM claraos_app_credentials "
            "WHERE username = $1 AND app_id = $2 AND is_active = TRUE",
            owner, GOOGLE_APP_ID)
    if not r:
        raise google.GoogleFehlt(Text("contacts.noGoogleAccess"))
    d = decrypt_credentials(bytes(r["credentials"]))
    if isinstance(d, str):
        d = _json.loads(d)
    return d


@router.get("/google/status")
async def google_status(request: Request) -> dict:
    ich = _ich(request)
    cid, secret, _r = _google_konfig()
    if not cid or not secret:
        return {"moeglich": False, "verbunden": False,
                "hinweis": await tx("contacts.googleNotSetUpVars")}
    try:
        z = await _google_zugang(ich)
        konto = z.get("konto", "")
    except Exception:
        return {"moeglich": True, "verbunden": False,
                "hinweis": await tx("contacts.notConnected"), "nur_lesend": True}
    return {"moeglich": True, "verbunden": True, "konto": konto,
            "nur_lesend": True, "zeiger": await store.zeiger_stand(ich)}


@router.get("/google/start")
async def google_start(request: Request) -> dict:
    """Return the URL where the user authorises THEIR Google account."""
    ich = _ich(request)
    cid, secret, redirect = _google_konfig()
    if not cid or not secret:
        raise HTTPException(status_code=503,
                            detail=Text("contacts.googleNotSetUp"))
    # `state` carries the user. On the way back it is checked against the
    # authenticated identity — a foreign `state` must never cause a token to
    # end up with the wrong user.
    return {"url": google.anmelde_url(cid, redirect, state=ich),
            "hinweis": await tx("contacts.readOnlyAccess", product=PRODUCT_NAME)}


@router.get("/google/callback")
async def google_callback(request: Request,
                          code: str = Query(""), state: str = Query(""),
                          error: str = Query("")):
    """Google's OAuth callback — the user's browser lands here.

    This MUST be a GET: Google redirects the browser here with
    `?code=…&state=…`. A POST endpoint would never be reached.

    Because the request comes through the reverse proxy, it carries the
    Authentik identity — so `require_caller` returns the real user, and the
    comparison with `state` is a real check, not a formality.
    """
    from fastapi.responses import RedirectResponse
    basis = os.environ.get("CLARAOS_PUBLIC_URL", f"https://home.{BASE_DOMAIN}").rstrip("/")
    zurueck = f"{basis}/?app=kontakte"

    def weiter(status: str, text: str = "") -> RedirectResponse:
        from urllib.parse import quote
        ziel = f"{zurueck}&google={status}"
        if text:
            ziel += f"&meldung={quote(text[:200])}"
        return RedirectResponse(ziel, status_code=303)

    if error:
        return weiter("abgebrochen", await tx("contacts.googleSays", error=error))
    ich = _ich(request)
    if not code:
        return weiter("fehler", await tx("contacts.noCode"))
    if state != ich:
        # Security: `state` MUST match the logged-in user. Otherwise someone
        # else's authorisation code could end up on this account — or, worse,
        # this user's code on someone else's.
        logger.warning("Google-Rueckweg: state=%r passt nicht zu %r", state, ich)
        return weiter("fehler", await tx("contacts.otherAccount"))

    cid, secret, redirect = _google_konfig()
    if not cid or not secret:
        return weiter("fehler", await tx("contacts.googleNotSetUp"))
    try:
        tok = await google.code_eintauschen(cid, secret, redirect, code)
    except Exception as e:
        logger.warning("Google-Token-Tausch fehlgeschlagen: %s", e)
        return weiter("fehler", await tx("contacts.codeFailed"))

    refresh = tok.get("refresh_token")
    if not refresh:
        # Google returns the long-lived token ONLY the first time. Whoever has
        # authorised before gets none — not our bug, but without an explanation
        # users look for the fault on their side.
        return weiter("fehler", await tx("contacts.noRefreshToken"))
    konto = await google.konto_name(tok.get("access_token", ""))
    await _google_speichern(ich, refresh, konto)
    return weiter("verbunden", konto)


async def _google_speichern(owner: str, refresh_token: str, konto: str) -> None:
    from database import user_tx
    from encryption import encrypt_credentials
    import json as _json
    async with user_tx(owner) as conn:   # row-level security (migrations/042)
        await conn.execute(
            "INSERT INTO claraos_app_credentials (username, app_id, account_name, "
            "  credentials, is_active) VALUES ($1, $2, $3, $4, TRUE) "
            "ON CONFLICT (username, app_id, account_name) DO UPDATE SET "
            "  credentials = EXCLUDED.credentials, is_active = TRUE, updated_at = NOW()",
            owner, GOOGLE_APP_ID, konto or "Default",
            encrypt_credentials(_json.dumps({"refresh_token": refresh_token, "konto": konto})))


@router.post("/google/sync")
async def google_sync(request: Request, voll: bool = Query(False)) -> dict:
    """Fetch contacts from Google.

    Without a sync token: full sync. With one: only changes since the last run.
    `?voll=true` forces a full sync (e.g. after something went wrong).
    """
    ich = _ich(request)
    cid, secret, _r = _google_konfig()
    if not cid or not secret:
        raise HTTPException(status_code=503, detail=Text("contacts.googleNotSetUp"))
    try:
        zugang = await _google_zugang(ich)
        access = await google.zugriffstoken(cid, secret, zugang["refresh_token"])
    except google.GoogleFehlt as e:
        raise HTTPException(status_code=409, detail=str(e))

    konto = zugang.get("konto", "")
    quelle = "google"
    zeiger = None if voll else await store.zeiger_holen(ich, quelle, konto)

    lauf = await store.lauf_beginnen(ich, quelle, konto)
    z = einspielen_mod.zaehler()
    fehler: list[str] = []
    war_voll = zeiger is None

    try:
        try:
            leute, neuer_zeiger = await google.personen(access, zeiger)
        except google.VollabgleichNoetig:
            # Not an error but an expected state: Google's sync token can
            # expire at any time. Treating it as a failure eventually leaves a
            # sync that never runs again.
            logger.info("Google-Zeiger abgelaufen — Vollabgleich fuer %s", ich)
            leute, neuer_zeiger = await google.personen(access, None)
            war_voll = True

        for person in leute:
            kennung = google.kennung(person)
            if not kennung:
                einspielen_mod.zaehlen(z, einspielen_mod.UEBERSPRUNGEN)
                continue
            try:
                if google.ist_geloescht(person):
                    ergebnis = await einspielen_mod.einspielen(
                        ich, quelle, konto, kennung, {}, geloescht=True)
                else:
                    data, handles = google.abbilden(person)
                    if not data:
                        einspielen_mod.zaehlen(z, einspielen_mod.UEBERSPRUNGEN)
                        continue
                    ergebnis = await einspielen_mod.einspielen(
                        ich, quelle, konto, kennung, data, handles)
                einspielen_mod.zaehlen(z, ergebnis)
            except Exception as e:      # a broken person record does not sink the run
                logger.warning("Google-Import: %s uebersprungen: %s", kennung, e)
                einspielen_mod.zaehlen(z, einspielen_mod.UEBERSPRUNGEN)
                if len(fehler) < 5:
                    fehler.append(str(e)[:200])

        # Important: set the sync token ONLY after everything is imported. If it
        # were set first and the run then aborted, those changes would be
        # skipped forever — Google never delivers them again.
        if neuer_zeiger:
            await store.zeiger_setzen(ich, quelle, konto, neuer_zeiger, voll=war_voll)
    except google.GoogleFehlt as e:
        await store.lauf_abschliessen(ich, lauf, z, str(e))
        raise HTTPException(status_code=409, detail=e.args[0] if e.args and isinstance(e.args[0], Text) else str(e))
    except Exception as e:
        await store.lauf_abschliessen(ich, lauf, z, str(e)[:400])
        raise HTTPException(status_code=502, detail=Text("contacts.googleSyncFailed", error=e))

    await store.lauf_abschliessen(ich, lauf, z, "; ".join(fehler) or None)
    return {"lauf": lauf, "konto": konto, "vollabgleich": war_voll, **z, "fehler": fehler}


# ── Projection into a dedicated Nextcloud address book ──────────────────────
#
# ClaraOS writes into its OWN address book `claraos` and is its only writer.
# The address book fed by Google stays untouched.
# One-way: we never read this address book to take contacts from it —
#    otherwise there would be two sources of truth.

@router.get("/projektion/status")
async def projektion_status(request: Request) -> dict:
    ich = _ich(request)
    from routers.files import nc_zugang
    art = await nc_zugang(ich)
    u = await store.projektion_uebersicht(ich, projektion.ZIEL)
    if art != "eigen":
        return {"moeglich": False, "adressbuch": projektion.BUCH, **u,
                "hinweis": await tx("contacts.ownNextcloud")}
    return {"moeglich": True, "adressbuch": projektion.BUCH, **u}


@router.post("/projektion/sync")
async def projektion_sync(request: Request) -> dict:
    """Bring the ClaraOS address book up to date with the contacts.

    A reconciliation, not a queue: it compares desired and actual state and is
    therefore self-healing. Whatever failed last time is caught up on the next
    run.
    """
    ich = _ich(request)
    try:
        return await projektion.abgleichen(ich)
    except projektion.KeinZugang as e:
        raise HTTPException(status_code=409, detail=str(e))
    except projektion.ZielVerboten as e:
        # This must never happen. If it does, it is a bug in OUR code and not a
        # user error — log it loudly, not silently.
        logger.error("Projektion wollte ausserhalb des ClaraOS-Adressbuchs schreiben: %s", e)
        raise HTTPException(status_code=500, detail="Abgleich abgebrochen (Zielpruefung).")
    except Exception as e:
        logger.warning("Projektion fehlgeschlagen fuer %s: %s", ich, e)
        raise HTTPException(status_code=502, detail=Text("contacts.syncFailed", error=e))


# ── User matching and teams ─────────────────────────────────────────────────
#
# Important: links are NEVER created automatically. Every match is a suggestion
#    that a human confirms. Reason: Authentik keeps no verification flag for
#    email addresses — so there is nothing an automatic process could rely on.
#    And a wrong link here does not mean "wrong name" but: someone gains
#    visibility into team content.

class LinkEntscheidung(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    matched_on: str = "manual"
    bestaetigt: bool = True


@router.get("/abgleich/vorschlaege")
async def abgleich_vorschlaege(request: Request) -> dict:
    """Which contacts look like a ClaraOS user?

    Security: matching is done only against users the caller **shares a team**
    with — otherwise this would be a directory oracle: anyone writing arbitrary
    email addresses into their address book could find out who has an account.
    """
    ich = _ich(request)
    try:
        v = await abgleich.vorschlaege(ich)
    except Exception as e:
        logger.warning("Abgleich fehlgeschlagen fuer %s: %s", ich, e)
        raise HTTPException(status_code=502, detail=Text("contacts.syncImpossible", error=e))
    return {"count": len(v), "vorschlaege": v, "automatisch": False}


@router.post("/{contact_id}/link")
async def link_setzen(contact_id: str, body: LinkEntscheidung, request: Request) -> dict:
    """Confirm a suggestion — or reject it.

    Rejections are stored too. Otherwise the same suggestion would come back on
    the next match, and a question dismissed three times gets blindly confirmed
    the fourth time.
    """
    ich = _ich(request)
    try:
        await store.link_setzen(ich, contact_id, body.username, body.matched_on,
                                "bestaetigt" if body.bestaetigt else "abgelehnt", ich)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    return {"ok": True, "username": body.username,
            "confidence": "bestaetigt" if body.bestaetigt else "abgelehnt"}


@router.delete("/{contact_id}/link/{username}")
async def link_loesen(contact_id: str, username: str, request: Request) -> dict:
    """Remove the link entirely — afterwards it may be suggested again."""
    await store.link_loesen(_ich(request), contact_id, username)
    return {"ok": True}


@router.get("/teams/meine")
async def meine_teams(request: Request) -> dict:
    """The caller's teams — and whether they may add anyone at all.

    Adding someone to a team is an administrative action in ClaraOS
    (`teams_admin` requires the admin role). The contact card says so honestly
    instead of offering a button that ends in 403 for most users.
    """
    from auth import get_current_user
    ich = _ich(request)
    try:
        user = get_current_user(request)
        darf = user.get("role") == "admin"
    except Exception:
        darf = False
    try:
        nutzer = await abgleich.sichtbare_nutzer(ich)
    except Exception:
        nutzer = {}
    teams = sorted({t for u in nutzer.values() for t in u["teams"]})
    return {"teams": teams, "darf_einladen": darf,
            "hinweis": None if darf else await tx("contacts.teamAdmin")}


# ── Sharing and blocking ────────────────────────────────────────────────────
#
# Important: the core principle is honesty. Every block carries a MEASURED state:
#    "enforced" only where ClaraOS actually did something; otherwise "hidden"
#    or "failed". A block that is merely claimed is worse than none — users
#    believe they are protected.

class TeilenBody(BaseModel):
    mit: str = Field(min_length=1, max_length=120)
    permission: str = "read"


class BlockBody(BaseModel):
    service: str = Field(min_length=1, max_length=64)


@router.get("/{contact_id}/freigaben")
async def freigaben_lesen(contact_id: str, request: Request) -> dict:
    ich = _ich(request)
    try:
        await store.hole(ich, contact_id)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    return {"freigaben": await regeln.freigaben(ich, contact_id),
            "blocks": await regeln.blocks(ich, contact_id)}


@router.post("/{contact_id}/freigaben")
async def teilen(contact_id: str, body: TeilenBody, request: Request) -> dict:
    ich = _ich(request)
    try:
        return await regeln.teilen(ich, contact_id, body.mit.strip(), body.permission)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    except regeln.NichtErreichbar as e:
        # 409, not 403: it is not a permission error but the recipient's
        #    decision. The difference belongs in the message.
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{contact_id}/freigaben/{mit}")
async def teilen_zurueck(contact_id: str, mit: str, request: Request) -> dict:
    await regeln.teilen_zuruecknehmen(_ich(request), contact_id, mit)
    return {"ok": True}


@router.post("/{contact_id}/block")
async def blocken(contact_id: str, body: BlockBody, request: Request) -> dict:
    ich = _ich(request)
    try:
        return await regeln.blocken(ich, contact_id, body.service)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{contact_id}/block/{service}")
async def block_aufheben(contact_id: str, service: str, request: Request) -> dict:
    ich = _ich(request)
    try:
        return await regeln.block_aufheben(ich, contact_id, service)
    except store.KontaktFehlt as e:
        raise _nicht_gefunden(e)


# ── CardDAV import ──────────────────────────────────────────────────────────
#
# Why this exists: whoever syncs their phone to Nextcloud via DAVx5 has their
#    contacts there — and without this path could only import them via Google,
#    which they might not use at all.
#
# Warning: NOT to be confused with the projection: that one WRITES into a
#    dedicated `claraos` address book. This path READS from the others — and
#    explicitly skips the ClaraOS address book. Otherwise ClaraOS would re-import
#    its own output, and the source of truth would become its own reflection.

@router.post("/import/carddav")
async def import_carddav(request: Request) -> dict:
    """Import the user's Nextcloud address books."""
    ich = _ich(request)
    from routers.files import nc_zugang
    if (await nc_zugang(ich)) != "eigen":
        raise HTTPException(
            status_code=409,
            detail=Text("contacts.ownNextcloudShort"))

    from routers.files import _nc_credentials
    from routers.nc_pim import _addressbooks, _dav, _REPORT_VCARD, _hrefs_and_data
    from services import kontakte_projektion as projektion

    nc_user, nc_pass = await _nc_credentials(ich)
    buecher = await _addressbooks(nc_user, nc_pass)

    z = einspielen_mod.zaehler()
    fehler: list[str] = []
    bilder = 0
    gelesen: list[str] = []

    uebergangen: list[str] = []
    for buch in buecher:
        kurz = buch["url"].rstrip("/").rsplit("/", 1)[-1]
        name = buch["name"] or kurz

        # Important: three kinds of address book must NOT be imported (otherwise
        #    a first run pulls in far more cards than the user actually has):
        #
        # 1. `claraos` — our OWN output (the projection). Re-importing it would
        #    make the source of truth its own reflection.
        # 2. `z-server-generated--system` ("Accounts") — Nextcloud's copy of ALL
        #    users. Importing it creates contacts for every user on the server
        #    that nobody added.
        # 3. `z-app-generated--…` ("Recently contacted") — everyone you ever
        #    emailed. That is a history, not an address book.
        #
        # Skipped books are REPORTED, not silently dropped: "many instead of a
        #    few" is noticeable, "a few instead of many" is not.
        if (kurz == projektion.BUCH
                or kurz.startswith(("z-server-generated--", "z-app-generated--"))
                or "/addressbooks/system/" in buch["url"]):
            uebergangen.append(name)
            continue
        gelesen.append(name)
        konto = f"{nc_user}/{kurz}"
        lauf = await store.lauf_beginnen(ich, "carddav", konto)
        zb = einspielen_mod.zaehler()
        try:
            resp = await _dav("REPORT", buch["url"], nc_user, nc_pass, _REPORT_VCARD)
            for _href, text, _etag in _hrefs_and_data(resp):
                for block in vcard.karten(text):
                    try:
                        data, handles, foto, uid = vcard.lesen(block)
                        if not data:
                            einspielen_mod.zaehlen(zb, einspielen_mod.UEBERSPRUNGEN)
                            continue
                        kennung = uid or hashlib.sha256(
                            store.inhalt_hash(data).encode()).hexdigest()[:32]
                        erg = await einspielen_mod.einspielen(
                            ich, "carddav", konto, kennung, data, handles)
                        einspielen_mod.zaehlen(zb, erg)
                        if foto and erg in (einspielen_mod.NEU, einspielen_mod.GEAENDERT):
                            treffer = await store.quelle_finden(ich, "carddav", konto, kennung)
                            if treffer and treffer.get("contact_id"):
                                pid = await store.foto_ablegen(ich, foto[0], foto[1])
                                await store.foto_setzen(ich, treffer["contact_id"], pid)
                                bilder += 1
                    except Exception as e:
                        logger.warning("carddav-Import: Karte uebersprungen: %s", e)
                        einspielen_mod.zaehlen(zb, einspielen_mod.UEBERSPRUNGEN)
                        if len(fehler) < 5:
                            fehler.append(str(e)[:200])
        except Exception as e:
            logger.warning("carddav-Import %s fehlgeschlagen: %s", buch["url"], e)
            if len(fehler) < 5:
                fehler.append(f"{buch['name']}: {str(e)[:150]}")
        await store.lauf_abschliessen(ich, lauf, zb, "; ".join(fehler) or None)
        for k, v in zb.items():
            z[k] = z.get(k, 0) + v

    return {"adressbuecher": gelesen, "uebergangen": uebergangen,
            **z, "bilder": bilder, "fehler": fehler}
