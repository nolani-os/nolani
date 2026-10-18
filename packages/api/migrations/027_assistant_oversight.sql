-- 027 — Oversight rework: model per run kind + oversight controls.
-- model_map: {"heartbeat"|"trigger"|"execution"|"question": "cheap"|"premium"};
--   missing keys fall back to model_tier, heartbeat fallback = cheap
--   (routine triage saves money, real analysis runs on the configured tier).
-- oversight: {"trace": "full"|"summary", "plan_required": "always"|"risky_only"};
--   status 'intern' is always full/always server-side and cannot be relaxed.
ALTER TABLE claraos_assistants
    ADD COLUMN IF NOT EXISTS model_map JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS oversight JSONB NOT NULL DEFAULT '{}';
