-- 034: Sync cursor per source and account.
--
-- Why a separate table and not `claraos_contact_sources.sync_token`:
-- that cursor sits on ONE contact. Google's `nextSyncToken`, however, belongs
-- to the whole collection ("what has changed since this point"), not to a
-- single card. Storing it on an arbitrary contact row would mean it disappears
-- as soon as that very contact is permanently deleted — and the next sync
-- silently pulls EVERYTHING again. That is only noticed when it is too late.
--
-- Important: a cursor for a collection belongs to the collection.

CREATE TABLE IF NOT EXISTS claraos_contact_sync (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    owner        TEXT NOT NULL,
    source       TEXT NOT NULL,          -- google | carddav | outlook
    account      TEXT NOT NULL DEFAULT '',
    sync_token   TEXT,                   -- Google's nextSyncToken / Nextcloud synctoken
    last_full    TIMESTAMPTZ,            -- last full sync
    last_run     TIMESTAMPTZ,
    UNIQUE (tenant_id, owner, source, account)
);

-- Same protection as 033: tenant permissive, owner RESTRICTIVE.
-- Warning: permissive would have no effect — Postgres combines permissive policies
--    with OR, and `tenant_isolation` is true for every household member.
DO $$
DECLARE
    tenant_expr TEXT := 'tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint';
    owner_expr  TEXT := 'owner = current_setting(''claraos.actor'', true)';
BEGIN
    EXECUTE 'ALTER TABLE claraos_contact_sync ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE claraos_contact_sync FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON claraos_contact_sync';
    EXECUTE format('CREATE POLICY tenant_isolation ON claraos_contact_sync USING (%s) WITH CHECK (%s)',
                   tenant_expr, tenant_expr);
    EXECUTE 'DROP POLICY IF EXISTS kontakt_eigentuemer ON claraos_contact_sync';
    EXECUTE format('CREATE POLICY kontakt_eigentuemer ON claraos_contact_sync AS RESTRICTIVE '
                   'USING (%s) WITH CHECK (%s)', owner_expr, owner_expr);
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON claraos_contact_sync TO claraos_kontakte';
END $$;
