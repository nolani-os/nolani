"""Registry of KPI sources.

A source is a function `async fetch(cfg: dict, username: str) -> FetchResult`.
New source = new file + one line here; the collector and the UI do not need
to be touched.

Why the adapter core came early and not later: every OKR tool dies because
nobody maintains the numbers — so the numbers have to be fetched automatically.

Deployment-specific sources (its own apps and devices) come from the optional
package `heim/`, which also fixes the order of the kinds.
"""
from __future__ import annotations

from .base import FetchResult
from . import formula, planner

try:
    from .heim import HEIM_QUELLEN, REIHENFOLGE
except ImportError:
    HEIM_QUELLEN, REIHENFOLGE = {}, ()

# 'manual' is registered on purpose and does nothing: this way the list of
# allowed kinds is defined in ONE place (UI, validation, collector).
_ALLE = {
    "manual": None,
    "planner": planner.fetch,
    "formula": formula.fetch,
    **HEIM_QUELLEN,
}
SOURCES = {k: _ALLE[k] for k in REIHENFOLGE if k in _ALLE}
SOURCES.update({k: v for k, v in _ALLE.items() if k not in SOURCES})

KINDS = tuple(SOURCES)


async def fetch(source: dict | None, username: str) -> FetchResult:
    """Fetch a value for the configured source."""
    src = source if isinstance(source, dict) else {}
    kind = (src.get("kind") or "manual").strip().lower()
    if kind not in SOURCES:
        return FetchResult(error=f"Unbekannte Quelle: {kind!r} (erlaubt: {', '.join(KINDS)})")
    handler = SOURCES[kind]
    if handler is None:
        return FetchResult(skipped="manuelle Kennzahl — nichts abzuholen")
    cfg = src.get("config")
    return await handler(cfg if isinstance(cfg, dict) else {}, username)


__all__ = ["FetchResult", "KINDS", "SOURCES", "fetch"]
