"""Guide assistant: user profile "What Clara knows about me".

A compact, curated profile block per user (Letta pattern): it is loaded into every
chat system context (chat_v2), maintained by Clara through an MCP tool
(guide_update_profile — only after the user confirmed it in the conversation) and
can be viewed, edited and deleted by the user in the settings.

Auth: regular users only read/change their own profile. Machines (MCP) come in
with X-ClaraOS-Service-Token + X-Authentik-Username=<user> and are thereby also
bound to exactly that user — no access to other users' profiles.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user
from database import get_pool

logger = logging.getLogger("claraos.guide")

router = APIRouter(prefix="/api/claraos/guide", tags=["guide"])

_TABLES_READY = False

# Keep the profile deliberately small — it goes into every chat prompt.
MAX_PROFILE_CHARS = 4000


async def _ensure_tables() -> None:
    global _TABLES_READY
    if _TABLES_READY:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS claraos_guide_profiles (
                username    TEXT NOT NULL,
                tenant_id   BIGINT NOT NULL DEFAULT 1,
                profil      JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_by  TEXT NOT NULL DEFAULT 'user',
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (username, tenant_id)
            )
            """
        )
        # RLS pattern (standing rule, migration 027); the tenancy sweep would add it
        # too — done explicitly here so the table is never left open.
        await conn.execute(
            "ALTER TABLE claraos_guide_profiles ENABLE ROW LEVEL SECURITY")
        await conn.execute(
            "ALTER TABLE claraos_guide_profiles FORCE ROW LEVEL SECURITY")
        policy = await conn.fetchval(
            "SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid "
            "WHERE c.relname='claraos_guide_profiles' AND p.polname='tenant_isolation'")
        if not policy:
            expr = ("tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', "
                    "true), ''), '1')::bigint")
            await conn.execute(
                f"CREATE POLICY tenant_isolation ON claraos_guide_profiles "
                f"USING ({expr}) WITH CHECK ({expr})")
        # Proactivity state (backoff/opt-out) on the same row.
        await conn.execute(
            "ALTER TABLE claraos_guide_profiles "
            "ADD COLUMN IF NOT EXISTS nudge_state JSONB NOT NULL DEFAULT '{}'::jsonb")
    _TABLES_READY = True


def _validate_profile(profil: Any) -> dict:
    if not isinstance(profil, dict):
        raise HTTPException(422, "profil muss ein Objekt sein.")
    raw = json.dumps(profil, ensure_ascii=False)
    if len(raw) > MAX_PROFILE_CHARS:
        raise HTTPException(
            422, f"Profil zu groß ({len(raw)} > {MAX_PROFILE_CHARS} Zeichen) — "
                 "kuratieren statt sammeln.")
    for key, val in profil.items():
        if not isinstance(key, str):
            raise HTTPException(422, "Profil-Schlüssel müssen Strings sein.")
        if not (isinstance(val, str)
                or (isinstance(val, list) and all(isinstance(x, str) for x in val))):
            raise HTTPException(
                422, f"Feld '{key}': nur Text oder Liste von Texten erlaubt.")
    return profil


async def load_profile(username: str) -> dict | None:
    """For chat_v2: the chat user's profile or None (never raises)."""
    try:
        await _ensure_tables()
        pool = await get_pool()
        row = await pool.fetchrow(
            "SELECT profil, updated_at FROM claraos_guide_profiles WHERE username=$1",
            username)
        if not row:
            return None
        profil = row["profil"]
        if isinstance(profil, str):
            profil = json.loads(profil)
        return profil or None
    except Exception:  # noqa: BLE001 — chat must never fail because of the profile
        logger.exception("guide: load_profile %s", username)
        return None


@router.get("/profile")
async def get_profile(request: Request):
    await _ensure_tables()
    user = get_current_user(request)
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT profil, updated_by, updated_at FROM claraos_guide_profiles "
        "WHERE username=$1", user["username"])
    if not row:
        return {"username": user["username"], "profil": {}, "exists": False}
    profil = row["profil"]
    if isinstance(profil, str):
        profil = json.loads(profil)
    # exists = "Clara knows the user" (profile has content) — the row itself may
    # carry only nudge state and then does not count.
    return {"username": user["username"], "profil": profil,
            "exists": bool(profil),
            "updated_by": row["updated_by"],
            "updated_at": row["updated_at"].isoformat()}


