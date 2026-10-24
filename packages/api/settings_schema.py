"""ClaraOS settings schema registry.

Analogous to KConfigXT: every settings module declares its keys as data
(type, default, bounds, label, dependencies). Validation (router), the form
renderer (frontend, via /schema), diff badges and reset are all fed from
this single source — unlike the models.py pattern, where an undeclared field
is silently swallowed: unknown keys are a 422 here.

Deliberately WITHOUT fastapi/pydantic imports: pure Python, so the unit tests
(test_settings_schema.py) run without the API venv and the router is only a
thin layer on top.

Persistence rules (KDE model):
  - ONLY deviations from the default (deltas) are stored.
  - "Reset to default" = DELETE the row, do not write the default.
  - A PUT with the default value deletes the row as well.
"""

from __future__ import annotations

from betriebsprofil import ASSISTANT_NAME, PRODUCT_NAME
import re
from dataclasses import dataclass, field
from typing import Any

# ── Setting-Definition ────────────────────────────────────────────────────

_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")

# Role ranking for requiredRole gates (compatible with auth.GROUP_ROLE_MAP).
ROLE_RANK = {"guest": 0, "user": 1, "power-user": 2, "admin": 3}


@dataclass(frozen=True)
class SettingDef:
    key: str
    type: str  # bool | int | float | string | enum | color | json
    default: Any
    label: str
    description: str = ""
    min: float | None = None
    max: float | None = None
    choices: tuple[str, ...] = ()
    # Key in the same module that must be truthy for this setting to be active
    # (KDE extraEnabledConditions). Purely declarative — the frontend disables the
    # field, the backend still validates (a disabled field may be written).
    depends_on: str = ""
    # "guest" = any signed-in user. Personal settings are deliberately NOT tied
    # to clara-users: many accounts are only in team-* groups (the Playwright
    # test account was too) and would otherwise get an empty Settings app.
    required_role: str = "guest"

    def validate(self, value: Any) -> Any:
        """Validate a value and coerce it to the canonical type. Raises ValueError on bad input."""
        t = self.type
        if t == "bool":
            if isinstance(value, bool):
                return value
            raise ValueError(f"{self.key}: bool erwartet")
        if t == "int":
            # bool is a subclass of int — exclude it explicitly
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"{self.key}: int erwartet")
            self._check_range(value)
            return value
        if t == "float":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{self.key}: Zahl erwartet")
            self._check_range(float(value))
            return float(value)
        if t == "string":
            if not isinstance(value, str):
                raise ValueError(f"{self.key}: String erwartet")
            if self.max is not None and len(value) > int(self.max):
                raise ValueError(f"{self.key}: länger als {int(self.max)} Zeichen")
            return value
        if t == "enum":
            if value not in self.choices:
                raise ValueError(f"{self.key}: '{value}' nicht in {self.choices}")
            return value
        if t == "color":
            if not isinstance(value, str) or not _COLOR_RE.match(value):
                raise ValueError(f"{self.key}: Hex-Farbe (#rrggbb) erwartet")
            return value.lower()
        if t == "json":
            if not isinstance(value, (dict, list)):
                raise ValueError(f"{self.key}: Objekt/Liste erwartet")
            return value
        raise ValueError(f"{self.key}: unbekannter Schema-Typ '{t}'")

    def _check_range(self, value: float) -> None:
        if self.min is not None and value < self.min:
            raise ValueError(f"{self.key}: {value} < min {self.min}")
        if self.max is not None and value > self.max:
            raise ValueError(f"{self.key}: {value} > max {self.max}")


@dataclass(frozen=True)
class SettingsModule:
    id: str
    name: str
    icon: str
    category: str
    weight: int = 100
    # Search index — maintain generously (KDE lesson: ~60 keywords per module, DE+EN)
    keywords: tuple[str, ...] = ()
    settings: tuple[SettingDef, ...] = ()
    # Custom modules (about, credentials, ...) render their own React component
    # instead of the generic form renderer; component = name in the frontend registry.
    component: str = ""
    # See SettingDef.required_role — only genuine admin modules are gated.
    required_role: str = "guest"
    form_factors: tuple[str, ...] = ("desktop", "tablet", "handset")

    def setting(self, key: str) -> SettingDef | None:
        for s in self.settings:
            if s.key == key:
                return s
        return None


