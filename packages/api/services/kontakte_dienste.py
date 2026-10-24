"""Which services a contact has — and what ClaraOS can really do there.

Important: **the class follows the service, not a whim.** It promises the
user what ClaraOS can actually deliver:

  * `foederiert` (federated) — ClaraOS can really do something there (write,
    share, follow). Matrix, Nextcloud, Mastodon, PeerTube, XMPP, SIP.
  * `bridge`     — reachable only via a Matrix bridge. As long as no bridge is
    running, it behaves like a reference.
  * `verweis` (reference) — we store the handle and open the profile. These
    services allow nothing more: LinkedIn has no messaging API, X is
    practically paid-only, Facebook only via a bridge with a risk of being
    banned.

Therefore the class must **not** come from the caller. If it came from the
client, someone could declare LinkedIn as "federated" — and the contact card
would promise a capability that does not exist. That is exactly the lie this
whole design is meant to avoid. The server derives it here, from a table, and
ignores whatever the client claims.

This file is the ONLY source of truth about services. `vcard.py` asks it when
parsing, the router when writing, the UI for its selection list.
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
import re

FOEDERIERT = "foederiert"
BRIDGE = "bridge"
VERWEIS = "verweis"

# id -> (display name, class, placeholder, hint)
DIENSTE: dict[str, tuple[str, str, str, str]] = {
    "matrix":    ("Matrix", FOEDERIERT, "@name:example.org",
                  f"Nachrichten direkt aus {PRODUCT_NAME} möglich."),
    "nextcloud": ("Nextcloud", FOEDERIERT, "name@nextcloud.example.com",
                  "Ordner und Dateien teilen (föderiertes Teilen)."),
    # Talk is a channel of its own, not a side effect of the Nextcloud account:
    # `nextcloud` is for sharing files, `nctalk` for chatting and calling.
    # Kept separate so the UI does not confuse sharing with chat.
    "nctalk":    ("Nextcloud Talk", FOEDERIERT, "name",
                  f"Chat und Anruf direkt aus {PRODUCT_NAME}."),
    "mastodon":  ("Mastodon", FOEDERIERT, "@name@mastodon.example.com",
                  "Folgen und erwähnen über ActivityPub."),
    "peertube":  ("PeerTube", FOEDERIERT, "@name@peertube.example.com",
                  "Kanal folgen über ActivityPub."),
    "xmpp":      ("XMPP", FOEDERIERT, "name@server", ""),
    "sip":       ("SIP", FOEDERIERT, "name@server", ""),

    "whatsapp":  ("WhatsApp", BRIDGE, "+49 171 1234567",
                  "Nur über eine Matrix-Brücke, falls eingerichtet."),
    "signal":    ("Signal", BRIDGE, "+49 171 1234567",
                  "Nur über eine Matrix-Brücke, falls eingerichtet."),
    "telegram":  ("Telegram", BRIDGE, "@name",
                  "Nur über eine Matrix-Brücke, falls eingerichtet."),

    "linkedin":  ("LinkedIn", VERWEIS, "vorname-nachname",
                  "Nur Profil öffnen — LinkedIn hat keine Nachrichten-Schnittstelle."),
    "x":         ("X (Twitter)", VERWEIS, "@name",
                  "Nur Profil öffnen — die Schnittstelle ist praktisch nur noch "
                  "kostenpflichtig nutzbar."),
    "facebook":  ("Facebook", VERWEIS, "name oder Profil-URL", "Nur Profil öffnen."),
    "instagram": ("Instagram", VERWEIS, "name", "Nur Profil öffnen."),
    "github":    ("GitHub", VERWEIS, "name", "Nur Profil öffnen."),
    "xing":      ("Xing", VERWEIS, "Vorname_Nachname", "Nur Profil öffnen."),
    "threema":   ("Threema", VERWEIS, "ABCD1234", "Nur die Kennung merken."),
    "skype":     ("Skype", VERWEIS, "name", "Nur die Kennung merken."),
    "website":   ("Webseite", VERWEIS, "https://…", ""),
    "sonstiges": ("Sonstiges", VERWEIS, "Kennung oder Adresse", ""),
}


def klasse_von(service: str) -> str:
    """The only place where a class is determined.

    Unknown services are a **reference** — never federated. Whoever enters
    something new gets the cautious promise, not the generous one.
    """
    return DIENSTE.get((service or "").strip().lower(), ("", VERWEIS, "", ""))[1]


def bekannt(service: str) -> bool:
    return (service or "").strip().lower() in DIENSTE


def katalog() -> list[dict[str, str]]:
    """For the selection list in the UI — sorted: what really works comes first."""
    rang = {FOEDERIERT: 0, BRIDGE: 1, VERWEIS: 2}
    out = [{"id": k, "label": v[0], "klasse": v[1], "platzhalter": v[2], "hinweis": v[3]}
           for k, v in DIENSTE.items()]
    out.sort(key=lambda d: (rang[d["klasse"]], d["label"].lower()))
    return out


def normalisieren(service: str, handle: str) -> str:
    """Gently tidy up what people actually type.

    Deliberately only tidy, never reject. Whoever enters a handle copied it
    from somewhere; rejecting input because it does not match the expected
    form loses real data over a formality. When in doubt: keep it unchanged.
    """
    s = (service or "").strip().lower()
    w = (handle or "").strip()
    if not w:
        return w
    # Full URLs stay as they are — they are unambiguous.
    if re.match(r"^https?://", w, re.I):
        return w
    if s == "matrix" and not w.startswith("@") and ":" in w:
        return "@" + w
    if s == "mastodon" and not w.startswith("@") and w.count("@") == 1:
        return "@" + w
    if s in ("x", "telegram", "instagram") and w.startswith("@"):
        # Stored without @ — the profile URL adds it back itself.
        return w[1:]
    if s in ("whatsapp", "signal"):
        # Numbers without decoration, but with a leading + if present
        plus = w.strip().startswith("+")
        ziffern = re.sub(r"\D", "", w)
        return ("+" if plus else "") + ziffern
    return w
