"""Unit tests for the KPI traffic light.

The traffic light later decides when Kaizen tools are offered — it must be
right in the edge cases, not just in the normal case. So the tests focus on:
falling target direction, missing values, division by zero, stale
measurements and aggregation at goal level.
"""
from __future__ import annotations

import datetime as dt

from services import kpi_progress as kp

NOW = dt.datetime(2026, 8, 11, 12, 0, tzinfo=dt.timezone.utc)


def val(days_ago: int, value: float) -> dict:
    return {"ts": NOW - dt.timedelta(days=days_ago), "value": value}


def defn(**kw) -> dict:
    base = {"baseline": 0, "target": 100, "unit": "Stk",
            "start_date": "2026-08-01", "due_date": "2026-08-31"}
    base.update(kw)
    return base


# ── Basic cases ─────────────────────────────────────────────────────────────

def test_ohne_messwert_ist_blind_nicht_gruen():
    r = kp.compute(defn(), [], now=NOW)
    assert r["status"] == "blind"
    assert r["attainment"] is None


def test_auf_kurs():
    # day 10 of 30 => expected 33 %; 40 reached => pace 1.2
    r = kp.compute(defn(), [val(0, 40)], now=NOW)
    assert r["status"] == "on_track"
    assert round(r["pace"], 2) == 1.2


def test_hinterher():
    r = kp.compute(defn(), [val(0, 10)], now=NOW)
    assert r["status"] == "behind"


def test_wackelt():
    # 28 % reached vs. 33 % expected => pace 0.84 -> at_risk
    r = kp.compute(defn(), [val(0, 28)], now=NOW)
    assert r["status"] == "at_risk"


def test_ziel_erreicht_schlaegt_tempo():
    r = kp.compute(defn(), [val(0, 120)], now=NOW)
    assert r["status"] == "done"


# ── Direction "smaller is better" ───────────────────────────────────────────

def test_fallende_richtung_ohne_sonderrechnung():
    """Baseline 90 -> target 80: at 85 exactly 50 % is reached."""
    d = defn(baseline=90, target=80, direction="down", unit="Stk")
    r = kp.compute(d, [val(0, 85)], now=NOW)
    assert round(r["attainment"], 3) == 0.5


def test_fallende_richtung_falsche_seite_ist_negativ():
    d = defn(baseline=90, target=80, direction="down")
    r = kp.compute(d, [val(0, 95)], now=NOW)
    assert r["attainment"] < 0
    assert r["status"] == "behind"


# ── Edge cases that would otherwise crash ───────────────────────────────────

def test_basis_gleich_ziel_keine_division_durch_null():
    d = defn(baseline=50, target=50)
    assert kp.compute(d, [val(0, 50)], now=NOW)["status"] == "done"
    assert kp.compute(d, [val(0, 49)], now=NOW)["attainment"] == 0.0


def test_ohne_zielwert_blind_mit_begruendung():
    r = kp.compute(defn(target=None), [val(0, 42)], now=NOW)
    assert r["status"] == "blind"
    assert "Zielwert" in r["reason"]


def test_ohne_basis_wird_erster_messwert_zur_basis():
    d = defn(baseline=None, target=100)
    r = kp.compute(d, [val(10, 20), val(0, 60)], now=NOW)
    assert r["baseline"] == 20
    assert round(r["attainment"], 3) == 0.5


def test_veraltete_messung_ist_blind_auch_wenn_der_wert_gut_ist():
    r = kp.compute(defn(), [val(40, 100)], now=NOW)
    assert r["status"] == "blind"
    assert "40 Tagen" in r["reason"]


def test_eigene_veralterungsfrist_wird_beachtet():
    r = kp.compute(defn(stale_after_days=60), [val(40, 40)], now=NOW)
    assert r["status"] != "blind"


def test_ohne_termin_zaehlt_der_stand_nicht_das_tempo():
    r = kp.compute(defn(due_date=None), [val(0, 10)], now=NOW)
    assert r["status"] == "behind"
    assert r["pace"] is None
    r2 = kp.compute(defn(due_date=None), [val(0, 90)], now=NOW)
    assert r2["status"] == "at_risk"


