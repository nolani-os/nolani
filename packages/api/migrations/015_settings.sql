-- 015: Settings service
-- Delta store: ONLY deviations from the schema default (settings_schema.py).
-- Reset = DELETE the row. One key per row → conflicts between devices
-- only affect that single key (last-write-wins per key, not per blob).
-- Note: routers/settings.py has an idempotent _ensure_tables() as a safety net —
-- this file is the canonical reference for applying it manually on deploy.

CREATE TABLE IF NOT EXISTS claraos_user_settings (
    username   TEXT NOT NULL,
    module     TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT NOT NULL DEFAULT '',  -- audit: impersonator/service, '' = the user themselves
    PRIMARY KEY (username, module, key)
);
CREATE INDEX IF NOT EXISTS idx_user_settings_user
    ON claraos_user_settings (username);
