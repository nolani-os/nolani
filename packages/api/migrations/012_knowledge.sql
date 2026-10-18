-- 012: "Ideas" app — idea pipeline + knowledge base (claraos_kb_*).
-- Canonical reference; routers/knowledge.py has an idempotent
-- _ensure_tables() as a safety net (planner pattern, 011_planner.sql).
--
-- Visibility model (MVP): 'private' (owner only) | 'family' (all users
-- read + comment, only the owner edits). Granular shares come later
-- (claraos_kb_shares, visibility='shared').
-- RAG: rag_status/rag_indexed_at = outbox as columns; the reconciler in
-- services/kb_indexer.py syncs pending/failed/deindex into Qdrant
-- (collection claraos_objects). Soft delete instead of DELETE, because
-- Qdrant de-indexing runs asynchronously (+ trash/restore).

CREATE TABLE IF NOT EXISTS claraos_kb_types (
    id          TEXT PRIMARY KEY,              -- slug: 'idea','vision','note',…
    name        TEXT NOT NULL,
    icon        TEXT,
    description TEXT,
    is_system   BOOLEAN NOT NULL DEFAULT FALSE,
    owner       TEXT,                          -- NULL = system type; otherwise user-defined
    prop_schema JSONB NOT NULL DEFAULT '[]',   -- [{key,label,kind:text|number|date|select|multi_select|url|checkbox|relation, options?}]
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO claraos_kb_types (id, name, icon, is_system) VALUES
  ('idea',   'Idee',   '💡', TRUE),
  ('vision', 'Vision', '🌅', TRUE),
  ('note',   'Notiz',  '📝', TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS claraos_kb_objects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type        TEXT NOT NULL REFERENCES claraos_kb_types(id),
    owner       TEXT NOT NULL,                 -- Authentik username (trusted header)
    visibility  TEXT NOT NULL DEFAULT 'private'
                CHECK (visibility IN ('private','family')),
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',      -- Markdown (single source of truth)
    properties  JSONB NOT NULL DEFAULT '{}',
    stage       TEXT CHECK (stage IN ('spark','developing','elaborated','planned','done','archived')),
    created_by  TEXT NOT NULL,                 -- owner or 'clara' (actor attribution)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ,                   -- soft delete
    rag_status  TEXT NOT NULL DEFAULT 'pending'
                CHECK (rag_status IN ('pending','ok','failed','deindex','skip')),
    rag_indexed_at TIMESTAMPTZ,
    search_tsv  tsvector GENERATED ALWAYS AS
                (to_tsvector('german', coalesce(title,'') || ' ' || coalesce(body,''))) STORED
);
CREATE INDEX IF NOT EXISTS idx_kb_obj_owner_vis ON claraos_kb_objects (owner, visibility) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kb_obj_type_stage ON claraos_kb_objects (type, stage)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kb_obj_tsv  ON claraos_kb_objects USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_kb_obj_rag  ON claraos_kb_objects (rag_status) WHERE rag_status IN ('pending','failed','deindex');

CREATE TABLE IF NOT EXISTS claraos_kb_links (      -- typed edges, directed
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id    UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    to_id      UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    rel        TEXT NOT NULL DEFAULT 'relates_to',
    -- idea pipeline: 'part_of_vision', 'inspired_by', 'duplicates'; otherwise free
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (from_id, to_id, rel)
);
CREATE INDEX IF NOT EXISTS idx_kb_links_to ON claraos_kb_links (to_id);

CREATE TABLE IF NOT EXISTS claraos_kb_activity (   -- history: Clara analyses, follow-up questions, stage changes
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id  UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    actor      TEXT NOT NULL,                  -- username or 'clara'
    kind       TEXT NOT NULL CHECK (kind IN ('comment','analysis','question','answer','stage_change','edit','handoff')),
    content    TEXT NOT NULL DEFAULT '',       -- Markdown
    meta       JSONB NOT NULL DEFAULT '{}',    -- {from_stage,to_stage} | {planner_project_id} | {session_id}
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_activity_obj ON claraos_kb_activity (object_id, created_at);
