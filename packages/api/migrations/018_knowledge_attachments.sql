-- 018: Knowledge Suite v2 — attachments
-- Files stored as bytea (household scale; 20 MB cap enforced app-side, included in backups).
-- Scaling guardrail: columns chosen so that a later storage driver
-- (local/S3, Docmost pattern) only has to swap data → storage_key.
-- Canonical; applied via _ensure_tables() in routers/knowledge.py.

CREATE TABLE IF NOT EXISTS claraos_kb_attachments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id    UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    data         BYTEA NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_attach_obj ON claraos_kb_attachments (object_id);
