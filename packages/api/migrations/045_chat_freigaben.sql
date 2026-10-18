-- Approvals from the chat: a tool marked `freigabe: true` (e.g. posting publicly)
-- is not executed when Clara calls it, but stored for the user to approve by button
-- — in the same place as a routine's proposals: a run WITHOUT a routine.
-- RLS of claraos_routine_laeufe (044) applies unchanged.
ALTER TABLE claraos_routine_laeufe ALTER COLUMN routine_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claraos_routine_laeufe_chat
    ON claraos_routine_laeufe (username, gestartet DESC) WHERE routine_id IS NULL;
