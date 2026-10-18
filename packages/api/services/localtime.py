"""One rule for wall-clock times: a time WITHOUT a zone is local time.

Users and the assistant say "Tuesday 3 pm" and mean the clock on the wall. Every
write path used to read a naive ISO string as UTC, which put each appointment
two hours late in summer (one in winter) while the assistant confidently
repeated the time the user had asked for.

Rules implemented here:
  * naive datetime ("2026-10-06T15:00" / "...:00")   -> LOCAL_TZ
  * explicit offset or "Z"                            -> taken as given
  * date only ("2026-10-06")                          -> a date (all-day)

Every read path returns the local wall-clock time WITH its offset, plus a
human-readable label, so a reader never has to convert UTC in its head.
"""
from __future__ import annotations

import os
import re
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

LOCAL_TZ = ZoneInfo(os.environ.get("CLARAOS_TZ", "Europe/Berlin"))
LOCAL_TZ_NAME = str(LOCAL_TZ)

_WEEKDAYS = ("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So")


def parse_iso(value: str) -> datetime | date:
    """ISO string -> aware datetime (naive = local time) or date (all-day).

    Raises ValueError for anything that is not ISO 8601.
    """
    v = (value or "").strip()
    if not v:
        raise ValueError("empty time value")
    if "T" not in v and " " not in v.strip():
        return date.fromisoformat(v[:10])
    dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=LOCAL_TZ)
    return dt


def to_utc(value: str) -> datetime:
    """Aware UTC datetime for a datetime string (naive = local time)."""
    v = parse_iso(value)
    if not isinstance(v, datetime):
        v = datetime(v.year, v.month, v.day, tzinfo=LOCAL_TZ)
    return v.astimezone(timezone.utc)


def to_local(dt: datetime) -> datetime:
    """Aware datetime in local time (a naive input counts as local)."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=LOCAL_TZ)
    return dt.astimezone(LOCAL_TZ)


def label(dt: datetime | date | None) -> str:
    """'Di 06.10.2026 15:00 (+02:00)' for a datetime, 'Di 06.10.2026 (ganztägig)' for a date."""
    if dt is None:
        return ""
    if not isinstance(dt, datetime):
        return f"{_WEEKDAYS[dt.weekday()]} {dt.strftime('%d.%m.%Y')} (ganztägig)"
    loc = to_local(dt)
    off = loc.strftime("%z")
    off = f"{off[:3]}:{off[3:]}" if len(off) == 5 else off
    return f"{_WEEKDAYS[loc.weekday()]} {loc.strftime('%d.%m.%Y %H:%M')} ({off})"


def iso_local(dt: datetime | date | None) -> str:
    """ISO with the local offset ('2026-10-06T15:00:00+02:00'), or the date."""
    if dt is None:
        return ""
    if not isinstance(dt, datetime):
        return dt.isoformat()
    return to_local(dt).isoformat()


_TZID_RE = re.compile(r"TZID=([^;:]+)", re.I)


def from_ical(value: str, params: str = "") -> datetime | date | None:
    """iCal DATE / DATE-TIME (+ params such as 'TZID=Europe/Berlin') -> aware datetime or date.

    A DATE-TIME without 'Z' and without TZID is a "floating" time: per RFC 5545
    it means local time, so it is read as LOCAL_TZ, not as UTC.
    """
    v = (value or "").strip()
    if not v:
        return None
    try:
        if "VALUE=DATE" in (params or "").upper() and "T" not in v:
            return datetime.strptime(v[:8], "%Y%m%d").date()
        if v.endswith("Z"):
            return datetime.strptime(v, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        if "T" in v:
            tz = LOCAL_TZ
            m = _TZID_RE.search(params or "")
            if m:
                try:
                    tz = ZoneInfo(m.group(1).strip('"'))
                except Exception:  # noqa: BLE001 - unknown zone: fall back to local
                    tz = LOCAL_TZ
            return datetime.strptime(v, "%Y%m%dT%H%M%S").replace(tzinfo=tz)
        if len(v) == 8:
            return datetime.strptime(v, "%Y%m%d").date()
    except ValueError:
        return None
    return None
