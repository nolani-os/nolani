-- 039: ClaraOS's own presence.
--
-- Requirement: the ClaraOS online status should be the basis for presence. It
-- did not exist. What existed were things easily confused with it:
--   * `claraos_devices`            — the device hub (TVs, plugs)
--   * `claraos_user_browsers`      — `last_seen` of the Selkies containers, i.e.
--                                    when someone used a streamed browser,
--                                    not whether they are in ClaraOS
-- And `PresenceDot` read Matrix presence with a fallback to "offline".
--
-- Important, the rule of this table: **a missing entry means "unknown", not
-- "offline".** Someone who never sent a heartbeat is not away — we simply know
-- nothing about them. The difference is not a subtlety: "offline" keeps
-- people from calling. That is why "unknown" has no symbol at all, not even
-- a grey one.
--
-- The derived state is DELIBERATELY not stored in the table: it depends on the
-- clock and would be stale the moment it is saved. Only what was measured
-- (`zuletzt_gesehen`) and what the person said themselves (`zustand`) is
-- stored.

CREATE TABLE IF NOT EXISTS claraos_praesenz (
    username         TEXT PRIMARY KEY,
    tenant_id        BIGINT NOT NULL DEFAULT 1,

    -- Last heartbeat from an open ClaraOS UI.
    zuletzt_gesehen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Set by the person themselves; overrides the measurement. NULL = automatic.
    -- verfuegbar (available) | beschaeftigt (busy) | nicht_stoeren (do not disturb) | abwesend (away)
    zustand          TEXT,
    -- Expiry of the manual state. NULL = until revoked.
    -- Without an expiry, a "do not disturb" from one evening sticks around
    --    for weeks and nobody dares to write anymore.
    zustand_bis      TIMESTAMPTZ,

    -- Display only ("on phone"), never used for decisions.
    geraet           TEXT,

    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT praesenz_zustand_chk CHECK (
        zustand IS NULL OR zustand IN
        ('verfuegbar', 'beschaeftigt', 'nicht_stoeren', 'abwesend')
    )
);

CREATE INDEX IF NOT EXISTS idx_praesenz_gesehen
    ON claraos_praesenz (zuletzt_gesehen DESC);

-- Tenancy following the basic pattern from 027_tenancy_foundation.sql.
-- Warning: the API role is a superuser and bypasses RLS —
-- the policy is defense in depth, not the actual protection. Who may see whose
-- presence is decided by `services/praesenz.py` via team visibility.
-- Presence is revealing: it exposes daily routines.
ALTER TABLE claraos_praesenz ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'claraos_praesenz' AND policyname = 'tenant_isolation'
    ) THEN
        EXECUTE 'CREATE POLICY tenant_isolation ON claraos_praesenz
                 USING (tenant_id = current_setting(''claraos.tenant_id'', true)::bigint)
                 WITH CHECK (tenant_id = current_setting(''claraos.tenant_id'', true)::bigint)';
    END IF;
END $$;
