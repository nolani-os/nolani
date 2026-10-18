"""Tests for the data classification (data class) of model calls.

Important: the most important test in this file is the **last** one: it checks
that every file calling the model gateway declares its data class. Without this
count, many callers can end up behind a single guard — and a state that nobody
re-counts comes back.
"""
from __future__ import annotations

import pathlib
import re

import pytest

from services import datenklasse as dk

HIER = pathlib.Path(__file__).parent


# ── The contract ─────────────────────────────────────────────────────────

def test_standard_ist_die_strengste_klasse():
    # Warning: this assertion is the core: a forgotten parameter must never
    # be a leak, it must lead to the strictest case.
    assert dk.STANDARD == "vertraulich"
    assert dk.normalisieren(None) == "vertraulich"
    assert dk.normalisieren("") == "vertraulich"
    assert dk.normalisieren("Quatsch") == "vertraulich"
    assert dk.normalisieren("OEFFENTLICH") == "oeffentlich"


# An installation's model tables (here invented). The product itself ships
# almost none — see test_produkt_haelt_kein_modell_fuer_lokal.
_BEISPIEL_ORT = {
    "local/modell-a": "lokal",
    "local/modell-b-vision": "lokal",
    # Not named local, but they are (they point to a local model).
    "classifier": "lokal",
    "cloud-name-alias": "lokal",
    "eu/modell-m": "eu",
    "cheap/eu-modell-s": "eu",      # named "cheap", but runs in the EU
    "clara/everyday": "durchgereicht",
}
_BEISPIEL_ORT_ROH = {"modell-a": "lokal", "eu-modell-l-latest": "eu"}
_BEISPIEL_BILDFAEHIG = frozenset({"local/modell-b-vision", "cheap/cloud-vision"})
_BEISPIEL_VORZUG = {
    "vertraulich": ("local/modell-b-vision", "local/modell-a"),
    "intern": ("eu/modell-m", "local/modell-a"),
}


@pytest.fixture(autouse=True)
def _beispieltabellen(monkeypatch):
    monkeypatch.setattr(dk, "ORT", dict(_BEISPIEL_ORT))
    monkeypatch.setattr(dk, "ORT_ROH", dict(_BEISPIEL_ORT_ROH))
    monkeypatch.setattr(dk, "BILDFAEHIG", _BEISPIEL_BILDFAEHIG)
    monkeypatch.setattr(dk, "VORZUG", dict(_BEISPIEL_VORZUG))


def test_produkt_haelt_kein_modell_fuer_lokal():
    """The product table must not call any model local.

    An alias name proves nothing about where it runs: in the cell configuration
    `claude-haiku-4-5` is the hosted model. A product default saying "lokal"
    would let confidential data leave the house in every installation that
    does not override it.
    """
    assert all(v != "lokal" for v in dk._ORT_PRODUKT.values())


def test_oeffentlich_laesst_den_wunsch_stehen():
    assert dk.waehlen("oeffentlich", "premium/cloud-large") == "premium/cloud-large"


def test_bildauftrag_bekommt_nie_ein_textmodell():
    gewaehlt = dk.waehlen("vertraulich", "", bild=True)
    assert gewaehlt in dk.BILDFAEHIG
    assert dk.ort(gewaehlt) == "lokal"


def test_ohne_passendes_modell_fliegt_ein_fehler():
    """No "fall back to the cloud in an emergency". An outage stays an outage."""
    dk.VORZUG["vertraulich"] = ()
    with pytest.raises(dk.DatenklasseVerletzt):
        dk.waehlen("vertraulich", "cheap/cloud-vision")


def test_unbekanntes_modell_gilt_als_extern():
    # A new model in the gateway configuration that is still missing here is
    # more likely a cloud model than a local one.
    assert dk.ort("gibt/es/nicht") == "extern"
    assert not dk.erlaubt("gibt/es/nicht", "vertraulich")
    assert not dk.erlaubt("gibt/es/nicht", "intern")


def test_vertraulich_laesst_nur_lokales_durch():
    assert dk.erlaubt("local/modell-a", "vertraulich")
    for fremd in ("cheap/cloud-vision", "premium/cloud-large",
                  "eu/modell-m", "clara/everyday"):
        assert not dk.erlaubt(fremd, "vertraulich"), fremd