class ProfilePut(BaseModel):
    profil: dict = Field(default_factory=dict)


@router.put("/profile")
async def put_profile(body: ProfilePut, request: Request):
    """Replace the whole profile. Empty object => delete the profile."""
    await _ensure_tables()
    user = get_current_user(request)
    profil = _validate_profile(body.profil)
    # Machine access (service token header) = Clara learned it;
    # browser logins (via the reverse proxy) edit as "user".
    is_service = bool(request.headers.get("X-ClaraOS-Service-Token"))
    updated_by = "clara" if is_service else "user"
    # Data minimisation for children — field whitelist + stricter size cap.
    dropped: list[str] = []
    if profil and await is_kid(user["username"],
                               None if is_service else user.get("groups") or []):
        profil, dropped = apply_kid_profile_rules(profil)
        if dropped:
            logger.info("guide: Kid-Profil %s — Felder verworfen: %s",
                        user["username"], dropped)
    pool = await get_pool()
    if not profil:
        await pool.execute(
            "DELETE FROM claraos_guide_profiles WHERE username=$1", user["username"])
        logger.info("guide: Profil %s gelöscht (%s)", user["username"], updated_by)
        return {"ok": True, "deleted": True}
    await pool.execute(
        """INSERT INTO claraos_guide_profiles (username, profil, updated_by, updated_at)
           VALUES ($1, $2::jsonb, $3, NOW())
           ON CONFLICT (username, tenant_id)
           DO UPDATE SET profil=$2::jsonb, updated_by=$3, updated_at=NOW()""",
        user["username"], json.dumps(profil, ensure_ascii=False), updated_by)
    logger.info("guide: Profil %s aktualisiert (%s, %d Felder)",
                user["username"], updated_by, len(profil))
    out = {"ok": True, "deleted": False, "felder": len(profil)}
    if dropped:
        out["felder_verworfen"] = dropped
        out["hinweis"] = ("Kinder-Profil: nur rolle/ziele/vorlieben/technik_komfort "
                          "werden gespeichert (Datenminimierung).")
    return out


# ── Proactivity nudges — the server keeps the backoff state ─────────────────
# Rules (based on CHI 2025 research): nudges only in the shell; ignoring or
# "later" doubles the nudge's waiting time (24h -> 48h -> ..., capped at 30 days);
# globally at most ONE new nudge per day (evaluated by the client); opt-out per
# user. Eligibility conditions live in the client (tour flags are in
# localStorage) — the server is the cross-device source of truth for counters,
# time windows and opt-out.

VALID_NUDGES = ("welcome", "device-setup", "files-tour", "fotos-tour",
                "feedback-after-tour")  # satisfaction nudge
VALID_OUTCOMES = ("shown", "accepted", "dismissed", "reset")
BACKOFF_BASE_H = 24
BACKOFF_CAP_H = 24 * 30


async def _load_nudge_state(username: str) -> dict:
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT nudge_state FROM claraos_guide_profiles WHERE username=$1", username)
    state = row["nudge_state"] if row else {}
    if isinstance(state, str):
        state = json.loads(state)
    return state or {}


async def _save_nudge_state(username: str, state: dict) -> None:
    pool = await get_pool()
    await pool.execute(
        """INSERT INTO claraos_guide_profiles (username, nudge_state)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (username, tenant_id)
           DO UPDATE SET nudge_state=$2::jsonb""",
        username, json.dumps(state, ensure_ascii=False))


@router.get("/nudges")
async def get_nudges(request: Request):
    await _ensure_tables()
    user = get_current_user(request)
    state = await _load_nudge_state(user["username"])
    return {"optout": bool(state.get("optout")),
            "last_any_shown": state.get("last_any_shown"),
            "last_any_id": state.get("last_any_id"),
            "nudges": state.get("nudges", {})}


class NudgeOutcome(BaseModel):
    outcome: str


