"""Seed data for all ClaraOS apps. Single source of truth for builtin app manifests."""

from domains_generated import BASE_DOMAIN as _DOMAIN  # cell: CLARAOS_BASE_DOMAIN

# fmt: off

# Reusable credential slot templates
_CREDS_USER_PASS = [
    {"key": "username", "label": "Username", "type": "text", "required": True},
    {"key": "password", "label": "Password", "type": "password", "required": True},
]
BUILTIN_APPS: list[dict] = [
    # ──────────────────────────────────────────
    # INTERNAL APPS (native React components, no credentials)
    # ──────────────────────────────────────────
    {
        "id": "teams-workspace", "name": "Teams", "icon": "\U0001f465",
        "description": "Unified collaboration hub — chat, calls, files, and planning",
        "type": "internal", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": True,
        "window": {"defaultWidth": 1100, "defaultHeight": 700, "minWidth": 800, "minHeight": 500, "maximizable": True},
        "permissions": [],
    },
    {
        "id": "settings", "name": "Einstellungen", "icon": "\u2699\ufe0f",
        "description": "Systemeinstellungen und Personalisierung",
        "type": "internal", "category": "system", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 1040, "defaultHeight": 720, "minWidth": 880, "minHeight": 560},
        "permissions": [],
    },
    {
        "id": "user-admin", "name": "Benutzer", "icon": "\U0001f465",
        "description": "Benutzer- und Dienstkonten verwalten und in fremder Ansicht arbeiten",
        "type": "internal", "category": "system", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 1200, "defaultHeight": 800, "minWidth": 700, "minHeight": 500},
        "permissions": ["impersonate:users"], "requiredGroups": ["clara-admins"],
    },
    {
        "id": "task-manager", "name": "Task-Manager", "icon": "\U0001f4ca",
        "description": "Open windows + active widgets, end-task action",
        "type": "internal", "category": "system", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 720, "defaultHeight": 520, "minWidth": 480, "minHeight": 360},
        "permissions": [],
    },
    {
        # Clara Planner — native planning environment;
        # backend = Vikunja via the BFF routers/planner.py
        "id": "planner", "name": "Planner", "icon": "\U0001f5c2️",
        "description": "Aufgaben, Kanban und Projekte — Mein Tag, Checklisten, Abhängigkeiten (MS-Planner-Stil)",
        "type": "internal", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 1150, "defaultHeight": 740, "minWidth": 760, "minHeight": 480, "maximizable": True},
        "permissions": [],
    },
    {
        # Important: "Idea Suite" and "Knowledge Suite" became ONE app
        # ("Wissen"/knowledge). This entry stays because deep links depend on it
        # (`?app=ideas`, ntfy notifications, Clara replies, bookmarks) — it opens
        # the same app in its "strategy" section. It no longer appears in the
        # start menu, otherwise there would be two tiles for one program.
        "id": "ideas", "name": "Wissen — Strategie", "icon": "🎯",
        "description": "Ziele, Visionen, Kennzahlen und Ideen — der Strategie-Bereich der App Wissen.",
        "type": "internal", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": False, "pinned": False,
        "window": {"defaultWidth": 1150, "defaultHeight": 740, "minWidth": 720, "minHeight": 480, "maximizable": True},
        "permissions": [],
    },
    {
        # Knowledge ("Wissen"): collections, notes, search, graph AND the
        # strategy layer (goals, visions, KPIs, ideas) in one app.
        # Previously two tiles with the same backend and the same database.
        "id": "knowledge", "name": "Wissen", "icon": "📚",
        "description": "Sammlungen, Notizen, Ziele und Kennzahlen — die Wissens- und Strategie-App der Familie.",
        "type": "internal", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 1150, "defaultHeight": 740, "minWidth": 760, "minHeight": 480, "maximizable": True},
        "permissions": [],
    },
    {
        "id": "files", "name": "Dateien", "icon": "\ud83d\udcc1",
        "description": "Dateien und Objekte durchsehen",
        "type": "internal", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": True,
        "window": {"defaultWidth": 960, "defaultHeight": 620, "minWidth": 400, "minHeight": 300},
        "permissions": ["fs:/workspace:read"],
    },
    {
        "id": "text-editor", "name": "Texteditor", "icon": "\ud83d\udcdd",
        "description": "Text- und Code-Editor mit Syntaxhervorhebung",
        "type": "internal", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 800, "defaultHeight": 600, "minWidth": 400, "minHeight": 300},
        "permissions": ["fs:/workspace:read", "fs:/workspace:write"],
    },
    {
        "id": "pdf-viewer", "name": "PDF", "icon": "\ud83d\udcd5",
        "description": "PDF-Dokumente ansehen",
        "type": "internal", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 800, "defaultHeight": 600, "minWidth": 400, "minHeight": 300},
        "permissions": [],
    },
    {
        "id": "office-viewer", "name": "Office", "icon": "\ud83d\udcc4",
        "description": "Word-, Excel- und PowerPoint-Dokumente bearbeiten (Collabora)",
        "type": "internal", "category": "productivity", "source": "builtin",
        # Internal document editor (fileTypeRouter routes doc/docx/xls/... here).
        # Stays as an engine, but NOT as its own start menu tile — otherwise
        # there would be a duplicate "Office" tile next to the removed iframe tile
        # nextcloud-office. Opening goes through the files app/Clara/Writer/Calc/Impress.
        "activated": True, "showInStartMenu": False, "pinned": False,
        "window": {"defaultWidth": 1150, "defaultHeight": 780, "minWidth": 640, "minHeight": 420},
        "permissions": [],
    },
    {
        "id": "image-viewer", "name": "Bildbetrachter", "icon": "\ud83d\uddbc\ufe0f",
        "description": "Bilder ansehen, zoomen und verschieben",
        "type": "internal", "category": "media", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 800, "defaultHeight": 600, "minWidth": 300, "minHeight": 200},
        "permissions": [],
    },
    {
        "id": "video-player", "name": "Videoplayer", "icon": "\u25b6\ufe0f",
        "description": "Videodateien abspielen",
        "type": "internal", "category": "media", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 854, "defaultHeight": 530, "minWidth": 400, "minHeight": 300},
        "permissions": [],
    },
    {
        "id": "immich", "name": "Immich", "icon": "\ud83d\udcf8",
        "description": "Photo & Video Management with AI",
        "type": "iframe", "category": "media", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "config": {"url": f"https://immich.{_DOMAIN}", "authMethod": "sso", "forceFreshAuth": True, "logoutPath": "/auth/logout"},
        "window": {"defaultWidth": 1000, "defaultHeight": 700, "minWidth": 600, "minHeight": 400},
        "permissions": [],
    },
    {
        "id": "paperless", "name": "Paperless", "icon": "\ud83d\udcc4",
        "description": "Document Management with OCR",
        "type": "iframe", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "config": {"url": f"https://paperless.{_DOMAIN}", "credentials": _CREDS_USER_PASS, "authMethod": "paperless", "forceFreshAuth": True, "logoutPath": "/accounts/logout/"},
        "window": {"defaultWidth": 900, "defaultHeight": 650, "minWidth": 500, "minHeight": 400},
        "permissions": [],
    },
    {
        "id": "mastodon", "name": "Mastodon", "icon": "\ud83d\udc18",
        "description": "Fediverse Social Media",
        "type": "iframe", "category": "communication", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        # Tile points directly at the OIDC init -> auto-redirect to Authentik
        # (existing session = no consent) -> signed in to Mastodon.
        # forceFreshAuth=false because iframe bootstrap destroys session cookies.
        "config": {"url": f"https://mastodon.{_DOMAIN}/sso-go", "authMethod": "sso", "forceFreshAuth": False, "logoutPath": "/auth/sign_out"},
        "window": {"defaultWidth": 900, "defaultHeight": 700, "minWidth": 500, "minHeight": 400},
        "permissions": [],
    },
    {
        "id": "element", "name": "Element", "icon": "\ud83d\udcac",
        "description": "Matrix Chat Client",
        "type": "iframe", "category": "communication", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "config": {"url": f"https://element.{_DOMAIN}", "credentials": _CREDS_USER_PASS, "authMethod": "matrix", "forceFreshAuth": False, "logoutPath": "/logout"},
        "window": {"defaultWidth": 900, "defaultHeight": 650, "minWidth": 500, "minHeight": 400},
        "permissions": [],
    },
    {
        "id": "peertube", "name": "PeerTube", "icon": "\ud83d\udcf9",
        "description": "Federated Video Publishing",
        "type": "iframe", "category": "media", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        # /login -> the user clicks the "Authentik" button of the OIDC plugin
        # (one click, by design). A version-specific plugin tile URL is fragile
        # (1.0.3 -> 1.0.4 etc.).
        # forceFreshAuth=false (with true, iframe bootstrap deleted session
        # cookies + logged out). Tile URL `/` shows the public browse UI; user
        # login via the "Login" button -> OIDC plugin (one click, by design —
        # PeerTube has no REMOTE_USER auto-login).
        "config": {"url": f"https://peertube.{_DOMAIN}/sso-go", "authMethod": "sso", "forceFreshAuth": False, "logoutPath": "/logout"},
        "window": {"defaultWidth": 1000, "defaultHeight": 700, "minWidth": 600, "minHeight": 400},
        "permissions": [],
    },
    {
        "id": "vaultwarden", "name": "Bitwarden", "icon": "\ud83d\udd11",
        "description": "Password Manager \u2014 install Bitwarden Browser-Extension for Auto-Fill",
        "type": "iframe", "category": "system", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        # NO zero-click by design — Vaultwarden is zero-knowledge end-to-end
        # encrypted; SSO only authenticates, the master password remains the
        # decryption key. SSO_PKCE=true => the authorize URL is built
        # client-side, so no static redirect URL is possible.
        # Direct URL + "Remember email" is the best pragmatic option.
        "config": {"url": f"https://vault.{_DOMAIN}", "authMethod": "sso", "forceFreshAuth": False, "logoutPath": "/identity/connect/endsession"},
        "window": {"defaultWidth": 900, "defaultHeight": 650, "minWidth": 500, "minHeight": 400},
        "permissions": [],
    },
    {
        # Contacts. ClaraOS is the source of truth; vCard/Google/Outlook are
        # projections. No requiredGroups: every user has THEIR OWN address book,
        # separated by RLS with a dedicated role (migration 033).
        # Tile name ONE short word (labels get ~67.5 px on a 360 px screen).
        "id": "kontakte", "name": "Kontakte", "icon": "\U0001f4c7",
        "description": "Dein Adressbuch — mit Verlauf, Papierkorb und vCard-Import",
        "type": "internal", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 940, "defaultHeight": 660, "minWidth": 360, "minHeight": 400, "maximizable": True},
        "permissions": [],
    },
    {
        # Native mail client of the shell.
        # Reads through the API's JMAP proxy; composing/rules may still happen
        # in the webmail app (bulwark-mail). Tile name ONE short word.
        "id": "post", "name": "Post", "icon": "\U0001f4ec",
        "description": "Deine E-Mails — lesen, sortieren, in Aufgabe/Termin/Notiz verwandeln",
        "type": "internal", "category": "communication", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 1180, "defaultHeight": 720, "minWidth": 360, "minHeight": 420, "maximizable": True},
        "permissions": [],
    },
    {
        "id": "services-hub", "name": "Dienste", "icon": "\U0001f9e9",
        "description": "Externe Dienste (Amazon & Co.) — Portal mit Auto-Login im Clara Browser",
        "type": "internal", "category": "services", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 1000, "defaultHeight": 700, "minWidth": 600, "minHeight": 440, "maximizable": True},
        "permissions": [],
    },

    # ──────────────────────────────────────────
    # IFRAME APPS – Remote desktops / browsers (no login)
    # ──────────────────────────────────────────
    {
        "id": "selkies-browser", "name": "Selkies Browser", "icon": "\ud83c\udf0a",
        "description": "Remote Desktop Browser (WebRTC/GStreamer)",
        # type "selkies", no fixed address: SelkiesApp asks /apps/selkies/status for
        # THIS user's browser and picks the twin for the device — the phone gets
        # the mobile twin (phone resolution, touch, pinch zoom). As a plain iframe
        # on the desktop host, the phone showed the desktop browser.
        "type": "selkies", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "config": {},
        "window": {"defaultWidth": 1100, "defaultHeight": 700, "minWidth": 600, "minHeight": 400},
        "permissions": [], "requiredGroups": ["clara-admins"],
    },
]

