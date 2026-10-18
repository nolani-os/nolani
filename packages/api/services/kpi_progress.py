"""KPI progress and traffic light — pure computation, no database.

Why a module of its own: the traffic light triggers everything else (the
improvement tools depend on "goal is behind"). A rule that applies the same
everywhere and is testable on its own is worth more than three scattered
evaluations.

Two design decisions you need to know when reading this:

1. **Direction needs no separate calculation.** Attainment is always
   `(actual - baseline) / (target - baseline)`. If the number should fall,
   `target < baseline`, so the denominator is negative — and a falling actual
   value automatically yields rising attainment. `direction` only serves
   display and checking whether the target is on the right side at all.

2. **"Blind" is a state of its own, not green.** The most common failure is
   not a missed goal but a measurement that fell asleep. A KPI without a fresh
   value must not disguise itself as "on track".
"""
from __future__ import annotations

import datetime as dt
import statistics

# Traffic light states, ordered from good to bad. The order IS the ranking for
# aggregation at goal level (the worst state wins).
#
# `observing` is deliberately FIRST: a KPI in observation mode should never
# decide the state of a goal. It thus loses against every other state — and
# only remains if really everything on the goal is still collecting a baseline.
STATUS_ORDER = ("observing", "done", "on_track", "at_risk", "blind", "behind")
_RANK = {s: i for i, s in enumerate(STATUS_ORDER)}

# How a KPI is evaluated.
#   path     — the path from baseline to target (default)
#   corridor — maintenance: "stay above/below/between"
#   observe  — measures and plots, but does not evaluate (yet)
MODES = ("path", "corridor", "observe")

# Share of the corridor width from which it counts as "close to the edge", if
# the KPI specifies nothing else. Only meaningful when both bounds are set.
CORRIDOR_WARN_SHARE = 0.10

# When a measurement counts as stale, if the KPI says nothing else.
DEFAULT_STALE_DAYS = 14

# Pace thresholds (actual attainment divided by expected attainment).
# Kept as a *figure* — `pace` is still reported because it reads well. But it is
# not suitable for the traffic light, see RUECKSTAND_* below.
PACE_ON_TRACK = 0.95
PACE_AT_RISK = 0.80

# The traffic light evaluates the **shortfall as a share of the total distance**,
# not the ratio of attainments.
#
# Reason: `pace = attainment / expected` is numerically unstable at the start. The
# day after creation attainment is exactly 0 — entirely correct, nothing has
# happened yet — so the quotient is 0 no matter how tiny the expectation. Freshly
# created goals thus showed `behind` after ONE day while missing only 0.2 of 29.5
# percentage points.
#
# The shortfall as a share of the distance does not have this problem: 0.7 %
# shortfall is 0.7 %, whether on the first or the hundredth day.
#
# And it is NOT more lenient where it matters. The expectation grows over time — a
# KPI that is really stuck crosses the threshold within a few weeks. In the middle
# and at the end of the distance both rules judge practically the same; they only
# differ where the old rule was simply wrong.
RUECKSTAND_ON_TRACK = 0.05   # up to 5 % of the distance behind plan: fine
RUECKSTAND_AT_RISK = 0.15    # up to 15 %: at risk


def _num(value) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _date(value) -> dt.date | None:
    """Accepts date, datetime and ISO strings (also with a time part)."""
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return dt.date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None


def normalize_milestones(raw, start: dt.date | None, due: dt.date | None) -> list[dict]:
    """Clean up milestones: only with date AND number, sorted, within the period.

    A milestone outside start and due date is dropped instead of silently
    included — it would bend the expected path without anyone understanding
    why.
    """
    out = []
    for m in (raw or []):
        if not isinstance(m, dict):
            continue
        d, v = _date(m.get("date")), _num(m.get("value"))
        if d is None or v is None:
            continue
        if start and d <= start:
            continue
        if due and d >= due:
            continue
        out.append({"date": d, "value": v, "label": str(m.get("label") or "").strip()[:80]})
    out.sort(key=lambda m: m["date"])
    return out


