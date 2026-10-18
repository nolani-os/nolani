"""kb_analyst — Clara's automatic analysis of freshly captured ideas
(runs automatically on capture).

After each capture of an idea (type='idea', newly created) Clara adds 1-3
thoughtful follow-up questions/prompts as activity entries (kind='question',
actor='clara') to the object. Deliberately ONE direct LiteLLM call (cheap tier)
instead of an agent loop: deterministic, cheap (~0.1 ct), no tool overhead.
Runs as a fire-and-forget BackgroundTask — failures NEVER block the capture.
No automatic comment on updates (only on creation).
"""
from __future__ import annotations

import json
import logging
import os
import re

from database import get_pool

# Service path: runs as a background task for any freshly captured idea and
# writes Clara's follow-up questions; plain pool (superuser) on purpose.

from . import llm

logger = logging.getLogger(__name__)

ANALYST_MODEL = os.environ.get("KB_ANALYST_MODEL", "cheap/gemini-flash")

_PROMPT = """Du bist Clara, die persönliche Assistentin der Familie. Der Nutzer hat gerade \
eine neue Idee festgehalten. Hilf ihm, sie weiterzuentwickeln: Stelle 1-3 kurze, \
kluge Rückfragen oder Denkanstöße — konkret zur Idee, nicht generisch. Duze den Nutzer. Was würde \
die Idee schärfen (Ziel? Aufwand? erster Schritt? Risiko? verwandte Ideen)?

Titel: {title}
Notizen:
{body}

Antworte NUR als JSON: {{"questions": ["…", "…"]}} (1-3 Einträge, Deutsch, je max. 200 Zeichen)."""


async def analyze_idea(object_id: str) -> None:
    """Generate follow-up questions and attach them as question activities. Never raises."""
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT title, body, type, deleted_at FROM claraos_kb_objects WHERE id = $1::uuid",
                object_id,
            )
        if not row or row["type"] != "idea" or row["deleted_at"] is not None:
            return

        # Data class `intern`: this reads the user's own ideas including their
        # text — business matters, half-finished and confidential things. That
        # does not belong with an arbitrary provider. `intern` allows EU-hosted
        # or local; the choice is made by `services.datenklasse`, not this
        # file.
        antwort = await llm.anfragen(
            nachrichten=[{
                "role": "user",
                "content": _PROMPT.format(
                    title=row["title"], body=(row["body"] or "—")[:3000]),
            }],
            datenklasse="intern",
            modell=ANALYST_MODEL,
            timeout=45.0,
            # gemini-2.5-flash thinks internally — thinking tokens count
            # against max_tokens (finish=length at 400 -> empty content)
            max_tokens=2000,
            extra={"response_format": {"type": "json_object"},
                   "temperature": 0.7},
        )
        content = antwort["choices"][0]["message"]["content"]
        # Despite response_format, models like to return ```json fences or
        # surrounding prose -> extract the first {...} object.
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            logger.warning("[kb-analyst] kein JSON in Antwort für %s", object_id)
            return
        raw = m.group(0)
        try:
            data = json.loads(raw)
        except ValueError:
            import ast  # Gemini likes to return single-quoted pseudo-JSON
            data = ast.literal_eval(raw)
        questions = (data.get("questions") or [])[:3]
        questions = [str(q).strip()[:300] for q in questions if str(q).strip()]
        if not questions:
            return

        pool = await get_pool()
        async with pool.acquire() as conn:
            for q in questions:
                await conn.execute(
                    "INSERT INTO claraos_kb_activity (object_id, actor, kind, content, meta) "
                    "VALUES ($1::uuid, 'clara', 'question', $2, '{}'::jsonb)",
                    object_id, q,
                )
        logger.info("[kb-analyst] %d Rückfrage(n) an Idee %s", len(questions), object_id)
    except Exception as exc:
        logger.warning("[kb-analyst] analyze %s failed: %s", object_id, exc)
