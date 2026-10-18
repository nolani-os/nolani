"""Domain registry (generated). See domains.yaml."""
# GENERATED — DO NOT EDIT BY HAND.
# Source: domains.yaml · regenerate with scripts/domains/gen.py

import os

BASE_DOMAIN = os.environ.get("CLARAOS_BASE_DOMAIN", "example.com")
LEGACY_DOMAIN = os.environ.get("CLARAOS_LEGACY_DOMAIN", "")

# Matrix server_name is an identity, not an address: it is part of every
# MXID and room ID, and Matrix has no rename. Source: domains.yaml/pinned.
# Override via environment only for a standalone instance (a cell) with its
# own homeserver — never change it on an existing installation.
MATRIX_SERVER_NAME = os.environ.get("CLARAOS_MATRIX_SERVER_NAME", "example.com")

# Federation domain of THIS instance = its own base domain. A federating
# partner uses ITS base domain (per-partner field), so never hardcode it.
# Used to build the public Authentik URL (auth.<domain>) for issuer and
# callback. Can be overridden via environment; default = base domain.
FEDERATION_BASE_DOMAIN = os.environ.get("CLARAOS_FEDERATION_BASE_DOMAIN", BASE_DOMAIN)

# Apps with a virtual host under the base domain
APP_HOSTS = {
    "admin-view": "admin-view",
    "authentik": "auth",
    "claraos": "home",
    "collabora": "collabora",
    "element": "element",
    "element-call": "call",
    "jmap": "jmap",
    "litellm": "litellm",
    "matrix": "matrix",
    "nextcloud": "nextcloud",
    "ntfy": "push",
    "openwebui": "chat",
    "vaultwarden": "vault",
    "vikunja": "planner",
}

# Apps without a virtual host under the base domain yet — they still point
# to the legacy domain. Once the host exists, move the entry from 'pending'
# to 'apps' in domains.yaml and regenerate.
PENDING_HOSTS = {
}


def host(app: str) -> str:
    """Fully qualified host name of an app."""
    if app in APP_HOSTS:
        return f"{APP_HOSTS[app]}.{BASE_DOMAIN}"
    if app in PENDING_HOSTS:
        return f"{PENDING_HOSTS[app]}.{LEGACY_DOMAIN}"
    raise KeyError(f"Unknown app {app!r} — add it to domains.yaml")


def url(app: str, path: str = "") -> str:
    """https URL of an app, optionally with a path."""
    return f"https://{host(app)}{path}"


def shell_url(path: str = "") -> str:
    """URL of the ClaraOS shell itself."""
    return f"https://home.{BASE_DOMAIN}{path}"