def _expected_value(defn: dict, milestones: list[dict], heute: dt.date) -> float | None:
    """Where should the value be today? Piecewise linear through the milestones.

    Without milestones this is the plain straight line from baseline to
    target. With them the expectation follows the actually planned course —
    when progress is expected to be faster at the beginning than at the end,
    a straight line would judge the pace in the final phase too harshly.
    """
    start, due = defn["start_date"], defn["due_date"]
    if not start or not due or due <= start or defn["baseline"] is None or defn["target"] is None:
        return None
    punkte = ([(start, defn["baseline"])]
              + [(m["date"], m["value"]) for m in milestones]
              + [(due, defn["target"])])
    if heute <= punkte[0][0]:
        return punkte[0][1]
    if heute >= punkte[-1][0]:
        return punkte[-1][1]
    for (d0, v0), (d1, v1) in zip(punkte, punkte[1:]):
        if d0 <= heute <= d1:
            spanne = (d1 - d0).days or 1
            return v0 + (v1 - v0) * ((heute - d0).days / spanne)
    return punkte[-1][1]


def normalize_def(props: dict | None) -> dict:
    """Bring the KPI definition from `properties` into a fixed shape.

    Missing values are allowed — they lead to an honest state
    ('unknown'/'blind'), not to an exception. A half-filled KPI should not
    break the goal view.
    """
    p = props or {}
    direction = str(p.get("direction") or "up").lower()
    if direction not in ("up", "down"):
        direction = "up"
    stale = _num(p.get("stale_after_days"))
    weight = _num(p.get("weight"))
    fenster = _num(p.get("window_days"))
    mode = str(p.get("mode") or "path").lower()
    if mode not in MODES:
        mode = "path"
    return {
        "unit": (p.get("unit") or "").strip(),
        "direction": direction,
        "baseline": _num(p.get("baseline")),
        "target": _num(p.get("target")),
        "start_date": _date(p.get("start_date")),
        "due_date": _date(p.get("due_date")),
        "aggregation": (p.get("aggregation") or "last").lower(),
        # Window in days over which to aggregate. Without a value the whole
        # history counts — so the previous behaviour stays unchanged.
        "window_days": int(fenster) if fenster and fenster > 0 else None,
        # Evaluation mode and corridor bounds.
        "mode": mode,
        "min": _num(p.get("min")),
        "max": _num(p.get("max")),
        "warn_margin": _num(p.get("warn_margin")),
        "weight": weight if weight and weight > 0 else 1.0,
        "stale_after_days": int(stale) if stale and stale > 0 else DEFAULT_STALE_DAYS,
        # When the SOURCE last answered cleanly — regardless of whether a new
        # value was created. The collector sets this on every successful fetch
        # (`kpi_collector`). See `_frische_pruefen`.
        "source_ok_at": p.get("source_ok_at"),
        "source": p.get("source") if isinstance(p.get("source"), dict) else {"kind": "manual"},
        "milestones_raw": p.get("milestones") if isinstance(p.get("milestones"), list) else [],
    }


def _utc(value) -> dt.datetime | None:
    """Timestamp as a UTC-aware datetime — or None if there is none."""
    if not isinstance(value, dt.datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)


