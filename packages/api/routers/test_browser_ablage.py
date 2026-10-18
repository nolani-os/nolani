"""Browser upload key: bound to one user, one purpose, and worthless for anyone else."""
import importlib
import os

import pytest


@pytest.fixture()
def ba(monkeypatch):
    monkeypatch.setenv("CLARAOS_SERVICE_TOKEN", "service-token-for-tests")
    from routers import browser_ablage
    return importlib.reload(browser_ablage)


def test_schluessel_gehoert_genau_einem_nutzer(ba):
    k = ba.key_for("anna.b")
    assert k.startswith("anna.b.")
    assert ba.user_from(k) == "anna.b"
    # another user's name with anna's signature: rejected
    assert ba.user_from("bob." + k.rsplit(".", 1)[1]) is None
    # tampered signature
    assert ba.user_from(k[:-1] + ("0" if k[-1] != "0" else "1")) is None
    for bad in ("", "anna.b", ".abc", "Anna.x", "../x.y"):
        assert ba.user_from(bad) is None, bad


def test_schluessel_verraet_den_dienstschluessel_nicht(ba):
    assert "service-token-for-tests" not in ba.key_for("anna")


def test_ohne_dienstschluessel_keine_schluessel(monkeypatch):
    monkeypatch.delenv("CLARAOS_SERVICE_TOKEN", raising=False)
    from routers import browser_ablage
    ba = importlib.reload(browser_ablage)
    with pytest.raises(ValueError):
        ba.key_for("anna")
    assert ba.user_from("anna.00") is None


def test_dateiname_ohne_pfad(ba):
    assert ba._safe_name("../../etc/passwd") == "passwd"
    assert ba._safe_name("a\\b\\c.pdf") == "c.pdf"
    assert ba._safe_name(".hidden") == "hidden"
    assert ba._safe_name("") == "download"
    assert ba._safe_name("x\x00y.txt") == "xy.txt"
