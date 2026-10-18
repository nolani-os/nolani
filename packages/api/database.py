"""Database connection pool for ClaraOS API."""

import os
from contextlib import asynccontextmanager

import asyncpg

from tenancy import CURRENT_TENANT_ID

_pool: asyncpg.Pool | None = None


async def _init_connection(conn: asyncpg.Connection) -> None:
    """Tenancy: set the session GUC used by RLS policies (default tenant = 1).

    Policies filter on current_setting('claraos.tenant_id', true) and fall
    back to '1' without the GUC — setting it here makes the context explicit
    and is the hook point for real tenant resolution later.
    """
    await conn.execute(
        "SELECT set_config('claraos.tenant_id', $1, false)", str(CURRENT_TENANT_ID)
    )


def _build_db_url() -> str:
    """Build postgres URL — prefer split CLARAOS_DB_* (secret store split),
    falls back to legacy DATABASE_URL env-var, or hard-coded local-dev default."""
    host = os.environ.get("CLARAOS_DB_HOST")
    if host:
        user = os.environ.get("CLARAOS_DB_USER", "clara")
        password = os.environ.get("CLARAOS_DB_PASS", "")
        port = os.environ.get("CLARAOS_DB_PORT", "5432")
        name = os.environ.get("CLARAOS_DB_NAME", "clara_users")
        return f"postgresql://{user}:{password}@{host}:{port}/{name}"
    return os.environ.get(
        "DATABASE_URL",
        "postgresql://clara:clara@localhost:5432/clara_users",
    )


