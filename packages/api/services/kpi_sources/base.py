"""Common shape of all KPI sources.

Important: the key part of this module is the distinction between the three
outcomes. A source that delivers nothing must NOT look like a source that
measured 0 — and an outage must not look like "nothing to do". Exactly this
confusion has cost half a day of debugging more than once elsewhere.

- `value`   -> real measurement, gets written
- `skipped` -> all fine, but there was nothing to fetch (e.g. a manual KPI,
              or the fetch interval has not elapsed yet)
- `error`   -> outage. Made visible on the object, NEVER swallowed.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class FetchResult:
    value: float | None = None
    error: str | None = None
    skipped: str | None = None
    # Warning: time of the MEASUREMENT, not of the fetch. Without it, every
    # source that keeps its last value fakes freshness: a smart-home hub keeps
    # returning a sensor reading from four weeks ago — the collector would
    # write it as "measured now" and the traffic light would stay green even
    # though nothing was measured. Exactly the self-deception the
    # "blind" (white) state is built against. If empty, the fetch time applies.
    ts: str | None = None

    @property
    def ok(self) -> bool:
        return self.value is not None and self.error is None


def to_float(raw, what: str = "Wert") -> FetchResult:
    """Raw value -> number. Knows the special cases that come from devices."""
    if raw is None:
        return FetchResult(error=f"{what} fehlt in der Antwort")
    text = str(raw).strip().replace(",", ".")
    if text == "":
        return FetchResult(error=f"{what} ist leer")
    # Smart-home hubs report these instead of a number when a device is
    # offline — that is an outage, not a measurement.
    if text.lower() in ("unavailable", "unknown", "none", "null", "nan"):
        return FetchResult(error=f"Quelle meldet „{text}“ statt einer Zahl")
    if text.lower() in ("on", "true", "open", "home"):
        return FetchResult(value=1.0)
    if text.lower() in ("off", "false", "closed", "not_home"):
        return FetchResult(value=0.0)
    try:
        return FetchResult(value=float(text))
    except ValueError:
        return FetchResult(error=f"{what} ist keine Zahl: {text[:60]!r}")
