-- 023: Knowledge Suite v2 — timeline view
-- layout_setting then carries {"start_field": "<key>", "end_field": "<key>"}.
ALTER TABLE claraos_kb_views DROP CONSTRAINT IF EXISTS claraos_kb_views_layout_check;
ALTER TABLE claraos_kb_views ADD CONSTRAINT claraos_kb_views_layout_check
    CHECK (layout IN ('table', 'board', 'gallery', 'list', 'calendar', 'timeline'));