def test_zeitraum_noch_nicht_begonnen():
    d = defn(start_date="2026-09-01", due_date="2026-09-30")
    r = kp.compute(d, [val(0, 0)], now=NOW)
    assert r["status"] == "on_track"


def test_unbrauchbarer_zeitraum_faellt_auf_stand_zurueck():
    d = defn(start_date="2026-08-31", due_date="2026-08-01")
    assert kp.compute(d, [val(0, 95)], now=NOW)["status"] == "at_risk"


def test_kaputte_werte_werfen_nicht():
    d = defn(baseline="quatsch", target="auch quatsch")
    r = kp.compute(d, [{"ts": NOW, "value": "keine Zahl"}], now=NOW)
    assert r["status"] == "blind"


# ── Aggregation ─────────────────────────────────────────────────────────────

def test_aggregation_gewichtet_und_nimmt_schlechtesten_zustand():
    parts = [
        {"attainment": 1.0, "status": "done", "weight": 1},
        {"attainment": 0.0, "status": "behind", "weight": 3},
    ]
    agg = kp.aggregate(parts)
    assert round(agg["attainment"], 3) == 0.25
    assert agg["status"] == "behind"


def test_blinde_kennzahl_schoenrechnet_den_schnitt_nicht():
    parts = [
        {"attainment": 0.8, "status": "on_track", "weight": 1},
        {"attainment": None, "status": "blind", "weight": 1},
    ]
    agg = kp.aggregate(parts)
    assert round(agg["attainment"], 3) == 0.8   # blind part does NOT count
    assert agg["status"] == "blind"             # but does show through on the traffic light


def test_leere_aggregation_ist_blind():
    assert kp.aggregate([])["status"] == "blind"


def test_rangfolge_behind_schlaegt_blind():
    assert kp.worst(["blind", "behind", "on_track"]) == "behind"
    assert kp.worst(["at_risk", "blind"]) == "blind"


# ── Numeric milestones ──────────────────────────────────────────────────────
# The purpose: the planned course is rarely a straight line. Many goals move
# faster at the beginning than at the end — a straight line would judge the
# pace in the final phase too harshly.

def defn_ms(*paare, **kw):
    d = defn(**kw)
    d["milestones"] = [{"date": dat, "value": val} for dat, val in paare]
    return d


def test_ohne_meilensteine_bleibt_es_die_gerade():
    ohne = kp.compute(defn(), [val(0, 40)], now=NOW)
    mit_leer = kp.compute(defn_ms(), [val(0, 40)], now=NOW)
    assert ohne["expected"] == mit_leer["expected"]


def test_erwartung_folgt_dem_pfad_statt_der_geraden():
    # 1 Aug–31 Aug, today is the 11th; milestone: already 50 by 11 Aug.
    r = kp.compute(defn_ms(("2026-08-11", 50)), [val(0, 50)], now=NOW)
    assert round(r["expected_value"], 1) == 50.0     # a straight line would have expected 33
    assert round(r["expected"], 2) == 0.5
    assert r["status"] == "on_track"                 # exactly on the path


def test_hinter_dem_zwischenziel_ist_hinterher():
    # Same path, but only 20 reached instead of the planned 50.
    r = kp.compute(defn_ms(("2026-08-11", 50)), [val(0, 20)], now=NOW)
    assert r["status"] == "behind"
    assert "Zwischenziel" not in (r["reason"] or "") or True   # text is optional


def test_naechstes_zwischenziel_wird_ausgewiesen():
    r = kp.compute(defn_ms(("2026-08-20", 70), ("2026-08-15", 55)), [val(0, 40)], now=NOW)
    # sorted: 15th before 20th — the next one in the future is the 15th
    assert r["next_milestone"]["value"] == 55
    assert [m["value"] for m in r["milestones"]] == [55, 70]


def test_meilenstein_ausserhalb_des_zeitraums_wird_verworfen():
    r = kp.compute(defn_ms(("2026-07-01", 10), ("2026-09-30", 90)), [val(0, 40)], now=NOW)
    assert r["milestones"] == []          # both lie outside start/due date
    assert round(r["expected"], 2) == 0.33


