-- 033: Contacts — ClaraOS is the source of truth.
--
-- Model: the ClaraOS table is the SUPERSET. vCard, Google and Outlook are
-- lossy projections of it — not the other way round. Anything that comes from
-- a source and fits no field ends up in `data->'frei'` instead of being
-- discarded.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WARNING: WHY THIS FILE HAS ITS OWN ROLE SWITCH — please read before changing
-- ════════════════════════════════════════════════════════════════════════════
-- Two facts about PostgreSQL that this design accounts for:
--
-- (1) All existing policies are PERMISSIVE (`pg_policy.polpermissive = t`).
--     PostgreSQL combines permissive policies with OR. An additional
--     permissive "owner = me" policy would therefore have NO EFFECT:
--     `tenant_isolation` (tenant_id = 1, true for every household member)
--     alone would already grant access to every row.
--     ⇒ The owner policies here are `AS RESTRICTIVE` (AND combination).
--
-- (2) If the API connects as a SUPERUSER role (`pg_roles.rolsuper = t`),
--     RLS is bypassed completely — even with `FORCE ROW LEVEL SECURITY`:
--     a policy `USING (false)` on a table with ENABLE+FORCE still lets the
--     row be seen. Policies only take effect under a non-superuser role.
--     ⇒ For contacts this is handled explicitly: a dedicated role WITHOUT
--        superuser rights, which the contact store switches into via
--        `SET LOCAL ROLE`. This file changes nothing for the other tables.
--
-- Important: a policy existing is not the same as a policy protecting. A policy
-- that is never evaluated is reassurance, not a barrier.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Role under which contact queries run ────────────────────────────────────
-- NOLOGIN: nobody connects with it, it is only switched into.
-- NOSUPERUSER/NOBYPASSRLS is the whole point — otherwise we are back at (2).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claraos_kontakte') THEN
        CREATE ROLE claraos_kontakte NOLOGIN NOSUPERUSER NOBYPASSRLS
                                     NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END $$;


