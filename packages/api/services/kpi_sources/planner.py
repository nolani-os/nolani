"""KPI source: Planner/Vikunja.

Measures the progress of an action plan: done, open, total tasks or their
ratio. This turns the work itself into a KPI without anyone having to enter
anything — the cheapest automatic value in the whole system.

Goes through the existing planner proxy (`/api/claraos/planner/api/...`)
instead of directly to Vikunja: the proxy holds the path whitelist and the
per-user token exchange. The loopback call needs the service credential
because the per-user routers require a trust anchor.

Config: {"project_id": 12, "metric": "done" | "open" | "total" | "done_ratio"}
"""
from __future__ import annotations

import httpx

from .base import FetchResult

METRICS = ("done", "open", "total", "done_ratio")
_PAGE_SIZE = 250
_MAX_PAGES = 20          # 5000 tasks per project — beyond that an error is reported


def count_metric(tasks: list[dict], metric: str) -> FetchResult:
    """Pure evaluation — testable separately, without network."""
    total = len(tasks)
    done = sum(1 for t in tasks if t.get("done"))
    if metric == "done":
        return FetchResult(value=float(done))
    if metric == "open":
        return FetchResult(value=float(total - done))
    if metric == "total":
        return FetchResult(value=float(total))
    if metric == "done_ratio":
        if total == 0:
            # No denominator => no statement. 0 % would be a lie (nothing is
            # open), 100 % even more so.
            return FetchResult(error="Projekt hat keine Aufgaben — Anteil nicht bestimmbar")
        return FetchResult(value=round(done / total * 100, 2))
    return FetchResult(error=f"Unbekannte Kennzahl-Art: {metric!r} (erlaubt: {', '.join(METRICS)})")


async def fetch(cfg: dict, username: str) -> FetchResult:
    from auth import service_headers

    project_id = cfg.get("project_id")
    metric = (cfg.get("metric") or "done_ratio").strip()
    try:
        project_id = int(project_id)
    except (TypeError, ValueError):
        return FetchResult(error="Keine gültige Projekt-Nummer hinterlegt (project_id)")
    if metric not in METRICS:
        return FetchResult(error=f"Unbekannte Kennzahl-Art: {metric!r} (erlaubt: {', '.join(METRICS)})")

    url = f"http://localhost:8090/api/claraos/planner/api/projects/{project_id}/tasks"
    tasks: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=30.0, headers=service_headers(username)) as client:
            for page in range(1, _MAX_PAGES + 1):
                resp = await client.get(url, params={"page": page, "per_page": _PAGE_SIZE})
                if resp.status_code == 404:
                    return FetchResult(error=f"Projekt {project_id} gibt es im Planner nicht")
                if resp.status_code in (401, 403):
                    return FetchResult(error=f"Planner verweigert den Zugriff auf Projekt {project_id}")
                if resp.status_code != 200:
                    return FetchResult(error=f"Planner antwortete mit {resp.status_code}")
                batch = resp.json()
                if not isinstance(batch, list):
                    return FetchResult(error="Planner lieferte keine Aufgabenliste")
                tasks.extend(t for t in batch if isinstance(t, dict))
                if len(batch) < _PAGE_SIZE:
                    break
            else:
                # No silent truncation: better a visible error than a number
                # that looks like the whole project but is not.
                return FetchResult(
                    error=f"Projekt {project_id} hat mehr als {_PAGE_SIZE * _MAX_PAGES} Aufgaben — "
                          "Zählung wäre unvollständig")
    except httpx.HTTPError as exc:
        return FetchResult(error=f"Planner nicht erreichbar: {exc}")

    return count_metric(tasks, metric)
