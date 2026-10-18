-- Per-team Nextcloud resources (Calendar, Deck, Collective).
-- URIs/IDs are stored so the tabs UI can load the right endpoint directly.

ALTER TABLE claraos_teams
  ADD COLUMN IF NOT EXISTS nc_calendar_uri    TEXT,
  ADD COLUMN IF NOT EXISTS nc_deck_board_id   INT,
  ADD COLUMN IF NOT EXISTS nc_collective_id   INT;
