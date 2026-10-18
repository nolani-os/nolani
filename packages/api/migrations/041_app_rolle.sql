-- 041: Row-level security that is actually enforced — role `claraos_app`.
--
-- Background (same reasoning as 033_kontakte.sql):
--   * If the API connects as a SUPERUSER (common in container setups), RLS is
--     bypassed, even with FORCE ROW LEVEL SECURITY — every `tenant_isolation`
--     policy is decorative for such a role.
--   * All `tenant_isolation` policies are PERMISSIVE (OR-combined) and true for
--     every household member, so they never separate one user from another.
--
-- What this migration does (stage 1 of moving the API off the superuser):
--   1. Role `claraos_app`: NOLOGIN NOSUPERUSER NOBYPASSRLS. Nobody connects
--      with it; the API switches into it per transaction (`SET LOCAL ROLE`,
--      database.user_tx). `SET LOCAL` ends with the transaction, so nothing
--      bleeds into the next request on a shared pool.
--   2. The acting user travels in the GUC `app.user`
--      (`set_config('app.user', <name>, true)` — also transaction-local).
--   3. Per table one RESTRICTIVE policy `nutzer_eigen`:
--        username = current_setting('app.user', true)
--      RESTRICTIVE = AND-combined with `tenant_isolation`. Without `app.user`
--      the comparison is NULL ⇒ zero rows (fail-closed).
--   4. Only the tables whose EVERY API access path goes through user_tx.
--      Paths that still use the plain pool keep working (superuser), so this
--      migration is safe to apply before the code is rolled out — and stays
--      harmless if the code is rolled back.
--
-- Tables in this stage: claraos_user_prefs, claraos_desktop_state,
-- claraos_user_settings, claraos_jobs (new, born with the policy).
--
-- Idempotent. Reverse: down/041_app_rolle.sql (kept out of the migrations/*.sql
-- glob that deploy/cell/setup.sh applies).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claraos_app') THEN
        CREATE ROLE claraos_app NOLOGIN NOSUPERUSER NOBYPASSRLS
                                NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO claraos_app;

-- ── Long-running agent jobs shown as status cards in the chat ────────────────
CREATE TABLE IF NOT EXISTS claraos_jobs (
    job_id       TEXT PRIMARY KEY,
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    username     TEXT NOT NULL,
    chat_id      TEXT,
    titel        TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'laeuft'
                 CHECK (status IN ('laeuft', 'fertig', 'fehler')),
    ergebnis_url TEXT,
    fehler       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claraos_jobs_user ON claraos_jobs (username, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_claraos_jobs_chat ON claraos_jobs (chat_id);
ALTER TABLE claraos_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE claraos_jobs FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'claraos_jobs'::regclass
                   AND polname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON claraos_jobs
            USING (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint)
            WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint);
    END IF;
END $$;

-- ── Owner policy on every stage-1 table ─────────────────────────────────────
DO $$
DECLARE
    t TEXT;
    ausdruck CONSTANT TEXT := 'username = current_setting(''app.user'', true)';
BEGIN
    FOREACH t IN ARRAY ARRAY['claraos_user_prefs', 'claraos_desktop_state',
                             'claraos_user_settings', 'claraos_jobs']
    LOOP
        IF to_regclass(t) IS NULL THEN
            RAISE NOTICE '041: table % missing — skipped', t;
            CONTINUE;
        END IF;
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS nutzer_eigen ON %I', t);
        -- AS RESTRICTIVE is the core: permissive would be OR-ed with
        -- tenant_isolation, which is true for everyone.
        EXECUTE format('CREATE POLICY nutzer_eigen ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
                       t, ausdruck, ausdruck);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO claraos_app', t);
    END LOOP;
END $$;
