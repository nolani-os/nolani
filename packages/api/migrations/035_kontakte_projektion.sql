-- 035: Projection into a dedicated Nextcloud address book.
--
-- ClaraOS creates a DEDICATED address book `claraos` per user and is its
-- only writer. The address book fed by Google is never touched.
--
-- Why a separate table and not `claraos_contact_sources`:
-- the source shadow describes what came in from OUTSIDE. This is the
-- opposite — what we wrote out. Keeping both in one table would mean
-- distinguishing two directions by a single field; the first person to mix
-- them up writes an import state back as output and thereby overwrites the
-- source of truth with its own copy.
--
-- Important: `etag` protects against lost updates: we only write if the card
--    on the server is still the one we wrote last. If someone edits the
--    `claraos` address book by hand (which they should not), this gets
--    NOTICED instead of being silently overwritten.

CREATE TABLE IF NOT EXISTS claraos_contact_projection (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     BIGINT NOT NULL DEFAULT 1,
    owner         TEXT NOT NULL,
    contact_id    UUID NOT NULL REFERENCES claraos_contacts(id) ON DELETE CASCADE,
    ziel          TEXT NOT NULL DEFAULT 'nextcloud',
    href          TEXT,                  -- full URL of the card in the address book
    etag          TEXT,                  -- state that WE wrote last
    -- Content that went out last. If it differs from the current contact,
    -- there is work to do — that is the whole sync, no queue needed.
    geschrieben_hash TEXT,
    zuletzt       TIMESTAMPTZ,
    fehler        TEXT,                  -- last failure, visible instead of silent
    UNIQUE (contact_id, ziel)
);

CREATE INDEX IF NOT EXISTS idx_cprojektion_owner
    ON claraos_contact_projection (owner, ziel);

-- Same protection as 033/034: tenant permissive, owner RESTRICTIVE.
DO $$
DECLARE
    tenant_expr TEXT := 'tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint';
    owner_expr  TEXT := 'owner = current_setting(''claraos.actor'', true)';
BEGIN
    EXECUTE 'ALTER TABLE claraos_contact_projection ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE claraos_contact_projection FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON claraos_contact_projection';
    EXECUTE format('CREATE POLICY tenant_isolation ON claraos_contact_projection '
                   'USING (%s) WITH CHECK (%s)', tenant_expr, tenant_expr);
    EXECUTE 'DROP POLICY IF EXISTS kontakt_eigentuemer ON claraos_contact_projection';
    EXECUTE format('CREATE POLICY kontakt_eigentuemer ON claraos_contact_projection '
                   'AS RESTRICTIVE USING (%s) WITH CHECK (%s)', owner_expr, owner_expr);
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON claraos_contact_projection '
            'TO claraos_kontakte';
END $$;
