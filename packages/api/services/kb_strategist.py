"""kb_strategist — Clara thinks along with the goals.

Three capabilities, all following the `kb_analyst` pattern: ONE direct
LiteLLM call instead of an agent loop — deterministic, cheap, no tool overhead.

1. `suggest_ideas`  — ideas that fit the vision and the goals
2. `develop_concept` — turn an idea into a concept with a fixed outline
3. `rate_contribution` — estimate of impact and effort WITH reasoning

Important: **Clara never commits a rating and never creates an idea
unprompted.** Suggestions come back as suggestions; the estimate lands only in
`meta.suggested` on the edge until a human confirms it. A tool that sets
priorities unprompted loses trust on its first mistake — and then the whole
system does.

For quality questions deliberately the better model: ideation and concept work
run on `premium/`, not on the budget model. The calls are rare (human
triggered), while the difference is clearly noticeable.
"""
from __future__ import annotations

import ast
import json
import logging
import os
import re

import httpx

from database import user_tx

from . import datenklasse, llm
from services import kpi_progress

logger = logging.getLogger(__name__)

STRATEGIST_MODEL = os.environ.get("KB_STRATEGIST_MODEL", "premium/claude-sonnet")

MAX_IDEAS = 8
MAX_CONTEXT_TITLES = 40


class StrategistError(RuntimeError):
    """Domain error that may be shown to the user in plain text."""