def _zeitpunkt(value) -> dt.datetime | None:
    """Like `_utc`, but also accepts an ISO string.

    Everything in `properties` comes through JSON — there a timestamp is text,
    not a datetime. Unreadable input returns None instead of raising: one
    broken value must not break the whole evaluation, it should just not count.
    """
    if isinstance(value, dt.datetime):
        return _utc(value)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return _utc(dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00")))
    except ValueError:
        return None


def _current(defn: dict, values: list[dict],
             now: dt.datetime | None = None) -> tuple[float | None, dt.datetime | None]:
    """Actual value according to the aggregation rule. `values` is sorted ascending by ts.

    **`window_days` is what turns `avg`/`median` into a ROLLING value.**
    Without a window `avg` averages over the whole history and drags the
    actual value behind forever — the longer the KPI runs, the more sluggish
    it becomes. With a window only the recent past counts.

    **`median` against measurement noise.** With a noisy sensor the single
    reading can fluctuate by a multiple of the real change over days. The median drops the single
    outlier, the mean includes it proportionally.

    If the window is empty there is **no** actual value — not the last old
    value as a substitute. Otherwise a KPI would claim a current state from
    numbers outside the window (same rule as for the sources: outage !=
    measurement). The timestamp of the last real measurement is still returned
    so the reason can say how old it is.
    """
    if not values:
        return None, None
    last_ts = values[-1].get("ts")
    genutzt = values
    fenster = defn.get("window_days")
    if fenster:
        grenze = (now or dt.datetime.now(dt.timezone.utc)) - dt.timedelta(days=fenster)
        if grenze.tzinfo is None:
            grenze = grenze.replace(tzinfo=dt.timezone.utc)
        # Values without a usable timestamp stay in — dropping them would mean
        # losing a measurement over a missing side detail.
        genutzt = [v for v in values
                   if (_utc(v.get("ts")) or grenze) >= grenze]
    nums = [_num(v.get("value")) for v in genutzt]
    nums = [n for n in nums if n is not None]
    if not nums:
        return None, last_ts
    agg = defn["aggregation"]
    if agg == "sum":
        return sum(nums), last_ts
    if agg == "avg":
        return sum(nums) / len(nums), last_ts
    if agg == "median":
        return statistics.median(nums), last_ts
    if agg == "min":
        return min(nums), last_ts
    if agg == "max":
        return max(nums), last_ts
    return nums[-1], last_ts  # 'last' = default


# ── Trend ─────────────────────────────────────────────────────────────────
# Minimum number of values before any direction is claimed at all. With two
# points every statement is chance.
TREND_MIN_SAMPLES = 4
# Window: only the recent past counts. A year-old history says nothing about
# where things are going RIGHT NOW.
TREND_WINDOW_DAYS = 56
# From when it counts as "moving": slope per week, measured as a share of the
# target span (|target - baseline|).
# Relative, not absolute — otherwise a KPI in grams is always "moving" and one
# in percent always "stagnating".
TREND_FLAT_SHARE = 0.02


def trend(values: list[dict], defn: dict, now: dt.datetime | None = None) -> dict:
    """Direction of the last weeks: `up`, `down`, `flat` — or none at all.

    Same rule as for the sources: **outage != measurement.** Too few points or
    too short a time base yield `None`, NOT "stagnating" — otherwise a KPI we
    know nothing about looks like one that demonstrably does not move. That is
    the more expensive mistake.

    Method: slope of the least-squares regression line over time in weeks.
    Additionally `trend_r2` as a measure of how well the line fits the points —
    a slope without a goodness-of-fit measure tempts one to take noise for a
    development.

    `trend_good` says whether the direction helps the goal: for a cost
    reduction goal "falling" is good, for a growth goal "rising".
    """
    leer = {"trend": None, "trend_per_week": None, "trend_r2": None,
            "trend_good": None, "trend_samples": 0}
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)

    punkte = []
    for v in values:
        ts, wert = v.get("ts"), _num(v.get("value"))
        if not isinstance(ts, dt.datetime) or wert is None:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=dt.timezone.utc)
        if (now - ts).days <= TREND_WINDOW_DAYS:
            punkte.append((ts, wert))
    if len(punkte) < TREND_MIN_SAMPLES:
        return {**leer, "trend_samples": len(punkte)}

    punkte.sort(key=lambda p: p[0])
    t0 = punkte[0][0]
    xs = [(ts - t0).total_seconds() / (7 * 86400) for ts, _ in punkte]   # weeks
    ys = [w for _, w in punkte]
    spanne_x = xs[-1] - xs[0]
    if spanne_x <= 0:
        # Everything measured on the same day — a slope "per week" would be made up.
        return {**leer, "trend_samples": len(punkte)}

    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    if sxx == 0:
        return {**leer, "trend_samples": n}
    steigung = sxy / sxx

    syy = sum((y - my) ** 2 for y in ys)
    r2 = (sxy * sxy) / (sxx * syy) if syy > 0 else 1.0

    ziel, basis = defn.get("target"), defn.get("baseline")
    spanne = abs(ziel - basis) if (ziel is not None and basis is not None) else None
    if spanne:
        schwelle = spanne * TREND_FLAT_SHARE
    else:
        # Without a target span only the magnitude of the values themselves helps.
        schwelle = (abs(my) or 1.0) * TREND_FLAT_SHARE

    if abs(steigung) < schwelle:
        richtung = "flat"
    else:
        richtung = "up" if steigung > 0 else "down"

    gewollt = defn.get("direction") or "up"
    gut = None if richtung == "flat" else (richtung == gewollt)

    return {"trend": richtung, "trend_per_week": steigung, "trend_r2": r2,
            "trend_good": gut, "trend_samples": n}


