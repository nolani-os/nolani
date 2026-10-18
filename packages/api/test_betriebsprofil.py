"""Unit tests for the operating profile home/cell.

Runs WITHOUT the API venv (only needs fastapi): `python3 -m pytest test_betriebsprofil.py`
or `python3 test_betriebsprofil.py` (mini runner below).
"""

import importlib
import os

from fastapi import APIRouter, FastAPI


def _lade(profil):
    if profil is None:
        os.environ.pop("CLARAOS_PROFILE", None)
    else:
        os.environ["CLARAOS_PROFILE"] = profil
    import betriebsprofil
    return importlib.reload(betriebsprofil)


def _endpoint(modul):
    async def ep():
        return {}
    ep.__module__ = modul
    return ep


def _app():
    app = FastAPI()
    for modul, pfad in [("routers.post", "/post"), ("routers.containers", "/containers"),
                        ("routers.ganz_neu", "/neu")]:
        r = APIRouter()
        r.add_api_route(pfad, _endpoint(modul))
        app.include_router(r)
    app.add_api_route("/me", _endpoint("main"))
    return app


def _pfade(app):
    # Both FastAPI shapes: individual routes (0.115) and included routers (>=0.140).
    out = set()
    def walk(routes):
        for r in routes:
            if getattr(r, "original_router", None) is not None:
                walk(r.original_router.routes)
            else:
                out.add(getattr(r, "path", None))
    walk(app.router.routes)
    return out


def test_home_aendert_nichts():
    bp = _lade(None)
    app = _app()
    vorher = _pfade(app)
    assert bp.prune_routes(app) == 0
    assert _pfade(app) == vorher
    bp.assert_cell_config()   # never an error at home, whatever the environment contains


def test_cell_behaelt_nur_freigegebene_router():
    bp = _lade("cell")
    app = _app()
    assert bp.prune_routes(app) == 2
    p = _pfade(app)
    assert "/post" in p and "/me" in p
    assert "/containers" not in p
    # Allowlist: an unknown NEW router is gone in the cell, not accidentally
    # exposed.
    assert "/neu" not in p


def test_heimverweise_nennen_namen_nie_werte():
    bp = _lade("cell")
    env = {
        "A": "http://192.168.1.20:8080",
        "B": "http://10.0.0.5:9000",
        "C": "https://vault.nas.home",
        "D": "http://100.64.0.7:8080",
        "E": "https://auth.demo.example.com",
        "F": "public-203.0.113.1",   # public address: not a private-network reference
        "G": "",
    }
    assert bp.home_references(env) == ["A", "B", "C", "D"]


def test_heim_default():
    os.environ.pop("X_TEST_URL", None)
    bp = _lade(None)
    # Home: explicit value (non-product code) ...
    assert bp.heim_default("X_TEST_URL", "http://192.168.1.10:1") == "http://192.168.1.10:1"
    # ... or the installation's value from heim_werte, by name or by key
    bp._heim_werte = lambda: {"X_TEST_URL": "http://nas:1", "X_TEST_URL@mod": "http://nas:2"}
    assert bp.heim_default("X_TEST_URL") == "http://nas:1"
    assert bp.heim_default("X_TEST_URL", key="X_TEST_URL@mod") == "http://nas:2"
    assert bp.heim_default("X_TEST_UNKNOWN") == ""
    bp = _lade("cell")
    # No silent reach into the home network in the cell: if the variable is missing, the feature is off.
    assert bp.heim_default("X_TEST_URL", "http://192.168.1.10:1") == ""
    assert bp.heim_default("X_TEST_URL") == ""
    os.environ["X_TEST_URL"] = "http://vikunja:3456"
    assert bp.heim_default("X_TEST_URL") == "http://vikunja:3456"
    os.environ.pop("X_TEST_URL")
    _lade(None)


