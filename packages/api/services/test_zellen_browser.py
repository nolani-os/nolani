"""Cell browser naming: the container a request reaches follows ONLY from the user name."""
import importlib
import os


def _lade(**env):
    for k in ("CLARAOS_PROFILE", "BROWSER_CTL_URL", "BROWSER_CTL_TOKEN", "CLARAOS_BASE_DOMAIN"):
        os.environ.pop(k, None)
    os.environ.update(env)
    import betriebsprofil
    importlib.reload(betriebsprofil)
    from services import zellen_browser
    return importlib.reload(zellen_browser)


def test_aus_ohne_zelle_oder_steuerdienst():
    assert _lade().entry_for("anna") is None
    assert _lade(CLARAOS_PROFILE="cell", CLARAOS_BASE_DOMAIN="demo.example.com").entry_for("anna") is None
    _lade()


def test_namen_und_adressen():
    zb = _lade(CLARAOS_PROFILE="cell", BROWSER_CTL_URL="http://browser-ctl:8199",
               BROWSER_CTL_TOKEN="t", CLARAOS_BASE_DOMAIN="demo.example.com")
    e = zb.entry_for("anna.b")
    assert zb.endpoints(e, "desktop") == ("http://ubd-anna.b:3000", "https://browser.demo.example.com",
                                          "http://ubd-anna.b:9223")
    assert zb.endpoints(e, "mobile")[0] == "http://ubm-anna.b:3000"
    # "bob-m" must never reach bob's mobile browser (a -m suffix must not alias it)
    assert zb.entry_for("bob-m")["desktop_ctr"] != zb.entry_for("bob")["mobile_ctr"]
    # nothing that could leave the name space of ubd-/ubm- containers
    for bad in ("", "A", "x", "../etc", "a b", "a:9222", "a/b", "-a"):
        assert zb.entry_for(bad) is None, bad
    _lade()