@router.post("/nudges/{nudge_id}")
async def post_nudge_outcome(nudge_id: str, body: NudgeOutcome, request: Request):
    await _ensure_tables()
    user = get_current_user(request)
    if nudge_id not in VALID_NUDGES:
        raise HTTPException(422, f"unbekannter Nudge (gültig: {', '.join(VALID_NUDGES)})")
    if body.outcome not in VALID_OUTCOMES:
        raise HTTPException(422, f"outcome muss {'|'.join(VALID_OUTCOMES)} sein")
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    state = await _load_nudge_state(user["username"])
    nudges = state.setdefault("nudges", {})
    n = nudges.setdefault(nudge_id, {})
    if body.outcome == "shown":
        n["shown"] = int(n.get("shown", 0)) + 1
        n["last_shown"] = now.isoformat()
        state["last_any_shown"] = now.isoformat()
        state["last_any_id"] = nudge_id
    elif body.outcome == "accepted":
        n["done"] = True
        n["accepted_at"] = now.isoformat()
    elif body.outcome == "dismissed":
        count = int(n.get("dismissed", 0)) + 1
        n["dismissed"] = count
        hours = min(BACKOFF_BASE_H * (2 ** (count - 1)), BACKOFF_CAP_H)
        n["next_after"] = (now + timedelta(hours=hours)).isoformat()
        n["backoff_hours"] = hours
    elif body.outcome == "reset":
        nudges.pop(nudge_id, None)
        if state.get("last_any_id") == nudge_id:
            state.pop("last_any_shown", None)
            state.pop("last_any_id", None)
    await _save_nudge_state(user["username"], state)
    return {"ok": True, "nudge": nudges.get(nudge_id, {})}


class OptOut(BaseModel):
    optout: bool


@router.post("/nudges-optout")
async def post_nudge_optout(body: OptOut, request: Request):
    await _ensure_tables()
    user = get_current_user(request)
    state = await _load_nudge_state(user["username"])
    state["optout"] = bool(body.optout)
    await _save_nudge_state(user["username"], state)
    logger.info("guide: nudge-optout %s → %s", user["username"], body.optout)
    return {"ok": True, "optout": state["optout"]}


# ── Guardrails for children + parent/rollout view ───────────────────────────
# Research basis: children form parasocial bonds faster; guardrails = stronger
# AI transparency, data minimisation, parental insight.
# Child = member of the Authentik group `claraos-kids` (assigned by the admin in
# the user admin app). Adult profiles stay private even for admins — only
# children's profiles are visible to parents.

KIDS_GROUP = "claraos-kids"
KID_ALLOWED_FIELDS = {"rolle", "ziele", "vorlieben", "technik_komfort"}
KID_MAX_PROFILE_CHARS = 1500

_kid_cache: dict[str, tuple[bool, float]] = {}


async def is_kid(username: str, session_groups: list[str] | None = None) -> bool:
    """Child status: from the session (browser headers) or via Authentik lookup
    (the MCP path has no groups header). Lookup errors => treat as adult
    (logged) — the guardrails are protection, not a prison."""
    if session_groups:
        return KIDS_GROUP in session_groups
    import time
    cached = _kid_cache.get(username)
    if cached and time.time() - cached[1] < 300:
        return cached[0]
    kid = False
    try:
        from routers.teams_admin import ak_get_user_by_username
        u = await ak_get_user_by_username(username)
        names = [g.get("name") for g in (u or {}).get("groups_obj", [])]
        kid = KIDS_GROUP in names
    except Exception:  # noqa: BLE001
        logger.exception("guide: kid-lookup %s", username)
    _kid_cache[username] = (kid, time.time())
    return kid


def apply_kid_profile_rules(profil: dict) -> tuple[dict, list[str]]:
    """Data minimisation for children: allowed fields only, stricter size cap."""
    dropped = [k for k in profil if k not in KID_ALLOWED_FIELDS]
    filtered = {k: v for k, v in profil.items() if k in KID_ALLOWED_FIELDS}
    while len(json.dumps(filtered, ensure_ascii=False)) > KID_MAX_PROFILE_CHARS and filtered:
        key = max(filtered, key=lambda k: len(json.dumps(filtered[k])))
        dropped.append(key)
        filtered.pop(key)
    return filtered, dropped


