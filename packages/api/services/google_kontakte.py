"""Google Contacts -> ClaraOS.

Security: **access is read-only by design.** We request only
`contacts.readonly`. So ClaraOS *cannot* write to Google — Google rejects every
write call. This is the no-data-loss guarantee for the user, and it does not
depend on our diligence but on a capability that does not exist.
Warning: whoever ever widens this scope removes the guarantee. Then it must
   also be struck from the documentation instead of remaining there.

Why the mapping is so detailed: Google's person model is **richer than vCard**.
That is exactly why ClaraOS keeps the superset — whatever arrives here and fits
no field lands under `frei` (free-form), not in the trash. A mapping that only
takes the vCard intersection would have made the whole design pointless.
"""
from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
PEOPLE_URL = "https://people.googleapis.com/v1/people/me/connections"
PROFIL_URL = "https://people.googleapis.com/v1/people/me"

# Read ONLY. See module header.
SCOPES = ["https://www.googleapis.com/auth/contacts.readonly", "openid", "email"]

# Everything Google knows about a person that we want to keep.
FELDER = ",".join([
    "names", "nicknames", "emailAddresses", "phoneNumbers", "addresses",
    "organizations", "occupations", "birthdays", "events", "relations",
    "urls", "imClients", "biographies", "photos", "userDefined",
    "miscKeywords", "locales", "externalIds", "memberships", "metadata",
])

SEITE = 200          # Google allows up to 1000; 200 keeps responses manageable
TIMEOUT = 30.0


class GoogleFehlt(Exception):
    """No Google access stored for this user."""


class VollabgleichNoetig(Exception):
    """Google's sync token has expired (410) — start over without a token.

    According to Google's documentation a `syncToken` can become invalid at any
    time. That is not an error but an intended state — whoever treats it as a
    failure eventually has a sync that never runs again.
    """


# ── OAuth ───────────────────────────────────────────────────────────────────

def anmelde_url(client_id: str, redirect_uri: str, state: str) -> str:
    """The URL where the user grants access to THEIR Google account.

    `access_type=offline` + `prompt=consent` are both required: without them
    Google returns **no** refresh token the second time, and access would be
    dead after an hour — an error that only shows up the next day.
    """
    return AUTH_URL + "?" + urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    })


