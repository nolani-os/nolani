"""list_tasks with prioritaet_min: filtered server-side over ALL tasks, true total.

`python3 -m pytest routers/test_planner_prioritaet.py`
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from routers import planner


def _setup(monkeypatch, tasks):
    seen = {}

    async def fake_all(token, project_id, include_done, search=None, extra_filter=None):
        seen["filter"] = extra_filter
        return list(tasks)

    async def noop():
        return None

    async def fake_token(user):
        return "t"

    async def fake_meta(user, ids):
        return {}

    monkeypatch.setattr(planner, "_all_tasks", fake_all)
    monkeypatch.setattr(planner, "_ensure_tables", noop)
    monkeypatch.setattr(planner, "_vikunja_token", fake_token)
    monkeypatch.setattr(planner, "_meta_for_tasks", fake_meta)
    monkeypatch.setattr(planner, "_caller", lambda request: "alice")
    monkeypatch.setattr(planner, "_slim_task", lambda t, meta: {"id": t["id"], "priority": t["priority"]})
    return seen


def test_priority_filter_goes_to_vikunja_and_reports_the_true_total(monkeypatch):
    tasks = [{"id": i, "priority": p, "title": f"t{i}"} for i, p in enumerate([3, 5, 1, 4, 3, 2] * 10)]
    seen = _setup(monkeypatch, tasks)
    out = asyncio.run(planner.clara_list_tasks(planner.ClaraListTasks(prioritaet_min=3, limit=5), None))
    assert seen["filter"] == "priority >= 3"
    assert out["total"] == 40 and out["returned"] == 5      # belt and braces drops prio 1/2
    assert [t["priority"] for t in out["tasks"]] == [5, 5, 5, 5, 5]  # highest first
    assert "35 weitere" in out["more"] and "40" in out["more"]
    assert out["filter"].startswith("Priorität >= 3")


def test_without_priority_nothing_changes(monkeypatch):
    seen = _setup(monkeypatch, [{"id": 1, "priority": 1, "title": "a"}])
    out = asyncio.run(planner.clara_list_tasks(planner.ClaraListTasks(), None))
    assert seen["filter"] is None and out["total"] == 1 and "filter" not in out


def test_priority_out_of_range_is_rejected(monkeypatch):
    _setup(monkeypatch, [])
    with pytest.raises(HTTPException):
        asyncio.run(planner.clara_list_tasks(planner.ClaraListTasks(prioritaet_min=7), None))
