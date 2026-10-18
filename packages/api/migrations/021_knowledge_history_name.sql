-- 021: Knowledge Suite v2 — named versions
-- Named versions ("before the big rework") — an Outline feature.
-- Diffs are NOT stored but computed on read (services/kb_diff.py):
-- snapshots are robust, and the diff rendering may change at any time.
ALTER TABLE claraos_kb_history ADD COLUMN IF NOT EXISTS name TEXT;
