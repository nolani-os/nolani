"""DBOS-backed agent orchestration.

DBOS Transact gives us durable workflows on top of Postgres:
  - Workflows survive process restarts (steps tracked in DB).
  - @DBOS.workflow + @DBOS.step decorators replace ad-hoc state code.
  - DBOS.start_workflow() returns a handle that can be queried later.
  - Queue-concurrency limits give atomic-claim semantics for sub-agents.

Components: the DBOS singleton + 3 queues + smoke workflow, and
the `agent_tasks` table (high-level task-tree visible to
human operators in the dashboard) plus the atomic claim_next_task()
helper using FOR UPDATE SKIP LOCKED.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from typing import Any, Optional

logger = logging.getLogger(__name__)
# Surface our INFO/WARN/ERROR — the FastAPI default config keeps
# library loggers at WARNING, but we need visibility into the
# LISTEN/NOTIFY pipeline.
logger.setLevel(logging.INFO)
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    logger.addHandler(_h)
    logger.propagate = False


# ── agent_tasks schema ─────────────────────────────────────────────────
#
# agent_tasks is the user-facing task-tree (visible in the dashboard).
# DBOS workflows are the implementation-detail layer that handles
# execution + retries — most agent_task rows reference a DBOS workflow_id
# in their dbos_workflow_id column.
#
# Status lifecycle:
#   queued     — created, waiting for a worker to claim
#   claimed    — worker reserved it (claim_next_task), not yet running
#   running    — worker is actively processing (started_at set)
#   done       — finished successfully (finished_at + result set)
#   failed     — finished with error (finished_at + error set)
#   cancelled  — operator cancelled before completion

AGENT_TASKS_DDL = """
CREATE TABLE IF NOT EXISTS agent_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id UUID REFERENCES agent_tasks(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL CHECK (status IN ('queued','claimed','running','done','failed','cancelled')),
    claimed_by TEXT,
    claimed_at TIMESTAMPTZ,
    ttl_seconds INT NOT NULL DEFAULT 3600,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    result JSONB,
    error TEXT,
    op_work_package_id INT,
    dbos_workflow_id TEXT,
    created_by_user TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_tasks_parent_idx
    ON agent_tasks(parent_id);
CREATE INDEX IF NOT EXISTS agent_tasks_status_type_idx
    ON agent_tasks(status, type, created_at)
    WHERE status IN ('queued','claimed','running');
CREATE INDEX IF NOT EXISTS agent_tasks_user_idx
    ON agent_tasks(created_by_user, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_tasks_dbos_wf_idx
    ON agent_tasks(dbos_workflow_id)
    WHERE dbos_workflow_id IS NOT NULL;
"""

# DBOS lazy-init: importing the dbos package without DATABASE_URL set throws
# at import-time, so we keep the class-level handles None until configure()
# is called from main.py's lifespan.
_DBOS = None
_QUEUES: dict[str, Any] = {}


def _build_database_url() -> str | None:
    """Read AGENT_ORCHESTRATION_DATABASE_URL or assemble from parts."""
    direct = os.environ.get("AGENT_ORCHESTRATION_DATABASE_URL")
    if direct:
        return direct
    pw = os.environ.get("AGENT_ORCHESTRATION_DB_PASSWORD")
    if not pw:
        return None
    host = os.environ.get("AGENT_ORCHESTRATION_DB_HOST", "shared-postgres")
    port = os.environ.get("AGENT_ORCHESTRATION_DB_PORT", "5432")
    user = os.environ.get("AGENT_ORCHESTRATION_DB_USER", "agent_orch")
    db = os.environ.get("AGENT_ORCHESTRATION_DB_NAME", "agent_orchestration")
    return f"postgresql://{user}:{pw}@{host}:{port}/{db}"


_USER_DB_URL: str | None = None


def configure() -> bool:
    """Wire DBOS up + ensure agent_tasks schema. Safe to call repeatedly."""
    global _DBOS, _USER_DB_URL
    if _DBOS is not None:
        return True

    db_url = _build_database_url()
    if not db_url:
        logger.warning(
            "[orchestrator] AGENT_ORCHESTRATION_DB_PASSWORD missing; "
            "DBOS workflows disabled."
        )
        return False
    _USER_DB_URL = db_url

    try:
        from dbos import DBOS, DBOSConfig, Queue  # type: ignore
    except ImportError as exc:
        logger.warning("[orchestrator] dbos lib not installed: %s", exc)
        return False

    try:
        cfg = DBOSConfig(
            name="claraos-api",
            database_url=db_url,
            log_level=os.environ.get("DBOS_LOG_LEVEL", "INFO"),
        )
        _DBOS = DBOS(config=cfg)
        _QUEUES["clara_react"] = Queue("clara_react", concurrency=4)
        _QUEUES["research_fanout"] = Queue("research_fanout", concurrency=8)
        _QUEUES["routines"] = Queue("routines", concurrency=2)
        _DBOS.launch()
        logger.info("[orchestrator] DBOS launched")
    except Exception:
        logger.exception("[orchestrator] DBOS launch failed")
        _DBOS = None
        return False

    # Ensure agent_tasks schema exists (idempotent).
    try:
        _ensure_schema_sync()
    except Exception:
        logger.exception("[orchestrator] agent_tasks schema setup failed")
    return True


def _ensure_schema_sync() -> None:
    """Run agent_tasks DDL synchronously at startup. Uses psycopg directly
    (bypasses asyncpg pool which doesn't exist yet at this point).
    """
    import psycopg  # type: ignore
    with psycopg.connect(_USER_DB_URL or "", autocommit=True) as conn:
        with conn.cursor() as cur:
            for stmt in AGENT_TASKS_DDL.split(";"):
                stmt = stmt.strip()
                if stmt:
                    cur.execute(stmt)
    logger.info("[orchestrator] agent_tasks schema verified")


def shutdown() -> None:
    global _DBOS
    # Stop the LISTEN consumer first so it doesn't try to use a
    # half-shutdown DBOS.
    try:
        stop_listener()
    except Exception:
        pass
    if _DBOS is not None:
        try:
            _DBOS.destroy()
        except Exception:
            logger.exception("[orchestrator] DBOS destroy raised")
        _DBOS = None


def is_ready() -> bool:
    return _DBOS is not None


def dbos() -> Any:
    """Return the live DBOS instance or raise if not configured."""
    if _DBOS is None:
        raise RuntimeError(
            "DBOS is not configured — call orchestrator.configure() first "
            "or set AGENT_ORCHESTRATION_DB_PASSWORD."
        )
    return _DBOS


def queue(name: str) -> Any:
    """Return a registered queue by name."""
    if name not in _QUEUES:
        raise KeyError(f"queue {name!r} not registered (known: {list(_QUEUES)})")
    return _QUEUES[name]


# ── agent_tasks CRUD + atomic-claim ────────────────────────────────────
#
# These helpers use a per-call psycopg connection (the agent_orchestration
# database is small enough that pool overhead would be wasted). Claim is
# done in a single round-trip via UPDATE-with-CTE-SELECT for atomicity.

async def _connect_async():
    """Return a fresh psycopg AsyncConnection in autocommit mode."""
    if _USER_DB_URL is None:
        raise RuntimeError("orchestrator.configure() not called")
    import psycopg  # type: ignore
    return await psycopg.AsyncConnection.connect(_USER_DB_URL, autocommit=True)


async def create_task(
    *,
    type: str,
    payload: dict[str, Any] | None = None,
    parent_id: str | None = None,
    created_by_user: str | None = None,
    ttl_seconds: int = 3600,
    dbos_workflow_id: str | None = None,
) -> dict[str, Any]:
    """Insert a new agent_task row in 'queued' status. Returns the row."""
    task_id = str(uuid.uuid4())
    async with await _connect_async() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO agent_tasks
                  (id, parent_id, type, payload, status, ttl_seconds,
                   created_by_user, dbos_workflow_id)
                VALUES (%s, %s, %s, %s::jsonb, 'queued', %s, %s, %s)
                RETURNING id, parent_id, type, payload, status, created_at
                """,
                (task_id, parent_id, type, json.dumps(payload or {}),
                 ttl_seconds, created_by_user, dbos_workflow_id),
            )
            row = await cur.fetchone()
            cols = [d[0] for d in cur.description]
    out = dict(zip(cols, row))
    # NOTIFY for live-stream subscribers.
    await _notify("agent_task_created", task_id)
    return out


async def claim_next_task(
    *,
    worker_id: str,
    types: list[str],
) -> Optional[dict[str, Any]]:
    """Atomically claim the oldest queued task whose type matches.

    Uses FOR UPDATE SKIP LOCKED so multiple concurrent workers each
    receive a different row (or None if the queue is empty). Sets
    status='claimed', claimed_by, claimed_at in a single round-trip.
    """
    async with await _connect_async() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE agent_tasks
                   SET status='claimed',
                       claimed_by=%s,
                       claimed_at=NOW(),
                       updated_at=NOW()
                 WHERE id = (
                    SELECT id FROM agent_tasks
                     WHERE status='queued'
                       AND type = ANY(%s)
                     ORDER BY created_at
                     LIMIT 1
                     FOR UPDATE SKIP LOCKED
                 )
                RETURNING id, parent_id, type, payload, status,
                          claimed_by, claimed_at, created_at
                """,
                (worker_id, types),
            )
            row = await cur.fetchone()
            if row is None:
                return None
            cols = [d[0] for d in cur.description]
    out = dict(zip(cols, row))
    await _notify("agent_task_claimed", out["id"])
    return out


async def update_task_status(
    task_id: str,
    *,
    status: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    """Transition a task to running/done/failed/cancelled with metadata."""
    if status not in {"running", "done", "failed", "cancelled"}:
        raise ValueError(f"invalid status {status!r}")
    set_clause = "status=%s, updated_at=NOW()"
    params: list[Any] = [status]
    if status == "running":
        set_clause += ", started_at=COALESCE(started_at, NOW())"
    elif status in {"done", "failed", "cancelled"}:
        set_clause += ", finished_at=NOW()"
    if result is not None:
        set_clause += ", result=%s::jsonb"
        params.append(json.dumps(result))
    if error is not None:
        set_clause += ", error=%s"
        params.append(error)
    params.append(task_id)
    async with await _connect_async() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"UPDATE agent_tasks SET {set_clause} WHERE id=%s",
                params,
            )
    await _notify("agent_task_updated", task_id)


async def get_task(task_id: str) -> Optional[dict[str, Any]]:
    """Fetch a single task by id with all columns."""
    async with await _connect_async() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM agent_tasks WHERE id=%s", (task_id,)
            )
            row = await cur.fetchone()
            if row is None:
                return None
            cols = [d[0] for d in cur.description]
    return dict(zip(cols, row))


async def list_tasks(
    *,
    parent_id: str | None = None,
    status: list[str] | None = None,
    type: list[str] | None = None,
    user: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """List tasks with simple filters. Newest first."""
    sql = "SELECT * FROM agent_tasks"
    where: list[str] = []
    params: list[Any] = []
    if parent_id is not None:
        where.append("parent_id=%s")
        params.append(parent_id)
    if status:
        where.append("status = ANY(%s)")
        params.append(status)
    if type:
        where.append("type = ANY(%s)")
        params.append(type)
    if user:
        where.append("created_by_user=%s")
        params.append(user)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT %s"
    params.append(limit)
    async with await _connect_async() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, params)
            rows = await cur.fetchall()
            cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in rows]


async def task_tree(root_id: str) -> dict[str, Any]:
    """Return the full hierarchical tree from root_id downward as nested
    dict {**root_row, "children": [...]}.

    Used for the dashboard tree-view.
    """
    async with await _connect_async() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                WITH RECURSIVE tree AS (
                  SELECT * FROM agent_tasks WHERE id=%s
                  UNION ALL
                  SELECT t.* FROM agent_tasks t
                    JOIN tree p ON t.parent_id = p.id
                )
                SELECT * FROM tree ORDER BY created_at
                """,
                (root_id,),
            )
            rows = await cur.fetchall()
            cols = [d[0] for d in cur.description]
    flat = [dict(zip(cols, r)) for r in rows]
    if not flat:
        return {}
    by_id = {r["id"]: dict(r, children=[]) for r in flat}
    root = None
    for r in flat:
        node = by_id[r["id"]]
        if r["parent_id"] is None or str(r["parent_id"]) == str(root_id) and r["id"] == root_id:
            if r["id"] == root_id:
                root = node
            else:
                # parent is None but not root — orphan, attach to root
                pass
        else:
            parent = by_id.get(r["parent_id"])
            if parent is not None:
                parent["children"].append(node)
    return root or by_id[flat[0]["id"]]


async def _notify(channel: str, payload: Any) -> None:
    """Emit a lifecycle event to in-memory subscribers + best-effort PG NOTIFY.

    Accepts UUID/str — coerces to str at the boundary so downstream
    serialization never sees raw UUID objects.
    """
    payload_str = str(payload)
    try:
        await _broadcast({"channel": channel, "task_id": payload_str})
    except Exception:
        logger.debug("[orchestrator] in-memory broadcast failed",
                     exc_info=True)
    try:
        async with await _connect_async() as conn:
            async with conn.cursor() as cur:
                await cur.execute(f"NOTIFY {channel}, %s", (payload_str,))
    except Exception:
        logger.debug("[orchestrator] PG NOTIFY %s failed",
                     channel, exc_info=True)


# ── LISTEN/NOTIFY broadcast bus ────────────────────────────────────────
#
# A single long-lived psycopg connection LISTENs on all three task
# channels and fans events out to every active WebSocket subscriber via
# an in-memory asyncio.Queue per subscriber. Subscribers register/
# unregister via the context manager `subscribe()`.
#
# Design:
#   - one background task per process (started lazily on first subscribe)
#   - bounded per-subscriber queue (drops oldest if a client is slow)
#   - JSON-payload includes channel + task-row (or task-id only on errors)

_LISTEN_TASK: Optional[asyncio.Task] = None
_SUBSCRIBERS: list[asyncio.Queue] = []
_LISTEN_LOCK = asyncio.Lock()
_CHANNELS = ("agent_task_created", "agent_task_claimed", "agent_task_updated")


async def _listen_loop() -> None:
    """Long-running LISTEN consumer.

    Tight poll loop that uses notifies(timeout=1.0) — each call drives
    the connection's socket read for up to a second and yields all
    queued notifications. This is the canonical psycopg3-async pattern
    for long-lived listener daemons.
    """
    import psycopg  # type: ignore
    while True:
        try:
            conn = await psycopg.AsyncConnection.connect(
                _USER_DB_URL or "", autocommit=True
            )
            try:
                for ch in _CHANNELS:
                    await conn.execute(f"LISTEN {ch}")
                logger.info("[orchestrator] LISTEN active on %s", _CHANNELS)
                while True:
                    # Drive the connection FIRST so any pending NOTIFY
                    # bytes get read into psycopg's internal queue.
                    await conn.execute("SELECT 1")
                    # Then drain whatever's now queued.
                    async for nf in conn.notifies(timeout=0.5, stop_after=128):
                        logger.info("[orchestrator] NOTIFY %s: %s",
                                    nf.channel, nf.payload)
                        await _broadcast({
                            "channel": nf.channel,
                            "task_id": nf.payload,
                        })
            finally:
                await conn.close()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[orchestrator] LISTEN loop crashed; "
                             "retrying in 5s")
            await asyncio.sleep(5)


