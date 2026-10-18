-- 043: Row-level security with role `claraos_app`, stage 3 — assistants and devices.
--
-- Same mechanism as 041/042 (read the 041 header first): the API connects as a
-- superuser, RLS only bites inside database.user_tx / user_db / system_tx, which
-- switch into `claraos_app` (NOSUPERUSER NOBYPASSRLS). Stage 2 left these tables
-- out because their rules are not "owner only":
--   * an admin sees and manages every assistant and every device,
--   * assistants can be shared read-only through their `acl`,
--   * background jobs (cron triggers, the effectiveness check, runs fired after
--     an approval, webhook triggers of the admin assistant) act for every owner
--     without a signed-in user.
--
-- So the policies here need two more facts besides `app.user`. They travel in
-- the transaction-local GUC `app.rolle`, set ONLY by database.py:
--   'admin'   database.rolle_fuer(user) — from the verified identity of
--             auth.get_current_user (Authentik group via the proxy secret, or the
--             service token). Never from request data. Requires app.user too.
--   'system'  database.system_tx(zweck) — explicit background context, no user.
--             It opens ONLY the tables of this migration (all 041/042 policies
--             compare app.user, which system_tx leaves unset ⇒ zero rows there).
-- Without app.user and app.rolle every policy below is false (fail-closed).
--
-- Rules mirrored from routers/assistants.py (_require_access), routers/devices.py
-- and the optional device routers:
--   assistants          read: owner, acl reader, admin, system
--                       insert: owner = acting user · update/delete: owner, admin
--   tools, triggers     read: like the assistant · write: owner, admin (not system:
--                       no background job edits them, the webhook path must not)
--   runs, incidents     read: like the assistant · write: owner, admin, system
--   run_events          read: like the run · insert: owner, admin, system ·
--                       NO update/delete grant at all (append-only audit trail)
--   memory_blocks       read: own scope, readers of an assistant of that scope,
--                       admin, system · write: own scope (and, for a per-assistant
--                       block, write access to that assistant), admin, system
--   devices             read: owner, admin, system (voice path) · write: admin only
--   device_jobs         read/update: own jobs, admin · insert: own job on a device
--                       the user can see · no delete grant
--
-- Plus one tightening from the knowledge audit (create_from_template):
--   claraos_kb_collection_items INSERT now requires WRITE access to the
--   collection (owner or 'write' share), as every code path already checks.
--   042 allowed "collection visible OR object visible" — so anyone could hang
--   their own object into a collection they could only read. Re-running 042
--   alone restores the wider rule; setup.sh applies 041→042→043 in order.
--
-- Paths that deliberately stay on the plain pool (superuser): table creation
-- (assistants._ensure_tables incl. the seed row of assistant #0).
--
-- Idempotent. Tables that do not exist are skipped.
-- Reverse: down/043_app_rolle_etappe3.sql (outside the migrations/*.sql glob).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claraos_app') THEN
        CREATE ROLE claraos_app NOLOGIN NOSUPERUSER NOBYPASSRLS
                                NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO claraos_app;

-- ── Context helpers (read GUCs only; no table access) ───────────────────────
CREATE OR REPLACE FUNCTION claraos_app_akteur() RETURNS text
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.user', true), '') $$;

-- Strictly true/false, never NULL: a GUC that was never set in the session
-- reads as NULL, and `NOT NULL` would lock out the owner in "NOT system" rules.
-- admin needs a named acting user as well: a bare app.rolle is not enough.
CREATE OR REPLACE FUNCTION claraos_app_admin() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT COALESCE(NULLIF(current_setting('app.user', true), '') IS NOT NULL
                          AND current_setting('app.rolle', true) = 'admin', false) $$;

CREATE OR REPLACE FUNCTION claraos_app_system() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT COALESCE(current_setting('app.rolle', true) = 'system', false) $$;

-- ── Cross-table checks (SECURITY DEFINER: no recursion through RLS) ─────────
-- They read the acting user themselves (no user parameter = no oracle for
-- other users) and are executable only by claraos_app.
CREATE OR REPLACE FUNCTION claraos_assistent_lesbar(aid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_app_system() OR claraos_app_admin() OR (
        claraos_app_akteur() IS NOT NULL AND EXISTS (
            SELECT 1 FROM claraos_assistants a
            WHERE a.id = aid
              AND (a.owner = claraos_app_akteur()
                   OR a.acl @> jsonb_build_array(jsonb_build_object('user', claraos_app_akteur())))))
$$;

CREATE OR REPLACE FUNCTION claraos_assistent_schreibbar(aid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_app_system() OR claraos_app_admin() OR (
        claraos_app_akteur() IS NOT NULL AND EXISTS (
            SELECT 1 FROM claraos_assistants a
            WHERE a.id = aid AND a.owner = claraos_app_akteur()))
$$;

CREATE OR REPLACE FUNCTION claraos_assistent_lauf_lesbar(rid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT EXISTS (SELECT 1 FROM claraos_assistant_runs r
                   WHERE r.id = rid AND claraos_assistent_lesbar(r.assistant_id))
$$;

CREATE OR REPLACE FUNCTION claraos_assistent_lauf_schreibbar(rid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT EXISTS (SELECT 1 FROM claraos_assistant_runs r
                   WHERE r.id = rid AND claraos_assistent_schreibbar(r.assistant_id))
$$;

-- shared memory blocks (assistant_id NULL) of `scope`: readable by readers of
-- any assistant of that owner (list_memory shows them next to the own blocks)
CREATE OR REPLACE FUNCTION claraos_assistent_scope_lesbar(scope text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_app_akteur() IS NOT NULL AND (
        scope = claraos_app_akteur() OR EXISTS (
            SELECT 1 FROM claraos_assistants a
            WHERE a.owner = scope
              AND a.acl @> jsonb_build_array(jsonb_build_object('user', claraos_app_akteur()))))
$$;

CREATE OR REPLACE FUNCTION claraos_geraet_sichtbar(did uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_app_admin() OR (
        claraos_app_akteur() IS NOT NULL AND EXISTS (
            SELECT 1 FROM claraos_devices d
            WHERE d.id = did AND d.owner = claraos_app_akteur()))
$$;

DO $$
DECLARE
    f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'claraos_assistent_lesbar(uuid)', 'claraos_assistent_schreibbar(uuid)',
        'claraos_assistent_lauf_lesbar(uuid)', 'claraos_assistent_lauf_schreibbar(uuid)',
        'claraos_assistent_scope_lesbar(text)', 'claraos_geraet_sichtbar(uuid)']
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO claraos_app', f);
    END LOOP;
END $$;

-- ── Tables: RLS on, tenant layer, grants ────────────────────────────────────
DO $$
DECLARE
    eintrag TEXT[];
    t TEXT;
    seq RECORD;
BEGIN
    -- {table, privileges for claraos_app}
    FOREACH eintrag SLICE 1 IN ARRAY ARRAY[
        ['claraos_assistants',              'SELECT, INSERT, UPDATE, DELETE'],
        ['claraos_assistant_tools',         'SELECT, INSERT, UPDATE, DELETE'],
        ['claraos_assistant_triggers',      'SELECT, INSERT, UPDATE, DELETE'],
        ['claraos_assistant_runs',          'SELECT, INSERT, UPDATE, DELETE'],
        ['claraos_assistant_run_events',    'SELECT, INSERT'],
        ['claraos_assistant_memory_blocks', 'SELECT, INSERT, UPDATE, DELETE'],
        ['claraos_assistant_incidents',     'SELECT, INSERT, UPDATE, DELETE'],
        ['claraos_devices',                 'SELECT, INSERT, UPDATE, DELETE'],
        ['claraos_device_jobs',             'SELECT, INSERT, UPDATE']
    ]
    LOOP
        t := eintrag[1];
        IF to_regclass(t) IS NULL THEN
            RAISE NOTICE '043: table % missing — skipped', t;
            CONTINUE;
        END IF;
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1', t);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        -- RESTRICTIVE policies only narrow what a PERMISSIVE one grants.
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = t::regclass AND polpermissive) THEN
            EXECUTE format(
                'CREATE POLICY tenant_isolation ON %I '
                'USING (tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint) '
                'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint)',
                t);
        END IF;
        -- exact privilege set (a re-run after a change must also take away)
        EXECUTE format('REVOKE ALL ON %I FROM claraos_app', t);
        EXECUTE format('GRANT %s ON %I TO claraos_app', eintrag[2], t);
        FOR seq IN
            SELECT s.relname
            FROM pg_depend d
            JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
            WHERE d.refobjid = t::regclass AND d.deptype IN ('a', 'i')
        LOOP
            EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO claraos_app', seq.relname);
        END LOOP;
    END LOOP;
END $$;

-- ── Policies ────────────────────────────────────────────────────────────────
-- One entry per policy: table, name, command, USING, WITH CHECK. All RESTRICTIVE.
DO $$
DECLARE
    sys CONSTANT TEXT := 'claraos_app_system()';
    adm CONSTANT TEXT := 'claraos_app_admin()';
    ich CONSTANT TEXT := 'claraos_app_akteur()';
    p RECORD;
BEGIN
    FOR p IN SELECT * FROM (VALUES
        -- assistants
        ('claraos_assistants', 'nutzer_lesen', 'SELECT',
            sys || ' OR ' || adm || ' OR (' || ich || ' IS NOT NULL AND (owner = ' || ich
                || ' OR acl @> jsonb_build_array(jsonb_build_object(''user'', ' || ich || '))))', NULL),
        ('claraos_assistants', 'nutzer_anlegen', 'INSERT', NULL,
            ich || ' IS NOT NULL AND owner = ' || ich),
        ('claraos_assistants', 'nutzer_aendern', 'UPDATE',
            adm || ' OR (' || ich || ' IS NOT NULL AND owner = ' || ich || ')',
            adm || ' OR (' || ich || ' IS NOT NULL AND owner = ' || ich || ')'),
        ('claraos_assistants', 'nutzer_loeschen', 'DELETE',
            adm || ' OR (' || ich || ' IS NOT NULL AND owner = ' || ich || ')', NULL),
        -- tools and triggers: configuration, never written by a background job
        ('claraos_assistant_tools', 'nutzer_lesen', 'SELECT', 'claraos_assistent_lesbar(assistant_id)', NULL),
        ('claraos_assistant_tools', 'nutzer_anlegen', 'INSERT', NULL,
            'NOT ' || sys || ' AND claraos_assistent_schreibbar(assistant_id)'),
        ('claraos_assistant_tools', 'nutzer_aendern', 'UPDATE',
            'NOT ' || sys || ' AND claraos_assistent_schreibbar(assistant_id)',
            'NOT ' || sys || ' AND claraos_assistent_schreibbar(assistant_id)'),
        ('claraos_assistant_tools', 'nutzer_loeschen', 'DELETE',
            'NOT ' || sys || ' AND claraos_assistent_schreibbar(assistant_id)', NULL),
        ('claraos_assistant_triggers', 'nutzer_lesen', 'SELECT', 'claraos_assistent_lesbar(assistant_id)', NULL),
        ('claraos_assistant_triggers', 'nutzer_anlegen', 'INSERT', NULL,
            'NOT ' || sys || ' AND claraos_assistent_schreibbar(assistant_id)'),
        ('claraos_assistant_triggers', 'nutzer_aendern', 'UPDATE',
            'NOT ' || sys || ' AND claraos_assistent_schreibbar(assistant_id)',
            'NOT ' || sys || ' AND claraos_assistent_schreibbar(assistant_id)'),
        ('claraos_assistant_triggers', 'nutzer_loeschen', 'DELETE',
            'NOT ' || sys || ' AND claraos_assistent_schreibbar(assistant_id)', NULL),
        -- runs and incidents: also written by the background jobs
        ('claraos_assistant_runs', 'nutzer_lesen', 'SELECT', 'claraos_assistent_lesbar(assistant_id)', NULL),
        ('claraos_assistant_runs', 'nutzer_anlegen', 'INSERT', NULL, 'claraos_assistent_schreibbar(assistant_id)'),
        ('claraos_assistant_runs', 'nutzer_aendern', 'UPDATE',
            'claraos_assistent_schreibbar(assistant_id)', 'claraos_assistent_schreibbar(assistant_id)'),
        ('claraos_assistant_runs', 'nutzer_loeschen', 'DELETE', 'claraos_assistent_schreibbar(assistant_id)', NULL),
        ('claraos_assistant_incidents', 'nutzer_lesen', 'SELECT', 'claraos_assistent_lesbar(assistant_id)', NULL),
        ('claraos_assistant_incidents', 'nutzer_anlegen', 'INSERT', NULL, 'claraos_assistent_schreibbar(assistant_id)'),
        ('claraos_assistant_incidents', 'nutzer_aendern', 'UPDATE',
            'claraos_assistent_schreibbar(assistant_id)', 'claraos_assistent_schreibbar(assistant_id)'),
        ('claraos_assistant_incidents', 'nutzer_loeschen', 'DELETE', 'claraos_assistent_schreibbar(assistant_id)', NULL),
        -- run events: append-only (no UPDATE/DELETE grant)
        ('claraos_assistant_run_events', 'nutzer_lesen', 'SELECT', 'claraos_assistent_lauf_lesbar(run_id)', NULL),
        ('claraos_assistant_run_events', 'nutzer_anlegen', 'INSERT', NULL, 'claraos_assistent_lauf_schreibbar(run_id)'),
        -- memory blocks
        ('claraos_assistant_memory_blocks', 'nutzer_lesen', 'SELECT',
            sys || ' OR ' || adm || ' OR (CASE WHEN assistant_id IS NULL'
                || ' THEN claraos_assistent_scope_lesbar(scope_user)'
                || ' ELSE claraos_assistent_lesbar(assistant_id) END)', NULL),
        ('claraos_assistant_memory_blocks', 'nutzer_anlegen', 'INSERT', NULL,
            sys || ' OR ' || adm || ' OR (' || ich || ' IS NOT NULL AND scope_user = ' || ich
                || ' AND (assistant_id IS NULL OR claraos_assistent_schreibbar(assistant_id)))'),
        ('claraos_assistant_memory_blocks', 'nutzer_aendern', 'UPDATE',
            sys || ' OR ' || adm || ' OR (' || ich || ' IS NOT NULL AND scope_user = ' || ich
                || ' AND (assistant_id IS NULL OR claraos_assistent_schreibbar(assistant_id)))',
            sys || ' OR ' || adm || ' OR (' || ich || ' IS NOT NULL AND scope_user = ' || ich
                || ' AND (assistant_id IS NULL OR claraos_assistent_schreibbar(assistant_id)))'),
        ('claraos_assistant_memory_blocks', 'nutzer_loeschen', 'DELETE',
            sys || ' OR ' || adm || ' OR (' || ich || ' IS NOT NULL AND scope_user = ' || ich
                || ' AND (assistant_id IS NULL OR claraos_assistent_schreibbar(assistant_id)))', NULL),
        -- devices: defining what can be switched remotely is an admin decision
        ('claraos_devices', 'nutzer_lesen', 'SELECT',
            sys || ' OR ' || adm || ' OR (' || ich || ' IS NOT NULL AND owner = ' || ich || ')', NULL),
        ('claraos_devices', 'nutzer_anlegen', 'INSERT', NULL, adm),
        ('claraos_devices', 'nutzer_aendern', 'UPDATE', adm, adm),
        ('claraos_devices', 'nutzer_loeschen', 'DELETE', adm, NULL),
        -- device jobs: the audit of who switched what
        ('claraos_device_jobs', 'nutzer_lesen', 'SELECT',
            adm || ' OR (' || ich || ' IS NOT NULL AND username = ' || ich || ')', NULL),
        ('claraos_device_jobs', 'nutzer_anlegen', 'INSERT', NULL,
            ich || ' IS NOT NULL AND username = ' || ich
                || ' AND (device_id IS NULL OR claraos_geraet_sichtbar(device_id))'),
        ('claraos_device_jobs', 'nutzer_aendern', 'UPDATE',
            adm || ' OR (' || ich || ' IS NOT NULL AND username = ' || ich || ')',
            adm || ' OR (' || ich || ' IS NOT NULL AND username = ' || ich || ')')
    ) AS v(tab, name, cmd, using_, check_)
    LOOP
        IF to_regclass(p.tab) IS NULL THEN
            CONTINUE;
        END IF;
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p.name, p.tab);
        EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR %s', p.name, p.tab, p.cmd)
             || CASE WHEN p.using_ IS NOT NULL THEN ' USING (' || p.using_ || ')' ELSE '' END
             || CASE WHEN p.check_ IS NOT NULL THEN ' WITH CHECK (' || p.check_ || ')' ELSE '' END;
    END LOOP;
END $$;

-- ── Knowledge: hanging an object into a collection needs WRITE access ───────
DO $$
BEGIN
    IF to_regclass('claraos_kb_collection_items') IS NOT NULL
       AND to_regprocedure('claraos_kb_coll_schreiben(uuid)') IS NOT NULL THEN
        DROP POLICY IF EXISTS nutzer_anlegen ON claraos_kb_collection_items;
        CREATE POLICY nutzer_anlegen ON claraos_kb_collection_items AS RESTRICTIVE FOR INSERT
            WITH CHECK (claraos_kb_akteur() IS NOT NULL
                        AND claraos_kb_coll_schreiben(collection_id));
    ELSE
        RAISE NOTICE '043: knowledge tables or 042 helpers missing — collection rule skipped';
    END IF;
END $$;