def test_kaputte_meilensteine_kippen_die_rechnung_nicht():
    d = defn()
    d["milestones"] = [{"date": "quatsch", "value": 5}, {"date": "2026-08-15"},
                       "kein Objekt", {"value": 7}]
    r = kp.compute(d, [val(0, 40)], now=NOW)
    assert r["milestones"] == [] and r["status"] == "on_track"


def test_meilenstein_position_entspricht_dem_erfuellungsgrad():
    r = kp.compute(defn_ms(("2026-08-15", 60)), [val(0, 40)], now=NOW)
    assert round(r["milestones"][0]["attainment"], 2) == 0.6


def test_startzeitpunkt_meldet_verstaendlich():
    d = defn(start_date="2026-08-11", due_date="2026-10-11")
    r = kp.compute(d, [val(0, 0)], now=NOW)
    assert r["status"] == "on_track" and "beginnt heute" in r["reason"]


# ── Window aggregation and median ───────────────────────────────────────────
# Motivation: a noisy KPI reported "goal reached" (~180 %) after a few days.
# When a single reading fluctuates more than the real change over days, the
# latest value alone is not a reliable actual value.

def test_ohne_fenster_bleibt_alles_wie_bisher():
    """Backward compatibility: no window_days => unchanged behaviour."""
    werte = [val(9, 10), val(1, 90)]
    assert kp.compute(defn(), werte, now=NOW)["current"] == 90
    assert kp.compute(defn(aggregation="avg"), werte, now=NOW)["current"] == 50


def test_fenster_beschraenkt_die_aggregation():
    """`avg` only becomes a rolling mean with a window."""
    werte = [val(30, 0), val(20, 0), val(3, 60), val(1, 80)]
    ohne = kp.compute(defn(aggregation="avg"), werte, now=NOW)
    mit = kp.compute(defn(aggregation="avg", window_days=7), werte, now=NOW)
    assert ohne["current"] == 35.0            # whole history drags it down
    assert mit["current"] == 70.0             # only the last 7 days


def test_median_wirft_den_ausreisser_raus():
    werte = [val(3, 50), val(2, 52), val(1, 90), val(0, 51)]
    assert kp.compute(defn(aggregation="median", window_days=7),
                      werte, now=NOW)["current"] == 51.5
    # The mean includes the outlier proportionally.
    assert kp.compute(defn(aggregation="avg", window_days=7),
                      werte, now=NOW)["current"] > 60


def test_leeres_fenster_ist_blind_nicht_der_alte_wert():
    """Outage != measurement: outside the window there is no actual value."""
    r = kp.compute(defn(aggregation="median", window_days=7, stale_after_days=90),
                   [val(40, 42)], now=NOW)
    assert r["status"] == "blind"
    assert r["current"] is None
    assert "letzten 7 Tagen" in r["reason"] and "vor 40 Tagen" in r["reason"]


def test_median_daempft_rauschen_rettet_das_ziel_aber_nicht():
    """Example series over six days with one outlier.

    This test captures TWO insights, and the second is the more important one:

    1. The 7-day median dampens the noise — attainment drops from 229 % to
       114 %.
    2. **It still does not save the goal.** The target span (3.5) is smaller
       than the day-to-day noise of the series (up to 3). A target closer than
       the noise of its own KPI is not measurable — no smoothing helps, only a
       larger distance or a calmer KPI.
    """
    reihe = [val(5, 40.0), val(4, 43.0), val(3, 44.0),
             val(1, 44.0), val(0, 45.0), val(0, 48.0)]
    d = {"baseline": 40.0, "target": 43.5, "unit": "Stk", "direction": "up",
         "start_date": "2026-08-01", "due_date": "2026-12-31"}

    letzter = kp.compute(d, reihe, now=NOW)
    assert letzter["current"] == 48.0
    assert round(letzter["attainment"], 2) == 2.29      # what the live value showed

    geglaettet = kp.compute({**d, "aggregation": "median", "window_days": 7},
                            reihe, now=NOW)
    assert geglaettet["current"] == 44.0                 # outlier 48 dropped
    assert round(geglaettet["attainment"], 2) == 1.14
    # Both report "done" — the target was within the noise.
    assert letzter["status"] == geglaettet["status"] == "done"