def _json_safe(obj: Any) -> Any:
    """Convert datetimes/UUIDs/Decimals to JSON-serializable primitives.
    Used in _broadcast() to ensure ws.send_json() never throws.
    """
    import datetime
    import uuid
    from decimal import Decimal
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, (datetime.datetime, datetime.date)):
        return obj.isoformat()
    if isinstance(obj, uuid.UUID):
        return str(obj)
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return str(obj)


async def _broadcast(event: dict[str, Any]) -> None:
    """Enrich event with the current task-row + push to all subscribers."""
    task_id = event.get("task_id")
    if task_id:
        try:
            row = await get_task(task_id)
            if row is not None:
                event["task"] = _json_safe(row)
        except Exception:
            logger.debug("[orchestrator] enrich failed for %s", task_id,
                         exc_info=True)
    # Fan out (drop on full queue → never block the listener).
    for q in list(_SUBSCRIBERS):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            # Pop oldest to make room — keeps slow clients from
            # blocking the entire bus.
            try:
                q.get_nowait()
                q.put_nowait(event)
            except Exception:
                pass


async def _ensure_listener() -> None:
    """Start the listener background task on first subscribe (idempotent)."""
    global _LISTEN_TASK
    async with _LISTEN_LOCK:
        if _LISTEN_TASK is None or _LISTEN_TASK.done():
            _LISTEN_TASK = asyncio.create_task(_listen_loop())


