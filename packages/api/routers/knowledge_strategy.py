"""Knowledge strategy layer: goals, KPIs, action plans, 5 Whys and Pareto.

Split from routers/knowledge.py so the knowledge core (objects, collections,
tree, search, trash) stands on its own: the standalone Knowledge app and an
installation without the strategy tools need only the core. The routes keep
their paths under /api/claraos/knowledge; this module only registers them.

Same rules as the core: identity ALWAYS comes from the trusted headers, every
request path runs in `database.user_tx(user)`, the flat /clara/* routes are
called by the tools gateway. The object model (types goal/kpi/vision, the
claraos_kb_kpi_values table, KPI source validation) stays in the core, because
objects of these types can exist without this module.
"""
from __future__ import annotations

import datetime as dt
import json
import logging

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel

from auth import service_headers
from betriebsprofil import heim_struktur
from database import user_tx
from routers.knowledge import (GOAL_TREE_TYPES, ObjectCreate, _actor, _caller, _create_object,
                               _ensure_tables, _fetch_visible, _jsonb, _require_owner, _uuid,
                               _validate, _vis_for)
from services import kaizen_pareto, kb_strategist, kpi_collector, kpi_progress
from sprache import Text, tx

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/claraos/knowledge", tags=["knowledge"])

# ── Strategy: goals & KPIs ──────────────────────────────────────────────────
# Goal hierarchy = page hierarchy (parent_id). KPIs hang off the goal via the
# 'measured_by' edge; n:m because one KPI may contribute to several goals.
# Measurements live in claraos_kb_kpi_values.

# Allowed values of a KPI's `source` property. The installation adds its own
# (heim_werte.HEIM_KPI_SOURCES, the complete ordered list there).
KPI_SOURCES = heim_struktur("HEIM_KPI_SOURCES", ("manual", "planner", "formula", "clara"))

# Upper bound for one tree fetch. When reached it is LOGGED instead of silently
# truncated: a silent cap reads like completeness.
_KPI_VALUE_BUDGET = 20000


def _vis_alias(alias: str, u: str) -> str:
    """_VIS for a query with a table alias (the constant names the table
    directly and therefore does not fit into recursive CTEs)."""
    return _vis_for(f"{alias}.", u)


def _parse_ts(raw: str | None) -> dt.datetime:
    if not raw:
        return dt.datetime.now(dt.timezone.utc)
    try:
        parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail=f"Ungültiger Zeitpunkt: {raw!r}")
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


async def _series_for(conn, kpi_ids: list[str]) -> dict[str, list[dict]]:
    """Series of several KPIs in ONE query (ascending by ts)."""
    if not kpi_ids:
        return {}
    rows = await conn.fetch(
        "SELECT kpi_id, ts, value, source, note FROM claraos_kb_kpi_values "
        "WHERE kpi_id = ANY($1::uuid[]) ORDER BY kpi_id, ts LIMIT $2",
        kpi_ids, _KPI_VALUE_BUDGET,
    )
    if len(rows) >= _KPI_VALUE_BUDGET:
        logger.warning("kb goals tree: Messwert-Budget %d erreicht — Reihen sind "
                       "gekappt, Fortschritt kann zu niedrig wirken", _KPI_VALUE_BUDGET)
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(str(r["kpi_id"]), []).append(
            {"ts": r["ts"], "value": float(r["value"]),
             "source": r["source"], "note": r["note"]})
    return out


def _kpi_node(row, series: list[dict]) -> dict:
    props = row["properties"]
    if isinstance(props, str):
        props = json.loads(props)
    prog = kpi_progress.compute(props, series)
    # Source and last failure belong visibly on the card; a silent adapter
    # would otherwise look like "not measured yet".
    return {"id": str(row["id"]), "title": row["title"], "icon": row["icon"],
            "owner": row["owner"], "progress": prog,
            "source": props.get("source") if isinstance(props.get("source"), dict) else None,
            "source_error": props.get("source_error")
                            if isinstance(props.get("source_error"), dict) else None}