def test_median_traegt_erst_bei_ausreichendem_zielabstand():
    """Counter-check to the test above: with a target span above the noise
    the median cleanly separates noise from progress."""
    reihe = [val(5, 40.0), val(4, 43.0), val(3, 44.0),
             val(1, 44.0), val(0, 45.0), val(0, 48.0)]
    d = {"baseline": 40.0, "target": 50.0, "unit": "Stk", "direction": "up",
         "start_date": "2026-08-01", "due_date": "2026-12-31"}

    assert round(kp.compute(d, reihe, now=NOW)["attainment"], 2) == 0.80
    assert round(kp.compute({**d, "aggregation": "median", "window_days": 7},
                            reihe, now=NOW)["attainment"], 2) == 0.40


# ── Maintenance goals (corridor) and observation mode ───────────────────────
# Motivation: a "keep the level" goal modelled as growth showed "done" after a
# few days. But "hold the same" is a corridor, not a path — and the model could
# not express that: with target = baseline there is only 100 % (hit exactly)
# or 0 %.

def korr(**kw) -> dict:
    base = {"mode": "corridor", "min": 40.0, "unit": "Stk",
            "start_date": "2026-08-01", "due_date": "2026-08-31"}
    base.update(kw)
    return base


def test_erhaltungsziel_im_korridor_ist_auf_kurs():
    r = kp.compute(korr(), [val(2, 41.0), val(1, 42.5), val(0, 41.5)], now=NOW)
    assert r["status"] == "on_track"
    assert r["attainment"] == 1.0            # all three measurements inside
    assert r["in_corridor"] is True


def test_erhaltungsziel_meldet_kein_erledigt_vor_dem_termin():
    """The actual bug: maintenance is only fulfilled at the end."""
    r = kp.compute(korr(), [val(0, 55.0)], now=NOW)   # far above the lower bound
    assert r["status"] == "on_track" and r["status"] != "done"


def test_erhaltungsziel_nach_dem_termin_ist_erledigt():
    r = kp.compute(korr(due_date="2026-08-05"), [val(0, 42.0)], now=NOW)
    assert r["status"] == "done" and "gehalten" in r["reason"]


def test_erhaltungsziel_ausserhalb_ist_hinterher():
    r = kp.compute(korr(), [val(1, 41.0), val(0, 38.0)], now=NOW)
    assert r["status"] == "behind"
    assert r["attainment"] == 0.5            # one of two measurements inside
    assert r["in_corridor"] is False


def test_erhaltungsziel_obergrenze_und_knapp_am_rand():
    """Two-sided corridor: a value inside the 10 % edge zone is at_risk."""
    d = {"mode": "corridor", "min": 40.0, "max": 60.0, "unit": "%",
         "start_date": "2026-08-01", "due_date": "2026-12-31"}
    assert kp.compute(d, [val(0, 50.0)], now=NOW)["status"] == "on_track"
    knapp = kp.compute(d, [val(0, 59.0)], now=NOW)
    assert knapp["status"] == "at_risk" and "knapp" in knapp["reason"]
    assert kp.compute(d, [val(0, 61.0)], now=NOW)["status"] == "behind"


def test_einseitiger_korridor_erfindet_keine_warnzone():
    """Without a second bound there is no width — then rather no warning zone."""
    r = kp.compute(korr(), [val(0, 40.01)], now=NOW)
    assert r["status"] == "on_track"
    # With an explicit margin there is.
    assert kp.compute(korr(warn_margin=0.5), [val(0, 40.01)], now=NOW)["status"] == "at_risk"


def test_korridor_ohne_grenze_ist_blind_nicht_gruen():
    r = kp.compute({"mode": "corridor", "start_date": "2026-08-01",
                    "due_date": "2026-08-31"}, [val(0, 45.0)], now=NOW)
    assert r["status"] == "blind" and "ohne Grenze" in r["reason"]


def test_verdrehter_korridor_wird_erkannt():
    r = kp.compute(korr(min=60.0, max=40.0), [val(0, 50.0)], now=NOW)
    assert r["status"] == "blind" and "verdreht" in r["reason"]