def stop_listener() -> None:
    """Cancel the LISTEN loop on shutdown."""
    global _LISTEN_TASK
    if _LISTEN_TASK is not None and not _LISTEN_TASK.done():
        _LISTEN_TASK.cancel()
    _LISTEN_TASK = None


class subscribe:
    """Async context manager: registers a subscriber queue + cleans up.

    Usage in WS handler:
        async with orchestrator.subscribe() as queue:
            while True:
                event = await queue.get()
                await ws.send_json(event)
    """
    def __init__(self, max_queue: int = 256) -> None:
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=max_queue)

    async def __aenter__(self) -> asyncio.Queue:
        await _ensure_listener()
        _SUBSCRIBERS.append(self._queue)
        return self._queue

    async def __aexit__(self, *_exc: Any) -> None:
        try:
            _SUBSCRIBERS.remove(self._queue)
        except ValueError:
            pass


# ── Replay/Trace + Metrics ─────────────────────────────────────────────

async def get_workflow_steps(wfid: str) -> list[dict[str, Any]]:
    """Read the DBOS step-history for a workflow_id. Each row is a single
    @DBOS.step() execution with timestamps + output (or None if running).
    """
    if _DBOS is None:
        return []
    try:
        steps = await _DBOS.list_workflow_steps_async(wfid)
    except Exception:
        logger.debug("[orchestrator] list_workflow_steps failed", exc_info=True)
        return []
    out: list[dict[str, Any]] = []
    for s in steps:
        # DBOS returns step rows as dicts (not namedtuple). Use .get().
        if isinstance(s, dict):
            item = {
                "function_id": s.get("function_id"),
                "function_name": s.get("function_name"),
                "child_workflow_id": s.get("child_workflow_id"),
                "output": _json_safe(s.get("output")),
                "error": str(s.get("error")) if s.get("error") else None,
                "started_at_epoch_ms": s.get("started_at_epoch_ms"),
                "completed_at_epoch_ms": s.get("completed_at_epoch_ms"),
            }
        else:
            item = {
                "function_id": getattr(s, "function_id", None),
                "function_name": getattr(s, "function_name", None),
                "child_workflow_id": getattr(s, "child_workflow_id", None),
                "output": _json_safe(getattr(s, "output", None)),
                "error": str(getattr(s, "error", None)) if getattr(s, "error", None) else None,
            }
        out.append(item)
    return out