async def code_eintauschen(client_id: str, client_secret: str, redirect_uri: str,
                           code: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(TOKEN_URL, data={
            "code": code, "client_id": client_id, "client_secret": client_secret,
            "redirect_uri": redirect_uri, "grant_type": "authorization_code",
        })
    if r.status_code != 200:
        raise RuntimeError(f"Google-Token-Tausch fehlgeschlagen ({r.status_code}): {r.text[:200]}")
    return r.json()


async def zugriffstoken(client_id: str, client_secret: str, refresh_token: str) -> str:
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(TOKEN_URL, data={
            "client_id": client_id, "client_secret": client_secret,
            "refresh_token": refresh_token, "grant_type": "refresh_token",
        })
    if r.status_code != 200:
        # `invalid_grant` almost always means: the user revoked access at
        # Google, or the token was unused for too long. The user should be told,
        # rather than logging it as a server error.
        raise GoogleFehlt(f"Google-Zugang nicht mehr gültig ({r.status_code}). "
                          f"Bitte in den Einstellungen neu verbinden.")
    return r.json()["access_token"]


async def konto_name(access_token: str) -> str:
    """Which Google account belongs to this token? For display and as
    `account` in the source shadow — whoever imports two accounts must be able
    to tell them apart."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.get(PROFIL_URL, params={"personFields": "emailAddresses"},
                        headers={"Authorization": f"Bearer {access_token}"})
    if r.status_code != 200:
        return ""
    for m in (r.json().get("emailAddresses") or []):
        if (m.get("metadata") or {}).get("primary"):
            return m.get("value", "")
    mails = r.json().get("emailAddresses") or []
    return mails[0].get("value", "") if mails else ""


# ── Fetching ────────────────────────────────────────────────────────────────

async def personen(access_token: str, sync_token: str | None = None):
    """Fetch all contacts — incrementally with a sync token, fully without.

    Returns `(list, new_token)`. In an incremental run the list also contains
    **deleted** persons (`metadata.deleted = true`).
    """
    kopf = {"Authorization": f"Bearer {access_token}"}
    alle: list[dict] = []
    seite: str | None = None
    neuer_zeiger = None

    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        while True:
            p: dict[str, Any] = {"personFields": FELDER, "pageSize": SEITE,
                                 "requestSyncToken": "true"}
            if sync_token:
                p["syncToken"] = sync_token
            if seite:
                p["pageToken"] = seite
            r = await c.get(PEOPLE_URL, params=p, headers=kopf)

            if r.status_code == 410:
                raise VollabgleichNoetig("syncToken abgelaufen")
            if r.status_code == 401:
                raise GoogleFehlt("Google lehnt das Token ab.")
            if r.status_code != 200:
                raise RuntimeError(f"People API {r.status_code}: {r.text[:200]}")

            j = r.json()
            alle += j.get("connections") or []
            neuer_zeiger = j.get("nextSyncToken") or neuer_zeiger
            seite = j.get("nextPageToken")
            if not seite:
                break
    return alle, neuer_zeiger


# ── Mapping: Google person -> ClaraOS superset ──────────────────────────────

def _wert(e: dict, *namen: str) -> str:
    for n in namen:
        v = e.get(n)
        if v:
            return str(v)
    return ""


def _label(e: dict) -> str:
    """Google's `type` is the plain name ("home"/"work"/"mobile"), `formattedType`
    the translated version. We use `type` — it is stable and language-neutral."""
    return str(e.get("type") or "").lower()


def _pref(e: dict) -> bool:
    return bool((e.get("metadata") or {}).get("primary"))


def _datum(d: dict | None) -> str:
    """Google's date is an object with an optional year. `--03-14` is the vCard
    notation for "day known, year not" — common for birthdays and must not get
    lost."""
    if not d:
        return ""
    y, m, t = d.get("year"), d.get("month"), d.get("day")
    if m and t:
        return f"{y:04d}-{m:02d}-{t:02d}" if y else f"--{m:02d}-{t:02d}"
    return str(y) if y else ""


def abbilden(person: dict) -> tuple[dict[str, Any], list[dict]]:
    """Google person -> (data, handles). Everything unknown lands under `frei`."""
    data: dict[str, Any] = {}
    handles: list[dict] = []
    frei: dict[str, list[str]] = {}

    namen = (person.get("names") or [{}])[0]
    n = {k: v for k, v in {
        "vorname": namen.get("givenName", ""),
        "nachname": namen.get("familyName", ""),
        "mittelname": namen.get("middleName", ""),
        "praefix": namen.get("honorificPrefix", ""),
        "suffix": namen.get("honorificSuffix", ""),
        "anzeigename": namen.get("displayName", ""),
        "phonetisch_vorname": namen.get("phoneticGivenName", ""),
        "phonetisch_nachname": namen.get("phoneticFamilyName", ""),
    }.items() if v}
    if (person.get("nicknames") or []):
        n["spitzname"] = person["nicknames"][0].get("value", "")
    if n:
        data["namen"] = n

    mails = [{"wert": e["value"], "label": _label(e), "pref": _pref(e)}
             for e in (person.get("emailAddresses") or []) if e.get("value")]
    if mails:
        data["mails"] = mails

    tele = []
    for e in (person.get("phoneNumbers") or []):
        if not e.get("value"):
            continue
        eintrag = {"wert": e["value"], "label": _label(e), "pref": _pref(e)}
        # Google's `canonicalForm` is the E.164 version. It is invaluable for
        # later matching against users — numbers can only be compared when
        # normalised.
        if e.get("canonicalForm"):
            eintrag["e164"] = e["canonicalForm"]
        tele.append(eintrag)
    if tele:
        data["telefone"] = tele

    adr = []
    for e in (person.get("addresses") or []):
        a = {k: v for k, v in {
            "strasse": e.get("streetAddress", ""), "ort": e.get("city", ""),
            "region": e.get("region", ""), "plz": e.get("postalCode", ""),
            "land": e.get("country", ""), "label": _label(e),
        }.items() if v}
        if a:
            adr.append(a)
    if adr:
        data["adressen"] = adr

    orgs = person.get("organizations") or []
    if orgs:
        o = {k: v for k, v in {
            "firma": orgs[0].get("name", ""), "abteilung": orgs[0].get("department", ""),
            "position": orgs[0].get("title", ""),
        }.items() if v}
        if o:
            data["organisation"] = o
    if person.get("occupations") and not (data.get("organisation") or {}).get("position"):
        data.setdefault("organisation", {})["position"] = person["occupations"][0].get("value", "")

    daten: dict[str, Any] = {}
    for b in (person.get("birthdays") or []):
        d = _datum(b.get("date"))
        if d:
            daten["geburtstag"] = d
            break
    weitere = []
    for e in (person.get("events") or []):
        d = _datum(e.get("date"))
        if not d:
            continue
        if _label(e) == "anniversary" and "jahrestag" not in daten:
            daten["jahrestag"] = d
        else:
            weitere.append({"was": _label(e) or "Termin", "datum": d})
    if weitere:
        daten["weitere"] = weitere
    if daten:
        data["daten"] = daten

    web = [{"url": e["value"], "label": _label(e)}
           for e in (person.get("urls") or []) if e.get("value")]
    if web:
        data["webseiten"] = web

    bez = [{"art": _label(e) or "verwandt", "freitext": e["value"]}
           for e in (person.get("relations") or []) if e.get("value")]
    if bez:
        data["beziehungen"] = bez

    notiz = " ".join(b.get("value", "") for b in (person.get("biographies") or []) if b.get("value"))
    if notiz.strip():
        data["notizen"] = notiz.strip()

    sprachen = [e.get("value") for e in (person.get("locales") or []) if e.get("value")]
    if sprachen:
        data["sprachen"] = sprachen

    # Categories from Google's groups ("labels")
    kat = []
    for m in (person.get("memberships") or []):
        g = (m.get("contactGroupMembership") or {}).get("contactGroupId")
        if g and g not in ("myContacts", "starred"):
            kat.append(g)
    if kat:
        data["kategorien"] = kat

    # Handles: Google's imClients carry the service in `protocol`.
    for e in (person.get("imClients") or []):
        if not e.get("username"):
            continue
        dienst = str(e.get("protocol") or _label(e) or "unbekannt").lower()
        handles.append({"service": dienst, "handle": e["username"],
                        "klasse": "foederiert" if dienst in ("matrix", "xmpp", "jabber", "sip")
                                  else "verweis"})

    # What Google has and we do not map: do NOT throw it away.
    for e in (person.get("userDefined") or []):
        if e.get("key"):
            frei.setdefault(f"GOOGLE-{e['key']}", []).append(str(e.get("value", "")))
    for e in (person.get("miscKeywords") or []):
        if e.get("value"):
            frei.setdefault(f"GOOGLE-{_label(e) or 'KEYWORD'}", []).append(str(e["value"]))
    for e in (person.get("externalIds") or []):
        if e.get("value"):
            frei.setdefault(f"GOOGLE-EXTERNAL-{(_label(e) or 'ID').upper()}", []).append(str(e["value"]))
    if frei:
        data["frei"] = frei

    if not (data.get("namen") or {}).get("anzeigename"):
        zus = " ".join(x for x in ((data.get("namen") or {}).get("vorname"),
                                   (data.get("namen") or {}).get("nachname")) if x)
        if zus:
            data.setdefault("namen", {})["anzeigename"] = zus

    return data, handles


def ist_geloescht(person: dict) -> bool:
    return bool((person.get("metadata") or {}).get("deleted"))


def kennung(person: dict) -> str:
    """`people/c123...` — Google's stable identifier. It is the anchor of the
    source shadow; without it the contact could not be recognised in the next
    run and would be duplicated."""
    return str(person.get("resourceName") or "")
