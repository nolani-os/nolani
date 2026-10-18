-- 030: browser instance per user.
--
-- Registry of personal Clara browsers: which user has which instance,
-- on which ports and which domain. Source for
--   * /apps/selkies/status   → returns the user's OWN URL
--   * /apps/selkies/navigate → controls the user's OWN instance (Clara sees only this one)
--   * lifecycle (lazy start / idle reaper)
--
-- Port scheme, index i:
--   Desktop: web 8300+i · relay 8400+i · cdp 8500+i
--   Mobile:  web 8600+i · relay 8700+i · cdp 8800+i
-- Exception: index 0 = a pre-existing instance that may run on ports outside
-- this scheme — which is why the ports are stored EXPLICITLY in the table
-- instead of being computed.
--
-- Also works without a migration run: routers/apps.py:_ensure_user_browser_table()
-- creates it idempotently.
CREATE TABLE IF NOT EXISTS claraos_user_browsers (
    username        TEXT NOT NULL,
    tenant_id       BIGINT NOT NULL DEFAULT 1,
    idx             INTEGER NOT NULL,
    -- Desktop
    desktop_host    TEXT NOT NULL,              -- e.g. browser-<user>.example.com
    desktop_web     INTEGER NOT NULL,
    desktop_relay   INTEGER NOT NULL,
    desktop_cdp     INTEGER NOT NULL,
    desktop_ctr     TEXT NOT NULL,              -- container name (lifecycle)
    -- Mobile
    mobile_host     TEXT NOT NULL,
    mobile_web      INTEGER NOT NULL,
    mobile_relay    INTEGER NOT NULL,
    mobile_cdp      INTEGER NOT NULL,
    mobile_ctr      TEXT NOT NULL,
    -- Operations
    stack_dir       TEXT NOT NULL DEFAULT '',   -- compose directory on the apps host
    managed         BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE = managed by hand (index 0)
    last_seen       TIMESTAMPTZ,                -- last use (idle reaper)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (username, tenant_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS claraos_user_browsers_idx_uniq
    ON claraos_user_browsers (tenant_id, idx);

ALTER TABLE claraos_user_browsers ENABLE ROW LEVEL SECURITY;
ALTER TABLE claraos_user_browsers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON claraos_user_browsers;
CREATE POLICY tenant_isolation ON claraos_user_browsers
    USING (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint);
