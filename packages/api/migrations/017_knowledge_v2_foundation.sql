-- 017: Knowledge Suite v2 — foundation
-- Page tree + icons/cover + derived text + weighted search + refs/favorites/history.
-- Canonical documentation; applied identically via _ensure_tables() in routers/knowledge.py.
-- Scaling guardrail: no 'family' literal here — visibility stays the job of the _VIS clause.

-- Page tree (Docmost pattern: fractional position, collate "C" for byte ordering)
ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES claraos_kb_objects(id) ON DELETE SET NULL;
ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS position TEXT COLLATE "C";
ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS icon TEXT;
ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS cover TEXT;
-- Plain text derived from the Markdown (post-save pipeline) — basis for search
ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS text_content TEXT;

CREATE INDEX IF NOT EXISTS idx_kb_obj_parent
    ON claraos_kb_objects (parent_id, position) WHERE deleted_at IS NULL;

-- Weighted search (Outline pattern: title A, body B). The old unweighted
-- GENERATED column is replaced once (DROP also removes idx_kb_obj_tsv).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'claraos_kb_objects' AND column_name = 'search_tsv'
               AND generation_expression NOT LIKE '%setweight%') THEN
    ALTER TABLE claraos_kb_objects DROP COLUMN search_tsv;
  END IF;
END $$;
ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('german', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('german', coalesce(text_content, body, '')), 'B')
    ) STORED;
CREATE INDEX IF NOT EXISTS idx_kb_obj_tsv ON claraos_kb_objects USING GIN (search_tsv);

-- Derived reference index (SiYuan pattern: both ends denormalized,
-- idempotent per-object reindex in the post-save pipeline — NEVER maintain by hand)
CREATE TABLE IF NOT EXISTS claraos_kb_refs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    src_object_id    UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    target_object_id UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL DEFAULT 'link'
                     CHECK (kind IN ('link', 'mention', 'relation_prop', 'embed')),
    anchor_text      TEXT NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (src_object_id, target_object_id, kind, anchor_text)
);
CREATE INDEX IF NOT EXISTS idx_kb_refs_target ON claraos_kb_refs (target_object_id);
CREATE INDEX IF NOT EXISTS idx_kb_refs_src ON claraos_kb_refs (src_object_id);

-- Favorites (Outline star pattern; user as string — scaling guardrail: no local user FK)
CREATE TABLE IF NOT EXISTS claraos_kb_favorites (
    username   TEXT NOT NULL,
    object_id  UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    position   TEXT COLLATE "C",
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (username, object_id)
);

-- Version history (Outline/Docmost pattern: full snapshots, skipped app-side when unchanged)
CREATE TABLE IF NOT EXISTS claraos_kb_history (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id  UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    version    INTEGER NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    properties JSONB NOT NULL DEFAULT '{}',
    actor      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (object_id, version)
);
CREATE INDEX IF NOT EXISTS idx_kb_history_obj ON claraos_kb_history (object_id, version DESC);
