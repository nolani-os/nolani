"""Pareto analysis — pure computation, no database.

Takes items `{cause, value, unit}`, sorts them in descending order and
determines which of them together make up 80 %. That is the whole trick:
finding the few causes that carry most of the effect.

Important limitation: nobody can derive these numbers from existing data —
they come from the conversation with the person. The tool is a structured
questionnaire with a calculator, not automation. An automatic cause
distribution would be show without substance; once enough KPI history with
dimensions exists, Pareto can build on it.
"""
from __future__ import annotations

DEFAULT_CUTOFF = 0.8
MAX_ITEMS = 40


def _num(value) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def analyse(items: list[dict], cutoff: float = DEFAULT_CUTOFF) -> dict:
    """Analyse the items.

    Returns the sorted items with share and cumulative share, plus
    `vital_few` (the items up to the threshold) and `cutoff_index`.

    Error cases return `error` instead of raising — the UI shows the message
    directly.
    """
    if not items:
        return {"error": "Keine Positionen angegeben"}
    if len(items) > MAX_ITEMS:
        return {"error": f"Zu viele Positionen ({len(items)}, höchstens {MAX_ITEMS})"}

    clean = []
    for raw in items:
        cause = str((raw or {}).get("cause") or "").strip()
        value = _num((raw or {}).get("value"))
        if not cause:
            return {"error": "Jede Position braucht eine Ursache"}
        if value is None:
            return {"error": f"„{cause}“ hat keinen auswertbaren Zahlenwert"}
        if value < 0:
            # Negative contributions make the cumulative curve meaningless (it
            # would fall again) — reject clearly rather than silently compute nonsense.
            return {"error": f"„{cause}“ ist negativ — Pareto braucht Beträge"}
        clean.append({"cause": cause[:120], "value": value,
                      "unit": str((raw or {}).get("unit") or "").strip()[:20]})

    total = sum(c["value"] for c in clean)
    if total <= 0:
        return {"error": "Alle Positionen sind 0 — daraus lässt sich nichts ableiten"}

    clean.sort(key=lambda c: c["value"], reverse=True)
    cutoff = min(max(float(cutoff or DEFAULT_CUTOFF), 0.5), 0.99)
    laufend = 0.0
    cutoff_index = None
    for i, c in enumerate(clean):
        laufend += c["value"]
        c["share"] = round(c["value"] / total, 4)
        c["cumulative"] = round(laufend / total, 4)
        if cutoff_index is None and c["cumulative"] >= cutoff:
            cutoff_index = i

    if cutoff_index is None:          # can only happen due to rounding residue
        cutoff_index = len(clean) - 1
    return {
        "items": clean,
        "total": round(total, 4),
        "unit": clean[0]["unit"],
        "cutoff": cutoff,
        "cutoff_index": cutoff_index,
        "vital_few": [c["cause"] for c in clean[: cutoff_index + 1]],
        # How uneven is the distribution? For a uniform distribution this is
        # ~cutoff, for a real Pareto much smaller. Tells whether prioritising pays off.
        "concentration": round((cutoff_index + 1) / len(clean), 4),
    }


def markdown(problem: str, result: dict) -> str:
    """Result as readable text for the analysis object."""
    if result.get("error"):
        return f"## Pareto\n\n⚠ {result['error']}\n"
    unit = result["unit"]
    zeilen = "\n".join(
        f"| {i + 1} | {c['cause']} | {c['value']:g} {unit} | {c['share']:.0%} | {c['cumulative']:.0%} |"
        for i, c in enumerate(result["items"]))
    wenige = ", ".join(result["vital_few"])
    anteil = result["concentration"]
    fazit = (f"**{len(result['vital_few'])} von {len(result['items'])} Ursachen "
             f"({anteil:.0%}) machen {result['cutoff']:.0%} aus:** {wenige}")
    if anteil > 0.6:
        fazit += ("\n\n⚠ Die Verteilung ist ziemlich gleichmäßig — hier bringt Priorisieren "
                  "wenig, weil kein klarer Hauptverursacher existiert.")
    return (f"## Problem\n{problem}\n\n## Pareto\n\n"
            f"| # | Ursache | Wert | Anteil | kumuliert |\n|---|---|---|---|---|\n{zeilen}\n\n"
            f"{fazit}\n")
