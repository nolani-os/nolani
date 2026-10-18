-- 024: Assistant app — assistant registry
-- Assistant = declarative entity: persona + tools (workflows/tool bridge) + triggers +
-- heartbeat + autonomy matrix + budget. Runs are the central execution entity
-- (with a taint level against prompt injection); run_events is append-only (audit).
-- Note: routers/assistants.py has an idempotent _ensure_tables() as a safety net —
-- this file is the canonical reference for applying it manually on deploy.

CREATE TABLE IF NOT EXISTS claraos_assistants (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner             TEXT NOT NULL,
    name              TEXT NOT NULL,
    slug              TEXT NOT NULL UNIQUE,
    icon              TEXT NOT NULL DEFAULT '🤖',
    instructions      TEXT NOT NULL DEFAULT '',
    model_tier        TEXT NOT NULL DEFAULT 'cheap'
                      CHECK (model_tier IN ('cheap', 'premium')),
    -- Autonomy matrix: action class → auto|ask|deny
    -- Classes: read, write_internal, external, system
    autonomy          JSONB NOT NULL DEFAULT
                      '{"read":"auto","write_internal":"ask","external":"deny","system":"deny"}',
    -- Intern model: 'intern' = everything only as a draft / with approval
    status            TEXT NOT NULL DEFAULT 'intern'
                      CHECK (status IN ('intern', 'active', 'paused')),
    budget_monthly_eur NUMERIC(8,2) NOT NULL DEFAULT 5.00,
    budget_soft_pct   INT NOT NULL DEFAULT 80,
    -- Provisioned references (NEVER return them via the API):
    litellm_key_ref   TEXT,
    authentik_user_pk INT,
    heartbeat         JSONB NOT NULL DEFAULT
                      '{"enabled": false, "interval_minutes": 60, "checklist": ""}',
    -- Write boundaries + stop rules (structured guardrails, workspace-agents pattern)
    boundaries        JSONB NOT NULL DEFAULT '{"write": [], "stop_rules": []}',
    acl               JSONB NOT NULL DEFAULT '[]',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assistants_owner ON claraos_assistants (owner);

CREATE TABLE IF NOT EXISTS claraos_assistant_tools (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assistant_id  UUID NOT NULL REFERENCES claraos_assistants(id) ON DELETE CASCADE,
    -- tool_ref: "<bridge>:<tool>" | "<workflow engine>:<workflow-id-or-mcp-tool>"
    tool_ref      TEXT NOT NULL,
    when_to_use   TEXT NOT NULL,
    -- the tool's action class (for the matrix) + explicit override
    action_class  TEXT NOT NULL DEFAULT 'read'
                  CHECK (action_class IN ('read', 'write_internal', 'external', 'system')),
    approval_mode TEXT NOT NULL DEFAULT 'inherit'
                  CHECK (approval_mode IN ('inherit', 'auto', 'ask', 'deny')),
    max_auto_runs INT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (assistant_id, tool_ref)
);

CREATE TABLE IF NOT EXISTS claraos_assistant_triggers (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assistant_id       UUID NOT NULL REFERENCES claraos_assistants(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL
                       CHECK (kind IN ('cron', 'webhook', 'event', 'heartbeat')),
    schedule           TEXT,          -- cron expression (kind=cron)
    event_key          TEXT,          -- internal event name (kind=event)
    -- trigger = pre-written message to the assistant (Gumloop pattern)
    prompt_template    TEXT NOT NULL DEFAULT '',
    extra_instructions TEXT NOT NULL DEFAULT '',
    -- external webhook content is untrusted by default (taint model)
    taint              TEXT NOT NULL DEFAULT 'semi'
                       CHECK (taint IN ('trusted', 'semi', 'untrusted')),
    enabled            BOOLEAN NOT NULL DEFAULT TRUE,
    webhook_secret     TEXT,
    -- self-trigger (v1): created by the assistant ⇒ requires owner approval
    created_by         TEXT NOT NULL,  -- "user:<name>" | "assistant"
    approved_by        TEXT,           -- required when created_by='assistant'
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assistant_triggers_assistant
    ON claraos_assistant_triggers (assistant_id);

CREATE TABLE IF NOT EXISTS claraos_assistant_runs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assistant_id   UUID NOT NULL REFERENCES claraos_assistants(id) ON DELETE CASCADE,
    trigger_id     UUID REFERENCES claraos_assistant_triggers(id) ON DELETE SET NULL,
    kind           TEXT NOT NULL DEFAULT 'chat'
                   CHECK (kind IN ('chat', 'trigger', 'heartbeat', 'delegation')),
    status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'waiting_approval', 'completed',
                                     'failed', 'cancelled')),
    -- taint only escalates (trusted→semi→untrusted), never back
    taint          TEXT NOT NULL DEFAULT 'trusted'
                   CHECK (taint IN ('trusted', 'semi', 'untrusted')),
    thread_id      TEXT,
    requested_by   TEXT NOT NULL DEFAULT '',  -- user or "clara" (delegation)
    tokens_in      BIGINT NOT NULL DEFAULT 0,
    tokens_out     BIGINT NOT NULL DEFAULT 0,
    cost_eur       NUMERIC(10,4) NOT NULL DEFAULT 0,
    result_summary TEXT,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_assistant_runs_assistant
    ON claraos_assistant_runs (assistant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_runs_status
    ON claraos_assistant_runs (status) WHERE status IN ('running', 'waiting_approval');

-- Append-only audit trail: no UPDATE/DELETE via the API, BIGSERIAL for ordering
CREATE TABLE IF NOT EXISTS claraos_assistant_run_events (
    id       BIGSERIAL PRIMARY KEY,
    run_id   UUID NOT NULL REFERENCES claraos_assistant_runs(id) ON DELETE CASCADE,
    ts       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    kind     TEXT NOT NULL
             CHECK (kind IN ('message', 'tool_call', 'gate', 'approval',
                             'model_call', 'status', 'error')),
    payload  JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON claraos_assistant_run_events (run_id, id);

-- Letta pattern: named memory blocks; assistant_id NULL ⇒ block shared across the user's assistants
CREATE TABLE IF NOT EXISTS claraos_assistant_memory_blocks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_user   TEXT NOT NULL,
    assistant_id UUID REFERENCES claraos_assistants(id) ON DELETE CASCADE,
    label        TEXT NOT NULL,
    value        TEXT NOT NULL DEFAULT '',
    char_limit   INT NOT NULL DEFAULT 4000,
    read_only    BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by   TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_blocks_unique
    ON claraos_assistant_memory_blocks (scope_user, COALESCE(assistant_id, '00000000-0000-0000-0000-000000000000'::uuid), label);
