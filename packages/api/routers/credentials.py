"""Credential management endpoints for ClaraOS apps."""

import json
import logging
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from auth import get_current_user
from database import get_pool, user_tx
from encryption import encrypt_credentials, decrypt_credentials
from vw_sync import schedule_vw_sync

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/credentials", tags=["credentials"])

_tables_ensured = False


async def _ensure_tables():
    global _tables_ensured
    if _tables_ensured:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_app_credentials (
                id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username      TEXT NOT NULL,
                app_id        TEXT NOT NULL,
                account_name  TEXT NOT NULL DEFAULT 'Default',
                credentials   BYTEA NOT NULL,
                is_active     BOOLEAN DEFAULT FALSE,
                vw_synced     BOOLEAN DEFAULT FALSE,
                created_at    TIMESTAMPTZ DEFAULT NOW(),
                updated_at    TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (username, app_id, account_name)
            )
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_creds_user_app
                ON claraos_app_credentials(username, app_id)
        """)
    _tables_ensured = True


class CredentialCreate(BaseModel):
    account_name: str = "Default"
    credentials: dict  # {key: value} pairs matching CredentialSlot keys


class CredentialUpdate(BaseModel):
    credentials: dict
    # merge=True: overwrite only the keys sent, keep the rest. Needed because
    # the gateway (api_token) and widgets (username/password) share the same
    # credential record (e.g. a media server).
    merge: bool = False


class AccountInfo(BaseModel):
    account_name: str
    is_active: bool
    vw_synced: bool


@router.get("/{app_id}")
async def list_accounts(app_id: str, request: Request) -> list[AccountInfo]:
    """List all credential accounts for an app (no secrets returned)."""
    await _ensure_tables()
    user = get_current_user(request)
    async with user_tx(user["username"]) as conn:
        rows = await conn.fetch("""
            SELECT account_name, is_active, vw_synced
            FROM claraos_app_credentials
            WHERE username = $1 AND app_id = $2
            ORDER BY account_name
        """, user["username"], app_id)
    return [AccountInfo(
        account_name=r["account_name"],
        is_active=r["is_active"],
        vw_synced=r["vw_synced"],
    ) for r in rows]


@router.post("/{app_id}")
async def create_account(app_id: str, body: CredentialCreate, request: Request) -> dict:
    """Create a new credential account for an app."""
    await _ensure_tables()
    user = get_current_user(request)
    encrypted = encrypt_credentials(body.credentials)
    pool = await get_pool()  # only for the background VW sync below (service path)
    async with user_tx(user["username"]) as conn:
        # Check if this is the first account (auto-activate)
        count = await conn.fetchval("""
            SELECT COUNT(*) FROM claraos_app_credentials
            WHERE username = $1 AND app_id = $2
        """, user["username"], app_id)
        is_active = count == 0  # First account is auto-activated

        try:
            await conn.execute("""
                INSERT INTO claraos_app_credentials (username, app_id, account_name, credentials, is_active)
                VALUES ($1, $2, $3, $4, $5)
            """, user["username"], app_id, body.account_name, encrypted, is_active)
        except Exception as e:
            if "unique" in str(e).lower():
                raise HTTPException(status_code=409, detail="Account name already exists")
            raise
    logger.info("Created credential account %s/%s for user %s", app_id, body.account_name, user["username"])
    # Background VW sync
    schedule_vw_sync(pool, user["username"], app_id, body.account_name, body.credentials)
    return {"status": "created", "is_active": is_active}


@router.get("/{app_id}/{account_name}")
async def get_credentials(app_id: str, account_name: str, request: Request) -> dict:
    """Get decrypted credentials for an account (for credential injection)."""
    await _ensure_tables()
    user = get_current_user(request)
    async with user_tx(user["username"]) as conn:
        row = await conn.fetchrow("""
            SELECT credentials FROM claraos_app_credentials
            WHERE username = $1 AND app_id = $2 AND account_name = $3
        """, user["username"], app_id, account_name)
    if not row:
        raise HTTPException(status_code=404, detail="Account not found")
    return decrypt_credentials(row["credentials"])


@router.put("/{app_id}/{account_name}")
async def update_credentials(app_id: str, account_name: str, body: CredentialUpdate, request: Request) -> dict:
    """Update credentials for an account (merge=True keeps keys not in the body)."""
    await _ensure_tables()
    user = get_current_user(request)
    new_creds = body.credentials
    async with user_tx(user["username"]) as conn:
        if body.merge:
            row = await conn.fetchrow("""
                SELECT credentials FROM claraos_app_credentials
                WHERE username = $1 AND app_id = $2 AND account_name = $3
            """, user["username"], app_id, account_name)
            if not row:
                raise HTTPException(status_code=404, detail="Account not found")
            new_creds = {**(decrypt_credentials(row["credentials"]) or {}), **new_creds}
        encrypted = encrypt_credentials(new_creds)
        result = await conn.execute("""
            UPDATE claraos_app_credentials
            SET credentials = $1, vw_synced = FALSE, updated_at = NOW()
            WHERE username = $2 AND app_id = $3 AND account_name = $4
        """, encrypted, user["username"], app_id, account_name)
    if "UPDATE 0" in result:
        raise HTTPException(status_code=404, detail="Account not found")
    return {"status": "updated"}


@router.delete("/{app_id}/{account_name}")
async def delete_account(app_id: str, account_name: str, request: Request) -> dict:
    """Delete a credential account."""
    await _ensure_tables()
    user = get_current_user(request)
    async with user_tx(user["username"]) as conn:
        # Check if deleting active account
        row = await conn.fetchrow("""
            SELECT is_active FROM claraos_app_credentials
            WHERE username = $1 AND app_id = $2 AND account_name = $3
        """, user["username"], app_id, account_name)
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        await conn.execute("""
            DELETE FROM claraos_app_credentials
            WHERE username = $1 AND app_id = $2 AND account_name = $3
        """, user["username"], app_id, account_name)

        # If we deleted the active account, activate the first remaining one
        if row["is_active"]:
            await conn.execute("""
                UPDATE claraos_app_credentials SET is_active = TRUE
                WHERE id = (
                    SELECT id FROM claraos_app_credentials
                    WHERE username = $1 AND app_id = $2
                    ORDER BY account_name LIMIT 1
                )
            """, user["username"], app_id)
    return {"status": "deleted"}


@router.post("/{app_id}/{account_name}/activate")
async def activate_account(app_id: str, account_name: str, request: Request) -> dict:
    """Set an account as the active one (deactivates others)."""
    await _ensure_tables()
    user = get_current_user(request)
    async with user_tx(user["username"]) as conn:
        # Deactivate all accounts for this app
        await conn.execute("""
            UPDATE claraos_app_credentials SET is_active = FALSE
            WHERE username = $1 AND app_id = $2
        """, user["username"], app_id)
        # Activate the selected one
        result = await conn.execute("""
            UPDATE claraos_app_credentials SET is_active = TRUE, updated_at = NOW()
            WHERE username = $1 AND app_id = $2 AND account_name = $3
        """, user["username"], app_id, account_name)
    if "UPDATE 0" in result:
        raise HTTPException(status_code=404, detail="Account not found")
    return {"status": "activated"}
