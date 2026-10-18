-- 019: Knowledge Suite v2 — databases
-- Field registry (AppFlowy pattern: stable type IDs + opaque type_option JSONB)
-- and named views per collection (DatabaseViewSetting pattern).
-- The existing kb_types.prop_schema remains the fallback/seed source: fields are
-- materialized from it ONCE on first view access (no breakage).
-- Scaling guardrail: filters/sorts are compiled to SQL server-side (not
-- in-memory like SiYuan/AFFiNE) — this also handles team-sized data volumes.

-- field_type (stable numbers, append-only — NEVER renumber):
--   0 text · 1 number · 2 date · 3 select · 4 multi_select · 5 url
--   6 checkbox · 7 checklist · 8 media · 9 person
--   10 relation · 11 rollup · 12 created_time · 13 updated_time
--   14 formula (reserved, not implemented yet)
CREATE TABLE IF NOT EXISTS claraos_kb_fields (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id UUID NOT NULL REFERENCES claraos_kb_collections(id) ON DELETE CASCADE,
    key           TEXT NOT NULL,           -- key in claraos_kb_objects.properties
    name          TEXT NOT NULL,
    field_type    SMALLINT NOT NULL DEFAULT 0,
    type_option   JSONB NOT NULL DEFAULT '{}',
    is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
    position      TEXT COLLATE "C",
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (collection_id, key)
);
CREATE INDEX IF NOT EXISTS idx_kb_fields_coll ON claraos_kb_fields (collection_id, position);

CREATE TABLE IF NOT EXISTS claraos_kb_views (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id  UUID NOT NULL REFERENCES claraos_kb_collections(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    layout         TEXT NOT NULL DEFAULT 'table'
                   CHECK (layout IN ('table', 'board', 'gallery', 'list', 'calendar')),
    layout_setting JSONB NOT NULL DEFAULT '{}',   -- e.g. {"date_field": "<key>"} for calendar
    filters        JSONB NOT NULL DEFAULT '{}',   -- filter tree {op, children[]} | {} = no filter
    sorts          JSONB NOT NULL DEFAULT '[]',   -- [{key, dir:"asc"|"desc"}]
    group_setting  JSONB NOT NULL DEFAULT '{}',   -- {"key": "<select-key>"}
    field_settings JSONB NOT NULL DEFAULT '{}',   -- {"<key>": {visible, width}}
    position       TEXT COLLATE "C",
    created_by     TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_views_coll ON claraos_kb_views (collection_id, position);

-- properties JSONB is filtered/sorted → GIN (scaling guardrail)
CREATE INDEX IF NOT EXISTS idx_kb_obj_props ON claraos_kb_objects USING GIN (properties);
