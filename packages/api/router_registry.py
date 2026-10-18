"""Ordered registry of the API routers.

`main.py` includes the routers in exactly this order — order matters, because an
earlier router wins when two paths overlap (e.g. `teams_admin_ui` must come before
the `/{slug}` catch-all in `teams_admin`).

Each entry is `(module, attributes)`: the module under `routers/` and the
`APIRouter` attributes to include from it.

Only the modules allowed by the active profile are imported (see
`betriebsprofil.active_routers`). A cell therefore never imports home-only code,
so that code may be absent.
"""

from __future__ import annotations

from betriebsprofil import heim_struktur

ROUTERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("apps", ("router",)),
    ("prefs", ("router",)),
    ("settings", ("router",)),
    ("software_center", ("router",)),
    ("personalization", ("router",)),
    ("files", ("router",)),
    ("bilder", ("router",)),
    ("grafik", ("router",)),
    ("system", ("router",)),
    ("chat", ("router",)),
    ("chat_v2", ("router",)),
    ("jobs", ("router",)),
    ("credentials", ("router",)),
    ("mcp", ("router",)),
    ("clara_tools", ("router",)),
    ("agent_keys", ("router",)),       # per-user keys for the MCP endpoint (Settings)
    ("modules", ("router",)),
    ("auth_proxy", ("router",)),
    ("vw_import", ("router",)),
    ("network", ("router",)),
    ("files_v2", ("router",)),
    ("browser_ablage", ("router",)),  # browser downloads -> owner's Files, narrow per-user key
    ("routinen", ("router",)),        # recurring tasks for Clara via the external brain
    ("meldungen", ("router",)),       # notifications for the shell bell (no push service)
    ("terminal", ("router",)),
    ("impersonate", ("router",)),
    ("admin_view", ("router",)),
    ("iframe_bootstrap", ("router",)),
    ("praesenz", ("router",)),
    # /teams/personen before teams_guests, so no later placeholder route catches it
    ("teams_personen", ("gespraeche_router", "router")),
    ("teams_guests", ("router",)),
    # must be before teams_admin so /ui isn't caught by /{slug}
    ("teams_admin_ui", ("router",)),
    ("teams_admin", ("router",)),
    ("routines", ("router",)),
    ("actions", ("router",)),
    ("public_share", ("router",)),     # unauthenticated share view
    ("vault", ("router",)),            # Vaultwarden organisation vault, per-user CRUD
    ("orchestrator", ("router",)),
    ("federation", ("router",)),
    ("sso_bridge", ("router",)),
    ("inbox", ("router",)),
    ("feeds", ("router",)),
    ("confirm", ("router",)),
    ("office", ("router",)),           # documents via Collabora convert-to
    ("paperless_lesen", ("router",)),  # read / newest Paperless documents (module tools)
    ("immich_lesen", ("router",)),  # cell: find photos, albums, people (Clara's Immich tools)
    ("peertube_lesen", ("router",)),  # cell: find public videos (Clara's PeerTube tools)
    ("planner_kalender", ("router",)),
    ("post", ("router",)),
    ("post_business", ("router",)),
    ("planner_business", ("router",)),
    ("post_fenster", ("router",)),
    ("wopi", ("router",)),             # own WOPI host for Collabora
    ("ntfy_proxy", ("router",)),
    ("notion", ("router",)),
    ("guide", ("router",)),
    ("app_adapters", ("router",)),
    ("nc_pim", ("router",)),           # per-user Nextcloud tasks/calendar/contacts
    ("contacts", ("router",)),         # ClaraOS-owned contacts (not Nextcloud's address book)
    ("mail", ("router",)),
    ("app_flows", ("router",)),
    ("widgets", ("router",)),
    ("containers", ("router",)),
    ("user_admin", ("router",)),
    ("onboarding_public", ("router",)),
    ("tool_health", ("router",)),
    ("planner", ("router",)),          # Vikunja backend-for-frontend
    ("knowledge", ("router",)),
    ("assistants", ("router",)),
    ("hub", ("router",)),
    ("feedback", ("router",)),
    ("devices", ("router",)),
    ("printing", ("router",)),
    # Routers of this installation that are not part of the product (heim_werte).
    *heim_struktur("HEIM_ROUTERS", ()),
)