@router.get("/goals/tree")
async def goals_tree(request: Request, root_id: str | None = None, max_depth: int = 8):
    """Goal tree with progress and traffic light per node.

    Without `root_id`: all visible visions/goals without a goal parent. A goal's
    progress comes from its own KPIs AND its sub-goals (weighted mean); the
    traffic light takes the worst state, so a green goal cannot hide a red KPI.
    """
    await _ensure_tables()
    user = _caller(request)
    max_depth = max(1, min(max_depth, 16))
    types = list(GOAL_TREE_TYPES)
    async with user_tx(user) as conn:
        if root_id:
            root_id = _uuid(root_id, "root_id")
            await _fetch_visible(conn, root_id, user)   # 404 instead of an existence leak
            root_where = "o.id = $3::uuid"
            params: list = [user, types, root_id, max_depth]
        else:
            root_where = ("(o.parent_id IS NULL OR NOT EXISTS "
                          "(SELECT 1 FROM claraos_kb_objects p "
                          " WHERE p.id = o.parent_id AND p.type = ANY($2)))")
            params = [user, types, max_depth]
        depth_param = f"${len(params)}"
        rows = await conn.fetch(
            f"""
            WITH RECURSIVE tree AS (
                SELECT o.id, o.parent_id, o.type, o.title, o.icon, o.owner,
                       o.properties, o.stage, o.position, 0 AS depth
                FROM claraos_kb_objects o
                WHERE o.type = ANY($2) AND {root_where} AND {_vis_alias('o', '$1')}
                UNION ALL
                SELECT o.id, o.parent_id, o.type, o.title, o.icon, o.owner,
                       o.properties, o.stage, o.position, t.depth + 1
                FROM claraos_kb_objects o
                JOIN tree t ON o.parent_id = t.id
                WHERE o.type = ANY($2) AND t.depth < {depth_param}
                  AND {_vis_alias('o', '$1')}
            )
            SELECT * FROM tree ORDER BY depth, position NULLS LAST, title
            """,
            *params,
        )
        node_ids = [str(r["id"]) for r in rows]
        kpi_rows: list = []
        edges: list = []
        if node_ids:
            # KPIs of the goals, VISIBLE ones only (someone else's private KPI
            # must not leak through the tree).
            edges = await conn.fetch(
                f"""
                SELECT l.from_id, l.to_id, o.id, o.title, o.icon, o.owner, o.properties
                FROM claraos_kb_links l
                JOIN claraos_kb_objects o ON o.id = l.to_id
                WHERE l.rel = 'measured_by' AND l.from_id = ANY($2::uuid[])
                  AND o.type = 'kpi' AND {_vis_alias('o', '$1')}
                """,
                user, node_ids,
            )
            kpi_rows = edges
        series = await _series_for(conn, sorted({str(e["id"]) for e in kpi_rows}))

    # KPIs per goal
    kpis_by_goal: dict[str, list[dict]] = {}
    for e in kpi_rows:
        kpis_by_goal.setdefault(str(e["from_id"]), []).append(
            _kpi_node(e, series.get(str(e["id"]), [])))

    # Build nodes, attach children
    nodes: dict[str, dict] = {}
    order: list[str] = []
    for r in rows:
        nid = str(r["id"])
        if nid in nodes:            # guard against multiple paths in the tree
            continue
        props = r["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        nodes[nid] = {
            "id": nid, "type": r["type"], "title": r["title"], "icon": r["icon"],
            "owner": r["owner"], "stage": r["stage"], "depth": r["depth"],
            "parent_id": str(r["parent_id"]) if r["parent_id"] else None,
            "properties": props, "kpis": kpis_by_goal.get(nid, []), "children": [],
        }
        order.append(nid)
    roots: list[dict] = []
    for nid in order:
        parent = nodes[nid]["parent_id"]
        (nodes[parent]["children"] if parent in nodes else roots).append(nodes[nid])

    # Progress bottom-up (deepest nodes first)
    for nid in reversed(order):
        n = nodes[nid]
        parts = [{"attainment": k["progress"]["attainment"],
                  "status": k["progress"]["status"],
                  "weight": k["progress"].get("weight") or 1.0} for k in n["kpis"]]
        parts += [{"attainment": c["progress"]["attainment"],
                   "status": c["progress"]["status"],
                   "weight": kpi_progress.normalize_def(c["properties"])["weight"]}
                  for c in n["children"]]
        n["progress"] = kpi_progress.aggregate(parts)
    return {"tree": roots, "count": len(order)}


# ── Action plan: goal ↔ planner ─────────────────────────────────────────────
# Important: Vikunja stays the ONLY source of truth for tasks. Status, due date
# and assignee are never copied here, only read. The Idea Suite holds only the
# link and the "why".
# Important: no import from planner.py (keeps the routers decoupled): everything
# goes through the loopback with a service token, like promote_idea_to_plan.

_PLANNER = "http://localhost:8090/api/claraos/planner"


def _goal_uri(goal_id: str) -> str:
    return f"claraos://ideas/object/{goal_id}"


async def _planner_call(method: str, path: str, user: str, request: Request,
                        *, json_body=None, params=None):
    headers = service_headers(user, request.headers.get("x-claraos-actor") or None)
    async with httpx.AsyncClient(timeout=45.0, headers=headers) as client:
        return await client.request(method, f"{_PLANNER}{path}", json=json_body, params=params)


async def _require_goal(conn, goal_id: str, user: str, owner_only: bool):
    row = await (_require_owner if owner_only else _fetch_visible)(conn, goal_id, user)
    if row["type"] not in GOAL_TREE_TYPES:
        raise HTTPException(status_code=400, detail=Text("knowledge.notGoal"))
    return row


@router.post("/goals/{goal_id}/action-plan")
async def goal_create_action_plan(goal_id: str, request: Request):
    """Create an action plan = one Vikunja project for this goal.

    Idempotent: if the goal already has a project id, it is returned instead
    of creating a second project.
    """
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        row = await _require_goal(conn, goal_id, user, owner_only=True)
        props = row["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        if props.get("planner_project_id"):
            return {"ok": True, "project_id": props["planner_project_id"], "created": False}

    # Important: deliberately the generic proxy (`PUT projects`) instead of
    # `/clara/create_project_from_plan`: the latter requires at least ONE task
    # (422 on an empty list) since it is Clara's planning endpoint. A fresh action
    # plan is empty, though, and an invented placeholder task in the user's
    # planner would be worse than none.
    resp = await _planner_call("PUT", "/api/projects", user, request, json_body={
        "title": row["title"],
        "description": f"Aktionsplan zum Ziel „{row['title']}“ (Ideen-App).",
    })
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502,
                            detail=Text("knowledge.plannerRejected", status=resp.status_code))
    project_id = (resp.json() or {}).get("id")
    if not project_id:
        raise HTTPException(status_code=502, detail=Text("knowledge.plannerNoId"))

    props["planner_project_id"] = project_id
    async with user_tx(user) as conn:
        await conn.execute(
            "UPDATE claraos_kb_objects SET properties = $2::jsonb, updated_at = NOW() "
            "WHERE id = $1::uuid", goal_id, _jsonb(props))
        await conn.execute(
            "INSERT INTO claraos_kb_activity (object_id, actor, kind, content, meta) "
            "VALUES ($1::uuid, $2, 'handoff', $3, $4::jsonb)",
            goal_id, actor, f"Aktionsplan im Planner angelegt (Projekt {project_id}).",
            _jsonb({"planner_project_id": project_id}))
    return {"ok": True, "project_id": project_id, "created": True}