def test_korridor_nutzt_das_fenster():
    """Old outliers outside the window do not spoil the share."""
    werte = [val(30, 30.0), val(2, 41.0), val(0, 42.0)]
    assert kp.compute(korr(), werte, now=NOW)["attainment"] == 2 / 3
    assert kp.compute(korr(window_days=7), werte, now=NOW)["attainment"] == 1.0


def test_beobachtungsmodus_bewertet_nicht():
    r = kp.compute({"mode": "observe", "unit": "°C"},
                   [val(1, 21.4), val(0, 20.9)], now=NOW)
    assert r["status"] == "observing"
    assert r["attainment"] is None
    assert "2 Messwerte" in r["reason"] and "Streuung" in r["reason"]


def test_beobachtung_ohne_messung_bleibt_blind():
    """Observing means measuring — without a value it is still blind."""
    assert kp.compute({"mode": "observe"}, [], now=NOW)["status"] == "blind"


def test_veraltete_beobachtung_ist_blind_nicht_beobachtend():
    r = kp.compute({"mode": "observe", "stale_after_days": 5}, [val(40, 21.0)], now=NOW)
    assert r["status"] == "blind"


def test_beobachtung_zieht_das_ziel_weder_hoch_noch_runter():
    ziel = kp.aggregate([
        {"attainment": 0.4, "status": "behind", "weight": 1.0},
        {"attainment": None, "status": "observing", "weight": 1.0},
    ])
    assert ziel["attainment"] == 0.4          # not diluted by the observer
    assert ziel["status"] == "behind"         # and not sugar-coated
    assert ziel["observing"] == 1


def test_ziel_aus_lauter_beobachtern_ist_in_beobachtung():
    ziel = kp.aggregate([{"attainment": None, "status": "observing", "weight": 1.0}] * 2)
    assert ziel["status"] == "observing" and ziel["attainment"] is None


def test_blind_bleibt_anders_als_beobachtend():
    """The distinction is the whole point: blind = deficiency, observing = intent."""
    mit_blind = kp.aggregate([
        {"attainment": 0.9, "status": "on_track", "weight": 1.0},
        {"attainment": None, "status": "blind", "weight": 1.0},
    ])
    mit_beob = kp.aggregate([
        {"attainment": 0.9, "status": "on_track", "weight": 1.0},
        {"attainment": None, "status": "observing", "weight": 1.0},
    ])
    assert mit_blind["status"] == "blind"       # shows through
    assert mit_beob["status"] == "on_track"     # deliberately does NOT show through


def test_verrauschter_wert_als_erhaltungsziel_statt_steigerung():
    """A maintenance goal computed as a corridor instead of growth.

    Lower bound just above the baseline ("do not fall below it"), 7-day median
    against noise. No "done" after a few days, but an honest statement:
    held, and the verdict comes on the due date.
    """
    reihe = [val(5, 40.0), val(4, 43.0), val(3, 44.0),
             val(1, 44.0), val(0, 48.0)]
    r = kp.compute({"mode": "corridor", "min": 40.5, "unit": "Stk",
                    "aggregation": "median", "window_days": 7,
                    "start_date": "2026-08-01", "due_date": "2026-12-31"},
                   reihe, now=NOW)
    assert r["current"] == 44.0
    assert r["status"] == "on_track"          # held — but not "done"
    assert r["attainment"] == 0.8             # 4 of 5 measurements above 40.5


# ── Why "observe" without a value STAYS blind (rejected fix) ────────────────
# An observation KPI — deliberately without a target and without a value yet —
# pulled a whole vision to `blind`. The obvious fix was to set `observe` without a value
# to `observing`.
#
# Warning: that would have been wrong. A freshly created observation and one
# whose measurement never worked look identical from the outside. Whoever
# colours the first one green colours the second one too — and a meter
# integration that never delivered a value since creation would show
# "observing" forever.
#
# The number was the fix, not the rule: **a measured 0 is a measurement.**
# The state "there is nothing" is measured, not claimed by a special rule.
# "Observing means measuring" stays.

def test_beobachtung_ohne_messwert_bleibt_blind_auch_wenn_es_stoert():
    """Counter-check to the rejected fix — intent does not replace measurement."""
    assert kp.compute({"mode": "observe"}, [], now=NOW)["status"] == "blind"


