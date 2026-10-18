-- ClaraOS Teams: Authentik is the source of truth; Nextcloud Circles and Matrix Spaces are mirrors.

CREATE TABLE IF NOT EXISTS claraos_teams (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                    TEXT NOT NULL UNIQUE,                         -- "engineering.backend.project-x"
    name                    TEXT NOT NULL,                                -- display name
    description             TEXT,
    parent_team_id          UUID REFERENCES claraos_teams(id) ON DELETE RESTRICT,
    depth                   INT  NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 5),
    authentik_group_pk      TEXT UNIQUE,                                  -- Authentik uses UUID for group pk
    matrix_space_id         TEXT UNIQUE,                                  -- !xxx:matrix.example.com
    matrix_main_room_id     TEXT,                                         -- default chat room inside space
    nc_circle_id            TEXT UNIQUE,                                  -- 30-char opaque id
    nc_groupfolder_id       INT  UNIQUE,                                  -- optional
    inherit_members         BOOLEAN NOT NULL DEFAULT FALSE,               -- parent members auto-added?
    include_clara_bot       BOOLEAN NOT NULL DEFAULT FALSE,
    status                  TEXT NOT NULL DEFAULT 'active'                -- active|archived|pending_import
                            CHECK (status IN ('active','archived','pending_import')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by              TEXT NOT NULL,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claraos_teams_parent ON claraos_teams(parent_team_id);
CREATE INDEX IF NOT EXISTS idx_claraos_teams_slug   ON claraos_teams(slug);
CREATE INDEX IF NOT EXISTS idx_claraos_teams_status ON claraos_teams(status);

-- Audit trail for all admin actions on teams.
-- Content events (messages, file changes) stay in Matrix/NC native audit.
CREATE TABLE IF NOT EXISTS claraos_team_audit (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id                 UUID NOT NULL REFERENCES claraos_teams(id) ON DELETE CASCADE,
    actor_username          TEXT NOT NULL,
    event_type              TEXT NOT NULL,
                            -- create | rename | member_add | member_remove | role_change
                            -- | delete | sync_ok | sync_error | nc_import
    target_username         TEXT,
    details                 JSONB,                                         -- free-form context
    occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claraos_team_audit_team_time
    ON claraos_team_audit(team_id, occurred_at DESC);

-- Auto-update updated_at on row change.
CREATE OR REPLACE FUNCTION claraos_teams_touch() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_claraos_teams_touch ON claraos_teams;
CREATE TRIGGER trg_claraos_teams_touch
    BEFORE UPDATE ON claraos_teams
    FOR EACH ROW EXECUTE FUNCTION claraos_teams_touch();

-- Auto-set depth from parent on insert/update of parent_team_id.
CREATE OR REPLACE FUNCTION claraos_teams_set_depth() RETURNS TRIGGER AS $$
DECLARE
    parent_depth INT;
BEGIN
    IF NEW.parent_team_id IS NULL THEN
        NEW.depth := 0;
    ELSE
        SELECT depth INTO parent_depth FROM claraos_teams WHERE id = NEW.parent_team_id;
        IF parent_depth IS NULL THEN
            RAISE EXCEPTION 'parent_team_id % not found', NEW.parent_team_id;
        END IF;
        NEW.depth := parent_depth + 1;
        IF NEW.depth > 5 THEN
            RAISE EXCEPTION 'team hierarchy exceeds max depth 5';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_claraos_teams_depth ON claraos_teams;
CREATE TRIGGER trg_claraos_teams_depth
    BEFORE INSERT OR UPDATE OF parent_team_id ON claraos_teams
    FOR EACH ROW EXECUTE FUNCTION claraos_teams_set_depth();
