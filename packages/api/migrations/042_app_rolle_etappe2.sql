-- 042: Row-level security with role `claraos_app`, stage 2.
--
-- Same mechanism as 041 (read that header first): the API connects as a
-- superuser, so RLS only bites inside database.user_tx / database.user_db,
-- which switch into `claraos_app` (NOSUPERUSER NOBYPASSRLS) and set the GUC
-- `app.user` for the transaction. Every table below gets one RESTRICTIVE
-- policy `nutzer_eigen` (AND-combined with the permissive tenant_isolation):
--     <owner column> = current_setting('app.user', true)
-- Without `app.user` the comparison is NULL ⇒ zero rows (fail-closed).
--
-- Tables, ordered by the damage a leak would do:
--   credentials/tokens  claraos_app_credentials, claraos_oauth_tokens,
--                       claraos_wopi_tokens, claraos_post_bridge_tokens,
--                       claraos_confirm_requests, claraos_confirm_rules
--   personal content    claraos_post_rules, claraos_post_snooze,
--                       claraos_post_verteiler, claraos_inbox_items (owner),
--                       claraos_planner_meta, claraos_planner_worklog,
--                       claraos_planner_reminders
--   devices/automation  claraos_network_devices, claraos_network_host_details,
--                       claraos_network_known_hosts, claraos_network_names,
--                       claraos_network_scan_results, claraos_network_user_mapping,
--                       claraos_routines, claraos_routine_items (via its routine),
--                       claraos_user_apps
--   knowledge (shares!) all 18 claraos_kb_* tables — own block at the end of
--                       this file, policies mirror the sharing rules of
--                       routers/knowledge.py (object/collection shares, family)
--
-- Paths that deliberately stay on the plain pool (superuser, no user RLS) —
-- they either have no user yet, act across users, or are admin-gated:
--   * token/credential lookups that ARE the authentication: post bridge token
--     (post._user_from_token), WOPI access token (wopi._resolve_token),
--     confirm one-time token (confirm_service.decide/get_request/get_status/
--     submit_question), routine webhook token (routines.webhook) and the
--     routines worker (/_internal/*)
--   * background jobs across users: post.snooze_loop (finds due mails, then
--     wakes each user's mails under user_tx), planner_kalender.reminder_loop
--     cleanup, wopi expired-token cleanup, inbox bookkeeping after delivery
--     (_vermerk*), confirm_service.republish_for_run, vw_sync.mark_synced,
--     assistants._planner_run_finish
--   * admin-gated actions on other users' rows: user_admin (apps, invites,
--     deletion), software_center.decide_request, hub.delete_service,
--     network admin mappings, assistants.decide_run (confirm requests of a run)
--   * system/service accounts and directories: teams_admin/teams_guests
--     (bot and admin tokens, guest accounts), planner_kalender._people,
--     post_business._session_verwerfen
--   * knowledge background work: kb_indexer (indexing, reconciler, backfill),
--     kb_analyst.analyze_idea, kpi_collector.run_once, knowledge._post_save
--     and _create_schema
--
-- Idempotent. Tables that do not exist are skipped. The tables a cell creates
-- lazily in code (routers in betriebsprofil.CELL_ROUTERS) are created here
-- first, so a fresh cell gets the policy before the first request.
-- Reverse: down/042_app_rolle_etappe2.sql (outside the migrations/*.sql glob).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claraos_app') THEN
        CREATE ROLE claraos_app NOLOGIN NOSUPERUSER NOBYPASSRLS
                                NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO claraos_app;

-- ── Tables the cell routers create lazily (same definitions as the code) ────
CREATE TABLE IF NOT EXISTS claraos_post_bridge_tokens (
    username     TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    uses         BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS claraos_post_rules (
    username   TEXT PRIMARY KEY,
    rules      JSONB NOT NULL DEFAULT '[]',
    script     TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS claraos_post_snooze (
    username     TEXT NOT NULL,
    email_id     TEXT NOT NULL,
    wake_at      TIMESTAMPTZ NOT NULL,
    mailbox_from TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (username, email_id)
);
CREATE INDEX IF NOT EXISTS idx_post_snooze_wake ON claraos_post_snooze (wake_at);
CREATE TABLE IF NOT EXISTS claraos_post_verteiler (
    username    TEXT NOT NULL,
    name        TEXT NOT NULL,
    mitglieder  JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (username, name)
);
CREATE TABLE IF NOT EXISTS claraos_wopi_tokens (
    token       TEXT PRIMARY KEY,
    username    TEXT NOT NULL,
    source      TEXT NOT NULL,
    path        TEXT NOT NULL,
    file_id     TEXT NOT NULL,
    can_write   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS claraos_planner_reminders (
    username TEXT NOT NULL,
    key      TEXT NOT NULL,
    sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (username, key)
);

-- ── Owner policy, grants, sequences ─────────────────────────────────────────
DO $$
DECLARE
    eintrag TEXT[];
    t TEXT;
    ausdruck TEXT;
    seq RECORD;
BEGIN
    -- {table, owner expression}. Order matters: claraos_routines before
    -- claraos_routine_items (its policy reads the parent under RLS).
    FOREACH eintrag SLICE 1 IN ARRAY ARRAY[
        ['claraos_app_credentials',      'username = current_setting(''app.user'', true)'],
        ['claraos_oauth_tokens',         'username = current_setting(''app.user'', true)'],
        ['claraos_wopi_tokens',          'username = current_setting(''app.user'', true)'],
        ['claraos_post_bridge_tokens',   'username = current_setting(''app.user'', true)'],
        ['claraos_confirm_requests',     'username = current_setting(''app.user'', true)'],
        ['claraos_confirm_rules',        'username = current_setting(''app.user'', true)'],
        ['claraos_post_rules',           'username = current_setting(''app.user'', true)'],
        ['claraos_post_snooze',          'username = current_setting(''app.user'', true)'],
        ['claraos_post_verteiler',       'username = current_setting(''app.user'', true)'],
        ['claraos_inbox_items',          'owner = current_setting(''app.user'', true)'],
        ['claraos_planner_meta',         'username = current_setting(''app.user'', true)'],
        ['claraos_planner_worklog',      'username = current_setting(''app.user'', true)'],
        ['claraos_planner_reminders',    'username = current_setting(''app.user'', true)'],
        ['claraos_network_devices',      'username = current_setting(''app.user'', true)'],
        ['claraos_network_host_details', 'username = current_setting(''app.user'', true)'],
        ['claraos_network_known_hosts',  'username = current_setting(''app.user'', true)'],
        ['claraos_network_names',        'username = current_setting(''app.user'', true)'],
        ['claraos_network_scan_results', 'username = current_setting(''app.user'', true)'],
        ['claraos_network_user_mapping', 'username = current_setting(''app.user'', true)'],
        ['claraos_routines',             'username = current_setting(''app.user'', true)'],
        ['claraos_routine_items',        'EXISTS (SELECT 1 FROM claraos_routines r WHERE r.id = routine_id AND r.username = current_setting(''app.user'', true))'],
        ['claraos_user_apps',            'username = current_setting(''app.user'', true)']
    ]
    LOOP
        t := eintrag[1];
        ausdruck := eintrag[2];
        IF to_regclass(t) IS NULL THEN
            RAISE NOTICE '042: table % missing — skipped', t;
            CONTINUE;
        END IF;
        IF t = 'claraos_routine_items' AND to_regclass('claraos_routines') IS NULL THEN
            RAISE NOTICE '042: claraos_routines missing — claraos_routine_items skipped';
            CONTINUE;
        END IF;
        -- Tenant layer (as 028): a RESTRICTIVE policy alone would deny every
        -- row, it needs a permissive one to narrow down.
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1', t);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = t::regclass
                       AND polname = 'tenant_isolation') THEN
            EXECUTE format(
                'CREATE POLICY tenant_isolation ON %I '
                'USING (tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint) '
                'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint)',
                t);
        END IF;
        EXECUTE format('DROP POLICY IF EXISTS nutzer_eigen ON %I', t);
        -- AS RESTRICTIVE is the core (see 041).
        EXECUTE format('CREATE POLICY nutzer_eigen ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
                       t, ausdruck, ausdruck);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO claraos_app', t);
        -- serial columns: nextval() needs USAGE on the sequence
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


-- ── Knowledge (claraos_kb_*): row-level security for claraos_app ────────────
--
-- Mirrors the visibility rules of routers/knowledge.py (_vis_core, _edit_for,
-- _fetch_coll) in the database. The policies are at least as wide as the code
-- (never narrower), so the application filters stay the first layer and these
-- policies are the net under them.
--
-- Rules mirrored:
--   object visible  = owner OR visibility 'family' OR explicit share
--                     (claraos_kb_shares) OR member of a collection the user
--                     owns or that is shared with them (claraos_kb_collection_shares)
--   object writable = visible (the code narrows further: owner / collection write)
--   object insert   = owner is the acting user; delete (purge) = owner only
--   collection visible = owner OR visibility 'family' OR shared with the user
--   collection update  = owner OR 'write' share; insert/delete = owner
--   child rows (history, comments, attachments, activity, kpi values) follow
--   their object; fields/views follow their collection; links/refs follow
--   either end; favorites are per user; notifications are read by their
--   recipient and may be written by anyone who sees the object.
--   types: readable by every signed-in user (the code looks types up by id
--   without owner filter), writable only by their owner and never system types.
--
-- Cross-table checks run in SECURITY DEFINER functions owned by the migrating
-- superuser: policies that query other RLS tables directly would recurse.
-- They read the acting user themselves (no user parameter = no oracle for
-- other users) and are executable only by claraos_app.
-- Requires the role claraos_app (041). Idempotent; tables may be missing.

CREATE OR REPLACE FUNCTION claraos_kb_akteur() RETURNS text
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.user', true), '') $$;

-- explicit share or collection membership (the non-trivial part of _vis_core)
CREATE OR REPLACE FUNCTION claraos_kb_freigabe(oid_ uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_kb_akteur() IS NOT NULL AND (
        EXISTS (SELECT 1 FROM claraos_kb_shares s
                WHERE s.object_id = oid_ AND s.shared_with = claraos_kb_akteur())
        OR EXISTS (SELECT 1 FROM claraos_kb_collection_items ci
                   JOIN claraos_kb_collections cc ON cc.id = ci.collection_id
                   WHERE ci.object_id = oid_
                     AND (cc.owner = claraos_kb_akteur() OR EXISTS
                          (SELECT 1 FROM claraos_kb_collection_shares cs
                           WHERE cs.collection_id = ci.collection_id
                             AND cs.shared_with = claraos_kb_akteur()))))
$$;

CREATE OR REPLACE FUNCTION claraos_kb_obj_sichtbar(oid_ uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_kb_akteur() IS NOT NULL AND EXISTS (
        SELECT 1 FROM claraos_kb_objects o
        WHERE o.id = oid_
          AND (o.owner = claraos_kb_akteur() OR o.visibility = 'family'
               OR claraos_kb_freigabe(o.id)))
$$;

CREATE OR REPLACE FUNCTION claraos_kb_obj_besitzer(oid_ uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_kb_akteur() IS NOT NULL AND EXISTS (
        SELECT 1 FROM claraos_kb_objects o
        WHERE o.id = oid_ AND o.owner = claraos_kb_akteur())
$$;

CREATE OR REPLACE FUNCTION claraos_kb_coll_zugang(cid_ uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_kb_akteur() IS NOT NULL AND EXISTS (
        SELECT 1 FROM claraos_kb_collections c
        WHERE c.id = cid_
          AND (c.owner = claraos_kb_akteur() OR c.visibility = 'family'
               OR EXISTS (SELECT 1 FROM claraos_kb_collection_shares cs
                          WHERE cs.collection_id = c.id
                            AND cs.shared_with = claraos_kb_akteur())))
$$;

CREATE OR REPLACE FUNCTION claraos_kb_coll_teilnahme(cid_ uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_kb_akteur() IS NOT NULL AND EXISTS (
        SELECT 1 FROM claraos_kb_collection_shares cs
        WHERE cs.collection_id = cid_ AND cs.shared_with = claraos_kb_akteur())
$$;

CREATE OR REPLACE FUNCTION claraos_kb_coll_schreiben(cid_ uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_kb_akteur() IS NOT NULL AND (
        EXISTS (SELECT 1 FROM claraos_kb_collections c
                WHERE c.id = cid_ AND c.owner = claraos_kb_akteur())
        OR EXISTS (SELECT 1 FROM claraos_kb_collection_shares cs
                   WHERE cs.collection_id = cid_ AND cs.shared_with = claraos_kb_akteur()
                     AND cs.permission = 'write'))
$$;

CREATE OR REPLACE FUNCTION claraos_kb_coll_besitzer(cid_ uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT claraos_kb_akteur() IS NOT NULL AND EXISTS (
        SELECT 1 FROM claraos_kb_collections c
        WHERE c.id = cid_ AND c.owner = claraos_kb_akteur())
$$;

-- Page-tree structure across ALL rows (as the code did before RLS): cycle check
-- and sibling positions must also see siblings/descendants the user cannot
-- read, otherwise a move could build a cycle through someone else's page.
-- They return only booleans/sort keys, never content.
CREATE OR REPLACE FUNCTION claraos_kb_ist_nachfahre(wurzel uuid, ziel uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    WITH RECURSIVE down AS (
        SELECT id FROM claraos_kb_objects WHERE parent_id = wurzel
        UNION
        SELECT o.id FROM claraos_kb_objects o JOIN down ON o.parent_id = down.id
    )
    SELECT claraos_kb_akteur() IS NOT NULL AND EXISTS (SELECT 1 FROM down WHERE id = ziel)
$$;

CREATE OR REPLACE FUNCTION claraos_kb_pos_max(eltern uuid, ausser uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT MAX(position) FROM claraos_kb_objects
    WHERE claraos_kb_akteur() IS NOT NULL
      AND parent_id IS NOT DISTINCT FROM eltern AND deleted_at IS NULL
      AND (ausser IS NULL OR id <> ausser)
$$;

CREATE OR REPLACE FUNCTION claraos_kb_pos_naechste(eltern uuid, nach text, ausser uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT MIN(position) FROM claraos_kb_objects
    WHERE claraos_kb_akteur() IS NOT NULL
      AND parent_id IS NOT DISTINCT FROM eltern AND deleted_at IS NULL
      AND position > nach AND (ausser IS NULL OR id <> ausser)
$$;

DO $$
DECLARE
    f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'claraos_kb_freigabe(uuid)', 'claraos_kb_obj_sichtbar(uuid)',
        'claraos_kb_obj_besitzer(uuid)', 'claraos_kb_coll_zugang(uuid)',
        'claraos_kb_coll_teilnahme(uuid)', 'claraos_kb_coll_schreiben(uuid)',
        'claraos_kb_coll_besitzer(uuid)', 'claraos_kb_ist_nachfahre(uuid, uuid)',
        'claraos_kb_pos_max(uuid, uuid)', 'claraos_kb_pos_naechste(uuid, text, uuid)']
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO claraos_app', f);
    END LOOP;
END $$;

-- ── Policies ────────────────────────────────────────────────────────────────
-- One entry per policy: table, policy name, command, USING, WITH CHECK.
-- Every expression starts with "claraos_kb_akteur() IS NOT NULL": without
-- app.user nothing passes, not even 'family' rows (fail-closed).
DO $$
DECLARE
    a CONSTANT TEXT := 'claraos_kb_akteur() IS NOT NULL AND ';
    obj_lesen CONSTANT TEXT := '(owner = claraos_kb_akteur() OR visibility = ''family'' OR claraos_kb_freigabe(id))';
    coll_lesen CONSTANT TEXT := '(owner = claraos_kb_akteur() OR visibility = ''family'' OR claraos_kb_coll_teilnahme(id))';
    p RECORD;
    t TEXT;
    tabellen TEXT[] := ARRAY[
        'claraos_kb_objects', 'claraos_kb_shares', 'claraos_kb_collections',
        'claraos_kb_collection_shares', 'claraos_kb_collection_items', 'claraos_kb_fields',
        'claraos_kb_views', 'claraos_kb_favorites', 'claraos_kb_notifications',
        'claraos_kb_templates', 'claraos_kb_types', 'claraos_kb_history', 'claraos_kb_comments',
        'claraos_kb_attachments', 'claraos_kb_activity', 'claraos_kb_kpi_values',
        'claraos_kb_links', 'claraos_kb_refs'];
BEGIN
    -- table preparation: RLS on, a permissive base policy, grants
    FOREACH t IN ARRAY tabellen LOOP
        IF to_regclass(t) IS NULL THEN
            RAISE NOTICE '042 kb: table % missing — skipped', t;
            CONTINUE;
        END IF;
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1', t);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        -- RESTRICTIVE policies only narrow what a PERMISSIVE one grants;
        -- without any permissive policy the role would see nothing at all.
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = t::regclass AND polpermissive) THEN
            EXECUTE format(
                'CREATE POLICY tenant_isolation ON %I '
                'USING (tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint) '
                'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint)',
                t);
        END IF;
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO claraos_app', t);
    END LOOP;

    FOR p IN SELECT * FROM (VALUES
        -- objects
        ('claraos_kb_objects', 'nutzer_lesen',    'SELECT', obj_lesen, NULL),
        ('claraos_kb_objects', 'nutzer_aendern',  'UPDATE', obj_lesen, obj_lesen),
        ('claraos_kb_objects', 'nutzer_anlegen',  'INSERT', NULL, 'owner = claraos_kb_akteur()'),
        ('claraos_kb_objects', 'nutzer_loeschen', 'DELETE', 'owner = claraos_kb_akteur()', NULL),
        -- object shares: recipient or anyone who sees the object reads; owner writes
        ('claraos_kb_shares', 'nutzer_lesen',  'SELECT',
            '(shared_with = claraos_kb_akteur() OR claraos_kb_obj_sichtbar(object_id))', NULL),
        ('claraos_kb_shares', 'nutzer_anlegen', 'INSERT', NULL, 'claraos_kb_obj_besitzer(object_id)'),
        ('claraos_kb_shares', 'nutzer_aendern', 'UPDATE',
            'claraos_kb_obj_besitzer(object_id)', 'claraos_kb_obj_besitzer(object_id)'),
        ('claraos_kb_shares', 'nutzer_loeschen', 'DELETE', 'claraos_kb_obj_besitzer(object_id)', NULL),
        -- collections
        ('claraos_kb_collections', 'nutzer_lesen',    'SELECT', coll_lesen, NULL),
        ('claraos_kb_collections', 'nutzer_aendern',  'UPDATE',
            'claraos_kb_coll_schreiben(id)', 'claraos_kb_coll_schreiben(id)'),
        ('claraos_kb_collections', 'nutzer_anlegen',  'INSERT', NULL, 'owner = claraos_kb_akteur()'),
        ('claraos_kb_collections', 'nutzer_loeschen', 'DELETE', 'owner = claraos_kb_akteur()', NULL),
        -- collection shares: every member sees who has access; the owner manages;
        -- a member may leave on their own
        ('claraos_kb_collection_shares', 'nutzer_lesen', 'SELECT',
            '(shared_with = claraos_kb_akteur() OR claraos_kb_coll_zugang(collection_id))', NULL),
        ('claraos_kb_collection_shares', 'nutzer_anlegen', 'INSERT', NULL,
            'claraos_kb_coll_besitzer(collection_id)'),
        ('claraos_kb_collection_shares', 'nutzer_aendern', 'UPDATE',
            'claraos_kb_coll_besitzer(collection_id)', 'claraos_kb_coll_besitzer(collection_id)'),
        ('claraos_kb_collection_shares', 'nutzer_loeschen', 'DELETE',
            '(claraos_kb_coll_besitzer(collection_id) OR shared_with = claraos_kb_akteur())', NULL),
        -- collection membership
        ('claraos_kb_collection_items', 'nutzer_lesen', 'SELECT',
            '(claraos_kb_coll_zugang(collection_id) OR claraos_kb_obj_sichtbar(object_id))', NULL),
        ('claraos_kb_collection_items', 'nutzer_anlegen', 'INSERT', NULL,
            '(claraos_kb_coll_zugang(collection_id) OR claraos_kb_obj_sichtbar(object_id))'),
        ('claraos_kb_collection_items', 'nutzer_aendern', 'UPDATE',
            'claraos_kb_coll_zugang(collection_id)', 'claraos_kb_coll_zugang(collection_id)'),
        ('claraos_kb_collection_items', 'nutzer_loeschen', 'DELETE',
            'claraos_kb_coll_zugang(collection_id)', NULL),
        -- fields and views follow their collection
        ('claraos_kb_fields', 'nutzer_eigen', 'ALL',
            'claraos_kb_coll_zugang(collection_id)', 'claraos_kb_coll_zugang(collection_id)'),
        ('claraos_kb_views', 'nutzer_eigen', 'ALL',
            'claraos_kb_coll_zugang(collection_id)', 'claraos_kb_coll_zugang(collection_id)'),
        -- per-user rows
        ('claraos_kb_favorites', 'nutzer_eigen', 'ALL',
            'username = claraos_kb_akteur()', 'username = claraos_kb_akteur()'),
        ('claraos_kb_notifications', 'nutzer_lesen', 'SELECT', 'username = claraos_kb_akteur()', NULL),
        ('claraos_kb_notifications', 'nutzer_aendern', 'UPDATE',
            'username = claraos_kb_akteur()', 'username = claraos_kb_akteur()'),
        ('claraos_kb_notifications', 'nutzer_loeschen', 'DELETE', 'username = claraos_kb_akteur()', NULL),
        -- a commenter notifies the owner/other authors of an object they can see
        ('claraos_kb_notifications', 'nutzer_anlegen', 'INSERT', NULL,
            '(username = claraos_kb_akteur() OR (object_id IS NOT NULL AND claraos_kb_obj_sichtbar(object_id)))'),
        -- templates
        ('claraos_kb_templates', 'nutzer_lesen', 'SELECT',
            '(owner = claraos_kb_akteur() OR visibility = ''family'')', NULL),
        ('claraos_kb_templates', 'nutzer_anlegen', 'INSERT', NULL, 'owner = claraos_kb_akteur()'),
        ('claraos_kb_templates', 'nutzer_aendern', 'UPDATE',
            'owner = claraos_kb_akteur()', 'owner = claraos_kb_akteur()'),
        ('claraos_kb_templates', 'nutzer_loeschen', 'DELETE', 'owner = claraos_kb_akteur()', NULL),
        -- types
        ('claraos_kb_types', 'nutzer_lesen', 'SELECT', 'TRUE', NULL),
        ('claraos_kb_types', 'nutzer_anlegen', 'INSERT', NULL,
            '(owner = claraos_kb_akteur() AND NOT is_system)'),
        ('claraos_kb_types', 'nutzer_aendern', 'UPDATE',
            '(owner = claraos_kb_akteur() AND NOT is_system)', '(owner = claraos_kb_akteur() AND NOT is_system)'),
        ('claraos_kb_types', 'nutzer_loeschen', 'DELETE', '(owner = claraos_kb_akteur() AND NOT is_system)', NULL),
        -- child rows follow their object
        ('claraos_kb_history', 'nutzer_eigen', 'ALL',
            'claraos_kb_obj_sichtbar(object_id)', 'claraos_kb_obj_sichtbar(object_id)'),
        ('claraos_kb_comments', 'nutzer_eigen', 'ALL',
            'claraos_kb_obj_sichtbar(object_id)', 'claraos_kb_obj_sichtbar(object_id)'),
        ('claraos_kb_attachments', 'nutzer_eigen', 'ALL',
            'claraos_kb_obj_sichtbar(object_id)', 'claraos_kb_obj_sichtbar(object_id)'),
        ('claraos_kb_activity', 'nutzer_eigen', 'ALL',
            'claraos_kb_obj_sichtbar(object_id)', 'claraos_kb_obj_sichtbar(object_id)'),
        ('claraos_kb_kpi_values', 'nutzer_eigen', 'ALL',
            'claraos_kb_obj_sichtbar(kpi_id)', 'claraos_kb_obj_sichtbar(kpi_id)'),
        ('claraos_kb_links', 'nutzer_eigen', 'ALL',
            '(claraos_kb_obj_sichtbar(from_id) OR claraos_kb_obj_sichtbar(to_id))',
            '(claraos_kb_obj_sichtbar(from_id) OR claraos_kb_obj_sichtbar(to_id))'),
        ('claraos_kb_refs', 'nutzer_eigen', 'ALL',
            '(claraos_kb_obj_sichtbar(src_object_id) OR claraos_kb_obj_sichtbar(target_object_id))',
            '(claraos_kb_obj_sichtbar(src_object_id) OR claraos_kb_obj_sichtbar(target_object_id))')
    ) AS v(tab, name, cmd, using_, check_)
    LOOP
        IF to_regclass(p.tab) IS NULL THEN
            CONTINUE;
        END IF;
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p.name, p.tab);
        EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR %s', p.name, p.tab, p.cmd)
             || CASE WHEN p.using_ IS NOT NULL THEN ' USING (' || a || p.using_ || ')' ELSE '' END
             || CASE WHEN p.check_ IS NOT NULL THEN ' WITH CHECK (' || a || p.check_ || ')' ELSE '' END;
    END LOOP;
END $$;