-- ── 1) The contact itself ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS claraos_contacts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     BIGINT NOT NULL DEFAULT 1,
    owner         TEXT NOT NULL,
    -- The superset (structured contact fields plus `frei` for the rest).
    data          JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Hash over `data` WITHOUT the photo. Basis for "did anything really
    -- change" — without it, a nightly import of thousands of contacts creates
    -- thousands of versions per night and the history becomes useless.
    content_hash  TEXT NOT NULL,
    photo_id      UUID,
    -- 'active' | 'removed'. `removed` is the tombstone: invisible, but the
    -- source rows REMAIN — otherwise the next import would simply recreate it.
    state         TEXT NOT NULL DEFAULT 'active',
    removed_at    TIMESTAMPTZ,
    -- Derived search text (name, company, emails, phones, handles, notes).
    -- Deliberately a COLUMN instead of a mirror table: since ClaraOS is the
    -- source of truth, there is nothing to mirror — only something to derive.
    such_text     TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT contacts_state_chk CHECK (state IN ('active', 'removed'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner_state
    ON claraos_contacts (owner, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON claraos_contacts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_such
    ON claraos_contacts USING GIN (such_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_contacts_data ON claraos_contacts USING GIN (data);


-- ── 2) Version history ──────────────────────────────────────────────────────
-- FULL SNAPSHOT per version, not per-field history: this makes restoring
-- obvious ("take this state"). The PHOTO is NEVER included, only its
-- reference — cards with a photo can be hundreds of KB, almost all photo; fixing a
-- phone number must not cost that much.
CREATE TABLE IF NOT EXISTS claraos_contact_versions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     BIGINT NOT NULL DEFAULT 1,
    owner         TEXT NOT NULL,
    contact_id    UUID NOT NULL REFERENCES claraos_contacts(id) ON DELETE CASCADE,
    seq           INT NOT NULL,
    data          JSONB NOT NULL,
    photo_id      UUID,
    content_hash  TEXT NOT NULL,
    changed_by    TEXT NOT NULL,          -- user or 'import:google'
    changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason        TEXT NOT NULL,          -- bearbeitet|import|zusammengefuehrt|entfernt|wiederhergestellt
    UNIQUE (contact_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_cversions_contact
    ON claraos_contact_versions (contact_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_cversions_tenant ON claraos_contact_versions (tenant_id);


-- ── 3) Source shadow — the building block that sync and history depend on ───
-- `last_seen_payload` is the state the source showed LAST.
-- Without it, two cases look identical on import:
--   A) corrected in ClaraOS, Google still has the old value  -> ignore
--   B) corrected on the phone, arrives via Google            -> accept
-- Comparing by timestamp gets it wrong half the time.
-- Warning: must be recorded from the FIRST import on — it cannot be
-- reconstructed afterwards.
CREATE TABLE IF NOT EXISTS claraos_contact_sources (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         BIGINT NOT NULL DEFAULT 1,
    owner             TEXT NOT NULL,
    contact_id        UUID NOT NULL REFERENCES claraos_contacts(id) ON DELETE CASCADE,
    source            TEXT NOT NULL,      -- google|carddav|outlook|vcf|sim
    account           TEXT NOT NULL DEFAULT '',
    external_id       TEXT NOT NULL,
    last_seen_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen_hash    TEXT NOT NULL DEFAULT '',
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sync_token        TEXT,
    state             TEXT NOT NULL DEFAULT 'linked',   -- linked|source_deleted
    UNIQUE (tenant_id, source, account, external_id)
);
CREATE INDEX IF NOT EXISTS idx_csources_contact ON claraos_contact_sources (contact_id);


-- ── 4) Service handles ──────────────────────────────────────────────────────
-- `klasse` is NOT cosmetic: it decides whether the UI offers "send message"
-- or only "open profile". Making it up would mean promising a capability
-- that does not exist.
CREATE TABLE IF NOT EXISTS claraos_contact_handles (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    owner        TEXT NOT NULL,
    contact_id   UUID NOT NULL REFERENCES claraos_contacts(id) ON DELETE CASCADE,
    service      TEXT NOT NULL,
    handle       TEXT NOT NULL,
    klasse       TEXT NOT NULL DEFAULT 'verweis',   -- foederiert|verweis|bridge
    verifiziert  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (contact_id, service, handle),
    CONSTRAINT handles_klasse_chk CHECK (klasse IN ('foederiert', 'verweis', 'bridge'))
);
CREATE INDEX IF NOT EXISTS idx_chandles_contact ON claraos_contact_handles (contact_id);


-- ── 5) Link contact ↔ ClaraOS user ──────────────────────────────────────────
-- Warning: NEVER link automatically except on an exact match with a
--    VERIFIED email address. A wrong link here does not mean "wrong name",
--    it means someone gains visibility into team content.
CREATE TABLE IF NOT EXISTS claraos_contact_links (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    owner        TEXT NOT NULL,
    contact_id   UUID NOT NULL REFERENCES claraos_contacts(id) ON DELETE CASCADE,
    username     TEXT NOT NULL,
    matched_on   TEXT NOT NULL,          -- email|phone|manual
    confidence   TEXT NOT NULL DEFAULT 'vorschlag',   -- vorschlag|bestaetigt|abgelehnt
    confirmed_by TEXT,
    confirmed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (contact_id, username),
    CONSTRAINT links_conf_chk CHECK (confidence IN ('vorschlag', 'bestaetigt', 'abgelehnt'))
);
CREATE INDEX IF NOT EXISTS idx_clinks_contact ON claraos_contact_links (contact_id);


-- ── 6) Blocking (schema defined ahead of the endpoints) ─────────────────────
-- `enforced` separates honestly: Matrix/Nextcloud/Mastodon we can really
-- block. Facebook/X/LinkedIn we cannot — there we only hide on our side.
-- The UI MUST state the difference, otherwise users believe they are
-- protected where they are not.
CREATE TABLE IF NOT EXISTS claraos_contact_blocks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   BIGINT NOT NULL DEFAULT 1,
    owner       TEXT NOT NULL,
    contact_id  UUID NOT NULL REFERENCES claraos_contacts(id) ON DELETE CASCADE,
    service     TEXT NOT NULL,
    enforced    BOOLEAN NOT NULL DEFAULT FALSE,
    since       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (contact_id, service)
);


-- ── 7) Photos, content-addressed ────────────────────────────────────────────
-- The bytes live in object storage (storage.py, key includes the owner);
-- only the metadata is stored here. Same photo = same sha256 = one row.
CREATE TABLE IF NOT EXISTS claraos_contact_photos (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   BIGINT NOT NULL DEFAULT 1,
    owner       TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    mime        TEXT NOT NULL,
    bytes       INT NOT NULL,
    storage_key TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner, sha256)
);