# fmt: on

# Installation-specific tiles can live in the optional module app_seeds_heim.py —
# if it is missing, those tiles do not exist. `HEIM_REIHENFOLGE` is the installation's tile order; tiles it
# does not name keep their place after the named ones.
try:
    from app_seeds_heim import HEIM_APPS as _HEIM_APPS  # noqa: E402
    from app_seeds_heim import HEIM_KACHELN as _HEIM_KACHELN  # noqa: E402
    from app_seeds_heim import HEIM_REIHENFOLGE as _HEIM_REIHENFOLGE  # noqa: E402
except ImportError:
    _HEIM_APPS, _HEIM_KACHELN, _HEIM_REIHENFOLGE = [], [], ()


def _ordered(apps: list[dict], order: tuple[str, ...]) -> list[dict]:
    """`apps` in the given id order; ids the order does not name follow in list order."""
    by_id = {a["id"]: a for a in apps}
    named = [by_id[i] for i in order if i in by_id]
    return named + [a for a in apps if a["id"] not in set(order)]


BUILTIN_APPS = _ordered(BUILTIN_APPS + _HEIM_KACHELN, _HEIM_REIHENFOLGE) + _HEIM_APPS

# External cell: only the tiles on the allowlist betriebsprofil.CELL_APPS. Tile
# URLs are already built on the cell's own domain (`_DOMAIN`), so nothing needs
# rewriting. Unchanged at home.
from betriebsprofil import IS_CELL as _IS_CELL  # noqa: E402

if _IS_CELL:
    from betriebsprofil import zellen_apps as _zellen_apps  # noqa: E402

    BUILTIN_APPS = _zellen_apps(BUILTIN_APPS, _DOMAIN, home_domain=_DOMAIN)
