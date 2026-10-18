-- 010 — Onboarding invites for the public setup wizard.
-- The token is NEVER stored in plain text, only as a sha256 hex digest.
-- The router also creates the table idempotently itself
-- (ensure_invites_table in routers/onboarding_public.py).

CREATE TABLE IF NOT EXISTS claraos_invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash      TEXT NOT NULL UNIQUE,
    username        TEXT NOT NULL,
    display_name    TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    preauth_issues  INT NOT NULL DEFAULT 0,
    node_baseline   JSONB NOT NULL DEFAULT '[]',
    steps_completed JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_claraos_invites_username ON claraos_invites (username);
