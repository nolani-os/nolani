-- 046: Agent keys — per-user access keys for the MCP endpoint (services/agent_mcp.py).
--
-- A user creates a key in Settings and gives it to an AI agent of their choice
-- (Claude Desktop, Cursor, ...). The agent then acts as that user through /mcp:
-- read-only by default, writing only if the key allows it. Only a SHA-256 hash of
-- the key is stored; the key itself is shown once.
-- Every tool call through a key is logged (tool name and outcome, never arguments),
-- so the user can see what their agents did. Calls older than 90 days are pruned.
--
-- Row-level security like 044: permissive base policy plus the RESTRICTIVE owner
-- policy `nutzer_eigen`. Checking a presented key looks it up by hash across users
-- through the plain pool (like the routine scheduler); every user-facing path goes
-- through database.user_tx.
-- Idempotent.

CREATE TABLE IF NOT EXISTS claraos_agent_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username    TEXT NOT NULL,
    name        TEXT NOT NULL,
    key_hash    TEXT NOT NULL UNIQUE,          -- sha256 hex of the full key
    key_prefix  TEXT NOT NULL,                 -- first characters, to recognise a key in the list
    can_write   BOOLEAN NOT NULL DEFAULT FALSE,
    created     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used   TIMESTAMPTZ,
    revoked     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_claraos_agent_keys_user ON claraos_agent_keys (username);

CREATE TABLE IF NOT EXISTS claraos_agent_calls (
    id          BIGSERIAL PRIMARY KEY,
    key_id      UUID REFERENCES claraos_agent_keys(id) ON DELETE CASCADE,
    username    TEXT NOT NULL,
    tool        TEXT NOT NULL,
    ok          BOOLEAN NOT NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claraos_agent_calls_user ON claraos_agent_calls (username, at DESC);

DO $$
DECLARE
    t TEXT;
    ausdruck CONSTANT TEXT := 'username = current_setting(''app.user'', true)';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claraos_app') THEN
        RAISE NOTICE '046: role claraos_app missing (041 not applied) — policies skipped';
        RETURN;
    END IF;
    FOREACH t IN ARRAY ARRAY['claraos_agent_keys', 'claraos_agent_calls']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS basis ON %I', t);
        EXECUTE format('CREATE POLICY basis ON %I USING (true) WITH CHECK (true)', t);
        EXECUTE format('DROP POLICY IF EXISTS nutzer_eigen ON %I', t);
        EXECUTE format('CREATE POLICY nutzer_eigen ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
                       t, ausdruck, ausdruck);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO claraos_app', t);
    END LOOP;
    GRANT USAGE, SELECT ON SEQUENCE claraos_agent_calls_id_seq TO claraos_app;
END $$;
