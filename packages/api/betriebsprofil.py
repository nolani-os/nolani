"""Operating profile of the API: `home` (home server, default) or `cell` (external cell).

A cell is a standalone ClaraOS instance on a rented server (e.g.
demo.example.com). There is no hypervisor, NAS, home devices, SSH machines or
VPN there — and there are users you do not know.

Important: **allowlist, not denylist.** In a cell only what is listed in
`CELL_ROUTERS` gets registered. A new router built for the home setup therefore
NEVER shows up in a cell by accident — it must be enabled deliberately.
A denylist would be a hole at the first forgotten entry.

Important: **a tile is not a permission.** The shell hides tiles, but that alone
protects nothing: the router has to be gone, otherwise the path is still callable.

At home (`CLARAOS_PROFILE` unset or `home`) this module changes nothing.
"""

from __future__ import annotations

import logging
import os
import re

logger = logging.getLogger(__name__)

PROFILE = (os.environ.get("CLARAOS_PROFILE") or "home").strip().lower()
if PROFILE not in ("home", "cell"):
    raise RuntimeError(f"CLARAOS_PROFILE={PROFILE!r} unbekannt (erlaubt: home, cell)")
IS_CELL = PROFILE == "cell"

# MCP endpoint for outside agents (services/agent_mcp.py). Off unless switched on;
# `setup.sh --mcp` sets it for a cell.
MCP_ENABLED = os.environ.get("CLARAOS_MCP", "").strip().lower() in ("1", "true", "yes", "on")

# Router modules (file name under routers/) allowed to run in a cell.
# Yardstick: the apps a cell is meant to offer plus what the shell itself needs.
CELL_ROUTERS: frozenset[str] = frozenset({
    # Shell / Desktop
    "apps", "prefs", "settings", "personalization", "widgets", "system",
    "credentials", "iframe_bootstrap", "actions", "guide",
    # Files, viewer, office
    "files_v2", "office", "wopi",
    # Downloads of the personal browser (narrow per-user key, no service token)
    "browser_ablage",
    # Routines (recurring tasks through the external brain) and the bell's notifications
    "routinen", "meldungen",
    # Clara's Paperless reading tools (read one document, newest documents)
    "paperless_lesen",
    "immich_lesen",
    "peertube_lesen",
    # Planner / calendar
    "planner", "planner_kalender", "planner_business", "nc_pim",
    # Mail
    "post", "post_business", "post_fenster", "mail", "contacts",
    # Teams
    "teams_personen", "teams_admin", "teams_admin_ui", "praesenz",
    # Knowledge
    "knowledge",
    # Vaultwarden
    "vault",
    # Clara (chat via Open WebUI + LiteLLM; tools through clara_tools when an
    # external brain is connected — see services/brain_turns.py)
    "chat_v2", "clara_tools", "jobs",
    # Users' own access keys for the MCP endpoint (services/agent_mcp.py)
    "agent_keys",
    # Cell administration (accounts, invitations)
    "user_admin",
    # Services: tiles for third-party sites (admins maintain them, everyone opens them
    # in their own browser). Vault sync stays off — a cell has no organisation vault.
    "hub",
    # Teams: /auth-proxy/element provides the Matrix token (admin mint via clara.bot).
    # The other login handlers go nowhere — their apps do not exist in a cell.
    "auth_proxy",
})

# Tiles (app_seeds.BUILTIN_APPS) a cell offers — also an allowlist.
# Office runs through the `office-viewer` (Collabora via our own WOPI host), NOT
# through the Nextcloud tiles Writer/Calc/Impress: those need the auth proxy with
# its home logins and the whole Nextcloud UI in an iframe.
CELL_APPS: frozenset[str] = frozenset({
    "teams-workspace", "settings", "user-admin", "task-manager",
    "planner", "ideas", "knowledge",
    "files", "text-editor", "pdf-viewer", "office-viewer", "image-viewer", "video-player",
    "post", "kontakte",
    "vaultwarden",
    "element",
    # Photos and documents: their own UIs as tiles, login via OIDC against the cell's
    # Authentik (deploy/cell/provision_immich.py, compose.yml).
    "immich", "paperless",
    # Personal browser (created on first use, deploy/cell/browser/ctl.py) and the
    # services portal that opens third-party sites in it.
    "selkies-browser", "services-hub",
})

