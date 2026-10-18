"""Leader election: exactly ONE api instance runs the singleton background
daemons (price alerts, verify loop, sync jobs, ...).

Mechanism: a Postgres session advisory lock on a DEDICATED connection
(not from the pool — the lock lives as long as the connection). Whoever holds
the lock is the leader and starts the daemons; all others poll and take over
when the leader fails (failover <= RETRY_S).

Deliberate limitation: daemons that have already started cannot be stopped
cleanly. If a leader loses its DB connection, its daemons keep running while
another instance may take over -> a short double-run window, with a loud
ERROR log recommending a restart. Irrelevant for single-instance operation,
a documented trade-off for multi-instance setups.
"""

import asyncio
import logging

logger = logging.getLogger(__name__)

# Constant lock key for "claraos-api singleton daemons"
LOCK_KEY = 0x00C1A0A5
RETRY_S = 60
KEEPALIVE_S = 30

_is_leader = False


def is_leader() -> bool:
    return _is_leader


def start(daemon_starter) -> None:
    """Call in the lifespan: starts the election in the background.

    daemon_starter: synchronous function that starts all singleton daemons.
    It is called at most ONCE per process (when becoming leader).
    """
    asyncio.get_event_loop().create_task(_loop(daemon_starter))


async def _loop(daemon_starter) -> None:
    global _is_leader
    import asyncpg

    from database import _build_db_url

    started = False
    while True:
        conn = None
        try:
            conn = await asyncpg.connect(_build_db_url(), command_timeout=10)
            got = await conn.fetchval("SELECT pg_try_advisory_lock($1)", LOCK_KEY)
            if not got:
                await conn.close()
                _is_leader = False
                await asyncio.sleep(RETRY_S)
                continue
            _is_leader = True
            logger.warning("[leader] Advisory-Lock gewonnen — starte Singleton-Daemons")
            if not started:
                daemon_starter()
                started = True
            while True:
                await asyncio.sleep(KEEPALIVE_S)
                await conn.fetchval("SELECT 1")
        except Exception as exc:
            _is_leader = False
            if started:
                logger.error(
                    "[leader] DB-Verbindung/Lock verloren, Daemons laufen aber weiter — "
                    "mögliches Doppel-Fenster mit neuem Leader; Instanz-Restart empfohlen (%s)",
                    exc,
                )
            else:
                logger.warning("[leader] Election-Fehler, neuer Versuch in %ss: %s", RETRY_S, exc)
            try:
                if conn:
                    await conn.close()
            except Exception:
                pass
            await asyncio.sleep(RETRY_S)
