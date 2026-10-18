-- ClaraOS database schema extension for the ClaraOS database
-- Run this once to create the tables.

-- User preferences (skin, theme, wallpaper, pinned apps)
CREATE TABLE IF NOT EXISTS claraos_user_prefs (
    username    TEXT PRIMARY KEY,
    prefs       JSONB NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Desktop state (window positions, open apps) for session restore
CREATE TABLE IF NOT EXISTS claraos_desktop_state (
    username    TEXT PRIMARY KEY,
    state       JSONB NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- App registry (for future dynamic apps)
CREATE TABLE IF NOT EXISTS claraos_apps (
    id          TEXT PRIMARY KEY,
    manifest    JSONB NOT NULL,
    enabled     BOOLEAN DEFAULT TRUE,
    created_by  TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Per-user app access overrides
CREATE TABLE IF NOT EXISTS claraos_user_apps (
    username    TEXT NOT NULL,
    app_id      TEXT NOT NULL REFERENCES claraos_apps(id) ON DELETE CASCADE,
    enabled     BOOLEAN DEFAULT TRUE,
    pinned      BOOLEAN DEFAULT FALSE,
    sort_order  INTEGER DEFAULT 0,
    PRIMARY KEY (username, app_id)
);
