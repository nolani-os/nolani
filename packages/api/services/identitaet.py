"""Signed chat identity for the trusted "[ClaraOS context]" block.

`chat_user:` in the block is what clara-agent acts on. The block is written by
this proxy only, but anyone who reaches LiteLLM directly can send a request
with any `user` and any context text. A signature lets the agent tell the
proxy's block from a forged one:

    chat_user: <user>; chat_zug: <zug_id>; chat_user_ts: <ts>; chat_user_sig: <sig>

    sig = hex(HMAC-SHA256(key, "<user>|<zug_id>|<ts>"))

* key     CLARA_IDENTITY_HMAC_KEY (shared with the agent, never logged)
* user    the lower-case chat user name exactly as in `chat_user:`
* zug_id  a fresh random id per turn (24 hex chars) — lets the agent refuse replays
* ts      unix seconds (UTC) when the block was written

Without the key nothing is added (the agent then decides: warn or reject).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time

KEY_ENV = "CLARA_IDENTITY_HMAC_KEY"


def _key() -> bytes:
    # Read at call time: secrets may be loaded after import.
    return os.environ.get(KEY_ENV, "").strip().encode()


def enabled() -> bool:
    return bool(_key())


def signatur(user: str, zug_id: str, ts: int, key: bytes | None = None) -> str:
    k = _key() if key is None else key
    msg = f"{user}|{zug_id}|{ts}".encode()
    return hmac.new(k, msg, hashlib.sha256).hexdigest()


def kontext_zeilen(user: str, now: float | None = None) -> list[str]:
    """The signature lines that follow `chat_user:` in the block, or [] without a key."""
    if not user or not enabled():
        return []
    zug_id = secrets.token_hex(12)
    ts = int(time.time() if now is None else now)
    return [f"chat_zug: {zug_id}", f"chat_user_ts: {ts}",
            f"chat_user_sig: {signatur(user, zug_id, ts)}"]


def pruefen(user: str, zug_id: str, ts: str | int, sig: str, *, max_alter_s: int = 300,
            now: float | None = None, key: bytes | None = None) -> bool:
    """Reference check (the agent implements the same): signature and age."""
    k = _key() if key is None else key
    if not k:
        return False
    try:
        ts_i = int(ts)
    except (TypeError, ValueError):
        return False
    jetzt = time.time() if now is None else now
    if abs(jetzt - ts_i) > max_alter_s:
        return False
    return hmac.compare_digest(signatur(user, zug_id, ts_i, k), (sig or "").lower())
