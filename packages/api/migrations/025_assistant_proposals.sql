-- 025: Assistant — proposal workflow
-- A background run ends in ONE proposed solution (instead of per-tool
-- approvals); the decision is async (no timeout in the agent), follow-up
-- questions go through the linked confirm request.
-- Safety net: routers/assistants.py::_ensure_tables() mirrors this schema.

ALTER TABLE claraos_assistant_runs
    ADD COLUMN IF NOT EXISTS proposal JSONB,
    ADD COLUMN IF NOT EXISTS decision_note TEXT;

-- Confirm requests can now be bound to an assistant run:
-- the decision (allow/deny) is mirrored onto the run and a resume is fired;
-- action=question asks a follow-up question without consuming the request.
ALTER TABLE claraos_confirm_requests
    ADD COLUMN IF NOT EXISTS run_id UUID;
CREATE INDEX IF NOT EXISTS idx_confirm_run ON claraos_confirm_requests (run_id)
    WHERE run_id IS NOT NULL;
