"""Synapse admin login with the owner's stored Matrix access.

Used by the Teams administration (fallback when the bot account has no stored
access) and by guest invitations.
"""
from __future__ import annotations

import json

import httpx
from fastapi import HTTPException

from betriebsprofil import OWNER_USER  # owner/admin account of this installation
from betriebsprofil import heim_default  # external deployments: no silent home-server fallback
from database import get_pool
from encryption import decrypt_credentials

SYNAPSE_URL = heim_default("SYNAPSE_INTERNAL_URL", key="SYNAPSE_INTERNAL_URL@teams_guests")


async def _get_synapse_admin_token() -> str:
    """Get a Synapse admin token by logging in as the admin account."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT credentials FROM claraos_app_credentials WHERE app_id=$1 AND username=$2",
            "matrix", OWNER_USER,
        )
    if not row:
        raise HTTPException(500, "No admin Matrix credentials found")
    creds = decrypt_credentials(bytes(row["credentials"]))
    if isinstance(creds, str):
        creds = json.loads(creds)

    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{SYNAPSE_URL}/_matrix/client/v3/login", json={
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": creds["username"]},
            "password": creds["password"],
            "initial_device_display_name": "ClaraOS Teams Admin",
        })
        if resp.status_code != 200:
            raise HTTPException(500, f"Synapse admin login failed: {resp.status_code}")
        return resp.json()["access_token"]