# Tile config a cell overrides. At home Paperless asks for username/password (the
# auth proxy logs in with them); a cell signs in via OIDC — a password prompt there
# would ask for something that does not exist.
CELL_APP_CONFIG: dict[str, dict] = {
    "paperless": {"authMethod": "sso", "credentials": None},
    # No fixed address: the tile asks the API for the user's own browser.
    "selkies-browser": {"url": None},
}

# Top-level tile fields a cell overrides (None = remove).
# The browser is a plain iframe at home (admins only, fixed host); in a cell every
# user gets one, and `selkies` makes the shell ask /selkies/status, which wakes it.
CELL_APP_FIELDS: dict[str, dict] = {
    "selkies-browser": {"type": "selkies", "name": "Browser", "requiredGroups": None,
                        "description": "Dein eigener Browser — läuft in der Zelle, nicht auf deinem Gerät"},
    "services-hub": {"description": "Externe Dienste — öffnen sich in deinem eigenen Browser"},
}

# Tiles present in a cell only as configuration carriers — not visible.
# `element` carries `authMethod: matrix`, through which /auth-proxy/element issues the
# Teams app its Matrix token; there is no Element UI in a cell.
CELL_APPS_VERSTECKT: frozenset[str] = frozenset({"element"})

# Patterns that must never appear in a cell's configuration: private and VPN networks.
# From a hosted server they would just time out — but a cell that silently TRIES to
# reach a private network is misconfigured, and that should surface at startup, not
# with the first user. An installation can add its own patterns (e.g. internal
# container names) via `heim_werte.HEIM_MUSTER`.
_PRIVATE_NETWORK_PATTERNS = (
    r"\b192\.168\.\d+\.\d+"
    r"|\b10\.\d+\.\d+\.\d+"
    r"|\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+"
    r"|\b[\w.-]+\.home\b"
    r"|\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+"   # CGNAT 100.64/10 (Tailscale)
    r"|\.ts\.net\b"
)


def _home_patterns() -> re.Pattern:
    try:
        from heim_werte import HEIM_MUSTER  # noqa: PLC0415 — optional module
    except ImportError:
        HEIM_MUSTER = ""
    return re.compile(_PRIVATE_NETWORK_PATTERNS + (f"|{HEIM_MUSTER}" if HEIM_MUSTER else ""))


def heim_default(name: str, home_value: str | None = None, *, key: str | None = None) -> str:
    """Like `os.environ.get(name, <home value>)` — but without a silent home fallback in a cell.

    If the variable is unset, a home installation falls back to its own value; a cell
    gets an empty string: the feature is OFF instead of wrongly connected (from a hosted
    server, a home-network address would only produce timeouts, and nobody would notice
    the missing setting).

    Home values do not live in the product code. They come from the optional module
    `heim_werte`, looked up by `key` or, by
    default, by the variable name. `home_value` is still accepted for code that is not
    part of the product.
    """
    val = os.environ.get(name)
    if val is not None:
        return val
    if IS_CELL:
        return ""
    if home_value is not None:
        return home_value
    return _heim_werte().get(key or name, "")


def _heim_werte() -> dict[str, str]:
    """Values of this installation's home network (module `heim_werte`, optional)."""
    try:
        from heim_werte import HEIM  # noqa: PLC0415 — optional module
    except ImportError:
        return {}
    return HEIM


def heim_struktur(name: str, default):
    """A structured value of this installation (device lists, host maps) from
    `heim_werte`; `default` in a cell or when the module is absent."""
    if IS_CELL:
        return default
    try:
        import heim_werte  # noqa: PLC0415 — optional module
    except ImportError:
        return default
    return getattr(heim_werte, name, default)


# Owner/admin account of this installation: protected from deletion, used as the
# fallback identity for service calls, never removed from rooms by the sync.
# From CLARAOS_OWNER_USER; at home the installation's value from heim_werte;
# otherwise "admin".
OWNER_USER: str = (
    os.environ.get("CLARAOS_OWNER_USER")
    or ("" if IS_CELL else _heim_werte().get("CLARAOS_OWNER_USER", ""))
    or "admin"
)

# Names users see: the product and its assistant. Ships as NolaniOS / Nolani; an
# installation renames them via CLARAOS_PRODUCT_NAME / CLARAOS_ASSISTANT_NAME (cell
# .env), at home via heim_werte. The shell gets both from /api/claraos/me.
PRODUCT_NAME: str = (
    os.environ.get("CLARAOS_PRODUCT_NAME", "").strip()
    or ("" if IS_CELL else _heim_werte().get("CLARAOS_PRODUCT_NAME", ""))
    or "NolaniOS"
)
ASSISTANT_NAME: str = (
    os.environ.get("CLARAOS_ASSISTANT_NAME", "").strip()
    or ("" if IS_CELL else _heim_werte().get("CLARAOS_ASSISTANT_NAME", ""))
    or "Nolani"
)

