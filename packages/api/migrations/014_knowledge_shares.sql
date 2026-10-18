-- 014: "Ideas" app — granular shares: share objects with individual users
-- (visibility='shared' + recipient list). Canonical reference;
-- routers/knowledge.py has an idempotent _ensure_tables() as a safety net.
--
-- Semantics: 'private' = owner only · 'family' = all users · 'shared' = owner
-- + explicit recipients (claraos_kb_shares). Recipients may read +
-- comment (like family). RAG: kb_indexer writes shared_with[] into the
-- Qdrant payload; the search filter matches owner/family/shared_with.

ALTER TABLE claraos_kb_objects DROP CONSTRAINT IF EXISTS claraos_kb_objects_visibility_check;
ALTER TABLE claraos_kb_objects ADD CONSTRAINT claraos_kb_objects_visibility_check
    CHECK (visibility IN ('private','family','shared'));

CREATE TABLE IF NOT EXISTS claraos_kb_shares (
    object_id   UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    shared_with TEXT NOT NULL,               -- Authentik username of the recipient
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (object_id, shared_with)
);
CREATE INDEX IF NOT EXISTS idx_kb_shares_user ON claraos_kb_shares (shared_with);
