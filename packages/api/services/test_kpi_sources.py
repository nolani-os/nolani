"""Unit tests for the KPI sources.

Tests the part without network: converting raw values and evaluating a task
list. The focus is on the rule underlying the whole adapter core — **an outage
must never look like a measurement** (and certainly not like a 0).
"""
from __future__ import annotations

import asyncio

import pytest

from services import kpi_sources
from services.kpi_sources import planner
from services.kpi_sources.base import to_float


# ── Raw values ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("42", 42.0),
    ("42.5", 42.5),
    ("42,5", 42.5),        # German decimal comma
    (" 7 ", 7.0),
    (3, 3.0),
    ("on", 1.0),
    ("off", 0.0),
])
def test_zahlen_werden_erkannt(raw, expected):
    r = to_float(raw)
    assert r.value == expected and r.error is None


@pytest.mark.parametrize("raw", ["unavailable", "unknown", "none", "NaN", "", None])
def test_ausfall_wird_nicht_zu_null(raw):
    """The heart of the matter: no value => error, NOT 0."""
    r = to_float(raw)
    assert r.value is None
    assert r.error


def test_text_meldet_klartextfehler():
    r = to_float("dreiundzwanzig", "Zustand")
    assert r.value is None
    assert "keine Zahl" in r.error and "Zustand" in r.error


def test_langer_muell_wird_gekuerzt():
    r = to_float("x" * 500)
    assert len(r.error) < 200


# ── Planner evaluation ──────────────────────────────────────────────────────

TASKS = [{"done": True}, {"done": True}, {"done": False}, {"done": False}, {"done": False}]


def test_planner_metriken():
    assert planner.count_metric(TASKS, "done").value == 2
    assert planner.count_metric(TASKS, "open").value == 3
    assert planner.count_metric(TASKS, "total").value == 5
    assert planner.count_metric(TASKS, "done_ratio").value == 40.0


def test_leeres_projekt_hat_keinen_anteil():
    """0 of 0 is not 0 % — it is no statement."""
    r = planner.count_metric([], "done_ratio")
    assert r.value is None and "nicht bestimmbar" in r.error
    # Absolute numbers, however, are indeed 0.
    assert planner.count_metric([], "done").value == 0.0


def test_unbekannte_metrik_meldet_die_erlaubten():
    r = planner.count_metric(TASKS, "quatsch")
    assert r.value is None and "done_ratio" in r.error


# ── Registry ────────────────────────────────────────────────────────────────

def test_manuelle_kennzahl_wird_uebersprungen_nicht_gemeldet():
    r = asyncio.run(kpi_sources.fetch({"kind": "manual"}, "alice"))
    assert r.skipped and not r.error and r.value is None


def test_fehlende_quelle_gilt_als_manuell():
    r = asyncio.run(kpi_sources.fetch(None, "alice"))
    assert r.skipped and not r.error


def test_unbekannte_quelle_ist_ein_fehler():
    r = asyncio.run(kpi_sources.fetch({"kind": "telepathie"}, "alice"))
    assert r.error and "telepathie" in r.error


def test_alle_arten_sind_registriert():
    """Deliberately a strict equality, not a subset: a new source should turn
    this test red so it does not slip in unnoticed.

    Warning: a permanently red test is the best way to miss the next real
    error; so this list must be maintained, not loosened."""
    assert set(kpi_sources.KINDS) - set(kpi_sources.HEIM_QUELLEN) == {
        "manual", "planner", "formula"}


# ── Adapter error paths without network ─────────────────────────────────────

def test_planner_ohne_projektnummer():
    r = asyncio.run(kpi_sources.fetch({"kind": "planner", "config": {"metric": "done"}}, "alice"))
    assert r.error and "project_id" in r.error


def test_planner_mit_unbekannter_metrik_geht_nicht_ins_netz():
    r = asyncio.run(kpi_sources.fetch(
        {"kind": "planner", "config": {"project_id": 1, "metric": "quatsch"}}, "alice"))
    assert r.error and "quatsch" in r.error


def test_formel_ohne_ausdruck():
    r = asyncio.run(kpi_sources.fetch({"kind": "formula", "config": {}}, "alice"))
    assert r.error and "Formel" in r.error


def test_formel_mit_zu_vielen_eingaengen():
    cfg = {"expression": "1", "inputs": {f"a{i}": "x" for i in range(20)}}
    r = asyncio.run(kpi_sources.fetch({"kind": "formula", "config": cfg}, "alice"))
    assert r.error and "Zu viele" in r.error
