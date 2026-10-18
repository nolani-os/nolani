"""Cross-instance event bus: Postgres LISTEN/NOTIFY.

Replaces process-local fan-outs (WS broadcasts and the like) across instances —
deliberately WITHOUT Redis (Postgres is the established common denominator).

Contract:
- The caller delivers to ITS OWN local receivers itself; `publish()` only
  relays the event to the OTHER instances (own events are dropped based on
  the src field).
- Handlers: `register(topic, async_handler)` — receives the `data` dict.
- NOTIFY payload limit is ~8000 bytes -> compact events only (IDs, not blobs).
"""

import asyncio
import json
import logging
import secrets

logger = logging.getLogger(__name__)

CHANNEL = "claraos_bus"
INSTANCE_ID = secrets.token_hex(8)

_handlers: dict[str, list] = {}


def register(topic: str, handler) -> None:
    _handlers.setdefault(topic, []).append(handler)


async def publish(topic: str, data: dict) -> None:
    """Relay an event to the other instances. Errors are never fatal (local
    delivery has already happened) — only a warning."""
    try:
        from database import get_pool
        payload = json.dumps({"t": topic, "src": INSTANCE_ID, "d": data})
        if len(payload) > 7500:
            logger.warning("[pg-bus] Event %s zu groß (%dB) — verworfen", topic, len(payload))
            return
        pool = await get_pool()
        await pool.execute("SELECT pg_notify($1, $2)", CHANNEL, payload)
    except Exception as exc:
        logger.warning("[pg-bus] publish(%s) fehlgeschlagen: %s", topic, exc)


def start() -> None:
    """Call in the lifespan of EVERY instance (per-instance infrastructure)."""
    asyncio.get_event_loop().create_task(_listen_loop())


def _dispatch(payload: str) -> None:
    try:
        evt = json.loads(payload)
        if evt.get("src") == INSTANCE_ID:
            return
        for h in _handlers.get(evt.get("t", ""), []):
            asyncio.get_event_loop().create_task(h(evt.get("d") or {}))
    except Exception as exc:
        logger.warning("[pg-bus] dispatch-Fehler: %s", exc)


async def _listen_loop() -> None:
    import asyncpg

    from database import _build_db_url

    while True:
        conn = None
        try:
            conn = await asyncpg.connect(_build_db_url(), command_timeout=10)
            await conn.add_listener(CHANNEL, lambda c, pid, ch, payload: _dispatch(payload))
            logger.warning("[pg-bus] LISTEN aktiv (instance %s)", INSTANCE_ID)
            while True:
                await asyncio.sleep(30)
                await conn.fetchval("SELECT 1")
        except Exception as exc:
            logger.warning("[pg-bus] Verbindung verloren, Reconnect in 15s: %s", exc)
            try:
                if conn:
                    await conn.close()
            except Exception:
                pass
            await asyncio.sleep(15)
