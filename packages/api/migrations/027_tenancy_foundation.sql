-- Tenancy foundation: tenant concept + basic RLS pattern.
-- The initial household = tenant 1. Idempotent, additive, safe on existing data.

CREATE TABLE IF NOT EXISTS claraos_tenants (
    id         BIGINT PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO claraos_tenants (id, slug, name)
VALUES (1, 'default', 'Default')
ON CONFLICT (id) DO NOTHING;

-- ── BASIC RLS PATTERN (template for all of our own tables) ─────────────
-- 1) Column:   ALTER TABLE <t> ADD COLUMN IF NOT EXISTS tenant_id BIGINT
--                NOT NULL DEFAULT 1 REFERENCES claraos_tenants(id);
-- 2) Index:    CREATE INDEX IF NOT EXISTS idx_<t>_tenant ON <t>(tenant_id);
-- 3) Policy:   ENABLE + FORCE ROW LEVEL SECURITY; the policy filters on the
--    session GUC claraos.tenant_id (set by the DB pool, database.py) with
--    fallback '1' — so NOTHING breaks if the GUC is ever missing
--    (manual psql access, legacy clients).
-- FORCE is required because the api connects as the table owner (owners
-- are otherwise exempt from RLS).

-- ── Example: claraos_kb_templates (knowledge templates) ──────────────────
ALTER TABLE claraos_kb_templates
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1
    REFERENCES claraos_tenants(id);

CREATE INDEX IF NOT EXISTS idx_kb_templates_tenant
    ON claraos_kb_templates (tenant_id);

ALTER TABLE claraos_kb_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE claraos_kb_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON claraos_kb_templates;
CREATE POLICY tenant_isolation ON claraos_kb_templates
    USING (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint);
