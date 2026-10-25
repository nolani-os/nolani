"""Planner BFF: the ClaraOS planning environment on top of Vikunja.

Per-user proxy to the Vikunja REST API plus sidecar metadata in Postgres.
Same pattern as `nc_pim.py`/`files.py`: every call runs as the authenticated
caller (trusted headers X-Claraos-User / X-Authentik-Username, never LLM
arguments); the caller's Vikunja API token comes from `claraos_app_credentials`
(app_id='vikunja', key 'api_token' — Settings → App connections).

No catch-all proxy: `_ALLOWED` explicitly whitelists (method, path regex).
Sidecar (`claraos_planner_meta`): estimates (€/tokens/minutes), links
(mail/chat/file/event), in_work_by (→ "Clara is working on …"),
event_uid (task scheduled as a calendar event). `claraos_planner_worklog`: time
tracking. Task list/detail GETs get the sidecar rows attached as `_meta`.
"""
from __future__ import annotations

from betriebsprofil import ASSISTANT_NAME, heim_default  # external deployment: no silent home-network fallback
import asyncio
import datetime as dt
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone

from typing import Literal
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from database import get_pool, system_db, user_tx
# CalDAV helpers imported directly from nc_pim (same pattern as nc_pim importing
# from files.py). Deliberately NOT extracted into services/ so nc_pim stays
# untouched.
from routers.files import _nc_credentials
from routers.nc_pim import (
    _REPORT_VEVENT_ALL, _blocks, _calendar_data_texts, _calendars, _dav,
    _default_target, _etag_of, _first, _fmt_dt, _guard_conflict, _ical_dt,
    _patch_ical, _put_ical, _report_events, _resolve_item, _unfold,
)

from auth import clara_agent_headers, is_service_call, require_caller
from sprache import Text, tx
from services import localtime

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/planner", tags=["planner"])

VIKUNJA_INTERNAL_URL = heim_default("VIKUNJA_INTERNAL_URL")
# clara-agent admin API for the cost pipeline. Configurable, since the agent may
# run on a different host than the API (same as user_admin.py).
CLARA_AGENT_ADMIN_URL = heim_default("CLARA_AGENT_ADMIN_URL")
_TIMEOUT = 20.0
_STALE_WORK_HOURS = 6  # in_work entries older than this are considered stale
# An assistant run that has not written an event for this long is dead, no
# matter what its status claims. Chosen generously: a GPU tool call may take
# minutes, but a run without any sign of life for half an hour may not.
_LAUF_STUMM_MIN = int(os.environ.get("CLARAOS_LAUF_STUMM_MIN", "30"))

# Cache for the self-healing in /in-work: (user, task_id) → monotonic() time of
# the last check that returned "not done yet". /in-work is polled by every open
# shell every 10 s; without this cache every round would cost one Vikunja query
# per running task. Done tasks never enter the cache — their row is gone after
# the first check.
_inwork_checked: dict[tuple[str, int], float] = {}
_INWORK_RECHECK_S = 60
_INWORK_MEMO_MAX = 256

_tables_ensured = False


async def _ensure_tables():
    """Safety net for deploys without a manual migration; canonical schema: migrations/011_planner.sql."""
    global _tables_ensured
    if _tables_ensured:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_planner_meta (
                id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username         TEXT NOT NULL,
                project_id       BIGINT NOT NULL,
                task_id          BIGINT NOT NULL DEFAULT 0,
                estimate_eur     NUMERIC(10,2),
                estimate_tokens  BIGINT,
                estimate_minutes INT,
                links            JSONB NOT NULL DEFAULT '[]',
                in_work_by       TEXT,
                in_work_since    TIMESTAMPTZ,
                in_work_session  TEXT,
                event_uid        TEXT,
                event_calendar   TEXT,
                updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (username, project_id, task_id)
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_planner_meta_task ON claraos_planner_meta (task_id)")
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_planner_meta_inwork ON claraos_planner_meta (in_work_by) WHERE in_work_by IS NOT NULL")
        # The reverse lookup "which tasks contribute to this goal?" uses jsonb
        # containment on links — without a GIN index that would be a full scan
        # over all sidecar rows.
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_planner_meta_links "
            "ON claraos_planner_meta USING GIN (links jsonb_path_ops)")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_planner_worklog (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username    TEXT NOT NULL,
                project_id  BIGINT NOT NULL,
                task_id     BIGINT NOT NULL,
                actor       TEXT NOT NULL,
                session_id  TEXT,
                started_at  TIMESTAMPTZ NOT NULL,
                finished_at TIMESTAMPTZ,
                note        TEXT
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_planner_worklog_task ON claraos_planner_worklog (project_id, task_id)")
    _tables_ensured = True


# ── caller / token ──────────────────────────────────────────────────────────

def _caller(request: Request) -> str:
    """The authenticated user on whose behalf this call runs.

    Security: delegates to `auth.require_caller`, which FIRST checks the trust
    anchor (a machine's service token or the reverse proxy's proxy secret) and
    only then returns the identity. Reading the header alone would let any
    device on the LAN and any logged-in user impersonate an arbitrary user.
    """
    return require_caller(request)


async def _vikunja_token(username: str) -> str:
    from encryption import decrypt_credentials
    row = None
    if username:
        async with user_tx(username) as conn:   # row-level security (migrations/042)
            row = await conn.fetchrow(
                """
                SELECT credentials FROM claraos_app_credentials
                WHERE username = $1 AND app_id = 'vikunja' AND is_active = TRUE
                LIMIT 1
                """,
                username,
            )
    if row:
        token = (decrypt_credentials(row["credentials"]) or {}).get("api_token")
        if token:
            return str(token).strip()
    raise HTTPException(
        status_code=424,
        detail=Text("planner.noToken"),
    )


async def _upstream(method: str, path: str, token: str,
                    body: bytes | None = None, params: dict | None = None,
                    content_type: str | None = None) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        # Default JSON; multipart uploads (attachments) pass through their
        # original Content-Type including the boundary.
        headers["Content-Type"] = content_type or "application/json"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        return await client.request(
            method, f"{VIKUNJA_INTERNAL_URL}/api/v1/{path}",
            headers=headers, content=body, params=params,
        )


# ── Proxy-Whitelist ─────────────────────────────────────────────────────────

_ALLOWED: list[tuple[frozenset[str], re.Pattern]] = [
    (frozenset({"GET", "PUT"}), re.compile(r"^projects$")),
    (frozenset({"GET", "POST", "DELETE"}), re.compile(r"^projects/\d+$")),
    (frozenset({"GET", "PUT"}), re.compile(r"^projects/\d+/tasks$")),
    (frozenset({"GET"}), re.compile(r"^projects/\d+/views$")),
    (frozenset({"GET"}), re.compile(r"^projects/\d+/views/\d+/tasks$")),
    (frozenset({"GET", "PUT"}), re.compile(r"^projects/\d+/views/\d+/buckets$")),
    (frozenset({"POST", "DELETE"}), re.compile(r"^projects/\d+/views/\d+/buckets/\d+$")),
    (frozenset({"POST"}), re.compile(r"^projects/\d+/views/\d+/buckets/\d+/tasks$")),
    (frozenset({"PUT", "DELETE"}), re.compile(r"^projects/\d+/users(/\d+)?$")),
    (frozenset({"GET"}), re.compile(r"^projects/\d+/projectusers$")),
    (frozenset({"GET"}), re.compile(r"^tasks$")),  # Vikunja 2.x: /tasks (replaces /tasks/all)
    (frozenset({"GET", "POST", "DELETE"}), re.compile(r"^tasks/\d+$")),
    (frozenset({"GET", "PUT"}), re.compile(r"^tasks/\d+/labels$")),
    (frozenset({"DELETE"}), re.compile(r"^tasks/\d+/labels/\d+$")),
    (frozenset({"PUT"}), re.compile(r"^tasks/\d+/relations$")),
    (frozenset({"DELETE"}), re.compile(r"^tasks/\d+/relations/[a-z_]+/\d+$")),
    (frozenset({"GET", "PUT"}), re.compile(r"^tasks/\d+/comments$")),
    (frozenset({"POST", "DELETE"}), re.compile(r"^tasks/\d+/comments/\d+$")),
    (frozenset({"GET", "PUT"}), re.compile(r"^tasks/\d+/assignees$")),
    (frozenset({"DELETE"}), re.compile(r"^tasks/\d+/assignees/\d+$")),
    (frozenset({"GET", "PUT"}), re.compile(r"^tasks/\d+/attachments$")),  # PUT = multipart upload
    (frozenset({"GET", "DELETE"}), re.compile(r"^tasks/\d+/attachments/\d+$")),  # GET = file download
    (frozenset({"GET", "PUT"}), re.compile(r"^labels$")),
    (frozenset({"GET", "POST", "DELETE"}), re.compile(r"^labels/\d+$")),
    (frozenset({"GET"}), re.compile(r"^user$")),
    (frozenset({"GET"}), re.compile(r"^users$")),
]

# GETs whose response gets enriched with sidecar `_meta`
_MERGE_TASK_LIST = re.compile(r"^(projects/\d+/tasks|projects/\d+/views/\d+/tasks|tasks)$")
_MERGE_TASK_DETAIL = re.compile(r"^tasks/\d+$")


async def _meta_for_tasks(username: str, task_ids: list[int]) -> dict[int, dict]:
    if not task_ids:
        return {}
    async with user_tx(username) as conn:
        rows = await conn.fetch(
            """
            SELECT project_id, task_id, estimate_eur, estimate_tokens, estimate_minutes,
                   links, in_work_by, in_work_since, in_work_session, event_uid, event_calendar
            FROM claraos_planner_meta
            WHERE username = $1 AND task_id = ANY($2::bigint[])
            """,
            username, task_ids,
        )
    out: dict[int, dict] = {}
    for r in rows:
        d = dict(r)
        d["links"] = json.loads(d["links"]) if isinstance(d["links"], str) else d["links"]
        d["estimate_eur"] = float(d["estimate_eur"]) if d["estimate_eur"] is not None else None
        d["in_work_since"] = d["in_work_since"].isoformat() if d["in_work_since"] else None
        out[r["task_id"]] = d
    return out


@router.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def api_proxy(path: str, request: Request):
    """Whitelisted passthrough to the Vikunja API, using the caller's token."""
    await _ensure_tables()
    method = request.method.upper()
    if not any(method in methods and rx.match(path) for methods, rx in _ALLOWED):
        raise HTTPException(status_code=403, detail=f"Pfad nicht freigegeben: {method} /{path}")
    user = _caller(request)
    token = await _vikunja_token(user)
    body = await request.body()  # buffered in RAM — fine up to Vikunja's 20 MB limit
    ct_in = request.headers.get("content-type", "")
    resp = await _upstream(method, path, token, body=body or None,
                           params=dict(request.query_params),
                           content_type=ct_in if ct_in.startswith("multipart/") else None)

    content_type = resp.headers.get("content-type", "")
    if method == "GET" and resp.status_code == 200 and "json" in content_type:
        try:
            data = resp.json()
            if _MERGE_TASK_LIST.match(path) and isinstance(data, list):
                metas = await _meta_for_tasks(user, [t["id"] for t in data if isinstance(t, dict) and "id" in t])
                for t in data:
                    if isinstance(t, dict) and t.get("id") in metas:
                        t["_meta"] = metas[t["id"]]
                return data
            if _MERGE_TASK_DETAIL.match(path) and isinstance(data, dict) and "id" in data:
                metas = await _meta_for_tasks(user, [data["id"]])
                if data["id"] in metas:
                    data["_meta"] = metas[data["id"]]
                return data
        except Exception as e:  # merging must never break the proxy
            logger.warning("planner meta-merge failed for %s: %s", path, e)
    # Downloads: pass the file name (Content-Disposition) through to the browser
    passthrough = {}
    if resp.headers.get("content-disposition"):
        passthrough["Content-Disposition"] = resp.headers["content-disposition"]
    return Response(content=resp.content, status_code=resp.status_code,
                    media_type=content_type or "application/json",
                    headers=passthrough or None)


# ── Sidecar: Meta / Estimates / Links ───────────────────────────────────────

class MetaUpsert(BaseModel):
    project_id: int
    task_id: int = 0  # 0 = project meta
    estimate_eur: float | None = None
    estimate_tokens: int | None = None
    estimate_minutes: int | None = None
    links: list[dict] | None = None  # [{kind: mail|chat|file|event, uri, label}]


@router.put("/meta")
async def upsert_meta(body: MetaUpsert, request: Request):
    """Partial update: only fields sent in the body are overwritten (merge, like prefs PUT)."""
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        await conn.execute(
            """
            INSERT INTO claraos_planner_meta (username, project_id, task_id,
                estimate_eur, estimate_tokens, estimate_minutes, links)
            VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '[]'::jsonb))
            ON CONFLICT (username, project_id, task_id) DO UPDATE SET
                estimate_eur     = COALESCE(EXCLUDED.estimate_eur, claraos_planner_meta.estimate_eur),
                estimate_tokens  = COALESCE(EXCLUDED.estimate_tokens, claraos_planner_meta.estimate_tokens),
                estimate_minutes = COALESCE(EXCLUDED.estimate_minutes, claraos_planner_meta.estimate_minutes),
                links            = COALESCE($7::jsonb, claraos_planner_meta.links),
                updated_at       = NOW()
            """,
            user, body.project_id, body.task_id,
            body.estimate_eur, body.estimate_tokens, body.estimate_minutes,
            json.dumps(body.links) if body.links is not None else None,
        )
    return {"ok": True}


class MetaLinkChange(BaseModel):
    project_id: int
    task_id: int
    link: dict                      # {kind, uri, label?}
    remove: bool = False


@router.post("/meta/links")
async def change_meta_link(body: MetaLinkChange, request: Request):
    """Add or remove ONE cross-app link atomically.

    `PUT /meta` replaces the whole `links` array; adding one entry that way
    requires read-modify-write and overwrites other writers' entries under
    concurrent edits. This endpoint makes the change in ONE statement and is
    therefore also safe for automated callers (Ideas app, Clara).

    Equality = same `uri` (the rest is display). This prevents duplicate links.
    """
    await _ensure_tables()
    user = _caller(request)
    uri = str(body.link.get("uri") or "").strip()
    if not uri:
        raise HTTPException(status_code=400, detail="link.uri fehlt")
    async with user_tx(user) as conn:
        if body.remove:
            res = await conn.execute(
                """
                UPDATE claraos_planner_meta
                SET links = COALESCE((
                        SELECT jsonb_agg(e) FROM jsonb_array_elements(links) e
                        WHERE e ->> 'uri' IS DISTINCT FROM $4
                    ), '[]'::jsonb),
                    updated_at = NOW()
                WHERE username = $1 AND project_id = $2 AND task_id = $3
                """,
                user, body.project_id, body.task_id, uri)
            return {"ok": True, "removed": int(res.split()[-1] or 0)}
        await conn.execute(
            """
            INSERT INTO claraos_planner_meta (username, project_id, task_id, links)
            VALUES ($1, $2, $3, jsonb_build_array($4::jsonb))
            ON CONFLICT (username, project_id, task_id) DO UPDATE SET
                links = COALESCE((
                            SELECT jsonb_agg(e) FROM jsonb_array_elements(claraos_planner_meta.links) e
                            WHERE e ->> 'uri' IS DISTINCT FROM $5
                        ), '[]'::jsonb) || jsonb_build_array($4::jsonb),
                updated_at = NOW()
            """,
            user, body.project_id, body.task_id, json.dumps(body.link), uri)
    return {"ok": True}


@router.get("/by-object")
async def tasks_for_object(object_id: str, request: Request, limit: int = 100):
    """Which tasks reference this object?

    The reverse direction of `links`: the Ideas app asks "which tasks
    contribute to this goal?". Title and done status come live from Vikunja —
    the sidecar deliberately stores NO copy of them (Vikunja stays the single
    source of truth for tasks).

    Note: the sidecar is per user, so a shared goal only shows the
    requesting user's links.
    """
    await _ensure_tables()
    user = _caller(request)
    try:
        uuid.UUID(object_id)
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=400, detail=f"Ungültige object_id: {object_id!r}")
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            """
            SELECT project_id, task_id FROM claraos_planner_meta
            WHERE username = $1 AND task_id > 0
              AND links @> jsonb_build_array(jsonb_build_object('uri', $2::text))
            ORDER BY project_id, task_id LIMIT $3
            """,
            user, f"claraos://ideas/object/{object_id}", max(1, min(limit, 500)))
    if not rows:
        return {"tasks": []}

    token = await _vikunja_token(user)
    out = []
    for r in rows:
        try:
            resp = await _upstream("GET", f"tasks/{r['task_id']}", token)
            t = resp.json() if resp.status_code == 200 else {}
        except Exception as exc:  # noqa: BLE001 — one dead task must not break the whole list
            logger.warning("planner by-object: Task %s nicht lesbar: %s", r["task_id"], exc)
            t = {}
        out.append({
            "project_id": r["project_id"], "task_id": r["task_id"],
            "title": t.get("title") or "(Aufgabe nicht lesbar)",
            "done": bool(t.get("done")), "due_date": t.get("due_date"),
            "missing": not t,
        })
    return {"tasks": out}


