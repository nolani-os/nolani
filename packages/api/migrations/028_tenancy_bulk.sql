-- tenant_id + FORCE RLS on ALL of our own tables.
-- The same logic runs idempotently on every api start (tenancy.ensure_all_rls)
-- under an advisory lock — this file is the manual/documented path.
-- Deliberately WITHOUT an FK to claraos_tenants (the bulk step stays purely additive/safe).
-- agent_tasks lives in the AGENT_ORCHESTRATION DB (DBOS) → not here.

-- Avoid the duplicate index from 027 (the bulk step names it idx_claraos_kb_templates_tenant)
DROP INDEX IF EXISTS idx_kb_templates_tenant;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'claraos_%'
      AND tablename <> 'claraos_tenants'
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1', r.tablename);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', 'idx_' || r.tablename || '_tenant', r.tablename);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.tablename);
    IF NOT EXISTS (
        SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = r.tablename AND p.polname = 'tenant_isolation')
    THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I '
        'USING (tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint) '
        'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint)',
        r.tablename);
    END IF;
  END LOOP;
END $$;
