"""Trend direction and distance to the expected value.

The costly mistake here is not a wrong slope, but a CLAIMED direction where
there is none: "stagnating" with three data points looks like a finding and is
not one. That is why several cases test exactly this.
"""
import datetime as dt
import sys

sys.path.insert(0, "/app")

from services import kpi_progress as kp  # noqa: E402


HEUTE = dt.datetime(2026, 8, 15, 12, 0, tzinfo=dt.timezone.utc)


def reihe(werte, tage_abstand=7, ende=HEUTE):
    """Series going back from `ende`, oldest value first."""
    n = len(werte)
    return [{"ts": ende - dt.timedelta(days=tage_abstand * (n - 1 - i)), "value": w}
            for i, w in enumerate(werte)]


def defn(target=82.0, baseline=92.0, direction="down"):
    return kp.normalize_def({"target": target, "baseline": baseline,
                             "direction": direction, "unit": "min"})


# ── Too little data: NO statement, not "flat" ──────────────────────────
def test_ohne_werte_keine_richtung():
    r = kp.trend([], defn(), HEUTE)
    assert r["trend"] is None
    assert r["trend_samples"] == 0


def test_drei_werte_sind_zu_wenig():
    r = kp.trend(reihe([92, 90, 88]), defn(), HEUTE)
    assert r["trend"] is None, "drei Punkte dürfen keine Richtung behaupten"


def test_vier_werte_genuegen():
    r = kp.trend(reihe([92, 90, 88, 86]), defn(), HEUTE)
    assert r["trend"] == "down"
    assert r["trend_samples"] == 4


def test_alles_am_selben_tag_ergibt_keine_wochensteigung():
    same = [{"ts": HEUTE, "value": v} for v in (90, 89, 88, 87)]
    r = kp.trend(same, defn(), HEUTE)
    assert r["trend"] is None
    assert r["trend_per_week"] is None


def test_alte_werte_zaehlen_nicht_mehr():
    # several values, but all older than the window
    alt = reihe([92, 90, 88, 86, 84, 82], ende=HEUTE - dt.timedelta(days=200))
    r = kp.trend(alt, defn(), HEUTE)
    assert r["trend"] is None, "außerhalb des Fensters darf nichts behauptet werden"


# ── Direction ────────────────────────────────────────────────────────────
def test_fallend():
    r = kp.trend(reihe([92, 90.5, 89, 87.5, 86]), defn(), HEUTE)
    assert r["trend"] == "down"
    assert r["trend_per_week"] < 0


def test_steigend():
    d = defn(target=3.0, baseline=0.0, direction="up")
    r = kp.trend(reihe([0, 0.8, 1.5, 2.2, 3.0]), d, HEUTE)
    assert r["trend"] == "up"
    assert r["trend_per_week"] > 0


def test_stagnierend():
    r = kp.trend(reihe([90.0, 90.1, 89.9, 90.0, 90.05]), defn(), HEUTE)
    assert r["trend"] == "flat"


# ── Threshold is RELATIVE to the target span ─────────────────────────────
def test_schwelle_skaliert_mit_der_zielspanne():
    """The same absolute movement: a development for a small span, noise for a
    huge span. That is exactly why the threshold is relative."""
    werte = [1000.0, 1000.2, 1000.4, 1000.6, 1000.8]
    eng = kp.trend(reihe(werte), defn(target=1002.0, baseline=1000.0, direction="up"), HEUTE)
    weit = kp.trend(reihe(werte), defn(target=2000.0, baseline=1000.0, direction="up"), HEUTE)
    assert eng["trend"] == "up"
    assert weit["trend"] == "flat"


# ── Does the trend help the goal? ────────────────────────────────────────
def test_fallen_ist_gut_bei_fallendem_ziel():
    r = kp.trend(reihe([92, 90, 88, 86]), defn(direction="down"), HEUTE)
    assert r["trend"] == "down" and r["trend_good"] is True


def test_fallen_ist_schlecht_beim_aufbauen():
    d = defn(target=3.0, baseline=0.0, direction="up")
    r = kp.trend(reihe([3.0, 2.2, 1.4, 0.6]), d, HEUTE)
    assert r["trend"] == "down" and r["trend_good"] is False


def test_stagnation_ist_weder_gut_noch_schlecht():
    r = kp.trend(reihe([90.0, 90.0, 90.0, 90.0]), defn(), HEUTE)
    assert r["trend"] == "flat" and r["trend_good"] is None


# ── Goodness of fit ──────────────────────────────────────────────────────
def test_gerade_reihe_hat_hohes_r2():
    r = kp.trend(reihe([92, 90, 88, 86]), defn(), HEUTE)
    assert r["trend_r2"] > 0.99


def test_zickzack_hat_niedriges_r2():
    r = kp.trend(reihe([92, 86, 92, 86, 92, 86]), defn(), HEUTE)
    assert r["trend_r2"] < 0.3, "Rauschen darf nicht wie eine Entwicklung aussehen"


# ── Distance to the expected value (sign!) ───────────────────────────────
def test_behind_by_bei_fallendem_ziel_positiv_wenn_zu_hoch():
    props = {"target": 82.0, "baseline": 92.0, "direction": "down", "unit": "min",
             "start_date": "2026-06-01", "due_date": "2026-12-31"}
    out = kp.compute(props, reihe([92, 90, 89, 88.5]), HEUTE)
    assert out["expected_value"] is not None
    if out["behind_by"] is not None:
        # too high compared to the planned path => behind => positive
        assert (out["current"] > out["expected_value"]) == (out["behind_by"] > 0)


def test_behind_by_beim_aufbauen_dreht_das_vorzeichen():
    props = {"target": 3.0, "baseline": 0.0, "direction": "up", "unit": "Einheiten",
             "start_date": "2026-06-01", "due_date": "2026-12-31"}
    out = kp.compute(props, reihe([0, 0.2, 0.3, 0.4]), HEUTE)
    if out["behind_by"] is not None:
        # too little compared to the planned path => behind => also positive
        assert (out["current"] < out["expected_value"]) == (out["behind_by"] > 0)


# ── compute() passes the trend through, even without a target ────────────
def test_compute_liefert_trend_auch_ohne_zielwert():
    out = kp.compute({"unit": "min", "direction": "down"}, reihe([92, 90, 88, 86]), HEUTE)
    assert out["status"] == "blind", "ohne Zielwert bleibt die Ampel grau"
    assert out["trend"] == "down", "die Richtung ist trotzdem bekannt"


def test_compute_ohne_messung_hat_keinen_trend():
    out = kp.compute({"target": 82.0, "unit": "min"}, [], HEUTE)
    assert out["trend"] is None and out["behind_by"] is None
