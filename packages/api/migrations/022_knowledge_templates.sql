-- 022: Knowledge Suite v2 — templates
-- Anytype pattern: a template is bound to a type and carries both default
-- properties and a Markdown body. Resolution order on creation:
-- explicitly chosen template → the type's default template.
CREATE TABLE IF NOT EXISTS claraos_kb_templates (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner              TEXT NOT NULL,
    visibility         TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'family')),
    name               TEXT NOT NULL,
    icon               TEXT,
    target_type        TEXT REFERENCES claraos_kb_types(id),
    body               TEXT NOT NULL DEFAULT '',
    default_properties JSONB NOT NULL DEFAULT '{}',
    is_default         BOOLEAN NOT NULL DEFAULT FALSE,   -- default for target_type
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_templates_owner
    ON claraos_kb_templates (owner, target_type);