@dataclass(frozen=True)
class Category:
    id: str
    name: str
    icon: str
    weight: int
    parent: str = ""  # "" = root
    # Clicking the category opens this module directly (KDE "Category Owner")
    owner_module: str = ""


# ── Taxonomy ────────────────────────────────────────────────────────────

CATEGORIES: tuple[Category, ...] = (
    Category("appearance", "Erscheinungsbild", "palette", 40),
    Category("workspace", "Arbeitsfläche", "layout-dashboard", 60),
    Category("personalization", "Persönliches", "user", 65),
    Category("privacy", "Sicherheit & Privatsphäre", "shield", 70),
    Category("language-time", "Sprache & Zeit", "globe", 80),
    Category("connections", "Konten & Verbindungen", "plug", 90),
    Category("system", "System", "settings-2", 100),
)


# ── Modules ─────────────────────────────────────────────────────────────
#
# IMPORTANT: skin/theme/wallpaper deliberately stay in the legacy prefs store
# (useStateSync path) for now — two sources of truth for the same value would
# risk conflicting writes. Appearance is migrated here later, and the legacy
# fields are removed at that point.

MODULES: tuple[SettingsModule, ...] = (
    SettingsModule(
        id="appearance",
        name="Farben & Darstellung",
        icon="paintbrush",
        category="appearance",
        weight=20,
        keywords=(
            "farbe", "color", "akzent", "accent", "hell", "dunkel", "light", "dark",
            "modus", "mode", "automatisch", "auto", "nachtmodus", "night",
            "schrift", "font", "größe", "size", "skalierung", "scale", "zoom",
            "animation", "bewegung", "motion", "kontrast", "contrast", "theme",
        ),
        settings=(
            SettingDef(
                key="themeMode", type="enum", default="skin",
                choices=("skin", "light", "dark", "auto"),
                label="Hell/Dunkel:",
                description="'Skin' folgt dem gewählten Design, 'Automatisch' wechselt nach Tageszeit.",
            ),
            SettingDef(
                key="lightSkinId", type="string", default="windows11-light", max=64,
                label="Design für hell:",
                depends_on="",  # only relevant for themeMode=auto/light, but always writable
            ),
            SettingDef(
                key="darkSkinId", type="string", default="clara-glass", max=64,
                label="Design für dunkel:",
            ),
            SettingDef(
                key="sunriseHour", type="int", default=7, min=0, max=23,
                label="Hell ab (Stunde):",
                description="Gilt für den automatischen Wechsel.",
            ),
            SettingDef(
                key="sunsetHour", type="int", default=20, min=0, max=23,
                label="Dunkel ab (Stunde):",
            ),
            SettingDef(
                key="accentSource", type="enum", default="skin",
                choices=("skin", "custom"),
                label="Akzentfarbe:",
                description="'Design' nutzt die Farbe des Skins, 'Eigene' überschreibt sie.",
            ),
            SettingDef(
                key="accentColor", type="color", default="#3daee9",
                label="Eigene Akzentfarbe:",
                depends_on="",  # the UI hides it when accentSource=skin
            ),
            SettingDef(
                key="uiScale", type="int", default=100, min=80, max=150,
                label="Oberflächengröße (%):",
                description="Skaliert die gesamte Oberfläche — besser als nur die Schrift zu vergrößern.",
            ),
            SettingDef(
                key="reduceMotion", type="bool", default=False,
                label="Bewegung reduzieren",
                description="Schaltet Animationen ab — hilft auf schwachen Geräten und bei Reizempfindlichkeit.",
            ),
            SettingDef(
                key="highContrast", type="bool", default=False,
                label="Höherer Kontrast",
            ),
            # Font roles modeled on kcm_fonts, but only those that actually
            # have an effect on the web. Size is deliberately left out — that
            # is what the UI scale is for (KDE points to global scaling at the
            # same place).
            SettingDef(
                key="fontUi", type="enum", default="system",
                choices=("system", "inter", "noto-sans", "segoe", "dejavu"),
                label="Schrift der Oberfläche:",
            ),
            SettingDef(
                key="fontMono", type="enum", default="system",
                choices=("system", "cascadia", "fira-code", "jetbrains", "dejavu-mono"),
                label="Feste Breite (Terminal, Code):",
            ),
        ),
    ),
    SettingsModule(
        id="workspace-behavior",
        name="Allgemeines Verhalten",
        icon="mouse-pointer-click",
        category="workspace",
        weight=10,
        keywords=(
            "klick", "click", "doppelklick", "double-click", "öffnen", "open",
            "animation", "geschwindigkeit", "speed", "tooltip", "hinweis",
            "verhalten", "behavior", "maus", "mouse",
        ),
        settings=(
            SettingDef(
                key="clickBehavior", type="enum", default="double",
                choices=("single", "double"),
                label="Klicken auf Dateien und Ordner:",
                description="Einfacher Klick wählt aus, Doppelklick öffnet — oder einfacher Klick öffnet direkt.",
            ),
            SettingDef(
                key="animationSpeed", type="enum", default="normal",
                choices=("instant", "fast", "normal", "slow"),
                label="Animationsgeschwindigkeit:",
                description="'Sofort' schaltet Animationen ab (auch gut für schwache Geräte).",
            ),
            SettingDef(
                key="showTooltips", type="bool", default=True,
                label="Hinweise beim Überfahren anzeigen",
            ),
        ),
    ),
    SettingsModule(
        id="session",
        name="Sitzung",
        icon="log-out",
        category="system",
        weight=70,
        keywords=(
            "sitzung", "session", "abmelden", "logout", "wiederherstellen",
            "restore", "fenster", "windows", "start", "login",
        ),
        settings=(
            SettingDef(
                key="restoreWindows", type="bool", default=True,
                label="Fenster der letzten Sitzung wiederherstellen",
            ),
            SettingDef(
                key="confirmLogout", type="bool", default=False,
                label="Beim Abmelden nachfragen",
            ),
            # Apps that start on their own after login (kcm_autostart).
            # Deliberately separate from restoreWindows: one restores the last
            # session, the other applies even when nothing was open.
            SettingDef(
                key="autostartApps", type="json", default=[],
                label="Beim Anmelden öffnen",
            ),
        ),
    ),
    SettingsModule(
        id="shortcuts",
        name="Tastenkürzel",
        icon="keyboard",
        category="workspace",
        weight=30,
        keywords=(
            "taste", "tastatur", "keyboard", "kürzel", "shortcut", "hotkey",
            "belegung", "binding", "tastenkombination", "win", "meta", "strg",
        ),
        component="ShortcutsTab",
        settings=(
            # {commandId: "Meta+E"} — an empty string removes the shortcut.
            SettingDef(
                key="bindings", type="json", default={},
                label="Eigene Tastenbelegung",
            ),
        ),
    ),
    SettingsModule(
        id="notifications",
        name="Benachrichtigungen",
        icon="bell",
        category="workspace",
        weight=20,
        keywords=(
            "benachrichtigung", "notification", "meldung", "popup", "toast",
            "nicht stören", "dnd", "ruhe", "stumm", "mute", "chronik", "history",
            "dringlichkeit", "urgency", "kritisch", "critical", "badge", "zähler",
        ),
        settings=(
            # DND is deliberately a timestamp, not a toggle: the state is always
            # "until when". A plain on/off switch otherwise stays on for weeks
            # after a movie night (KDE model, kcm_notifications).
            SettingDef(
                key="dndUntil", type="int", default=0, min=0, max=4102444800000,
                label="Nicht stören bis (Zeitstempel):",
                description="Wird über die Schnelleinstellungen gesetzt — 0 heißt aus.",
            ),
            SettingDef(
                key="criticalInDnd", type="bool", default=True,
                label="Kritische Meldungen trotz „Nicht stören“ zeigen",
            ),
            SettingDef(
                key="lowPriorityPopups", type="bool", default=True,
                label="Popups auch bei geringer Dringlichkeit",
            ),
            SettingDef(
                key="lowPriorityHistory", type="bool", default=False,
                label="Geringe Dringlichkeit in der Chronik führen",
            ),
            SettingDef(
                key="popupTimeoutMs", type="int", default=5000, min=1000, max=60000,
                label="Popup-Dauer (ms):",
            ),
            # Per-app rules: {appId: {showPopups, showPopupsInDnd,
            # showInHistory, showBadges}} — the four switches from KDE.
            SettingDef(
                key="appRules", type="json", default={},
                label="Regeln je App",
                description="Pro App: Popup, Popup trotz „Nicht stören“, Chronik, Zähler.",
            ),
        ),
    ),
    SettingsModule(
        id="terminal",
        name="Terminal",
        icon="terminal",
        category="workspace",
        weight=40,
        keywords=(
            "terminal", "konsole", "shell", "bash", "kommandozeile", "cli",
            "schrift", "font", "farbschema", "colorscheme", "scrollback",
            "verlauf", "cursor", "kopieren", "einfügen", "paste",
        ),
        settings=(
            SettingDef(
                key="colorScheme", type="enum", default="catppuccin",
                choices=("catppuccin", "breeze-dark", "solarized-dark", "solarized-light", "monokai"),
                label="Farbschema:",
            ),
            SettingDef(
                key="fontSize", type="int", default=13, min=8, max=28,
                label="Schriftgröße:",
            ),
            SettingDef(
                key="scrollbackLines", type="int", default=10000, min=0, max=200000,
                label="Verlauf (Zeilen):",
                description="0 merkt sich nichts. Der Verlauf liegt serverseitig in tmux.",
            ),
            SettingDef(
                key="cursorStyle", type="enum", default="block",
                choices=("block", "bar", "underline"),
                label="Cursor:",
            ),
            SettingDef(
                key="cursorBlink", type="bool", default=True,
                label="Cursor blinkt",
            ),
            SettingDef(
                key="confirmPasteAlways", type="bool", default=False,
                label="Vor jedem Einfügen nachfragen",
                description="Sonst wird nur bei Steuerzeichen oder sehr großen Einfügungen gefragt.",
            ),
            # json data keys — the Settings UI deliberately does not render
            # json; they are maintained by the Terminal app itself.
            SettingDef(
                key="profiles", type="json", default=[],
                label="Terminal-Profile",
            ),
            SettingDef(
                key="defaultProfile", type="string", default="builtin:local",
                label="Standard-Profil:",
            ),
            SettingDef(
                key="quickCommands", type="json", default=[],
                label="Quick Commands",
            ),
        ),
    ),
    SettingsModule(
        id="files",
        name="Dateien",
        icon="folder",
        category="workspace",
        weight=45,
        keywords=(
            "dateien", "files", "dateimanager", "dolphin", "ordner", "folder",
            "ansicht", "view", "sortierung", "sort", "versteckt", "hidden",
            "tabs", "geteilte ansicht", "split", "orte", "places",
        ),
        settings=(
            # ── migrated from the legacy prefs block files_app ──
            SettingDef(
                key="viewMode", type="enum", default="icons-large",
                choices=("icons-large", "icons-small", "list", "details"),
                label="Ansicht:",
            ),
            SettingDef(
                key="sortKey", type="enum", default="name",
                choices=("name", "modified", "size", "type"),
                label="Sortieren nach:",
            ),
            SettingDef(
                key="sortDir", type="enum", default="asc",
                choices=("asc", "desc"),
                label="Reihenfolge:",
            ),
            SettingDef(
                key="dirsFirst", type="bool", default=True,
                label="Ordner zuerst",
            ),
            SettingDef(
                key="showHidden", type="bool", default=False,
                label="Versteckte Dateien anzeigen",
            ),
            SettingDef(
                key="groupBy", type="enum", default="none",
                choices=("none", "type", "date"),
                label="Gruppieren:",
            ),
            # The Settings UI deliberately does not render json fields (data keys,
            # maintained by the Files app or the default-apps module).
            SettingDef(
                key="openWithOverrides", type="json", default={},
                label="Öffnen-mit-Zuordnungen",
            ),
            # ── Tabs & split view (Dolphin dolphin_generalsettings) ──
            SettingDef(
                key="rememberOpenedTabs", type="bool", default=True,
                label="Geöffnete Tabs merken",
                description="Beim nächsten Öffnen dort weitermachen, wo du aufgehört hast.",
            ),
            SettingDef(
                key="openNewTabAfterLastTab", type="bool", default=False,
                label="Neue Tabs am Ende einreihen",
                description="Sonst öffnen neue Tabs direkt neben dem aktuellen.",
            ),
            SettingDef(
                key="alwaysShowTabBar", type="bool", default=False,
                label="Tab-Leiste immer anzeigen",
                description="Sonst erscheint sie erst ab dem zweiten Tab.",
            ),
            SettingDef(
                key="confirmClosingMultipleTabs", type="bool", default=True,
                label="Nachfragen, wenn mehrere Tabs offen sind",
            ),
            SettingDef(
                key="closeSplitViewChoice", type="enum", default="active",
                choices=("active", "inactive", "right"),
                label="Geteilte Ansicht schließt:",
                description="Welche Seite beim Beenden der geteilten Ansicht zugeht.",
            ),
            SettingDef(
                key="places", type="json", default=[],
                label="Orte-Leiste",
            ),
            SettingDef(
                key="openTabs", type="json", default=[],
                label="Offene Tabs (Sitzung)",
            ),
        ),
    ),
    SettingsModule(
        id="region-formats",
        name="Sprache & Formate",
        icon="globe",
        category="language-time",
        weight=10,
        keywords=(
            "sprache", "language", "format", "zahl", "number", "datum", "date",
            "zeit", "time", "uhrzeit", "währung", "currency", "euro",
            "wochenbeginn", "week", "region", "locale", "einheiten", "units",
            "dateigröße", "filesize", "kib", "mb",
        ),
        settings=(
            # Two axes, as in KDE: the UI language and the region format are
            # independent (English UI with German dates is allowed).
            # Choices = codes in packages/core/src/i18n/languages.ts (+ "system");
            # test_settings_schema.py fails on drift.
            SettingDef(
                key="uiLanguage", type="enum", default="system",
                choices=("system", "de", "en"),
                label="Sprache der Oberfläche:",
                description="„Wie der Browser“ folgt der Spracheinstellung des Geräts.",
            ),
            SettingDef(
                # "auto" = the browser's region — an English install should not
                # show German dates just because nobody touched this setting.
                key="locale", type="enum", default="auto",
                choices=("auto", "de-DE", "de-AT", "de-CH", "en-GB", "en-US", "fr-FR", "it-IT"),
                label="Regionsformat:",
                description="Bestimmt Zahlen, Datum und Uhrzeit — nicht die Sprache der Oberfläche.",
            ),
            SettingDef(
                key="timeFormat", type="enum", default="region",
                choices=("region", "24h", "12h"),
                label="Uhrzeit:",
            ),
            SettingDef(
                key="firstDayOfWeek", type="enum", default="region",
                choices=("region", "monday", "sunday"),
                label="Woche beginnt am:",
            ),
            SettingDef(
                key="currency", type="enum", default="EUR",
                choices=("EUR", "CHF", "USD", "GBP"),
                label="Währung:",
            ),
            SettingDef(
                key="binaryDialect", type="enum", default="iec",
                choices=("iec", "metric", "jedec"),
                label="Dateigrößen:",
                description="IEC = KiB/MiB (1024), Metrisch = kB/MB (1000), JEDEC = KB als 1024.",
            ),
        ),
    ),
    SettingsModule(
        id="default-apps",
        name="Standard-Apps & Autostart",
        icon="app-window",
        category="workspace",
        weight=50,
        component="DefaultAppsTab",
        keywords=(
            "standard", "default", "öffnen mit", "open with", "zuordnung",
            "dateityp", "filetype", "autostart", "anmelden", "login", "starten",
        ),
    ),
    SettingsModule(
        id="privacy-history",
        name="Verläufe",
        icon="history",
        category="privacy",
        weight=40,
        keywords=(
            "verlauf", "history", "zwischenablage", "clipboard", "zuletzt",
            "recent", "privatsphäre", "privacy", "löschen", "clear",
        ),
        settings=(
            SettingDef(
                key="recentAppsEnabled", type="bool", default=True,
                label="Zuletzt benutzte Apps im Startmenü führen",
            ),
            SettingDef(
                key="clipboardHistorySize", type="int", default=20, min=0, max=100,
                label="Einträge in der Zwischenablage-Chronik:",
                description="0 schaltet die Chronik (Win+V) ab.",
            ),
        ),
    ),
    # Existing settings tabs as custom modules in the new shell.
    # PersonalizationTab is to be replaced by real schema modules.
    SettingsModule(
        # Do not name it "Erscheinungsbild" — that is the category's name, and a
        # module named like its own category is indistinguishable in the menu
        # (caught in E2E, when the click hit the category title).
        id="personalization", name="Design & Hintergrund", icon="palette",
        category="appearance", weight=10, component="PersonalizationTab",
        keywords=(
            "skin", "theme", "design", "farbe", "color", "hintergrund", "wallpaper",
            "hell", "dunkel", "light", "dark", "aussehen", "appearance", "personalisieren",
        ),
    ),
    SettingsModule(
        id="credentials", name="App-Zugangsdaten", icon="key-round",
        category="connections", weight=10, component="CredentialsTab",
        keywords=("zugangsdaten", "credentials", "passwort", "password", "konto", "account"),
    ),
    SettingsModule(
        id="app-connections", name="App-Verbindungen", icon="cable",
        category="connections", weight=20, component="AppConnectionsTab",
        keywords=("verbindung", "connection", "oauth", "api"),
    ),
    SettingsModule(
        id="agent-keys", name="Agenten-Zugang", icon="key-round",
        category="connections", weight=25, component="AgentKeysTab",
        keywords=("agent", "mcp", "schlüssel", "key", "claude", "cursor", "zugang", "ki"),
    ),
    SettingsModule(
        id="mobile-push", name="Handy-Push", icon="smartphone",
        category="connections", weight=30, component="MobilePushTab",
        keywords=("push", "ntfy", "handy", "benachrichtigung", "notification", "mobil"),
    ),
    SettingsModule(
        id="federation", name="Federation", icon="network",
        category="connections", weight=40, component="FederationTab",
        required_role="admin",
        keywords=("federation", "partner", "instanz", "verbund"),
    ),
    SettingsModule(
        id="clara-memory", name=f"Was {ASSISTANT_NAME} über mich weiß", icon="shield",
        category="privacy", weight=20, component="ClaraMemoryTab",
        keywords=(ASSISTANT_NAME.lower(), "profil", "gedächtnis", "memory", "gelernt",
                  "privatsphäre", "kennenlernen", "guide"),
    ),
    SettingsModule(
        id="clara-freigaben", name=f"{ASSISTANT_NAME}-Freigaben", icon="shield",
        category="privacy", weight=30, component="FreigabenTab",
        keywords=("freigabe", "immer", "bestätigung", "regel", ASSISTANT_NAME.lower(), "strom",
                  "löschen", "erlaubnis", "confirm"),
    ),
    SettingsModule(
        id="about", name=f"Über {PRODUCT_NAME}", icon="info",
        category="system", weight=100, component="AboutTab",
        keywords=("version", "about", "über", "info", "lizenz"),
    ),
)

