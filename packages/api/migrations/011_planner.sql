-- 011: Planner (Clara Planner — planning environment)
-- Sidecar metadata for Vikunja objects: estimates (€/tokens/minutes),
-- links (mail/chat/file/event), "in progress by" status, scheduled VEVENT.
-- task_id = 0 ⇒ the row carries project metadata.
-- Note: routers/planner.py has an idempotent _ensure_tables() as a safety net —
-- this file is the canonical reference for applying it manually on deploy.

CREATE TABLE IF NOT EXISTS claraos_planner_meta (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username         TEXT NOT NULL,
    project_id       BIGINT NOT NULL,
    task_id          BIGINT NOT NULL DEFAULT 0,
    estimate_eur     NUMERIC(10,2),
    estimate_tokens  BIGINT,
    estimate_minutes INT,
    links            JSONB NOT NULL DEFAULT '[]',
    in_work_by       TEXT,
    in_work_since    TIMESTAMPTZ,
    in_work_session  TEXT,
    event_uid        TEXT,
    event_calendar   TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (username, project_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_planner_meta_task
    ON claraos_planner_meta (task_id);
CREATE INDEX IF NOT EXISTS idx_planner_meta_inwork
    ON claraos_planner_meta (in_work_by) WHERE in_work_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS claraos_planner_worklog (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username    TEXT NOT NULL,
    project_id  BIGINT NOT NULL,
    task_id     BIGINT NOT NULL,
    actor       TEXT NOT NULL,
    session_id  TEXT,
    started_at  TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_planner_worklog_task
    ON claraos_planner_worklog (project_id, task_id);
