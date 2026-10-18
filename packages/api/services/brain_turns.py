"""Chat turns an external brain may act in.

When a cell is connected to an external brain (`CLARAOS_BRAIN_TOKEN` set), every
chat turn gets a random turn id. chat_v2 puts it at the very start of the context
block; the brain sends it back with each tool call. The brain never names the
user — this module does, from the turn id:

* No turn id, unknown or expired turn id, or a wrong brain token -> 401.
* The brain can act only for users who are chatting right now, and only as them.
* The brain token alone is worth nothing: it never grants `X-Claraos-User`.

Storage is in-process (the API runs as a single uvicorn process). A restart drops
running turns; the next chat message issues a new one.
"""
from __future__ import annotations

import hmac
import logging
import os
import secrets
import threading
import time

import httpx
from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

BRAIN_TOKEN = os.environ.get("CLARAOS_BRAIN_TOKEN", "").strip()
TURN_TTL_SECONDS = int(os.environ.get("CLARAOS_BRAIN_TURN_TTL", "1200"))
# Where the brain listens and the key this cell uses towards it (same values LiteLLM uses).
BRAIN_URL = os.environ.get("CLARAOS_BRAIN_URL", "").strip().rstrip("/")
BRAIN_KEY = os.environ.get("CLARAOS_BRAIN_KEY", "").strip()

_lock = threading.Lock()
_turns: dict[str, tuple[str, float, dict]] = {}


def enabled() -> bool:
    """Is an external brain connected to this cell?"""
    return bool(BRAIN_TOKEN)


def _prune(now: float) -> None:
    for tid in [t for t, (_, exp, _m) in _turns.items() if exp <= now]:
        _turns.pop(tid, None)


def issue(user: str, meta: dict | None = None) -> str:
    """New turn id for `user` (valid for TURN_TTL_SECONDS).

    `meta` travels with the turn and is set only by this cell — never by the brain.
    A routine run marks its turn `{"art": "routine", "lauf": <run id>}`; the tool
    gateway then allows reading only and stores changes as proposals."""
    tid = secrets.token_urlsafe(32)
    now = time.monotonic()
    with _lock:
        _prune(now)
        _turns[tid] = (user, now + TURN_TTL_SECONDS, dict(meta or {}))
    return tid


def meta(turn_id: str) -> dict:
    """What this cell attached to a live turn (empty for chat turns and unknown ids)."""
    now = time.monotonic()
    with _lock:
        hit = _turns.get(turn_id or "")
        return dict(hit[2]) if hit and hit[1] > now else {}


def end(turn_id: str) -> None:
    """Invalidate a turn early (a routine run that finished)."""
    with _lock:
        _turns.pop(turn_id or "", None)


def resolve(turn_id: str) -> str | None:
    """User of a live turn, or None."""
    if not turn_id:
        return None
    now = time.monotonic()
    with _lock:
        hit = _turns.get(turn_id)
        if hit is None or hit[1] <= now:
            return None
        return hit[0]


def brain_caller(request: Request) -> str | None:
    """The user a brain request acts for — or None if this is no brain request.

    A request counts as a brain request as soon as it carries the brain token
    header; from then on it must be fully valid, there is no fallback to other
    trust anchors.
    """
    sent = request.headers.get("X-ClaraOS-Brain-Token")
    if sent is None:
        return None
    if not BRAIN_TOKEN or not hmac.compare_digest(sent.encode(), BRAIN_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="invalid brain token")
    user = resolve(request.headers.get("X-Claraos-Turn", ""))
    if not user:
        raise HTTPException(status_code=401, detail="unknown or expired chat turn")
    return user


async def forget_user(username: str) -> str:
    """Ask the brain to forget everything about a deleted user (memories, chat sessions).

    Best effort like the other clean-up steps of an account deletion: returns a short
    status for the admin log instead of raising.
    """
    if not (BRAIN_URL and BRAIN_KEY):
        return "no brain"
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(f"{BRAIN_URL}/forget", json={"user": username},
                             headers={"Authorization": f"Bearer {BRAIN_KEY}"})
    except httpx.HTTPError as exc:
        logger.warning("brain forget %s failed: %s", username, exc)
        return f"error ({type(exc).__name__})"
    if r.status_code != 200:
        return f"error (HTTP {r.status_code})"
    d = r.json()
    return f"forgotten (memories {(d.get('memories') or {}).get('deleted', 0)}, sessions {d.get('sessions', 0)})"
