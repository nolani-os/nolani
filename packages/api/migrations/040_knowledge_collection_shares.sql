-- 040: Collection-level shares with a permission.
--
-- Motivation: sharing a collection (e.g. a project collection) with another
-- user so that they can EDIT inside it ("we decide together"). Previously the
-- knowledge app only knew read shares per note (014) and collections were only
-- "private" or "family". For a collection with N notes that meant N individual
-- shares, all read-only, and every new note fell out of the share again.
--
-- Model: one row per (collection, user) with permission read|write.
--   read  = see the collection, read and comment on all notes in it
--   write = additionally edit notes (title, text, fields, attachments), create/
--           file new notes, change fields and views
--   Reserved for the owner: deleting (collection and notes), visibility, shares,
--   moving, restoring versions. The history records the actor anyway.
--
-- Effect on objects: the visibility clause (_VIS) and the write check
-- (_require_editable) in routers/knowledge.py derive from collection
-- membership — objects stay "private", there is no additional visibility level.
-- The safety net in _create_schema() also creates the table on startup.
CREATE TABLE IF NOT EXISTS claraos_kb_collection_shares (
    collection_id UUID NOT NULL REFERENCES claraos_kb_collections(id) ON DELETE CASCADE,
    shared_with   TEXT NOT NULL,            -- Authentik username, lowercase
    permission    TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read','write')),
    created_by    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (collection_id, shared_with)
);
CREATE INDEX IF NOT EXISTS idx_kb_coll_shares_user ON claraos_kb_collection_shares (shared_with);
