"""Collector for automatic KPIs.

Fetches, at a fixed interval, the values of all KPIs that have a source
configured and writes them to `claraos_kb_kpi_values`.

Important: **an outage is never silent.** If a source delivers nothing, NO
value is written (a 0 would be a lie); instead `properties.source_error` is
set on the object — the card shows the plain-text message, and since no fresh
value arrives, the traffic light flips to "blind" after the staleness period
anyway. Without this combination, failures elsewhere looked like success
(a push that returned 200 but never arrived, a search outage that looked like
"0 results").

Runs only on the leader (`services/leader.py`) — otherwise, with several API
instances, all of them would query the same external systems at once.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging

from database import get_pool

# Service path: the scheduled collector measures every due KPI of every user,
# plain pool (superuser) on purpose. The "collect now" route passes its own
# user_tx connection into collect_one instead.
from services import kpi_sources

logger = logging.getLogger(__name__)

# Collector tick. How often a SINGLE KPI is actually fetched is controlled by
# `properties.source.every_minutes` (default below).
TICK_S = 900                      # 15 min
DEFAULT_EVERY_MINUTES = 60
MIN_EVERY_MINUTES = 5

_task: asyncio.Task | None = None


def _props(raw) -> dict:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return {}
    return raw or {}


def _every_minutes(source: dict) -> int:
    try:
        val = int(source.get("every_minutes") or DEFAULT_EVERY_MINUTES)
    except (TypeError, ValueError):
        val = DEFAULT_EVERY_MINUTES
    return max(MIN_EVERY_MINUTES, val)


async def collect_one(conn, row, *, force: bool = False) -> dict:
    """Fetch one KPI. Returns a small log record (for log/API)."""
    kpi_id = str(row["id"])
    props = _props(row["properties"])
    source = props.get("source") if isinstance(props.get("source"), dict) else {}
    kind = (source.get("kind") or "manual").lower()
    out = {"kpi_id": kpi_id, "title": row["title"], "kind": kind}

    if kind == "manual":
        return {**out, "skipped": "manuelle Kennzahl"}

    if not force:
        last = await conn.fetchval(
            "SELECT max(ts) FROM claraos_kb_kpi_values WHERE kpi_id = $1::uuid AND source = $2",
            kpi_id, kind)
        if last is not None:
            age_min = (dt.datetime.now(dt.timezone.utc) - last).total_seconds() / 60
            if age_min < _every_minutes(source):
                return {**out, "skipped": f"zuletzt vor {int(age_min)} min geholt"}

    result = await kpi_sources.fetch(source, row["owner"])

    if result.skipped:
        return {**out, "skipped": result.skipped}

    if result.error:
        # Write the error to the object — visible, with timestamp.
        props["source_error"] = {
            "at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "message": result.error[:500],
        }
        await conn.execute(
            "UPDATE claraos_kb_objects SET properties = $2::jsonb WHERE id = $1::uuid",
            kpi_id, json.dumps(props))
        logger.warning("[kpi-collector] %s (%s): %s", row["title"], kind, result.error)
        return {**out, "error": result.error}

    # Time of measurement if the source knows it (see FetchResult.ts) —
    # otherwise the fetch time. Thanks to the uniqueness key an unchanged
    # value does not land in the series twice.
    ts = dt.datetime.now(dt.timezone.utc)
    if result.ts:
        try:
            parsed = dt.datetime.fromisoformat(str(result.ts).replace("Z", "+00:00"))
            ts = parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
        except ValueError:
            logger.warning("[kpi-collector] %s: unlesbarer Zeitstempel %r — nehme jetzt",
                           row["title"], result.ts)
    await conn.execute(
        """
        INSERT INTO claraos_kb_kpi_values (kpi_id, ts, value, source, created_by)
        VALUES ($1::uuid, $2, $3, $4, 'collector')
        ON CONFLICT (kpi_id, ts, source) DO UPDATE SET value = EXCLUDED.value
        """,
        kpi_id, ts, result.value, kind)

    erholt = props.pop("source_error", None) is not None
    # Warning: proof that the SOURCE answered — regardless of whether a new data
    # point was created. Without it, "value is constant" and "source is dead" are
    # indistinguishable: a sensor that reports the same number for days creates no
    # second row because of the uniqueness key, and the KPI flipped to "blind"
    # after the staleness period — even though it was measured cleanly every day
    # (e.g. a meter that legitimately reports the same reading for days).
    # `kpi_progress` reads this field and then does not let the KPI go stale.
    props["source_ok_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    await conn.execute(
        "UPDATE claraos_kb_objects SET properties = $2::jsonb WHERE id = $1::uuid",
        kpi_id, json.dumps(props))
    if erholt:
        # Make recovery as visible as the outage.
        logger.warning("[kpi-collector] %s (%s): liefert wieder Werte", row["title"], kind)
    return {**out, "value": result.value}


async def _due_rows(conn) -> list:
    """All KPIs with a source other than 'manual'.

    The visibility clause is intentionally missing here: the collector is not
    a user, it works on behalf of the respective owner (`row['owner']`) — and
    the adapter then uses exactly that owner's access.
    """
    return await conn.fetch(
        """
        SELECT id, title, owner, properties
        FROM claraos_kb_objects
        WHERE type = 'kpi' AND deleted_at IS NULL
          AND coalesce(properties -> 'source' ->> 'kind', 'manual') <> 'manual'
        ORDER BY updated_at DESC
        LIMIT 500
        """)


async def run_once(*, force: bool = False) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await _due_rows(conn)
        results = []
        for row in rows:
            try:
                results.append(await collect_one(conn, row, force=force))
            except Exception as exc:  # noqa: BLE001 — one broken KPI must not end the run
                logger.exception("[kpi-collector] %s unerwartet gescheitert", row["title"])
                results.append({"kpi_id": str(row["id"]), "title": row["title"],
                                "error": f"unerwartet: {exc}"})
    return results


async def _loop() -> None:
    logger.warning("[kpi-collector] gestartet (Takt %ss)", TICK_S)
    while True:
        try:
            results = await run_once()
            geholt = sum(1 for r in results if "value" in r)
            fehler = sum(1 for r in results if r.get("error"))
            if geholt or fehler:
                logger.warning("[kpi-collector] %d Werte geholt, %d Ausfälle", geholt, fehler)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[kpi-collector] Durchlauf gescheitert")
        await asyncio.sleep(TICK_S)


def start_background() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.get_event_loop().create_task(_loop())


def stop_background() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        _task = None
