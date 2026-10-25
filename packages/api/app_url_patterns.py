"""URL pattern registry for Clara chat deep-link navigation.

Maps `(app_id, pattern_key, params)` -> relative app path. The base origin
(scheme+host) comes from the app registry (`app_seeds.BUILTIN_APPS`) at runtime,
NOT from here — this module only knows the path structure of each app.

Deliberately a Python dict instead of YAML: no new dependency (PyYAML is not in
requirements.txt), importable, no file parsing at runtime. Patterns are very
stable (not versioned per app release).

Placeholders in `{...}` are filled from `params` and URL-encoded.

Installation-specific apps can add their patterns from the optional module
`app_url_patterns_heim`.
"""
from __future__ import annotations

from urllib.parse import quote

# app_id → { pattern_key: path_template }
URL_PATTERNS: dict[str, dict[str, str]] = {
    "paperless": {
        "document": "/documents/{id}/details",
        "search": "/documents?query={query}",
    },
    "immich": {  # verified against Immich 2.7.5 (SvelteKit path routing)
        "photo": "/photos/{id}",          # asset viewer (path segment, NOT ?at=)
        "album": "/albums/{id}",
        "people": "/people",
        "person": "/people/{id}",        # person detail (Clara asked for this key repeatedly)
        # Search descoped: Immich's search route expects ?query= as URL-encoded JSON
        # ({"query":"..."}); plain text throws in JSON.parse -> broken page. Deferred.
    },
    "peertube": {  # verified against PeerTube 7.3.0 (Angular history routing)
        "video": "/w/{uuid}",             # uuid/shortUUID/id — all work
        "search": "/search?search={query}",   # ?search= (NOT ?q=)
        "channel": "/c/{handle}",         # handle = channel name (slug), not displayName
        "account": "/a/{handle}",
        "playlist": "/w/p/{playlistId}",
    },
    # Rule: removing an app => remove its patterns here as well, otherwise the
    # drift check reports "no origin in the app registry" on every restart.
    "mastodon": {  # verified against Mastodon 4.5.9 (history routing, no hash)
        # acct = @user (local/remote); status detail needs acct + status id.
        "status": "/@{acct}/{id}",
        "profile": "/@{acct}",
        "search": "/search?q={query}",          # q param (NOT ?search=)
    },
    # ── Internal apps ────────────────────────────────────────────────────────
    # No iframe: the "path" is NOT loaded as a URL but parsed by the native
    # app's navigator (PlannerApp registers itself in the iframeNavigator
    # registry; actions.py/navigate broadcasts the relative path for internal
    # apps instead of origin+path).
    "ideas": {  # native "Idea Suite" — IdeasApp registers iframeNavigator
        "object": "/object/{object_id}",  # object detail (idea/vision/note, UUID)
        "board": "/board",                # idea board by maturity
        "list": "/list",
    },
    "knowledge": {  # native "Knowledge Suite" (split from "Ideas") — KnowledgeApp registers iframeNavigator
        "object": "/object/{object_id}",              # object detail (note/research/..., UUID)
        "collections": "/collections",                # collections overview (default view)
        "collection": "/collection/{collection_id}",  # a single collection (table/gallery/board)
        "list": "/list",                              # all objects
        "notes": "/notes",
        "search": "/search",
    },
    "planner": {  # native planner app
        "task": "/task/{task_id}",                 # TaskDetail drawer
        "project": "/project/{project_id}",        # project -> kanban board
        "board": "/project/{project_id}/board",
        "gantt": "/project/{project_id}/gantt",    # Gantt with dependency arrows
        "costs": "/project/{project_id}/costs",    # cost/time transparency
        "myday": "/myday",
        "tasks": "/tasks",
        "calendar": "/calendar",
        "calendar_date": "/calendar/{date}",       # calendar on the week/day of YYYY-MM-DD
    },
}

try:
    from app_url_patterns_heim import HEIM_URL_PATTERNS  # optional module
except ImportError:
    HEIM_URL_PATTERNS = {}
URL_PATTERNS.update(HEIM_URL_PATTERNS)


class PatternError(ValueError):
    """Raised when an app/pattern is unknown or a required param is missing."""


def resolve_path(app_id: str, pattern_key: str, params: dict | None = None) -> str:
    """Resolve a relative app path from a pattern + params.

    Raises PatternError on unknown app/pattern or missing placeholder.
    Returns e.g. "/s/contacts/view/123".
    """
    params = params or {}
    app = URL_PATTERNS.get(app_id)
    if app is None:
        raise PatternError(f"no URL patterns registered for app '{app_id}'")
    template = app.get(pattern_key)
    if template is None:
        raise PatternError(
            f"unknown pattern '{pattern_key}' for app '{app_id}' "
            f"(known: {', '.join(sorted(app))})"
        )

    out = template
    # Substitute each {placeholder} present in the template.
    for key in _placeholders(template):
        if key not in params or params[key] in (None, ""):
            raise PatternError(f"missing param '{key}' for {app_id}.{pattern_key}")
        out = out.replace("{" + key + "}", quote(str(params[key]), safe=""))
    return out


def _placeholders(template: str) -> list[str]:
    """Extract {name} placeholders from a template string."""
    keys: list[str] = []
    i = 0
    while True:
        start = template.find("{", i)
        if start < 0:
            break
        end = template.find("}", start)
        if end < 0:
            break
        keys.append(template[start + 1:end])
        i = end + 1
    return keys


def known_patterns(app_id: str) -> list[str]:
    """List the pattern keys registered for an app (empty if app unknown)."""
    return sorted(URL_PATTERNS.get(app_id, {}))