@router.get("/admin/status/{username}")
async def admin_guide_status(username: str, request: Request):
    """Rollout/parent view (admin only): how far along is Clara's onboarding
    of the user? Profile CONTENT only for children (parental transparency) —
    for adults metadata only."""
    await _ensure_tables()
    user = get_current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(403, "Nur für Admins.")
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT profil, nudge_state, updated_by, updated_at "
        "FROM claraos_guide_profiles WHERE username=$1", username)
    profil = row["profil"] if row else {}
    if isinstance(profil, str):
        profil = json.loads(profil)
    nudge_state = row["nudge_state"] if row else {}
    if isinstance(nudge_state, str):
        nudge_state = json.loads(nudge_state)
    kid = await is_kid(username)
    out = {
        "username": username,
        "kid": kid,
        "profil_felder": len(profil or {}),
        "updated_by": row["updated_by"] if row else None,
        "updated_at": row["updated_at"].isoformat() if row else None,
        "optout": bool((nudge_state or {}).get("optout")),
        "nudges": (nudge_state or {}).get("nudges", {}),
    }
    if kid:
        out["profil"] = profil or {}
    return out


# ── Layers 4+5: Clara remembers preferences and learned approaches ───────────
# Both end up as text lists in the profile (praeferenzen / gelernte_wege) and are
# thus injected into every chat -> next time Clara knows the shorter path and the
# user's preferences. No new learning engine, just appending to the profile.
class MerkePraef(BaseModel):
    text: str = Field(..., max_length=300)


class MerkeWeg(BaseModel):
    ausloeser: str = Field(..., max_length=200)
    weg: str = Field(..., max_length=400)


async def _profil_anhaengen(request: Request, feld: str, wert: str, cap: int,
                            dedupe_prefix: str | None = None) -> dict:
    user = get_current_user(request)
    prof = (await load_profile(user["username"])) or {}
    lst = [x for x in (prof.get(feld) or []) if isinstance(x, str)]
    if dedupe_prefix:
        lst = [x for x in lst if not x.startswith(dedupe_prefix)]
    elif wert in lst:
        lst.remove(wert)
    lst.append(wert)
    prof[feld] = lst[-cap:]
    _validate_profile(prof)  # size/type check (text or text lists only)
    is_service = bool(request.headers.get("X-ClaraOS-Service-Token"))
    updated_by = "clara" if is_service else "user"
    dropped: list[str] = []
    if await is_kid(user["username"], None if is_service else user.get("groups") or []):
        prof, dropped = apply_kid_profile_rules(prof)
    pool = await get_pool()
    if not prof:
        return {"ok": True, "gespeichert": False, "hinweis": "Kinder-Profil: nicht gespeichert."}
    await pool.execute(
        """INSERT INTO claraos_guide_profiles (username, profil, updated_by, updated_at)
           VALUES ($1, $2::jsonb, $3, NOW())
           ON CONFLICT (username, tenant_id)
           DO UPDATE SET profil=$2::jsonb, updated_by=$3, updated_at=NOW()""",
        user["username"], json.dumps(prof, ensure_ascii=False), updated_by)
    return {"ok": True, "gespeichert": True, "feld": feld, "anzahl": len(prof.get(feld, []))}


@router.post("/merke_praeferenz")
async def merke_praeferenz(body: MerkePraef, request: Request) -> dict:
    """Store a lasting user preference (appears in the chat context from now on)."""
    await _ensure_tables()
    if not body.text.strip():
        raise HTTPException(400, "Leerer Text.")
    return await _profil_anhaengen(request, "praeferenzen", body.text.strip(), cap=8)


@router.post("/gelernter_weg")
async def gelernter_weg(body: MerkeWeg, request: Request) -> dict:
    """Store a proven approach: which tools/steps to use for which request."""
    await _ensure_tables()
    if not body.ausloeser.strip() or not body.weg.strip():
        raise HTTPException(400, "Auslöser und Weg nötig.")
    eintrag = f"{body.ausloeser.strip()} → {body.weg.strip()}"
    return await _profil_anhaengen(request, "gelernte_wege", eintrag, cap=10,
                                   dedupe_prefix=body.ausloeser.strip() + " →")
