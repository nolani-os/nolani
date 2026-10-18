"""Unit tests for the Pareto analysis.

Focus on the cases where a naive implementation silently computes nonsense:
negative contributions, all zeros, broken numbers — and the honest special
case "the distribution is uniform, prioritising does not help here".
"""
from __future__ import annotations

from services import kaizen_pareto as kp


def items(*paare):
    return [{"cause": c, "value": v, "unit": "h"} for c, v in paare]


def test_klassischer_pareto():
    r = kp.analyse(items(("Meetings", 60), ("Mail", 20), ("Kontext-Wechsel", 12),
                         ("Ablage", 5), ("Sonstiges", 3)))
    assert r["items"][0]["cause"] == "Meetings"
    assert r["items"][0]["share"] == 0.6
    assert r["vital_few"] == ["Meetings", "Mail"]          # 60 + 20 = 80 %
    assert r["cutoff_index"] == 1
    assert r["total"] == 100


def test_sortiert_unabhaengig_von_der_eingabereihenfolge():
    a = kp.analyse(items(("klein", 1), ("gross", 9)))
    assert [i["cause"] for i in a["items"]] == ["gross", "klein"]
    assert a["items"][-1]["cumulative"] == 1.0


def test_gleichverteilung_wird_als_solche_erkannt():
    r = kp.analyse(items(("a", 10), ("b", 10), ("c", 10), ("d", 10), ("e", 10)))
    # 80 % is only reached with 4 of 5 causes — prioritising does not pay off.
    assert r["concentration"] == 0.8
    assert "gleichmäßig" in kp.markdown("Test", r)


def test_eine_einzige_position():
    r = kp.analyse(items(("alles", 42)))
    assert r["vital_few"] == ["alles"] and r["items"][0]["cumulative"] == 1.0


def test_deutsches_komma():
    r = kp.analyse([{"cause": "x", "value": "1,5"}, {"cause": "y", "value": "0,5"}])
    assert r["total"] == 2.0


# ── Cases where silently computing would be worse than refusing ───────────

def test_negative_werte_werden_abgelehnt():
    r = kp.analyse(items(("gut", 10), ("kaputt", -3)))
    assert "negativ" in r["error"]


def test_alles_null_ergibt_keine_aussage():
    r = kp.analyse(items(("a", 0), ("b", 0)))
    assert "0" in r["error"] and "items" not in r


def test_leere_liste():
    assert kp.analyse([])["error"]


def test_position_ohne_ursache():
    assert "Ursache" in kp.analyse([{"cause": "  ", "value": 5}])["error"]


def test_unlesbare_zahl_nennt_die_position():
    r = kp.analyse([{"cause": "Meetings", "value": "viel"}])
    assert "Meetings" in r["error"]


def test_zu_viele_positionen():
    r = kp.analyse([{"cause": f"u{i}", "value": 1} for i in range(kp.MAX_ITEMS + 1)])
    assert "Zu viele" in r["error"]


# ── Rendering ──────────────────────────────────────────────────────────────

def test_markdown_enthaelt_tabelle_und_fazit():
    md = kp.markdown("Zu wenig Zeit", kp.analyse(items(("Meetings", 80), ("Mail", 20))))
    assert "| # | Ursache |" in md
    assert "Zu wenig Zeit" in md
    assert "Meetings" in md


def test_markdown_zeigt_fehler_statt_leerer_tabelle():
    md = kp.markdown("Problem", kp.analyse([]))
    assert "⚠" in md
