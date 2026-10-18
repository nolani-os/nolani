-- 013: "Ideas" app — knowledge base: collections + additional system types.
-- Canonical reference; routers/knowledge.py has an idempotent
-- _ensure_tables() as a safety net (pattern of 012).

CREATE TABLE IF NOT EXISTS claraos_kb_collections (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner        TEXT NOT NULL,
    visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','family')),
    name         TEXT NOT NULL,
    icon         TEXT,
    description  TEXT,
    default_type TEXT REFERENCES claraos_kb_types(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_coll_owner ON claraos_kb_collections (owner, visibility);

CREATE TABLE IF NOT EXISTS claraos_kb_collection_items (
    collection_id UUID NOT NULL REFERENCES claraos_kb_collections(id) ON DELETE CASCADE,
    object_id     UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
    position      REAL NOT NULL DEFAULT 0,
    added_by      TEXT NOT NULL,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (collection_id, object_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_coll_items_obj ON claraos_kb_collection_items (object_id);

-- System types with a property schema (kind: text|number|date|select|multi_select|url|checkbox)
INSERT INTO claraos_kb_types (id, name, icon, is_system, prop_schema) VALUES
  ('research', 'Recherche', '🔎', TRUE,
   '[{"key":"quelle","label":"Quelle","kind":"url"},{"key":"bewertung","label":"Bewertung (1-5)","kind":"number"},{"key":"status","label":"Status","kind":"select","options":["offen","gelesen","relevant","verworfen"]}]'),
  ('item', 'Gegenstand', '📦', TRUE,
   '[{"key":"ort","label":"Aufbewahrungsort","kind":"text"},{"key":"wert","label":"Wert (€)","kind":"number"},{"key":"kaufdatum","label":"Kaufdatum","kind":"date"},{"key":"seriennummer","label":"Seriennummer","kind":"text"}]'),
  ('comparison', 'Vergleichs-Option', '⚖️', TRUE,
   '[{"key":"preis","label":"Preis (€)","kind":"number"},{"key":"url","label":"Link","kind":"url"},{"key":"bewertung","label":"Bewertung (1-5)","kind":"number"},{"key":"pro","label":"Pro","kind":"text"},{"key":"contra","label":"Contra","kind":"text"}]'),
  ('trip', 'Reise', '✈️', TRUE,
   '[{"key":"ziel","label":"Ziel","kind":"text"},{"key":"von","label":"Von","kind":"date"},{"key":"bis","label":"Bis","kind":"date"},{"key":"budget","label":"Budget (€)","kind":"number"},{"key":"status","label":"Status","kind":"select","options":["Idee","geplant","gebucht","erledigt"]}]')
ON CONFLICT (id) DO NOTHING;
