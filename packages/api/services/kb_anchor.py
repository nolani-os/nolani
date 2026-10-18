"""Knowledge store: anchor resolution for inline comments.

A comment remembers the QUOTE plus some context before/after it — not a
position and not a marker inside the Markdown. On read, the location is
searched again in the current body (Outline pattern `findTextRange`).

Why? Our `body` is the Markdown single source of truth: Clara writes into it
freely and RAG chunks it. A comment marker in the text would disturb both and
get lost in the editor round trip. Quote + context, on the other hand,
survives rewording elsewhere, insertions before it and edits by Clara.

Resolution strategy (first match wins):
  1. exact with prefix+suffix   -> unambiguous, even if the quote occurs several times
  2. exact with prefix OR suffix
  3. exact, but present only ONCE in the text
  4. normalised (whitespace/case) and unambiguous
  5. nothing found -> orphaned ("context lost")
"""
from __future__ import annotations

import re

CONTEXT_LEN = 40  # characters of context sent by the client


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def resolve_anchor(body: str, anchor_text: str, prefix: str = "", suffix: str = "") -> dict:
    """→ {"status": "exact"|"fuzzy"|"orphan", "start": int|None, "end": int|None}"""
    if not anchor_text:
        return {"status": "none", "start": None, "end": None}  # object-level comment
    body = body or ""
    hits = [m.start() for m in re.finditer(re.escape(anchor_text), body)]

    if hits:
        # 1./2. context-based
        scored: list[tuple[int, int]] = []
        for pos in hits:
            score = 0
            if prefix and body[max(0, pos - len(prefix)):pos].endswith(prefix[-CONTEXT_LEN:]):
                score += 2
            end = pos + len(anchor_text)
            if suffix and body[end:end + len(suffix)].startswith(suffix[:CONTEXT_LEN]):
                score += 2
            scored.append((score, pos))
        best = max(scored, key=lambda x: x[0])
        if best[0] > 0 or len(hits) == 1:
            return {"status": "exact", "start": best[1], "end": best[1] + len(anchor_text)}
        # ambiguous without a context match: first hit, but report as fuzzy
        return {"status": "fuzzy", "start": hits[0], "end": hits[0] + len(anchor_text)}

    # 4. normalised comparison (line breaks/case changed)
    nbody, nanchor = _norm(body), _norm(anchor_text)
    if nanchor and nbody.count(nanchor) == 1:
        # Roughly reconstruct the position in the original: word start of the first hit
        idx = nbody.find(nanchor)
        approx = 0
        seen = 0
        for i, ch in enumerate(body):
            if seen >= idx:
                approx = i
                break
            if not (ch.isspace() and (i + 1 < len(body) and body[i + 1].isspace())):
                seen += 1
        return {"status": "fuzzy", "start": approx, "end": approx + len(anchor_text)}

    return {"status": "orphan", "start": None, "end": None}
