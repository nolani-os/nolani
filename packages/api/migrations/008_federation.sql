-- Federation partner registry.
--
-- A ClaraOS instance stores its federated partner instances here.
-- The actual wiring (OIDC source / Matrix whitelist / Nextcloud trusted
-- server) is done by the provisioning engine; this table is the
-- registry and status store behind it.

CREATE TABLE IF NOT EXISTS claraos_federation_partners (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL,                      -- display name, e.g. "ClaraOS-Lab"
    base_domain       TEXT NOT NULL UNIQUE,               -- e.g. "lab.example.com"
    authentik_url     TEXT NOT NULL,                      -- https://auth.<base_domain>
    matrix_server     TEXT,                               -- matrix.<base_domain>
    nextcloud_url     TEXT,                               -- https://nextcloud.<base_domain>
    trust_level       TEXT NOT NULL DEFAULT 'partial'
                      CHECK (trust_level IN ('full','partial','per_app')),
    oidc_source_slug  TEXT,                               -- set by the provisioning engine
    status_json       JSONB NOT NULL DEFAULT '{}'::jsonb, -- last status probe (oidc/matrix/nc)
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claraos_federation_domain
    ON claraos_federation_partners(base_domain);