async def get_pool() -> asyncpg.Pool:
    """Get or create the connection pool. URL is built lazily on first call
    so the secret bootstrap in the lifespan startup has already injected env-vars."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            _build_db_url(),
            min_size=2,
            max_size=10,
            command_timeout=10,
            init=_init_connection,
        )
    return _pool


# Role the API switches into for per-user tables (migrations/041_app_rolle.sql).
APP_ROLLE = "claraos_app"

# Values of the GUC `app.rolle` (migrations/043_app_rolle_etappe3.sql). The
# policies of the assistant and device tables let `admin` see every row and
# `system` act for every owner. Both values are set ONLY in this module: `admin`
# from the verified identity (auth.get_current_user -> rolle_fuer), `system`
# only through system_tx. Never derive them from request data.
ROLLE_ADMIN = "admin"
ROLLE_SYSTEM = "system"


def rolle_fuer(user: dict) -> str | None:
    """`app.rolle` for a verified identity from auth.get_current_user.

    Returns ROLLE_ADMIN for the admin role and None for everyone else. The
    dict must come from the auth module (proxy secret or service token), never
    from a request body.
    """
    return ROLLE_ADMIN if (user or {}).get("role") == "admin" else None


@asynccontextmanager
async def user_tx(username: str, rolle: str | None = None):
    """A transaction in which row-level security is enforced for `username`.

    The pool connects as a superuser, and superusers bypass RLS. Inside this
    block the connection runs as `claraos_app` (no superuser, no BYPASSRLS)
    and `app.user` names the acting user, so the RESTRICTIVE policy
    `nutzer_eigen` lets only that user's rows through. Both settings are
    transaction-local and end with the block — nothing leaks into the next
    request on the shared pool.

    `rolle` (only ROLLE_ADMIN, see rolle_fuer) additionally sets `app.rolle`;
    only the stage-3 policies (assistants, devices) read it. The stage-1/2
    tables stay strictly per user, also for admins.

    Fail-closed: an empty name is refused here, and a connection that skips
    this helper but switches the role anyway sees zero rows.
    """
    if not username or not isinstance(username, str):
        raise ValueError("user_tx: username is required")
    if rolle not in (None, ROLLE_ADMIN):
        raise ValueError("user_tx: rolle must be None or 'admin'")
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(f"SET LOCAL ROLE {APP_ROLLE}")
            await conn.execute("SELECT set_config('app.user', $1, true)", username)
            if rolle:
                await conn.execute("SELECT set_config('app.rolle', $1, true)", rolle)
            yield conn


@asynccontextmanager
async def system_tx(zweck: str):
    """A transaction for a background job that acts for every owner.

    Scheduler, webhook and confirmation paths of the assistants (cron triggers,
    effectiveness checks, runs fired after an approval) have no signed-in user,
    yet must see the rows of all owners. Leaving them on the superuser pool
    would keep them working even if a policy broke; switching them into the
    role WITHOUT a context would make them silently see nothing. So they say
    it explicitly: `claraos_app` + `app.rolle = 'system'` (+ `app.zweck`, the
    name of the job, for debugging).

    `app.user` stays unset, so every stage-1/2 policy (credentials, mail,
    knowledge, ...) still returns zero rows here: the system context opens the
    stage-3 tables only, and only as far as their policies allow.
    """
    if not zweck or not isinstance(zweck, str):
        raise ValueError("system_tx: zweck is required")
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(f"SET LOCAL ROLE {APP_ROLLE}")
            await conn.execute("SELECT set_config('app.rolle', $1, true)", ROLLE_SYSTEM)
            await conn.execute("SELECT set_config('app.zweck', $1, true)", zweck)
            yield conn


class _TxDB:
    """Pool-like facade whose every call runs in its own short transaction.

    Drop-in for the `pool.fetch/fetchrow/fetchval/execute` style used by many
    routers: each call is one transaction under row-level security, exactly
    like a plain pool call is one implicit transaction. No connection is held
    between calls (slow uploads in between stay cheap).
    """

    __slots__ = ()

    def _tx(self):  # pragma: no cover - overridden
        raise NotImplementedError

    async def fetch(self, query: str, *args, **kw):
        async with self._tx() as conn:
            return await conn.fetch(query, *args, **kw)

    async def fetchrow(self, query: str, *args, **kw):
        async with self._tx() as conn:
            return await conn.fetchrow(query, *args, **kw)

    async def fetchval(self, query: str, *args, **kw):
        async with self._tx() as conn:
            return await conn.fetchval(query, *args, **kw)

    async def execute(self, query: str, *args, **kw):
        async with self._tx() as conn:
            return await conn.execute(query, *args, **kw)

    async def executemany(self, query: str, args, **kw):
        async with self._tx() as conn:
            return await conn.executemany(query, args, **kw)


class UserDB(_TxDB):
    """See _TxDB; every call is a `user_tx(username, rolle)`."""

    __slots__ = ("username", "rolle")

    def __init__(self, username: str, rolle: str | None = None):
        if not username or not isinstance(username, str):
            raise ValueError("user_db: username is required")
        if rolle not in (None, ROLLE_ADMIN):
            raise ValueError("user_db: rolle must be None or 'admin'")
        self.username = username
        self.rolle = rolle

    def _tx(self):
        return user_tx(self.username, self.rolle)


class SystemDB(_TxDB):
    """See _TxDB; every call is a `system_tx(zweck)`."""

    __slots__ = ("zweck",)

    def __init__(self, zweck: str):
        if not zweck or not isinstance(zweck, str):
            raise ValueError("system_db: zweck is required")
        self.zweck = zweck

    def _tx(self):
        return system_tx(self.zweck)


def user_db(username: str, rolle: str | None = None) -> UserDB:
    """See UserDB. Raises ValueError for an empty name (fail-closed)."""
    return UserDB(username, rolle)


def caller_db(user: dict) -> UserDB:
    """UserDB for a verified identity from auth.get_current_user (name + role)."""
    return UserDB((user or {}).get("username") or "", rolle_fuer(user))


def system_db(zweck: str) -> SystemDB:
    """See SystemDB. For background jobs only; `zweck` names the job."""
    return SystemDB(zweck)


async def close_pool():
    """Close the connection pool."""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
