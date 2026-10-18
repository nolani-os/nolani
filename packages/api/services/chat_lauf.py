"""Server-side completion run for the chat proxy (chat_v2).

The answer must survive a closed browser: the proxy reads the upstream stream
to the end in its own task, independent of the client connection, and keeps
an exact copy of what the client would have built (text, cards, sources,
follow-ups). If the client is gone at the end, the copy is written into the
chat history, so the answer is there when the chat is opened again.

Pure helpers only (no I/O) so they can be tested without a network.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

# Same marker as the shell (Chat/api.ts): events travel inline in the content
# because Open WebUI drops unknown SSE root keys.
CLARAEV_RE = re.compile(r"\|\|\|CLARAEV\|\|\|([\s\S]*?)\|\|\|/CLARAEV\|\|\|")

# The agent's tool.end carries only ~120 characters of the result; the mail
# router puts `kind` and `draft_id` first so they always fit. Tolerant of JSON,
# Python-repr and escaped quoting.
_DRAFT_RE = re.compile(r"kind\W{1,8}mail_draft\W.{0,80}?draft_id\W{1,8}(\d{1,12})", re.S)


def sse_frame_for_event(ev: dict) -> bytes:
    """An SSE frame that carries one event exactly like the agent sends it."""
    content = "|||CLARAEV|||" + json.dumps(ev, ensure_ascii=False) + "|||/CLARAEV|||"
    return ("data: " + json.dumps({"choices": [{"delta": {"content": content}}]},
                                  ensure_ascii=False) + "\n\n").encode()


def draft_id_from_event(ev: dict) -> str | None:
    """Draft UID if this event reports a successfully stored mail draft."""
    if not isinstance(ev, dict) or ev.get("type") != "tool.end" or ev.get("ok") is False:
        return None
    m = _DRAFT_RE.search(str(ev.get("result_summary") or ""))
    return m.group(1) if m else None


def draft_block(preview: dict) -> dict:
    """The chat card for a stored draft (kind `mail_entwurf`, see BlockRenderer)."""
    did = str(preview.get("draft_id") or "")
    return {
        "id": f"mail-draft-{did}",
        "kind": "mail_entwurf",
        "props": {
            "draft_id": did,
            "an": str(preview.get("to") or ""),
            "cc": str(preview.get("cc") or ""),
            "betreff": str(preview.get("subject") or ""),
            "vorschau": str(preview.get("preview") or "")[:600],
            "laenge": int(preview.get("length") or 0),
            "status": "offen",
        },
    }


class Antwort:
    """The assistant message as the shell builds it from the stream."""

    def __init__(self) -> None:
        self.content = ""
        self.blocks: list[dict] = []
        self.sources: list[dict] = []
        self.suggestions: list[str] = []
        self.fehler = ""
        self.started = time.time()

    def apply_event(self, ev: dict) -> None:
        typ = ev.get("type")
        if typ in ("ui.block", "ui.block.update"):
            blk = ev.get("block")
            if isinstance(blk, dict) and isinstance(blk.get("id"), str) and isinstance(blk.get("kind"), str):
                for i, b in enumerate(self.blocks):
                    if b.get("id") == blk["id"]:
                        props = {**(b.get("props") or {}), **(blk.get("props") or {})}
                        self.blocks[i] = {"id": blk["id"], "kind": blk["kind"], "props": props}
                        break
                else:
                    self.blocks.append({"id": blk["id"], "kind": blk["kind"],
                                        "props": dict(blk.get("props") or {})})
        elif typ in ("job.started", "job.done", "job.failed"):
            # Job events become a status card, exactly like the shell does it
            # (useClaraChat.ts), so the stored copy carries the same card.
            from services.jobs import job_block, normalisieren
            job = normalisieren(ev)
            if job:
                self.apply_event({"type": "ui.block", "block": job_block(job)})
        elif typ == "draft.reset":
            self.content = ""
        elif typ == "suggest" and isinstance(ev.get("followups"), list):
            self.suggestions = [x for x in ev["followups"] if isinstance(x, str)][:3]
        elif typ == "final" and isinstance(ev.get("sources"), list):
            self.sources = [x for x in ev["sources"]
                            if isinstance(x, dict) and isinstance(x.get("url"), str)][:8]

    def apply_line(self, line: str) -> list[dict]:
        """Feed one SSE line; returns the events found in it (already applied)."""
        line = line.strip()
        if not line.startswith("data:"):
            return []
        data = line[5:].strip()
        if not data or data == "[DONE]":
            return []
        try:
            obj = json.loads(data)
        except ValueError:
            return []
        if not isinstance(obj, dict):
            return []
        if obj.get("error"):
            self.fehler = str(obj.get("detail") or obj.get("error"))[:300]
            return []
        if isinstance(obj.get("claraos_event"), dict):
            ev = obj["claraos_event"]
            self.apply_event(ev)
            return [ev]
        choice = (obj.get("choices") or [{}])[0] or {}
        delta = (choice.get("delta") or {}).get("content")
        if delta is None:
            delta = (choice.get("message") or {}).get("content")
        if not isinstance(delta, str):
            return []
        events: list[dict] = []

        def _take(m: re.Match) -> str:
            try:
                ev = json.loads(m.group(1))
                if isinstance(ev, dict):
                    events.append(ev)
            except ValueError:
                pass
            return ""

        cleaned = CLARAEV_RE.sub(_take, delta) if "|||CLARAEV|||" in delta else delta
        for ev in events:
            self.apply_event(ev)
        self.content += cleaned
        return events

    def as_message(self) -> dict:
        content = self.content
        if not content.strip() and self.fehler:
            content = f"⚠️ {self.fehler}"
        msg: dict[str, Any] = {"role": "assistant", "content": content,
                               "timestamp": int(self.started * 1000)}
        if self.blocks:
            msg["blocks"] = self.blocks
        if self.sources:
            msg["sources"] = self.sources
        if self.suggestions:
            msg["suggestions"] = self.suggestions
        return msg

    def has_content(self) -> bool:
        return bool(self.content.strip() or self.blocks or self.fehler)


def last_user_text(messages: Any) -> str:
    """Text of the last user message as the client sent it (before any proxy edits)."""
    if not isinstance(messages, list):
        return ""
    for m in reversed(messages):
        if isinstance(m, dict) and m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return " ".join(str(p.get("text", "")) for p in c
                                if isinstance(p, dict) and p.get("type") == "text")
            return ""
    return ""


def merge_into_history(stored: list, user_text: str, answer: dict) -> list:
    """Stored thread + the finished answer, placed after the question it answers.

    * question found, answer after it  -> replace that answer (the client may
      have saved a partial one when it aborted)
    * question found, nothing after it -> insert the answer
    * question missing (the client died before saving a follow-up) -> append
      question and answer
    """
    msgs = [m for m in (stored or []) if isinstance(m, dict)]
    want = (user_text or "").strip()
    idx = None
    for i in range(len(msgs) - 1, -1, -1):
        m = msgs[i]
        if m.get("role") == "user" and str(m.get("content") or "").strip() == want:
            idx = i
            break
    if idx is None:
        return msgs + [{"role": "user", "content": user_text,
                        "timestamp": answer.get("timestamp")}, answer]
    nxt = idx + 1
    if nxt < len(msgs) and msgs[nxt].get("role") == "assistant":
        keep = {k: v for k, v in msgs[nxt].items() if k == "files"}
        msgs[nxt] = {**answer, **keep}
        return msgs
    return msgs[:nxt] + [answer] + msgs[nxt:]