def _values_in_window(defn: dict, values: list[dict],
                      now: dt.datetime) -> list[dict]:
    """The values the evaluation may see — same rule as `_current`."""
    fenster = defn.get("window_days")
    if not fenster:
        return values
    grenze = now - dt.timedelta(days=fenster)
    return [v for v in values if (_utc(v.get("ts")) or grenze) >= grenze]


def _im_korridor(defn: dict, wert: float) -> bool:
    if defn["min"] is not None and wert < defn["min"]:
        return False
    if defn["max"] is not None and wert > defn["max"]:
        return False
    return True


def _corridor(defn: dict, out: dict, current: float, values: list[dict],
              now: dt.datetime) -> dict:
    """Maintenance goal: "stay above/below/between".

    **Attainment here is the share of measurements inside the corridor**, not
    the distance covered. This keeps the number between 0 and 1 so it can be
    averaged with path goals on the same goal — a maintenance KPI and a growth
    KPI may hang side by side on one goal.

    **There is no "done" before the due date.** A goal that combines
    "reduce X" with "keep Y the same" would otherwise break here: modelled as
    growth, it could show done after a few days, although "hold the same"
    applies until the due date.
    Maintenance is only fulfilled at the end.
    """
    lo, hi = defn["min"], defn["max"]
    if lo is None and hi is None:
        out["status"] = "blind"
        out["reason"] = "Erhaltungsziel ohne Grenze (min oder max fehlt)"
        return out
    if lo is not None and hi is not None and lo > hi:
        out["status"] = "blind"
        out["reason"] = f"Korridor verdreht (min {lo} liegt über max {hi})"
        return out

    betrachtet = _values_in_window(defn, values, now)
    zahlen = [n for n in (_num(v.get("value")) for v in betrachtet) if n is not None]
    drin = [n for n in zahlen if _im_korridor(defn, n)]
    out["attainment"] = (len(drin) / len(zahlen)) if zahlen else None
    out["in_corridor"] = _im_korridor(defn, current)
    out["corridor"] = {"min": lo, "max": hi}

    grenze_txt = (f"zwischen {lo} und {hi}" if lo is not None and hi is not None
                  else (f"über {lo}" if lo is not None else f"unter {hi}"))
    anteil = f"{out['attainment']:.0%} der Messungen im Korridor" if zahlen else ""

    if not out["in_corridor"]:
        out["status"] = "behind"
        out["reason"] = f"{current} liegt außerhalb ({grenze_txt}) — {anteil}"
        return out

    # "Close to the edge" only if a distance can be determined: either given
    # explicitly or as a share of a width bounded on both sides. With only one
    # bound there is no width — then rather no warning zone than a made-up one.
    rand = defn["warn_margin"]
    if rand is None and lo is not None and hi is not None:
        rand = (hi - lo) * CORRIDOR_WARN_SHARE
    if rand and rand > 0:
        knapp = ((lo is not None and current - lo <= rand)
                 or (hi is not None and hi - current <= rand))
        if knapp:
            out["status"] = "at_risk"
            out["reason"] = f"{current} ist knapp am Rand ({grenze_txt}) — {anteil}"
            return out

    due = defn["due_date"]
    if due and now.date() > due:
        out["status"] = "done"
        out["reason"] = f"bis zum Termin gehalten ({grenze_txt}) — {anteil}"
        return out
    out["status"] = "on_track"
    out["reason"] = f"{current} liegt im Korridor ({grenze_txt}) — {anteil}"
    return out


