-- Push accounts (ntfy) per user, managed by routers/ntfy_proxy.py.
-- The home installation created this table by hand long ago; a cell needs it
-- from its migrations. IF NOT EXISTS: a no-op where the table is already there.
-- ntfy_password is the login the API uses to mint per-device tokens.
CREATE TABLE IF NOT EXISTS ntfy_user_credentials (
    authentik_username  TEXT PRIMARY KEY,
    ntfy_username       TEXT NOT NULL,
    ntfy_password       TEXT NOT NULL,
    ntfy_token          TEXT,
    ntfy_token_expires  TIMESTAMPTZ,
    last_token_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
