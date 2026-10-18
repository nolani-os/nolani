"""Knowledge store: version diff.

Computes differences between two Markdown revisions ON READ — only complete
snapshots are stored (kb_history). This is Outline's approach: snapshots are
cheap and robust, the diff is produced only when viewed.

Word-wise instead of line-wise, because otherwise a reworded phrase shows up
as "whole line removed, whole line added". Plus Outline's refinement
`mergeInterleavedChanges`: tiny unchanged islands between two changes are
absorbed, otherwise the diff frays into unreadable snippets.
"""
from __future__ import annotations

import difflib
import re

# Words including trailing whitespace — so joining them reproduces the text
# character for character.
_TOKEN_RE = re.compile(r"\S+\s*|\s+")

MERGE_GAP = 3  # unchanged tokens between changes that get merged


def _tokens(text: str) -> list[str]:
    return _TOKEN_RE.findall(text or "")


def diff_markdown(old: str, new: str) -> list[dict]:
    """→ [{"type": "equal"|"insert"|"delete", "text": str}, …]"""
    a, b = _tokens(old), _tokens(new)
    ops: list[dict] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            ops.append({"type": "equal", "text": "".join(a[i1:i2]), "n": i2 - i1})
        elif tag == "delete":
            ops.append({"type": "delete", "text": "".join(a[i1:i2]), "n": i2 - i1})
        elif tag == "insert":
            ops.append({"type": "insert", "text": "".join(b[j1:j2]), "n": j2 - j1})
        else:  # replace
            ops.append({"type": "delete", "text": "".join(a[i1:i2]), "n": i2 - i1})
            ops.append({"type": "insert", "text": "".join(b[j1:j2]), "n": j2 - j1})

    # Absorb small "equal" islands between changes (readability)
    merged: list[dict] = []
    for op in ops:
        if (op["type"] == "equal" and op["n"] <= MERGE_GAP and merged
                and merged[-1]["type"] != "equal"):
            merged.append({**op, "type": merged[-1]["type"], "merged": True})
        else:
            merged.append(op)

    # Merge adjacent ops of the same type
    out: list[dict] = []
    for op in merged:
        if out and out[-1]["type"] == op["type"]:
            out[-1]["text"] += op["text"]
        else:
            out.append({"type": op["type"], "text": op["text"]})
    return out


def summarize(ops: list[dict]) -> dict:
    """Compact figures for the timeline (without loading the whole diff)."""
    added = sum(len(o["text"]) for o in ops if o["type"] == "insert")
    removed = sum(len(o["text"]) for o in ops if o["type"] == "delete")
    return {"added_chars": added, "removed_chars": removed,
            "changed": bool(added or removed)}