def _observe(defn: dict, out: dict, values: list[dict], now: dt.datetime) -> dict:
    """Observation mode: measures and plots, but does not evaluate.

    Previously there was no separate state for "still collecting a baseline" —
    a KPI without a target became `blind`. So a KPI deliberately not yet
    evaluated looked exactly like one whose measurement fell asleep. That is
    the same confusion "blind != green" already resolved, one level further.

    A part in observation mode therefore affects neither the average nor the
    traffic light of the goal (see `aggregate`).
    """
    betrachtet = _values_in_window(defn, values, now)
    out["status"] = "observing"
    spanne = ""
    zahlen = [n for n in (_num(v.get("value")) for v in betrachtet) if n is not None]
    if len(zahlen) >= 2:
        spanne = f", Streuung {max(zahlen) - min(zahlen):.3g} {defn['unit']}".rstrip()
    tage = ""
    erste = _utc(betrachtet[0].get("ts")) if betrachtet else None
    if erste:
        tage = f" über {max((now - erste).days, 0)} Tage"
    out["reason"] = (f"Basis wird gesammelt: {len(zahlen)} Messwerte{tage}{spanne} "
                     "— noch kein Zielwert")
    return out


def compute(props: dict | None, values: list[dict],
            now: dt.datetime | None = None) -> dict:
    """Progress of a single KPI.

    `values`: [{'ts': datetime, 'value': float}, ...] sorted ascending.
    The result always contains `status` and `reason` — `reason` explains in
    plain text why the state is what it is (the UI shows it as a tooltip).
    """
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)
    defn = normalize_def(props)
    current, last_ts = _current(defn, values, now)

    out = {
        **{k: defn[k] for k in ("unit", "direction", "target", "aggregation",
                                "window_days", "mode", "weight")},
        "baseline": defn["baseline"],
        "current": current,
        "current_ts": last_ts.isoformat() if isinstance(last_ts, dt.datetime) else None,
        "samples": len(values),
        "attainment": None,
        "expected": None,
        "pace": None,
        "status": "blind",
        "reason": "noch nie gemessen",
        # Direction of the last weeks. Present even if the goal evaluation
        # below aborts — "where is it going" is independent of whether a
        # target is set.
        **trend(values, defn, now),
        # Distance to the expected value in the KPI's unit.
        # Positive = behind plan, negative = ahead of plan. The sign logic
        # depends on direction: for a reduction goal "too high" is behind,
        # for a growth goal "too low".
        "behind_by": None,
    }

    if current is None:
        # Distinguish "never measured" from "nothing fresh in the window" — one
        # is an empty start, the other a measurement that fell asleep.
        if values and defn["window_days"]:
            alter = ""
            if isinstance(_utc(last_ts), dt.datetime):
                alter = f", letzte vor {(now - _utc(last_ts)).days} Tagen"
            out["reason"] = (f"keine Messung in den letzten "
                             f"{defn['window_days']} Tagen{alter}")
        elif values:
            out["reason"] = "kein Zahlenwert in der Reihe"
        return out

    # A stale measurement beats any evaluation of content — first trust in the
    # number, then a statement about the goal.
    if isinstance(last_ts, dt.datetime):
        age = (now - (last_ts if last_ts.tzinfo else last_ts.replace(tzinfo=dt.timezone.utc))).days
        if age > defn["stale_after_days"]:
            # Warning: "value is constant" is NOT the same as "source is dead", but
            # looked exactly the same up to here. A smart-home adapter may take `last_changed`
            # as the measurement time (correctly!), and the uniqueness key prevents a
            # second row for the same value — so a sensor reporting the same number for
            # days creates no new data point. Example: a meter reading staying
            # constant for days while the source answered cleanly every day.
            # => If the source has confirmed an answer since then, the value is current
            #   and the KPI is NOT blind. Without `source_ok_at` the old behaviour
            #   stays — a KPI that never had a fetch still counts as stale.
            bestaetigt = _zeitpunkt(defn.get("source_ok_at"))
            if bestaetigt is None or (now - bestaetigt).days > defn["stale_after_days"]:
                out["reason"] = f"letzte Messung vor {age} Tagen"
                return out
            out["unchanged_days"] = age
            out["source_confirmed_at"] = bestaetigt.isoformat()

    # The two modes besides the path model. Deliberately AFTER the freshness
    # check — a maintenance goal and a baseline collection are worthless too if
    # the measurement fell asleep.
    if defn["mode"] == "observe":
        return _observe(defn, out, values, now)
    if defn["mode"] == "corridor":
        return _corridor(defn, out, current, values, now)

    if defn["target"] is None:
        out["status"] = "blind"
        out["reason"] = "kein Zielwert hinterlegt"
        return out

    # Baseline: as configured, otherwise the first value ever measured (then the
    # start is simply the day of the first measurement — better than 0, which
    # would distort every statement for "from 90 to 80").
    baseline = defn["baseline"]
    if baseline is None:
        baseline = _num(values[0].get("value"))
        out["baseline"] = baseline
    if baseline is None:
        out["reason"] = "keine Basis ermittelbar"
        return out

    span = defn["target"] - baseline
    if span == 0:
        attainment = 1.0 if current == defn["target"] else 0.0
    else:
        attainment = (current - baseline) / span
    out["attainment"] = attainment

    if attainment >= 1.0:
        out["status"] = "done"
        out["reason"] = "Zielwert erreicht"
        return out

    start, due = defn["start_date"], defn["due_date"]
    if not due:
        # A KPI without a due date measures a state, not a pace ("stay below X").
        out["status"] = "at_risk" if attainment >= PACE_AT_RISK else "behind"
        out["reason"] = f"{attainment:.0%} des Zielwerts, kein Termin gesetzt"
        return out

    start = start or (values[0].get("ts").date() if isinstance(values[0].get("ts"), dt.datetime) else None)
    if not start or due <= start:
        out["status"] = "at_risk" if attainment >= PACE_AT_RISK else "behind"
        out["reason"] = "Zeitraum unbrauchbar (Start fehlt oder liegt nach dem Termin)"
        return out

    # The expectation follows the planned path through the milestones — without
    # any it is the straight line from baseline to target.
    meilensteine = normalize_milestones(defn["milestones_raw"], start, due)
    out["milestones"] = [
        {"date": m["date"].isoformat(), "value": m["value"], "label": m["label"],
         # position on the bar = attainment of this milestone
         "attainment": (m["value"] - baseline) / span if span else None}
        for m in meilensteine
    ]
    # The planned path as a series — so the chart in the UI draws the same path
    # the traffic light evaluates.
    # Deliberately here and not in the frontend: otherwise there would be two
    # computations for the same line, and one would eventually drift from the other.
    out["plan_path"] = [
        {"date": start.isoformat(), "value": baseline},
        *[{"date": m["date"].isoformat(), "value": m["value"]} for m in meilensteine],
        {"date": due.isoformat(), "value": defn["target"]},
    ]

    naechster = next((m for m in meilensteine if m["date"] >= now.date()), None)
    out["next_milestone"] = ({"date": naechster["date"].isoformat(),
                              "value": naechster["value"], "label": naechster["label"]}
                             if naechster else None)

    erwarteter_wert = _expected_value(defn, meilensteine, now.date())
    out["expected_value"] = erwarteter_wert
    if erwarteter_wert is not None and current is not None:
        # For a reduction goal a value that is too HIGH is behind, for a growth
        # goal one that is too low. One sign for both cases so the UI does not have to
        # evaluate the direction itself (and get it wrong).
        out["behind_by"] = (current - erwarteter_wert if defn["direction"] == "down"
                            else erwarteter_wert - current)
    if erwarteter_wert is None or span == 0:
        expected = 0.0
    else:
        expected = max(0.0, min(1.0, (erwarteter_wert - baseline) / span))
    out["expected"] = expected

    if expected <= 0:
        out["status"] = "on_track"
        out["reason"] = ("Zeitraum beginnt heute — noch kein Vorsprung nötig"
                         if now.date() <= start else "Zeitraum hat noch nicht begonnen")
        return out

    out["pace"] = attainment / expected
    # Shortfall as a share of the total distance — see RUECKSTAND_* above.
    rueckstand = expected - attainment
    if rueckstand <= RUECKSTAND_ON_TRACK:
        out["status"] = "on_track"
    elif rueckstand <= RUECKSTAND_AT_RISK:
        out["status"] = "at_risk"
    else:
        out["status"] = "behind"
    ziel_text = ""
    if naechster:
        ziel_text = (f"; nächstes Zwischenziel {naechster['value']:g} "
                     f"bis {naechster['date'].strftime('%d.%m.')}")
    out["reason"] = (f"{attainment:.0%} erreicht, erwartet wären {expected:.0%} "
                     f"({(due - now.date()).days} Tage bis zum Termin){ziel_text}")
    return out


