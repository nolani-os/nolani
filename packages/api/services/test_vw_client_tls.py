"""The vault CLI always verifies TLS — a disabled check hands the master password to
anyone in the middle. Guards against the switch-off coming back."""
from services import vw_client


def test_bw_laeuft_mit_tls_pruefung(monkeypatch):
    monkeypatch.delenv("NODE_TLS_REJECT_UNAUTHORIZED", raising=False)
    assert "NODE_TLS_REJECT_UNAUTHORIZED" not in vw_client._env()


def test_auch_wenn_die_umgebung_sie_abschaltet(monkeypatch):
    monkeypatch.setenv("NODE_TLS_REJECT_UNAUTHORIZED", "0")
    assert "NODE_TLS_REJECT_UNAUTHORIZED" not in vw_client._env()


def test_zusaetzliche_ca_bleibt_erlaubt(monkeypatch):
    # an internal CA is added, not trusted by switching verification off
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", "/etc/ssl/certs/ca-bundle.crt")
    assert vw_client._env()["NODE_EXTRA_CA_CERTS"] == "/etc/ssl/certs/ca-bundle.crt"
