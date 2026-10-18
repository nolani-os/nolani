"""Derived KPIs.

Computes a new KPI from other KPIs — "savings rate", "cost per task",
"share done vs. planned". Uses the **existing** formula evaluator
(`services/kb_formula.py`, a custom AST interpreter without `eval`, with a
node whitelist and DoS limits) — so there is no second expression language
and no second attack surface.

Config: {"expression": "prop(\\"gewicht\\") / prop(\\"ziel\\") * 100",
         "inputs": {"gewicht": "<kpi-uuid>", "ziel": "<kpi-uuid>"}}
"""
from __future__ import annotations

import uuid

from .base import FetchResult

MAX_INPUTS = 12


async def current_values(kpi_ids: list[str], username: str) -> dict[str, float]:
    """Latest value per KPI — one query for all, as `username`.

    Only KPIs that user can see count: the query runs under row-level security
    (database.user_tx, policies of migration 042 on claraos_kb_kpi_values and
    claraos_kb_objects), and the join to the object is the application-level
    check on top. A formula that names someone else's KPI id therefore gets no
    value for it and reports the input as missing — it cannot read the number.
    """
    ids = []
    for k in kpi_ids:
        try:
            ids.append(str(uuid.UUID(str(k))))
        except ValueError:
            continue  # not a KPI id at all: counts as missing, like a foreign one
    if not ids or not username:
        return {}
    from database import user_tx

    async with user_tx(username) as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT ON (v.kpi_id) v.kpi_id, v.value "
            "FROM claraos_kb_kpi_values v "
            "JOIN claraos_kb_objects o ON o.id = v.kpi_id "
            "WHERE v.kpi_id = ANY($1::uuid[]) AND o.type = 'kpi' AND o.deleted_at IS NULL "
            "ORDER BY v.kpi_id, v.ts DESC",
            ids,
        )
    return {str(r["kpi_id"]): float(r["value"]) for r in rows}


async def fetch(cfg: dict, username: str) -> FetchResult:
    from .. import kb_formula

    expression = (cfg.get("expression") or "").strip()
    inputs = cfg.get("inputs") or {}
    if not expression:
        return FetchResult(error="Keine Formel hinterlegt (expression)")
    if not isinstance(inputs, dict):
        return FetchResult(error="inputs muss eine Zuordnung Name → Kennzahl-ID sein")
    if len(inputs) > MAX_INPUTS:
        return FetchResult(error=f"Zu viele Eingangsgrößen ({len(inputs)}, erlaubt sind {MAX_INPUTS})")

    values = await current_values([str(v) for v in inputs.values()], username)
    props: dict[str, float] = {}
    fehlend = []
    for alias, kpi_id in inputs.items():
        val = values.get(str(kpi_id))
        if val is None:
            fehlend.append(alias)
        else:
            props[str(alias)] = val
    if fehlend:
        # A missing input makes the result wrong, not small.
        # Hence an error instead of computing with 0.
        return FetchResult(error="Ohne Messwert: " + ", ".join(sorted(fehlend)))

    try:
        result = kb_formula.evaluate(expression, props)
    except Exception as exc:  # noqa: BLE001 — formula errors belong on the card
        return FetchResult(error=f"Formel nicht auswertbar: {exc}")

    if isinstance(result, bool) or not isinstance(result, (int, float)):
        return FetchResult(error=f"Formel ergibt keine Zahl, sondern {type(result).__name__}")
    if result != result or result in (float("inf"), float("-inf")):  # NaN/infinity
        return FetchResult(error="Formel ergibt keinen endlichen Wert (Division durch Null?)")
    return FetchResult(value=float(result))