async def get_metrics(*, since_hours: int = 24) -> dict[str, Any]:
    """Aggregate stats over the last N hours.

    Returns:
      totals: total/queued/running/done/failed/cancelled counts
      by_type: per type {count, avg_duration_s, failure_rate}
      queue_depth: per type, currently queued+claimed
      recent_failures: last 10 failed tasks
    """
    out: dict[str, Any] = {"since_hours": since_hours}
    async with await _connect_async() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT status, COUNT(*) FROM agent_tasks
                 WHERE created_at > NOW() - (%s || ' hours')::interval
                 GROUP BY status
                """,
                (since_hours,),
            )
            out["totals"] = {r[0]: r[1] for r in await cur.fetchall()}

            await cur.execute(
                """
                SELECT type,
                       COUNT(*) AS total,
                       AVG(EXTRACT(EPOCH FROM (finished_at - started_at))) FILTER (
                         WHERE status='done' AND started_at IS NOT NULL AND finished_at IS NOT NULL
                       ) AS avg_dur_s,
                       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END)::float
                         / NULLIF(COUNT(*),0) AS failure_rate
                  FROM agent_tasks
                 WHERE created_at > NOW() - (%s || ' hours')::interval
                 GROUP BY type
                 ORDER BY total DESC
                """,
                (since_hours,),
            )
            out["by_type"] = [
                {
                    "type": r[0],
                    "count": r[1],
                    "avg_duration_s": float(r[2]) if r[2] is not None else None,
                    "failure_rate": float(r[3]) if r[3] is not None else 0.0,
                }
                for r in await cur.fetchall()
            ]

            await cur.execute(
                """
                SELECT type, COUNT(*) FROM agent_tasks
                 WHERE status IN ('queued','claimed')
                 GROUP BY type ORDER BY 2 DESC
                """,
            )
            out["queue_depth"] = [
                {"type": r[0], "depth": r[1]} for r in await cur.fetchall()
            ]

            await cur.execute(
                """
                SELECT id, type, error, finished_at FROM agent_tasks
                 WHERE status='failed'
                   AND created_at > NOW() - (%s || ' hours')::interval
                 ORDER BY finished_at DESC NULLS LAST LIMIT 10
                """,
                (since_hours,),
            )
            out["recent_failures"] = [
                {
                    "id": str(r[0]), "type": r[1],
                    "error": (r[2] or "")[:300],
                    "finished_at": r[3].isoformat() if r[3] else None,
                }
                for r in await cur.fetchall()
            ]
    return out


async def cancel_task(task_id: str) -> bool:
    """Cancel a task. If linked to a DBOS workflow, cancel that too.
    Returns True if the row was updated, False if not found.
    """
    row = await get_task(task_id)
    if row is None:
        return False
    if row["status"] in ("done", "failed", "cancelled"):
        # Already terminal — no-op
        return False
    # 1. Cancel DBOS workflow if linked (fire-and-forget — DBOS will
    #    update its own status; our agent_tasks update follows below).
    wfid = row.get("dbos_workflow_id")
    if wfid and _DBOS is not None:
        try:
            await _DBOS.cancel_workflow_async(wfid)
        except Exception:
            logger.warning("[orchestrator] DBOS cancel %s failed",
                           wfid, exc_info=True)
    # 2. Update the agent_tasks row.
    await update_task_status(task_id, status="cancelled",
                             error="cancelled by operator")
    return True


# ── Smoke-tests ────────────────────────────────────────────────────────
#
# These are tiny workflows used by the runner script (tests/) to verify
# DBOS + Postgres are wired correctly. They are NOT user-facing.

def register_smoke_workflows() -> None:
    """Register smoke-test + demo workflows."""
    if _DBOS is None:
        return

    from dbos import DBOS  # type: ignore

    # ── Hello smoke (kept as a basic end-to-end test) ──────────────────
    @DBOS.workflow()
    async def hello_workflow(name: str) -> dict[str, Any]:
        greeting = await _hello_step1(name)
        await _hello_step2(greeting)
        return await _hello_step3(greeting)

    @DBOS.step()
    async def _hello_step1(name: str) -> str:
        return f"hello, {name}"

    @DBOS.step()
    async def _hello_step2(greeting: str) -> None:
        await asyncio.sleep(2)

    @DBOS.step()
    async def _hello_step3(greeting: str) -> dict[str, Any]:
        return {"greeting": greeting, "completed": True}

    globals()["hello_workflow"] = hello_workflow

    # ── Demo: fan-out + reduce with agent_tasks tracking ───────────────
    #
    # Pattern: a "research" workflow spawns N sub-agent workflows
    # in parallel via the research_fanout queue, waits for all results,
    # and reduces them. Each sub-agent gets its own agent_tasks row so
    # the dashboard can show the tree.

    @DBOS.workflow()
    async def research_fanout_workflow(
        topic: str,
        n_agents: int,
        created_by_user: str | None = None,
    ) -> dict[str, Any]:
        """Demo of agent-orchestration: spawn N parallel sub-agents."""
        # 1. Create the parent agent_tasks row (running).
        parent = await create_task(
            type="research_fanout",
            payload={"topic": topic, "n_agents": n_agents},
            created_by_user=created_by_user,
            dbos_workflow_id=DBOS.workflow_id,
        )
        await update_task_status(parent["id"], status="running")

        # 2. Fan out N sub-agent tasks.
        subs = []
        for i in range(n_agents):
            sub = await create_task(
                type="research_sub",
                payload={"topic": topic, "agent_idx": i},
                parent_id=parent["id"],
                created_by_user=created_by_user,
            )
            subs.append(sub)

        # 3. Spawn N async sub-workflows (DBOS handles concurrency
        #    via the research_fanout queue, max 8 simultaneous).
        # str(sub["id"]) — DBOS pickles args; UUID objects would break
        # downstream JSON serialization in the WS broadcast layer.
        rfq = queue("research_fanout")
        handles = [
            await rfq.enqueue_async(_research_sub_workflow, str(sub["id"]), topic, i)
            for i, sub in enumerate(subs)
        ]

        # 4. Wait for all + collect results.
        # WorkflowHandleAsyncPolling.get_result is itself async-awaitable.
        results = []
        for h in handles:
            results.append(await h.get_result())

        # 5. Reduce + finalize parent.
        summary = {
            "topic": topic,
            "n_completed": len(results),
            "agent_results": results,
        }
        await update_task_status(parent["id"], status="done", result=summary)
        return summary

    @DBOS.workflow()
    async def _research_sub_workflow(
        task_id: str,
        topic: str,
        idx: int,
    ) -> dict[str, Any]:
        """Per-sub-agent workflow. Updates its agent_tasks row as it runs."""
        await update_task_status(task_id, status="running")
        try:
            r = await _research_sub_step(topic, idx)
            await update_task_status(task_id, status="done", result=r)
            return r
        except Exception as exc:
            await update_task_status(task_id, status="failed", error=str(exc))
            raise

    @DBOS.step()
    async def _research_sub_step(topic: str, idx: int) -> dict[str, Any]:
        # Stub — a later version will dispatch to actual agents.
        await asyncio.sleep(1 + idx * 0.3)
        return {"topic": topic, "agent_idx": idx,
                "finding": f"sub-agent #{idx} researched {topic!r}"}

    globals()["research_fanout_workflow"] = research_fanout_workflow
    logger.info("[orchestrator] workflows registered (hello, research_fanout)")