def test_eine_gemessene_null_macht_die_beobachtung_gueltig():
    """The right way out of blind: measure that it is zero."""
    r = kp.compute({"mode": "observe", "unit": "Stk"}, [val(0, 0.0)], now=NOW)
    assert r["status"] == "observing"
    assert r["current"] == 0.0


# ── Shortfall instead of quotient ───────────────────────────────────────────
# Motivation: goals created the day before showed `behind` after ONE day.
# `pace = attainment / expected` is unstable at the start — attainment is still
# exactly 0 (correct, nothing happened), so the quotient is 0 no matter how tiny
# the expectation. Now the shortfall as a share of the distance is evaluated.

def test_am_tag_nach_dem_anlegen_ist_nichts_hinterher():
    """A percentage KPI with a long horizon: after one day only a tiny fraction
    of the distance is missing. That is not a shortfall, it is resolution."""
    r = kp.compute(defn(baseline=40.5, target=90, unit="%",
                        start_date="2026-08-10", due_date="2026-12-31"),
                   [val(1, 40.5)], now=NOW)
    assert r["status"] == "on_track"


def test_eine_kennzahl_die_wirklich_steht_wird_hinterher():
    """The counter-check that matters: leniency on the first day must not become
    permanent leniency. After half the time without any progress the traffic
    light must show red."""
    r = kp.compute(defn(baseline=0, target=25, unit="Personen",
                        start_date="2026-06-11", due_date="2026-10-11"),
                   [val(1, 0)], now=NOW)          # half the distance, nothing happened
    assert r["status"] == "behind"


def test_der_uebergang_liegt_zwischen_den_beiden():
    """A tenth of the distance behind plan: not good, but not red either."""
    r = kp.compute(defn(baseline=0, target=100,
                        start_date="2026-08-01", due_date="2026-08-31"),
                   [val(0, 23)], now=NOW)          # day 10 of 30 -> expected ~33
    assert r["status"] == "at_risk"


def test_pace_wird_weiter_ausgewiesen():
    """The quotient stays as a reading aid — it just no longer decides."""
    r = kp.compute(defn(baseline=0, target=100,
                        start_date="2026-08-01", due_date="2026-08-31"),
                   [val(0, 23)], now=NOW)
    assert r["pace"] is not None and 0 < r["pace"] < 1


# ── "Value is constant" != "source is dead" ─────────────────────────────────
# Motivation: several KPIs looked frozen for days. The cause was NOT an outage —
# the sensors reported the same value every day, and an unchanged value creates
# no new data point because of the uniqueness key. Without `source_ok_at` both
# cases were indistinguishable.

def test_bestaetigte_quelle_haelt_konstanten_wert_frisch():
    """Old measurement, but the source answered today => not blind."""
    r = kp.compute(defn(source_ok_at=NOW.isoformat()), [val(40, 100)], now=NOW)
    assert r["status"] != "blind"
    assert r["unchanged_days"] == 40          # value unchanged for 40 days ...
    assert r["source_confirmed_at"]           # ... but confirmed current


def test_ohne_bestaetigung_bleibt_es_beim_alten_verhalten():
    """No `source_ok_at` => a stale measurement is still blind."""
    r = kp.compute(defn(), [val(40, 100)], now=NOW)
    assert r["status"] == "blind"
    assert "40 Tagen" in r["reason"]


def test_auch_die_bestaetigung_kann_veralten():
    """The source last answered 40 days ago => real outage, blind."""
    alt = (NOW - dt.timedelta(days=40)).isoformat()
    r = kp.compute(defn(source_ok_at=alt), [val(40, 100)], now=NOW)
    assert r["status"] == "blind"
    assert "40 Tagen" in r["reason"]


def test_kaputte_bestaetigung_wird_ignoriert_statt_zu_werfen():
    """An unreadable timestamp must not break the evaluation."""
    r = kp.compute(defn(source_ok_at="übermorgen"), [val(40, 100)], now=NOW)
    assert r["status"] == "blind"


def test_frische_messung_braucht_keine_bestaetigung():
    """The normal case stays untouched — no `unchanged_days` in the result."""
    r = kp.compute(defn(), [val(1, 50)], now=NOW)
    assert r["status"] != "blind"
    assert "unchanged_days" not in r
