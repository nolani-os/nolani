"""Long-running agent jobs shown as status cards in the chat.

A job is work the agent keeps doing after its chat answer has ended (a long
research, a render, an import). It reports three events:

    job.started   {job_id, titel, chat_id?}
    job.done      {job_id, ergebnis_url?, titel?}
    job.failed    {job_id, fehler?, titel?}

They arrive on two ways, and both land here:

  * inside a chat stream (`|||CLARAEV|||{"type": "job.started", ...}`) — the
    proxy knows who is chatting and in which chat, so the job is bound to that
    user and chat (chat_v2._lauf_ausfuehren);
  * later, without a stream, from the agent as a machine call
    (POST /api/claraos/jobs/ereignis, routers/jobs.py).

The card in the chat is an ordinary `ui.block` of kind `job`; it stores only
the job id plus what was known at the time, and asks GET /jobs/{id} for the
current state (the chat message is not rewritten when the job ends).

Field names are provisional until the agent's job registry is final: the
aliases in `_FELDER` map its names onto ours, so only that table changes.

All rows are read and written through database.user_tx — the table carries a
RESTRICTIVE owner policy (migrations/041_app_rolle.sql). The queries filter on
`username` as well: two layers, either one alone keeps users apart.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from database import get_pool, user_tx

logger = logging.getLogger(__name__)

EVENT_STATUS = {"job.started": "laeuft", "job.done": "fertig", "job.failed": "fehler"}
STATUS_ENDGUELTIG = {"fertig", "fehler"}
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

# our name -> accepted names in an incoming event (first hit wins)
_FELDER: dict[str, tuple[str, ...]] = {
    "job_id": ("job_id", "id", "jobId"),
    "titel": ("titel", "title", "name"),
    "chat_id": ("chat_id", "chatId"),
    "ergebnis_url": ("ergebnis_url", "result_url", "url", "link"),
    "fehler": ("fehler", "error", "detail"),
    "user": ("user", "username", "chat_user"),
}


def _feld(ev: dict, name: str) -> str:
    for k in _FELDER[name]:
        v = ev.get(k)
        if isinstance(v, (str, int)) and str(v).strip():
            return str(v).strip()
    return ""


def ist_job_event(ev: Any) -> bool:
    return isinstance(ev, dict) and ev.get("type") in EVENT_STATUS


def normalisieren(ev: dict) -> dict | None:
    """Event -> {job_id, status, titel, chat_id, ergebnis_url, fehler, user} or None."""
    if not ist_job_event(ev):
        return None
    job_id = _feld(ev, "job_id")
    if not JOB_ID_RE.match(job_id):
        return None
    url = _feld(ev, "ergebnis_url")
    # Links only to our own pages or https — never javascript: or data:.
    if url and not (url.startswith("/") and not url.startswith("//") or url.startswith("https://")):
        url = ""
    return {
        "job_id": job_id,
        "status": EVENT_STATUS[ev["type"]],
        "titel": _feld(ev, "titel")[:200],
        "chat_id": _feld(ev, "chat_id")[:64],
        "ergebnis_url": url[:1000],
        "fehler": _feld(ev, "fehler")[:500],
        "user": _feld(ev, "user").lower()[:128],
    }


def job_block(job: dict) -> dict:
    """The chat card (`ui.block`, kind `job`) for a normalised job event."""
    props: dict[str, Any] = {"job_id": job["job_id"], "status": job["status"]}
    for k in ("titel", "ergebnis_url", "fehler"):
        if job.get(k):
            props[k] = job[k]
    return {"id": f"job-{job['job_id']}", "kind": "job", "props": props}


# ── storage ──────────────────────────────────────────────────────────────────

_table_ready = False


async def ensure_table() -> None:
    """Safety net like the other routers; canonical schema + policy: migration 041."""
    global _table_ready
    if _table_ready:
        return
    pool = await get_pool()
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS claraos_jobs (
            job_id       TEXT PRIMARY KEY,
            tenant_id    BIGINT NOT NULL DEFAULT 1,
            username     TEXT NOT NULL,
            chat_id      TEXT,
            titel        TEXT NOT NULL DEFAULT '',
            status       TEXT NOT NULL DEFAULT 'laeuft'
                         CHECK (status IN ('laeuft', 'fertig', 'fehler')),
            ergebnis_url TEXT,
            fehler       TEXT,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    _table_ready = True


def _zeile(r) -> dict:
    return {
        "job_id": r["job_id"], "chat_id": r["chat_id"], "titel": r["titel"],
        "status": r["status"], "ergebnis_url": r["ergebnis_url"], "fehler": r["fehler"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
    }


class FremderJob(Exception):
    """The job id exists, but for another user (only raised to machine callers)."""


async def speichern(username: str, job: dict) -> tuple[dict, str]:
    """Insert or update a job of `username`. Returns (row, previous status).

    A job id that already belongs to another user is refused: under RLS the
    row is invisible here, so the INSERT hits the primary key — reported as
    FremderJob instead of silently overwriting.
    """
    await ensure_table()
    import asyncpg
    async with user_tx(username) as conn:
        alt = await conn.fetchrow("SELECT status FROM claraos_jobs WHERE job_id = $1 AND username = $2",
                                  job["job_id"], username)
        if alt is None:
            try:
                r = await conn.fetchrow(
                    """
                    INSERT INTO claraos_jobs (job_id, username, chat_id, titel, status, ergebnis_url, fehler)
                    VALUES ($1, $2, NULLIF($3, ''), $4, $5, NULLIF($6, ''), NULLIF($7, ''))
                    RETURNING *
                    """,
                    job["job_id"], username, job.get("chat_id", ""), job.get("titel", ""),
                    job["status"], job.get("ergebnis_url", ""), job.get("fehler", ""))
            except asyncpg.UniqueViolationError as exc:
                raise FremderJob(job["job_id"]) from exc
            return _zeile(r), ""
        # A late job.started must not turn a finished job back into "running".
        status = job["status"]
        if alt["status"] in STATUS_ENDGUELTIG and status == "laeuft":
            status = alt["status"]
        r = await conn.fetchrow(
            """
            UPDATE claraos_jobs SET
                status = $2,
                chat_id = COALESCE(chat_id, NULLIF($3, '')),
                titel = CASE WHEN $4 = '' THEN titel ELSE $4 END,
                ergebnis_url = COALESCE(NULLIF($5, ''), ergebnis_url),
                fehler = COALESCE(NULLIF($6, ''), fehler),
                updated_at = NOW()
            WHERE job_id = $1 AND username = $7
            RETURNING *
            """,
            job["job_id"], status, job.get("chat_id", ""), job.get("titel", ""),
            job.get("ergebnis_url", ""), job.get("fehler", ""), username)
        return _zeile(r), alt["status"]


async def lesen(username: str, job_id: str) -> dict | None:
    await ensure_table()
    async with user_tx(username) as conn:
        r = await conn.fetchrow("SELECT * FROM claraos_jobs WHERE job_id = $1 AND username = $2",
                                job_id, username)
    return _zeile(r) if r else None


async def liste(username: str, chat_id: str | None = None, limit: int = 50) -> list[dict]:
    await ensure_table()
    async with user_tx(username) as conn:
        if chat_id:
            rows = await conn.fetch(
                "SELECT * FROM claraos_jobs WHERE chat_id = $1 AND username = $3 "
                "ORDER BY created_at DESC LIMIT $2", chat_id, limit, username)
        else:
            rows = await conn.fetch(
                "SELECT * FROM claraos_jobs WHERE username = $2 ORDER BY updated_at DESC LIMIT $1",
                limit, username)
    return [_zeile(r) for r in rows]
