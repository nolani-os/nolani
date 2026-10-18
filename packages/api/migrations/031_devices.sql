-- 031: device hub — controllable devices + action jobs.
--
-- Distinction from the existing table: `claraos_network_devices` (network.py) is
-- the ADMIN INVENTORY (what is visible on the network). This table is the
-- USER VIEW (what can I operate) — a device can appear in both, linked via
-- match_mac/match_ip. They are kept separate on purpose: the inventory may
-- be full of scan noise, the hub must not be.
--
-- Sources (source):
--   '<hub>'         — entity synced from a smart-home hub (smart plugs, later
--                     media players). external_id = entity_id.
--   'manual'        — created by hand (wake-up host, printer).
--   'adhoc'         — found by a phone on a foreign network,
--                     only lives as long as network_fingerprint matches.
--
-- capabilities: JSONB list of allowed actions, e.g.
--   ["power.on","power.off","outlet.on","outlet.off","media.play_url"]
-- The list is the AUTHORITY for /devices/{id}/action — if an action is not
-- in it, the router rejects with 400 (no pass-through to connectors).

CREATE TABLE IF NOT EXISTS claraos_devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       BIGINT NOT NULL DEFAULT 1,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'other',   -- computer|tv|speaker|printer|outlet|other
    source          TEXT NOT NULL DEFAULT 'manual',  -- <hub>|manual|adhoc
    external_id     TEXT,                            -- hub entity_id or similar
    connector       TEXT NOT NULL,                   -- name of a device connector (e.g. ipp, companion)
    capabilities    JSONB NOT NULL DEFAULT '[]'::jsonb,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- mac, ssh_user, host, gate_entity …
    -- Link into the network inventory (network.py) — a hint only, no FK:
    -- the inventory is rescanned and may lose rows.
    match_mac       TEXT,
    match_ip        TEXT,
    -- Visibility: 'household' = all household members, 'private' = owner only.
    visibility      TEXT NOT NULL DEFAULT 'household',
    owner           TEXT,                            -- username when visibility='private'
    -- Ad-hoc devices: only valid while the phone is on the same network.
    ephemeral       BOOLEAN NOT NULL DEFAULT FALSE,
    network_fingerprint TEXT,
    -- Operational state (from the last sync/probe), display only.
    last_state      TEXT,
    last_seen       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A hub entity may appear only ONCE in the device hub (sync upserts on this).
CREATE UNIQUE INDEX IF NOT EXISTS claraos_devices_ext_uniq
    ON claraos_devices (tenant_id, source, external_id)
    WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS claraos_devices_tenant_idx
    ON claraos_devices (tenant_id, kind);

ALTER TABLE claraos_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE claraos_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON claraos_devices;
CREATE POLICY tenant_isolation ON claraos_devices
    USING (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint);


-- Action jobs: every action is logged, even ones that complete immediately.
-- Reason: "who switched off a server's power" must be traceable, and slow
-- recipes (wake-up + waiting for SSH) need a status to poll.
CREATE TABLE IF NOT EXISTS claraos_device_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       BIGINT NOT NULL DEFAULT 1,
    device_id       UUID REFERENCES claraos_devices(id) ON DELETE CASCADE,
    username        TEXT NOT NULL,
    action          TEXT NOT NULL,
    params          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed|denied
    detail          TEXT NOT NULL DEFAULT '',
    confirm_id      TEXT,                              -- claraos_confirm_requests.id
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS claraos_device_jobs_dev_idx
    ON claraos_device_jobs (tenant_id, device_id, created_at DESC);

ALTER TABLE claraos_device_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE claraos_device_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON claraos_device_jobs;
CREATE POLICY tenant_isolation ON claraos_device_jobs
    USING (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('claraos.tenant_id', true), ''), '1')::bigint);