@router.get("/goals/{goal_id}/action-plan")
async def goal_action_plan(goal_id: str, request: Request):
    """Action plan status, live from Vikunja, nothing mirrored.

    Two sources are merged: the tasks of the goal's project AND individual
    tasks from other projects that are linked to this goal.
    """
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        row = await _require_goal(conn, goal_id, user, owner_only=False)
    props = row["properties"]
    if isinstance(props, str):
        props = json.loads(props)
    project_id = props.get("planner_project_id")

    tasks: list[dict] = []
    warnung = None
    if project_id:
        resp = await _planner_call("GET", f"/api/projects/{project_id}/tasks", user, request,
                                   params={"page": 1, "per_page": 250})
        if resp.status_code == 200 and isinstance(resp.json(), list):
            tasks = [{"project_id": project_id, "task_id": t.get("id"), "title": t.get("title"),
                      "done": bool(t.get("done")), "due_date": t.get("due_date")}
                     for t in resp.json() if isinstance(t, dict)]
        else:
            # Do not swallow: an unreadable project is not an empty plan.
            warnung = await tx("knowledge.projectUnreadable", project=project_id, status=resp.status_code)

    linked = await _planner_call("GET", "/by-object", user, request, params={"object_id": goal_id})
    if linked.status_code == 200:
        known = {(t["project_id"], t["task_id"]) for t in tasks}
        for t in (linked.json() or {}).get("tasks", []):
            if (t["project_id"], t["task_id"]) not in known:
                tasks.append(t)
    elif warnung is None:
        warnung = await tx("knowledge.tasksUnreadable", status=linked.status_code)

    done = sum(1 for t in tasks if t["done"])
    faellig = sorted(t["due_date"] for t in tasks
                     if not t["done"] and t.get("due_date") and not str(t["due_date"]).startswith("0001"))
    return {
        "project_id": project_id,
        "total": len(tasks), "done": done, "open": len(tasks) - done,
        # Important: deliberately separate from KPI progress: 80 % of tasks done at
        # 20 % goal achievement is exactly the information you want to see.
        "next_due": faellig[0] if faellig else None,
        "tasks": tasks[:100],
        "warning": warnung,
    }


class GoalTaskLink(BaseModel):
    project_id: int
    task_id: int


@router.post("/goals/{goal_id}/tasks")
async def goal_link_task(goal_id: str, body: GoalTaskLink, request: Request):
    """Make an existing task contribute to this goal."""
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        row = await _require_goal(conn, goal_id, user, owner_only=False)
    resp = await _planner_call("POST", "/meta/links", user, request, json_body={
        "project_id": body.project_id, "task_id": body.task_id,
        "link": {"kind": "goal", "uri": _goal_uri(goal_id), "label": f"🎯 {row['title']}"},
    })
    if resp.status_code != 200:
        raise HTTPException(status_code=502,
                            detail=Text("knowledge.plannerLinkFailed", status=resp.status_code))
    return {"ok": True}


@router.delete("/goals/{goal_id}/tasks/{task_id}")
async def goal_unlink_task(goal_id: str, task_id: int, project_id: int, request: Request):
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    resp = await _planner_call("POST", "/meta/links", user, request, json_body={
        "project_id": project_id, "task_id": task_id, "remove": True,
        "link": {"kind": "goal", "uri": _goal_uri(goal_id)},
    })
    if resp.status_code != 200:
        raise HTTPException(status_code=502,
                            detail=Text("knowledge.plannerUnlinkFailed", status=resp.status_code))
    return {"ok": True}


# ── Ideas, concepts, impact/effort ──────────────────────────────────────────
# Warning: Clara suggests, the human decides. Suggestions are NOT stored, and
# Clara's estimate lands only in `meta.suggested` on the edge until someone
# confirms it. A tool that sets priorities unasked loses trust at the first
# mistake.

def _rating_from_meta(meta) -> dict:
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except ValueError:
            meta = {}
    return meta if isinstance(meta, dict) else {}


async def _upsert_contribution(conn, object_id: str, goal_id: str, actor: str,
                               patch: dict) -> dict:
    """Create an idea/concept → goal edge or update its rating.

    Merging happens in SQL (`meta || $patch`) so that a confirmed rating and a
    Clara suggestion arriving afterwards do not overwrite each other.
    """
    row = await conn.fetchrow(
        """
        INSERT INTO claraos_kb_links (from_id, to_id, rel, created_by, meta)
        VALUES ($1::uuid, $2::uuid, 'contributes_to', $3, $4::jsonb)
        ON CONFLICT (from_id, to_id, rel) DO UPDATE
            SET meta = claraos_kb_links.meta || $4::jsonb
        RETURNING id, meta
        """,
        object_id, goal_id, actor, _jsonb(patch))
    return {"link_id": str(row["id"]), "meta": _rating_from_meta(row["meta"])}


class SuggestIdeas(BaseModel):
    n: int = 5


@router.post("/goals/{goal_id}/suggest-ideas")
async def goal_suggest_ideas(goal_id: str, body: SuggestIdeas, request: Request):
    """Clara suggests ideas for the goal; NOTHING is stored.

    The return value is a list of suggestions; only "accept" creates an
    object. This keeps the idea space clean when a suggestion is off.
    """
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
    try:
        ideas = await kb_strategist.suggest_ideas(goal_id, user, body.n)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ideas": ideas}