# Tiles that exist ONLY in a cell (not in app_seeds — in the home profile the name
# "Routinen" may belong to another tile). Appended by zellen_apps.
CELL_EXTRA_APPS: tuple[dict, ...] = (
    {
        "id": "clara-routinen", "name": "Routinen", "icon": "\U0001f501",
        "description": f"Wiederkehrende Aufträge an {ASSISTANT_NAME} — Ergebnis kommt als Meldung",
        "type": "internal", "category": "productivity", "source": "builtin",
        "activated": True, "showInStartMenu": True, "pinned": False,
        "window": {"defaultWidth": 900, "defaultHeight": 680, "minWidth": 420, "minHeight": 400},
        "permissions": [],
    },
)


def zellen_apps(apps: list[dict], base_domain: str, home_domain: str = "example.com") -> list[dict]:
    """Tile set of a cell: only `CELL_APPS`, iframe URLs rewritten to the cell's domain.

    Never called at home (app_seeds checks IS_CELL). The original list stays
    unchanged; entries are copied.
    """
    import copy

    out = []
    for app in apps:
        if app.get("id") not in CELL_APPS:
            continue
        app = copy.deepcopy(app)
        if app.get("id") in CELL_APPS_VERSTECKT:
            # Important: start menu grid, search and mobile filter only on `activated` —
            # `showInStartMenu` alone left Element visible.
            # /auth-proxy/element reads the Matrix token server-side from this entry.
            app["showInStartMenu"] = False
            app["pinned"] = False
            app["activated"] = False
        for key, value in CELL_APP_FIELDS.get(app.get("id"), {}).items():
            if value is None:
                app.pop(key, None)
            else:
                app[key] = value
        for key, value in CELL_APP_CONFIG.get(app.get("id"), {}).items():
            if value is None:
                (app.get("config") or {}).pop(key, None)
            else:
                app.setdefault("config", {})[key] = value
        url = (app.get("config") or {}).get("url")
        if isinstance(url, str) and base_domain != home_domain:
            app["config"]["url"] = re.sub(
                r"(https?://[\w.-]*?)\b" + re.escape(home_domain) + r"\b",
                lambda m: m.group(1) + base_domain, url)
        out.append(app)
    out.extend(copy.deepcopy(list(CELL_EXTRA_APPS)))
    # Shared social cell: its tiles appear only when this cell knows where it lives.
    for app in apps:
        ziel = _SOZIAL.get(app.get("id"))
        host = os.environ.get(ziel[0], "").strip() if ziel else ""
        if host:
            app = copy.deepcopy(app)
            app["config"] = {**(app.get("config") or {}), "url": f"https://{host}{ziel[1]}",
                             "authMethod": "sso", "forceFreshAuth": False}
            out.append(app)
    return out


# Tile -> (environment variable with the host, start path). One click on
# "Mit ClaraOS anmelden" on the login page.
_SOZIAL: dict[str, tuple[str, str]] = {
    "mastodon": ("SOCIAL_DOMAIN", "/auth/sign_in"),
    # Start page: PeerTube forwards to the ClaraOS login when "Anmelden" is clicked
    # (redirectOnSingleExternalAuth) — loading /login directly shows its password form.
    "peertube": ("VIDEO_DOMAIN", "/"),
}


# Chat in a cell: Open WebUI -> LiteLLM -> cloud model, WITHOUT clara-agent and hence
# without tools. The context block from chat_v2, however, asks for tools in many
# places (`preferred actions: files_write_file ...`, `guide_update_profile`).
# A model without those tools then says "done" although nothing happened — the
# worst possible answer in a demo. So those parts are removed and an honest note
# is added instead.
_WERKZEUG_TEILE = re.compile(
    r"^(preferred actions|chat_user:|chat_session:|wrapp_instance_id:)"
    r"|claraos_action_|\bguide_[a-z_]+|meta_platform|toolgen",
    re.IGNORECASE,
)
ZELLE_CHAT_HINWEIS = (
    f"Du bist {ASSISTANT_NAME} in einer eigenständigen {PRODUCT_NAME}-Instanz. Hier hast du KEINE "
    "Werkzeuge: du kannst keine Dateien, Termine, Aufgaben oder Mails anlegen oder "
    "ändern und keine Apps steuern. Behaupte nie, etwas getan zu haben. Erkläre "
    "stattdessen kurz, wie der Nutzer es in der jeweiligen App selbst erledigt."
)


