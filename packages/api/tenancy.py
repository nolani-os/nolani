"""Tenancy foundation: the default installation is tenant 1.

ClaraOS currently runs single-tenant; this module contract makes the tenant
concept explicit from the start, so that multi-tenancy later is a matter of
configuration rather than a rewrite:

- Every connection in the DB pool sets the session GUC `claraos.tenant_id`
  (see database.py) — RLS policies filter on it.
- New tables: `tenant_id BIGINT NOT NULL DEFAULT 1` + a policy following the
  base pattern in migrations/027_tenancy_foundation.sql.
- Object storage keys carry the prefix `t{tenant_id}/` (storage.py).

When real tenant resolution arrives (e.g. from the Authentik context), THIS
function is the only place that changes.
"""

import os

from betriebsprofil import heim_struktur

CURRENT_TENANT_ID: int = int(os.environ.get("CLARAOS_TENANT_ID", "1"))


def get_tenant_id() -> int:
    return CURRENT_TENANT_ID


# Tables that must NOT be covered by the bulk RLS
_RLS_SKIP = {"claraos_tenants"}

_POLICY_EXPR = (
    "tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint"
)


async def ensure_all_rls(pool) -> int:
    """Bulk retrofit: tenant_id + index + FORCE RLS policy on ALL first-party
    tables (claraos_* plus a few app tables with their own prefix).

    Idempotent; runs in the lifespan of EVERY instance under an advisory xact
    lock — so tables created lazily by router DDL also get their tenancy at the
    latest on the next start (eventual consistency instead of editing 62
    routers; pattern and rationale: migrations/028_tenancy_bulk.sql).
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(3252525)")
            # Foundation even without the migration runner (fresh install!)
            await conn.execute(
                "CREATE TABLE IF NOT EXISTS claraos_tenants ("
                " id BIGINT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,"
                " name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
            )
            await conn.execute(
                "INSERT INTO claraos_tenants (id, slug, name) "
                "VALUES (1, 'default', 'Default') ON CONFLICT (id) DO NOTHING"
            )
            rows = await conn.fetch(
                "SELECT tablename FROM pg_tables WHERE schemaname='public' "
                "AND (tablename LIKE 'claraos_%' OR tablename = ANY($1::text[]))",
                list(heim_struktur("HEIM_RLS_TABELLEN", ())),
            )
            n = 0
            for r in rows:
                t = r["tablename"]
                if t in _RLS_SKIP:
                    continue
                await conn.execute(
                    f'ALTER TABLE "{t}" ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1'
                )
                await conn.execute(
                    f'CREATE INDEX IF NOT EXISTS "idx_{t}_tenant" ON "{t}" (tenant_id)'
                )
                await conn.execute(f'ALTER TABLE "{t}" ENABLE ROW LEVEL SECURITY')
                await conn.execute(f'ALTER TABLE "{t}" FORCE ROW LEVEL SECURITY')
                policy_exists = await conn.fetchval(
                    "SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid "
                    "WHERE c.relname=$1 AND p.polname='tenant_isolation'", t
                )
                if not policy_exists:
                    await conn.execute(
                        f'CREATE POLICY tenant_isolation ON "{t}" '
                        f"USING ({_POLICY_EXPR}) WITH CHECK ({_POLICY_EXPR})"
                    )
                n += 1
            return n