def test_zellen_apps():
    bp = _lade("cell")
    apps = [
        {"id": "vaultwarden", "config": {"url": "https://vault.example.com"}},
        {"id": "files", "config": {}},
        {"id": "media-server", "config": {"url": "https://media-server.example.com"}},
        {"id": "office-viewer"},
    ]
    out = bp.zellen_apps(apps, "demo.example.com", home_domain="example.com")
    assert [a["id"] for a in out] == ["vaultwarden", "files", "office-viewer", "clara-routinen"]
    assert out[0]["config"]["url"] == "https://vault.demo.example.com"
    assert apps[0]["config"]["url"] == "https://vault.example.com"   # original left untouched
    # element: only carries the configuration for the Matrix token, invisible
    el = bp.zellen_apps([{"id": "element", "showInStartMenu": True, "pinned": True,
                          "config": {"url": "https://element.example.com", "authMethod": "matrix"}}],
                        "demo.example.com", home_domain="example.com")[0]
    assert el["showInStartMenu"] is False and el["pinned"] is False and el["activated"] is False
    assert el["config"]["authMethod"] == "matrix"
    # paperless: OIDC in a cell — no password prompt, own domain
    home = {"id": "paperless", "config": {"url": "https://paperless.example.com", "authMethod": "paperless",
                                          "credentials": [{"key": "username"}], "logoutPath": "/accounts/logout/"}}
    pl = bp.zellen_apps([home], "demo.example.com", home_domain="example.com")[0]
    assert pl["config"]["url"] == "https://paperless.demo.example.com"
    assert pl["config"]["authMethod"] == "sso" and "credentials" not in pl["config"]
    assert pl["config"]["logoutPath"] == "/accounts/logout/"
    assert home["config"]["authMethod"] == "paperless" and "credentials" in home["config"]
    # browser: a selkies tile for EVERY user, no fixed host
    br = bp.zellen_apps([{"id": "selkies-browser", "type": "iframe", "requiredGroups": ["clara-admins"],
                          "config": {"url": "https://browser.example.com"}}], "demo.example.com", home_domain="example.com")[0]
    assert br["type"] == "selkies" and "requiredGroups" not in br and "url" not in br["config"]
    assert "hub" in bp.CELL_ROUTERS and "services-hub" in bp.CELL_APPS
    # social tiles only where the social cell's host is known
    m = {"id": "mastodon", "config": {"url": "https://mastodon.example.com/sso-go"}}
    assert not [a for a in bp.zellen_apps([m], "demo.example.com", home_domain="example.com") if a["id"] == "mastodon"]
    os.environ["SOCIAL_DOMAIN"] = "social.example.com"
    mm = [a for a in bp.zellen_apps([m], "demo.example.com", home_domain="example.com") if a["id"] == "mastodon"][0]
    assert mm["config"]["url"] == "https://social.example.com/auth/sign_in"
    os.environ.pop("SOCIAL_DOMAIN")
    _lade(None)


def test_werkzeugfreier_kontext():
    bp = _lade("cell")
    parts = [
        "active app: files",
        "chat_user: alice",
        "chat_session: abc123",
        "current path: /Dokumente",
        "preferred actions: files_list_directory / files_write_file for I/O",
        "Guide: du kennst diesen User noch NICHT … (guide_capabilities, guide_show_tour)",
        "Objekt „Idee 7“: Gartenbeet anlegen …",
    ]
    out = bp.werkzeugfreier_kontext(parts)
    assert out[:3] == ["active app: files", "current path: /Dokumente", "Objekt „Idee 7“: Gartenbeet anlegen …"]
    assert out[-1] == bp.ZELLE_CHAT_HINWEIS
    assert not any("files_write_file" in p or "guide_" in p or p.startswith("chat_") for p in out)
    _lade(None)


def test_unbekanntes_profil_bricht_ab():
    try:
        _lade("kunde")
        assert False, "unbekanntes Profil haette scheitern muessen"
    except RuntimeError:
        pass
    finally:
        _lade(None)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("✅", name)
    _lade(None)
    print("Alle Tests grün.")
