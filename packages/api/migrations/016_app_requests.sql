-- 016: Approval requests for the software center
-- Two-level self-service: level A (enable a tile) goes through
-- claraos_user_apps and needs no table. Level B (a new app) is a
-- deployment with Docker privileges and therefore lands here for approval.
-- Safety net: routers/software_center.py creates the table idempotently itself.

CREATE TABLE IF NOT EXISTS claraos_app_requests (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT NOT NULL,
    app_id        TEXT NOT NULL,
    note          TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'open',   -- open | approved | declined
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at    TIMESTAMPTZ,
    decided_by    TEXT NOT NULL DEFAULT '',
    decision_note TEXT NOT NULL DEFAULT ''
);

-- One open request per user and app — double clicks do not cause a flood.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_requests_open
    ON claraos_app_requests (username, app_id) WHERE status = 'open';
