"""vCard <-> ClaraOS contact.

The two directions are not symmetric, and that is intentional:

  * **In** (`lesen`): rescue as much as possible. What we know is mapped;
    everything else lands under `frei` (free-form) instead of in the trash.
    That is what the ClaraOS superset is for — it is richer than any target
    format.

  * **Out** (`schreiben`): a **projection**. The vCard carries what vCard can
    carry. Provenance, confidence, block state and revisions stay in ClaraOS.
    Whoever expects otherwise has misunderstood the model.

Hand-written instead of a library — as `nc_pim.py` already does for
iCal/vCard. The reason is the same: no extra dependency for a line format, and
we have to be tolerant of what Google, Apple and Android actually export
anyway (rather than what RFC 6350 prescribes).
"""
from __future__ import annotations

import base64
import re
import uuid
from typing import Any

# The class of a service comes from the service registry, not from a second
# list here. Two lists drift apart, and then the contact card promises
# something in one place that it takes back in another.
from services.kontakte_dienste import klasse_von as _klasse_von

# vCard folds long lines: a continuation starts with a space or tab.
_FORTSETZUNG = re.compile(r"^[ \t]")

# These properties are mapped. Everything else goes to `frei` — throwing it away
# unread would be exactly the loss the superset is meant to prevent.
_BEKANNT = {
    "BEGIN", "END", "VERSION", "UID", "FN", "N", "NICKNAME", "EMAIL", "TEL",
    "ADR", "ORG", "TITLE", "ROLE", "BDAY", "ANNIVERSARY", "NOTE", "CATEGORIES",
    "URL", "IMPP", "X-SOCIALPROFILE", "PHOTO", "REV", "PRODID", "KIND",
    "X-PHONETIC-FIRST-NAME", "X-PHONETIC-LAST-NAME", "SORT-STRING", "GENDER",
    "LANG", "RELATED",
}

def entfalten(text: str) -> list[str]:
    """Unfold folded lines. Must happen BEFORE any parsing — otherwise a long
    field (typically PHOTO) is torn into unusable pieces."""
    zeilen: list[str] = []
    for roh in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if zeilen and _FORTSETZUNG.match(roh):
            zeilen[-1] += roh[1:]
        else:
            zeilen.append(roh)
    return [z for z in zeilen if z.strip()]