def worst(statuses) -> str:
    """Worst state of a set — the rule for goals with several KPIs. A green
    goal must not hide a red KPI."""
    known = [s for s in statuses if s in _RANK]
    if not known:
        return "blind"
    return max(known, key=lambda s: _RANK[s])


def aggregate(parts: list[dict]) -> dict:
    """Progress of a goal from its KPIs AND subgoals.

    `parts`: [{'attainment': float|None, 'status': str, 'weight': float}, ...]
    Weighted average over everything that yields an attainment; the state is
    the worst one. Parts without attainment (blind) do not count in the
    average but do show through in the state — otherwise a dead measurement
    would sugar-coat the average.

    **Parts in observation mode do not count at all.** Neither in the average
    nor in the traffic light — unlike `blind` this is not a deficiency but
    intentional. A goal where a KPI is still collecting a baseline should look
    neither worse nor better because of it. If ALL parts are only collecting a
    baseline, the goal honestly stays "observing".
    """
    beobachtend = [p for p in parts if p.get("status") == "observing"]
    bewertet = [p for p in parts if p.get("status") != "observing"]
    rated = [p for p in bewertet if p.get("attainment") is not None]
    total_w = sum(max(0.0, float(p.get("weight") or 1.0)) for p in rated)
    attainment = None
    if rated and total_w > 0:
        attainment = sum(
            float(p["attainment"]) * max(0.0, float(p.get("weight") or 1.0)) for p in rated
        ) / total_w
    if bewertet:
        status = worst([p.get("status") for p in bewertet])
    else:
        status = "observing" if beobachtend else worst([])
    return {
        "attainment": attainment,
        "status": status,
        "parts": len(parts),
        "observing": len(beobachtend),
    }
