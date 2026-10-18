-- 037: Warning: a READ share must not grant write access.
--
-- Problem this fixes: a user with whom a contact was shared could
-- **delete** it. Cause: the policy from migration 033 applied to `ALL`, and its
-- expression was "owner = me OR a share to me exists". For SELECT that is
-- correct — for UPDATE and DELETE it was full authority.
--
-- Important: RLS only distinguishes operations if you tell it to. Writing a
-- policy for `ALL` gives readers the same rights as writers.
--
-- WARNING, a pitfall when fixing this: a RESTRICTIVE policy only applies to the
-- operations it was created for. If one is missing for DELETE, ONLY the
-- permissive `tenant_isolation` applies there — and that is true for every
-- household member. A forgotten operation therefore does not make the table
-- stricter but **open**. That is why a policy is set explicitly here for EACH
-- of the four operations.
--
-- Scope deliberately narrow: only **read** shares are supported. The column
-- `permission` stays for later, but the API currently only accepts
-- `read` — a write share would also need rules for the version history
-- (whose version gets created?), and building that half-finished would be
-- worse than postponing it.

DO $$
DECLARE
    t            TEXT;
    -- Read: owner OR explicit share.
    lesen_karte  TEXT := '(owner = current_setting(''claraos.actor'', true)'
                      || ' OR EXISTS (SELECT 1 FROM claraos_contact_shares s'
                      || '            WHERE s.contact_id = claraos_contacts.id'
                      || '              AND s.shared_with = current_setting(''claraos.actor'', true)))';
    lesen_kind   TEXT := '(owner = current_setting(''claraos.actor'', true)'
                      || ' OR EXISTS (SELECT 1 FROM claraos_contact_shares s'
                      || '            WHERE s.contact_id = %I.contact_id'
                      || '              AND s.shared_with = current_setting(''claraos.actor'', true)))';
    -- Write: ONLY the owner.
    nur_ich      TEXT := 'owner = current_setting(''claraos.actor'', true)';
    lese_ausdruck TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'claraos_contacts', 'claraos_contact_versions', 'claraos_contact_sources',
        'claraos_contact_handles', 'claraos_contact_links', 'claraos_contact_blocks',
        'claraos_contact_photos', 'claraos_contact_imports'
    ] LOOP
        -- Drop the old catch-all policy — it was the source of the excess rights.
        EXECUTE format('DROP POLICY IF EXISTS kontakt_eigentuemer ON %I', t);

        IF t = 'claraos_contacts' THEN
            lese_ausdruck := lesen_karte;
        ELSIF t IN ('claraos_contact_handles', 'claraos_contact_links') THEN
            lese_ausdruck := format(lesen_kind, t);
        ELSE
            -- History, source provenance, blocks, photos, import runs stay
            -- private: a share grants the current state, not the trail.
            lese_ausdruck := nur_ich;
        END IF;

        EXECUTE format('CREATE POLICY kontakt_lesen ON %I AS RESTRICTIVE '
                       'FOR SELECT USING (%s)', t, lese_ausdruck);
        EXECUTE format('CREATE POLICY kontakt_anlegen ON %I AS RESTRICTIVE '
                       'FOR INSERT WITH CHECK (%s)', t, nur_ich);
        EXECUTE format('CREATE POLICY kontakt_aendern ON %I AS RESTRICTIVE '
                       'FOR UPDATE USING (%s) WITH CHECK (%s)', t, nur_ich, nur_ich);
        EXECUTE format('CREATE POLICY kontakt_loeschen ON %I AS RESTRICTIVE '
                       'FOR DELETE USING (%s)', t, nur_ich);
    END LOOP;

    -- Shares themselves: visible to the owner AND the recipient
    -- (otherwise the subquery above cannot find them). Only the owner may
    -- create, change and delete them — otherwise someone could grant
    -- themselves a share.
    EXECUTE 'DROP POLICY IF EXISTS kontakt_eigentuemer ON claraos_contact_shares';
    EXECUTE format('CREATE POLICY kontakt_lesen ON claraos_contact_shares AS RESTRICTIVE '
                   'FOR SELECT USING (%s OR shared_with = current_setting(''claraos.actor'', true))',
                   nur_ich);
    EXECUTE format('CREATE POLICY kontakt_anlegen ON claraos_contact_shares AS RESTRICTIVE '
                   'FOR INSERT WITH CHECK (%s)', nur_ich);
    EXECUTE format('CREATE POLICY kontakt_aendern ON claraos_contact_shares AS RESTRICTIVE '
                   'FOR UPDATE USING (%s) WITH CHECK (%s)', nur_ich, nur_ich);
    EXECUTE format('CREATE POLICY kontakt_loeschen ON claraos_contact_shares AS RESTRICTIVE '
                   'FOR DELETE USING (%s)', nur_ich);
END $$;

-- The tables added later (034/035/036) carry their own owner policy for
-- ALL — there are no shares there, so that is correct. They are deliberately
-- NOT touched here.