_MODULES_BY_ID = {m.id: m for m in MODULES}
_CATEGORIES_BY_ID = {c.id: c for c in CATEGORIES}


# ── API helpers (used by the router and the tests) ──────────────────────


def get_module(module_id: str) -> SettingsModule | None:
    return _MODULES_BY_ID.get(module_id)


def modules_for_role(role: str) -> list[SettingsModule]:
    rank = ROLE_RANK.get(role, 0)
    return [m for m in MODULES if rank >= ROLE_RANK.get(m.required_role, 0)]


def validate_payload(module: SettingsModule, payload: dict) -> tuple[dict, list[str]]:
    """Validate a payload against the module schema.

    Returns (validated values, list of unknown keys). Unknown keys are a 422 at
    the caller — NEVER swallow them silently (anti-models.py rule).
    ValueError propagates on type/range errors.
    """
    unknown = [k for k in payload if module.setting(k) is None]
    if unknown:
        return {}, unknown
    validated = {}
    for key, value in payload.items():
        sdef = module.setting(key)
        assert sdef is not None
        validated[key] = sdef.validate(value)
    return validated, []


def resolve(module: SettingsModule, deltas: dict) -> dict:
    """Effective values: defaults overlaid with the stored deltas."""
    out = {}
    for s in module.settings:
        out[s.key] = deltas.get(s.key, s.default)
    return out