@router.get("/meta")
async def get_meta(project_id: int, request: Request):
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            "SELECT * FROM claraos_planner_meta WHERE username = $1 AND project_id = $2",
            user, project_id,
        )
    out = []
    for r in rows:
        d = {k: v for k, v in dict(r).items() if k != "id"}
        d["links"] = json.loads(d["links"]) if isinstance(d["links"], str) else d["links"]
        d["estimate_eur"] = float(d["estimate_eur"]) if d["estimate_eur"] is not None else None
        for k in ("in_work_since", "updated_at"):
            d[k] = d[k].isoformat() if d[k] else None
        out.append(d)
    return out


# ── "Clara is working on …" ──────────────────────────────────────────────────

class WorkStart(BaseModel):
    project_id: int
    task_id: int
    session_id: str | None = None
    note: str | None = None


class WorkFinish(BaseModel):
    project_id: int
    task_id: int
    note: str | None = None
    # Ad-hoc tasks (from start_adhoc_work) should also be checked off at the
    # end — otherwise the "Clara" project fills up with finished work that
    # still looks open. Default false so the Planner app (finishWork) keeps
    # behaving exactly as before.
    complete: bool = False


def _actor(request: Request, user: str) -> str:
    """Clara's calls arrive via the tools gateway (X-Claraos-User = chat user);
    the gateway marks machine calls with X-Claraos-Actor: clara."""
    # Security: ONLY from machines. Otherwise a logged-in user could set
    # `X-Claraos-Actor: clara` through the reverse proxy — and `_write_candidates`
    # would write with Clara's Vikunja token, which sees more projects than the user.
    if not is_service_call(request):
        return user
    return (request.headers.get("x-claraos-actor") or user).strip()