-- ── 8) Sharing (policy in place before the endpoints exist) ─────────────────
-- Created deliberately up front: adding a security policy later is an
-- opportunity to forget it. Default remains: nothing shared.
CREATE TABLE IF NOT EXISTS claraos_contact_shares (
    contact_id  UUID NOT NULL REFERENCES claraos_contacts(id) ON DELETE CASCADE,
    tenant_id   BIGINT NOT NULL DEFAULT 1,
    owner       TEXT NOT NULL,
    shared_with TEXT NOT NULL,
    permission  TEXT NOT NULL DEFAULT 'read',
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (contact_id, shared_with),
    CONSTRAINT shares_perm_chk CHECK (permission IN ('read', 'write'))
);
CREATE INDEX IF NOT EXISTS idx_cshares_with ON claraos_contact_shares (shared_with);


-- ── 9) Import runs ──────────────────────────────────────────────────────────
-- Separate from version history: "seen, unchanged" is a run event,
-- not a version of the contact.
CREATE TABLE IF NOT EXISTS claraos_contact_imports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    owner        TEXT NOT NULL,
    source       TEXT NOT NULL,
    account      TEXT NOT NULL DEFAULT '',
    started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at  TIMESTAMPTZ,
    gesehen      INT NOT NULL DEFAULT 0,
    neu          INT NOT NULL DEFAULT 0,
    geaendert    INT NOT NULL DEFAULT 0,
    unveraendert INT NOT NULL DEFAULT 0,
    uebersprungen INT NOT NULL DEFAULT 0,
    fehler       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cimports_owner ON claraos_contact_imports (owner, started_at DESC);


-- ════════════════════════════════════════════════════════════════════════════
-- RLS: tenant (permissive, as elsewhere in the codebase) + owner (RESTRICTIVE)
-- ════════════════════════════════════════════════════════════════════════════
-- Fail-closed by design: without the GUC set, `current_setting(...,true)` returns
-- NULL, every comparison becomes NULL, the restrictive policy does not match ⇒ zero
-- rows. Whoever forgets the role switch sees nothing — not everything.

DO $$
DECLARE
    t              TEXT;
    tenant_expr    TEXT := 'tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint';
    -- Owner OR explicitly shared. Thanks to RLS on `claraos_contact_shares`,
    -- the subquery only sees shares TO ME — exactly the right set.
    geteilt_expr   TEXT := '(owner = current_setting(''claraos.actor'', true)'
                        || ' OR EXISTS (SELECT 1 FROM claraos_contact_shares s'
                        || '            WHERE s.contact_id = %I.id'
                        || '              AND s.shared_with = current_setting(''claraos.actor'', true)))';
    kind_expr      TEXT := '(owner = current_setting(''claraos.actor'', true)'
                        || ' OR EXISTS (SELECT 1 FROM claraos_contact_shares s'
                        || '            WHERE s.contact_id = %I.contact_id'
                        || '              AND s.shared_with = current_setting(''claraos.actor'', true)))';
    -- Strictly private: history, blocks, source provenance, import runs, photos.
    -- A share grants the CURRENT state, not the editing trail.
    privat_expr    TEXT := 'owner = current_setting(''claraos.actor'', true)';
    ausdruck       TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'claraos_contacts', 'claraos_contact_versions', 'claraos_contact_sources',
        'claraos_contact_handles', 'claraos_contact_links', 'claraos_contact_blocks',
        'claraos_contact_photos', 'claraos_contact_shares', 'claraos_contact_imports'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)',
                       t, tenant_expr, tenant_expr);

        IF t = 'claraos_contacts' THEN
            ausdruck := format(geteilt_expr, t);
        ELSIF t IN ('claraos_contact_handles', 'claraos_contact_links') THEN
            ausdruck := format(kind_expr, t);
        ELSIF t = 'claraos_contact_shares' THEN
            -- Must not reference itself, otherwise the policy recurses.
            ausdruck := 'owner = current_setting(''claraos.actor'', true)'
                     || ' OR shared_with = current_setting(''claraos.actor'', true)';
        ELSE
            ausdruck := privat_expr;
        END IF;

        EXECUTE format('DROP POLICY IF EXISTS kontakt_eigentuemer ON %I', t);
        -- Important: AS RESTRICTIVE is the core. Permissive would have no effect,
        --    because `tenant_isolation` is OR-ed in and is true for everyone.
        EXECUTE format(
            'CREATE POLICY kontakt_eigentuemer ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
            t, ausdruck, ausdruck);

        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO claraos_kontakte', t);
    END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO claraos_kontakte;