def werkzeugfreier_kontext(parts: list[str]) -> list[str]:
    """Context parts without tool instructions, plus a note that tools are missing."""
    return [p for p in parts if not _WERKZEUG_TEILE.search(p)] + [ZELLE_CHAT_HINWEIS]


# With an external brain (services/brain_turns.py) the cell HAS tools — its own
# clara-tools.d. Identity and session lines stay (the brain needs them); hints at
# tools that only exist in the home setup still go, they would send the model
# looking for tools it does not have.
_HEIM_WERKZEUG_TEILE = re.compile(
    r"^(preferred actions|wrapp_instance_id:)"
    r"|claraos_action_|\bguide_[a-z_]+|meta_platform|toolgen",
    re.IGNORECASE,
)


def gehirn_kontext(parts: list[str], turn_id: str) -> list[str]:
    """Context parts for an external brain: the turn id FIRST, home tool hints removed.

    The turn id leads the block on purpose: the brain reads the first `chat_turn:`
    of the block, and every later part may contain client-supplied text.
    """
    return [f"chat_turn: {turn_id}"] + [p for p in parts if not _HEIM_WERKZEUG_TEILE.search(p)]


def router_name(endpoint) -> str | None:
    """`routers.post` -> `post`; anything outside routers/ -> None."""
    mod = getattr(endpoint, "__module__", "") or ""
    if mod.startswith("routers."):
        return mod.split(".", 1)[1].split(".", 1)[0]
    return None


def _router_names(route) -> set[str | None]:
    """All router modules behind a route entry.

    Warning: FastAPI < 0.140 adds every route individually to `app.router.routes`;
    newer versions store an included APIRouter as ONE object (`_IncludedRouter`
    with `original_router`). Reading only `route.endpoint` sees nothing there — and
    after a FastAPI update would silently stop removing anything. Hence both
    forms, recursively.
    """
    if getattr(route, "endpoint", None) is not None:
        return {router_name(route.endpoint)}
    inner = getattr(route, "original_router", None)
    if inner is not None:
        names: set[str | None] = set()
        for r in inner.routes:
            names |= _router_names(r)
        return names
    return {None}


def active_routers(registry):
    """Router entries (module, attributes) the active profile may import.

    Home: all of them, in registry order. Cell: only modules in CELL_ROUTERS —
    home-only modules are never imported, so they may be absent.
    `prune_routes` stays as a second safety net.
    """
    if not IS_CELL:
        return list(registry)
    return [(m, a) for m, a in registry if m in CELL_ROUTERS]


def prune_routes(app) -> int:
    """In a cell, remove all routes whose router is not allowlisted.

    Runs AFTER all `include_router` calls. Routes outside routers/
    (e.g. `/api/claraos/me` in main.py, static files) stay.
    Returns the number of removed entries; 0 at home.
    """
    if not IS_CELL:
        return 0
    behalten, weg = [], set()
    for route in app.router.routes:
        fremd = {n for n in _router_names(route) if n is not None and n not in CELL_ROUTERS}
        if fremd:
            weg |= fremd
        else:
            behalten.append(route)
    entfernt = len(app.router.routes) - len(behalten)
    app.router.routes[:] = behalten
    logger.warning("[profile=cell] %d Routen aus %d Heim-Routern entfernt: %s",
                   entfernt, len(weg), ",".join(sorted(weg)))
    return entfernt


# Variables that point into a PRIVATE network on purpose: an external brain is reached
# over the provider's private network between cell and brain (never over the internet).
# Named one by one — the check stays strict for everything else.
_PRIVATE_BY_DESIGN = frozenset({"CLARAOS_BRAIN_URL"})


def home_references(environ: dict[str, str] | None = None) -> list[str]:
    """Names of environment variables whose value points into the home network (never the values)."""
    env = os.environ if environ is None else environ
    pattern = _home_patterns()
    return sorted(k for k, v in env.items()
                  if v and k not in _PRIVATE_BY_DESIGN and pattern.search(v))


def assert_cell_config() -> None:
    """Cell: refuse to start if the configuration points into the home network."""
    if not IS_CELL:
        return
    treffer = home_references()
    if treffer:
        raise RuntimeError(
            "[profile=cell] Konfiguration zeigt ins Heimnetz — Start verweigert. "
            "Betroffene Variablen: " + ", ".join(treffer))
