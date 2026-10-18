-- 029 (Guide): user profile "What Clara knows about me".
-- Also works without this migration via routers/guide.py:_ensure_tables (idempotent).
CREATE TABLE IF NOT EXISTS claraos_guide_profiles (
    username    TEXT NOT NULL,
    tenant_id   BIGINT NOT NULL DEFAULT 1,
    profil      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by  TEXT NOT NULL DEFAULT 'user',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (username, tenant_id)
);

ALTER TABLE claraos_guide_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE claraos_guide_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON claraos_guide_profiles;
CREATE POLICY tenant_isolation ON claraos_guide_profiles
    USING (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint);