def is_default(module: SettingsModule, key: str, value: Any) -> bool:
    sdef = module.setting(key)
    return sdef is not None and value == sdef.default


def schema_payload(role: str) -> dict:
    """Serializable schema for GET /settings/schema (frontend renderer)."""
    mods = modules_for_role(role)
    visible_cats = {m.category for m in mods}
    return {
        "categories": [
            {
                "id": c.id, "name": c.name, "icon": c.icon, "weight": c.weight,
                "parent": c.parent, "ownerModule": c.owner_module,
            }
            for c in sorted(CATEGORIES, key=lambda c: c.weight)
            if c.id in visible_cats
        ],
        "modules": [
            {
                "id": m.id, "name": m.name, "icon": m.icon, "category": m.category,
                "weight": m.weight, "keywords": list(m.keywords),
                "component": m.component, "formFactors": list(m.form_factors),
                "settings": [
                    {
                        "key": s.key, "type": s.type, "default": s.default,
                        "label": s.label, "description": s.description,
                        "min": s.min, "max": s.max, "choices": list(s.choices),
                        "dependsOn": s.depends_on,
                    }
                    for s in m.settings
                ],
            }
            for m in sorted(mods, key=lambda m: (m.category, m.weight))
        ],
    }


def integrity_errors() -> list[str]:
    """Registry self-check — called by the unit tests."""
    errors = []
    for m in MODULES:
        if m.category not in _CATEGORIES_BY_ID:
            errors.append(f"{m.id}: unbekannte Kategorie '{m.category}'")
        seen = set()
        for s in m.settings:
            if s.key in seen:
                errors.append(f"{m.id}.{s.key}: doppelter Key")
            seen.add(s.key)
            try:
                s.validate(s.default)
            except ValueError as e:
                errors.append(f"{m.id}.{s.key}: Default invalide ({e})")
            if s.depends_on and m.setting(s.depends_on) is None:
                errors.append(f"{m.id}.{s.key}: dependsOn '{s.depends_on}' existiert nicht")
    for c in CATEGORIES:
        if c.parent and c.parent not in _CATEGORIES_BY_ID:
            errors.append(f"Kategorie {c.id}: parent '{c.parent}' existiert nicht")
        if c.owner_module and c.owner_module not in _MODULES_BY_ID:
            errors.append(f"Kategorie {c.id}: ownerModule '{c.owner_module}' existiert nicht")
    return errors
