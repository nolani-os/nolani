-- ClaraOS App Ecosystem: Credential Storage + OAuth Tokens
-- Run after schema.sql (001)

-- App credentials (encrypted at rest)
CREATE TABLE IF NOT EXISTS claraos_app_credentials (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL,
    app_id        TEXT NOT NULL,
    account_name  TEXT NOT NULL DEFAULT 'Default',
    credentials   BYTEA NOT NULL,
    is_active     BOOLEAN DEFAULT FALSE,
    vw_synced     BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (username, app_id, account_name)
);

CREATE INDEX IF NOT EXISTS idx_creds_user_app
    ON claraos_app_credentials(username, app_id);

-- OAuth token storage (for Google, GitHub, Spotify etc.)
CREATE TABLE IF NOT EXISTS claraos_oauth_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL,
    provider      TEXT NOT NULL,
    account_name  TEXT NOT NULL DEFAULT 'Default',
    access_token  BYTEA NOT NULL,
    refresh_token BYTEA,
    token_type    TEXT DEFAULT 'Bearer',
    expires_at    TIMESTAMPTZ,
    scopes        TEXT[],
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (username, provider, account_name)
);
