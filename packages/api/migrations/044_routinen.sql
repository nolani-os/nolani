-- 044: Routines (recurring tasks for Clara) and in-app notifications.
--
-- A routine is a recurring instruction ("every weekday at 7: summarise my inbox and
-- today's tasks"). It runs through the external brain with the cell's tools; a
-- routine run may only READ — anything that would change data is stored as a
-- proposal on the run and executed only after the owner approves it in the app
-- (services/routinen.py, routers/routinen.py).
-- Notifications ("Meldungen") are what the shell's bell shows in a deployment
-- without a push service.
--
-- All three tables are born with row-level security like claraos_jobs (041):
-- a permissive base policy plus the RESTRICTIVE owner policy `nutzer_eigen`
-- (restrictive alone admits nothing). The scheduler reads across users through the
-- plain pool; every user-facing path goes through database.user_tx.
-- Idempotent.

CREATE TABLE IF NOT EXISTS claraos_routinen (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username    TEXT NOT NULL,
    titel       TEXT NOT NULL,
    auftrag     TEXT NOT NULL,
    rhythmus    TEXT NOT NULL CHECK (rhythmus IN ('taeglich', 'werktags', 'woechentlich', 'stuendlich')),
    uhrzeit     TEXT NOT NULL DEFAULT '07:00' CHECK (uhrzeit ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    wochentag   SMALLINT CHECK (wochentag BETWEEN 0 AND 6),        -- 0 = Monday
    aktiv       BOOLEAN NOT NULL DEFAULT TRUE,
    letzter_lauf TIMESTAMPTZ,
    erstellt    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claraos_routinen_user ON claraos_routinen (username);

CREATE TABLE IF NOT EXISTS claraos_routine_laeufe (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    routine_id  UUID NOT NULL REFERENCES claraos_routinen(id) ON DELETE CASCADE,
    username    TEXT NOT NULL,
    gestartet   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    beendet     TIMESTAMPTZ,
    status      TEXT NOT NULL DEFAULT 'laeuft'
                CHECK (status IN ('laeuft', 'fertig', 'wartet', 'fehler', 'erledigt')),
    ergebnis    TEXT,
    -- [{"modul", "werkzeug", "argumente", "status": offen|ausgefuehrt|verworfen|fehler, "antwort"}]
    vorschlaege JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_claraos_routine_laeufe_routine ON claraos_routine_laeufe (routine_id, gestartet DESC);

CREATE TABLE IF NOT EXISTS claraos_meldungen (
    id          BIGSERIAL PRIMARY KEY,
    username    TEXT NOT NULL,
    erstellt    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    titel       TEXT NOT NULL,
    text        TEXT NOT NULL DEFAULT '',
    app         TEXT,                -- tile to open on click
    gelesen     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_claraos_meldungen_user ON claraos_meldungen (username, erstellt DESC);

DO $$
DECLARE
    t TEXT;
    ausdruck CONSTANT TEXT := 'username = current_setting(''app.user'', true)';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claraos_app') THEN
        RAISE NOTICE '044: role claraos_app missing (041 not applied) — policies skipped';
        RETURN;
    END IF;
    FOREACH t IN ARRAY ARRAY['claraos_routinen', 'claraos_routine_laeufe', 'claraos_meldungen']
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
    GRANT USAGE, SELECT ON SEQUENCE claraos_meldungen_id_seq TO claraos_app;
END $$;
