"""Superset in a cell — dashboards and analyses. Login ONLY via the cell's Authentik.

Values come from the environment (compose.yml); nothing secret is written here.
Lean on purpose: no Celery worker/beat (no alerts, reports or async queries) and no
results cache — one web process, about 0.5 GB.
"""
import os

from superset.security import SupersetSecurityManager

from flask_appbuilder.security.manager import AUTH_OAUTH

DOM = os.environ["ZELLE_DOMAIN"]

SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]
SQLALCHEMY_DATABASE_URI = (
    f"postgresql+psycopg2://superset:{os.environ['SUPERSET_DB_PASSWORD']}@superset-db:5432/superset"
)

# Behind the cell's Caddy (TLS ends there)
ENABLE_PROXY_FIX = True
SESSION_COOKIE_SECURE = True
PREFERRED_URL_SCHEME = "https"

# No telemetry pixel, no example data
SCARF_ANALYTICS = False
# Language: English only. The official image carries no built language packs — with
# LANGUAGES = {"de": …} the menu showed a German flag over English texts.

# Embedding only in the cell's own shell. Talisman stays on (Superset's CSP), with
# frame-ancestors added and its tracking hosts removed.
TALISMAN_ENABLED = True
TALISMAN_CONFIG = {
    "content_security_policy": {
        "base-uri": ["'self'"],
        "default-src": ["'self'"],
        "img-src": ["'self'", "blob:", "data:"],
        "worker-src": ["'self'", "blob:"],
        "connect-src": ["'self'", "https://api.mapbox.com", "https://events.mapbox.com",
                        "https://tile.openstreetmap.org", "https://a.basemaps.cartocdn.com"],
        "object-src": "'none'",
        "style-src": ["'self'", "'unsafe-inline'"],
        "font-src": ["'self'"],
        "script-src": ["'self'", "'strict-dynamic'"],
        "frame-ancestors": ["'self'", f"https://home.{DOM}"],
    },
    "content_security_policy_nonce_in": ["script-src"],
    "frame_options": None,           # frame-ancestors above decides, not X-Frame-Options
    "force_https": False,            # Caddy does that
    "session_cookie_secure": True,
}

# ── Login via Authentik (OIDC) ──────────────────────────────────────────
AUTH_TYPE = AUTH_OAUTH
OAUTH_PROVIDERS = [{
    "name": "authentik",             # Flask-AppBuilder's built-in Authentik support
    "icon": "fa-sign-in",
    "token_key": "access_token",
    "remote_app": {
        "client_id": "superset",
        "client_secret": os.environ["SUPERSET_OIDC_SECRET"],
        "server_metadata_url": f"https://auth.{DOM}/application/o/superset/.well-known/openid-configuration",
        "api_base_url": f"https://auth.{DOM}/application/o/",
        "client_kwargs": {"scope": "openid email profile"},
    },
}]
# Every account of the cell may sign in. New accounts get "Alpha" — Superset's role for
# analysts: all data sources, own charts and dashboards, no user or role administration.
# The cell's admins (Authentik group clara-admins) additionally get "Admin". Synced at
# every login: whoever leaves clara-admins loses Admin.
AUTH_USER_REGISTRATION = True
AUTH_USER_REGISTRATION_ROLE = "Alpha"
AUTH_ROLES_MAPPING = {"clara-admins": ["Admin"]}
AUTH_ROLES_SYNC_AT_LOGIN = True


class ZellenSecurityManager(SupersetSecurityManager):
    """Flask-AppBuilder validates Authentik's id_token against its signing keys, but then
    takes the e-mail from `preferred_username`. Same validation, the right fields."""

    def oauth_user_info(self, provider, response=None):
        if provider != "authentik":
            return super().oauth_user_info(provider, response)
        me = self._get_authentik_token_info(response["id_token"])  # signature checked
        name = (me.get("name") or "").split(" ", 1)
        return {
            "username": me.get("preferred_username") or me["email"],
            "email": me.get("email", ""),
            "first_name": me.get("given_name") or name[0],
            "last_name": me.get("family_name") or (name[1] if len(name) > 1 else ""),
            "role_keys": me.get("groups", []),
        }


CUSTOM_SECURITY_MANAGER = ZellenSecurityManager
