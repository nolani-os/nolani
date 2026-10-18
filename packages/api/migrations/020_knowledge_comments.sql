-- 020: Knowledge Suite v2 — inline comments + notifications
--
-- Key decision (Outline pattern): a comment's anchor is NOT stored in the
-- Markdown. We store the QUOTE (anchor_text) plus some context before and
-- after it; the location is searched again in the current body when reading.
-- This keeps `body` pure Markdown (Clara can keep writing into it freely, RAG
-- chunks it unchanged) and comments survive edits as long as the quote exists.
-- If the quote can no longer be found, the comment is marked as "context lost"
-- instead of silently disappearing.

CREATE TABLE IF NOT EXISTS claraos_kb_comments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id     UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    parent_id     UUID REFERENCES claraos_kb_comments(id) ON DELETE CASCADE,  -- threads one level deep
    author        TEXT NOT NULL,
    body          TEXT NOT NULL,
    anchor_text   TEXT NOT NULL DEFAULT '',   -- quoted text ('' = comment on the whole object)
    anchor_prefix TEXT NOT NULL DEFAULT '',   -- ~40 chars before (disambiguation)
    anchor_suffix TEXT NOT NULL DEFAULT '',   -- ~40 chars after
    resolved_at   TIMESTAMPTZ,
    resolved_by   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_kb_comments_obj
    ON claraos_kb_comments (object_id, created_at) WHERE deleted_at IS NULL;

-- Notifications (Outline notification pattern). Scaling guardrail:
-- `username` is a string from the Authentik header, not an FK to a local
-- user table — this also supports team/group recipients later.
CREATE TABLE IF NOT EXISTS claraos_kb_notifications (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username   TEXT NOT NULL,
    object_id  UUID REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    comment_id UUID REFERENCES claraos_kb_comments(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'mention', 'reply')),
    actor      TEXT NOT NULL,
    snippet    TEXT NOT NULL DEFAULT '',
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_notif_user
    ON claraos_kb_notifications (username, read_at, created_at DESC);