async def _ask(prompt: str, *, temperature: float = 0.7, max_tokens: int = 2500) -> dict:
    """Get a JSON block from the model. Raises StrategistError with a plain-text message."""
    # Data class `intern`: the strategist reads goals, KPIs and plans — the
    # core of what the user does not want lying around at an arbitrary
    # provider. `intern` allows EU-hosted or local.
    #
    # That `premium/claude-sonnet` used to be here was not a decision against
    # privacy — it was no decision at all. The caller picked a model by
    # quality because there was nothing else to choose. That is exactly the
    # gap the data class closes.
    try:
        antwort = await llm.anfragen(
            nachrichten=[{"role": "user", "content": prompt}],
            datenklasse="intern",
            modell=STRATEGIST_MODEL,
            timeout=90.0,
            # Thinking tokens count against max_tokens (lesson from kb_analyst:
            # at 400 the result was finish=length and empty content).
            max_tokens=max_tokens,
            extra={"response_format": {"type": "json_object"},
                   "temperature": temperature},
        )
    except datenklasse.DatenklasseVerletzt as exc:
        # In plain text and not as "unreachable": the difference between "the
        # network is stuck" and "this may not go there" is exactly what a user
        # needs to know.
        raise StrategistError(f"Aus Datenschutzgruenden nicht ausfuehrbar: {exc}") from exc
    except httpx.HTTPError as exc:
        raise StrategistError(f"Clara ist gerade nicht erreichbar: {exc}") from exc
    try:
        content = antwort["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as exc:
        raise StrategistError("Antwort des Modells war unlesbar") from exc
    # Despite response_format, ```json fences or surrounding prose are common.
    m = re.search(r"\{.*\}", content or "", re.S)
    if not m:
        raise StrategistError("Modell lieferte kein JSON")
    try:
        return json.loads(m.group(0))
    except ValueError:
        try:
            return ast.literal_eval(m.group(0))   # Gemini: single-quoted pseudo-JSON
        except (ValueError, SyntaxError) as exc:
            raise StrategistError("JSON der Antwort war fehlerhaft") from exc


def _clamp(value, low: int, high: int, default: int) -> int:
    try:
        return max(low, min(high, int(round(float(value)))))
    except (TypeError, ValueError):
        return default


# ── Context: what Clara knows about the goal ────────────────────────────────

async def goal_context(conn, goal_id: str, user: str) -> dict:
    """Vision, goal, subgoals, KPI status and already existing ideas.

    The part with the existing ideas is the most important: without it every
    model happily suggests the same thing for the fourth time.
    """
    goal = await conn.fetchrow(
        "SELECT id, type, title, body, properties, parent_id FROM claraos_kb_objects "
        "WHERE id = $1::uuid AND deleted_at IS NULL", goal_id)
    if not goal:
        raise StrategistError("Ziel nicht gefunden")

    ancestors = await conn.fetch(
        """
        WITH RECURSIVE up AS (
            SELECT id, parent_id, title, type, 0 AS depth FROM claraos_kb_objects
            WHERE id = $1::uuid
            UNION ALL
            SELECT o.id, o.parent_id, o.title, o.type, up.depth + 1
            FROM claraos_kb_objects o JOIN up ON o.id = up.parent_id WHERE up.depth < 8
        )
        SELECT title, type FROM up WHERE depth > 0 ORDER BY depth DESC
        """, goal_id)

    children = await conn.fetch(
        "SELECT title FROM claraos_kb_objects WHERE parent_id = $1::uuid "
        "AND type = 'goal' AND deleted_at IS NULL LIMIT 20", goal_id)

    kpi_rows = await conn.fetch(
        """
        SELECT o.id, o.title, o.properties FROM claraos_kb_links l
        JOIN claraos_kb_objects o ON o.id = l.to_id
        WHERE l.from_id = $1::uuid AND l.rel = 'measured_by'
          AND o.type = 'kpi' AND o.deleted_at IS NULL
        """, goal_id)
    kpis = []
    for k in kpi_rows:
        vals = await conn.fetch(
            "SELECT ts, value FROM claraos_kb_kpi_values WHERE kpi_id = $1::uuid ORDER BY ts",
            str(k["id"]))
        props = k["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        prog = kpi_progress.compute(props, [{"ts": v["ts"], "value": float(v["value"])} for v in vals])
        kpis.append({"title": k["title"], "unit": prog["unit"], "current": prog["current"],
                     "target": prog["target"], "status": prog["status"], "reason": prog["reason"]})

    existing = await conn.fetch(
        """
        SELECT DISTINCT o.title FROM claraos_kb_objects o
        JOIN claraos_kb_links l ON l.from_id = o.id
        WHERE l.to_id = $1::uuid AND l.rel = 'contributes_to' AND o.deleted_at IS NULL
        LIMIT $2
        """, goal_id, MAX_CONTEXT_TITLES)
    others = await conn.fetch(
        "SELECT title FROM claraos_kb_objects WHERE type IN ('idea','concept') "
        "AND owner = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT $2",
        user, MAX_CONTEXT_TITLES)

    props = goal["properties"]
    if isinstance(props, str):
        props = json.loads(props)
    return {
        "goal": {"id": str(goal["id"]), "type": goal["type"], "title": goal["title"],
                 "body": (goal["body"] or "")[:1500], "due_date": props.get("due_date")},
        "vision": [a["title"] for a in ancestors if a["type"] == "vision"],
        "parents": [a["title"] for a in ancestors],
        "subgoals": [c["title"] for c in children],
        "kpis": kpis,
        "already_linked": [e["title"] for e in existing],
        "other_ideas": [o["title"] for o in others],
    }


def _context_block(ctx: dict) -> str:
    kpi_lines = "\n".join(
        f"  - {k['title']}: {k['current']} von {k['target']} {k['unit']} — {k['status']} ({k['reason']})"
        for k in ctx["kpis"]) or "  (noch keine Kennzahl)"
    return f"""Vision: {' / '.join(ctx['vision']) or '(keine übergeordnete Vision)'}
Ziel: {ctx['goal']['title']}{f" (Termin {ctx['goal']['due_date']})" if ctx['goal'].get('due_date') else ''}
Beschreibung: {ctx['goal']['body'] or '—'}
Unterziele: {', '.join(ctx['subgoals']) or '—'}
Kennzahlen:
{kpi_lines}
Bereits diesem Ziel zugeordnet: {', '.join(ctx['already_linked']) or '—'}
Weitere vorhandene Ideen des Nutzers: {', '.join(ctx['other_ideas'][:25]) or '—'}"""


# ── 1) Suggest ideas ────────────────────────────────────────────────────────

_IDEAS_PROMPT = """Du bist Clara, eine persönliche Assistentin. Du hilfst \
dem Nutzer, ein Ziel zu erreichen. Schlage {n} konkrete, umsetzbare Ideen vor, die auf GENAU \
dieses Ziel einzahlen.

{context}

Regeln:
- Jede Idee muss erkennbar auf das Ziel oder eine seiner Kennzahlen wirken — schreibe in \
"why" DIREKT, welche Kennzahl oder welcher Aspekt sich dadurch bewegt.
- KEINE Wiederholung der bereits zugeordneten oder vorhandenen Ideen (siehe oben). Wenn dir \
nur noch Varianten davon einfallen, gib lieber weniger Ideen zurück.
- Konkret statt allgemein: "Jeden Montag 15 min Wochenplanung vor dem ersten Termin" statt \
"mehr Sport treiben".
- Schätze Aufwand und Wirkung je 1-5 (1 = sehr wenig, 5 = sehr viel). Sei ehrlich: nicht \
alles ist ein schneller Treffer.
- Duze den Nutzer.

Antworte NUR als JSON:
{{"ideas": [{{"title": "…", "why": "…", "effort": 1-5, "impact": 1-5}}]}}
(Deutsch, title max. 90 Zeichen, why max. 220 Zeichen)"""


async def suggest_ideas(goal_id: str, user: str, n: int = 5) -> list[dict]:
    """Idea suggestions — deliberately WITHOUT saving (the human takes over)."""
    n = max(1, min(int(n or 5), MAX_IDEAS))
    async with user_tx(user) as conn:
        ctx = await goal_context(conn, goal_id, user)
    data = await _ask(_IDEAS_PROMPT.format(n=n, context=_context_block(ctx)))
    out = []
    for raw in (data.get("ideas") or [])[:n]:
        title = str(raw.get("title") or "").strip()[:120]
        if not title:
            continue
        out.append({
            "title": title,
            "why": str(raw.get("why") or "").strip()[:300],
            "effort": _clamp(raw.get("effort"), 1, 5, 3),
            "impact": _clamp(raw.get("impact"), 1, 5, 3),
        })
    if not out:
        raise StrategistError("Clara hatte diesmal keinen brauchbaren Vorschlag")
    return out


# ── 2) Develop a concept ────────────────────────────────────────────────────

_CONCEPT_PROMPT = """Du bist Clara. Arbeite aus dieser Idee ein belastbares Konzept aus.

Idee: {title}
Notizen: {body}

Zusammenhang:
{context}

Antworte NUR als JSON mit genau diesen Feldern:
{{"problem": "Welches Problem oder welcher Wunsch steckt dahinter? (max 400 Zeichen)",
  "solution": "Was genau wird gemacht? (max 600 Zeichen)",
  "mechanism": "WARUM wirkt das auf das Ziel? Nenne die Kennzahl, die sich bewegen soll. (max 400)",
  "first_steps": ["3-5 konkrete erste Schritte, jeder ein Satz"],
  "risks": ["1-3 ehrliche Risiken oder Gründe, warum es scheitern könnte"],
  "effort": 1-5, "impact": 1-5}}
Deutsch, du duzt den Nutzer."""


def _concept_markdown(c: dict) -> str:
    schritte = "\n".join(f"{i}. {s}" for i, s in enumerate(c.get("first_steps", []), 1))
    risiken = "\n".join(f"- {r}" for r in c.get("risks", []))
    return (f"## Problem\n{c.get('problem', '—')}\n\n"
            f"## Lösung\n{c.get('solution', '—')}\n\n"
            f"## Wirkmechanismus\n{c.get('mechanism', '—')}\n\n"
            f"## Erste Schritte\n{schritte or '—'}\n\n"
            f"## Risiken\n{risiken or '—'}\n")


async def develop_concept(idea_id: str, user: str, goal_id: str | None = None) -> dict:
    """Turn an idea into a concept object. Returns title/body/estimate; the
    router does the creation (that is where the permission and RAG logic lives)."""
    async with user_tx(user) as conn:
        idea = await conn.fetchrow(
            "SELECT title, body, type FROM claraos_kb_objects "
            "WHERE id = $1::uuid AND deleted_at IS NULL", idea_id)
        if not idea:
            raise StrategistError("Idee nicht gefunden")
        ctx_text = "—"
        if goal_id:
            ctx_text = _context_block(await goal_context(conn, goal_id, user))
    data = await _ask(_CONCEPT_PROMPT.format(
        title=idea["title"], body=(idea["body"] or "—")[:2500], context=ctx_text))
    return {
        "title": f"Konzept: {idea['title']}"[:180],
        "body": _concept_markdown(data),
        "effort": _clamp(data.get("effort"), 1, 5, 3),
        "impact": _clamp(data.get("impact"), 1, 5, 3),
        "structured": {k: data.get(k) for k in
                       ("problem", "solution", "mechanism", "first_steps", "risks")},
    }


# ── 3) Estimate impact and effort ───────────────────────────────────────────

_RATE_PROMPT = """Du bist Clara. Schätze, wie stark diese Idee auf DIESES Ziel einzahlt \
und wie aufwendig sie ist.

Idee/Konzept: {title}
Inhalt: {body}

Ziel-Zusammenhang:
{context}

Sei ehrlich und zurückhaltend: die meisten Ideen sind mittelmäßig. Eine 5 bei der Wirkung \
vergibst du nur, wenn die Idee eine der genannten Kennzahlen deutlich bewegt.

Antworte NUR als JSON:
{{"impact": 1-5, "effort": 1-5, "confidence": 1-3, "reason": "eine Begründung, max 250 Zeichen"}}"""


async def rate_contribution(object_id: str, goal_id: str, user: str) -> dict:
    async with user_tx(user) as conn:
        obj = await conn.fetchrow(
            "SELECT title, body FROM claraos_kb_objects "
            "WHERE id = $1::uuid AND deleted_at IS NULL", object_id)
        if not obj:
            raise StrategistError("Objekt nicht gefunden")
        ctx = await goal_context(conn, goal_id, user)
    data = await _ask(_RATE_PROMPT.format(
        title=obj["title"], body=(obj["body"] or "—")[:2000],
        context=_context_block(ctx)), temperature=0.3, max_tokens=1200)
    return {
        "impact": _clamp(data.get("impact"), 1, 5, 3),
        "effort": _clamp(data.get("effort"), 1, 5, 3),
        "confidence": _clamp(data.get("confidence"), 1, 3, 2),
        "reason": str(data.get("reason") or "").strip()[:300],
    }


# ── 4) Improvement: 5 Whys ─────────────────────────────────────────────────
# Important: deliberately STEP BY STEP instead of in one go: the value of 5 Whys
# lies in the person's knowledge of their own situation. A model that invents
# five levels by itself produces plausible prose, not a cause. So Clara asks the
# question and offers candidate answers — the human has to pick or overwrite.

MAX_WHY_DEPTH = 5

_WHY_STEP_PROMPT = """Du führst mit dem Nutzer eine 5-Why-Analyse (Ursachensuche).

Problem: {problem}

Bisherige Kette:
{chain}

Zusammenhang:
{context}

Stelle die NÄCHSTE „Warum?"-Frage — sie muss sich konkret auf die letzte Antwort beziehen, \
nicht auf das ursprüngliche Problem. Biete zusätzlich 2-3 plausible Antwort-Kandidaten an, \
die der Nutzer anklicken ODER überschreiben kann.

Wenn die Kette erkennbar bei einer GRUNDursache angekommen ist (weiter zu fragen brächte \
nichts mehr) oder sich im Kreis dreht, setze "done": true und begründe kurz.

Antworte NUR als JSON:
{{"question": "…", "candidates": ["…", "…"], "done": false, "note": "optional"}}
Deutsch, du duzt den Nutzer."""

_WHY_FINISH_PROMPT = """Du hast mit dem Nutzer diese 5-Why-Analyse geführt.

Problem: {problem}

Kette:
{chain}

Zusammenhang:
{context}

Fasse die Grundursache in EINEM Satz zusammen und leite 2-4 konkrete Gegenmaßnahmen ab, \
die an der GRUNDursache ansetzen — nicht am Symptom. Jede Gegenmaßnahme muss als Aufgabe \
formulierbar sein (mit Verb, konkret).

Antworte NUR als JSON:
{{"root_cause": "…", "countermeasures": [{{"title": "…", "why": "…"}}]}}
Deutsch."""


def _chain_text(chain: list[dict]) -> str:
    if not chain:
        return "  (noch leer — das ist die erste Frage)"
    return "\n".join(
        f"  {i}. Warum? {c.get('question', '')}\n     → {c.get('answer', '')}"
        for i, c in enumerate(chain, 1))


async def five_why_step(goal_id: str, user: str, problem: str, chain: list[dict]) -> dict:
    """The next why-question together with candidate answers."""
    chain = chain or []
    if len(chain) >= MAX_WHY_DEPTH:
        return {"question": None, "candidates": [], "done": True,
                "note": f"{MAX_WHY_DEPTH} Ebenen erreicht — tiefer wird es selten nützlicher."}
    async with user_tx(user) as conn:
        ctx = _context_block(await goal_context(conn, goal_id, user))
    data = await _ask(_WHY_STEP_PROMPT.format(
        problem=problem[:500], chain=_chain_text(chain), context=ctx),
        temperature=0.5, max_tokens=1200)
    return {
        "question": str(data.get("question") or "").strip()[:300] or None,
        "candidates": [str(c).strip()[:250] for c in (data.get("candidates") or [])[:3]
                       if str(c).strip()],
        "done": bool(data.get("done")),
        "note": str(data.get("note") or "").strip()[:300] or None,
    }


async def five_why_finish(goal_id: str, user: str, problem: str, chain: list[dict]) -> dict:
    """Root cause + countermeasures from the finished chain."""
    if not chain:
        raise StrategistError("Die Kette ist leer — es gibt nichts auszuwerten")
    async with user_tx(user) as conn:
        ctx = _context_block(await goal_context(conn, goal_id, user))
    data = await _ask(_WHY_FINISH_PROMPT.format(
        problem=problem[:500], chain=_chain_text(chain), context=ctx),
        temperature=0.4, max_tokens=1500)
    maßnahmen = []
    for m in (data.get("countermeasures") or [])[:4]:
        title = str((m or {}).get("title") or "").strip()[:200]
        if title:
            maßnahmen.append({"title": title,
                              "why": str((m or {}).get("why") or "").strip()[:300]})
    return {
        "root_cause": str(data.get("root_cause") or "").strip()[:500],
        "countermeasures": maßnahmen,
    }


def five_why_markdown(problem: str, chain: list[dict], result: dict) -> str:
    kette = "\n".join(
        f"{i}. **Warum?** {c.get('question', '')}\n   → {c.get('answer', '')}"
        for i, c in enumerate(chain, 1))
    maß = "\n".join(f"- **{m['title']}**" + (f" — {m['why']}" if m.get("why") else "")
                    for m in result.get("countermeasures", []))
    return (f"## Problem\n{problem}\n\n## Warum-Kette\n{kette}\n\n"
            f"## Grundursache\n{result.get('root_cause', '—')}\n\n"
            f"## Gegenmaßnahmen\n{maß or '—'}\n")


# ── 5) Improvement: candidates for a Pareto breakdown ───────────────────────

_PARETO_PROMPT = """Der Nutzer will für dieses Problem eine Pareto-Analyse machen und braucht \
eine Liste möglicher Ursachen, die er dann mit ZAHLEN füllt.

Problem: {problem}

Zusammenhang:
{context}

Nenne 4-7 Ursachen, die man realistisch zählen oder messen kann (Stunden, Euro, Anzahl). \
Schlage auch die passende Einheit vor. Erfinde KEINE Zahlen — die trägt der Nutzer ein.

Antworte NUR als JSON:
{{"unit": "h", "causes": ["…", "…"]}}
Deutsch."""


async def pareto_causes(goal_id: str, user: str, problem: str) -> dict:
    async with user_tx(user) as conn:
        ctx = _context_block(await goal_context(conn, goal_id, user))
    data = await _ask(_PARETO_PROMPT.format(problem=problem[:500], context=ctx),
                      temperature=0.5, max_tokens=1000)
    return {
        "unit": str(data.get("unit") or "").strip()[:20],
        "causes": [str(c).strip()[:120] for c in (data.get("causes") or [])[:8] if str(c).strip()],
    }