@router.post("/work/start")
async def work_start(body: WorkStart, request: Request):
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    now = datetime.now(timezone.utc)
    async with user_tx(user) as conn:
        await conn.execute(
            """
            INSERT INTO claraos_planner_meta (username, project_id, task_id,
                in_work_by, in_work_since, in_work_session)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (username, project_id, task_id) DO UPDATE SET
                in_work_by = $4, in_work_since = $5, in_work_session = $6, updated_at = NOW()
            """,
            user, body.project_id, body.task_id, actor, now, body.session_id,
        )
        await conn.execute(
            """
            INSERT INTO claraos_planner_worklog (username, project_id, task_id,
                actor, session_id, started_at, note)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            user, body.project_id, body.task_id, actor, body.session_id, now, body.note,
        )
    return {"ok": True, "in_work_by": actor, "since": now.isoformat()}


async def _release_work(user: str, project_id: int, task_id: int, note: str = "") -> bool:
    """Release the "working on this" lock and close the open worklog entry.

    Shared core of `/work/finish`, checking off (`done=True`) and the
    self-healing in `/in-work`. Returns True if a lock was actually open — the
    caller can use that to decide whether there is anything to report.
    """
    now = datetime.now(timezone.utc)
    async with user_tx(user) as conn:
        async with conn.transaction():
            tag = await conn.execute(
                """
                UPDATE claraos_planner_meta
                SET in_work_by = NULL, in_work_since = NULL, in_work_session = NULL,
                    updated_at = NOW()
                WHERE username = $1 AND project_id = $2 AND task_id = $3
                  AND in_work_by IS NOT NULL
                """,
                user, project_id, task_id,
            )
            await conn.execute(
                """
                UPDATE claraos_planner_worklog
                SET finished_at = $4, note = COALESCE(note, '') || $5
                WHERE id = (
                    SELECT id FROM claraos_planner_worklog
                    WHERE username = $1 AND project_id = $2 AND task_id = $3
                      AND finished_at IS NULL
                    ORDER BY started_at DESC LIMIT 1
                )
                """,
                user, project_id, task_id, now, f" | {note}" if note else "",
            )
    return tag.rsplit(" ", 1)[-1] != "0"


async def _work_obsolete(user: str, project_id: int, task_id: int) -> bool:
    """True if the task is already done — in that case release the lock right away.

    Important: why the check lives here and not only on check-off: the Planner
    UI checks tasks off directly in Vikunja via the passthrough `/api/{path}`
    (see `api_proxy`) and never passes code that knows about the sidecar. A
    lock nobody releases would otherwise stay in the taskbar forever, long
    after the task was completed.

    When in doubt (Vikunja unreachable, token missing) the lock is **shown**,
    not hidden: an invisible running job would be the worse failure.
    """
    key = (user, task_id)
    seen = _inwork_checked.get(key)
    if seen is not None and time.monotonic() - seen < _INWORK_RECHECK_S:
        return False
    try:
        token = await _vikunja_token(user)
        resp = await _upstream("GET", f"tasks/{task_id}", token)
    except Exception as e:  # noqa: BLE001
        logger.warning("in-work: Task %s nicht prüfbar (%s) — Eintrag bleibt stehen", task_id, e)
        return False
    if resp.status_code != 200:
        return False
    if not (resp.json() or {}).get("done"):
        if len(_inwork_checked) >= _INWORK_MEMO_MAX:
            _inwork_checked.clear()
        _inwork_checked[key] = time.monotonic()
        return False
    _inwork_checked.pop(key, None)
    if await _release_work(user, project_id, task_id, "automatisch gelöst: Aufgabe war erledigt"):
        # See above: INFO would be invisible. This release also discards
        # state and belongs in the log.
        logger.warning("in-work: hängende Sperre für Task %s gelöst (Aufgabe ist erledigt)", task_id)
    return True


async def _lauf_tot(session_id: str | None) -> str | None:
    """Does the lock belong to an assistant run that is no longer alive?

    Warning: without this check, the mobile chat can permanently show
    "Clara is working · N" for runs that died long ago (e.g. test runs stuck on
    `running` for hours). The task-based self-healing does not catch this: it
    asks whether the TASK is done, and it never was.

    Important: the gap is the coupling. `_planner_run_finish` hangs off the
    RUN's final state. Anyone who calls `POST /assistants/{id}/runs` and never
    patches the run to `completed|failed|cancelled` — crash, restart, aborted
    test — holds the lock indefinitely. A `stale` flag after 6 h alone does
    not clean anything up.

    Two cases, handled differently:
      * The run is in a **final state** → the completion hook was missed.
        Release immediately; this is unambiguous.
      * The run supposedly still lives but has had no event for
        `_LAUF_STUMM_MIN` → dead. `waiting_approval` gets more time
        (`_STALE_WORK_HOURS`): it is waiting for the admin's approval via push,
        and people do not answer within thirty minutes.

    Returns the reason as text, or None if the run is still alive.
    When in doubt, None — same rule as above: an invisible running job is the
    worse failure.
    """
    if not session_id:
        return None
    try:
        uuid.UUID(session_id)      # only assistant runs have a UUID
    except (ValueError, AttributeError, TypeError):
        return None
    try:
        # Lock housekeeping across users (the run may belong to any assistant
        # owner): explicit system context for the assistant tables (043).
        pool = system_db("planner-lock-check")
        lauf = await pool.fetchrow(
            """
            SELECT r.status, r.started_at,
                   (SELECT max(ts) FROM claraos_assistant_run_events e
                     WHERE e.run_id = r.id) AS letztes_ereignis
            FROM claraos_assistant_runs r WHERE r.id = $1
            """,
            session_id,
        )
    except Exception as e:  # noqa: BLE001 — table missing or similar: claim nothing
        logger.debug("in-work: Lauf %s nicht prüfbar (%s)", session_id[:8], e)
        return None
    if not lauf:
        return None
    if lauf["status"] in ("completed", "failed", "cancelled"):
        return f"Lauf war längst {lauf['status']}, der Abschluss hat die Sperre nicht gelöst"
    zuletzt = lauf["letztes_ereignis"] or lauf["started_at"]
    if not zuletzt:
        return None
    stumm_s = (datetime.now(timezone.utc) - zuletzt).total_seconds()
    grenze = (_STALE_WORK_HOURS * 3600 if lauf["status"] == "waiting_approval"
              else _LAUF_STUMM_MIN * 60)
    if stumm_s > grenze:
        return (f"Lauf steht seit {int(stumm_s // 60)} min auf "
                f"„{lauf['status']}“ ohne ein einziges Ereignis")
    return None


@router.post("/work/finish")
async def work_finish(body: WorkFinish, request: Request):
    await _ensure_tables()
    user = _caller(request)
    now = datetime.now(timezone.utc)
    await _release_work(user, body.project_id, body.task_id, body.note or "")
    _inwork_checked.pop((user, body.task_id), None)
    completed = False
    if body.complete:
        # Note as a comment (stays readable on the task), then check off. Both
        # best-effort: the worklog is already closed, and a Vikunja error must
        # not turn the completion into a 500.
        try:
            if body.note:
                await clara_add_comment(
                    ClaraAddComment(task_id=body.task_id, comment=body.note), request)
            await clara_update_task(
                ClaraUpdateTask(task_id=body.task_id, done=True), request)
            completed = True
        except Exception as e:  # noqa: BLE001
            logger.warning("work/finish: Task %s konnte nicht abgehakt werden: %s",
                           body.task_id, e)
    return {"ok": True, "finished_at": now.isoformat(), "completed": completed}


@router.get("/in-work")
async def in_work(request: Request):
    """All active "working on" entries of the caller (+ stale flag)."""
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            """
            SELECT project_id, task_id, in_work_by, in_work_since, in_work_session
            FROM claraos_planner_meta
            WHERE username = $1 AND in_work_by IS NOT NULL
            ORDER BY in_work_since DESC
            """,
            user,
        )
    now = datetime.now(timezone.utc)
    out = []
    for r in rows:
        # Done tasks are not running work. The check also releases the lock so
        # leftovers disappear on their own.
        if await _work_obsolete(user, r["project_id"], r["task_id"]):
            continue
        # And: a run with no sign of life for hours is not a running run. The
        # task stays open — only the LOCK is released so it does not show
        # "Clara is working" forever.
        grund = await _lauf_tot(r["in_work_session"])
        if grund:
            if await _release_work(user, r["project_id"], r["task_id"],
                                   f"automatisch gelöst: {grund}"):
                # Important: WARNING, not INFO — deliberately: this API's own
                # loggers are at WARNING without a root handler, so
                # `logger.info` shows up NOWHERE. Self-healing that deletes
                # state silently cannot be traced afterwards.
                logger.warning("in-work: Sperre für Task %s gelöst — %s",
                               r["task_id"], grund)
            continue
        out.append({
            "project_id": r["project_id"],
            "task_id": r["task_id"],
            "in_work_by": r["in_work_by"],
            "since": r["in_work_since"].isoformat() if r["in_work_since"] else None,
            "session_id": r["in_work_session"],
            "stale": bool(r["in_work_since"] and (now - r["in_work_since"]).total_seconds() > _STALE_WORK_HOURS * 3600),
        })
    return out


# ── Calendar: NC CalDAV merge + "schedule task as event" ─────────────────────

_TASKPROP = "X-CLARAOS-TASK"  # VEVENT-Property: "vikunja:<task_id>"


def _range_stamp(iso: str) -> str:
    # A naive time is local wall-clock time (services/localtime.py), not UTC.
    return localtime.to_utc(iso).strftime("%Y%m%dT%H%M%SZ")


@router.get("/calendar")
async def calendar_merged(start: str, end: str, request: Request):
    """NC VEVENTs (all of the user's VEVENT calendars) + Vikunja tasks due in
    the range. Events created via 'schedule' carry task_id."""
    await _ensure_tables()
    user = _caller(request)
    nc_user, nc_pass = await _nc_credentials(user)
    rep = _report_events(_range_stamp(start), _range_stamp(end))
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    events: list[dict] = []
    for cal in cals:
        resp = await _dav("REPORT", cal["url"], nc_user, nc_pass, rep)
        for ics in _calendar_data_texts(resp):
            for blk in _blocks(ics, "VEVENT"):
                task_ref = _first(blk, _TASKPROP)
                task_id = None
                if task_ref.startswith("vikunja:"):
                    try:
                        task_id = int(task_ref.split(":", 1)[1])
                    except ValueError:
                        pass
                events.append({
                    "summary": _first(blk, "SUMMARY"),
                    "start": _fmt_dt(_first(blk, "DTSTART")),
                    "end": _fmt_dt(_first(blk, "DTEND")),
                    "uid": _first(blk, "UID"),
                    "calendar": cal["name"],
                    "color": cal.get("color", ""),
                    "task_id": task_id,
                    # see _event_out: cancelled is not the same as deleted
                    "cancelled": _first(blk, "STATUS").strip().upper() == "CANCELLED",
                })
    events.sort(key=lambda e: e["start"] or "9999")

    token = await _vikunja_token(user)
    tasks: list[dict] = []
    for page in (1, 2, 3):
        resp = await _upstream("GET", "tasks", token, params={"per_page": "50", "page": str(page)})
        batch = resp.json() if resp.status_code == 200 else []
        if not isinstance(batch, list) or not batch:
            break
        tasks.extend(batch)
        if len(batch) < 50:
            break
    lo, hi = start[:10], end[:10]
    due_tasks = [
        {"id": t["id"], "project_id": t.get("project_id"), "title": t.get("title"),
         "done": t.get("done"), "due_date": t.get("due_date"), "priority": t.get("priority")}
        for t in tasks
        if isinstance(t, dict) and t.get("due_date") and not str(t["due_date"]).startswith("0001-")
        and lo <= str(t["due_date"])[:10] <= hi
    ]
    return {"events": events, "tasks": due_tasks}


class ScheduleBody(BaseModel):
    project_id: int
    start: str                    # ISO datetime
    end: str | None = None        # default: start + 60 min
    calendar: str | None = None   # display name; None = default calendar


async def _sidecar_event(user: str, project_id: int, task_id: int) -> tuple[str | None, str | None]:
    async with user_tx(user) as conn:
        row = await conn.fetchrow(
            "SELECT event_uid, event_calendar FROM claraos_planner_meta "
            "WHERE username = $1 AND project_id = $2 AND task_id = $3",
            user, project_id, task_id)
    return (row["event_uid"], row["event_calendar"]) if row else (None, None)


async def _delete_event(nc_user: str, nc_pass: str, cals: list[dict],
                        event_uid: str, calendar_name: str | None) -> None:
    """Remove the calendar event belonging to a task.

    Security: fetch the ETag first, then delete conditionally. This path builds
    the URL itself (`{uid}.ics`) instead of going through a REPORT, so it has no
    ETag from a read — it is fetched explicitly. Without it, an event changed
    on a phone in the meantime would be deleted without asking.
    """
    for cal in cals:
        if calendar_name and cal["name"] != calendar_name:
            continue
        url = cal["url"].rstrip("/") + f"/{event_uid}.ics"
        etag = await _etag_of(url, nc_user, nc_pass)
        if etag is None:          # not in this calendar
            continue
        resp = await _dav("DELETE", url, nc_user, nc_pass, if_match=etag or None)
        _guard_conflict(resp, "Der Termin")
        if resp.status_code in (200, 204):
            return


@router.post("/tasks/{task_id}/schedule")
async def schedule_task(task_id: int, body: ScheduleBody, request: Request):
    """Schedule a task as an event in the NC calendar (VEVENT with X-CLARAOS-TASK).
    An existing schedule is replaced; event_uid is stored in the sidecar."""
    await _ensure_tables()
    user = _caller(request)
    token = await _vikunja_token(user)
    tresp = await _upstream("GET", f"tasks/{task_id}", token)
    if tresp.status_code != 200:
        raise HTTPException(status_code=404, detail=f"Task {task_id} nicht gefunden")
    title = (tresp.json() or {}).get("title") or f"Task {task_id}"

    nc_user, nc_pass = await _nc_credentials(user)
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    if not cals:
        raise HTTPException(status_code=404, detail=Text("planner.noCalendar"))

    old_uid, old_cal = await _sidecar_event(user, body.project_id, task_id)
    if old_uid:
        await _delete_event(nc_user, nc_pass, cals, old_uid, old_cal)

    target = _default_target(cals, body.calendar)
    uid = str(uuid.uuid4())
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dtstart = _ical_dt(body.start)
    end_iso = body.end
    if not end_iso:
        d = datetime.fromisoformat(body.start.replace("Z", "+00:00"))
        end_iso = (d + timedelta(minutes=60)).isoformat()
    dtend = _ical_dt(end_iso)
    public_url = heim_default("CLARAOS_PUBLIC_URL").rstrip("/")
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ClaraOS//planner//EN",
        "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}",
        f"DTSTART:{dtstart}" if "T" in dtstart else f"DTSTART;VALUE=DATE:{dtstart}",
        f"DTEND:{dtend}" if "T" in dtend else f"DTEND;VALUE=DATE:{dtend}",
        f"SUMMARY:🗂️ {title}",
        f"{_TASKPROP}:vikunja:{task_id}",
        f"URL:{public_url}/?app=planner",
        "END:VEVENT", "END:VCALENDAR",
    ]
    url = target["url"].rstrip("/") + f"/{uid}.ics"
    resp = await _dav("PUT", url, nc_user, nc_pass, "\r\n".join(lines),
                      content_type="text/calendar; charset=utf-8", if_none_match=True)
    _guard_conflict(resp, "Der Termin")
    if resp.status_code not in (201, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud PUT failed: {resp.status_code} {resp.text[:200]}")

    async with user_tx(user) as conn:
        await conn.execute(
            """
            INSERT INTO claraos_planner_meta (username, project_id, task_id, event_uid, event_calendar)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (username, project_id, task_id)
            DO UPDATE SET event_uid = $4, event_calendar = $5, updated_at = NOW()
            """,
            user, body.project_id, task_id, uid, target["name"])
    return {"ok": True, "uid": uid, "calendar": target["name"], "start": body.start, "end": end_iso}


@router.delete("/tasks/{task_id}/schedule")
async def unschedule_task(task_id: int, project_id: int, request: Request):
    await _ensure_tables()
    user = _caller(request)
    uid, cal_name = await _sidecar_event(user, project_id, task_id)
    if not uid:
        return {"ok": True, "removed": False}
    nc_user, nc_pass = await _nc_credentials(user)
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    await _delete_event(nc_user, nc_pass, cals, uid, cal_name)
    async with user_tx(user) as conn:
        await conn.execute(
            "UPDATE claraos_planner_meta SET event_uid = NULL, event_calendar = NULL, updated_at = NOW() "
            "WHERE username = $1 AND project_id = $2 AND task_id = $3",
            user, project_id, task_id)
    return {"ok": True, "removed": True}


# ── Outlook-style calendar: /events CRUD — busy status, attendees,
#    recurrence, TZID Europe/Berlin. The existing /calendar stays untouched.

_TZ_BERLIN = ZoneInfo("Europe/Berlin")

# Static VTIMEZONE block (RFC 5545; last Sunday of March/October) — immutable.
_VTIMEZONE_BERLIN = "\r\n".join([
    "BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
    "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
    "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE",
])

# Outlook mapping: availability ↔ TRANSP / X-MICROSOFT-CDO-BUSYSTATUS / STATUS
_BUSY_PROPS: dict[str, dict] = {
    "free":      {"transp": "TRANSPARENT", "xbusy": "FREE",      "status": None},
    "busy":      {"transp": "OPAQUE",      "xbusy": "BUSY",      "status": None},
    "tentative": {"transp": "OPAQUE",      "xbusy": "TENTATIVE", "status": "TENTATIVE"},
    "oof":       {"transp": "OPAQUE",      "xbusy": "OOF",       "status": None},
}


def _esc(t: str) -> str:
    """iCal text escaping (RFC 5545 §3.3.11) — backslash FIRST."""
    return (t or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _unesc(t: str) -> str:
    out, i = [], 0
    while i < len(t):
        if t[i] == "\\" and i + 1 < len(t):
            c = t[i + 1]
            out.append("\n" if c in "nN" else c)
            i += 2
        else:
            out.append(t[i])
            i += 1
    return "".join(out)


def _fold(line: str) -> str:
    """RFC 5545 line folding at >74 octets (safe for UTF-8 sequences)."""
    b = line.encode("utf-8")
    if len(b) <= 74:
        return line
    chunks, first = [], True
    while b:
        limit = 74 if first else 73
        cut = min(limit, len(b))
        while 0 < cut < len(b) and (b[cut] & 0xC0) == 0x80:
            cut -= 1
        chunks.append(("" if first else " ") + b[:cut].decode("utf-8"))
        b = b[cut:]
        first = False
    return "\r\n".join(chunks)


def _ical_local(iso: str) -> str:
    """ISO (UTC/offset; naive = local time) → Berlin wall-clock time 'YYYYMMDDTHHMMSS' (for TZID)."""
    return localtime.to_utc(iso).astimezone(_TZ_BERLIN).strftime("%Y%m%dT%H%M%S")


def _prop(block: list[tuple[str, str, str]], key: str) -> tuple[str, str]:
    """Like _first, but returns (value, params) — _first discards the params."""
    for k, p, v in block:
        if k == key:
            return v, p
    return "", ""


def _parse_ical_dt(value: str, params: str) -> tuple[str, bool]:
    """iCal DATE/DATE-TIME (+params such as 'TZID=Europe/Berlin') → (ISO UTC, all_day)."""
    v = value.strip()
    if not v:
        return "", False
    if "VALUE=DATE" in params.upper() or ("T" not in v and len(v) == 8):
        try:
            return datetime.strptime(v, "%Y%m%d").date().isoformat(), True
        except ValueError:
            return v, True
    try:
        if v.endswith("Z"):
            dt = datetime.strptime(v, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        else:
            dt = datetime.strptime(v, "%Y%m%dT%H%M%S")
            # No TZID = "floating" time, which RFC 5545 defines as local time.
            tz = localtime.LOCAL_TZ
            m = re.search(r"TZID=([^;:]+)", params, re.I)
            if m:
                try:
                    tz = ZoneInfo(m.group(1).strip('"'))
                except Exception:
                    tz = localtime.LOCAL_TZ
            dt = dt.replace(tzinfo=tz)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), False
    except ValueError:
        return v, False


def _split_alarm(blk: list[tuple[str, str, str]]) -> tuple[list[tuple[str, str, str]], int | None]:
    """Separate top-level props from VALARM content; TRIGGER → minutes before start."""
    main, alarm = [], []
    depth = 0
    for t in blk:
        k = t[0]
        if k == "BEGIN":
            depth += 1
            continue
        if k == "END":
            depth = max(0, depth - 1)
            continue
        (alarm if depth > 0 else main).append(t)
    minutes = None
    for k, _p, v in alarm:
        if k != "TRIGGER":
            continue
        m = re.match(r"-PT(\d+)([MH])$", v.strip(), re.I)
        if m:
            minutes = int(m.group(1)) * (60 if m.group(2).upper() == "H" else 1)
        else:
            m = re.match(r"-P(\d+)D", v.strip(), re.I)
            if m:
                minutes = int(m.group(1)) * 1440
    return main, minutes


def _parse_attendees(main: list[tuple[str, str, str]]) -> tuple[str | None, list[dict]]:
    organizer = None
    attendees: list[dict] = []
    for k, p, v in main:
        if k == "ORGANIZER":
            organizer = v.strip()
        elif k == "ATTENDEE":
            email = v.strip()
            if email.lower().startswith("mailto:"):
                email = email[7:]
            mcn = re.search(r'CN=("[^"]*"|[^;:]+)', p, re.I)
            mps = re.search(r"PARTSTAT=([^;:]+)", p, re.I)
            attendees.append({
                "email": email,
                "name": mcn.group(1).strip('"') if mcn else None,
                "partstat": (mps.group(1).upper() if mps else "NEEDS-ACTION"),
            })
    return organizer, attendees


def _busy_of(main: list[tuple[str, str, str]]) -> str:
    xbusy = transp = status = ""
    for k, _p, v in main:
        if k == "X-MICROSOFT-CDO-BUSYSTATUS":
            xbusy = v.strip().upper()
        elif k == "TRANSP":
            transp = v.strip().upper()
        elif k == "STATUS":
            status = v.strip().upper()
    if xbusy == "FREE":
        return "free"
    if xbusy == "TENTATIVE":
        return "tentative"
    if xbusy == "OOF":
        return "oof"
    if xbusy == "BUSY":
        return "busy"
    if status == "TENTATIVE":
        return "tentative"
    if transp == "TRANSPARENT":
        return "free"
    return "busy"


def _rrule_simple_of(rrule: str) -> dict | None:
    """Only FREQ/INTERVAL/UNTIL/COUNT — anything else = None ('custom')."""
    if not rrule:
        return None
    try:
        parts = dict(kv.split("=", 1) for kv in rrule.strip().split(";") if "=" in kv)
    except ValueError:
        return None
    if set(parts) - {"FREQ", "INTERVAL", "UNTIL", "COUNT"}:
        return None
    freq = parts.get("FREQ", "").upper()
    if freq not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY"):
        return None
    out: dict = {"freq": freq, "interval": int(parts.get("INTERVAL", 1)), "until": None, "count": None}
    if "UNTIL" in parts:
        out["until"] = _parse_ical_dt(parts["UNTIL"], "")[0][:10]
    if "COUNT" in parts:
        out["count"] = int(parts["COUNT"])
    return out


def _event_out(blk: list[tuple[str, str, str]], cal: dict) -> dict:
    main, alarm_minutes = _split_alarm(blk)
    sv, sp = _prop(main, "DTSTART")
    ev, ep = _prop(main, "DTEND")
    start, all_day = _parse_ical_dt(sv, sp)
    end, _ = _parse_ical_dt(ev, ep)
    rid_v, rid_p = _prop(main, "RECURRENCE-ID")
    rrule = _first(main, "RRULE")
    task_ref = _first(main, _TASKPROP)
    task_id = None
    if task_ref.startswith("vikunja:"):
        try:
            task_id = int(task_ref.split(":", 1)[1])
        except ValueError:
            pass
    organizer, attendees = _parse_attendees(main)
    return {
        "uid": _first(main, "UID"),
        "summary": _unesc(_first(main, "SUMMARY")),
        "start": start, "end": end, "all_day": all_day,
        "calendar": cal["name"], "color": cal.get("color", ""),
        "task_id": task_id,
        "location": _unesc(_first(main, "LOCATION")),
        "description": _unesc(_first(main, "DESCRIPTION")),
        "busy_status": _busy_of(main),
        # Note: when the organizer cancels, Sabre reliably delivers the
        #    cancellation to the invitee — their copy gets STATUS:CANCELLED
        #    (SEQUENCE 0 -> 1). Without passing STATUS through here, a cancelled
        #    event would look exactly like a valid one, and people would show
        #    up to meetings that no longer take place.
        "cancelled": _first(main, "STATUS").strip().upper() == "CANCELLED",
        "recurrence_id": _parse_ical_dt(rid_v, rid_p)[0] if rid_v else None,
        "is_recurring": bool(rrule) or bool(rid_v),
        "rrule_raw": rrule,
        "rrule_simple": _rrule_simple_of(rrule),
        "alarm_minutes": alarm_minutes,
        "organizer": organizer,
        "attendees": attendees,
    }


def _report_events_expanded(start: str, end: str) -> str:
    """CalDAV REPORT with <c:expand>: Sabre expands recurring series server-side
    (applies EXDATE + RECURRENCE-ID overrides, times normalized to UTC)."""
    return (
        '<?xml version="1.0" encoding="utf-8" ?>'
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        f'<d:prop><c:calendar-data><c:expand start="{start}" end="{end}"/></c:calendar-data></d:prop>'
        '<c:filter><c:comp-filter name="VCALENDAR">'
        f'<c:comp-filter name="VEVENT"><c:time-range start="{start}" end="{end}"/>'
        '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>'
    )


class AttendeeIn(BaseModel):
    email: str
    name: str | None = None


class RRuleSimple(BaseModel):
    freq: Literal["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]
    interval: int = 1
    until: str | None = None  # ISO date (end of day in Berlin → UNTIL in UTC)
    count: int | None = None


class EventCreate(BaseModel):
    summary: str
    start: str                 # ISO datetime; for all_day "YYYY-MM-DD"
    end: str
    all_day: bool = False
    calendar: str | None = None
    location: str | None = None
    description: str | None = None
    busy_status: Literal["free", "busy", "tentative", "oof"] = "busy"
    rrule: RRuleSimple | None = None
    alarm_minutes: int | None = None
    attendees: list[AttendeeIn] = []
    tzid: str | None = None    # time zone of the event (default Europe/Berlin)


class EventUpdate(EventCreate):
    rrule_keep: bool = False   # True = leave an existing (complex) RRULE untouched
    only_this: bool = False    # only this occurrence of the series (RECURRENCE-ID override)
    recurrence_id: str | None = None


def _rrule_line(r: RRuleSimple) -> str:
    parts = [f"FREQ={r.freq}"]
    if r.interval and r.interval > 1:
        parts.append(f"INTERVAL={r.interval}")
    if r.until:
        end_local = datetime.fromisoformat(r.until).replace(hour=23, minute=59, second=59, tzinfo=_TZ_BERLIN)
        parts.append("UNTIL=" + end_local.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    elif r.count:
        parts.append(f"COUNT={r.count}")
    return "RRULE:" + ";".join(parts)


def _dt_lines(body: EventCreate) -> tuple[str, str]:
    if body.all_day:
        d0 = datetime.fromisoformat(body.start[:10]).date()
        d1 = datetime.fromisoformat(body.end[:10]).date()
        if d1 <= d0:
            d1 = d0 + timedelta(days=1)  # DTEND is exclusive
        return (f"DTSTART;VALUE=DATE:{d0.strftime('%Y%m%d')}",
                f"DTEND;VALUE=DATE:{d1.strftime('%Y%m%d')}")
    tzid = (body.tzid or "").strip()
    if tzid and tzid != "Europe/Berlin":
        try:
            tz = ZoneInfo(tzid)
        except Exception:
            raise HTTPException(status_code=400, detail=f"Unbekannte Zeitzone: {tzid}")
        def loc(iso: str) -> str:
            # A naive time is wall-clock time in the event's own zone.
            d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            if d.tzinfo is None:
                d = d.replace(tzinfo=tz)
            return d.astimezone(tz).strftime("%Y%m%dT%H%M%S")
        return (f"DTSTART;TZID={tzid}:{loc(body.start)}", f"DTEND;TZID={tzid}:{loc(body.end)}")
    return (f"DTSTART;TZID=Europe/Berlin:{_ical_local(body.start)}",
            f"DTEND;TZID=Europe/Berlin:{_ical_local(body.end)}")


def _attendee_lines(organizer_email: str, organizer_cn: str, attendees: list[AttendeeIn]) -> list[str]:
    lines = [f"ORGANIZER;CN={organizer_cn}:mailto:{organizer_email}"]
    for a in attendees:
        cn = f";CN={a.name}" if a.name else ""
        lines.append(_fold(
            f"ATTENDEE{cn};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;"
            f"CUTYPE=INDIVIDUAL:mailto:{a.email}"))
    return lines


def _valarm_lines(minutes: int) -> list[str]:
    return ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Erinnerung",
            f"TRIGGER:-PT{int(minutes)}M", "END:VALARM"]


def _build_vevent(uid: str, body: EventCreate, organizer_email: str | None,
                  organizer_cn: str = "", sequence: int = 0) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    busy = _BUSY_PROPS[body.busy_status]
    dtstart, dtend = _dt_lines(body)
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ClaraOS//planner//EN"]
    if not body.all_day and (not body.tzid or body.tzid == "Europe/Berlin"):
        lines.append(_VTIMEZONE_BERLIN)
    lines += ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}", f"SEQUENCE:{sequence}",
              dtstart, dtend, _fold(f"SUMMARY:{_esc(body.summary)}")]
    if body.location:
        lines.append(_fold(f"LOCATION:{_esc(body.location)}"))
    if body.description:
        lines.append(_fold(f"DESCRIPTION:{_esc(body.description)}"))
    lines.append(f"TRANSP:{busy['transp']}")
    lines.append(f"X-MICROSOFT-CDO-BUSYSTATUS:{busy['xbusy']}")
    if busy["status"]:
        lines.append(f"STATUS:{busy['status']}")
    if body.rrule:
        lines.append(_rrule_line(body.rrule))
    if body.attendees and organizer_email:
        lines += _attendee_lines(organizer_email, organizer_cn or organizer_email, body.attendees)
    if body.alarm_minutes is not None:
        lines += _valarm_lines(body.alarm_minutes)
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(lines)


def _replace_multi(raw: str, keys: set[str], new_lines: list[str]) -> str:
    """Replace all top-level lines for the keys in the first VEVENT (VALARM
    content is skipped); new_lines are inserted before END:VEVENT."""
    out: list[str] = []
    in_block = False
    depth = 0
    inserted = False
    for line in _unfold(raw):
        key = line.split(":", 1)[0].split(";", 1)[0].strip().upper()
        if line == "BEGIN:VEVENT" and not inserted:
            in_block, depth = True, 0
            out.append(line)
            continue
        if in_block and line.startswith("BEGIN:"):
            depth += 1
            out.append(line)
            continue
        if in_block and line.startswith("END:") and depth > 0:
            depth -= 1
            out.append(line)
            continue
        if in_block and depth == 0 and line == "END:VEVENT":
            out.extend(new_lines)
            out.append(line)
            in_block, inserted = False, True
            continue
        if in_block and depth == 0 and key in keys:
            continue  # drop the old line
        out.append(line)
    return "\r\n".join(_fold(l) for l in out)


def _strip_valarms(raw: str) -> str:
    out: list[str] = []
    depth = 0
    for line in _unfold(raw):
        if line == "BEGIN:VALARM":
            depth += 1
            continue
        if line == "END:VALARM" and depth > 0:
            depth -= 1
            continue
        if depth > 0:
            continue
        out.append(line)
    return "\r\n".join(out)


async def _principal_email(nc_user: str, nc_pass: str) -> str | None:
    """calendar-user-address-set of the NC principal — Sabre's scheduling plugin
    matches the ORGANIZER ONLY against this address (otherwise no iMIP mail is sent)."""
    from routers.files import NEXTCLOUD_INTERNAL_URL
    body = (
        '<?xml version="1.0" encoding="utf-8" ?>'
        '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        '<d:prop><c:calendar-user-address-set/></d:prop></d:propfind>'
    )
    try:
        resp = await _dav("PROPFIND", f"{NEXTCLOUD_INTERNAL_URL}/remote.php/dav/principals/users/{nc_user}/",
                          nc_user, nc_pass, body)
        m = re.search(r"mailto:([^<\s]+)", resp.text or "")
        return m.group(1) if m else None
    except Exception as e:
        logger.warning("planner _principal_email: %s", e)
        return None


async def _cals_for(nc_user: str, nc_pass: str, calendar: str | None) -> list[dict]:
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    if not cals:
        raise HTTPException(status_code=404, detail=Text("planner.noCalendar"))
    if calendar:
        f = [c for c in cals if c["name"] == calendar]
        if f:
            return f
    return cals


async def _due_tasks_between(token: str, start: str, end: str) -> list[dict]:
    tasks: list[dict] = []
    for page in range(1, 41):
        resp = await _upstream("GET", "tasks", token, params={"per_page": "50", "page": str(page)})
        batch = resp.json() if resp.status_code == 200 else []
        if not isinstance(batch, list) or not batch:
            break
        tasks.extend(batch)
        if len(batch) < 50:
            break
    lo, hi = start[:10], end[:10]
    return [
        {"id": t["id"], "project_id": t.get("project_id"), "title": t.get("title"),
         "done": t.get("done"), "due_date": t.get("due_date"), "priority": t.get("priority")}
        for t in tasks
        if isinstance(t, dict) and t.get("due_date") and not str(t["due_date"]).startswith("0001-")
        and lo <= str(t["due_date"])[:10] <= hi
    ]


@router.get("/events")
async def list_events(start: str, end: str, request: Request):
    """Like /calendar, but with expanded series + full event fields
    (busy_status, attendees, rrule, alarm, location, description)."""
    await _ensure_tables()
    user = _caller(request)
    nc_user, nc_pass = await _nc_credentials(user)
    s, e = _range_stamp(start), _range_stamp(end)
    rep_expanded = _report_events_expanded(s, e)
    rep_plain = _report_events(s, e)
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    events: list[dict] = []
    for cal in cals:
        resp = await _dav("REPORT", cal["url"], nc_user, nc_pass, rep_expanded)
        texts = _calendar_data_texts(resp) if resp.status_code == 207 else []
        if resp.status_code != 207:
            # Fallback: master only (show the series once instead of crashing)
            resp = await _dav("REPORT", cal["url"], nc_user, nc_pass, rep_plain)
            texts = _calendar_data_texts(resp)
        for ics in texts:
            for blk in _blocks(ics, "VEVENT"):
                try:
                    events.append(_event_out(blk, cal))
                except Exception as ex:  # one broken event must not kill the list
                    logger.warning("planner list_events: parse-Fehler in %s: %s", cal["name"], ex)
    events.sort(key=lambda ev: ev["start"] or "9999")

    # Users without a Vikunja token would otherwise get a 424 here and no
    # calendar at all — tasks are an extra, the calendar must still work.
    tasks: list[dict] = []
    try:
        token = await _vikunja_token(user)
        tasks = await _due_tasks_between(token, start, end)
    except HTTPException as exc:
        if exc.status_code != 424:
            raise
    return {"events": events, "tasks": tasks}


@router.get("/events/{uid}")
async def get_event(uid: str, request: Request, calendar: str | None = None):
    """Master event for the editor (rrule_raw instead of an expanded instance)."""
    user = _caller(request)
    nc_user, nc_pass = await _nc_credentials(user)
    cals = await _cals_for(nc_user, nc_pass, calendar)
    url, raw, _etag = await _resolve_item(nc_user, nc_pass, cals, _REPORT_VEVENT_ALL, "VEVENT", uid)
    cal = next((c for c in cals if url.startswith(c["url"]) or c["url"] in url), cals[0])
    for blk in _blocks(raw, "VEVENT"):
        if _first(blk, "UID") == uid and not _first(blk, "RECURRENCE-ID"):
            return _event_out(blk, cal)
    for blk in _blocks(raw, "VEVENT"):
        if _first(blk, "UID") == uid:
            return _event_out(blk, cal)
    raise HTTPException(status_code=404, detail=Text("planner.eventNotFound"))


@router.post("/events")
async def create_event(body: EventCreate, request: Request):
    await _ensure_tables()
    user = _caller(request)
    nc_user, nc_pass = await _nc_credentials(user)
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    if not cals:
        raise HTTPException(status_code=404, detail=Text("planner.noCalendar"))
    target = _default_target(cals, body.calendar)
    if not target.get("writable", True):
        raise HTTPException(status_code=403, detail=Text("planner.calendarReadOnly", name=target["name"]))

    organizer_email = None
    warning = None
    if body.attendees:
        organizer_email = await _principal_email(nc_user, nc_pass)
        if not organizer_email:
            warning = await tx("planner.attendeesNotSaved")
            body = body.model_copy(update={"attendees": []})

    uid = str(uuid.uuid4())
    from routers.planner_kalender import invalidate_agenda
    invalidate_agenda(user)
    ical = _build_vevent(uid, body, organizer_email, organizer_cn=nc_user)
    await _put_ical(target["url"].rstrip("/") + f"/{uid}.ics", nc_user, nc_pass, ical,
                    neu=True, was="Der Termin")
    out = {"ok": True, "uid": uid, "calendar": target["name"]}
    if warning:
        out["warning"] = warning
    return out


def _override_props(body: EventUpdate, master: list[tuple[str, str, str]]) -> list[str]:
    """Property lines for a single-occurrence override: same rules as for the
    master; ORGANIZER/ATTENDEE are taken from the master."""
    busy = _BUSY_PROPS[body.busy_status]
    dtstart, dtend = _dt_lines(body)
    lines = [f"SUMMARY:{_esc(body.summary)}", dtstart, dtend,
             f"TRANSP:{busy['transp']}", f"X-MICROSOFT-CDO-BUSYSTATUS:{busy['xbusy']}"]
    if busy["status"]:
        lines.append(f"STATUS:{busy['status']}")
    if body.location:
        lines.append(f"LOCATION:{_esc(body.location)}")
    if body.description:
        lines.append(f"DESCRIPTION:{_esc(body.description)}")
    for k, p, v in master:
        if k in ("ORGANIZER", "ATTENDEE", "CATEGORIES", "CLASS", "URL"):
            lines.append(f"{k}{';' + p if p else ''}:{v}")
    if body.alarm_minutes is not None:
        lines += _valarm_lines(body.alarm_minutes)
    return lines


@router.put("/events/{uid}")
async def update_event(uid: str, body: EventUpdate, request: Request, calendar: str | None = None):
    """No blind rebuild: _patch_ical preserves EXDATE/CATEGORIES/foreign X-props;
    SEQUENCE+1 is required so Sabre sends iTIP UPDATE mails."""
    await _ensure_tables()
    user = _caller(request)
    from routers.planner_kalender import invalidate_agenda, update_single_occurrence
    invalidate_agenda(user)
    if body.only_this and body.recurrence_id:
        return await update_single_occurrence(user, uid, calendar, body.recurrence_id, body, _override_props)
    nc_user, nc_pass = await _nc_credentials(user)
    cals = await _cals_for(nc_user, nc_pass, calendar)
    url, raw, etag = await _resolve_item(nc_user, nc_pass, cals, _REPORT_VEVENT_ALL, "VEVENT", uid)

    main, _alarm = _split_alarm(next(iter(_blocks(raw, "VEVENT")), []))
    try:
        seq = int(_first(main, "SEQUENCE") or 0) + 1
    except ValueError:
        seq = 1
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    busy = _BUSY_PROPS[body.busy_status]
    dtstart, dtend = _dt_lines(body)

    sets = {
        "SUMMARY": f"SUMMARY:{_esc(body.summary)}",
        "DTSTART": dtstart, "DTEND": dtend,
        "TRANSP": f"TRANSP:{busy['transp']}",
        "X-MICROSOFT-CDO-BUSYSTATUS": f"X-MICROSOFT-CDO-BUSYSTATUS:{busy['xbusy']}",
        "SEQUENCE": f"SEQUENCE:{seq}",
        "DTSTAMP": f"DTSTAMP:{stamp}",
        "LAST-MODIFIED": f"LAST-MODIFIED:{stamp}",
    }
    removes: set[str] = set()
    if busy["status"]:
        sets["STATUS"] = f"STATUS:{busy['status']}"
    else:
        removes.add("STATUS")
    if body.location:
        sets["LOCATION"] = f"LOCATION:{_esc(body.location)}"
    else:
        removes.add("LOCATION")
    if body.description:
        sets["DESCRIPTION"] = f"DESCRIPTION:{_esc(body.description)}"
    else:
        removes.add("DESCRIPTION")
    if not body.rrule_keep:
        if body.rrule:
            sets["RRULE"] = _rrule_line(body.rrule)
        else:
            removes.add("RRULE")

    patched = _patch_ical(raw, "VEVENT", sets, removes)

    # Attendees: replace the complete ATTENDEE/ORGANIZER list (multi-valued —
    # _patch_ical only handles single-valued props)
    organizer_email = None
    warning = None
    if body.attendees:
        organizer_email = await _principal_email(nc_user, nc_pass)
        if not organizer_email:
            warning = await tx("planner.attendeesUnchanged")
    if body.attendees and organizer_email:
        patched = _replace_multi(patched, {"ATTENDEE", "ORGANIZER"},
                                 _attendee_lines(organizer_email, nc_user, body.attendees))
    elif not body.attendees:
        patched = _replace_multi(patched, {"ATTENDEE", "ORGANIZER"}, [])

    # Reminder: replace VALARM blocks
    patched = _strip_valarms(patched)
    if body.alarm_minutes is not None:
        patched = _replace_multi(patched, set(), _valarm_lines(body.alarm_minutes))

    # fold lines properly (folding was lost during _unfold)
    patched = "\r\n".join(_fold(l) for l in _unfold(patched))
    await _put_ical(url, nc_user, nc_pass, patched, etag, "Der Termin")
    out = {"ok": True, "uid": uid, "sequence": seq}
    if warning:
        out["warning"] = warning
    return out


@router.delete("/events/{uid}")
async def delete_event(uid: str, request: Request, calendar: str | None = None,
                       recurrence_id: str | None = None):
    """Delete — goes to the NC trash bin (30 days). With `recurrence_id`, only
    this occurrence of the series (EXDATE in the master)."""
    user = _caller(request)
    from routers.planner_kalender import delete_single_occurrence, invalidate_agenda
    invalidate_agenda(user)
    if recurrence_id:
        return await delete_single_occurrence(user, uid, calendar, recurrence_id)
    nc_user, nc_pass = await _nc_credentials(user)
    cals = await _cals_for(nc_user, nc_pass, calendar)
    url, _raw, etag = await _resolve_item(nc_user, nc_pass, cals, _REPORT_VEVENT_ALL, "VEVENT", uid)
    resp = await _dav("DELETE", url, nc_user, nc_pass, if_match=etag or None)
    _guard_conflict(resp, "Der Termin")
    if resp.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud DELETE failed: {resp.status_code}")
    return {"ok": True, "uid": uid, "trashed": True}


# ── Clara tools: flat endpoints for clara-tools.d/planner.yaml ──────────────
# The tools gateway (clara_tools.py) calls these endpoints with X-Claraos-User
# (chat user) + the static header X-Claraos-Actor: clara. Write actions
# preferably run with Clara's OWN Vikunja token (the action shows up as
# "clara"); fallback = the user's token if the project is not shared with
# clara. Reads always run as the user (their view is what counts).

_CLARA_CRED_USERNAMES = ("clara-agent", "clara")


async def _clara_token() -> str | None:
    from encryption import decrypt_credentials
    # Clara's own (service) account: each candidate name is read as itself.
    for uname in _CLARA_CRED_USERNAMES:
        async with user_tx(uname) as conn:
            row = await conn.fetchrow(
                """
                SELECT credentials FROM claraos_app_credentials
                WHERE username = $1 AND app_id = 'vikunja' AND is_active = TRUE
                LIMIT 1
                """,
                uname,
            )
            if row:
                token = (decrypt_credentials(row["credentials"]) or {}).get("api_token")
                if token:
                    return str(token).strip()
    return None


async def _write_candidates(user: str, request: Request) -> list[tuple[str, str]]:
    """(actor_label, token) candidates for write actions, in the order they are tried."""
    out: list[tuple[str, str]] = []
    if _actor(request, user) != user:
        t = await _clara_token()
        if t:
            out.append(("clara", t))
    out.append((user, await _vikunja_token(user)))
    return out


async def _assert_visible(path: str, user_token: str, what: str) -> None:
    """The caller must see the target with their OWN token before Clara's token writes.

    Writes run as clara first (she may be shared into projects the user can see),
    so without this check any user could write into every project shared with
    clara — including other users' projects.
    """
    resp = await _upstream("GET", path, user_token)
    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail=f"{what} nicht gefunden oder nicht freigegeben")


async def _write_upstream(method: str, path: str, candidates: list[tuple[str, str]],
                          body: bytes | None = None) -> tuple[httpx.Response, str]:
    """Write as clara first; on 403/404 (project not shared) → as the user."""
    resp, label = None, ""
    for label, tok in candidates:
        resp = await _upstream(method, path, tok, body=body)
        if resp.status_code not in (403, 404):
            break
    return resp, label


def _fail(resp: httpx.Response, what: str) -> HTTPException:
    return HTTPException(status_code=502 if resp.status_code >= 500 else resp.status_code,
                         detail=f"{what} fehlgeschlagen ({resp.status_code}): {resp.text[:300]}")


def _slim_task(t: dict, meta: dict | None = None) -> dict:
    out = {
        "id": t.get("id"), "title": t.get("title"), "done": bool(t.get("done")),
        "project_id": t.get("project_id"), "priority": t.get("priority") or 0,
    }
    due = t.get("due_date")
    if due and not str(due).startswith("0001-"):
        out["due_date"] = due
        try:
            out["due_lokal"] = localtime.label(localtime.parse_iso(str(due)))
        except ValueError:
            pass
    if meta:
        if meta.get("in_work_by"):
            out["in_work_by"] = meta["in_work_by"]
        for k in ("estimate_eur", "estimate_minutes", "estimate_tokens"):
            if meta.get(k) is not None:
                out[k] = meta[k]
    return out


class ClaraListTasks(BaseModel):
    project_id: int | None = None
    include_done: bool = False
    query: str | None = None
    limit: int = 30
    # Only tasks with priority >= this (Vikunja 1-5; "hohe Priorität" = 3).
    prioritaet_min: int | None = None


# Vikunja priorities as the app shows them. 1/2 are "low"/"medium", 3 is
# "high", 4 "urgent", 5 "DO NOW" — "high" alone therefore means >= 3.
PRIORITY_NAMES = {0: "keine", 1: "niedrig", 2: "mittel", 3: "hoch", 4: "dringend", 5: "SOFORT (DO NOW)"}
_PAGE_SIZE = 50          # Vikunja caps per_page at 50 regardless of the request
_MAX_PAGES = 60          # 3,000 tasks — a guard against an endless loop, not a window


async def _all_tasks(token: str, project_id: int | None, include_done: bool,
                     search: str | None = None, extra_filter: str | None = None) -> list[dict]:
    """ALL matching tasks, filtered by Vikunja and paginated to the end.

    The old code fetched 3x50 unfiltered tasks (done ones included) and filtered
    afterwards: with ~200 tasks, new ones simply fell out of the window, so the
    assistant created duplicates and checked off the wrong task.
    `search` goes to Vikunja's `s` parameter (case-insensitive, title and
    description); a `title like` filter would be case-sensitive.
    """
    path = f"projects/{project_id}/tasks" if project_id else "tasks"
    conds = [] if include_done else ["done = false"]
    if extra_filter:
        conds.append(extra_filter)
    params = {"per_page": str(_PAGE_SIZE), "sort_by": "id", "order_by": "asc"}
    if conds:
        params["filter"] = " && ".join(conds)
    if search:
        params["s"] = search
    tasks: list[dict] = []
    seen: set = set()
    for page in range(1, _MAX_PAGES + 1):
        resp = await _upstream("GET", path, token, params={**params, "page": str(page)})
        if resp.status_code != 200:
            raise _fail(resp, "Aufgabenliste")
        batch = resp.json() or []
        if not isinstance(batch, list) or not batch:
            break
        for t in batch:
            if isinstance(t, dict) and t.get("id") not in seen:
                seen.add(t.get("id"))
                tasks.append(t)
        if len(batch) < _PAGE_SIZE:
            break
    if not include_done:   # belt and braces, in case a Vikunja version ignores the filter
        tasks = [t for t in tasks if not t.get("done")]
    return tasks


def _due_utc(t: dict) -> datetime | None:
    due = str(t.get("due_date") or "")
    if not due or due.startswith("0001-"):
        return None
    try:
        return localtime.to_utc(due)
    except ValueError:
        return None


@router.post("/clara/list_projects")
async def clara_list_projects(request: Request):
    await _ensure_tables()
    user = _caller(request)
    token = await _vikunja_token(user)
    resp = await _upstream("GET", "projects", token)
    if resp.status_code != 200:
        raise _fail(resp, "Projektliste")
    return {"projects": [
        {"id": p["id"], "title": p.get("title"),
         **({"description": p["description"][:200]} if p.get("description") else {})}
        for p in (resp.json() or []) if isinstance(p, dict) and not p.get("is_archived")
    ]}


@router.post("/clara/list_tasks")
async def clara_list_tasks(body: ClaraListTasks, request: Request):
    await _ensure_tables()
    user = _caller(request)
    token = await _vikunja_token(user)
    q = (body.query or "").strip()
    prio_min = body.prioritaet_min
    if prio_min is not None and not 1 <= prio_min <= 5:
        raise HTTPException(status_code=422, detail="prioritaet_min muss zwischen 1 und 5 liegen "
                                                    "(3 = hoch, 4 = dringend, 5 = SOFORT).")
    # Filtered by Vikunja itself, then checked again here: a list "by priority"
    # must hold ALL such tasks, not the first page of everything.
    tasks = await _all_tasks(token, body.project_id, body.include_done, search=q or None,
                             extra_filter=f"priority >= {prio_min}" if prio_min else None)
    if prio_min:
        tasks = [t for t in tasks if int(t.get("priority") or 0) >= prio_min]
    if q:
        # Title hits first; Vikunja's search also matches descriptions.
        ql = q.lower()
        tasks.sort(key=lambda t: ql not in str(t.get("title", "")).lower())

    def _due_key(t: dict) -> str:
        d = _due_utc(t)
        return d.isoformat() if d else "9999"
    if not q:
        tasks.sort(key=_due_key)
        if prio_min:
            tasks.sort(key=lambda t: -int(t.get("priority") or 0))  # stable: due order within a priority
    total = len(tasks)
    limit = max(1, min(body.limit, 200))
    tasks = tasks[:limit]
    metas = await _meta_for_tasks(user, [t["id"] for t in tasks if "id" in t])
    out = {"total": total, "returned": len(tasks),
           "tasks": [_slim_task(t, metas.get(t.get("id"))) for t in tasks]}
    if prio_min:
        out["filter"] = f"Priorität >= {prio_min} ({PRIORITY_NAMES.get(prio_min, '?')} oder höher)"
    if total > len(tasks):
        out["more"] = (f"{total - len(tasks)} weitere — mit query/project_id eingrenzen "
                       f"oder limit erhöhen (max. 200). Nenne dem Nutzer die Gesamtzahl {total}.")
    if q and not total:
        out["hint"] = (f"No task contains {q!r}. Before creating a new one, try a shorter "
                       "search term; say honestly that nothing was found.")
    return out


class ClaraCountTasks(BaseModel):
    project_id: int | None = None
    query: str | None = None


@router.post("/clara/count_tasks")
async def clara_count_tasks(body: ClaraCountTasks, request: Request):
    """Exact counts of OPEN tasks: total, overdue, due today, by priority."""
    await _ensure_tables()
    user = _caller(request)
    token = await _vikunja_token(user)
    tasks = await _all_tasks(token, body.project_id, False, search=(body.query or "").strip() or None)
    now = datetime.now(timezone.utc)
    today = localtime.to_local(now).date()
    overdue, due_today, no_due = [], 0, 0
    by_prio: dict[int, int] = {}
    for t in tasks:
        prio = int(t.get("priority") or 0)
        by_prio[prio] = by_prio.get(prio, 0) + 1
        d = _due_utc(t)
        if d is None:
            no_due += 1
            continue
        if d < now:
            overdue.append(t)
        elif localtime.to_local(d).date() == today:
            due_today += 1
    return {
        "offen": len(tasks),
        "ueberfaellig": len(overdue),
        "heute_faellig": due_today,
        "ohne_faelligkeit": no_due,
        "nach_prioritaet": {f"{p} ({PRIORITY_NAMES.get(p, '?')})": n
                            for p, n in sorted(by_prio.items(), reverse=True)},
        "hoch_oder_hoeher": sum(n for p, n in by_prio.items() if p >= 3),
        "ueberfaellig_titel": [{"id": t.get("id"), "title": t.get("title"),
                                "due_lokal": localtime.label(_due_utc(t))} for t in overdue[:20]],
        "stand": localtime.label(now),
        "prioritaeten": "Vikunja: 1 niedrig, 2 mittel, 3 hoch, 4 dringend, 5 SOFORT (DO NOW)",
    }


class ClaraTaskRef(BaseModel):
    task_id: int


# ── Compact overview for the organiser assistant ────────────────────────────
# `list_tasks` returns no descriptions, and `get_task` per task means one call
# and ~1,500 tokens per task. The organiser needs ALL open tasks per run with
# what matters for organising — in ONE call, ~150 tokens per task. Plus the
# "done criterion" convention (a block at the end of the task description that
# states when the task counts as done; the marker keywords below are matched
# literally):
#     ✅ Erledigt wenn: <verifiable statement>
#     🤖 Prüfung: <kind> <target>          (optional, class-1 evidence)
#     👤 Typ: maschine | mensch | entscheidung   (machine | human | decision)
_KRIT_RE = re.compile(r"✅\s*Erledigt wenn:\s*(.+)")
_PRUEF_RE = re.compile(r"🤖\s*Pr(?:ü|ue)fung:\s*(\S+)\s*(.*)")
_TYP_RE = re.compile(r"👤\s*Typ:\s*(maschine|mensch|entscheidung)", re.I)
_TAG_RE = re.compile(r"<[^>]+>")


def _text_of(html_or_md: str | None) -> str:
    """Vikunja stores HTML — reduce it to text for regex matching/display."""
    if not html_or_md:
        return ""
    t = _TAG_RE.sub("\n", html_or_md)
    t = t.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<") \
         .replace("&gt;", ">").replace("&quot;", '"')
    return re.sub(r"\n{2,}", "\n", t).strip()


def _kriterium_block(description: str | None) -> dict:
    text = _text_of(description)
    out: dict = {"typ": None, "kriterium": None, "pruefung": None}
    m = _TYP_RE.search(text)
    if m:
        out["typ"] = m.group(1).lower()
    m = _KRIT_RE.search(text)
    if m:
        out["kriterium"] = m.group(1).strip()[:200]
    m = _PRUEF_RE.search(text)
    if m:
        out["pruefung"] = {"art": m.group(1).strip()[:30], "ziel": m.group(2).strip()[:200]}
    return out


class ClaraUebersicht(BaseModel):
    include_done: bool = False
    max_tasks: int = 80
    with_details: bool = True   # also load blocked_by + comments per task


@router.post("/clara/uebersicht")
async def clara_uebersicht(body: ClaraUebersicht, request: Request):
    """All open tasks of all projects, compact, with done criterion, blockers,
    last comment and age — one call for the daily run."""
    await _ensure_tables()
    user = _caller(request)
    token = await _vikunja_token(user)
    presp = await _upstream("GET", "projects", token, params={"per_page": "100"})
    projekte = {p["id"]: p.get("title") for p in (presp.json() or [])
                if presp.status_code == 200 and isinstance(p, dict)}
    tasks: list[dict] = []
    for page in (1, 2, 3, 4):
        resp = await _upstream("GET", "tasks", token, params={"per_page": "50", "page": str(page)})
        if resp.status_code != 200:
            raise _fail(resp, "Aufgabenliste")
        batch = resp.json() or []
        if not isinstance(batch, list) or not batch:
            break
        tasks.extend(t for t in batch if isinstance(t, dict))
        if len(batch) < 50:
            break
    if not body.include_done:
        tasks = [t for t in tasks if not t.get("done")]
    # The collection project "Assistenten" holds the assistants' own runtime
    # entries ("Organiser: trigger") — otherwise the organiser would end up
    # organising itself.
    laufzeit = {pid for pid, title in projekte.items() if title == "Assistenten"}
    tasks = [t for t in tasks if t.get("project_id") not in laufzeit]
    tasks = tasks[: max(1, min(body.max_tasks, 150))]
    metas = await _meta_for_tasks(user, [t["id"] for t in tasks if "id" in t])
    now = dt.datetime.now(dt.timezone.utc)

    sem = asyncio.Semaphore(6)

    async def _details(tid: int) -> dict:
        d: dict = {}
        async with sem:
            try:
                r = await _upstream("GET", f"tasks/{tid}", token)
                if r.status_code == 200:
                    rel = (r.json() or {}).get("related_tasks") or {}
                    if isinstance(rel, dict) and rel.get("blocked"):
                        d["blockiert_von"] = [
                            {"id": x.get("id"), "done": bool(x.get("done"))}
                            for x in rel["blocked"] if isinstance(x, dict)]
                c = await _upstream("GET", f"tasks/{tid}/comments", token)
                if c.status_code == 200 and isinstance(c.json(), list):
                    cs = [x for x in c.json() if isinstance(x, dict)]
                    d["kommentare"] = len(cs)
                    if cs:
                        last = cs[-1]
                        d["letzter_kommentar"] = {
                            "von": (last.get("author") or {}).get("username"),
                            "am": str(last.get("created") or "")[:10],
                            "text": _text_of(last.get("comment"))[:160],
                        }
                        # class-2 evidence: the human writes "erledigt" (done) themselves
                        d["mensch_sagt_erledigt"] = any(
                            (x.get("author") or {}).get("username") == user
                            and re.search(r"\berledigt\b", _text_of(x.get("comment")), re.I)
                            and not re.search(r"nicht erledigt|noch nicht", _text_of(x.get("comment")), re.I)
                            for x in cs[-3:])
            except Exception as e:  # noqa: BLE001
                d["fehler"] = str(e)[:80]
        return d

    details: dict[int, dict] = {}
    if body.with_details:
        got = await asyncio.gather(*[_details(t["id"]) for t in tasks if "id" in t])
        details = {t["id"]: g for t, g in zip([t for t in tasks if "id" in t], got)}

    def _days(ts: str | None) -> int | None:
        if not ts or str(ts).startswith("0001-"):
            return None
        try:
            d0 = dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            return (now - d0).days
        except ValueError:
            return None

    out = []
    for t in tasks:
        tid = t.get("id")
        meta = metas.get(tid) or {}
        krit = _kriterium_block(t.get("description"))
        due = t.get("due_date")
        row = {
            "id": tid,
            "projekt": projekte.get(t.get("project_id"), t.get("project_id")),
            "titel": t.get("title"),
            "prio": t.get("priority") or 0,
            "faellig": None if not due or str(due).startswith("0001-") else str(due)[:10],
            "ueberfaellig": (_days(due) or 0) > 0 if due and not str(due).startswith("0001-") else False,
            "typ": krit["typ"],
            "kriterium": krit["kriterium"],
            "pruefung": krit["pruefung"],
            "labels": [l.get("title") for l in (t.get("labels") or []) if isinstance(l, dict)],
            "tage_seit_aenderung": _days(t.get("updated")),
            "tage_seit_anlage": _days(t.get("created")),
            "in_arbeit_von": meta.get("in_work_by"),
            "beschreibung_kurz": _text_of(t.get("description"))[:140],
        }
        row.update(details.get(tid, {}))
        out.append(row)
    out.sort(key=lambda r: (r["faellig"] or "9999", -r["prio"], r["id"] or 0))
    ohne = [r["id"] for r in out if not r["kriterium"]]
    return {"stand": now.isoformat(timespec="minutes"), "anzahl": len(out),
            "ohne_kriterium": ohne, "aufgaben": out}


@router.post("/clara/get_task")
async def clara_get_task(body: ClaraTaskRef, request: Request):
    await _ensure_tables()
    task_id = body.task_id
    user = _caller(request)
    token = await _vikunja_token(user)
    resp = await _upstream("GET", f"tasks/{task_id}", token)
    if resp.status_code != 200:
        raise _fail(resp, f"Task {task_id} lesen")
    t = resp.json() or {}
    metas = await _meta_for_tasks(user, [task_id])
    out = _slim_task(t, metas.get(task_id))
    if t.get("description"):
        out["description"] = t["description"]
    rel = t.get("related_tasks") or {}
    if isinstance(rel, dict) and rel.get("blocked"):
        out["blocked_by"] = [_slim_task(x) for x in rel["blocked"] if isinstance(x, dict)]
    cresp = await _upstream("GET", f"tasks/{task_id}/comments", token)
    if cresp.status_code == 200 and isinstance(cresp.json(), list):
        out["comments"] = [
            {"author": (c.get("author") or {}).get("username"), "comment": c.get("comment")}
            for c in cresp.json()[-5:] if isinstance(c, dict)
        ]
    return out


class ClaraCreateTask(BaseModel):
    project_id: int
    title: str
    description: str | None = None
    due_date: str | None = None
    priority: int | None = None


def _vikunja_due(value: str) -> str:
    """Due date for Vikunja (RFC 3339, UTC).

    Naive times are local wall-clock time (they used to land in Vikunja as UTC,
    two hours off); a date alone means the END of that local day, so a task
    "due Friday" is not overdue on Friday afternoon.
    """
    try:
        parsed = localtime.parse_iso(value)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail=(f"due_date {value!r} not understood. Use local time YYYY-MM-DDTHH:MM "
                    f"(read as {localtime.LOCAL_TZ_NAME}) or a date YYYY-MM-DD (= end of day)."))
    if not isinstance(parsed, datetime):
        parsed = datetime(parsed.year, parsed.month, parsed.day, 23, 59, tzinfo=localtime.LOCAL_TZ)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _task_result(task_id: int, token: str, want: dict, action: str, extra: dict) -> dict:
    """Read the task back after writing it; `verified` only if it matches `want`."""
    link = f"{(heim_default('CLARAOS_PUBLIC_URL') or '').rstrip('/')}/?app=planner"
    r = await _upstream("GET", f"tasks/{task_id}", token)
    if r.status_code != 200:
        return {"ok": False, "id": task_id, "verified": False, "link": link, **extra,
                "error": f"Task {action}: written, but reading it back failed ({r.status_code}).",
                "hint": "Check with list_tasks/get_task before telling the user it worked."}
    t = r.json() or {}
    mismatch = []
    for key, val in want.items():
        got = t.get(key)
        if key == "due_date":
            same = (_due_utc({"due_date": got}) == (localtime.to_utc(val) if val else None))
        elif key == "title":
            same = str(got or "").strip() == str(val).strip()
        else:
            same = got == val
        if not same:
            mismatch.append(f"{key}: wanted {val!r}, stored {got!r}")
    slim = _slim_task(t)
    out = {"ok": not mismatch, "id": task_id, "verified": not mismatch, "link": link,
           "task": slim, "title": slim.get("title"), "due_lokal": slim.get("due_lokal"),
           "priority": slim.get("priority"),
           "priority_name": PRIORITY_NAMES.get(int(slim.get("priority") or 0)), **extra}
    if mismatch:
        out.update({"error": "Read-back differs: " + "; ".join(mismatch),
                    "hint": "Do not report success; tell the user what is stored."})
    return out


@router.post("/clara/create_task")
async def clara_create_task(body: ClaraCreateTask, request: Request):
    await _ensure_tables()
    user = _caller(request)
    cands = await _write_candidates(user, request)
    await _assert_visible(f"projects/{body.project_id}", cands[-1][1], f"Projekt {body.project_id}")
    payload: dict = {"title": body.title}
    if body.description:
        payload["description"] = body.description
    if body.due_date:
        payload["due_date"] = _vikunja_due(body.due_date)
    if body.priority is not None:
        payload["priority"] = max(0, min(int(body.priority), 5))
    resp, label = await _write_upstream("PUT", f"projects/{body.project_id}/tasks",
                                        cands, body=json.dumps(payload).encode())
    if resp.status_code not in (200, 201):
        raise _fail(resp, "Task anlegen")
    t = resp.json() or {}
    token = dict(cands).get(label) or cands[-1][1]
    want = {k: payload[k] for k in ("title", "due_date", "priority") if k in payload}
    return await _task_result(int(t.get("id") or 0), token, want, "create",
                              {"created_as": label, "project_id": body.project_id})


class ClaraUndoTask(BaseModel):
    task_id: int


@router.post("/clara/undo_task")
async def clara_undo_task(body: ClaraUndoTask, request: Request):
    """"Undo" on the task card in the chat.

    Deletes a task Clara just created — with Clara's token, because the user
    (e.g. a household member or trial account) often has no Vikunja account of
    their own. A hard limit instead of trust: only tasks created less than
    30 minutes ago. Anything older has to be handled in the app.
    """
    await _ensure_tables()
    user = _caller(request)  # logged-in user, otherwise 401
    # Only a task this user can see (a member without an own Vikunja account sees
    # nothing and cannot undo — the app is the place for that).
    await _assert_visible(f"tasks/{body.task_id}", await _vikunja_token(user), f"Aufgabe {body.task_id}")
    cands: list[tuple[str, str]] = []
    t = await _clara_token()
    if t:
        cands.append(("clara", t))
    if not cands:
        raise HTTPException(status_code=503, detail=f"{ASSISTANT_NAME} hat kein Planner-Token")
    resp = await _upstream("GET", f"tasks/{body.task_id}", cands[0][1])
    if resp.status_code != 200:
        raise _fail(resp, "Aufgabe lesen")
    task = resp.json() or {}
    created = str(task.get("created") or "")
    try:
        from datetime import datetime, timezone
        alter_s = (datetime.now(timezone.utc) - datetime.fromisoformat(created.replace("Z", "+00:00"))).total_seconds()
    except Exception:  # noqa: BLE001
        alter_s = 10 ** 9
    if alter_s > 30 * 60:
        raise HTTPException(status_code=409, detail="Rückgängig nur innerhalb von 30 Minuten nach dem Anlegen")
    resp, label = await _write_upstream("DELETE", f"tasks/{body.task_id}", cands)
    if resp.status_code not in (200, 204):
        raise _fail(resp, "Aufgabe löschen")
    return {"ok": True, "task_id": body.task_id, "deleted_as": label}


class ClaraUpdateTask(BaseModel):
    task_id: int
    title: str | None = None
    description: str | None = None
    due_date: str | None = None
    priority: int | None = None
    done: bool | None = None


@router.post("/clara/update_task")
async def clara_update_task(body: ClaraUpdateTask, request: Request):
    """A Vikunja update replaces the WHOLE object → read-modify-write (like the app)."""
    await _ensure_tables()
    user = _caller(request)
    token = await _vikunja_token(user)
    cur = await _upstream("GET", f"tasks/{body.task_id}", token)
    if cur.status_code != 200:
        raise _fail(cur, f"Task {body.task_id} lesen")
    task = cur.json() or {}
    want: dict = {}
    for field in ("title", "description", "due_date", "priority", "done"):
        val = getattr(body, field)
        if val is None:
            continue
        if field == "due_date":
            # "" clears the due date (Vikunja's zero time)
            val = _vikunja_due(val) if val.strip() else "0001-01-01T00:00:00Z"
        if field == "priority":
            val = max(0, min(int(val), 5))
        task[field] = val
        if field != "description":
            want[field] = val if not (field == "due_date" and val.startswith("0001-")) else None
    cands = await _write_candidates(user, request)
    resp, label = await _write_upstream("POST", f"tasks/{body.task_id}", cands,
                                        body=json.dumps(task).encode())
    if resp.status_code not in (200, 201):
        raise _fail(resp, "Task aktualisieren")
    if body.done:
        # Checking off ends the work — otherwise "Clara is working on this"
        # would stay forever (passing through done=True alone is not enough).
        await _release_work(user, int(task.get("project_id") or 0), body.task_id,
                            "automatisch gelöst: Aufgabe abgehakt")
        _inwork_checked.pop((user, body.task_id), None)
    token = dict(cands).get(label) or cands[-1][1]
    return await _task_result(body.task_id, token, want, "update",
                              {"updated_as": label, "done": bool(body.done) if body.done is not None
                               else bool((resp.json() or {}).get("done"))})


@router.post("/clara/complete_task")
async def clara_complete_task(body: ClaraTaskRef, request: Request):
    return await clara_update_task(ClaraUpdateTask(task_id=body.task_id, done=True), request)


class ClaraSetDependency(BaseModel):
    task_id: int
    depends_on_task_id: int


@router.post("/clara/set_dependency")
async def clara_set_dependency(body: ClaraSetDependency, request: Request):
    """task_id is BLOCKED by depends_on_task_id (Gantt arrow)."""
    await _ensure_tables()
    user = _caller(request)
    cands = await _write_candidates(user, request)
    for tid in (body.task_id, body.depends_on_task_id):
        await _assert_visible(f"tasks/{tid}", cands[-1][1], f"Aufgabe {tid}")
    payload = {"task_id": body.task_id, "other_task_id": body.depends_on_task_id,
               "relation_kind": "blocked"}
    resp, label = await _write_upstream("PUT", f"tasks/{body.task_id}/relations",
                                        cands, body=json.dumps(payload).encode())
    if resp.status_code not in (200, 201):
        raise _fail(resp, "Abhängigkeit setzen")
    return {"ok": True, "task_id": body.task_id,
            "depends_on": body.depends_on_task_id, "set_as": label}


class ClaraMoveCard(BaseModel):
    project_id: int
    task_id: int
    bucket: str


@router.post("/clara/move_card")
async def clara_move_card(body: ClaraMoveCard, request: Request):
    """Kanban: move the task into the bucket with the matching title."""
    await _ensure_tables()
    user = _caller(request)
    token = await _vikunja_token(user)
    presp = await _upstream("GET", f"projects/{body.project_id}", token)
    if presp.status_code != 200:
        raise _fail(presp, f"Projekt {body.project_id} lesen")
    views = (presp.json() or {}).get("views") or []
    kanban = next((v for v in views if v.get("view_kind") == "kanban"), None)
    if not kanban:
        raise HTTPException(status_code=404, detail="Projekt hat keine Kanban-Ansicht")
    bresp = await _upstream("GET", f"projects/{body.project_id}/views/{kanban['id']}/buckets", token)
    if bresp.status_code != 200:
        raise _fail(bresp, "Buckets lesen")
    buckets = bresp.json() or []
    want = body.bucket.strip().lower()
    target = next((b for b in buckets if str(b.get("title", "")).strip().lower() == want), None)
    if not target:
        raise HTTPException(
            status_code=404,
            detail=f"Bucket '{body.bucket}' nicht gefunden. Vorhanden: "
                   f"{', '.join(str(b.get('title')) for b in buckets)}")
    await _assert_visible(f"tasks/{body.task_id}", token, f"Aufgabe {body.task_id}")
    cands = await _write_candidates(user, request)
    resp, label = await _write_upstream(
        "POST", f"projects/{body.project_id}/views/{kanban['id']}/buckets/{target['id']}/tasks",
        cands, body=json.dumps({"task_id": body.task_id}).encode())
    if resp.status_code not in (200, 201):
        raise _fail(resp, "Karte verschieben")
    return {"ok": True, "task_id": body.task_id, "bucket": target.get("title"), "moved_as": label}


class ClaraAddComment(BaseModel):
    task_id: int
    comment: str


@router.post("/clara/add_comment")
async def clara_add_comment(body: ClaraAddComment, request: Request):
    await _ensure_tables()
    user = _caller(request)
    cands = await _write_candidates(user, request)
    await _assert_visible(f"tasks/{body.task_id}", cands[-1][1], f"Aufgabe {body.task_id}")
    resp, label = await _write_upstream("PUT", f"tasks/{body.task_id}/comments", cands,
                                        body=json.dumps({"comment": body.comment}).encode())
    if resp.status_code not in (200, 201):
        raise _fail(resp, "Kommentar anlegen")
    return {"ok": True, "task_id": body.task_id, "commented_as": label}


class PlanTask(BaseModel):
    title: str
    description: str | None = None
    due_date: str | None = None
    depends_on: list[int] | None = None  # 1-based indices of earlier tasks in this list


class ClaraProjectPlan(BaseModel):
    title: str
    description: str | None = None
    tasks: list[PlanTask]


@router.post("/clara/create_project_from_plan")
async def clara_create_project_from_plan(body: ClaraProjectPlan, request: Request):
    """Project + tasks + blocked relations in one go (Clara's project planning).

    The project is created as the USER (who should be the owner) and shared
    right away with the Vikunja user 'clara' (right=2, admin) — the tasks are
    then preferably created as clara. depends_on references 1-based task indices.
    """
    await _ensure_tables()
    if not body.tasks:
        raise HTTPException(status_code=422, detail="tasks darf nicht leer sein")
    user = _caller(request)
    token = await _vikunja_token(user)
    ppayload: dict = {"title": body.title}
    if body.description:
        ppayload["description"] = body.description
    presp = await _upstream("PUT", "projects", token, body=json.dumps(ppayload).encode())
    if presp.status_code not in (200, 201):
        raise _fail(presp, "Projekt anlegen")
    project = presp.json() or {}
    project_id = project.get("id")

    # Vikunja 2.x: the fields are username + permission (NOT user_id/right —
    # that yields 1005 "user does not exist" or read-only access; verified live).
    sresp = await _upstream("PUT", f"projects/{project_id}/users", token,
                            body=json.dumps({"username": "clara", "permission": 2}).encode())
    shared_with_clara = sresp.status_code in (200, 201)

    cands = await _write_candidates(user, request)
    created: list[dict] = []
    for i, pt in enumerate(body.tasks, start=1):
        tpayload: dict = {"title": pt.title}
        if pt.description:
            tpayload["description"] = pt.description
        if pt.due_date:
            tpayload["due_date"] = _vikunja_due(pt.due_date)
        tresp, label = await _write_upstream("PUT", f"projects/{project_id}/tasks",
                                             cands, body=json.dumps(tpayload).encode())
        if tresp.status_code not in (200, 201):
            raise HTTPException(
                status_code=502,
                detail=f"Task {i} ('{pt.title}') fehlgeschlagen ({tresp.status_code}); "
                       f"Projekt {project_id} ist angelegt, bisher {len(created)} Tasks.")
        created.append({"index": i, "id": (tresp.json() or {}).get("id"),
                        "title": pt.title, "created_as": label})

    relations = 0
    for i, pt in enumerate(body.tasks, start=1):
        for dep in (pt.depends_on or []):
            if not (1 <= dep <= len(created)) or dep == i:
                continue
            rpayload = {"task_id": created[i - 1]["id"],
                        "other_task_id": created[dep - 1]["id"], "relation_kind": "blocked"}
            rresp, _ = await _write_upstream(
                "PUT", f"tasks/{created[i - 1]['id']}/relations",
                cands, body=json.dumps(rpayload).encode())
            if rresp.status_code in (200, 201):
                relations += 1

    return {"ok": True, "project_id": project_id, "title": body.title,
            "tasks": created, "relations_created": relations,
            "shared_with_clara": shared_with_clara,
            "hint": "Zum Zeigen: claraos_action_navigate_to(app_id='planner', "
                    f"pattern_key='gantt', params={{'project_id': {project_id}}})"}


# ── Make ad-hoc work visible ────────────────────────────────────────────────
#
# The problem this solves: `work/start` only sets the "working on" marker on a
# task that ALREADY exists. The common case, however, is a quick request in the
# chat ("research X") — no task exists, so nothing was visible. Without this
# entry point the model would have to get three calls right in sequence (find
# project → create task → work/start); each one is a chance to get it wrong.

ADHOC_PROJECT_TITLE = ASSISTANT_NAME


async def _find_or_create_project(token: str, title: str) -> int:
    """Project ID for the title (case-insensitive), created if missing. Only for
    the collection projects for ad-hoc work — nothing the user maintains."""
    resp = await _upstream("GET", "projects", token)
    if resp.status_code != 200:
        raise _fail(resp, "Projektliste")
    want = title.strip().lower()
    for p in (resp.json() or []):
        if isinstance(p, dict) and str(p.get("title", "")).strip().lower() == want:
            return int(p["id"])
    cresp = await _upstream("PUT", "projects", token,
                            body=json.dumps({"title": title}).encode())
    if cresp.status_code not in (200, 201):
        raise _fail(cresp, f"Projekt '{title}' anlegen")
    pid = int((cresp.json() or {})["id"])
    # Like create_project_from_plan: share with the Vikunja user 'clara' right
    # away so write actions show up as "clara" instead of the user.
    await _upstream("PUT", f"projects/{pid}/users", token,
                    body=json.dumps({"username": "clara", "permission": 2}).encode())
    return pid


class AdhocWork(BaseModel):
    title: str
    note: str | None = None
    session_id: str | None = None
    # collection project; assistants pass their own bucket here.
    project: str | None = None


@router.post("/clara/start_adhoc_work")
async def start_adhoc_work(body: AdhocWork, request: Request):
    """Find/create the collection project → create the task → mark it "in progress".

    The result contains project_id + task_id so the caller can pass them
    unchanged to `work/finish`.
    """
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="title darf nicht leer sein")
    token = await _vikunja_token(user)
    project_id = await _find_or_create_project(token, body.project or ADHOC_PROJECT_TITLE)

    cands = await _write_candidates(user, request)
    payload: dict = {"title": title[:250]}
    if body.note:
        payload["description"] = body.note
    tresp, created_as = await _write_upstream("PUT", f"projects/{project_id}/tasks",
                                              cands, body=json.dumps(payload).encode())
    if tresp.status_code not in (200, 201):
        raise _fail(tresp, "Ad-hoc-Task anlegen")
    task_id = int((tresp.json() or {})["id"])

    await work_start(WorkStart(project_id=project_id, task_id=task_id,
                               session_id=body.session_id, note=body.note), request)
    return {"ok": True, "project_id": project_id, "task_id": task_id,
            "in_work_by": actor, "created_as": created_as,
            "hint": "Zum Abschluss: finish_work(project_id, task_id, note=<Ergebnis>, "
                    "complete=true) — sonst bleibt die Markierung stehen."}


# ── Cost/time transparency ──────────────────────────────────────────────────

@router.get("/projects/{project_id}/costs")
async def project_costs(project_id: int, request: Request):
    """Actual costs (clara-agent cost_events) + estimates (sidecar) + time
    (worklog) for a project, aggregated per task.

    Authorization = project access: the caller must be able to read the project
    with their Vikunja token (owner or shared); only then do we query the
    admin-gated clara-agent cost interface service-to-service.
    """
    await _ensure_tables()
    user = _caller(request)

    # 1. Access check via Vikunja (403/404 if it is not the caller's project)
    token = await _vikunja_token(user)
    presp = await _upstream("GET", f"projects/{project_id}", token)
    if presp.status_code != 200:
        raise HTTPException(status_code=presp.status_code if presp.status_code in (403, 404) else 502,
                            detail=f"Kein Zugriff auf Projekt {project_id} ({presp.status_code})")

    # 2. Actual costs from clara-agent (grouped by task_id). Degrades gracefully:
    #    cost backend unreachable → costs=None, UI shows "not available".
    costs_by_task: dict[int, dict] = {}
    cost_total = None
    cost_available = True
    try:
        async with httpx.AsyncClient(verify=False, timeout=10) as c:
            r = await c.get(f"{CLARA_AGENT_ADMIN_URL}/v1/admin/costs/by-ref",
                            params={"project_id": project_id, "group_by": "task"},
                            headers=clara_agent_headers({"X-User-Role": "admin", "X-User-Id": user}))
        if r.status_code == 200:
            data = r.json()
            cost_total = data.get("total")
            for g in data.get("groups", []):
                ref = g.get("ref")
                if ref is None:
                    continue
                try:
                    costs_by_task[int(ref)] = g
                except (ValueError, TypeError):
                    costs_by_task.setdefault(0, g)  # project-wide, without task_id
        else:
            cost_available = False
    except Exception as e:
        logger.warning("planner project_costs: clara-agent unreachable: %s", e)
        cost_available = False

    # 3. Estimates (sidecar) + worklog time
    async with user_tx(user) as conn:
        meta_rows = await conn.fetch(
            "SELECT task_id, estimate_eur, estimate_tokens, estimate_minutes "
            "FROM claraos_planner_meta WHERE username = $1 AND project_id = $2",
            user, project_id)
        work_rows = await conn.fetch(
            """
            SELECT task_id,
                   COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))), 0) AS seconds,
                   COUNT(*) FILTER (WHERE finished_at IS NULL) AS open_sessions
            FROM claraos_planner_worklog WHERE username = $1 AND project_id = $2
            GROUP BY task_id
            """,
            user, project_id)
    estimates = {r["task_id"]: {
        "estimate_eur": float(r["estimate_eur"]) if r["estimate_eur"] is not None else None,
        "estimate_tokens": r["estimate_tokens"], "estimate_minutes": r["estimate_minutes"],
    } for r in meta_rows}
    worklog = {r["task_id"]: {"worked_minutes": round(float(r["seconds"]) / 60, 1),
                              "open_sessions": r["open_sessions"]} for r in work_rows}

    # 4. Merge — union of all task_ids from costs/estimates/worklog
    task_ids = set(costs_by_task) | set(estimates) | set(worklog)
    task_ids.discard(0)
    tasks = []
    for tid in sorted(task_ids):
        c = costs_by_task.get(tid, {})
        tasks.append({
            "task_id": tid,
            "cost_eur": round(c["cost_eur"], 6) if c.get("cost_eur") is not None else None,
            "input_tokens": c.get("input_tokens"), "output_tokens": c.get("output_tokens"),
            "events": c.get("events"),
            **estimates.get(tid, {"estimate_eur": None, "estimate_tokens": None, "estimate_minutes": None}),
            **worklog.get(tid, {"worked_minutes": None, "open_sessions": 0}),
        })
    return {
        "project_id": project_id,
        "cost_available": cost_available,
        "total": cost_total,
        "project_estimate": estimates.get(0),
        "tasks": tasks,
    }


@router.get("/costs/overview")
async def costs_overview(request: Request, days: int = 30):
    """Costs across ALL of the caller's projects: all-time + period (daily
    approximation via group_by=day — by-ref has no since param) + top tasks.

    Two by-ref calls per project (semaphore 4, per-project degradation);
    estimates/worklog are scoped by username, one SQL query each.
    """
    await _ensure_tables()
    user = _caller(request)
    token = await _vikunja_token(user)

    presp = await _upstream("GET", "projects", token)
    if presp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Vikunja projects: {presp.status_code}")
    projects = [p for p in (presp.json() or []) if isinstance(p, dict) and "id" in p]

    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    sem = asyncio.Semaphore(4)
    any_cost_error = False

    async def fetch_project(p: dict) -> dict:
        nonlocal any_cost_error
        pid = p["id"]
        out = {"project_id": pid, "title": p.get("title", f"Projekt {pid}"),
               "is_archived": bool(p.get("is_archived")),
               "cost_eur": None, "range_cost_eur": None, "tokens": None, "events": None,
               "task_groups": []}
        async with sem:
            try:
                async with httpx.AsyncClient(verify=False, timeout=10) as c:
                    rt, rd = await asyncio.gather(
                        c.get(f"{CLARA_AGENT_ADMIN_URL}/v1/admin/costs/by-ref",
                              params={"project_id": pid, "group_by": "task"},
                              headers=clara_agent_headers({"X-User-Role": "admin", "X-User-Id": user})),
                        c.get(f"{CLARA_AGENT_ADMIN_URL}/v1/admin/costs/by-ref",
                              params={"project_id": pid, "group_by": "day"},
                              headers=clara_agent_headers({"X-User-Role": "admin", "X-User-Id": user})),
                    )
                if rt.status_code == 200:
                    data = rt.json()
                    total = data.get("total") or {}
                    if total:
                        out["cost_eur"] = round(total.get("cost_eur") or 0, 6)
                        out["tokens"] = (total.get("input_tokens") or 0) + (total.get("output_tokens") or 0)
                        out["events"] = total.get("events")
                    out["task_groups"] = [g for g in data.get("groups", []) if g.get("ref") is not None]
                else:
                    any_cost_error = True
                if rd.status_code == 200:
                    rc = 0.0
                    for g in rd.json().get("groups", []):
                        ref = str(g.get("ref") or "")
                        if ref >= cutoff and g.get("cost_eur") is not None:
                            rc += g["cost_eur"]
                    out["range_cost_eur"] = round(rc, 6)
                else:
                    any_cost_error = True
            except Exception as e:
                logger.warning("costs_overview: clara-agent für Projekt %s nicht erreichbar: %s", pid, e)
                any_cost_error = True
        return out

    results = await asyncio.gather(*(fetch_project(p) for p in projects))

    # estimates + worklog scoped by username, ONE query per table
    async with user_tx(user) as conn:
        est_rows = await conn.fetch(
            "SELECT project_id, SUM(estimate_eur) AS estimate_eur FROM claraos_planner_meta "
            "WHERE username = $1 GROUP BY project_id", user)
        work_rows = await conn.fetch(
            """
            SELECT project_id,
                   COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))), 0) AS seconds,
                   COUNT(*) FILTER (WHERE finished_at IS NULL) AS open_sessions
            FROM claraos_planner_worklog WHERE username = $1 GROUP BY project_id
            """, user)
    est = {r["project_id"]: float(r["estimate_eur"]) if r["estimate_eur"] is not None else None
           for r in est_rows}
    work = {r["project_id"]: {"worked_minutes": round(float(r["seconds"]) / 60, 1),
                              "open_sessions": r["open_sessions"]} for r in work_rows}

    out_projects, top = [], []
    total_all = {"cost_eur": 0.0, "tokens": 0, "events": 0}
    range_all = {"cost_eur": 0.0, "tokens": 0, "events": 0}
    for r in results:
        pid = r.pop("project_id")
        groups = r.pop("task_groups")
        w = work.get(pid, {"worked_minutes": None, "open_sessions": 0})
        out_projects.append({"project_id": pid, **r, "estimate_eur": est.get(pid), **w})
        if r["cost_eur"] is not None:
            total_all["cost_eur"] += r["cost_eur"]
            total_all["tokens"] += r["tokens"] or 0
            total_all["events"] += r["events"] or 0
        if r["range_cost_eur"] is not None:
            range_all["cost_eur"] += r["range_cost_eur"]
        for g in groups:
            try:
                tid = int(g["ref"])
            except (ValueError, TypeError):
                continue
            top.append({"project_id": pid, "task_id": tid,
                        "cost_eur": round(g.get("cost_eur") or 0, 6),
                        "tokens": (g.get("input_tokens") or 0) + (g.get("output_tokens") or 0),
                        "events": g.get("events")})
    top.sort(key=lambda t: t["cost_eur"], reverse=True)
    cost_available = not any_cost_error or any(p["cost_eur"] is not None for p in out_projects)

    out_projects.sort(key=lambda p: (p["cost_eur"] or 0), reverse=True)
    return {
        "cost_available": cost_available,
        "days": days,
        "total": {**total_all, "cost_eur": round(total_all["cost_eur"], 6)} if cost_available else None,
        "range_total": {**range_all, "cost_eur": round(range_all["cost_eur"], 6)} if cost_available else None,
        "projects": out_projects,
        "top_tasks": top[:15],
    }


@router.get("/health")
async def health():
    """Vikunja liveness from the BFF's point of view (without a user token)."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{VIKUNJA_INTERNAL_URL}/health")
        return {"ok": r.status_code == 200, "upstream_status": r.status_code}
    except Exception as e:
        return {"ok": False, "error": str(e)}
