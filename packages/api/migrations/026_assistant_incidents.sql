-- 026: Assistant — incident memory
-- Standard SRE pattern: deterministic fingerprint + status instead of LLM memory.
-- Known issues create NO new runs; after a fix has been applied, a verify loop
-- checks whether it worked (recurrence ⇒ escalation, never blind
-- repetition). Safety net: routers/assistants.py::_ensure_tables().

CREATE TABLE IF NOT EXISTS claraos_assistant_incidents (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assistant_id     UUID NOT NULL REFERENCES claraos_assistants(id) ON DELETE CASCADE,
    -- "alert:<alertname>:<instance>" (deterministic from Alertmanager labels)
    -- or "topic:<slug>" (stable short identifier from submit_proposal)
    fingerprint      TEXT NOT NULL,
    title            TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'known', 'verify_pending', 'resolved')),
    occurrence_count INT NOT NULL DEFAULT 1,
    first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_diagnosis   TEXT,
    last_run_id      UUID,
    -- known: no new proposal until then (owner's "no" ⇒ default +7 days)
    suppressed_until TIMESTAMPTZ,
    -- verify_pending: when the effectiveness check is due (default +24h)
    verify_after     TIMESTAMPTZ,
    verify_failures  INT NOT NULL DEFAULT 0,
    note             TEXT,
    UNIQUE (assistant_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_assistant_incidents_due
    ON claraos_assistant_incidents (verify_after)
    WHERE status = 'verify_pending';
