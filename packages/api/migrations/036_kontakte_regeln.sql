-- 036: Reachability rule per user.
--
-- Requirement: "configurable so that you can only be reached by users who are
-- in the same team or in your own contact list."
--
-- Warning: the rule is a SERVER rule, not a UI setting. If it lived in the
-- frontend, anyone could bypass it with a direct API call.
-- A visible tile is not an authorization.
--
-- Important: it stays honest only if it is clear WHERE it applies: in the channels
-- ClaraOS itself controls (sharing contacts, sharing knowledge). It does not
-- switch off WhatsApp or the phone line. What it cannot do, the UI must say —
-- otherwise users believe they are protected where they are not.

CREATE TABLE IF NOT EXISTS claraos_contact_policy (
    owner        TEXT PRIMARY KEY,
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    -- alle (everyone) | team | team_und_kontakte (team and contacts)
    erreichbar   TEXT NOT NULL DEFAULT 'alle',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT policy_erreichbar_chk
        CHECK (erreichbar IN ('alle', 'team', 'team_und_kontakte'))
);

-- Same protection as 033–035.
DO $$
DECLARE
    tenant_expr TEXT := 'tenant_id = COALESCE(NULLIF(current_setting(''claraos.tenant_id'', true), ''''), ''1'')::bigint';
    owner_expr  TEXT := 'owner = current_setting(''claraos.actor'', true)';
BEGIN
    EXECUTE 'ALTER TABLE claraos_contact_policy ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE claraos_contact_policy FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON claraos_contact_policy';
    EXECUTE format('CREATE POLICY tenant_isolation ON claraos_contact_policy '
                   'USING (%s) WITH CHECK (%s)', tenant_expr, tenant_expr);
    EXECUTE 'DROP POLICY IF EXISTS kontakt_eigentuemer ON claraos_contact_policy';
    EXECUTE format('CREATE POLICY kontakt_eigentuemer ON claraos_contact_policy '
                   'AS RESTRICTIVE USING (%s) WITH CHECK (%s)', owner_expr, owner_expr);
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON claraos_contact_policy '
            'TO claraos_kontakte';
END $$;

-- Warning: the SENDER must be able to read the RECIPIENT's rule — otherwise
-- nobody can check whether they may reach someone. Hence a SECURITY DEFINER
-- function: it returns ONLY the rule, never data.
-- (Without it the sender would need read access to the whole table — and thus
-- also see who else has which rule.)
CREATE OR REPLACE FUNCTION claraos_erreichbarkeit(ziel TEXT)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE((SELECT erreichbar FROM claraos_contact_policy WHERE owner = ziel), 'alle');
$$;

GRANT EXECUTE ON FUNCTION claraos_erreichbarkeit(TEXT) TO claraos_kontakte;

-- Likewise: "is the sender in the recipient's contact list?" The sender must
-- also be able to check this without seeing other users' contacts.
CREATE OR REPLACE FUNCTION claraos_ist_kontakt(ziel TEXT, absender TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM claraos_contact_links l
        JOIN claraos_contacts k ON k.id = l.contact_id
        WHERE k.owner = ziel AND k.state = 'active'
          AND l.username = absender AND l.confidence = 'bestaetigt'
    );
$$;

GRANT EXECUTE ON FUNCTION claraos_ist_kontakt(TEXT, TEXT) TO claraos_kontakte;

-- Third lookup function: "has the recipient explicitly blocked me?"
-- The SENDER must also be able to check this without seeing other users' contacts.
-- Important: returns only yes/no — never WHICH contact is behind it.
CREATE OR REPLACE FUNCTION claraos_ist_geblockt(ziel TEXT, absender TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM claraos_contact_blocks b
        JOIN claraos_contact_links l ON l.contact_id = b.contact_id
        JOIN claraos_contacts k ON k.id = b.contact_id
        WHERE k.owner = ziel AND l.username = absender
          AND l.confidence = 'bestaetigt' AND b.service = 'claraos'
    );
$$;

GRANT EXECUTE ON FUNCTION claraos_ist_geblockt(TEXT, TEXT) TO claraos_kontakte;