def _zerlegen(zeile: str) -> tuple[str, dict[str, str], str]:
    """`NAME;PARAM=VALUE:content` -> (NAME, {param: value}, content).

    A colon may occur in the content (`URL:https://...`), but not in the name
    part — except inside a quoted parameter. Hence a character-wise search
    instead of blindly trusting `split(":", 1)`.
    """
    in_zitat = False
    schnitt = -1
    for i, c in enumerate(zeile):
        if c == '"':
            in_zitat = not in_zitat
        elif c == ":" and not in_zitat:
            schnitt = i
            break
    if schnitt < 0:
        return zeile.upper(), {}, ""
    kopf, inhalt = zeile[:schnitt], zeile[schnitt + 1:]
    stuecke = kopf.split(";")
    name = stuecke[0].split(".")[-1].upper()      # strip group prefix `item1.TEL`
    params: dict[str, str] = {}
    for p in stuecke[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v.strip('"')
        else:
            params.setdefault("TYPE", p)
    return name, params, inhalt


def _ent(v: str) -> str:
    """Resolve vCard escaping. Order matters: `\\\\` last, otherwise
    `\\\\n` wrongly becomes a line break."""
    out, i = [], 0
    while i < len(v):
        if v[i] == "\\" and i + 1 < len(v):
            n = v[i + 1]
            out.append({"n": "\n", "N": "\n", ",": ",", ";": ";", "\\": "\\"}.get(n, n))
            i += 2
        else:
            out.append(v[i])
            i += 1
    return "".join(out)


def _mask(v: str) -> str:
    return (str(v).replace("\\", "\\\\").replace("\n", "\\n")
            .replace(",", "\\,").replace(";", "\\;"))


def _label(params: dict[str, str]) -> str:
    t = params.get("TYPE", "")
    teile = [x for x in re.split(r"[,;]", t) if x and x.upper() not in ("PREF", "INTERNET", "VOICE")]
    return teile[0].lower() if teile else ""


def _pref(params: dict[str, str]) -> bool:
    return "PREF" in params or params.get("TYPE", "").upper().find("PREF") >= 0


def karten(text: str) -> list[list[str]]:
    """Split the text into individual VCARD blocks (one file = many cards)."""
    out, aktuell = [], None
    for z in entfalten(text):
        oben = z.upper()
        if oben.startswith("BEGIN:VCARD"):
            aktuell = []
        elif oben.startswith("END:VCARD"):
            if aktuell is not None:
                out.append(aktuell)
            aktuell = None
        elif aktuell is not None:
            aktuell.append(z)
    return out


def lesen(block: list[str]) -> tuple[dict[str, Any], list[dict], tuple[bytes, str] | None, str]:
    """One vCard -> (data, handles, foto, uid).

    `foto` is (bytes, mime) or None. `uid` is the vCard UID if present — it
    serves as the source identifier (source shadow).
    """
    data: dict[str, Any] = {
        "namen": {}, "mails": [], "telefone": [], "adressen": [],
        "organisation": {}, "daten": {}, "webseiten": [], "kategorien": [],
        "beziehungen": [], "notizen": "", "frei": {},
    }
    handles: list[dict] = []
    foto: tuple[bytes, str] | None = None
    uid = ""

    for zeile in block:
        name, params, roh = _zerlegen(zeile)
        wert = _ent(roh)
        if name == "UID":
            uid = wert
        elif name == "FN":
            data["namen"]["anzeigename"] = wert
        elif name == "N":
            # N:family;given;middle;prefix;suffix — separators NOT escaped
            t = [_ent(x) for x in roh.split(";")]
            t += [""] * (5 - len(t))
            data["namen"].update({"nachname": t[0], "vorname": t[1], "mittelname": t[2],
                                  "praefix": t[3], "suffix": t[4]})
        elif name == "NICKNAME":
            data["namen"]["spitzname"] = wert
        elif name == "SORT-STRING":
            data["namen"]["sortiername"] = wert
        elif name == "X-PHONETIC-FIRST-NAME":
            data["namen"]["phonetisch_vorname"] = wert
        elif name == "X-PHONETIC-LAST-NAME":
            data["namen"]["phonetisch_nachname"] = wert
        elif name == "EMAIL":
            if wert:
                data["mails"].append({"wert": wert, "label": _label(params), "pref": _pref(params)})
        elif name == "TEL":
            if wert:
                data["telefone"].append({"wert": wert, "label": _label(params), "pref": _pref(params)})
        elif name == "ADR":
            t = [_ent(x) for x in roh.split(";")]
            t += [""] * (7 - len(t))
            if any(t):
                data["adressen"].append({"strasse": t[2], "ort": t[3], "region": t[4],
                                         "plz": t[5], "land": t[6], "label": _label(params)})
        elif name == "ORG":
            t = [_ent(x) for x in roh.split(";")]
            data["organisation"]["firma"] = t[0] if t else ""
            if len(t) > 1:
                data["organisation"]["abteilung"] = t[1]
        elif name == "TITLE":
            data["organisation"]["position"] = wert
        elif name == "ROLE":
            data["organisation"]["rolle"] = wert
        elif name == "BDAY":
            data["daten"]["geburtstag"] = wert
        elif name == "ANNIVERSARY":
            data["daten"]["jahrestag"] = wert
        elif name == "NOTE":
            data["notizen"] = (data["notizen"] + "\n" + wert).strip() if data["notizen"] else wert
        elif name == "CATEGORIES":
            data["kategorien"] += [c.strip() for c in re.split(r"(?<!\\),", roh) if c.strip()]
        elif name == "URL":
            if wert:
                data["webseiten"].append({"url": wert, "label": _label(params)})
        elif name == "RELATED":
            if wert:
                data["beziehungen"].append({"art": _label(params) or "verwandt", "freitext": wert})
        elif name in ("IMPP", "X-SOCIALPROFILE"):
            dienst = (params.get("X-SERVICE-TYPE") or params.get("TYPE") or "").lower()
            w = wert
            if not dienst and "://" in w:
                dienst = w.split("://", 1)[0].lower()
            if not dienst:
                dienst = "unbekannt"
            if w:
                handles.append({"service": dienst, "handle": w,
                                "klasse": _klasse_von(dienst)})
        elif name == "PHOTO":
            foto = _foto_lesen(params, roh)
        elif name not in _BEKANNT:
            # Do not throw away. That is exactly what distinguishes a superset
            # from yet another lossy format.
            data["frei"].setdefault(name, []).append(wert)

    if not data["namen"].get("anzeigename"):
        zus = " ".join(x for x in (data["namen"].get("vorname"), data["namen"].get("nachname")) if x)
        if zus:
            data["namen"]["anzeigename"] = zus

    return _aufraeumen(data), handles, foto, uid


def _foto_lesen(params: dict[str, str], roh: str) -> tuple[bytes, str] | None:
    """PHOTO comes in three shapes: data URI (vCard 4), BASE64 parameter
    (vCard 3) or a reference URL. Only the first two carry bytes."""
    mime = "image/jpeg"
    if roh.startswith("data:"):
        try:
            kopf, b64 = roh.split(",", 1)
            mime = kopf[5:].split(";")[0] or mime
            return base64.b64decode(b64), mime
        except Exception:
            return None
    kodierung = (params.get("ENCODING") or "").upper()
    if kodierung in ("B", "BASE64"):
        typ = (params.get("TYPE") or "").lower()
        if typ and "/" not in typ:
            mime = f"image/{typ}"
        try:
            return base64.b64decode(roh), mime
        except Exception:
            return None
    return None          # URL reference: the image lives elsewhere, we do not fetch it


def _aufraeumen(data: dict[str, Any]) -> dict[str, Any]:
    """Drop empty containers — otherwise two contacts with identical content
    differ in their hash, and the import creates revisions without changes."""
    out = {}
    for k, v in data.items():
        if v in ({}, [], "", None):
            continue
        out[k] = v
    return out


# ── Out: the projection ─────────────────────────────────────────────────────

def schreiben(data: dict[str, Any], *, uid: str | None = None,
              handles: list[dict] | None = None,
              foto: tuple[bytes, str] | None = None) -> str:
    """ClaraOS contact -> vCard 3.0.

    Why 3.0 and not 4.0: Android (also via DAVx5), Google Contacts and the
    Nextcloud Contacts app understand 3.0 reliably; 4.0 is still read
    incompletely in places. For a PROJECTION what matters is what arrives, not
    what is newest.
    """
    n = data.get("namen") or {}
    org = data.get("organisation") or {}
    z: list[str] = ["BEGIN:VCARD", "VERSION:3.0", f"UID:{uid or uuid.uuid4()}"]

    anzeige = n.get("anzeigename") or " ".join(
        x for x in (n.get("vorname"), n.get("nachname")) if x) or "(ohne Namen)"
    z.append(f"FN:{_mask(anzeige)}")
    z.append("N:" + ";".join(_mask(n.get(k, "")) for k in
                             ("nachname", "vorname", "mittelname", "praefix", "suffix")))
    if n.get("spitzname"):
        z.append(f"NICKNAME:{_mask(n['spitzname'])}")

    for m in (data.get("mails") or []):
        typ = m.get("label") or "INTERNET"
        z.append(f"EMAIL;TYPE={typ.upper()}{';TYPE=PREF' if m.get('pref') else ''}:{_mask(m['wert'])}")
    for t in (data.get("telefone") or []):
        typ = (t.get("label") or "voice").upper()
        z.append(f"TEL;TYPE={typ}{';TYPE=PREF' if t.get('pref') else ''}:{_mask(t['wert'])}")
    for a in (data.get("adressen") or []):
        z.append("ADR;TYPE={}:;;{};{};{};{};{}".format(
            (a.get("label") or "home").upper(),
            _mask(a.get("strasse", "")), _mask(a.get("ort", "")), _mask(a.get("region", "")),
            _mask(a.get("plz", "")), _mask(a.get("land", ""))))
    if org.get("firma") or org.get("abteilung"):
        z.append(f"ORG:{_mask(org.get('firma', ''))};{_mask(org.get('abteilung', ''))}")
    if org.get("position"):
        z.append(f"TITLE:{_mask(org['position'])}")
    if org.get("rolle"):
        z.append(f"ROLE:{_mask(org['rolle'])}")
    d = data.get("daten") or {}
    if d.get("geburtstag"):
        z.append(f"BDAY:{d['geburtstag']}")
    if d.get("jahrestag"):
        z.append(f"ANNIVERSARY:{d['jahrestag']}")
    for w in (data.get("webseiten") or []):
        z.append(f"URL:{_mask(w['url'])}")
    if data.get("kategorien"):
        z.append("CATEGORIES:" + ",".join(_mask(k) for k in data["kategorien"]))
    if data.get("notizen"):
        z.append(f"NOTE:{_mask(data['notizen'])}")

    # Handles are exported as IMPP/X-SOCIALPROFILE — both are indexed in
    # Nextcloud and editable in the Contacts app. So a LinkedIn or Mastodon
    # handle also shows up on the phone, not only in ClaraOS.
    for h in (handles or []):
        dienst = str(h.get("service", "")).lower()
        wert = _mask(str(h.get("handle", "")))
        if dienst in ("matrix", "xmpp", "sip"):
            z.append(f"IMPP;X-SERVICE-TYPE={dienst}:{wert}")
        else:
            z.append(f"X-SOCIALPROFILE;TYPE={dienst}:{wert}")

    if foto:
        roh, mime = foto
        typ = mime.split("/")[-1].upper()
        z.append(_falten(f"PHOTO;ENCODING=b;TYPE={typ}:" + base64.b64encode(roh).decode()))

    z.append("END:VCARD")
    return "\r\n".join(z) + "\r\n"


def _falten(zeile: str, breite: int = 73) -> str:
    """Lines over 75 octets must be folded (RFC 6350 §3.2).
    In practice this only affects PHOTO — but unfolded, some readers reject the
    whole card, not just the image."""
    if len(zeile) <= breite:
        return zeile
    stuecke = [zeile[:breite]]
    rest = zeile[breite:]
    while rest:
        stuecke.append(" " + rest[:breite - 1])
        rest = rest[breite - 1:]
    return "\r\n".join(stuecke)


def datei_schreiben(kontakte: list[tuple[dict, str, list[dict]]]) -> str:
    """Several contacts into one .vcf — the backup and migration path."""
    return "".join(schreiben(d, uid=u, handles=h) for d, u, h in kontakte)