def test_intern_erlaubt_eu_und_lokal_sonst_nichts():
    for erlaubt in ("eu/modell-m", "cheap/eu-modell-s", "local/modell-a"):
        assert dk.erlaubt(erlaubt, "intern"), erlaubt
    for verboten in ("cheap/cloud-vision", "premium/cloud-large",
                     "cheap/cloud-fast", "clara/everyday"):
        assert not dk.erlaubt(verboten, "intern"), verboten


def test_praefix_luege_ist_abgedeckt():
    """The cases where a `startswith("local/")` check would be wrong."""
    # Not named local, but it is (points to a local model).
    assert dk.ort("classifier") == "lokal"
    assert dk.ort("cloud-name-alias") == "lokal"
    # Named "cheap", but runs in the EU — the prefix refers to the price.
    assert dk.ort("cheap/eu-modell-s") == "eu"
    # Harmless name, but it routes onward by itself.
    assert dk.ort("clara/everyday") == "durchgereicht"


def test_rueckfall_antwort_wird_richtig_eingeordnet():
    """On fallback, LiteLLM reports the provider name without a prefix, on
    success the alias. Both forms must be classified correctly — otherwise the
    cross-check in `llm.py` rejects either too much or too little.
    """
    assert dk.ort("openai/large-fallback") == "extern"    # how the fallback arrives
    assert dk.ort("cheap/cloud-vision") == "extern"       # how success arrives
    assert dk.ort("modell-a") == "lokal"                  # raw name of a local model
    assert dk.ort("llamacpp/modell-a") == "lokal"         # with provider prefix
    assert dk.ort("eu-modell-l-latest") == "eu"
    # The case that would silently break without ORT_ROH: a local model
    # answers successfully and would be wrongly blocked.
    assert dk.erlaubt("modell-a", "vertraulich")


def test_ersatz_bleibt_in_der_klasse():
    # Requested model does not fit -> substitute, but never beyond the class.
    gewaehlt = dk.waehlen("intern", "cheap/cloud-vision")
    assert dk.ort(gewaehlt) in ("eu", "lokal")
    gewaehlt = dk.waehlen("vertraulich", "premium/cloud-large")
    assert dk.ort(gewaehlt) == "lokal"


def test_jede_klasse_hat_erlaubte_orte():
    for k in dk.KLASSEN:
        assert dk.ERLAUBTE_ORTE[k], k
        assert dk.ERLAUBTE_ORTE[k] <= set(dk.ORTE), k


# ── The count that prevents regression ──────────────────────────────────

# A file containing one of these calls the gateway.
_RUFT_AN = re.compile(r"chat/completions|/v1/embeddings")
# ... and must then contain one of these.
_DEKLARIERT = re.compile(r"DATENKLASSE\s*=|datenklasse\s*=\s*[\"']|"
                         r"datenklasse\.waehlen|datenklasse\.pruefen|llm\.anfragen")

_AUSGENOMMEN = {"services/llm.py", "test_datenklasse.py"}


def _gateway_aufrufer() -> list[pathlib.Path]:
    treffer = []
    for pfad in HIER.rglob("*.py"):
        rel = pfad.relative_to(HIER).as_posix()
        if rel in _AUSGENOMMEN or "/test" in rel or rel.startswith("test_"):
            continue
        text = pfad.read_text(encoding="utf-8", errors="ignore")
        if _RUFT_AN.search(text):
            treffer.append(pfad)
    return treffer


def test_jeder_gateway_aufrufer_deklariert_seine_datenklasse():
    """The actual guard.

    A new file calls the gateway without saying what it processes? Then this
    test fails — with the file name, not with a number. Such gaps go unnoticed
    for a long time when nobody ever counts the callers against the guards.
    """
    ohne = [p.relative_to(HIER).as_posix() for p in _gateway_aufrufer()
            if not _DEKLARIERT.search(p.read_text(encoding="utf-8", errors="ignore"))]
    assert not ohne, ("Diese Dateien rufen das Modell-Gateway an, ohne ihre "
                      "Datenklasse zu deklarieren: " + ", ".join(sorted(ohne)))


def test_deklarierte_klassen_sind_gueltig():
    muster = re.compile(r"DATENKLASSE(?:_SOLL)?\s*=\s*[\"'](\w+)[\"']")
    for pfad in _gateway_aufrufer():
        for gefunden in muster.findall(pfad.read_text(encoding="utf-8", errors="ignore")):
            assert gefunden in dk.KLASSEN, f"{pfad.name}: {gefunden!r}"
