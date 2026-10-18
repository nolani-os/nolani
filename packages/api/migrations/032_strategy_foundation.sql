-- 032: Strategy layer of the Idea Suite
--
-- Purely additive. Three things:
--   1) four new system types (goal/kpi/concept/analysis)
--   2) metadata on the edge (impact/effort belong to the link idea→goal,
--      not to the object — otherwise the effort-impact matrix would show the
--      same points for every goal).
--   3) the only new table: KPI measurements.
--
-- The goal hierarchy needs NO new construct: it uses the existing page
-- hierarchy (parent_id + fractional position; cycle protection and
-- re-parenting are already implemented there).
--
-- Warning: do NOT leave tenant_id/RLS to the automatic step: `tenancy.ensure_all_rls`
-- runs at API START, but the safety net in _ensure_tables only creates the table
-- on the FIRST knowledge call after that. It would remain unprotected until the
-- next restart. Hence it is shipped in full here
-- (same wording as migration 028, so the automatic step later does not
-- create anything twice).

INSERT INTO claraos_kb_types (id, name, icon, is_system, description) VALUES
  ('goal',     'Ziel',    '🎯', TRUE, 'Ziel oder Unterziel — Hierarchie über die Seitenstruktur, gemessen über verknüpfte Kennzahlen'),
  ('kpi',      'Kennzahl','📈', TRUE, 'Messgröße mit Basis, Zielwert und Termin; Werte in claraos_kb_kpi_values'),
  ('concept',  'Konzept', '🧩', TRUE, 'Ausgearbeitete Idee (Problem, Wirkmechanismus, erste Schritte)'),
  ('analysis', 'Analyse', '🔍', TRUE, 'Ergebnis einer Kaizen-Methode (5-Why, Pareto)')
ON CONFLICT (id) DO NOTHING;

-- Rating on the edge: {impact, effort, confidence, rated_by, rated_at,
-- suggested:{impact,effort,reason}}. Clara's estimate goes into `suggested`
-- until a human confirms it.
ALTER TABLE claraos_kb_links
    ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}';

-- Measurements get their own table because time series grow without bound and
-- are filtered and aggregated by time — both would be expensive in a JSONB field.
CREATE TABLE IF NOT EXISTS claraos_kb_kpi_values (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kpi_id     UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    ts         TIMESTAMPTZ NOT NULL,
    value      NUMERIC NOT NULL,
    source     TEXT NOT NULL DEFAULT 'manual',   -- manual|planner|formula|clara|<installation sources>
    note       TEXT,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tenant_id  BIGINT NOT NULL DEFAULT 1,
    -- A collector may re-deliver the same timestamp (correction) without
    -- creating duplicate points; different sources may measure side by side
    -- (entered manually vs. fetched automatically).
    UNIQUE (kpi_id, ts, source)
);

-- If the safety net in _ensure_tables already created the table without tenant_id
-- (deployed before this migration), add the column — `CREATE TABLE IF
-- NOT EXISTS` would otherwise silently skip and the column would be missing forever.
ALTER TABLE claraos_kb_kpi_values
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_kb_kpi_values_kpi
    ON claraos_kb_kpi_values (kpi_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_claraos_kb_kpi_values_tenant
    ON claraos_kb_kpi_values (tenant_id);

ALTER TABLE claraos_kb_kpi_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE claraos_kb_kpi_values FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname = 'claraos_kb_kpi_values' AND p.polname = 'tenant_isolation')
  THEN
    CREATE POLICY tenant_isolation ON claraos_kb_kpi_values
      USING (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint)
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint);
  END IF;
END $$;
