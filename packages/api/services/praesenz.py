"""ClaraOS presence — who is around right now.

**The source is ClaraOS itself**: an open UI sends a heartbeat, and the
server remembers the time. The state is *derived* from that — only what was
measured is stored.

Important: **the key rule comes first: `UNBEKANNT` (unknown) is a state of its
own.** Someone who never sent a heartbeat is not "offline" — nothing is known
about them. The difference decides whether someone calls: "offline"
discourages, "unknown" invites a try. The UI therefore shows **no icon at all**
for UNBEKANNT, not a grey one.

Matrix presence and the Nextcloud status may complement where ClaraOS knows
nothing — but they never lead. Whoever has ClaraOS open is present; that their
Matrix client is asleep changes nothing.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from database import get_pool

logger = logging.getLogger(__name__)

# States (the UI maps them to icons)
VERFUEGBAR = "verfuegbar"
BESCHAEFTIGT = "beschaeftigt"
NICHT_STOEREN = "nicht_stoeren"
ABWESEND = "abwesend"
OFFLINE = "offline"
UNBEKANNT = "unbekannt"

MANUELL_ERLAUBT = {VERFUEGBAR, BESCHAEFTIGT, NICHT_STOEREN, ABWESEND}

# A heartbeat arrives every 60 s. 150 s of tolerance bridges one missed beat
# plus network delay — set tighter, the dot jumps to "away" on every hiccup,
# and a flickering status gets ignored instead of believed.
FRIST_AKTIV = timedelta(seconds=150)
# After that, someone was at the computer but is not active. Like MS Teams.
FRIST_ABWESEND = timedelta(minutes=15)


async def _tabelle_sicherstellen(conn) -> None:
    """Create the table if needed — this project has no migration runner,
    routers create their own tables (pattern from apps.py/assistants.py).
    The full comment including RLS is in migrations/039_praesenz.sql."""
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS claraos_praesenz (
            username         TEXT PRIMARY KEY,
            tenant_id        BIGINT NOT NULL DEFAULT 1,
            zuletzt_gesehen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            zustand          TEXT,
            zustand_bis      TIMESTAMPTZ,
            geraet           TEXT,
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)


def _ableiten(zeile: dict[str, Any] | None, jetzt: datetime) -> str:
    """Derive the displayed state from measurement + self-reported status."""
    if not zeile:
        return UNBEKANNT

    # Self-reported status beats the measurement — as long as it is valid.
    zustand = zeile.get("zustand")
    bis = zeile.get("zustand_bis")
    if zustand and (bis is None or bis > jetzt):
        return zustand

    gesehen = zeile.get("zuletzt_gesehen")
    if not gesehen:
        return UNBEKANNT
    alter = jetzt - gesehen
    if alter <= FRIST_AKTIV:
        return VERFUEGBAR
    if alter <= FRIST_ABWESEND:
        return ABWESEND
    return OFFLINE


async def herzschlag(username: str, geraet: str | None = None) -> None:
    """Heartbeat: "I am here." Sent by every open ClaraOS UI."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await _tabelle_sicherstellen(conn)
        await conn.execute("""
            INSERT INTO claraos_praesenz (username, zuletzt_gesehen, geraet, updated_at)
            VALUES ($1, NOW(), $2, NOW())
            ON CONFLICT (username) DO UPDATE
               SET zuletzt_gesehen = NOW(),
                   geraet          = COALESCE(EXCLUDED.geraet, claraos_praesenz.geraet),
                   updated_at      = NOW()
        """, username, geraet)


async def zustand_setzen(username: str, zustand: str | None,
                         minuten: int | None = None) -> None:
    """Set a self-reported status (or `None` to go back to automatic).

    `minuten` limits its duration. Without a limit, a "do not disturb"
    outlives its reason and nobody dares to write anymore.
    """
    if zustand is not None and zustand not in MANUELL_ERLAUBT:
        raise ValueError(f"unbekannter Zustand: {zustand}")
    bis = None
    if zustand is not None and minuten:
        bis = datetime.now(timezone.utc) + timedelta(minutes=minuten)

    pool = await get_pool()
    async with pool.acquire() as conn:
        await _tabelle_sicherstellen(conn)
        await conn.execute("""
            INSERT INTO claraos_praesenz (username, zustand, zustand_bis, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (username) DO UPDATE
               SET zustand = EXCLUDED.zustand,
                   zustand_bis = EXCLUDED.zustand_bis,
                   updated_at = NOW()
        """, username, zustand, bis)


async def fuer_nutzer(usernames: list[str]) -> dict[str, dict[str, Any]]:
    """State of several users. Users not found appear as UNBEKANNT.

    Security: this function checks NO permissions — it answers what was asked.
    Who may be asked about is decided by the router via team visibility.
    Presence data reveals daily routines; an open query across all accounts
    would be a movement profile.
    """
    if not usernames:
        return {}
    jetzt = datetime.now(timezone.utc)
    pool = await get_pool()
    async with pool.acquire() as conn:
        await _tabelle_sicherstellen(conn)
        zeilen = await conn.fetch(
            "SELECT username, zuletzt_gesehen, zustand, zustand_bis, geraet "
            "FROM claraos_praesenz WHERE username = ANY($1::text[])",
            usernames)
    bekannt = {z["username"]: dict(z) for z in zeilen}

    out: dict[str, dict[str, Any]] = {}
    for u in usernames:
        z = bekannt.get(u)
        zustand = _ableiten(z, jetzt)
        out[u] = {
            "zustand": zustand,
            # `selbst_gesetzt` makes the difference visible in the UI between
            # "says they are busy" and "we have not seen them for a long time".
            # Both are red, but they do not mean the same thing.
            "selbst_gesetzt": bool(z and z.get("zustand")
                                   and (z.get("zustand_bis") is None
                                        or z["zustand_bis"] > jetzt)),
            "zuletzt_gesehen": (z["zuletzt_gesehen"].isoformat()
                                if z and z.get("zuletzt_gesehen") else None),
            "geraet": (z or {}).get("geraet"),
        }
    return out