class AcceptIdea(BaseModel):
    title: str
    why: str | None = None
    effort: int | None = None
    impact: int | None = None


@router.post("/goals/{goal_id}/ideas")
async def goal_accept_idea(goal_id: str, body: AcceptIdea, request: Request,
                           background: BackgroundTasks):
    """Accept a suggestion: create the idea and attach it to the goal.

    The supplied estimate counts as confirmed by the human (they just accepted
    the suggestion), so it goes straight into the edge.
    """
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
    obj = await _create_object(user, actor, ObjectCreate(
        type="idea", title=body.title,
        body=f"{body.why}\n" if body.why else "", stage="spark"), background)
    patch = {"rated_by": user, "rated_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    if body.impact is not None:
        patch["impact"] = max(1, min(5, int(body.impact)))
    if body.effort is not None:
        patch["effort"] = max(1, min(5, int(body.effort)))
    async with user_tx(user) as conn:
        link = await _upsert_contribution(conn, obj["id"], goal_id, actor, patch)
    return {"object": obj, **link}


class DevelopConcept(BaseModel):
    goal_id: str | None = None


@router.post("/objects/{idea_id}/develop-concept")
async def object_develop_concept(idea_id: str, body: DevelopConcept, request: Request,
                                 background: BackgroundTasks):
    """Turn an idea into a concept with a fixed outline.

    The concept is a separate object (`derived_from` → idea) so the raw idea
    is kept: later you want to see where something came from.
    """
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    idea_id = _uuid(idea_id, "idea_id")
    goal_id = _uuid(body.goal_id, "goal_id") if body.goal_id else None
    async with user_tx(user) as conn:
        await _fetch_visible(conn, idea_id, user)
        if goal_id:
            await _require_goal(conn, goal_id, user, owner_only=False)
    try:
        draft = await kb_strategist.develop_concept(idea_id, user, goal_id)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    obj = await _create_object(user, actor, ObjectCreate(
        type="concept", title=draft["title"], body=draft["body"],
        properties=draft["structured"], stage="developing"), background)
    async with user_tx(user) as conn:
        await conn.execute(
            "INSERT INTO claraos_kb_links (from_id, to_id, rel, created_by) "
            "VALUES ($1::uuid, $2::uuid, 'derived_from', $3) ON CONFLICT DO NOTHING",
            obj["id"], idea_id, actor)
        link = None
        if goal_id:
            # Clara's estimate stays a SUGGESTION; the human confirms it in the
            # matrix by dragging or clicking.
            link = await _upsert_contribution(conn, obj["id"], goal_id, actor, {
                "suggested": {"impact": draft["impact"], "effort": draft["effort"],
                              "reason": "Schätzung aus der Konzeptausarbeitung"}})
    return {"object": obj, **(link or {})}


class RatingSet(BaseModel):
    impact: int
    effort: int


@router.post("/goals/{goal_id}/contributions/{object_id}")
async def goal_set_contribution(goal_id: str, object_id: str, body: RatingSet,
                                request: Request):
    """Set the rating; this is the human's confirmation."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id, object_id = _uuid(goal_id, "goal_id"), _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
        await _require_owner(conn, object_id, user)
        link = await _upsert_contribution(conn, object_id, goal_id, actor, {
            "impact": max(1, min(5, body.impact)),
            "effort": max(1, min(5, body.effort)),
            "rated_by": user,
            "rated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        })
    return link


@router.post("/goals/{goal_id}/contributions/{object_id}/rate")
async def goal_rate_contribution(goal_id: str, object_id: str, request: Request):
    """Clara estimates; the result lands ONLY under `suggested`."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id, object_id = _uuid(goal_id, "goal_id"), _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
        await _fetch_visible(conn, object_id, user)
    try:
        est = await kb_strategist.rate_contribution(object_id, goal_id, user)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    async with user_tx(user) as conn:
        link = await _upsert_contribution(conn, object_id, goal_id, actor,
                                          {"suggested": est})
    return {"suggested": est, **link}


@router.delete("/goals/{goal_id}/contributions/{object_id}")
async def goal_remove_contribution(goal_id: str, object_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    goal_id, object_id = _uuid(goal_id, "goal_id"), _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_owner(conn, object_id, user)
        res = await conn.execute(
            "DELETE FROM claraos_kb_links WHERE from_id = $1::uuid AND to_id = $2::uuid "
            "AND rel = 'contributes_to'", object_id, goal_id)
    if int(res.split()[-1] or 0) == 0:
        raise HTTPException(status_code=404, detail=Text("knowledge.linkNotFound"))
    return {"ok": True}


@router.get("/goals/{goal_id}/matrix")
async def goal_matrix(goal_id: str, request: Request):
    """All ideas/concepts contributing to this goal, with their ratings.

    Important: the rating lives on the EDGE, not on the object: the same idea
    can rate very differently for another goal. That is why the matrix is
    always filtered to ONE goal.
    """
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        goal = await _require_goal(conn, goal_id, user, owner_only=False)
        rows = await conn.fetch(
            f"""
            SELECT l.id AS link_id, l.meta, o.id, o.type, o.title, o.stage, o.owner,
                   left(o.body, 280) AS body_preview
            FROM claraos_kb_links l
            JOIN claraos_kb_objects o ON o.id = l.from_id
            WHERE l.to_id = $2::uuid AND l.rel = 'contributes_to'
              AND {_vis_alias('o', '$1')}
            ORDER BY o.updated_at DESC LIMIT 300
            """,
            user, goal_id)
    items = []
    for r in rows:
        meta = _rating_from_meta(r["meta"])
        suggested = meta.get("suggested") if isinstance(meta.get("suggested"), dict) else None
        items.append({
            "link_id": str(r["link_id"]), "id": str(r["id"]), "type": r["type"],
            "title": r["title"], "stage": r["stage"], "owner": r["owner"],
            "body_preview": r["body_preview"],
            "impact": meta.get("impact"), "effort": meta.get("effort"),
            "rated_by": meta.get("rated_by"),
            # Report the suggestion separately; the UI shows it faded until
            # someone confirms it.
            "suggested": suggested,
        })
    return {"goal": {"id": goal_id, "title": goal["title"]}, "items": items}


@router.post("/goals/{goal_id}/promote/{object_id}")
async def goal_promote_to_plan(goal_id: str, object_id: str, request: Request):
    """Move an idea/concept into the action plan: a real task in the goal's project.

    Creates the action plan on demand as well; otherwise you would have to
    click somewhere else first just to continue here.
    """
    await _ensure_tables()
    user = _caller(request)
    goal_id, object_id = _uuid(goal_id, "goal_id"), _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        goal = await _require_goal(conn, goal_id, user, owner_only=True)
        obj = await _fetch_visible(conn, object_id, user)
        props = goal["properties"]
        if isinstance(props, str):
            props = json.loads(props)

    project_id = props.get("planner_project_id")
    if not project_id:
        created = await goal_create_action_plan(goal_id, request)
        project_id = created["project_id"]

    resp = await _planner_call("PUT", f"/api/projects/{project_id}/tasks", user, request,
                               json_body={"title": obj["title"][:250],
                                          "description": (obj["body"] or "")[:4000]})
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502,
                            detail=Text("knowledge.taskFailed", status=resp.status_code))
    task_id = (resp.json() or {}).get("id")

    # Back reference: the task points to the goal, the object remembers the task.
    await _planner_call("POST", "/meta/links", user, request, json_body={
        "project_id": project_id, "task_id": task_id,
        "link": {"kind": "goal", "uri": _goal_uri(goal_id), "label": f"🎯 {goal['title']}"}})
    async with user_tx(user) as conn:
        oprops = obj["properties"]
        if isinstance(oprops, str):
            oprops = json.loads(oprops)
        oprops["planner_task_id"] = task_id
        oprops["planner_project_id"] = project_id
        await conn.execute(
            "UPDATE claraos_kb_objects SET properties = $2::jsonb, stage = 'planned', "
            "updated_at = NOW() WHERE id = $1::uuid", object_id, _jsonb(oprops))
        await conn.execute(
            "INSERT INTO claraos_kb_activity (object_id, actor, kind, content, meta) "
            "VALUES ($1::uuid, $2, 'handoff', $3, $4::jsonb)",
            object_id, _actor(request, user),
            f"In den Aktionsplan von „{goal['title']}“ übernommen (Aufgabe {task_id}).",
            _jsonb({"planner_project_id": project_id, "planner_task_id": task_id}))
    return {"ok": True, "project_id": project_id, "task_id": task_id}


# ── Root-cause analysis: 5 Whys and Pareto ───────────────────────────────────
# Important: these are triggered not from a menu item but from a red goal;
# tools you have to go looking for never get used.
# Warning: both methods depend on human knowledge: 5 Whys asks step by step
# (Clara only offers candidate answers), Pareto computes with numbers the human
# enters. An automatic cause distribution would be show without substance.

class WhyStep(BaseModel):
    problem: str
    chain: list[dict] = []


@router.post("/goals/{goal_id}/five-why/step")
async def goal_five_why_step(goal_id: str, body: WhyStep, request: Request):
    """Next "why" question + candidate answers. Stores nothing."""
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
    try:
        return await kb_strategist.five_why_step(goal_id, user, body.problem, body.chain)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/goals/{goal_id}/five-why")
async def goal_five_why_finish(goal_id: str, body: WhyStep, request: Request,
                               background: BackgroundTasks):
    """Evaluate the chain and record it as an analysis object on the goal."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        goal = await _require_goal(conn, goal_id, user, owner_only=False)
    try:
        result = await kb_strategist.five_why_finish(goal_id, user, body.problem, body.chain)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    obj = await _create_object(user, actor, ObjectCreate(
        type="analysis", title=f"5-Why: {body.problem}"[:180],
        body=kb_strategist.five_why_markdown(body.problem, body.chain, result),
        properties={"method": "five_why", "problem": body.problem,
                    "why_chain": body.chain, "root_cause": result["root_cause"],
                    "countermeasures": result["countermeasures"],
                    "goal_title": goal["title"]}), background)
    async with user_tx(user) as conn:
        await conn.execute(
            "INSERT INTO claraos_kb_links (from_id, to_id, rel, created_by) "
            "VALUES ($1::uuid, $2::uuid, 'derived_from', $3) ON CONFLICT DO NOTHING",
            obj["id"], goal_id, actor)
    return {"object": obj, **result}


class ParetoRequest(BaseModel):
    problem: str
    items: list[dict] = []
    cutoff: float = 0.8


@router.post("/goals/{goal_id}/pareto/causes")
async def goal_pareto_causes(goal_id: str, body: WhyStep, request: Request):
    """Cause candidates for the breakdown, WITHOUT numbers (the human enters those)."""
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
    try:
        return await kb_strategist.pareto_causes(goal_id, user, body.problem)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/goals/{goal_id}/pareto")
async def goal_pareto(goal_id: str, body: ParetoRequest, request: Request,
                      background: BackgroundTasks):
    """Compute Pareto and record it as an analysis object.

    The computation is pure (services/kaizen_pareto.py) and returns a
    plain-text error for unusable input instead of silent numbers.
    """
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        goal = await _require_goal(conn, goal_id, user, owner_only=False)

    result = kaizen_pareto.analyse(body.items, body.cutoff)
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])

    obj = await _create_object(user, actor, ObjectCreate(
        type="analysis", title=f"Pareto: {body.problem}"[:180],
        body=kaizen_pareto.markdown(body.problem, result),
        properties={"method": "pareto", "problem": body.problem,
                    "pareto": result["items"], "vital_few": result["vital_few"],
                    "total": result["total"], "unit": result["unit"],
                    "concentration": result["concentration"],
                    "goal_title": goal["title"]}), background)
    async with user_tx(user) as conn:
        await conn.execute(
            "INSERT INTO claraos_kb_links (from_id, to_id, rel, created_by) "
            "VALUES ($1::uuid, $2::uuid, 'derived_from', $3) ON CONFLICT DO NOTHING",
            obj["id"], goal_id, actor)
    return {"object": obj, "result": result}


@router.get("/goals/{goal_id}/analyses")
async def goal_analyses(goal_id: str, request: Request):
    """All analyses for this goal (newest first)."""
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
        rows = await conn.fetch(
            f"""
            SELECT o.id, o.title, o.properties, o.created_at
            FROM claraos_kb_links l JOIN claraos_kb_objects o ON o.id = l.from_id
            WHERE l.to_id = $2::uuid AND l.rel = 'derived_from'
              AND o.type = 'analysis' AND {_vis_alias('o', '$1')}
            ORDER BY o.created_at DESC LIMIT 50
            """, user, goal_id)
    out = []
    for r in rows:
        props = r["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        out.append({"id": str(r["id"]), "title": r["title"],
                    "method": props.get("method"), "problem": props.get("problem"),
                    "root_cause": props.get("root_cause"),
                    "countermeasures": props.get("countermeasures") or [],
                    "vital_few": props.get("vital_few") or [],
                    "pareto": props.get("pareto") or [],
                    "unit": props.get("unit"),
                    "created_at": r["created_at"].isoformat()})
    return {"analyses": out}


class PlanTaskCreate(BaseModel):
    title: str
    description: str | None = None


@router.post("/goals/{goal_id}/action-plan/tasks")
async def goal_add_plan_task(goal_id: str, body: PlanTaskCreate, request: Request):
    """Put a countermeasure directly into the action plan as a task.

    Without this path you would first have to build an object from an analysis
    just to promote it again, even though the measure is already decided.
    """
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        goal = await _require_goal(conn, goal_id, user, owner_only=True)
        props = goal["properties"]
        if isinstance(props, str):
            props = json.loads(props)
    project_id = props.get("planner_project_id")
    if not project_id:
        project_id = (await goal_create_action_plan(goal_id, request))["project_id"]

    resp = await _planner_call("PUT", f"/api/projects/{project_id}/tasks", user, request,
                               json_body={"title": body.title[:250],
                                          "description": (body.description or "")[:4000]})
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502,
                            detail=Text("knowledge.taskFailed", status=resp.status_code))
    task_id = (resp.json() or {}).get("id")
    await _planner_call("POST", "/meta/links", user, request, json_body={
        "project_id": project_id, "task_id": task_id,
        "link": {"kind": "goal", "uri": _goal_uri(goal_id), "label": f"🎯 {goal['title']}"}})
    return {"ok": True, "project_id": project_id, "task_id": task_id}


# ── Flat /clara/ routes for the strategy tools ──────────────────────────────
# The tools gateway only knows fixed URLs without path parameters, hence thin
# wrappers around the same functions. Identity still comes from the trusted
# headers, never from the model's arguments.

class ClaraGoalRef(BaseModel):
    goal_id: str
    n: int = 5


class ClaraObjectGoal(BaseModel):
    object_id: str
    goal_id: str
    impact: int | None = None
    effort: int | None = None


@router.post("/clara/list_goals")
async def clara_list_goals(request: Request):
    """All visible goals with traffic light, so Clara can map "my fitness goal"
    to an id at all."""
    tree = await goals_tree(request)

    def flatten(nodes, out, tiefe=0):
        for n in nodes:
            out.append({
                "id": n["id"], "type": n["type"], "title": n["title"], "depth": tiefe,
                "status": n["progress"]["status"], "attainment": n["progress"]["attainment"],
                "kpis": [{"title": k["title"], "current": k["progress"]["current"],
                          "target": k["progress"]["target"], "unit": k["progress"]["unit"],
                          "status": k["progress"]["status"]} for k in n["kpis"]],
            })
            flatten(n["children"], out, tiefe + 1)
        return out

    return {"goals": flatten(tree["tree"], [])}


@router.post("/clara/suggest_ideas")
async def clara_suggest_ideas(body: ClaraGoalRef, request: Request):
    return await goal_suggest_ideas(body.goal_id, SuggestIdeas(n=body.n), request)


@router.post("/clara/develop_concept")
async def clara_develop_concept(body: ClaraObjectGoal, request: Request,
                                background: BackgroundTasks):
    return await object_develop_concept(
        body.object_id, DevelopConcept(goal_id=body.goal_id), request, background)


@router.post("/clara/rate_contribution")
async def clara_rate_contribution(body: ClaraObjectGoal, request: Request):
    return await goal_rate_contribution(body.goal_id, body.object_id, request)


@router.post("/clara/link_to_goal")
async def clara_link_to_goal(body: ClaraObjectGoal, request: Request):
    if body.impact is None or body.effort is None:
        raise HTTPException(status_code=400,
                            detail="impact und effort (je 1-5) sind Pflicht")
    return await goal_set_contribution(
        body.goal_id, body.object_id, RatingSet(impact=body.impact, effort=body.effort), request)


@router.post("/clara/promote_to_action_plan")
async def clara_promote_to_action_plan(body: ClaraObjectGoal, request: Request):
    return await goal_promote_to_plan(body.goal_id, body.object_id, request)


class ClaraFiveWhy(BaseModel):
    goal_id: str
    problem: str
    chain: list[dict] = []
    finish: bool = False


@router.post("/clara/run_five_why")
async def clara_run_five_why(body: ClaraFiveWhy, request: Request,
                             background: BackgroundTasks):
    """The chat is the natural place for the chain: Clara asks the question and
    the user answers in the same conversation. `finish=true` evaluates and
    creates the analysis."""
    step = WhyStep(problem=body.problem, chain=body.chain)
    if body.finish:
        return await goal_five_why_finish(body.goal_id, step, request, background)
    return await goal_five_why_step(body.goal_id, step, request)


class ClaraPareto(BaseModel):
    goal_id: str
    problem: str
    items: list[dict] = []


@router.post("/clara/pareto_analysis")
async def clara_pareto_analysis(body: ClaraPareto, request: Request,
                                background: BackgroundTasks):
    """Without items: suggest cause candidates. With items: compute and create
    the analysis."""
    if not body.items:
        return await goal_pareto_causes(
            body.goal_id, WhyStep(problem=body.problem), request)
    return await goal_pareto(
        body.goal_id, ParetoRequest(problem=body.problem, items=body.items),
        request, background)


class KpiValueAdd(BaseModel):
    value: float
    ts: str | None = None
    note: str | None = None
    source: str = "manual"


async def _require_kpi(conn, kpi_id: str, user: str, owner_only: bool):
    row = await (_require_owner if owner_only else _fetch_visible)(conn, kpi_id, user)
    if row["type"] != "kpi":
        raise HTTPException(status_code=400, detail=Text("knowledge.notKpi"))
    return row


@router.get("/kpi/{kpi_id}/values")
async def kpi_values(kpi_id: str, request: Request, limit: int = 200):
    await _ensure_tables()
    user = _caller(request)
    kpi_id = _uuid(kpi_id, "kpi_id")
    async with user_tx(user) as conn:
        await _require_kpi(conn, kpi_id, user, owner_only=False)
        rows = await conn.fetch(
            "SELECT id, ts, value, source, note, created_by FROM claraos_kb_kpi_values "
            "WHERE kpi_id = $1::uuid ORDER BY ts DESC LIMIT $2",
            kpi_id, max(1, min(limit, 2000)),
        )
    return {"values": [
        {"id": str(r["id"]), "ts": r["ts"].isoformat(), "value": float(r["value"]),
         "source": r["source"], "note": r["note"], "created_by": r["created_by"]}
        for r in rows
    ]}


@router.post("/kpi/{kpi_id}/values")
async def kpi_add_value(kpi_id: str, body: KpiValueAdd, request: Request):
    """Record a measurement. Same timestamp + same source = correction."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    kpi_id = _uuid(kpi_id, "kpi_id")
    _validate(body.source, KPI_SOURCES, "source")
    ts = _parse_ts(body.ts)
    async with user_tx(user) as conn:
        await _require_kpi(conn, kpi_id, user, owner_only=True)
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_kb_kpi_values (kpi_id, ts, value, source, note, created_by)
            VALUES ($1::uuid, $2, $3, $4, $5, $6)
            ON CONFLICT (kpi_id, ts, source) DO UPDATE
                SET value = EXCLUDED.value, note = EXCLUDED.note
            RETURNING id
            """,
            kpi_id, ts, body.value, body.source, body.note, actor,
        )
    return {"ok": True, "value_id": str(row["id"])}


@router.delete("/kpi/{kpi_id}/values/{value_id}")
async def kpi_delete_value(kpi_id: str, value_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    kpi_id, value_id = _uuid(kpi_id, "kpi_id"), _uuid(value_id, "value_id")
    async with user_tx(user) as conn:
        await _require_kpi(conn, kpi_id, user, owner_only=True)
        res = await conn.execute(
            "DELETE FROM claraos_kb_kpi_values WHERE id = $1::uuid AND kpi_id = $2::uuid",
            value_id, kpi_id)
    if int(res.split()[-1] or 0) == 0:
        raise HTTPException(status_code=404, detail=Text("knowledge.valueNotFound"))
    return {"ok": True}


class MilestoneAdd(BaseModel):
    date: str
    value: float
    label: str | None = None


@router.post("/kpi/{kpi_id}/milestones")
async def kpi_add_milestone(kpi_id: str, body: MilestoneAdd, request: Request):
    """Set a milestone. Same date = correction, not a duplicate."""
    await _ensure_tables()
    user = _caller(request)
    kpi_id = _uuid(kpi_id, "kpi_id")
    tag = _parse_ts(body.date).date().isoformat()
    async with user_tx(user) as conn:
        row = await _require_kpi(conn, kpi_id, user, owner_only=True)
        props = row["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        rest = [m for m in (props.get("milestones") or [])
                if isinstance(m, dict) and str(m.get("date"))[:10] != tag]
        rest.append({"date": tag, "value": body.value,
                     "label": (body.label or "").strip()[:80]})
        rest.sort(key=lambda m: str(m.get("date")))
        props["milestones"] = rest
        await conn.execute(
            "UPDATE claraos_kb_objects SET properties = $2::jsonb, updated_at = NOW() "
            "WHERE id = $1::uuid", kpi_id, _jsonb(props))
    return {"ok": True, "milestones": rest}


@router.delete("/kpi/{kpi_id}/milestones/{tag}")
async def kpi_delete_milestone(kpi_id: str, tag: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    kpi_id = _uuid(kpi_id, "kpi_id")
    async with user_tx(user) as conn:
        row = await _require_kpi(conn, kpi_id, user, owner_only=True)
        props = row["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        rest = [m for m in (props.get("milestones") or [])
                if isinstance(m, dict) and str(m.get("date"))[:10] != tag[:10]]
        props["milestones"] = rest
        await conn.execute(
            "UPDATE claraos_kb_objects SET properties = $2::jsonb, updated_at = NOW() "
            "WHERE id = $1::uuid", kpi_id, _jsonb(props))
    return {"ok": True, "milestones": rest}


@router.get("/kpi/{kpi_id}/progress")
async def kpi_progress_one(kpi_id: str, request: Request):
    """Progress of a KPI including the series for the chart."""
    await _ensure_tables()
    user = _caller(request)
    kpi_id = _uuid(kpi_id, "kpi_id")
    async with user_tx(user) as conn:
        row = await _require_kpi(conn, kpi_id, user, owner_only=False)
        series = (await _series_for(conn, [kpi_id])).get(kpi_id, [])
    props = row["properties"]
    if isinstance(props, str):
        props = json.loads(props)
    return {
        "kpi": {"id": kpi_id, "title": row["title"], "icon": row["icon"]},
        "progress": kpi_progress.compute(props, series),
        "series": [{"ts": s["ts"].isoformat(), "value": s["value"]} for s in series],
        "source": props.get("source") if isinstance(props.get("source"), dict) else None,
        "source_error": props.get("source_error") if isinstance(props.get("source_error"), dict) else None,
    }


# Dashboard order: problems first. An overview that shows "all achieved" in the
# top left and hides the red ones at the bottom is a sedative; the eye goes to
# the top left first (F-pattern).
# Important: `observing` goes explicitly last: a KPI still collecting its
# baseline is nothing to act on. It belongs at the end of the overview, not next
# to the blind ones (that would again confuse lack with intent).
_DASH_RANG = {"behind": 0, "at_risk": 1, "blind": 2, "on_track": 3, "done": 4,
              "observing": 5}


@router.get("/kpi/dashboard")
async def kpi_dashboard(request: Request, days: int = 90):
    """All visible KPIs at a glance, for the overview.

    Important: ONE query for all series (`_series_for` batches), not one per
    tile. With ten KPIs that would otherwise be ten round trips just to open a
    dashboard.

    `days` trims ONLY the returned series for the chart; progress is always
    computed on the full history. Otherwise a narrow time range would shift the
    baseline and recolor the traffic light without anything having changed.
    """
    await _ensure_tables()
    user = _caller(request)
    days = max(7, min(days, 3650))
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            f"""
            SELECT o.id, o.title, o.icon, o.owner, o.properties, o.updated_at,
                   g.id AS goal_id, g.title AS goal_title
            FROM claraos_kb_objects o
            LEFT JOIN claraos_kb_links l ON l.to_id = o.id AND l.rel = 'measured_by'
            LEFT JOIN claraos_kb_objects g ON g.id = l.from_id AND g.deleted_at IS NULL
            WHERE o.type = 'kpi' AND o.deleted_at IS NULL AND {_vis_alias('o', '$1')}
            """,
            user,
        )
        series = await _series_for(conn, sorted({str(r["id"]) for r in rows}))

    grenze = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    kpis = []
    gesehen: set[str] = set()
    for r in rows:
        kid = str(r["id"])
        if kid in gesehen:          # a KPI may hang off several goals
            continue
        gesehen.add(kid)
        props = r["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        voll = series.get(kid, [])
        fortschritt = kpi_progress.compute(props, voll)
        kurz = [s for s in voll
                if s["ts"].replace(tzinfo=s["ts"].tzinfo or dt.timezone.utc) >= grenze]
        kpis.append({
            "id": kid,
            "title": r["title"],
            "goal": ({"id": str(r["goal_id"]), "title": r["goal_title"]}
                     if r["goal_id"] else None),
            "progress": fortschritt,
            "series": [{"ts": s["ts"].isoformat(), "value": s["value"]} for s in kurz],
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        })

    kpis.sort(key=lambda k: (_DASH_RANG.get(k["progress"]["status"], 9),
                             -(k["progress"].get("weight") or 1),
                             (k["title"] or "").lower()))
    return {"kpis": kpis,
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "days": days}


@router.post("/kpi/{kpi_id}/collect")
async def kpi_collect_now(kpi_id: str, request: Request):
    """"Fetch now": gets the value immediately instead of waiting for the schedule.

    Deliberately bypasses the fetch interval (force) so a freshly configured
    source can be tried right away. Errors come back as plain text AND are
    stored on the object, so the card still shows them later.
    """
    await _ensure_tables()
    user = _caller(request)
    kpi_id = _uuid(kpi_id, "kpi_id")
    async with user_tx(user) as conn:
        await _require_kpi(conn, kpi_id, user, owner_only=True)
        row = await conn.fetchrow(
            "SELECT id, title, owner, properties FROM claraos_kb_objects WHERE id = $1::uuid", kpi_id)
        result = await kpi_collector.collect_one(conn, row, force=True)
    return {"result": result}
