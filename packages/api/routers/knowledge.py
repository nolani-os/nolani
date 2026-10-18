"""Knowledge BFF for the "Ideas" app: idea pipeline + knowledge base.

Own object model in Postgres (claraos_kb_*) instead of a third-party app:
objects with type/properties/stage, typed links, and an append-only activity
log (Clara analyses, follow-up questions, stage changes). Same pattern as
planner.py: identity ALWAYS comes from the trusted headers X-Claraos-User /
X-Authentik-Username (never from LLM args or the body, to prevent
impersonation); the flat /clara/* routes are called by the tools gateway
(clara_tools.py) with X-Claraos-Actor: clara.

Visibility (MVP): 'private' (owner only) | 'family' (everyone reads and
comments, only the owner edits). The central clause _VIS is used everywhere.

Row-level security (migration 042): every request path runs in
`database.user_tx(user)` (role claraos_app + app.user), so the database
enforces the same visibility rules as _VIS/_edit_for underneath the WHERE
clauses. Service paths stay on the plain pool on purpose and are marked:
schema DDL, the post-save pipeline, /health, and the background services
(kb_indexer, kb_analyst, kpi_collector).

RAG: every object is indexed event-driven into the Qdrant collection
claraos_objects (services/kb_indexer.py, BackgroundTask + reconciler).
/clara/search enforces the visibility filter server-side; if embeddings are
unavailable it falls back to tsvector full-text search.
"""
from __future__ import annotations

from domains_generated import BASE_DOMAIN  # setting: CLARAOS_BASE_DOMAIN
from betriebsprofil import heim_default, heim_struktur
import asyncio
import datetime as dt
import json
import logging
import os
import re
import uuid as uuid_mod

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

import httpx

from database import get_pool, user_tx
from services import (kb_analyst, kb_anchor, kb_clip, kb_diff, kb_formula,
                      kb_import, kb_indexer, kb_query, kb_strategist,
                      kaizen_pareto, kpi_collector, kpi_progress, kpi_sources)

from auth import is_service_call, require_caller, service_headers

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/knowledge", tags=["knowledge"])

STAGES = ("spark", "developing", "elaborated", "planned", "done", "archived")
VISIBILITIES = ("private", "family", "shared")
COLL_VISIBILITIES = ("private", "family")  # collections have no 'shared' visibility (MVP)
ACTIVITY_KINDS = ("comment", "analysis", "question", "answer", "stage_change", "edit", "handoff")
LINK_RELS = ("relates_to", "part_of_vision", "inspired_by", "duplicates",
             # Strategy layer: goal→KPI, idea/concept→goal (carries the
             # rating in link.meta), concept→idea or analysis→goal.
             "measured_by", "contributes_to", "derived_from")

# Types of the strategy layer. The goal hierarchy uses parent_id (the page
# tree), not a separate edge kind: re-parenting, sorting and cycle protection
# already exist there.
GOAL_TREE_TYPES = ("vision", "goal")

# What belongs to the "Idea Suite" and does NOT appear in the Knowledge Suite.
# Must match PIPELINE_TYPES in apps/knowledge/KnowledgeApp.tsx: two lists,
# one truth.
IDEA_SUITE_TYPES = ("idea", "vision", "goal", "kpi", "concept", "analysis")

# Visibility enforcement, used everywhere (the user's $-placeholder number varies).
# 'shared' = owner + explicit recipients in claraos_kb_shares.
# Collection shares: claraos_kb_collection_shares, permission read|write.
# An object is also visible if it lives in a collection that the user owns or
# that is shared with them, and editable if they own it or the collection is
# theirs or shared with write permission. The building blocks are generated in
# ONE place because the share condition used to be hand-copied in five places
# (get_object links, ancestors x2, graph) and every extension would have been
# silently missing somewhere.
def _vis_core(prefix: str, u: str) -> str:
    """Only the OR group (without deleted_at), for queries that check that themselves."""
    idref = f"{prefix}id"
    return (f"({prefix}owner = {u} OR {prefix}visibility = 'family' OR EXISTS "
            f"(SELECT 1 FROM claraos_kb_shares _sh WHERE _sh.object_id = {idref} "
            f"AND _sh.shared_with = {u}) OR EXISTS "
            f"(SELECT 1 FROM claraos_kb_collection_items _ci "
            f"JOIN claraos_kb_collections _cc ON _cc.id = _ci.collection_id "
            f"WHERE _ci.object_id = {idref} AND (_cc.owner = {u} OR EXISTS "
            f"(SELECT 1 FROM claraos_kb_collection_shares _cs "
            f"WHERE _cs.collection_id = _ci.collection_id AND _cs.shared_with = {u}))))")


def _vis_for(prefix: str, u: str) -> str:
    return f"{_vis_core(prefix, u)} AND {prefix}deleted_at IS NULL"


def _edit_for(prefix: str, u: str) -> str:
    """Write access: owner OR member of a collection containing the object
    (collection owner or 'write' share)."""
    return (f"({prefix}owner = {u} OR EXISTS "
            f"(SELECT 1 FROM claraos_kb_collection_items _ci "
            f"JOIN claraos_kb_collections _cc ON _cc.id = _ci.collection_id "
            f"LEFT JOIN claraos_kb_collection_shares _cs "
            f"ON _cs.collection_id = _ci.collection_id AND _cs.shared_with = {u} "
            f"WHERE _ci.object_id = {prefix}id AND (_cc.owner = {u} OR _cs.permission = 'write')))")


_VIS = _vis_for("claraos_kb_objects.", "{u}")

_tables_ensured = False

# Warning: without this lock the schema safety net ran SEVERAL TIMES AT ONCE.
# The app fetches four things in parallel on open (objects/collections/types/favorites);
# all four saw `_tables_ensured is False` (the flag is only set at the very end)
# and ran the DDL concurrently. The two DROP/ADD CONSTRAINT pairs further down
# overtook each other, and the loser got `DuplicateObjectError` => HTTP 500 =>
# a red "500 : Internal Server Error" banner on cold start. Not always the same
# request, but every cold start.
# Important: the lock only helps within one process, so the constraint steps
# are additionally idempotent on their own (see below).
_ensure_lock = asyncio.Lock()


async def _ensure_tables():
    """Safety net for deploys without a manual migration. Canonical: migrations/012_knowledge.sql."""
    global _tables_ensured
    if _tables_ensured:
        return
    async with _ensure_lock:
        if _tables_ensured:          # second check: the first caller already finished
            return
        await _create_schema()
        _tables_ensured = True


async def _create_schema():
    """The actual DDL; runs only once per process thanks to `_ensure_lock`."""
    # Service path: schema DDL runs on the plain pool (superuser), not user_tx.
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_types (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                icon        TEXT,
                description TEXT,
                is_system   BOOLEAN NOT NULL DEFAULT FALSE,
                owner       TEXT,
                prop_schema JSONB NOT NULL DEFAULT '[]',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute("""
            INSERT INTO claraos_kb_types (id, name, icon, is_system) VALUES
              ('idea', 'Idee', '💡', TRUE),
              ('vision', 'Vision', '🌅', TRUE),
              ('note', 'Notiz', '📝', TRUE),
              -- S1 Strategie-Schicht (Migration 032)
              ('goal', 'Ziel', '🎯', TRUE),
              ('kpi', 'Kennzahl', '📈', TRUE),
              ('concept', 'Konzept', '🧩', TRUE),
              ('analysis', 'Analyse', '🔍', TRUE)
            ON CONFLICT (id) DO NOTHING
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_objects (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                type        TEXT NOT NULL REFERENCES claraos_kb_types(id),
                owner       TEXT NOT NULL,
                visibility  TEXT NOT NULL DEFAULT 'private',
                title       TEXT NOT NULL,
                body        TEXT NOT NULL DEFAULT '',
                properties  JSONB NOT NULL DEFAULT '{}',
                stage       TEXT CHECK (stage IN ('spark','developing','elaborated','planned','done','archived')),
                created_by  TEXT NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                deleted_at  TIMESTAMPTZ,
                rag_status  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (rag_status IN ('pending','ok','failed','deindex','skip')),
                rag_indexed_at TIMESTAMPTZ,
                search_tsv  tsvector GENERATED ALWAYS AS
                            (to_tsvector('german', coalesce(title,'') || ' ' || coalesce(body,''))) STORED
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_obj_owner_vis ON claraos_kb_objects (owner, visibility) WHERE deleted_at IS NULL")
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_obj_type_stage ON claraos_kb_objects (type, stage) WHERE deleted_at IS NULL")
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_obj_tsv ON claraos_kb_objects USING GIN (search_tsv)")
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_obj_rag ON claraos_kb_objects (rag_status) WHERE rag_status IN ('pending','failed','deindex')")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_links (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                from_id    UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                to_id      UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                rel        TEXT NOT NULL DEFAULT 'relates_to',
                created_by TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (from_id, to_id, rel)
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_links_to ON claraos_kb_links (to_id)")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_activity (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                object_id  UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                actor      TEXT NOT NULL,
                kind       TEXT NOT NULL CHECK (kind IN ('comment','analysis','question','answer','stage_change','edit','handoff')),
                content    TEXT NOT NULL DEFAULT '',
                meta       JSONB NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_activity_obj ON claraos_kb_activity (object_id, created_at)")
        # (014): granular shares + visibility 'shared'.
        # Important: this used to be a bare DROP + ADD, which is dangerous twice over:
        # it leaves a window without a check constraint, and two concurrent runs raise
        # `DuplicateObjectError`. Now only what is wrong gets touched, and a concurrent
        # second run becomes a no-op instead of an error.
        await conn.execute("""
            DO $$
            DECLARE regel text;
            BEGIN
              SELECT pg_get_constraintdef(oid) INTO regel FROM pg_constraint
               WHERE conname = 'claraos_kb_objects_visibility_check'
                 AND conrelid = 'claraos_kb_objects'::regclass;
              IF regel IS NULL THEN
                ALTER TABLE claraos_kb_objects ADD CONSTRAINT claraos_kb_objects_visibility_check
                  CHECK (visibility IN ('private','family','shared'));
              ELSIF regel NOT LIKE '%shared%' THEN
                ALTER TABLE claraos_kb_objects DROP CONSTRAINT claraos_kb_objects_visibility_check;
                ALTER TABLE claraos_kb_objects ADD CONSTRAINT claraos_kb_objects_visibility_check
                  CHECK (visibility IN ('private','family','shared'));
              END IF;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_shares (
                object_id   UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                shared_with TEXT NOT NULL,
                created_by  TEXT NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (object_id, shared_with)
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_shares_user ON claraos_kb_shares (shared_with)")
        # (013): collections + typed system types
        await conn.execute("""
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
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_coll_owner ON claraos_kb_collections (owner, visibility)")
        # (040): collection shares with permission. Canonical: migrations/040_knowledge_collection_shares.sql
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_collection_shares (
                collection_id UUID NOT NULL REFERENCES claraos_kb_collections(id) ON DELETE CASCADE,
                shared_with   TEXT NOT NULL,
                permission    TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read','write')),
                created_by    TEXT NOT NULL,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (collection_id, shared_with)
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_coll_shares_user ON claraos_kb_collection_shares (shared_with)")
        # Free-form field on the collection for things that are neither a view nor a
        # column: row templates and the lock. Important: additive and idempotent, so
        # `_ensure_tables()` can run on every start without ever losing anything.
        await conn.execute(
            "ALTER TABLE claraos_kb_collections "
            "ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_collection_items (
                collection_id UUID NOT NULL REFERENCES claraos_kb_collections(id) ON DELETE CASCADE,
                object_id     UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                position      REAL NOT NULL DEFAULT 0,
                added_by      TEXT NOT NULL,
                added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (collection_id, object_id)
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_coll_items_obj ON claraos_kb_collection_items (object_id)")
        await conn.execute("""
            INSERT INTO claraos_kb_types (id, name, icon, is_system, prop_schema) VALUES
              ('research', 'Recherche', '🔎', TRUE,
               '[{"key":"quelle","label":"Quelle","kind":"url"},{"key":"bewertung","label":"Bewertung (1-5)","kind":"number"},{"key":"status","label":"Status","kind":"select","options":["offen","gelesen","relevant","verworfen"]}]'),
              ('item', 'Gegenstand', '📦', TRUE,
               '[{"key":"ort","label":"Aufbewahrungsort","kind":"text"},{"key":"wert","label":"Wert (€)","kind":"number"},{"key":"kaufdatum","label":"Kaufdatum","kind":"date"},{"key":"seriennummer","label":"Seriennummer","kind":"text"}]'),
              ('comparison', 'Vergleichs-Option', '⚖️', TRUE,
               '[{"key":"preis","label":"Preis (€)","kind":"number"},{"key":"url","label":"Link","kind":"url"},{"key":"bewertung","label":"Bewertung (1-5)","kind":"number"},{"key":"pro","label":"Pro","kind":"text"},{"key":"contra","label":"Contra","kind":"text"}]'),
              ('trip', 'Reise', '✈️', TRUE,
               '[{"key":"ziel","label":"Ziel","kind":"text"},{"key":"von","label":"Von","kind":"date"},{"key":"bis","label":"Bis","kind":"date"},{"key":"budget","label":"Budget (€)","kind":"number"},{"key":"status","label":"Status","kind":"select","options":["Idee","geplant","gebucht","erledigt"]}]')
            ON CONFLICT (id) DO NOTHING
        """)
        # (017): page tree, icons/cover, text_content, weighted search,
        # refs/favorites/history. Canonical: migrations/017_knowledge_v2_foundation.sql
        await conn.execute(
            "ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS parent_id UUID "
            "REFERENCES claraos_kb_objects(id) ON DELETE SET NULL")
        await conn.execute(
            'ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS position TEXT COLLATE "C"')
        await conn.execute(
            "ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS icon TEXT")
        await conn.execute(
            "ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS cover TEXT")
        await conn.execute(
            "ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS text_content TEXT")
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_obj_parent ON claraos_kb_objects "
            "(parent_id, position) WHERE deleted_at IS NULL")
        # The weighted tsv column replaces the old unweighted one (one-off; DROP also
        # removes idx_kb_obj_tsv, which is recreated below).
        await conn.execute("""
            DO $$ BEGIN
              IF EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'claraos_kb_objects' AND column_name = 'search_tsv'
                           AND generation_expression NOT LIKE '%setweight%') THEN
                ALTER TABLE claraos_kb_objects DROP COLUMN search_tsv;
              END IF;
            END $$
        """)
        await conn.execute("""
            ALTER TABLE claraos_kb_objects ADD COLUMN IF NOT EXISTS search_tsv tsvector
                GENERATED ALWAYS AS (
                    setweight(to_tsvector('german', coalesce(title, '')), 'A') ||
                    setweight(to_tsvector('german', coalesce(text_content, body, '')), 'B')
                ) STORED
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_obj_tsv ON claraos_kb_objects USING GIN (search_tsv)")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_refs (
                id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                src_object_id    UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                target_object_id UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                kind             TEXT NOT NULL DEFAULT 'link'
                                 CHECK (kind IN ('link', 'mention', 'relation_prop', 'embed')),
                anchor_text      TEXT NOT NULL DEFAULT '',
                created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (src_object_id, target_object_id, kind, anchor_text)
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_refs_target ON claraos_kb_refs (target_object_id)")
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_refs_src ON claraos_kb_refs (src_object_id)")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_favorites (
                username   TEXT NOT NULL,
                object_id  UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                position   TEXT COLLATE "C",
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (username, object_id)
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_history (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                object_id  UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                version    INTEGER NOT NULL,
                title      TEXT NOT NULL,
                body       TEXT NOT NULL,
                properties JSONB NOT NULL DEFAULT '{}',
                actor      TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (object_id, version)
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_history_obj ON claraos_kb_history (object_id, version DESC)")
        # (018): attachments as bytea (household scale; a storage driver abstraction is the next scale step)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_attachments (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                object_id    UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                filename     TEXT NOT NULL,
                content_type TEXT NOT NULL,
                size_bytes   INTEGER NOT NULL,
                data         BYTEA NOT NULL,
                created_by   TEXT NOT NULL,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_attach_obj ON claraos_kb_attachments (object_id)")
        # (019): field registry + named views per collection
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_fields (
                id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                collection_id UUID NOT NULL REFERENCES claraos_kb_collections(id) ON DELETE CASCADE,
                key           TEXT NOT NULL,
                name          TEXT NOT NULL,
                field_type    SMALLINT NOT NULL DEFAULT 0,
                type_option   JSONB NOT NULL DEFAULT '{}',
                is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
                position      TEXT COLLATE "C",
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (collection_id, key)
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_fields_coll ON claraos_kb_fields (collection_id, position)")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_views (
                id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                collection_id  UUID NOT NULL REFERENCES claraos_kb_collections(id) ON DELETE CASCADE,
                name           TEXT NOT NULL,
                layout         TEXT NOT NULL DEFAULT 'table'
                               CHECK (layout IN ('table', 'board', 'gallery', 'list', 'calendar', 'timeline')),
                layout_setting JSONB NOT NULL DEFAULT '{}',
                filters        JSONB NOT NULL DEFAULT '{}',
                sorts          JSONB NOT NULL DEFAULT '[]',
                group_setting  JSONB NOT NULL DEFAULT '{}',
                field_settings JSONB NOT NULL DEFAULT '{}',
                position       TEXT COLLATE "C",
                created_by     TEXT NOT NULL,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_views_coll ON claraos_kb_views (collection_id, position)")
        # (023): add the timeline layout (replace the existing constraint),
        # same treatment as above: check instead of blindly replacing.
        await conn.execute("""
            DO $$
            DECLARE regel text;
            BEGIN
              SELECT pg_get_constraintdef(oid) INTO regel FROM pg_constraint
               WHERE conname = 'claraos_kb_views_layout_check'
                 AND conrelid = 'claraos_kb_views'::regclass;
              IF regel IS NULL THEN
                ALTER TABLE claraos_kb_views ADD CONSTRAINT claraos_kb_views_layout_check
                  CHECK (layout IN ('table','board','gallery','list','calendar','timeline'));
              ELSIF regel NOT LIKE '%timeline%' THEN
                ALTER TABLE claraos_kb_views DROP CONSTRAINT claraos_kb_views_layout_check;
                ALTER TABLE claraos_kb_views ADD CONSTRAINT claraos_kb_views_layout_check
                  CHECK (layout IN ('table','board','gallery','list','calendar','timeline'));
              END IF;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_obj_props ON claraos_kb_objects USING GIN (properties)")
        # (020): inline comments (anchored by quote, not in the Markdown!) + notifications
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_comments (
                id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                object_id     UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                parent_id     UUID REFERENCES claraos_kb_comments(id) ON DELETE CASCADE,
                author        TEXT NOT NULL,
                body          TEXT NOT NULL,
                anchor_text   TEXT NOT NULL DEFAULT '',
                anchor_prefix TEXT NOT NULL DEFAULT '',
                anchor_suffix TEXT NOT NULL DEFAULT '',
                resolved_at   TIMESTAMPTZ,
                resolved_by   TEXT,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                deleted_at    TIMESTAMPTZ
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_comments_obj ON claraos_kb_comments "
            "(object_id, created_at) WHERE deleted_at IS NULL")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_notifications (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username   TEXT NOT NULL,
                object_id  UUID REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                comment_id UUID REFERENCES claraos_kb_comments(id) ON DELETE CASCADE,
                kind       TEXT NOT NULL DEFAULT 'comment'
                           CHECK (kind IN ('comment', 'mention', 'reply')),
                actor      TEXT NOT NULL,
                snippet    TEXT NOT NULL DEFAULT '',
                read_at    TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_notif_user ON claraos_kb_notifications "
            "(username, read_at, created_at DESC)")
        # (021): named versions
        await conn.execute("ALTER TABLE claraos_kb_history ADD COLUMN IF NOT EXISTS name TEXT")
        # (022): templates; (027): tenant_id + RLS, see migration 027
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_templates (
                id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id          BIGINT NOT NULL DEFAULT 1,
                owner              TEXT NOT NULL,
                visibility         TEXT NOT NULL DEFAULT 'private'
                                   CHECK (visibility IN ('private', 'family')),
                name               TEXT NOT NULL,
                icon               TEXT,
                target_type        TEXT REFERENCES claraos_kb_types(id),
                body               TEXT NOT NULL DEFAULT '',
                default_properties JSONB NOT NULL DEFAULT '{}',
                is_default         BOOLEAN NOT NULL DEFAULT FALSE,
                created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_templates_owner "
            "ON claraos_kb_templates (owner, target_type)")
        # Strategy layer. Canonical: migrations/032_strategy_foundation.sql
        await conn.execute(
            "ALTER TABLE claraos_kb_links "
            "ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_kb_kpi_values (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                kpi_id     UUID NOT NULL REFERENCES claraos_kb_objects(id) ON DELETE CASCADE,
                ts         TIMESTAMPTZ NOT NULL,
                value      NUMERIC NOT NULL,
                source     TEXT NOT NULL DEFAULT 'manual',
                note       TEXT,
                created_by TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                -- tenant_id belongs here, not to the start-up routine:
                -- `tenancy.ensure_all_rls` runs at API start, but this table
                -- is only created on the first call after that.
                tenant_id  BIGINT NOT NULL DEFAULT 1,
                UNIQUE (kpi_id, ts, source)
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kb_kpi_values_kpi "
            "ON claraos_kb_kpi_values (kpi_id, ts DESC)")


# ── caller / helpers ────────────────────────────────────────────────────────

def _caller(request: Request) -> str:
    """The authenticated user on whose behalf this call runs.

    Delegates to `auth.require_caller`, which FIRST verifies the trust anchor
    (a machine's service token or the reverse proxy's shared secret) and only
    then returns the identity. Reading the header alone would let any device on
    the network, or any signed-in user, impersonate an arbitrary user.
    """
    return require_caller(request)


def _actor(request: Request, user: str) -> str:
    """'clara' for gateway calls (X-Claraos-Actor), otherwise the user themselves."""
    # The actor header is accepted from machines only (see auth.is_service_call).
    a = ((request.headers.get("x-claraos-actor") or "").strip().lower()
         if is_service_call(request) else "")
    return "clara" if a == "clara" else user


def _uuid(value: str, what: str = "id") -> str:
    try:
        return str(uuid_mod.UUID(value))
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=400, detail=f"Ungültige {what}: {value!r}")


def _jsonb(value) -> str:
    """asyncpg gotcha: serialize dicts explicitly and bind them as $n::jsonb."""
    return json.dumps(value if value is not None else {})


def _row_obj(r, slim: bool = False) -> dict:
    d = dict(r)
    d["id"] = str(d["id"])
    if d.get("parent_id") is not None:
        d["parent_id"] = str(d["parent_id"])
    if isinstance(d.get("properties"), str):
        d["properties"] = json.loads(d["properties"])
    for k in ("created_at", "updated_at", "deleted_at", "rag_indexed_at"):
        if k in d:
            d[k] = d[k].isoformat() if d[k] else None
    d.pop("search_tsv", None)
    d.pop("text_content", None)
    if slim:
        body = d.get("body") or ""
        d["body_preview"] = body[:280] + ("…" if len(body) > 280 else "")
        d.pop("body", None)
        d.pop("rag_status", None)
        d.pop("rag_indexed_at", None)
        d.pop("deleted_at", None)
    return d


def _row_activity(r) -> dict:
    d = dict(r)
    d["id"] = str(d["id"])
    d["object_id"] = str(d["object_id"])
    if isinstance(d.get("meta"), str):
        d["meta"] = json.loads(d["meta"])
    d["created_at"] = d["created_at"].isoformat()
    return d


_OBJ_COLS = ("id, type, owner, visibility, title, body, properties, stage, "
             "created_by, created_at, updated_at, deleted_at, rag_status, rag_indexed_at, "
             "parent_id, position, icon, cover")
# Qualified variant for joins (refs.id/favorites.position would otherwise be ambiguous)
_OBJ_COLS_Q = ", ".join(f"claraos_kb_objects.{c.strip()}" for c in _OBJ_COLS.split(","))


async def _fetch_visible(conn, object_id: str, user: str):
    """Load an object if the user may see it, otherwise 404 (no existence leak)."""
    row = await conn.fetchrow(
        f"SELECT {_OBJ_COLS} FROM claraos_kb_objects "
        f"WHERE id = $1::uuid AND {_VIS.format(u='$2')}",
        object_id, user,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Objekt nicht gefunden")
    return row


async def _require_owner(conn, object_id: str, user: str):
    row = await _fetch_visible(conn, object_id, user)
    if row["owner"] != user:
        raise HTTPException(status_code=403, detail="Nur der Besitzer darf dieses Objekt ändern")
    return row


async def _require_editable(conn, object_id: str, user: str):
    """Editing is allowed for the owner, or for whoever owns the collection
    containing the object or received it with write permission. Deleting,
    moving, sharing and restoring versions stay with the owner (_require_owner)."""
    row = await _fetch_visible(conn, object_id, user)
    if row["owner"] == user:
        return row
    ok = await conn.fetchval(
        f"SELECT {_edit_for('claraos_kb_objects.', '$2')} FROM claraos_kb_objects WHERE id = $1::uuid",
        object_id, user)
    if not ok:
        raise HTTPException(
            status_code=403,
            detail="Nur der Besitzer oder ein Mitglied mit Schreibrecht darf dieses Objekt ändern")
    return row


async def _log_activity(conn, object_id: str, actor: str, kind: str,
                        content: str = "", meta: dict | None = None) -> None:
    await conn.execute(
        "INSERT INTO claraos_kb_activity (object_id, actor, kind, content, meta) "
        "VALUES ($1::uuid, $2, $3, $4, $5::jsonb)",
        object_id, actor, kind, content, _jsonb(meta),
    )


def _validate(value: str | None, allowed: tuple, what: str) -> str | None:
    if value is not None and value not in allowed:
        raise HTTPException(status_code=400, detail=f"Ungültige(r) {what}: {value!r} (erlaubt: {', '.join(allowed)})")
    return value


# ── Fractional index + post-save pipeline ───────────────────────────────────
# (patterns borrowed from Docmost/SiYuan/Outline)

# ASCII-ordered alphabet → sorts correctly under COLLATE "C"
_FRAC_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def _frac_between(a: str | None, b: str | None) -> str:
    """Sort key strictly between a and b (None = open end).
    The result never ends on the smallest digit, so something always fits before it."""
    a, b = a or "", b or ""
    if b and a >= b:
        raise HTTPException(status_code=400, detail="Ungültige Positions-Nachbarn")
    key = ""
    i = 0
    while True:
        da = _FRAC_DIGITS.index(a[i]) if i < len(a) else 0
        db = _FRAC_DIGITS.index(b[i]) if i < len(b) else len(_FRAC_DIGITS)
        if db - da > 1:
            return key + _FRAC_DIGITS[(da + db) // 2]
        # no room at this position → take a's digit and go deeper
        key += _FRAC_DIGITS[da]
        i += 1
        if i > len(a) and i > 64:  # emergency brake against degenerate chains
            return key + _FRAC_DIGITS[len(_FRAC_DIGITS) // 2]


_MD_STRIP_RES = (
    (re.compile(r"```.*?```", re.S), " "),               # code fences (content dropped: search covers prose)
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), " "),          # images
    (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),       # links → link text
    (re.compile(r"\{:[^}]*\}"), " "),                    # Kramdown IAL (future use)
    (re.compile(r"^#{1,6}\s+", re.M), ""),               # heading markers
    (re.compile(r"[*_`>|~#]"), " "),                     # remaining Markdown characters
    (re.compile(r"\s+"), " "),
)


def _derive_text(md: str) -> str:
    """Markdown → plain text for the weighted full-text search (zone B)."""
    out = md or ""
    for rx, repl in _MD_STRIP_RES:
        out = rx.sub(repl, out)
    return out.strip()[:200_000]


# Reference forms in Markdown:
#   [anchor](#kb-<uuid>)                          ← editor mentions (survive sanitizing!)
#   [anchor](claraos://knowledge/object/<uuid>)   ← Clara / legacy content
#   bare claraos://… URI                          ← Clara free text
# Important: the fragment form is canonical: unknown URL schemes do not survive
# the Markdown round trip in the editor (remark sanitizing).
_REF_MD_RE = re.compile(
    r"\[([^\]]*)\]\((?:claraos://(?:knowledge|ideas)/object/|#kb-)([0-9a-f-]{36})\)", re.I)
_REF_BARE_RE = re.compile(
    r"(?<!\()claraos://(?:knowledge|ideas)/object/([0-9a-f-]{36})", re.I)


def _extract_refs(body: str) -> list[tuple[str, str, str]]:
    """[(target_id, kind, anchor_text)], deduplicated, stable order."""
    seen: dict[tuple[str, str, str], None] = {}
    for m in _REF_MD_RE.finditer(body or ""):
        seen[(m.group(2).lower(), "mention", m.group(1)[:200])] = None
    for m in _REF_BARE_RE.finditer(body or ""):
        key = (m.group(1).lower(), "link", "")
        if not any(k[0] == key[0] for k in seen):
            seen[key] = None
    return list(seen.keys())


async def _post_save(object_id: str, actor: str) -> None:
    """One hook after every write (Docmost pattern): derive text_content →
    rewrite refs idempotently (SiYuan) → history snapshot (skipped when
    unchanged, Outline). Fire-and-forget: errors NEVER block the save."""
    try:
        # Service path (background task, no request user): text, refs and history
        # are derived for every object regardless of who triggered the save, so
        # this runs on the plain pool (superuser, bypasses RLS) on purpose.
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT title, body, properties, deleted_at FROM claraos_kb_objects "
                "WHERE id = $1::uuid", object_id)
            if not row:
                return
            if row["deleted_at"] is not None:
                await conn.execute(
                    "DELETE FROM claraos_kb_refs WHERE src_object_id = $1::uuid", object_id)
                return
            # 1) Plain text (deliberately do NOT touch updated_at: not a user edit)
            await conn.execute(
                "UPDATE claraos_kb_objects SET text_content = $2 WHERE id = $1::uuid",
                object_id, _derive_text(row["body"]))
            # 2) Refs: idempotent reindex; self-references and dead targets are dropped
            refs = _extract_refs(row["body"])
            await conn.execute(
                "DELETE FROM claraos_kb_refs WHERE src_object_id = $1::uuid", object_id)
            for target_id, kind, anchor in refs:
                if target_id == object_id:
                    continue
                await conn.execute(
                    """
                    INSERT INTO claraos_kb_refs (src_object_id, target_object_id, kind, anchor_text)
                    SELECT $1::uuid, o.id, $3, $4 FROM claraos_kb_objects o
                    WHERE o.id = $2::uuid
                    ON CONFLICT DO NOTHING
                    """,
                    object_id, target_id, kind, anchor)
            # 3) History snapshot (deduplicated against the latest version)
            props = row["properties"] if isinstance(row["properties"], str) \
                else json.dumps(row["properties"] or {})
            last = await conn.fetchrow(
                "SELECT version, title, body, properties FROM claraos_kb_history "
                "WHERE object_id = $1::uuid ORDER BY version DESC LIMIT 1", object_id)
            last_props = (last["properties"] if isinstance(last["properties"], str)
                          else json.dumps(last["properties"] or {})) if last else None
            if last and last["title"] == row["title"] and last["body"] == row["body"] \
                    and last_props == props:
                return
            await conn.execute(
                """
                INSERT INTO claraos_kb_history (object_id, version, title, body, properties, actor)
                VALUES ($1::uuid,
                        COALESCE((SELECT MAX(version) FROM claraos_kb_history
                                  WHERE object_id = $1::uuid), 0) + 1,
                        $2, $3, $4::jsonb, $5)
                ON CONFLICT (object_id, version) DO NOTHING
                """,
                object_id, row["title"], row["body"], props, actor)
    except Exception as exc:  # noqa: BLE001 — the pipeline is nice-to-have
        logger.warning("kb post_save %s failed: %s", object_id, exc)


# ── CRUD: objects ───────────────────────────────────────────────────────────

class ObjectCreate(BaseModel):
    type: str = "note"
    title: str
    body: str = ""
    properties: dict | None = None
    visibility: str = "private"
    stage: str | None = None
    parent_id: str | None = None
    icon: str | None = None
    cover: str | None = None


class ObjectPatch(BaseModel):
    title: str | None = None
    body: str | None = None
    properties: dict | None = None
    visibility: str | None = None
    stage: str | None = None
    icon: str | None = None
    cover: str | None = None


@router.get("/objects")
async def list_objects(request: Request, type: str | None = None,
                       stage: str | None = None, q: str | None = None,
                       visibility: str | None = None,
                       props: str | None = None,
                       collection_id: str | None = None,
                       limit: int = 50, offset: int = 0):
    await _ensure_tables()
    user = _caller(request)
    where = [_VIS.format(u="$1")]
    params: list = [user]
    join = ""
    order = "updated_at DESC"
    for col, val in (("type", type), ("stage", stage), ("visibility", visibility)):
        if val:
            params.append(val)
            where.append(f"{col} = ${len(params)}")
    if q:
        params.append(q)
        where.append(f"search_tsv @@ websearch_to_tsquery('german', ${len(params)})")
    if props:
        # Property filter: JSON object, containment (`properties @> …`)
        try:
            parsed = json.loads(props)
            assert isinstance(parsed, dict)
        except (ValueError, AssertionError):
            raise HTTPException(status_code=400, detail="props muss ein JSON-Objekt sein")
        params.append(json.dumps(parsed))
        where.append(f"properties @> ${len(params)}::jsonb")
    if collection_id:
        params.append(_uuid(collection_id, "collection_id"))
        join = ("JOIN claraos_kb_collection_items ci ON ci.object_id = claraos_kb_objects.id "
                f"AND ci.collection_id = ${len(params)}::uuid")
        order = "ci.position, updated_at DESC"
    params.append(max(1, min(limit, 200)))
    lim = f"${len(params)}"
    params.append(max(0, offset))
    off = f"${len(params)}"
    async with user_tx(user) as conn:
        # _OBJ_COLS_Q: the collection join brings its own position column
        rows = await conn.fetch(
            f"SELECT {_OBJ_COLS_Q}, {_edit_for('claraos_kb_objects.', '$1')} AS can_edit "
            f"FROM claraos_kb_objects {join} WHERE {' AND '.join(where)} "
            f"ORDER BY {order} LIMIT {lim} OFFSET {off}",
            *params,
        )
    return {"objects": [_row_obj(r, slim=True) for r in rows]}


def _validate_kpi_source(properties: dict | None) -> None:
    """Validate a KPI's source at SAVE time.

    Otherwise a misspelled source would only surface on the next collection
    run, as an error on a card that nobody connects with creating it anymore.
    """
    src = (properties or {}).get("source")
    if src is None:
        return
    if not isinstance(src, dict):
        raise HTTPException(status_code=400, detail="source muss ein Objekt sein")
    kind = (src.get("kind") or "manual")
    if kind not in kpi_sources.KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unbekannte Quelle: {kind!r} (erlaubt: {', '.join(kpi_sources.KINDS)})")


async def _create_object(user: str, actor: str, body: ObjectCreate,
                         background: BackgroundTasks) -> dict:
    _validate(body.visibility, VISIBILITIES, "visibility")
    _validate(body.stage, STAGES, "stage")
    if body.type == "kpi":
        _validate_kpi_source(body.properties)
    if body.type == "idea" and body.stage is None:
        body.stage = "spark"
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="title darf nicht leer sein")
    async with user_tx(user) as conn:
        t = await conn.fetchrow("SELECT id FROM claraos_kb_types WHERE id = $1", body.type)
        if not t:
            raise HTTPException(status_code=400, detail=f"Unbekannter Typ: {body.type!r}")
        parent_id = None
        position = None
        if body.parent_id:
            parent_id = _uuid(body.parent_id, "parent_id")
            await _fetch_visible(conn, parent_id, user)  # 404 instead of an existence leak
            # Over ALL siblings, including ones this user cannot read (RLS would
            # hide them and the new key could collide): a SECURITY DEFINER helper.
            last = await conn.fetchval("SELECT claraos_kb_pos_max($1::uuid, NULL)", parent_id)
            position = _frac_between(last, None)
        row = await conn.fetchrow(
            f"""
            INSERT INTO claraos_kb_objects
                (type, owner, visibility, title, body, properties, stage, created_by,
                 parent_id, position, icon, cover)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::uuid, $10, $11, $12)
            RETURNING {_OBJ_COLS}
            """,
            body.type, user, body.visibility, body.title.strip(), body.body or "",
            _jsonb(body.properties), body.stage, actor,
            parent_id, position, body.icon, body.cover,
        )
    background.add_task(kb_indexer.index_object, str(row["id"]))
    background.add_task(_post_save, str(row["id"]), actor)
    # Clara attaches 1-3 follow-up questions to freshly captured IDEAS
    # (automatic on capture); fire-and-forget, never blocks.
    if body.type == "idea":
        background.add_task(kb_analyst.analyze_idea, str(row["id"]))
    return _row_obj(row)


@router.post("/objects")
async def create_object(body: ObjectCreate, request: Request, background: BackgroundTasks):
    await _ensure_tables()
    user = _caller(request)
    return {"object": await _create_object(user, _actor(request, user), body, background)}


@router.get("/objects/{object_id}")
async def get_object(object_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        row = await _fetch_visible(conn, object_id, user)
        links = await conn.fetch(
            """
            SELECT l.id, l.from_id, l.to_id, l.rel, o.title AS other_title, o.type AS other_type,
                   (l.from_id = $1::uuid) AS outgoing
            FROM claraos_kb_links l
            JOIN claraos_kb_objects o
              ON o.id = CASE WHEN l.from_id = $1::uuid THEN l.to_id ELSE l.from_id END
            WHERE (l.from_id = $1::uuid OR l.to_id = $1::uuid)
              AND """ + _vis_for("o.", "$2") + """
            """,
            object_id, user,
        )
        activity = await conn.fetch(
            "SELECT id, object_id, actor, kind, content, meta, created_at "
            "FROM claraos_kb_activity WHERE object_id = $1::uuid "
            "ORDER BY created_at DESC LIMIT 20",
            object_id,
        )
        # Which collections contain this object? Without this the detail view could
        # not know the collection's columns and showed the object TYPE's
        # `prop_schema` instead. Result: opening a row hid the fields shown next to it
        # in the table (cost, status, due date …), which could then only be edited in
        # the table row. Two parallel property systems, and the detail view used the
        # wrong one.
        colls = await conn.fetch(
            """
            SELECT c.id, c.name, c.icon
            FROM claraos_kb_collections c
            JOIN claraos_kb_collection_items ci ON ci.collection_id = c.id
            WHERE ci.object_id = $1::uuid
              AND (c.owner = $2 OR c.visibility = 'family' OR EXISTS
                   (SELECT 1 FROM claraos_kb_collection_shares _cs
                    WHERE _cs.collection_id = c.id AND _cs.shared_with = $2))
            ORDER BY c.name
            """,
            object_id, user,
        )
        can_edit = row["owner"] == user or bool(await conn.fetchval(
            f"SELECT {_edit_for('claraos_kb_objects.', '$2')} FROM claraos_kb_objects "
            "WHERE id = $1::uuid", object_id, user))
    out = _row_obj(row)
    out["can_edit"] = can_edit
    out["collections"] = [
        {"id": str(c["id"]), "name": c["name"], "icon": c["icon"]} for c in colls
    ]
    if row["owner"] == user:
        async with user_tx(user) as conn:
            sh = await conn.fetch(
                "SELECT shared_with FROM claraos_kb_shares WHERE object_id = $1::uuid ORDER BY shared_with",
                object_id)
        out["shares"] = [s["shared_with"] for s in sh]
    out["links"] = [
        {"id": str(l["id"]), "rel": l["rel"], "direction": "out" if l["outgoing"] else "in",
         "other_id": str(l["to_id"] if l["outgoing"] else l["from_id"]),
         "other_title": l["other_title"], "other_type": l["other_type"]}
        for l in links
    ]
    out["activity"] = [_row_activity(a) for a in reversed(activity)]
    return {"object": out}


async def _patch_object(object_id: str, user: str, actor: str, body: ObjectPatch,
                        background: BackgroundTasks) -> dict:
    _validate(body.visibility, VISIBILITIES, "visibility")
    _validate(body.stage, STAGES, "stage")
    async with user_tx(user) as conn:
        cur = await _require_editable(conn, object_id, user)
        if body.visibility is not None and cur["owner"] != user:
            raise HTTPException(status_code=403, detail="Die Sichtbarkeit ändert nur der Besitzer")
        if cur["type"] == "kpi" and body.properties is not None:
            _validate_kpi_source(body.properties)
        sets, params = ["updated_at = NOW()"], [object_id]
        for col in ("title", "body", "visibility", "stage", "icon", "cover"):
            val = getattr(body, col)
            if val is not None:
                params.append(val.strip() if col == "title" else val)
                sets.append(f"{col} = ${len(params)}")
        if body.properties is not None:
            params.append(_jsonb(body.properties))
            sets.append(f"properties = ${len(params)}::jsonb")
        params.append("pending")
        sets.append(f"rag_status = ${len(params)}")
        row = await conn.fetchrow(
            f"UPDATE claraos_kb_objects SET {', '.join(sets)} "
            f"WHERE id = $1::uuid RETURNING {_OBJ_COLS}",
            *params,
        )
        if body.stage is not None and body.stage != cur["stage"]:
            await _log_activity(conn, object_id, actor, "stage_change",
                                meta={"from_stage": cur["stage"], "to_stage": body.stage})
    background.add_task(kb_indexer.index_object, object_id)
    background.add_task(_post_save, object_id, actor)
    return _row_obj(row)


@router.patch("/objects/{object_id}")
async def patch_object(object_id: str, body: ObjectPatch, request: Request,
                       background: BackgroundTasks):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    return {"object": await _patch_object(object_id, user, _actor(request, user), body, background)}


@router.delete("/objects/{object_id}")
async def delete_object(object_id: str, request: Request, background: BackgroundTasks):
    """Soft delete (trash); Qdrant points are cleaned up by the BackgroundTask/reconciler."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_owner(conn, object_id, user)
        await conn.execute(
            "UPDATE claraos_kb_objects SET deleted_at = NOW(), rag_status = 'deindex', "
            "updated_at = NOW() WHERE id = $1::uuid",
            object_id,
        )
    background.add_task(kb_indexer.deindex_object, object_id)
    background.add_task(_post_save, object_id, user)  # cleans up the object's refs
    return {"ok": True}


@router.post("/objects/{object_id}/restore")
async def restore_object(object_id: str, request: Request, background: BackgroundTasks):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        row = await conn.fetchrow(
            f"SELECT {_OBJ_COLS} FROM claraos_kb_objects "
            "WHERE id = $1::uuid AND owner = $2 AND deleted_at IS NOT NULL",
            object_id, user,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Nichts zum Wiederherstellen")
        await conn.execute(
            "UPDATE claraos_kb_objects SET deleted_at = NULL, rag_status = 'pending', "
            "updated_at = NOW() WHERE id = $1::uuid",
            object_id,
        )
    background.add_task(kb_indexer.index_object, object_id)
    background.add_task(_post_save, object_id, user)
    return {"ok": True}


@router.delete("/objects/{object_id}/purge")
async def purge_object(object_id: str, request: Request):
    """Remove an object from the trash for good (owner only, only if already trashed).

    Two steps on purpose: delete moves to the trash, purge empties that one
    entry. Nothing that is still live can be destroyed through this route.
    """
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        done = await conn.execute(
            "DELETE FROM claraos_kb_objects WHERE id = $1::uuid AND owner = $2 "
            "AND deleted_at IS NOT NULL", object_id, user)
    if done.endswith(" 0"):
        raise HTTPException(status_code=404, detail="Not in your trash (delete it first)")
    return {"ok": True, "purged": object_id}


# ── Tree, backlinks, favorites, history, trash ──────────────────────────────

class ObjectMove(BaseModel):
    parent_id: str | None = None    # None = top level
    after_id: str | None = None     # sibling to insert after (None = at the end)


@router.get("/objects/{object_id}/backlinks")
async def get_backlinks(object_id: str, request: Request, limit: int = 50):
    """Who references this object? Only VISIBLE sources (no existence leak)."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _fetch_visible(conn, object_id, user)
        rows = await conn.fetch(
            f"""
            SELECT r.kind, r.anchor_text, {_OBJ_COLS_Q}
            FROM claraos_kb_refs r
            JOIN claraos_kb_objects ON claraos_kb_objects.id = r.src_object_id
            WHERE r.target_object_id = $2::uuid AND {_VIS.format(u='$1')}
            ORDER BY claraos_kb_objects.updated_at DESC LIMIT $3
            """,
            user, object_id, max(1, min(limit, 200)),
        )
    return {"backlinks": [
        {**_row_obj(r, slim=True), "kind": r["kind"], "anchor_text": r["anchor_text"]}
        for r in rows
    ]}


@router.get("/objects/{object_id}/children")
async def get_children(object_id: str, request: Request,
                       after: str | None = None, limit: int = 100):
    """Child pages sorted by position (cursor = position of the last child)."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _fetch_visible(conn, object_id, user)
        params: list = [user, object_id, max(1, min(limit, 200))]
        cursor = ""
        if after:
            params.append(after)
            cursor = f"AND position > ${len(params)}"
        rows = await conn.fetch(
            f"SELECT {_OBJ_COLS} FROM claraos_kb_objects "
            f"WHERE parent_id = $2::uuid AND {_VIS.format(u='$1')} {cursor} "
            f"ORDER BY position NULLS LAST, created_at LIMIT $3",
            *params,
        )
    return {"children": [_row_obj(r, slim=True) for r in rows]}


@router.get("/objects/{object_id}/ancestors")
async def get_ancestors(object_id: str, request: Request):
    """Breadcrumb path (root first): recursive CTE over visible ancestors."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _fetch_visible(conn, object_id, user)
        rows = await conn.fetch(
            """
            WITH RECURSIVE up AS (
                SELECT o.id, o.parent_id, o.title, o.icon, o.type, o.owner, o.visibility,
                       o.deleted_at, 0 AS depth
                FROM claraos_kb_objects o WHERE o.id = $2::uuid
                UNION ALL
                SELECT o.id, o.parent_id, o.title, o.icon, o.type, o.owner, o.visibility,
                       o.deleted_at, up.depth + 1
                FROM claraos_kb_objects o JOIN up ON o.id = up.parent_id
                WHERE up.depth < 32
            )
            SELECT id, title, icon, type FROM up
            WHERE depth > 0 AND deleted_at IS NULL
              AND """ + _vis_core("up.", "$1") + """
            ORDER BY depth DESC
            """,
            user, object_id,
        )
    return {"ancestors": [
        {"id": str(r["id"]), "title": r["title"], "icon": r["icon"], "type": r["type"]}
        for r in rows
    ]}


@router.patch("/objects/{object_id}/move")
async def move_object(object_id: str, body: ObjectMove, request: Request):
    """Re-parent/reorder: owner only; cycle check via CTE; fractional position."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    parent_id = _uuid(body.parent_id, "parent_id") if body.parent_id else None
    after_id = _uuid(body.after_id, "after_id") if body.after_id else None
    async with user_tx(user) as conn:
        await _require_owner(conn, object_id, user)
        if parent_id:
            if parent_id == object_id:
                raise HTTPException(status_code=400, detail="Objekt kann nicht sein eigenes Elternteil sein")
            await _fetch_visible(conn, parent_id, user)
            # The cycle check must see the WHOLE subtree, also pages of other
            # users below this one (RLS would hide them): SECURITY DEFINER helper.
            cycle = await conn.fetchval(
                "SELECT claraos_kb_ist_nachfahre($1::uuid, $2::uuid)", object_id, parent_id)
            if cycle:
                raise HTTPException(status_code=400, detail="Zyklus: Ziel ist ein Nachfahre des Objekts")
        # Determine neighbours (in the target parent, visible, sorted by position)
        prev_pos = None
        if after_id:
            prev = await conn.fetchrow(
                "SELECT position, parent_id FROM claraos_kb_objects "
                "WHERE id = $1::uuid AND deleted_at IS NULL", after_id)
            if not prev or str(prev["parent_id"] or "") != str(parent_id or ""):
                raise HTTPException(status_code=400, detail="after_id liegt nicht im Ziel-Parent")
            prev_pos = prev["position"]
            next_pos = await conn.fetchval(
                "SELECT claraos_kb_pos_naechste($1::uuid, $2, $3::uuid)",
                parent_id, prev_pos, object_id)
        else:
            next_pos = None
            prev_pos = await conn.fetchval(
                "SELECT claraos_kb_pos_max($1::uuid, $2::uuid)", parent_id, object_id)
        position = _frac_between(prev_pos, next_pos)
        row = await conn.fetchrow(
            f"UPDATE claraos_kb_objects SET parent_id = $2::uuid, position = $3, "
            f"updated_at = NOW() WHERE id = $1::uuid RETURNING {_OBJ_COLS}",
            object_id, parent_id, position,
        )
    return {"object": _row_obj(row)}


@router.get("/favorites")
async def list_favorites(request: Request):
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            f"""
            SELECT f.position AS fav_position, {_OBJ_COLS_Q}
            FROM claraos_kb_favorites f
            JOIN claraos_kb_objects ON claraos_kb_objects.id = f.object_id
            WHERE f.username = $1 AND {_VIS.format(u='$1')}
            ORDER BY f.position NULLS LAST, f.created_at
            """,
            user,
        )
    return {"favorites": [_row_obj(r, slim=True) for r in rows]}


@router.put("/objects/{object_id}/favorite")
async def add_favorite(object_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _fetch_visible(conn, object_id, user)
        last = await conn.fetchval(
            "SELECT MAX(position) FROM claraos_kb_favorites WHERE username = $1", user)
        await conn.execute(
            "INSERT INTO claraos_kb_favorites (username, object_id, position) "
            "VALUES ($1, $2::uuid, $3) ON CONFLICT DO NOTHING",
            user, object_id, _frac_between(last, None),
        )
    return {"ok": True}


@router.delete("/objects/{object_id}/favorite")
async def remove_favorite(object_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await conn.execute(
            "DELETE FROM claraos_kb_favorites WHERE username = $1 AND object_id = $2::uuid",
            user, object_id)
    return {"ok": True}


@router.get("/objects/{object_id}/history")
async def list_history(object_id: str, request: Request, limit: int = 50):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _fetch_visible(conn, object_id, user)
        rows = await conn.fetch(
            "SELECT version, name, title, actor, created_at, length(body) AS body_len "
            "FROM claraos_kb_history WHERE object_id = $1::uuid "
            "ORDER BY version DESC LIMIT $2",
            object_id, max(1, min(limit, 200)),
        )
    return {"history": [
        {"version": r["version"], "name": r["name"], "title": r["title"], "actor": r["actor"],
         "created_at": r["created_at"].isoformat(), "body_len": r["body_len"]}
        for r in rows
    ]}


@router.get("/objects/{object_id}/history/{version}")
async def get_history_version(object_id: str, version: int, request: Request):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _fetch_visible(conn, object_id, user)
        r = await conn.fetchrow(
            "SELECT version, title, body, properties, actor, created_at "
            "FROM claraos_kb_history WHERE object_id = $1::uuid AND version = $2",
            object_id, version)
    if not r:
        raise HTTPException(status_code=404, detail="Version nicht gefunden")
    props = r["properties"] if not isinstance(r["properties"], str) else json.loads(r["properties"])
    return {"version": {"version": r["version"], "title": r["title"], "body": r["body"],
                        "properties": props, "actor": r["actor"],
                        "created_at": r["created_at"].isoformat()}}


@router.post("/objects/{object_id}/history/{version}/restore")
async def restore_history_version(object_id: str, version: int, request: Request,
                                  background: BackgroundTasks):
    """Reset title/body/properties to the snapshot (itself creates a new version)."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_owner(conn, object_id, user)
        snap = await conn.fetchrow(
            "SELECT title, body, properties FROM claraos_kb_history "
            "WHERE object_id = $1::uuid AND version = $2", object_id, version)
        if not snap:
            raise HTTPException(status_code=404, detail="Version nicht gefunden")
        props = snap["properties"] if isinstance(snap["properties"], str) \
            else json.dumps(snap["properties"] or {})
        row = await conn.fetchrow(
            f"UPDATE claraos_kb_objects SET title = $2, body = $3, properties = $4::jsonb, "
            f"rag_status = 'pending', updated_at = NOW() "
            f"WHERE id = $1::uuid RETURNING {_OBJ_COLS}",
            object_id, snap["title"], snap["body"], props,
        )
        await _log_activity(conn, object_id, actor, "edit",
                            content=f"Version {version} wiederhergestellt")
    background.add_task(kb_indexer.index_object, object_id)
    background.add_task(_post_save, object_id, actor)
    return {"object": _row_obj(row)}


@router.get("/trash")
async def list_trash(request: Request, limit: int = 100):
    """Own deleted objects (only the owner sees their trash)."""
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            f"SELECT {_OBJ_COLS} FROM claraos_kb_objects "
            f"WHERE owner = $1 AND deleted_at IS NOT NULL "
            f"ORDER BY deleted_at DESC LIMIT $2",
            user, max(1, min(limit, 200)),
        )
    out = []
    for r in rows:
        d = dict(r)
        deleted = d.get("deleted_at")
        o = _row_obj(r, slim=True)
        o["deleted_at"] = deleted.isoformat() if deleted else None
        out.append(o)
    return {"trash": out}


# ── Attachments (editor uploads) ───────────────────────────────────────────

_ATTACH_MAX = 20 * 1024 * 1024  # 20 MB, household scale; videos belong in a media server
# Whitelist of types rendered inline; everything else is served as a download.
_ATTACH_INLINE = {
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
    "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav",
    "application/pdf",
}
# SVG deliberately NOT inline (script injection); forced as a download.


@router.post("/objects/{object_id}/attachments")
async def upload_attachment(object_id: str, request: Request, file: UploadFile):
    """Editor upload (BlockNote uploadFile). Only the owner uploads; delivery
    is visibility-checked via the object."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    data = await file.read()
    if len(data) > _ATTACH_MAX:
        raise HTTPException(status_code=413, detail="Datei zu groß (max. 20 MB)")
    if not data:
        raise HTTPException(status_code=400, detail="Leere Datei")
    ctype = (file.content_type or "application/octet-stream").split(";")[0].strip().lower()
    fname = re.sub(r"[^\w.\-()+ ]", "_", file.filename or "datei")[:180] or "datei"
    async with user_tx(user) as conn:
        await _require_editable(conn, object_id, user)
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_kb_attachments (object_id, filename, content_type, size_bytes, data, created_by)
            VALUES ($1::uuid, $2, $3, $4, $5, $6)
            RETURNING id
            """,
            object_id, fname, ctype, len(data), data, user,
        )
    aid = str(row["id"])
    return {"attachment": {
        "id": aid, "filename": fname, "content_type": ctype, "size_bytes": len(data),
        "url": f"/api/claraos/knowledge/attachments/{aid}/{fname}",
    }}


@router.get("/attachments/{attachment_id}/{filename}")
async def serve_attachment(attachment_id: str, filename: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    attachment_id = _uuid(attachment_id, "attachment_id")
    async with user_tx(user) as conn:
        row = await conn.fetchrow(
            "SELECT object_id, filename, content_type, data FROM claraos_kb_attachments "
            "WHERE id = $1::uuid", attachment_id)
        if not row:
            raise HTTPException(status_code=404, detail="Anhang nicht gefunden")
        await _fetch_visible(conn, str(row["object_id"]), user)  # 404 instead of a leak
    inline = row["content_type"] in _ATTACH_INLINE
    disposition = "inline" if inline else "attachment"
    return Response(
        content=row["data"],
        media_type=row["content_type"] if inline else "application/octet-stream",
        headers={
            "Content-Disposition": f'{disposition}; filename="{row["filename"]}"',
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=86400",
        },
    )


@router.get("/objects/{object_id}/attachments")
async def list_attachments(object_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _fetch_visible(conn, object_id, user)
        rows = await conn.fetch(
            "SELECT id, filename, content_type, size_bytes, created_by, created_at "
            "FROM claraos_kb_attachments WHERE object_id = $1::uuid ORDER BY created_at",
            object_id)
    return {"attachments": [
        {"id": str(r["id"]), "filename": r["filename"], "content_type": r["content_type"],
         "size_bytes": r["size_bytes"], "created_by": r["created_by"],
         "created_at": r["created_at"].isoformat(),
         "url": f"/api/claraos/knowledge/attachments/{r['id']}/{r['filename']}"}
        for r in rows
    ]}


# ── Activity ────────────────────────────────────────────────────────────────

class ActivityCreate(BaseModel):
    kind: str = "comment"
    content: str
    meta: dict | None = None


@router.get("/objects/{object_id}/activity")
async def list_activity(object_id: str, request: Request, limit: int = 50):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _fetch_visible(conn, object_id, user)
        rows = await conn.fetch(
            "SELECT id, object_id, actor, kind, content, meta, created_at "
            "FROM claraos_kb_activity WHERE object_id = $1::uuid "
            "ORDER BY created_at DESC LIMIT $2",
            object_id, max(1, min(limit, 200)),
        )
    return {"activity": [_row_activity(r) for r in reversed(rows)]}


@router.post("/objects/{object_id}/activity")
async def add_activity(object_id: str, body: ActivityCreate, request: Request):
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    object_id = _uuid(object_id, "object_id")
    _validate(body.kind, ACTIVITY_KINDS, "kind")
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="content darf nicht leer sein")
    async with user_tx(user) as conn:
        row = await _fetch_visible(conn, object_id, user)
        # 'family' visibility only allows comments; everything else is owner-only
        # (or Clara on the owner's behalf, since Clara always acts as the chat user).
        if row["owner"] != user and body.kind != "comment":
            raise HTTPException(status_code=403, detail="Auf geteilten Objekten sind nur Kommentare erlaubt")
        await _log_activity(conn, object_id, actor, body.kind, body.content, body.meta)
    return {"ok": True}


# ── Links ───────────────────────────────────────────────────────────────────

class LinkCreate(BaseModel):
    to_id: str
    rel: str = "relates_to"


@router.post("/objects/{object_id}/links")
async def create_link(object_id: str, body: LinkCreate, request: Request):
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    object_id = _uuid(object_id, "object_id")
    to_id = _uuid(body.to_id, "to_id")
    _validate(body.rel, LINK_RELS, "rel")
    if object_id == to_id:
        raise HTTPException(status_code=400, detail="Ein Objekt kann nicht mit sich selbst verknüpft werden")
    async with user_tx(user) as conn:
        await _require_owner(conn, object_id, user)
        await _fetch_visible(conn, to_id, user)
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_kb_links (from_id, to_id, rel, created_by)
            VALUES ($1::uuid, $2::uuid, $3, $4)
            ON CONFLICT (from_id, to_id, rel) DO UPDATE SET rel = EXCLUDED.rel
            RETURNING id
            """,
            object_id, to_id, body.rel, actor,
        )
    return {"ok": True, "link_id": str(row["id"])}


@router.delete("/links/{link_id}")
async def delete_link(link_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    link_id = _uuid(link_id, "link_id")
    async with user_tx(user) as conn:
        res = await conn.execute(
            """
            DELETE FROM claraos_kb_links l
            USING claraos_kb_objects o
            WHERE l.id = $1::uuid AND o.id = l.from_id AND o.owner = $2
            """,
            link_id, user,
        )
    if int(res.split()[-1] or 0) == 0:
        raise HTTPException(status_code=404, detail="Link nicht gefunden")
    return {"ok": True}


# ── Strategy: goals & KPIs ──────────────────────────────────────────────────
# Goal hierarchy = page hierarchy (parent_id). KPIs hang off the goal via the
# 'measured_by' edge; n:m because one KPI may contribute to several goals.
# Measurements live in claraos_kb_kpi_values.

# Allowed values of a KPI's `source` property. The installation adds its own
# (heim_werte.HEIM_KPI_SOURCES, the complete ordered list there).
KPI_SOURCES = heim_struktur("HEIM_KPI_SOURCES", ("manual", "planner", "formula", "clara"))

# Upper bound for one tree fetch. When reached it is LOGGED instead of silently
# truncated: a silent cap reads like completeness.
_KPI_VALUE_BUDGET = 20000


def _vis_alias(alias: str, u: str) -> str:
    """_VIS for a query with a table alias (the constant names the table
    directly and therefore does not fit into recursive CTEs)."""
    return _vis_for(f"{alias}.", u)


def _parse_ts(raw: str | None) -> dt.datetime:
    if not raw:
        return dt.datetime.now(dt.timezone.utc)
    try:
        parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail=f"Ungültiger Zeitpunkt: {raw!r}")
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


async def _series_for(conn, kpi_ids: list[str]) -> dict[str, list[dict]]:
    """Series of several KPIs in ONE query (ascending by ts)."""
    if not kpi_ids:
        return {}
    rows = await conn.fetch(
        "SELECT kpi_id, ts, value, source, note FROM claraos_kb_kpi_values "
        "WHERE kpi_id = ANY($1::uuid[]) ORDER BY kpi_id, ts LIMIT $2",
        kpi_ids, _KPI_VALUE_BUDGET,
    )
    if len(rows) >= _KPI_VALUE_BUDGET:
        logger.warning("kb goals tree: Messwert-Budget %d erreicht — Reihen sind "
                       "gekappt, Fortschritt kann zu niedrig wirken", _KPI_VALUE_BUDGET)
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(str(r["kpi_id"]), []).append(
            {"ts": r["ts"], "value": float(r["value"]),
             "source": r["source"], "note": r["note"]})
    return out


def _kpi_node(row, series: list[dict]) -> dict:
    props = row["properties"]
    if isinstance(props, str):
        props = json.loads(props)
    prog = kpi_progress.compute(props, series)
    # Source and last failure belong visibly on the card; a silent adapter
    # would otherwise look like "not measured yet".
    return {"id": str(row["id"]), "title": row["title"], "icon": row["icon"],
            "owner": row["owner"], "progress": prog,
            "source": props.get("source") if isinstance(props.get("source"), dict) else None,
            "source_error": props.get("source_error")
                            if isinstance(props.get("source_error"), dict) else None}


@router.get("/goals/tree")
async def goals_tree(request: Request, root_id: str | None = None, max_depth: int = 8):
    """Goal tree with progress and traffic light per node.

    Without `root_id`: all visible visions/goals without a goal parent. A goal's
    progress comes from its own KPIs AND its sub-goals (weighted mean); the
    traffic light takes the worst state, so a green goal cannot hide a red KPI.
    """
    await _ensure_tables()
    user = _caller(request)
    max_depth = max(1, min(max_depth, 16))
    types = list(GOAL_TREE_TYPES)
    async with user_tx(user) as conn:
        if root_id:
            root_id = _uuid(root_id, "root_id")
            await _fetch_visible(conn, root_id, user)   # 404 instead of an existence leak
            root_where = "o.id = $3::uuid"
            params: list = [user, types, root_id, max_depth]
        else:
            root_where = ("(o.parent_id IS NULL OR NOT EXISTS "
                          "(SELECT 1 FROM claraos_kb_objects p "
                          " WHERE p.id = o.parent_id AND p.type = ANY($2)))")
            params = [user, types, max_depth]
        depth_param = f"${len(params)}"
        rows = await conn.fetch(
            f"""
            WITH RECURSIVE tree AS (
                SELECT o.id, o.parent_id, o.type, o.title, o.icon, o.owner,
                       o.properties, o.stage, o.position, 0 AS depth
                FROM claraos_kb_objects o
                WHERE o.type = ANY($2) AND {root_where} AND {_vis_alias('o', '$1')}
                UNION ALL
                SELECT o.id, o.parent_id, o.type, o.title, o.icon, o.owner,
                       o.properties, o.stage, o.position, t.depth + 1
                FROM claraos_kb_objects o
                JOIN tree t ON o.parent_id = t.id
                WHERE o.type = ANY($2) AND t.depth < {depth_param}
                  AND {_vis_alias('o', '$1')}
            )
            SELECT * FROM tree ORDER BY depth, position NULLS LAST, title
            """,
            *params,
        )
        node_ids = [str(r["id"]) for r in rows]
        kpi_rows: list = []
        edges: list = []
        if node_ids:
            # KPIs of the goals, VISIBLE ones only (someone else's private KPI
            # must not leak through the tree).
            edges = await conn.fetch(
                f"""
                SELECT l.from_id, l.to_id, o.id, o.title, o.icon, o.owner, o.properties
                FROM claraos_kb_links l
                JOIN claraos_kb_objects o ON o.id = l.to_id
                WHERE l.rel = 'measured_by' AND l.from_id = ANY($2::uuid[])
                  AND o.type = 'kpi' AND {_vis_alias('o', '$1')}
                """,
                user, node_ids,
            )
            kpi_rows = edges
        series = await _series_for(conn, sorted({str(e["id"]) for e in kpi_rows}))

    # KPIs per goal
    kpis_by_goal: dict[str, list[dict]] = {}
    for e in kpi_rows:
        kpis_by_goal.setdefault(str(e["from_id"]), []).append(
            _kpi_node(e, series.get(str(e["id"]), [])))

    # Build nodes, attach children
    nodes: dict[str, dict] = {}
    order: list[str] = []
    for r in rows:
        nid = str(r["id"])
        if nid in nodes:            # guard against multiple paths in the tree
            continue
        props = r["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        nodes[nid] = {
            "id": nid, "type": r["type"], "title": r["title"], "icon": r["icon"],
            "owner": r["owner"], "stage": r["stage"], "depth": r["depth"],
            "parent_id": str(r["parent_id"]) if r["parent_id"] else None,
            "properties": props, "kpis": kpis_by_goal.get(nid, []), "children": [],
        }
        order.append(nid)
    roots: list[dict] = []
    for nid in order:
        parent = nodes[nid]["parent_id"]
        (nodes[parent]["children"] if parent in nodes else roots).append(nodes[nid])

    # Progress bottom-up (deepest nodes first)
    for nid in reversed(order):
        n = nodes[nid]
        parts = [{"attainment": k["progress"]["attainment"],
                  "status": k["progress"]["status"],
                  "weight": k["progress"].get("weight") or 1.0} for k in n["kpis"]]
        parts += [{"attainment": c["progress"]["attainment"],
                   "status": c["progress"]["status"],
                   "weight": kpi_progress.normalize_def(c["properties"])["weight"]}
                  for c in n["children"]]
        n["progress"] = kpi_progress.aggregate(parts)
    return {"tree": roots, "count": len(order)}


# ── Action plan: goal ↔ planner ─────────────────────────────────────────────
# Important: Vikunja stays the ONLY source of truth for tasks. Status, due date
# and assignee are never copied here, only read. The Idea Suite holds only the
# link and the "why".
# Important: no import from planner.py (keeps the routers decoupled): everything
# goes through the loopback with a service token, like promote_idea_to_plan.

_PLANNER = "http://localhost:8090/api/claraos/planner"


def _goal_uri(goal_id: str) -> str:
    return f"claraos://ideas/object/{goal_id}"


async def _planner_call(method: str, path: str, user: str, request: Request,
                        *, json_body=None, params=None):
    headers = service_headers(user, request.headers.get("x-claraos-actor") or None)
    async with httpx.AsyncClient(timeout=45.0, headers=headers) as client:
        return await client.request(method, f"{_PLANNER}{path}", json=json_body, params=params)


async def _require_goal(conn, goal_id: str, user: str, owner_only: bool):
    row = await (_require_owner if owner_only else _fetch_visible)(conn, goal_id, user)
    if row["type"] not in GOAL_TREE_TYPES:
        raise HTTPException(status_code=400, detail="Objekt ist kein Ziel und keine Vision")
    return row


@router.post("/goals/{goal_id}/action-plan")
async def goal_create_action_plan(goal_id: str, request: Request):
    """Create an action plan = one Vikunja project for this goal.

    Idempotent: if the goal already has a project id, it is returned instead
    of creating a second project.
    """
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        row = await _require_goal(conn, goal_id, user, owner_only=True)
        props = row["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        if props.get("planner_project_id"):
            return {"ok": True, "project_id": props["planner_project_id"], "created": False}

    # Important: deliberately the generic proxy (`PUT projects`) instead of
    # `/clara/create_project_from_plan`: the latter requires at least ONE task
    # (422 on an empty list) since it is Clara's planning endpoint. A fresh action
    # plan is empty, though, and an invented placeholder task in the user's
    # planner would be worse than none.
    resp = await _planner_call("PUT", "/api/projects", user, request, json_body={
        "title": row["title"],
        "description": f"Aktionsplan zum Ziel „{row['title']}“ (Ideen-App).",
    })
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502,
                            detail=f"Planner lehnte die Projekt-Anlage ab ({resp.status_code})")
    project_id = (resp.json() or {}).get("id")
    if not project_id:
        raise HTTPException(status_code=502, detail="Planner lieferte keine Projekt-Nummer")

    props["planner_project_id"] = project_id
    async with user_tx(user) as conn:
        await conn.execute(
            "UPDATE claraos_kb_objects SET properties = $2::jsonb, updated_at = NOW() "
            "WHERE id = $1::uuid", goal_id, _jsonb(props))
        await conn.execute(
            "INSERT INTO claraos_kb_activity (object_id, actor, kind, content, meta) "
            "VALUES ($1::uuid, $2, 'handoff', $3, $4::jsonb)",
            goal_id, actor, f"Aktionsplan im Planner angelegt (Projekt {project_id}).",
            _jsonb({"planner_project_id": project_id}))
    return {"ok": True, "project_id": project_id, "created": True}


@router.get("/goals/{goal_id}/action-plan")
async def goal_action_plan(goal_id: str, request: Request):
    """Action plan status, live from Vikunja, nothing mirrored.

    Two sources are merged: the tasks of the goal's project AND individual
    tasks from other projects that are linked to this goal.
    """
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        row = await _require_goal(conn, goal_id, user, owner_only=False)
    props = row["properties"]
    if isinstance(props, str):
        props = json.loads(props)
    project_id = props.get("planner_project_id")

    tasks: list[dict] = []
    warnung = None
    if project_id:
        resp = await _planner_call("GET", f"/api/projects/{project_id}/tasks", user, request,
                                   params={"page": 1, "per_page": 250})
        if resp.status_code == 200 and isinstance(resp.json(), list):
            tasks = [{"project_id": project_id, "task_id": t.get("id"), "title": t.get("title"),
                      "done": bool(t.get("done")), "due_date": t.get("due_date")}
                     for t in resp.json() if isinstance(t, dict)]
        else:
            # Do not swallow: an unreadable project is not an empty plan.
            warnung = f"Projekt {project_id} nicht lesbar (HTTP {resp.status_code})"

    linked = await _planner_call("GET", "/by-object", user, request, params={"object_id": goal_id})
    if linked.status_code == 200:
        known = {(t["project_id"], t["task_id"]) for t in tasks}
        for t in (linked.json() or {}).get("tasks", []):
            if (t["project_id"], t["task_id"]) not in known:
                tasks.append(t)
    elif warnung is None:
        warnung = f"Verknüpfte Aufgaben nicht lesbar (HTTP {linked.status_code})"

    done = sum(1 for t in tasks if t["done"])
    faellig = sorted(t["due_date"] for t in tasks
                     if not t["done"] and t.get("due_date") and not str(t["due_date"]).startswith("0001"))
    return {
        "project_id": project_id,
        "total": len(tasks), "done": done, "open": len(tasks) - done,
        # Important: deliberately separate from KPI progress: 80 % of tasks done at
        # 20 % goal achievement is exactly the information you want to see.
        "next_due": faellig[0] if faellig else None,
        "tasks": tasks[:100],
        "warning": warnung,
    }


class GoalTaskLink(BaseModel):
    project_id: int
    task_id: int


@router.post("/goals/{goal_id}/tasks")
async def goal_link_task(goal_id: str, body: GoalTaskLink, request: Request):
    """Make an existing task contribute to this goal."""
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        row = await _require_goal(conn, goal_id, user, owner_only=False)
    resp = await _planner_call("POST", "/meta/links", user, request, json_body={
        "project_id": body.project_id, "task_id": body.task_id,
        "link": {"kind": "goal", "uri": _goal_uri(goal_id), "label": f"🎯 {row['title']}"},
    })
    if resp.status_code != 200:
        raise HTTPException(status_code=502,
                            detail=f"Verknüpfung im Planner fehlgeschlagen ({resp.status_code})")
    return {"ok": True}


@router.delete("/goals/{goal_id}/tasks/{task_id}")
async def goal_unlink_task(goal_id: str, task_id: int, project_id: int, request: Request):
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    resp = await _planner_call("POST", "/meta/links", user, request, json_body={
        "project_id": project_id, "task_id": task_id, "remove": True,
        "link": {"kind": "goal", "uri": _goal_uri(goal_id)},
    })
    if resp.status_code != 200:
        raise HTTPException(status_code=502,
                            detail=f"Lösen der Verknüpfung fehlgeschlagen ({resp.status_code})")
    return {"ok": True}


# ── Ideas, concepts, impact/effort ──────────────────────────────────────────
# Warning: Clara suggests, the human decides. Suggestions are NOT stored, and
# Clara's estimate lands only in `meta.suggested` on the edge until someone
# confirms it. A tool that sets priorities unasked loses trust at the first
# mistake.

def _rating_from_meta(meta) -> dict:
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except ValueError:
            meta = {}
    return meta if isinstance(meta, dict) else {}


async def _upsert_contribution(conn, object_id: str, goal_id: str, actor: str,
                               patch: dict) -> dict:
    """Create an idea/concept → goal edge or update its rating.

    Merging happens in SQL (`meta || $patch`) so that a confirmed rating and a
    Clara suggestion arriving afterwards do not overwrite each other.
    """
    row = await conn.fetchrow(
        """
        INSERT INTO claraos_kb_links (from_id, to_id, rel, created_by, meta)
        VALUES ($1::uuid, $2::uuid, 'contributes_to', $3, $4::jsonb)
        ON CONFLICT (from_id, to_id, rel) DO UPDATE
            SET meta = claraos_kb_links.meta || $4::jsonb
        RETURNING id, meta
        """,
        object_id, goal_id, actor, _jsonb(patch))
    return {"link_id": str(row["id"]), "meta": _rating_from_meta(row["meta"])}


class SuggestIdeas(BaseModel):
    n: int = 5


@router.post("/goals/{goal_id}/suggest-ideas")
async def goal_suggest_ideas(goal_id: str, body: SuggestIdeas, request: Request):
    """Clara suggests ideas for the goal; NOTHING is stored.

    The return value is a list of suggestions; only "accept" creates an
    object. This keeps the idea space clean when a suggestion is off.
    """
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
    try:
        ideas = await kb_strategist.suggest_ideas(goal_id, user, body.n)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ideas": ideas}


class AcceptIdea(BaseModel):
    title: str
    why: str | None = None
    effort: int | None = None
    impact: int | None = None


@router.post("/goals/{goal_id}/ideas")
async def goal_accept_idea(goal_id: str, body: AcceptIdea, request: Request,
                           background: BackgroundTasks):
    """Accept a suggestion: create the idea and attach it to the goal.

    The supplied estimate counts as confirmed by the human (they just accepted
    the suggestion), so it goes straight into the edge.
    """
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
    obj = await _create_object(user, actor, ObjectCreate(
        type="idea", title=body.title,
        body=f"{body.why}\n" if body.why else "", stage="spark"), background)
    patch = {"rated_by": user, "rated_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    if body.impact is not None:
        patch["impact"] = max(1, min(5, int(body.impact)))
    if body.effort is not None:
        patch["effort"] = max(1, min(5, int(body.effort)))
    async with user_tx(user) as conn:
        link = await _upsert_contribution(conn, obj["id"], goal_id, actor, patch)
    return {"object": obj, **link}


class DevelopConcept(BaseModel):
    goal_id: str | None = None


@router.post("/objects/{idea_id}/develop-concept")
async def object_develop_concept(idea_id: str, body: DevelopConcept, request: Request,
                                 background: BackgroundTasks):
    """Turn an idea into a concept with a fixed outline.

    The concept is a separate object (`derived_from` → idea) so the raw idea
    is kept: later you want to see where something came from.
    """
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    idea_id = _uuid(idea_id, "idea_id")
    goal_id = _uuid(body.goal_id, "goal_id") if body.goal_id else None
    async with user_tx(user) as conn:
        await _fetch_visible(conn, idea_id, user)
        if goal_id:
            await _require_goal(conn, goal_id, user, owner_only=False)
    try:
        draft = await kb_strategist.develop_concept(idea_id, user, goal_id)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    obj = await _create_object(user, actor, ObjectCreate(
        type="concept", title=draft["title"], body=draft["body"],
        properties=draft["structured"], stage="developing"), background)
    async with user_tx(user) as conn:
        await conn.execute(
            "INSERT INTO claraos_kb_links (from_id, to_id, rel, created_by) "
            "VALUES ($1::uuid, $2::uuid, 'derived_from', $3) ON CONFLICT DO NOTHING",
            obj["id"], idea_id, actor)
        link = None
        if goal_id:
            # Clara's estimate stays a SUGGESTION; the human confirms it in the
            # matrix by dragging or clicking.
            link = await _upsert_contribution(conn, obj["id"], goal_id, actor, {
                "suggested": {"impact": draft["impact"], "effort": draft["effort"],
                              "reason": "Schätzung aus der Konzeptausarbeitung"}})
    return {"object": obj, **(link or {})}


class RatingSet(BaseModel):
    impact: int
    effort: int


@router.post("/goals/{goal_id}/contributions/{object_id}")
async def goal_set_contribution(goal_id: str, object_id: str, body: RatingSet,
                                request: Request):
    """Set the rating; this is the human's confirmation."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id, object_id = _uuid(goal_id, "goal_id"), _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
        await _require_owner(conn, object_id, user)
        link = await _upsert_contribution(conn, object_id, goal_id, actor, {
            "impact": max(1, min(5, body.impact)),
            "effort": max(1, min(5, body.effort)),
            "rated_by": user,
            "rated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        })
    return link


@router.post("/goals/{goal_id}/contributions/{object_id}/rate")
async def goal_rate_contribution(goal_id: str, object_id: str, request: Request):
    """Clara estimates; the result lands ONLY under `suggested`."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id, object_id = _uuid(goal_id, "goal_id"), _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
        await _fetch_visible(conn, object_id, user)
    try:
        est = await kb_strategist.rate_contribution(object_id, goal_id, user)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    async with user_tx(user) as conn:
        link = await _upsert_contribution(conn, object_id, goal_id, actor,
                                          {"suggested": est})
    return {"suggested": est, **link}


@router.delete("/goals/{goal_id}/contributions/{object_id}")
async def goal_remove_contribution(goal_id: str, object_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    goal_id, object_id = _uuid(goal_id, "goal_id"), _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_owner(conn, object_id, user)
        res = await conn.execute(
            "DELETE FROM claraos_kb_links WHERE from_id = $1::uuid AND to_id = $2::uuid "
            "AND rel = 'contributes_to'", object_id, goal_id)
    if int(res.split()[-1] or 0) == 0:
        raise HTTPException(status_code=404, detail="Verknüpfung nicht gefunden")
    return {"ok": True}


@router.get("/goals/{goal_id}/matrix")
async def goal_matrix(goal_id: str, request: Request):
    """All ideas/concepts contributing to this goal, with their ratings.

    Important: the rating lives on the EDGE, not on the object: the same idea
    can rate very differently for another goal. That is why the matrix is
    always filtered to ONE goal.
    """
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        goal = await _require_goal(conn, goal_id, user, owner_only=False)
        rows = await conn.fetch(
            f"""
            SELECT l.id AS link_id, l.meta, o.id, o.type, o.title, o.stage, o.owner,
                   left(o.body, 280) AS body_preview
            FROM claraos_kb_links l
            JOIN claraos_kb_objects o ON o.id = l.from_id
            WHERE l.to_id = $2::uuid AND l.rel = 'contributes_to'
              AND {_vis_alias('o', '$1')}
            ORDER BY o.updated_at DESC LIMIT 300
            """,
            user, goal_id)
    items = []
    for r in rows:
        meta = _rating_from_meta(r["meta"])
        suggested = meta.get("suggested") if isinstance(meta.get("suggested"), dict) else None
        items.append({
            "link_id": str(r["link_id"]), "id": str(r["id"]), "type": r["type"],
            "title": r["title"], "stage": r["stage"], "owner": r["owner"],
            "body_preview": r["body_preview"],
            "impact": meta.get("impact"), "effort": meta.get("effort"),
            "rated_by": meta.get("rated_by"),
            # Report the suggestion separately; the UI shows it faded until
            # someone confirms it.
            "suggested": suggested,
        })
    return {"goal": {"id": goal_id, "title": goal["title"]}, "items": items}


@router.post("/goals/{goal_id}/promote/{object_id}")
async def goal_promote_to_plan(goal_id: str, object_id: str, request: Request):
    """Move an idea/concept into the action plan: a real task in the goal's project.

    Creates the action plan on demand as well; otherwise you would have to
    click somewhere else first just to continue here.
    """
    await _ensure_tables()
    user = _caller(request)
    goal_id, object_id = _uuid(goal_id, "goal_id"), _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        goal = await _require_goal(conn, goal_id, user, owner_only=True)
        obj = await _fetch_visible(conn, object_id, user)
        props = goal["properties"]
        if isinstance(props, str):
            props = json.loads(props)

    project_id = props.get("planner_project_id")
    if not project_id:
        created = await goal_create_action_plan(goal_id, request)
        project_id = created["project_id"]

    resp = await _planner_call("PUT", f"/api/projects/{project_id}/tasks", user, request,
                               json_body={"title": obj["title"][:250],
                                          "description": (obj["body"] or "")[:4000]})
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502,
                            detail=f"Aufgabe konnte nicht angelegt werden ({resp.status_code})")
    task_id = (resp.json() or {}).get("id")

    # Back reference: the task points to the goal, the object remembers the task.
    await _planner_call("POST", "/meta/links", user, request, json_body={
        "project_id": project_id, "task_id": task_id,
        "link": {"kind": "goal", "uri": _goal_uri(goal_id), "label": f"🎯 {goal['title']}"}})
    async with user_tx(user) as conn:
        oprops = obj["properties"]
        if isinstance(oprops, str):
            oprops = json.loads(oprops)
        oprops["planner_task_id"] = task_id
        oprops["planner_project_id"] = project_id
        await conn.execute(
            "UPDATE claraos_kb_objects SET properties = $2::jsonb, stage = 'planned', "
            "updated_at = NOW() WHERE id = $1::uuid", object_id, _jsonb(oprops))
        await conn.execute(
            "INSERT INTO claraos_kb_activity (object_id, actor, kind, content, meta) "
            "VALUES ($1::uuid, $2, 'handoff', $3, $4::jsonb)",
            object_id, _actor(request, user),
            f"In den Aktionsplan von „{goal['title']}“ übernommen (Aufgabe {task_id}).",
            _jsonb({"planner_project_id": project_id, "planner_task_id": task_id}))
    return {"ok": True, "project_id": project_id, "task_id": task_id}


# ── Root-cause analysis: 5 Whys and Pareto ───────────────────────────────────
# Important: these are triggered not from a menu item but from a red goal;
# tools you have to go looking for never get used.
# Warning: both methods depend on human knowledge: 5 Whys asks step by step
# (Clara only offers candidate answers), Pareto computes with numbers the human
# enters. An automatic cause distribution would be show without substance.

class WhyStep(BaseModel):
    problem: str
    chain: list[dict] = []


@router.post("/goals/{goal_id}/five-why/step")
async def goal_five_why_step(goal_id: str, body: WhyStep, request: Request):
    """Next "why" question + candidate answers. Stores nothing."""
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
    try:
        return await kb_strategist.five_why_step(goal_id, user, body.problem, body.chain)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/goals/{goal_id}/five-why")
async def goal_five_why_finish(goal_id: str, body: WhyStep, request: Request,
                               background: BackgroundTasks):
    """Evaluate the chain and record it as an analysis object on the goal."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        goal = await _require_goal(conn, goal_id, user, owner_only=False)
    try:
        result = await kb_strategist.five_why_finish(goal_id, user, body.problem, body.chain)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    obj = await _create_object(user, actor, ObjectCreate(
        type="analysis", title=f"5-Why: {body.problem}"[:180],
        body=kb_strategist.five_why_markdown(body.problem, body.chain, result),
        properties={"method": "five_why", "problem": body.problem,
                    "why_chain": body.chain, "root_cause": result["root_cause"],
                    "countermeasures": result["countermeasures"],
                    "goal_title": goal["title"]}), background)
    async with user_tx(user) as conn:
        await conn.execute(
            "INSERT INTO claraos_kb_links (from_id, to_id, rel, created_by) "
            "VALUES ($1::uuid, $2::uuid, 'derived_from', $3) ON CONFLICT DO NOTHING",
            obj["id"], goal_id, actor)
    return {"object": obj, **result}


class ParetoRequest(BaseModel):
    problem: str
    items: list[dict] = []
    cutoff: float = 0.8


@router.post("/goals/{goal_id}/pareto/causes")
async def goal_pareto_causes(goal_id: str, body: WhyStep, request: Request):
    """Cause candidates for the breakdown, WITHOUT numbers (the human enters those)."""
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
    try:
        return await kb_strategist.pareto_causes(goal_id, user, body.problem)
    except kb_strategist.StrategistError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/goals/{goal_id}/pareto")
async def goal_pareto(goal_id: str, body: ParetoRequest, request: Request,
                      background: BackgroundTasks):
    """Compute Pareto and record it as an analysis object.

    The computation is pure (services/kaizen_pareto.py) and returns a
    plain-text error for unusable input instead of silent numbers.
    """
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        goal = await _require_goal(conn, goal_id, user, owner_only=False)

    result = kaizen_pareto.analyse(body.items, body.cutoff)
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])

    obj = await _create_object(user, actor, ObjectCreate(
        type="analysis", title=f"Pareto: {body.problem}"[:180],
        body=kaizen_pareto.markdown(body.problem, result),
        properties={"method": "pareto", "problem": body.problem,
                    "pareto": result["items"], "vital_few": result["vital_few"],
                    "total": result["total"], "unit": result["unit"],
                    "concentration": result["concentration"],
                    "goal_title": goal["title"]}), background)
    async with user_tx(user) as conn:
        await conn.execute(
            "INSERT INTO claraos_kb_links (from_id, to_id, rel, created_by) "
            "VALUES ($1::uuid, $2::uuid, 'derived_from', $3) ON CONFLICT DO NOTHING",
            obj["id"], goal_id, actor)
    return {"object": obj, "result": result}


@router.get("/goals/{goal_id}/analyses")
async def goal_analyses(goal_id: str, request: Request):
    """All analyses for this goal (newest first)."""
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        await _require_goal(conn, goal_id, user, owner_only=False)
        rows = await conn.fetch(
            f"""
            SELECT o.id, o.title, o.properties, o.created_at
            FROM claraos_kb_links l JOIN claraos_kb_objects o ON o.id = l.from_id
            WHERE l.to_id = $2::uuid AND l.rel = 'derived_from'
              AND o.type = 'analysis' AND {_vis_alias('o', '$1')}
            ORDER BY o.created_at DESC LIMIT 50
            """, user, goal_id)
    out = []
    for r in rows:
        props = r["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        out.append({"id": str(r["id"]), "title": r["title"],
                    "method": props.get("method"), "problem": props.get("problem"),
                    "root_cause": props.get("root_cause"),
                    "countermeasures": props.get("countermeasures") or [],
                    "vital_few": props.get("vital_few") or [],
                    "pareto": props.get("pareto") or [],
                    "unit": props.get("unit"),
                    "created_at": r["created_at"].isoformat()})
    return {"analyses": out}


class PlanTaskCreate(BaseModel):
    title: str
    description: str | None = None


@router.post("/goals/{goal_id}/action-plan/tasks")
async def goal_add_plan_task(goal_id: str, body: PlanTaskCreate, request: Request):
    """Put a countermeasure directly into the action plan as a task.

    Without this path you would first have to build an object from an analysis
    just to promote it again, even though the measure is already decided.
    """
    await _ensure_tables()
    user = _caller(request)
    goal_id = _uuid(goal_id, "goal_id")
    async with user_tx(user) as conn:
        goal = await _require_goal(conn, goal_id, user, owner_only=True)
        props = goal["properties"]
        if isinstance(props, str):
            props = json.loads(props)
    project_id = props.get("planner_project_id")
    if not project_id:
        project_id = (await goal_create_action_plan(goal_id, request))["project_id"]

    resp = await _planner_call("PUT", f"/api/projects/{project_id}/tasks", user, request,
                               json_body={"title": body.title[:250],
                                          "description": (body.description or "")[:4000]})
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502,
                            detail=f"Aufgabe konnte nicht angelegt werden ({resp.status_code})")
    task_id = (resp.json() or {}).get("id")
    await _planner_call("POST", "/meta/links", user, request, json_body={
        "project_id": project_id, "task_id": task_id,
        "link": {"kind": "goal", "uri": _goal_uri(goal_id), "label": f"🎯 {goal['title']}"}})
    return {"ok": True, "project_id": project_id, "task_id": task_id}


# ── Flat /clara/ routes for the strategy tools ──────────────────────────────
# The tools gateway only knows fixed URLs without path parameters, hence thin
# wrappers around the same functions. Identity still comes from the trusted
# headers, never from the model's arguments.

class ClaraGoalRef(BaseModel):
    goal_id: str
    n: int = 5


class ClaraObjectGoal(BaseModel):
    object_id: str
    goal_id: str
    impact: int | None = None
    effort: int | None = None


@router.post("/clara/list_goals")
async def clara_list_goals(request: Request):
    """All visible goals with traffic light, so Clara can map "my fitness goal"
    to an id at all."""
    tree = await goals_tree(request)

    def flatten(nodes, out, tiefe=0):
        for n in nodes:
            out.append({
                "id": n["id"], "type": n["type"], "title": n["title"], "depth": tiefe,
                "status": n["progress"]["status"], "attainment": n["progress"]["attainment"],
                "kpis": [{"title": k["title"], "current": k["progress"]["current"],
                          "target": k["progress"]["target"], "unit": k["progress"]["unit"],
                          "status": k["progress"]["status"]} for k in n["kpis"]],
            })
            flatten(n["children"], out, tiefe + 1)
        return out

    return {"goals": flatten(tree["tree"], [])}


@router.post("/clara/suggest_ideas")
async def clara_suggest_ideas(body: ClaraGoalRef, request: Request):
    return await goal_suggest_ideas(body.goal_id, SuggestIdeas(n=body.n), request)


@router.post("/clara/develop_concept")
async def clara_develop_concept(body: ClaraObjectGoal, request: Request,
                                background: BackgroundTasks):
    return await object_develop_concept(
        body.object_id, DevelopConcept(goal_id=body.goal_id), request, background)


@router.post("/clara/rate_contribution")
async def clara_rate_contribution(body: ClaraObjectGoal, request: Request):
    return await goal_rate_contribution(body.goal_id, body.object_id, request)


@router.post("/clara/link_to_goal")
async def clara_link_to_goal(body: ClaraObjectGoal, request: Request):
    if body.impact is None or body.effort is None:
        raise HTTPException(status_code=400,
                            detail="impact und effort (je 1-5) sind Pflicht")
    return await goal_set_contribution(
        body.goal_id, body.object_id, RatingSet(impact=body.impact, effort=body.effort), request)


@router.post("/clara/promote_to_action_plan")
async def clara_promote_to_action_plan(body: ClaraObjectGoal, request: Request):
    return await goal_promote_to_plan(body.goal_id, body.object_id, request)


class ClaraFiveWhy(BaseModel):
    goal_id: str
    problem: str
    chain: list[dict] = []
    finish: bool = False


@router.post("/clara/run_five_why")
async def clara_run_five_why(body: ClaraFiveWhy, request: Request,
                             background: BackgroundTasks):
    """The chat is the natural place for the chain: Clara asks the question and
    the user answers in the same conversation. `finish=true` evaluates and
    creates the analysis."""
    step = WhyStep(problem=body.problem, chain=body.chain)
    if body.finish:
        return await goal_five_why_finish(body.goal_id, step, request, background)
    return await goal_five_why_step(body.goal_id, step, request)


class ClaraPareto(BaseModel):
    goal_id: str
    problem: str
    items: list[dict] = []


@router.post("/clara/pareto_analysis")
async def clara_pareto_analysis(body: ClaraPareto, request: Request,
                                background: BackgroundTasks):
    """Without items: suggest cause candidates. With items: compute and create
    the analysis."""
    if not body.items:
        return await goal_pareto_causes(
            body.goal_id, WhyStep(problem=body.problem), request)
    return await goal_pareto(
        body.goal_id, ParetoRequest(problem=body.problem, items=body.items),
        request, background)


class KpiValueAdd(BaseModel):
    value: float
    ts: str | None = None
    note: str | None = None
    source: str = "manual"


async def _require_kpi(conn, kpi_id: str, user: str, owner_only: bool):
    row = await (_require_owner if owner_only else _fetch_visible)(conn, kpi_id, user)
    if row["type"] != "kpi":
        raise HTTPException(status_code=400, detail="Objekt ist keine Kennzahl")
    return row


@router.get("/kpi/{kpi_id}/values")
async def kpi_values(kpi_id: str, request: Request, limit: int = 200):
    await _ensure_tables()
    user = _caller(request)
    kpi_id = _uuid(kpi_id, "kpi_id")
    async with user_tx(user) as conn:
        await _require_kpi(conn, kpi_id, user, owner_only=False)
        rows = await conn.fetch(
            "SELECT id, ts, value, source, note, created_by FROM claraos_kb_kpi_values "
            "WHERE kpi_id = $1::uuid ORDER BY ts DESC LIMIT $2",
            kpi_id, max(1, min(limit, 2000)),
        )
    return {"values": [
        {"id": str(r["id"]), "ts": r["ts"].isoformat(), "value": float(r["value"]),
         "source": r["source"], "note": r["note"], "created_by": r["created_by"]}
        for r in rows
    ]}


@router.post("/kpi/{kpi_id}/values")
async def kpi_add_value(kpi_id: str, body: KpiValueAdd, request: Request):
    """Record a measurement. Same timestamp + same source = correction."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    kpi_id = _uuid(kpi_id, "kpi_id")
    _validate(body.source, KPI_SOURCES, "source")
    ts = _parse_ts(body.ts)
    async with user_tx(user) as conn:
        await _require_kpi(conn, kpi_id, user, owner_only=True)
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_kb_kpi_values (kpi_id, ts, value, source, note, created_by)
            VALUES ($1::uuid, $2, $3, $4, $5, $6)
            ON CONFLICT (kpi_id, ts, source) DO UPDATE
                SET value = EXCLUDED.value, note = EXCLUDED.note
            RETURNING id
            """,
            kpi_id, ts, body.value, body.source, body.note, actor,
        )
    return {"ok": True, "value_id": str(row["id"])}


@router.delete("/kpi/{kpi_id}/values/{value_id}")
async def kpi_delete_value(kpi_id: str, value_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    kpi_id, value_id = _uuid(kpi_id, "kpi_id"), _uuid(value_id, "value_id")
    async with user_tx(user) as conn:
        await _require_kpi(conn, kpi_id, user, owner_only=True)
        res = await conn.execute(
            "DELETE FROM claraos_kb_kpi_values WHERE id = $1::uuid AND kpi_id = $2::uuid",
            value_id, kpi_id)
    if int(res.split()[-1] or 0) == 0:
        raise HTTPException(status_code=404, detail="Messwert nicht gefunden")
    return {"ok": True}


class MilestoneAdd(BaseModel):
    date: str
    value: float
    label: str | None = None


@router.post("/kpi/{kpi_id}/milestones")
async def kpi_add_milestone(kpi_id: str, body: MilestoneAdd, request: Request):
    """Set a milestone. Same date = correction, not a duplicate."""
    await _ensure_tables()
    user = _caller(request)
    kpi_id = _uuid(kpi_id, "kpi_id")
    tag = _parse_ts(body.date).date().isoformat()
    async with user_tx(user) as conn:
        row = await _require_kpi(conn, kpi_id, user, owner_only=True)
        props = row["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        rest = [m for m in (props.get("milestones") or [])
                if isinstance(m, dict) and str(m.get("date"))[:10] != tag]
        rest.append({"date": tag, "value": body.value,
                     "label": (body.label or "").strip()[:80]})
        rest.sort(key=lambda m: str(m.get("date")))
        props["milestones"] = rest
        await conn.execute(
            "UPDATE claraos_kb_objects SET properties = $2::jsonb, updated_at = NOW() "
            "WHERE id = $1::uuid", kpi_id, _jsonb(props))
    return {"ok": True, "milestones": rest}


@router.delete("/kpi/{kpi_id}/milestones/{tag}")
async def kpi_delete_milestone(kpi_id: str, tag: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    kpi_id = _uuid(kpi_id, "kpi_id")
    async with user_tx(user) as conn:
        row = await _require_kpi(conn, kpi_id, user, owner_only=True)
        props = row["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        rest = [m for m in (props.get("milestones") or [])
                if isinstance(m, dict) and str(m.get("date"))[:10] != tag[:10]]
        props["milestones"] = rest
        await conn.execute(
            "UPDATE claraos_kb_objects SET properties = $2::jsonb, updated_at = NOW() "
            "WHERE id = $1::uuid", kpi_id, _jsonb(props))
    return {"ok": True, "milestones": rest}


@router.get("/kpi/{kpi_id}/progress")
async def kpi_progress_one(kpi_id: str, request: Request):
    """Progress of a KPI including the series for the chart."""
    await _ensure_tables()
    user = _caller(request)
    kpi_id = _uuid(kpi_id, "kpi_id")
    async with user_tx(user) as conn:
        row = await _require_kpi(conn, kpi_id, user, owner_only=False)
        series = (await _series_for(conn, [kpi_id])).get(kpi_id, [])
    props = row["properties"]
    if isinstance(props, str):
        props = json.loads(props)
    return {
        "kpi": {"id": kpi_id, "title": row["title"], "icon": row["icon"]},
        "progress": kpi_progress.compute(props, series),
        "series": [{"ts": s["ts"].isoformat(), "value": s["value"]} for s in series],
        "source": props.get("source") if isinstance(props.get("source"), dict) else None,
        "source_error": props.get("source_error") if isinstance(props.get("source_error"), dict) else None,
    }


# Dashboard order: problems first. An overview that shows "all achieved" in the
# top left and hides the red ones at the bottom is a sedative; the eye goes to
# the top left first (F-pattern).
# Important: `observing` goes explicitly last: a KPI still collecting its
# baseline is nothing to act on. It belongs at the end of the overview, not next
# to the blind ones (that would again confuse lack with intent).
_DASH_RANG = {"behind": 0, "at_risk": 1, "blind": 2, "on_track": 3, "done": 4,
              "observing": 5}


@router.get("/kpi/dashboard")
async def kpi_dashboard(request: Request, days: int = 90):
    """All visible KPIs at a glance, for the overview.

    Important: ONE query for all series (`_series_for` batches), not one per
    tile. With ten KPIs that would otherwise be ten round trips just to open a
    dashboard.

    `days` trims ONLY the returned series for the chart; progress is always
    computed on the full history. Otherwise a narrow time range would shift the
    baseline and recolor the traffic light without anything having changed.
    """
    await _ensure_tables()
    user = _caller(request)
    days = max(7, min(days, 3650))
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            f"""
            SELECT o.id, o.title, o.icon, o.owner, o.properties, o.updated_at,
                   g.id AS goal_id, g.title AS goal_title
            FROM claraos_kb_objects o
            LEFT JOIN claraos_kb_links l ON l.to_id = o.id AND l.rel = 'measured_by'
            LEFT JOIN claraos_kb_objects g ON g.id = l.from_id AND g.deleted_at IS NULL
            WHERE o.type = 'kpi' AND o.deleted_at IS NULL AND {_vis_alias('o', '$1')}
            """,
            user,
        )
        series = await _series_for(conn, sorted({str(r["id"]) for r in rows}))

    grenze = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    kpis = []
    gesehen: set[str] = set()
    for r in rows:
        kid = str(r["id"])
        if kid in gesehen:          # a KPI may hang off several goals
            continue
        gesehen.add(kid)
        props = r["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        voll = series.get(kid, [])
        fortschritt = kpi_progress.compute(props, voll)
        kurz = [s for s in voll
                if s["ts"].replace(tzinfo=s["ts"].tzinfo or dt.timezone.utc) >= grenze]
        kpis.append({
            "id": kid,
            "title": r["title"],
            "goal": ({"id": str(r["goal_id"]), "title": r["goal_title"]}
                     if r["goal_id"] else None),
            "progress": fortschritt,
            "series": [{"ts": s["ts"].isoformat(), "value": s["value"]} for s in kurz],
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        })

    kpis.sort(key=lambda k: (_DASH_RANG.get(k["progress"]["status"], 9),
                             -(k["progress"].get("weight") or 1),
                             (k["title"] or "").lower()))
    return {"kpis": kpis,
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "days": days}


@router.post("/kpi/{kpi_id}/collect")
async def kpi_collect_now(kpi_id: str, request: Request):
    """"Fetch now": gets the value immediately instead of waiting for the schedule.

    Deliberately bypasses the fetch interval (force) so a freshly configured
    source can be tried right away. Errors come back as plain text AND are
    stored on the object, so the card still shows them later.
    """
    await _ensure_tables()
    user = _caller(request)
    kpi_id = _uuid(kpi_id, "kpi_id")
    async with user_tx(user) as conn:
        await _require_kpi(conn, kpi_id, user, owner_only=True)
        row = await conn.fetchrow(
            "SELECT id, title, owner, properties FROM claraos_kb_objects WHERE id = $1::uuid", kpi_id)
        result = await kpi_collector.collect_one(conn, row, force=True)
    return {"result": result}


# ── Shares: share objects with individual users ─────────────────────────────
# UI only (no Clara tool: sharing is deliberately a human action).

class ShareAdd(BaseModel):
    username: str


@router.get("/objects/{object_id}/shares")
async def list_shares(object_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_owner(conn, object_id, user)
        rows = await conn.fetch(
            "SELECT shared_with, created_at FROM claraos_kb_shares "
            "WHERE object_id = $1::uuid ORDER BY shared_with",
            object_id,
        )
    return {"shares": [r["shared_with"] for r in rows]}


@router.post("/objects/{object_id}/shares")
async def add_share(object_id: str, body: ShareAdd, request: Request,
                    background: BackgroundTasks):
    """Share the object with a user and set visibility='shared'
    (unless it is already 'family', which is broader)."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    target = body.username.strip().lower()
    if not target:
        raise HTTPException(status_code=400, detail="username darf nicht leer sein")
    if target == user:
        raise HTTPException(status_code=400, detail="Mit dir selbst musst du nicht teilen")

    # Warning: this path must check reachability. Without it anyone could deliver
    # anything to anyone. The reachability rule ("team/contacts only") is a SERVER
    # rule; if it lived in the UI, anyone could bypass it with a direct call
    # (a tile is not a permission).
    from services import kontakte_regeln as _regeln
    try:
        darf, grund = await _regeln.darf_erreichen(user, target)
    except Exception as exc:                       # noqa: BLE001
        logger.warning("Erreichbarkeitspruefung fehlgeschlagen (%s→%s): %s", user, target, exc)
        darf, grund = False, "nicht pruefbar"      # when in doubt, deny
    if not darf:
        raise HTTPException(
            status_code=409,
            detail=f"{target} nimmt derzeit nichts von dir an ({grund}).")

    async with user_tx(user) as conn:
        row = await _require_owner(conn, object_id, user)
        await conn.execute(
            "INSERT INTO claraos_kb_shares (object_id, shared_with, created_by) "
            "VALUES ($1::uuid, $2, $3) ON CONFLICT DO NOTHING",
            object_id, target, user,
        )
        if row["visibility"] == "private":
            await conn.execute(
                "UPDATE claraos_kb_objects SET visibility = 'shared', rag_status = 'pending', "
                "updated_at = NOW() WHERE id = $1::uuid",
                object_id,
            )
        else:
            await conn.execute(
                "UPDATE claraos_kb_objects SET rag_status = 'pending' WHERE id = $1::uuid",
                object_id,
            )
    background.add_task(kb_indexer.index_object, object_id)
    return {"ok": True}


@router.delete("/objects/{object_id}/shares/{username}")
async def remove_share(object_id: str, username: str, request: Request,
                       background: BackgroundTasks):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_owner(conn, object_id, user)
        await conn.execute(
            "DELETE FROM claraos_kb_shares WHERE object_id = $1::uuid AND shared_with = $2",
            object_id, username.strip().lower(),
        )
        remaining = await conn.fetchval(
            "SELECT count(*) FROM claraos_kb_shares WHERE object_id = $1::uuid", object_id)
        # last recipient removed → back to private (no zombie 'shared')
        await conn.execute(
            "UPDATE claraos_kb_objects SET rag_status = 'pending', updated_at = NOW()"
            + (", visibility = 'private'" if remaining == 0 else "")
            + " WHERE id = $1::uuid AND visibility = 'shared'",
            object_id,
        )
    background.add_task(kb_indexer.index_object, object_id)
    return {"ok": True}


# ── Collections ─────────────────────────────────────────────────────────────

class CollectionCreate(BaseModel):
    name: str
    icon: str | None = None
    description: str | None = None
    default_type: str | None = None
    visibility: str = "private"


class CollectionPatch(BaseModel):
    name: str | None = None
    icon: str | None = None
    description: str | None = None
    default_type: str | None = None
    visibility: str | None = None
    # Row templates + lock. Open JSONB like the views: the meaning lives in the
    # frontend, the server only stores it.
    settings: dict | None = None


COLL_PERMISSIONS = ("read", "write")


def _row_coll(r, user: str | None = None, share_permission: str | None = None) -> dict:
    d = dict(r)
    d["id"] = str(d["id"])
    # The caller's role on the collection: the frontend should not guess
    # (by comparing owner) but read what the server enforces.
    sp = d.pop("share_permission", None) or share_permission
    if user is not None:
        if d.get("owner") == user:
            d["permission"] = "owner"
        elif sp in COLL_PERMISSIONS:
            d["permission"] = sp
        else:
            d["permission"] = "read"
        d["is_owner"] = d["permission"] == "owner"
        d["can_edit"] = d["permission"] in ("owner", "write")
    for k in ("created_at", "updated_at"):
        if k in d and d[k]:
            d[k] = d[k].isoformat()
    # asyncpg returns JSONB as text when no codec is set.
    if isinstance(d.get("settings"), str):
        d["settings"] = json.loads(d["settings"])
    d.setdefault("settings", {})
    return d


async def _fetch_coll(conn, collection_id: str, user: str, owner_only: bool = False,
                      write: bool = False):
    """Load a collection if visible (ownership, 'family' or share), otherwise 404.
    `write`: owner or 'write' share (content, fields, views).
    `owner_only`: owner only (delete, visibility, shares)."""
    row = await conn.fetchrow(
        "SELECT c.*, _cs.permission AS share_permission FROM claraos_kb_collections c "
        "LEFT JOIN claraos_kb_collection_shares _cs "
        "  ON _cs.collection_id = c.id AND _cs.shared_with = $2 "
        "WHERE c.id = $1::uuid AND (c.owner = $2 OR c.visibility = 'family' "
        "  OR _cs.shared_with IS NOT NULL)",
        collection_id, user,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Sammlung nicht gefunden")
    if owner_only and row["owner"] != user:
        raise HTTPException(status_code=403, detail="Nur der Besitzer darf diese Sammlung ändern")
    if write and row["owner"] != user and row["share_permission"] != "write":
        raise HTTPException(status_code=403,
                            detail="Dafür braucht es Schreibrecht an dieser Sammlung")
    return row


@router.get("/collections")
async def list_collections(request: Request):
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            """
            SELECT c.*, count(ci.object_id) AS item_count, _cs.permission AS share_permission
            FROM claraos_kb_collections c
            LEFT JOIN claraos_kb_collection_items ci ON ci.collection_id = c.id
            LEFT JOIN claraos_kb_collection_shares _cs
                   ON _cs.collection_id = c.id AND _cs.shared_with = $1
            WHERE c.owner = $1 OR c.visibility = 'family' OR _cs.shared_with IS NOT NULL
            GROUP BY c.id, _cs.permission ORDER BY c.name
            """,
            user,
        )
    return {"collections": [_row_coll(r, user) for r in rows]}


@router.post("/collections")
async def create_collection(body: CollectionCreate, request: Request):
    await _ensure_tables()
    user = _caller(request)
    _validate(body.visibility, COLL_VISIBILITIES, "visibility")
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name darf nicht leer sein")
    async with user_tx(user) as conn:
        if body.default_type:
            t = await conn.fetchrow("SELECT id FROM claraos_kb_types WHERE id = $1", body.default_type)
            if not t:
                raise HTTPException(status_code=400, detail=f"Unbekannter Typ: {body.default_type!r}")
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_kb_collections (owner, visibility, name, icon, description, default_type)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
            """,
            user, body.visibility, body.name.strip(), body.icon, body.description, body.default_type,
        )
    return {"collection": _row_coll(row, user)}


@router.patch("/collections/{collection_id}")
async def patch_collection(collection_id: str, body: CollectionPatch, request: Request):
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    _validate(body.visibility, COLL_VISIBILITIES, "visibility")
    async with user_tx(user) as conn:
        cur = await _fetch_coll(conn, collection_id, user, write=True)
        if body.visibility is not None and cur["owner"] != user:
            raise HTTPException(status_code=403, detail="Die Sichtbarkeit ändert nur der Besitzer")
        sets, params = ["updated_at = NOW()"], [collection_id]
        for col in ("name", "icon", "description", "default_type", "visibility"):
            val = getattr(body, col)
            if val is not None:
                params.append(val.strip() if col == "name" else val)
                sets.append(f"{col} = ${len(params)}")
        if body.settings is not None:
            params.append(json.dumps(body.settings))
            sets.append(f"settings = ${len(params)}::jsonb")
        row = await conn.fetchrow(
            f"UPDATE claraos_kb_collections SET {', '.join(sets)} WHERE id = $1::uuid RETURNING *",
            *params,
        )
    return {"collection": _row_coll(row, user, cur["share_permission"])}


@router.delete("/collections/{collection_id}")
async def delete_collection(collection_id: str, request: Request):
    """Delete ONLY the collection (item membership via CASCADE); objects remain."""
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    async with user_tx(user) as conn:
        await _fetch_coll(conn, collection_id, user, owner_only=True)
        await conn.execute("DELETE FROM claraos_kb_collections WHERE id = $1::uuid", collection_id)
    return {"ok": True}


class ItemAdd(BaseModel):
    object_id: str
    position: float = 0


@router.post("/collections/{collection_id}/items")
async def add_collection_item(collection_id: str, body: ItemAdd, request: Request,
                              background: BackgroundTasks):
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    collection_id = _uuid(collection_id, "collection_id")
    object_id = _uuid(body.object_id, "object_id")
    async with user_tx(user) as conn:
        await _fetch_coll(conn, collection_id, user, write=True)
        await _fetch_visible(conn, object_id, user)
        await conn.execute(
            """
            INSERT INTO claraos_kb_collection_items (collection_id, object_id, position, added_by)
            VALUES ($1::uuid, $2::uuid, $3, $4)
            ON CONFLICT (collection_id, object_id) DO UPDATE SET position = EXCLUDED.position
            """,
            collection_id, object_id, body.position, actor,
        )
    # Update the vector payload (collection shares in search)
    background.add_task(kb_indexer.update_collection_ids, object_id)
    return {"ok": True}


@router.delete("/collections/{collection_id}/items/{object_id}")
async def remove_collection_item(collection_id: str, object_id: str, request: Request,
                                 background: BackgroundTasks):
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _fetch_coll(conn, collection_id, user, write=True)
        await conn.execute(
            "DELETE FROM claraos_kb_collection_items WHERE collection_id = $1::uuid AND object_id = $2::uuid",
            collection_id, object_id,
        )
    background.add_task(kb_indexer.update_collection_ids, object_id)
    return {"ok": True}


class CollShareAdd(BaseModel):
    username: str
    permission: str = "read"


class CollSharePatch(BaseModel):
    permission: str


def _row_coll_share(r) -> dict:
    return {"username": r["shared_with"], "permission": r["permission"],
            "created_by": r["created_by"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None}


@router.get("/collections/{collection_id}/shares")
async def list_collection_shares(collection_id: str, request: Request):
    """Who has access? Visible to every member, so users can see within a
    collection who has access to it."""
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    async with user_tx(user) as conn:
        coll = await _fetch_coll(conn, collection_id, user)
        rows = await conn.fetch(
            "SELECT shared_with, permission, created_by, created_at "
            "FROM claraos_kb_collection_shares WHERE collection_id = $1::uuid ORDER BY shared_with",
            collection_id)
    me = _row_coll(coll, user)
    return {"owner": coll["owner"], "visibility": coll["visibility"],
            "permission": me["permission"], "shares": [_row_coll_share(r) for r in rows]}


async def _push_collection_share(recipient: str, actor: str, coll_name: str,
                                 collection_id: str, permission: str) -> None:
    try:
        from services import ntfy_publish
        was = "bearbeiten" if permission == "write" else "lesen und kommentieren"
        await ntfy_publish.notify_users(
            [recipient], f"{actor} hat die Sammlung „{coll_name}“ mit dir geteilt",
            f"Du kannst darin {was}. In der Wissens-App unter Sammlungen.",
            app_id="knowledge", action="open_collection",
            args={"collection_id": str(collection_id)})
    except Exception as exc:  # noqa: BLE001
        logger.info("ntfy push skipped: %s", exc)


@router.post("/collections/{collection_id}/shares")
async def add_collection_share(collection_id: str, body: CollShareAdd, request: Request,
                               background: BackgroundTasks):
    """Share a collection with a user (read = read + comment, write = also edit
    and create notes, change fields/views). Deleting, visibility and shares stay
    with the owner."""
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    target = body.username.strip().lower()
    if not target:
        raise HTTPException(status_code=400, detail="username darf nicht leer sein")
    if target == user:
        raise HTTPException(status_code=400, detail="Mit dir selbst musst du nicht teilen")
    _validate(body.permission, COLL_PERMISSIONS, "permission")
    # Same server-side gate as for object shares: the recipient's reachability
    # rule decides, not the UI.
    from services import kontakte_regeln as _regeln
    try:
        darf, grund = await _regeln.darf_erreichen(user, target)
    except Exception as exc:                       # noqa: BLE001
        logger.warning("Erreichbarkeitspruefung fehlgeschlagen (%s→%s): %s", user, target, exc)
        darf, grund = False, "nicht pruefbar"
    if not darf:
        raise HTTPException(status_code=409,
                            detail=f"{target} nimmt derzeit nichts von dir an ({grund}).")
    async with user_tx(user) as conn:
        coll = await _fetch_coll(conn, collection_id, user, owner_only=True)
        row = await conn.fetchrow(
            "INSERT INTO claraos_kb_collection_shares (collection_id, shared_with, permission, created_by) "
            "VALUES ($1::uuid, $2, $3, $4) "
            "ON CONFLICT (collection_id, shared_with) DO UPDATE SET permission = EXCLUDED.permission "
            "RETURNING shared_with, permission, created_by, created_at, (xmax = 0) AS inserted",
            collection_id, target, body.permission, user)
    if row["inserted"]:
        background.add_task(_push_collection_share, target, user, coll["name"],
                            collection_id, body.permission)
    return {"ok": True, "share": _row_coll_share(row)}


@router.patch("/collections/{collection_id}/shares/{username}")
async def patch_collection_share(collection_id: str, username: str, body: CollSharePatch,
                                 request: Request):
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    _validate(body.permission, COLL_PERMISSIONS, "permission")
    async with user_tx(user) as conn:
        await _fetch_coll(conn, collection_id, user, owner_only=True)
        row = await conn.fetchrow(
            "UPDATE claraos_kb_collection_shares SET permission = $3 "
            "WHERE collection_id = $1::uuid AND shared_with = $2 "
            "RETURNING shared_with, permission, created_by, created_at",
            collection_id, username.strip().lower(), body.permission)
    if not row:
        raise HTTPException(status_code=404, detail="Freigabe nicht gefunden")
    return {"ok": True, "share": _row_coll_share(row)}


@router.delete("/collections/{collection_id}/shares/{username}")
async def remove_collection_share(collection_id: str, username: str, request: Request):
    """The owner removes someone, or a member leaves the collection themselves."""
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    target = username.strip().lower()
    async with user_tx(user) as conn:
        coll = await _fetch_coll(conn, collection_id, user)
        if coll["owner"] != user and target != user:
            raise HTTPException(status_code=403, detail="Nur der Besitzer darf Freigaben entfernen")
        await conn.execute(
            "DELETE FROM claraos_kb_collection_shares WHERE collection_id = $1::uuid AND shared_with = $2",
            collection_id, target)
    return {"ok": True}


# ── Web clipper: save a page as an object ──────────────────────────────────
# The fetch itself is secured in services/kb_clip.py (SSRF); only storage is
# added here. The result is a normal knowledge object of type "research": it is
# indexed, searchable, and Clara can work with it.

class ClipRequest(BaseModel):
    url: str
    selection: str = ""      # text selected in the browser (bookmarklet/share)
    note: str = ""           # own note
    title: str | None = None
    collection_id: str | None = None
    visibility: str = "private"
    fetch_page: bool = True  # false = only save selection/note (no fetch)


async def _clip_to_object(user: str, actor: str, body: ClipRequest,
                          background: BackgroundTasks) -> dict:
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL fehlt")
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    data = {"title": "", "markdown": "", "description": ""}
    warning = None
    if body.fetch_page:
        try:
            final_url, html_text = await kb_clip.fetch(url)
            data = kb_clip.extract(html_text, final_url)
            url = final_url
        except kb_clip.ClipError as exc:
            # Do NOT swallow rejection/errors, but still create the clip: the user
            # has the page in front of them.
            warning = str(exc)
        except Exception as exc:  # noqa: BLE001
            warning = f"Seite konnte nicht geladen werden ({type(exc).__name__})"
    title = (body.title or data.get("title") or url)[:280]
    md = kb_clip.build_body(url, data, body.selection, body.note)
    if warning:
        md += f"\n\n> ⚠ {warning}\n"
    obj = await _create_object(
        user, actor,
        ObjectCreate(type="research", title=title, body=md,
                     visibility=body.visibility,
                     properties={"quelle": url, "status": "offen"}),
        background)
    if body.collection_id:
        async with user_tx(user) as conn:
            await _fetch_coll(conn, _uuid(body.collection_id, "collection_id"), user,
                              write=True)
            await conn.execute(
                "INSERT INTO claraos_kb_collection_items (collection_id, object_id, position, added_by) "
                "VALUES ($1::uuid, $2::uuid, 0, $3) ON CONFLICT DO NOTHING",
                _uuid(body.collection_id, "collection_id"), obj["id"], actor)
    return {"object": obj, "warning": warning,
            "chars": len(data.get("markdown") or "")}


@router.post("/clip")
async def clip_page(body: ClipRequest, request: Request, background: BackgroundTasks):
    """Web clipper (UI/bookmarklet/share target)."""
    await _ensure_tables()
    user = _caller(request)
    return await _clip_to_object(user, _actor(request, user), body, background)


@router.get("/clip/bookmarklet")
async def clip_bookmarklet(request: Request):
    """Return the bookmarklet code. Deliberately a bookmark instead of a browser
    extension: works in every browser (mobile too), without installation, store
    approval or update maintenance."""
    await _ensure_tables()
    _caller(request)
    js = (
        "javascript:(function(){"
        "var s=window.getSelection?String(window.getSelection()):'';"
        "var n=prompt('Notiz zum Clip (optional):','');"
        "if(n===null)return;"
        f"fetch('https://home.{BASE_DOMAIN}/api/claraos/knowledge/clip',{{"
        "method:'POST',credentials:'include',"
        "headers:{'Content-Type':'application/json'},"
        "body:JSON.stringify({url:location.href,selection:s,note:n,title:document.title})"
        "}).then(function(r){return r.json()}).then(function(d){"
        "alert(d.object?('Gespeichert: '+d.object.title):'Fehler beim Speichern')"
        "}).catch(function(){alert('ClaraOS nicht erreichbar')});"
        "})();"
    )
    return {"bookmarklet": js,
            "hinweis": "Als Lesezeichen speichern und auf einer Seite anklicken. "
                       "Markierter Text wird mitgesichert."}


class ClaraClip(BaseModel):
    url: str
    note: str = ""
    collection_id: str | None = None


@router.post("/clara/clip_url")
async def clara_clip_url(body: ClaraClip, request: Request, background: BackgroundTasks):
    """Clara saves a web page to the knowledge base (type "research").
    Only publicly reachable addresses; the service rejects internal targets."""
    await _ensure_tables()
    user = _caller(request)
    res = await _clip_to_object(
        user, _actor(request, user),
        ClipRequest(url=body.url, note=body.note, collection_id=body.collection_id),
        background)
    o = res["object"]
    return {"ok": True, "object_id": o["id"], "title": o["title"],
            "extracted_chars": res["chars"], "warning": res["warning"]}


# ── Templates, duplicate, knowledge graph, backmentions, live query ────────

class TemplateCreate(BaseModel):
    name: str
    target_type: str | None = None
    body: str = ""
    icon: str | None = None
    default_properties: dict | None = None
    is_default: bool = False
    visibility: str = "private"
    # set = create the template from an existing object
    from_object_id: str | None = None


@router.get("/templates")
async def list_templates(request: Request, target_type: str | None = None):
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            "SELECT * FROM claraos_kb_templates "
            "WHERE (owner = $1 OR visibility = 'family') "
            "AND ($2::text IS NULL OR target_type = $2) ORDER BY is_default DESC, name",
            user, target_type)
    out = []
    for r in rows:
        d = dict(r)
        d["id"] = str(d["id"])
        if isinstance(d.get("default_properties"), str):
            d["default_properties"] = json.loads(d["default_properties"])
        for k in ("created_at", "updated_at"):
            d[k] = d[k].isoformat()
        out.append(d)
    return {"templates": out}


@router.post("/templates")
async def create_template(body: TemplateCreate, request: Request):
    """New template, either empty or from an existing object."""
    await _ensure_tables()
    user = _caller(request)
    tmpl_body, props, ttype = body.body, body.default_properties or {}, body.target_type
    async with user_tx(user) as conn:
        if body.from_object_id:
            src = await _fetch_visible(conn, _uuid(body.from_object_id, "from_object_id"), user)
            tmpl_body = src["body"] or ""
            ttype = ttype or src["type"]
            sp = src["properties"]
            props = json.loads(sp) if isinstance(sp, str) else (sp or {})
        if body.is_default and ttype:
            await conn.execute(
                "UPDATE claraos_kb_templates SET is_default = FALSE "
                "WHERE owner = $1 AND target_type = $2", user, ttype)
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_kb_templates
                (owner, visibility, name, icon, target_type, body, default_properties, is_default)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
            RETURNING id
            """,
            user, _validate(body.visibility, COLL_VISIBILITIES, "visibility") or "private",
            body.name.strip() or "Vorlage", body.icon, ttype, tmpl_body,
            _jsonb(props), body.is_default)
    return {"template": {"id": str(row["id"]), "name": body.name.strip()}}


@router.delete("/templates/{template_id}")
async def delete_template(template_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    template_id = _uuid(template_id, "template_id")
    async with user_tx(user) as conn:
        r = await conn.execute(
            "DELETE FROM claraos_kb_templates WHERE id = $1::uuid AND owner = $2",
            template_id, user)
    if r.endswith("0"):
        raise HTTPException(status_code=404, detail="Vorlage nicht gefunden")
    return {"ok": True}


class FromTemplate(BaseModel):
    template_id: str | None = None
    type: str | None = None       # without template_id: this type's default template
    title: str
    collection_id: str | None = None
    parent_id: str | None = None


@router.post("/objects/from-template")
async def create_from_template(body: FromTemplate, request: Request,
                               background: BackgroundTasks):
    """Object from a template. Resolution: explicit template → type default."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    async with user_tx(user) as conn:
        if body.template_id:
            t = await conn.fetchrow(
                "SELECT * FROM claraos_kb_templates WHERE id = $1::uuid "
                "AND (owner = $2 OR visibility = 'family')",
                _uuid(body.template_id, "template_id"), user)
        else:
            t = await conn.fetchrow(
                "SELECT * FROM claraos_kb_templates WHERE target_type = $1 "
                "AND (owner = $2 OR visibility = 'family') AND is_default "
                "ORDER BY owner = $2 DESC LIMIT 1", body.type, user)
        if not t and body.template_id:
            raise HTTPException(status_code=404, detail="Vorlage nicht gefunden")
        # The target collection is checked BEFORE the object exists: write
        # access (owner or 'write' share), the same rule as adding an item.
        # Otherwise any caller could hang objects into a collection they may
        # only read — or that is not theirs at all — and leave an orphan behind
        # when it fails.
        collection_id = None
        if body.collection_id:
            collection_id = _uuid(body.collection_id, "collection_id")
            await _fetch_coll(conn, collection_id, user, write=True)
    props = {}
    if t:
        dp = t["default_properties"]
        props = json.loads(dp) if isinstance(dp, str) else (dp or {})
    obj = await _create_object(
        user, actor,
        ObjectCreate(type=(t["target_type"] if t else None) or body.type or "note",
                     title=body.title, body=(t["body"] if t else ""),
                     properties=props, parent_id=body.parent_id),
        background)
    if collection_id:
        async with user_tx(user) as conn:
            # checked again in the writing transaction (a share may have been
            # revoked in between); the RLS policy of migration 043 is the net
            await _fetch_coll(conn, collection_id, user, write=True)
            await conn.execute(
                "INSERT INTO claraos_kb_collection_items (collection_id, object_id, position, added_by) "
                "VALUES ($1::uuid, $2::uuid, 0, $3) ON CONFLICT DO NOTHING",
                collection_id, obj["id"], actor)
    return {"object": obj, "from_template": str(t["id"]) if t else None}


@router.post("/objects/{object_id}/duplicate")
async def duplicate_object(object_id: str, request: Request, background: BackgroundTasks):
    """Copy including properties; comments/history stay with the original."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        src = await _fetch_visible(conn, object_id, user)
        sp = src["properties"]
        obj = await conn.fetchrow(
            f"""
            INSERT INTO claraos_kb_objects
                (type, owner, visibility, title, body, properties, stage, created_by,
                 parent_id, icon, cover)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
            RETURNING {_OBJ_COLS}
            """,
            src["type"], user, "private", f"{src['title']} (Kopie)", src["body"] or "",
            sp if isinstance(sp, str) else json.dumps(sp or {}), src["stage"], actor,
            src["parent_id"], src["icon"], src["cover"])
        # Carry over collection memberships — only into collections this user
        # may write (owner or 'write' share). The source may sit in a
        # collection the user can only read; the copy must not land there.
        await conn.execute(
            "INSERT INTO claraos_kb_collection_items (collection_id, object_id, position, added_by) "
            "SELECT ci.collection_id, $2::uuid, ci.position, $3 FROM claraos_kb_collection_items ci "
            "JOIN claraos_kb_collections c ON c.id = ci.collection_id "
            "WHERE ci.object_id = $1::uuid AND (c.owner = $4 OR EXISTS ("
            "  SELECT 1 FROM claraos_kb_collection_shares cs WHERE cs.collection_id = c.id "
            "  AND cs.shared_with = $4 AND cs.permission = 'write')) "
            "ON CONFLICT DO NOTHING",
            object_id, str(obj["id"]), actor, user)
    background.add_task(kb_indexer.index_object, str(obj["id"]))
    background.add_task(_post_save, str(obj["id"]), actor)
    return {"object": _row_obj(obj)}


@router.get("/knowledge-graph")
async def knowledge_graph(request: Request, limit: int = 300):
    """Knowledge Suite graph: nodes = visible objects, edges = kb_refs (mentions
    + relations). Edges only count when BOTH ends are visible, otherwise the
    graph would reveal other users' objects."""
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        nodes = await conn.fetch(
            f"SELECT id, title, type, icon FROM claraos_kb_objects "
            f"WHERE {_VIS.format(u='$1')} AND type <> ALL($3) "
            f"ORDER BY updated_at DESC LIMIT $2",
            user, max(10, min(limit, 500)), list(IDEA_SUITE_TYPES))
        ids = [str(n["id"]) for n in nodes]
        edges = await conn.fetch(
            "SELECT DISTINCT src_object_id, target_object_id, kind FROM claraos_kb_refs "
            "WHERE src_object_id = ANY($1::uuid[]) AND target_object_id = ANY($1::uuid[])",
            ids)
    return {
        "nodes": [{"id": str(n["id"]), "title": n["title"], "type": n["type"],
                   "icon": n["icon"]} for n in nodes],
        "edges": [{"from": str(e["src_object_id"]), "to": str(e["target_object_id"]),
                   "kind": e["kind"]} for e in edges],
    }


@router.get("/objects/{object_id}/backmentions")
async def backmentions(object_id: str, request: Request, limit: int = 20):
    """"Unlinked mentions" (SiYuan pattern): objects whose text contains the
    title but which are NOT already linked."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        obj = await _fetch_visible(conn, object_id, user)
        title = (obj["title"] or "").strip()
        if len(title) < 4:
            return {"backmentions": []}
        rows = await conn.fetch(
            f"""
            SELECT {_OBJ_COLS_Q} FROM claraos_kb_objects
            WHERE {_VIS.format(u='$1')}
              AND claraos_kb_objects.id <> $2::uuid
              AND (claraos_kb_objects.body ILIKE '%' || $3 || '%')
              AND NOT EXISTS (SELECT 1 FROM claraos_kb_refs r
                              WHERE r.src_object_id = claraos_kb_objects.id
                                AND r.target_object_id = $2::uuid)
            ORDER BY claraos_kb_objects.updated_at DESC LIMIT $4
            """,
            user, object_id, title, max(1, min(limit, 50)))
    return {"backmentions": [_row_obj(r, slim=True) for r in rows]}


class QueryResolve(BaseModel):
    q: str | None = None
    type: str | None = None
    collection_id: str | None = None
    limit: int = 20


@router.post("/query/resolve")
async def resolve_query(body: QueryResolve, request: Request):
    """Resolve a live query block (`{{query:…}}` in Markdown).

    Instead of mirroring blocks between pages (Notion's "synced blocks", which
    need their own sync graph), the block stores a SEARCH and shows its current
    result (SiYuan's "embed = query"). This composes with our full-text and RAG
    search instead of standing beside it."""
    await _ensure_tables()
    return await list_objects(
        request, type=body.type, q=body.q, collection_id=body.collection_id,
        limit=max(1, min(body.limit, 50)))


# ── Version diff, import, export ───────────────────────────────────────────

@router.get("/objects/{object_id}/history/{version}/diff")
async def diff_history_version(object_id: str, version: int, request: Request,
                               against: int | None = None):
    """Difference between two states, computed on read (Outline pattern).
    `against` = version to compare; without it, compare against the CURRENT state."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        obj = await _fetch_visible(conn, object_id, user)
        base = await conn.fetchrow(
            "SELECT version, title, body FROM claraos_kb_history "
            "WHERE object_id = $1::uuid AND version = $2", object_id, version)
        if not base:
            raise HTTPException(status_code=404, detail="Version nicht gefunden")
        if against is None:
            other_title, other_body, other_label = obj["title"], obj["body"], "aktuell"
        else:
            o = await conn.fetchrow(
                "SELECT version, title, body FROM claraos_kb_history "
                "WHERE object_id = $1::uuid AND version = $2", object_id, against)
            if not o:
                raise HTTPException(status_code=404, detail="Vergleichsversion nicht gefunden")
            other_title, other_body, other_label = o["title"], o["body"], f"v{o['version']}"
    ops = kb_diff.diff_markdown(base["body"], other_body)
    return {"from": {"version": base["version"], "title": base["title"]},
            "to": {"label": other_label, "title": other_title},
            "ops": ops, "summary": kb_diff.summarize(ops)}


class VersionRename(BaseModel):
    name: str


@router.patch("/objects/{object_id}/history/{version}")
async def rename_history_version(object_id: str, version: int, body: VersionRename,
                                 request: Request):
    """Named versions ("before the big rework"), an Outline feature."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        await _require_owner(conn, object_id, user)
        r = await conn.execute(
            "UPDATE claraos_kb_history SET name = $3 WHERE object_id = $1::uuid AND version = $2",
            object_id, version, body.name.strip()[:120] or None)
    if r.endswith("0"):
        raise HTTPException(status_code=404, detail="Version nicht gefunden")
    return {"ok": True}


@router.post("/import")
async def import_archive(request: Request, background: BackgroundTasks, file: UploadFile):
    """Import a Notion/Markdown export (ZIP).

    Two passes: first create all pages and databases, then rewrite the links
    in the Markdown to our objects, so Notion references become real backlinks
    (the post-save pipeline does the rest)."""
    await _ensure_tables()
    user = _caller(request)
    data = await file.read()
    if len(data) > 80 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Archiv zu groß (max. 80 MB)")
    try:
        parsed = kb_import.parse_zip(data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"ZIP konnte nicht gelesen werden: {exc}")

    id_map: dict[str, str] = {}   # Notion id → our UUID
    created_pages, created_rows, created_colls = [], 0, 0
    async with user_tx(user) as conn:
        # Pass 1: pages
        for p in parsed["pages"]:
            row = await conn.fetchrow(
                "INSERT INTO claraos_kb_objects (type, owner, visibility, title, body, created_by) "
                "VALUES ('note', $1, 'private', $2, $3, $1) RETURNING id",
                user, p["title"], p["body"])
            oid = str(row["id"])
            created_pages.append((oid, p))
            if p["notion_id"]:
                id_map[p["notion_id"]] = oid
        # Add the hierarchy (child pages)
        for oid, p in created_pages:
            parent_nid = p.get("parent_notion_id")
            if parent_nid and parent_nid in id_map and id_map[parent_nid] != oid:
                await conn.execute(
                    "UPDATE claraos_kb_objects SET parent_id = $2::uuid, position = $3 "
                    "WHERE id = $1::uuid",
                    oid, id_map[parent_nid], _frac_between(None, None))
        # Databases → collection + fields + rows
        for db in parsed["databases"]:
            coll = await conn.fetchrow(
                "INSERT INTO claraos_kb_collections (owner, visibility, name, default_type) "
                "VALUES ($1, 'private', $2, 'note') RETURNING id",
                user, db["name"])
            cid = str(coll["id"])
            created_colls += 1
            pos = None
            for col in db["columns"]:
                key = re.sub(r"[^\w-]", "_", col.strip().lower())[:64] or "feld"
                ftype = kb_import.guess_field_type([r["props"].get(col, "") for r in db["rows"]])
                pos = _frac_between(pos, None)
                await conn.execute(
                    "INSERT INTO claraos_kb_fields (collection_id, key, name, field_type, position) "
                    "VALUES ($1::uuid, $2, $3, $4, $5) ON CONFLICT (collection_id, key) DO NOTHING",
                    cid, key, col.strip()[:120] or key, ftype, pos)
            for r in db["rows"]:
                props = {re.sub(r"[^\w-]", "_", k.strip().lower())[:64]: v
                         for k, v in r["props"].items()}
                obj = await conn.fetchrow(
                    "INSERT INTO claraos_kb_objects (type, owner, visibility, title, properties, created_by) "
                    "VALUES ('note', $1, 'private', $2, $3::jsonb, $1) RETURNING id",
                    user, r["title"], json.dumps(props))
                await conn.execute(
                    "INSERT INTO claraos_kb_collection_items (collection_id, object_id, position, added_by) "
                    "VALUES ($1::uuid, $2::uuid, $3, $4) ON CONFLICT DO NOTHING",
                    cid, str(obj["id"]), created_rows, user)
                created_rows += 1

        # Pass 2: rewrite links (all ids are known now)
        rewritten = 0
        for oid, p in created_pages:
            new_body = kb_import.rewrite_links(p["body"], id_map)
            if new_body != p["body"]:
                await conn.execute(
                    "UPDATE claraos_kb_objects SET body = $2 WHERE id = $1::uuid", oid, new_body)
                rewritten += 1

    # Trigger indexing + refs/history (fire-and-forget)
    for oid, _ in created_pages:
        background.add_task(kb_indexer.index_object, oid)
        background.add_task(_post_save, oid, user)
    return {"ok": True, "pages": len(created_pages), "collections": created_colls,
            "rows": created_rows, "links_rewritten": rewritten}


@router.get("/export")
async def export_archive(request: Request, collection_id: str | None = None):
    """Everything visible (or one collection) as a ZIP: Markdown + CSV per collection."""
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        if collection_id:
            cid = _uuid(collection_id, "collection_id")
            coll = await _fetch_coll(conn, cid, user)
            rows = await conn.fetch(
                f"SELECT {_OBJ_COLS_Q} FROM claraos_kb_objects "
                f"JOIN claraos_kb_collection_items ci ON ci.object_id = claraos_kb_objects.id "
                f"WHERE ci.collection_id = $2::uuid AND {_VIS.format(u='$1')} "
                f"ORDER BY ci.position", user, cid)
            field_rows = await _ensure_fields(conn, cid, coll)
            cols = [f["name"] for f in field_rows]
            keys = [f["key"] for f in field_rows]
            colls = [{"name": coll["name"], "columns": cols, "rows": [
                {"title": r["title"],
                 "props": {c: str((json.loads(r["properties"]) if isinstance(r["properties"], str)
                                   else r["properties"] or {}).get(k, ""))
                           for c, k in zip(cols, keys)}}
                for r in rows]}]
        else:
            rows = await conn.fetch(
                f"SELECT {_OBJ_COLS} FROM claraos_kb_objects WHERE {_VIS.format(u='$1')} "
                f"ORDER BY updated_at DESC LIMIT 2000", user)
            colls = []
    objects = [{"title": r["title"], "body": r["body"],
                "properties": (json.loads(r["properties"]) if isinstance(r["properties"], str)
                               else r["properties"] or {})}
               for r in rows]
    blob = kb_import.build_export_zip(objects, colls)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    return Response(
        content=blob, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="knowledge-export-{stamp}.zip"'},
    )


# ── Inline comments + notifications ────────────────────────────────────────
# Anchor = quote + context (services/kb_anchor.py), NOT marked in the Markdown,
# so body stays clean Markdown (Clara/RAG unaffected) and comments survive edits.

class CommentCreate(BaseModel):
    body: str
    anchor_text: str = ""
    anchor_prefix: str = ""
    anchor_suffix: str = ""
    parent_id: str | None = None


class CommentPatch(BaseModel):
    body: str | None = None
    resolved: bool | None = None


async def _notify(conn, username: str, actor: str, object_id: str,
                  comment_id: str | None, kind: str, snippet: str) -> None:
    """In-app notification + ntfy push (best effort, never blocking)."""
    if not username or username == actor:
        return
    await conn.execute(
        "INSERT INTO claraos_kb_notifications (username, object_id, comment_id, kind, actor, snippet) "
        "VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6)",
        username, object_id, comment_id, kind, actor, snippet[:300])


async def _push_ntfy(recipients: list[str], title: str, message: str,
                     object_id: str | None = None) -> None:
    """Push to the personal ntfy topics (the existing service validates the
    recipients against the real list of people). Failure is never critical."""
    try:
        from services import ntfy_publish
        # Object target per the shell convention (tags `claraos-action=open_object`
        # + `claraos-arg-object_id=…`, click `?app=knowledge&do=open_object&object_id=…`).
        # A plain `&object=<id>` in the click URL is not understood by the shell and
        # would land on the app's start page instead of the object.
        await ntfy_publish.notify_users(
            [r for r in recipients if r and r != "clara"], title, message,
            app_id="knowledge",
            action="open_object" if object_id else None,
            args={"object_id": str(object_id)} if object_id else None,
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("ntfy push skipped: %s", exc)


@router.get("/objects/{object_id}/comments")
async def list_comments(object_id: str, request: Request, include_resolved: bool = True):
    """Comments including the resolved anchor position in the CURRENT body."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(object_id, "object_id")
    async with user_tx(user) as conn:
        obj = await _fetch_visible(conn, object_id, user)
        rows = await conn.fetch(
            "SELECT * FROM claraos_kb_comments WHERE object_id = $1::uuid AND deleted_at IS NULL "
            "ORDER BY created_at",
            object_id)
    body = obj["body"] or ""
    out = []
    for r in rows:
        anchor = kb_anchor.resolve_anchor(body, r["anchor_text"], r["anchor_prefix"], r["anchor_suffix"])
        if not include_resolved and r["resolved_at"]:
            continue
        out.append({
            "id": str(r["id"]),
            "parent_id": str(r["parent_id"]) if r["parent_id"] else None,
            "author": r["author"], "body": r["body"],
            "anchor_text": r["anchor_text"],
            "anchor_status": anchor["status"], "anchor_start": anchor["start"],
            "resolved": r["resolved_at"] is not None,
            "resolved_by": r["resolved_by"],
            "created_at": r["created_at"].isoformat(),
        })
    return {"comments": out}


@router.post("/objects/{object_id}/comments")
async def create_comment(object_id: str, body: CommentCreate, request: Request,
                         background: BackgroundTasks):
    """ANYONE who can see the object may comment ('family' visibility reads and comments)."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    object_id = _uuid(object_id, "object_id")
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="Kommentar darf nicht leer sein")
    parent_id = _uuid(body.parent_id, "parent_id") if body.parent_id else None
    async with user_tx(user) as conn:
        obj = await _fetch_visible(conn, object_id, user)
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_kb_comments
                (object_id, parent_id, author, body, anchor_text, anchor_prefix, anchor_suffix)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
            RETURNING id, created_at
            """,
            object_id, parent_id, actor, body.body.strip(),
            body.anchor_text[:2000], body.anchor_prefix[-80:], body.anchor_suffix[:80],
        )
        cid = str(row["id"])
        # Notify: object owner + previous thread participants (except oneself)
        recipients = {obj["owner"]}
        if parent_id:
            others = await conn.fetch(
                "SELECT DISTINCT author FROM claraos_kb_comments "
                "WHERE object_id = $1::uuid AND deleted_at IS NULL", object_id)
            recipients.update(o["author"] for o in others)
        recipients.discard("clara")
        for who in recipients:
            await _notify(conn, who, actor, object_id, cid,
                          "reply" if parent_id else "comment",
                          f"{actor}: {body.body.strip()[:160]}")
    push_to = [r for r in recipients if r != actor]
    if push_to:
        background.add_task(_push_ntfy, push_to,
                            f"💬 Kommentar zu „{obj['title'][:40]}“",
                            f"{actor}: {body.body.strip()[:200]}", object_id)
    return {"comment": {"id": cid, "author": actor,
                        "created_at": row["created_at"].isoformat()}}


@router.patch("/comments/{comment_id}")
async def patch_comment(comment_id: str, body: CommentPatch, request: Request):
    """Editing text: author only. Resolving: author OR object owner."""
    await _ensure_tables()
    user = _caller(request)
    comment_id = _uuid(comment_id, "comment_id")
    async with user_tx(user) as conn:
        c = await conn.fetchrow(
            "SELECT * FROM claraos_kb_comments WHERE id = $1::uuid AND deleted_at IS NULL", comment_id)
        if not c:
            raise HTTPException(status_code=404, detail="Kommentar nicht gefunden")
        obj = await _fetch_visible(conn, str(c["object_id"]), user)
        if body.body is not None:
            if c["author"] != user:
                raise HTTPException(status_code=403, detail="Nur der Autor darf den Text ändern")
            await conn.execute(
                "UPDATE claraos_kb_comments SET body = $2, updated_at = NOW() WHERE id = $1::uuid",
                comment_id, body.body.strip())
        if body.resolved is not None:
            if c["author"] != user and obj["owner"] != user:
                raise HTTPException(status_code=403,
                                    detail="Nur Autor oder Objekt-Besitzer dürfen das erledigen")
            await conn.execute(
                "UPDATE claraos_kb_comments SET resolved_at = $2, resolved_by = $3, updated_at = NOW() "
                "WHERE id = $1::uuid OR parent_id = $1::uuid",  # resolve the thread too (Outline pattern)
                comment_id,
                (dt.datetime.now(dt.timezone.utc) if body.resolved else None),
                (user if body.resolved else None))
    return {"ok": True}


@router.delete("/comments/{comment_id}")
async def delete_comment(comment_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    comment_id = _uuid(comment_id, "comment_id")
    async with user_tx(user) as conn:
        c = await conn.fetchrow(
            "SELECT author, object_id FROM claraos_kb_comments WHERE id = $1::uuid", comment_id)
        if not c:
            raise HTTPException(status_code=404, detail="Kommentar nicht gefunden")
        obj = await _fetch_visible(conn, str(c["object_id"]), user)
        if c["author"] != user and obj["owner"] != user:
            raise HTTPException(status_code=403, detail="Nur Autor oder Objekt-Besitzer dürfen löschen")
        await conn.execute(
            "UPDATE claraos_kb_comments SET deleted_at = NOW() WHERE id = $1::uuid OR parent_id = $1::uuid",
            comment_id)
    return {"ok": True}


@router.get("/notifications")
async def list_notifications(request: Request, unread_only: bool = False, limit: int = 50):
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            f"""
            SELECT n.id, n.object_id, n.comment_id, n.kind, n.actor, n.snippet,
                   n.read_at, n.created_at, o.title AS object_title
            FROM claraos_kb_notifications n
            LEFT JOIN claraos_kb_objects o ON o.id = n.object_id
            WHERE n.username = $1 {"AND n.read_at IS NULL" if unread_only else ""}
            ORDER BY n.created_at DESC LIMIT $2
            """,
            user, max(1, min(limit, 200)))
    return {"notifications": [
        {"id": str(r["id"]), "object_id": str(r["object_id"]) if r["object_id"] else None,
         "object_title": r["object_title"], "kind": r["kind"], "actor": r["actor"],
         "snippet": r["snippet"], "read": r["read_at"] is not None,
         "created_at": r["created_at"].isoformat()}
        for r in rows
    ]}


@router.post("/notifications/read")
async def mark_notifications_read(request: Request):
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        await conn.execute(
            "UPDATE claraos_kb_notifications SET read_at = NOW() "
            "WHERE username = $1 AND read_at IS NULL", user)
    return {"ok": True}


class ClaraComment(BaseModel):
    object_id: str
    body: str
    anchor_text: str = ""


@router.post("/clara/comment_on_object")
async def clara_comment_on_object(body: ClaraComment, request: Request,
                                  background: BackgroundTasks):
    """Clara comments on a specific TEXT PASSAGE. anchor_text must appear
    verbatim in the body, so Clara quotes instead of guessing positions."""
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(body.object_id, "object_id")
    prefix = suffix = ""
    if body.anchor_text:
        async with user_tx(user) as conn:
            obj = await _fetch_visible(conn, object_id, user)
        pos = (obj["body"] or "").find(body.anchor_text)
        if pos < 0:
            raise HTTPException(
                status_code=400,
                detail="anchor_text kommt so nicht im Text vor — bitte wörtlich zitieren")
        prefix = (obj["body"] or "")[max(0, pos - kb_anchor.CONTEXT_LEN):pos]
        suffix = (obj["body"] or "")[pos + len(body.anchor_text):
                                     pos + len(body.anchor_text) + kb_anchor.CONTEXT_LEN]
    res = await create_comment(
        object_id,
        CommentCreate(body=body.body, anchor_text=body.anchor_text,
                      anchor_prefix=prefix, anchor_suffix=suffix),
        request, background)
    return {"ok": True, "comment_id": res["comment"]["id"]}


# ── Fields + views + row query (databases) ─────────────────────────────────
# Field registry after the AppFlowy pattern (stable field_type ids + type_option),
# named views with saved filters/sorts (DatabaseViewSetting).
# Backward compatibility: collections without their own fields inherit their
# default_type's prop_schema ONCE, so nobody has to migrate anything.

_FIELD_KIND_TO_TYPE = {  # old prop_schema vocabulary → new field_type ids
    "text": kb_query.FT_TEXT, "number": kb_query.FT_NUMBER, "date": kb_query.FT_DATE,
    "select": kb_query.FT_SELECT, "multi_select": kb_query.FT_MULTI_SELECT,
    "url": kb_query.FT_URL, "checkbox": kb_query.FT_CHECKBOX,
}
_VALID_FIELD_TYPES = set(range(0, 15))  # includes 14 = formula


def _validate_formula_option(field_type: int, type_option: dict | None) -> None:
    """Formulas are validated at SAVE time: an unsafe or broken formula should
    never reach the database."""
    if field_type != kb_query.FT_FORMULA:
        return
    expr = (type_option or {}).get("expression", "")
    try:
        kb_formula.validate(expr)
    except kb_formula.FormulaError as exc:
        raise HTTPException(status_code=400, detail=f"Formel ungültig: {exc}")


class FieldCreate(BaseModel):
    key: str
    name: str
    field_type: int = 0
    type_option: dict | None = None
    is_primary: bool = False


class FieldPatch(BaseModel):
    name: str | None = None
    field_type: int | None = None
    type_option: dict | None = None


class ViewCreate(BaseModel):
    name: str
    layout: str = "table"
    layout_setting: dict | None = None
    filters: dict | None = None
    sorts: list | None = None
    group_setting: dict | None = None
    field_settings: dict | None = None


class ViewPatch(BaseModel):
    name: str | None = None
    layout: str | None = None
    layout_setting: dict | None = None
    filters: dict | None = None
    sorts: list | None = None
    group_setting: dict | None = None
    field_settings: dict | None = None


_LAYOUTS = ("table", "board", "gallery", "list", "calendar", "timeline")


def _row_field(r) -> dict:
    d = dict(r)
    d["id"] = str(d["id"])
    d["collection_id"] = str(d["collection_id"])
    if isinstance(d.get("type_option"), str):
        d["type_option"] = json.loads(d["type_option"])
    for k in ("created_at", "updated_at"):
        if d.get(k):
            d[k] = d[k].isoformat()
    return d


def _row_view(r) -> dict:
    d = dict(r)
    d["id"] = str(d["id"])
    d["collection_id"] = str(d["collection_id"])
    for k in ("layout_setting", "filters", "sorts", "group_setting", "field_settings"):
        if isinstance(d.get(k), str):
            d[k] = json.loads(d[k])
    for k in ("created_at", "updated_at"):
        if d.get(k):
            d[k] = d[k].isoformat()
    return d


async def _ensure_fields(conn, collection_id: str, coll_row) -> list:
    """Fields of the collection; materialized from the default_type's
    prop_schema on first access (backward compatibility, once)."""
    rows = await conn.fetch(
        "SELECT * FROM claraos_kb_fields WHERE collection_id = $1::uuid "
        "ORDER BY position NULLS LAST, created_at", collection_id)
    if rows:
        return rows
    default_type = coll_row["default_type"] if not isinstance(coll_row, dict) else coll_row.get("default_type")
    if not default_type:
        return []
    t = await conn.fetchrow("SELECT prop_schema FROM claraos_kb_types WHERE id = $1", default_type)
    if not t:
        return []
    schema = t["prop_schema"]
    if isinstance(schema, str):
        schema = json.loads(schema)
    pos = None
    for p in (schema or []):
        pos = _frac_between(pos, None)
        await conn.execute(
            """
            INSERT INTO claraos_kb_fields (collection_id, key, name, field_type, type_option, position)
            VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)
            ON CONFLICT (collection_id, key) DO NOTHING
            """,
            collection_id, p.get("key"), p.get("label") or p.get("key"),
            _FIELD_KIND_TO_TYPE.get(p.get("kind", "text"), kb_query.FT_TEXT),
            _jsonb({"options": p["options"]} if p.get("options") else {}), pos,
        )
    return await conn.fetch(
        "SELECT * FROM claraos_kb_fields WHERE collection_id = $1::uuid "
        "ORDER BY position NULLS LAST, created_at", collection_id)


@router.get("/collections/{collection_id}/fields")
async def list_fields(collection_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    async with user_tx(user) as conn:
        coll = await _fetch_coll(conn, collection_id, user)
        rows = await _ensure_fields(conn, collection_id, coll)
    return {"fields": [_row_field(r) for r in rows]}


@router.post("/collections/{collection_id}/fields")
async def create_field(collection_id: str, body: FieldCreate, request: Request):
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    if body.field_type not in _VALID_FIELD_TYPES:
        raise HTTPException(status_code=400, detail=f"Unbekannter field_type: {body.field_type}")
    _validate_formula_option(body.field_type, body.type_option)
    key = re.sub(r"[^\w-]", "_", body.key.strip())[:64]
    if not key:
        raise HTTPException(status_code=400, detail="key darf nicht leer sein")
    async with user_tx(user) as conn:
        coll = await _fetch_coll(conn, collection_id, user, write=True)
        await _ensure_fields(conn, collection_id, coll)
        last = await conn.fetchval(
            "SELECT MAX(position) FROM claraos_kb_fields WHERE collection_id = $1::uuid",
            collection_id)
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_kb_fields (collection_id, key, name, field_type, type_option, is_primary, position)
            VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7)
            ON CONFLICT (collection_id, key) DO UPDATE
              SET name = EXCLUDED.name, field_type = EXCLUDED.field_type,
                  type_option = EXCLUDED.type_option, updated_at = NOW()
            RETURNING *
            """,
            collection_id, key, body.name.strip(), body.field_type,
            _jsonb(body.type_option), body.is_primary, _frac_between(last, None),
        )
    return {"field": _row_field(row)}


@router.patch("/collections/{collection_id}/fields/{field_id}")
async def patch_field(collection_id: str, field_id: str, body: FieldPatch, request: Request):
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    field_id = _uuid(field_id, "field_id")
    if body.field_type is not None and body.field_type not in _VALID_FIELD_TYPES:
        raise HTTPException(status_code=400, detail=f"Unbekannter field_type: {body.field_type}")
    if body.type_option is not None and body.field_type is not None:
        _validate_formula_option(body.field_type, body.type_option)
    async with user_tx(user) as conn:
        await _fetch_coll(conn, collection_id, user, write=True)
        sets, params = ["updated_at = NOW()"], [field_id, collection_id]
        for col in ("name", "field_type"):
            val = getattr(body, col)
            if val is not None:
                params.append(val)
                sets.append(f"{col} = ${len(params)}")
        if body.type_option is not None:
            params.append(_jsonb(body.type_option))
            sets.append(f"type_option = ${len(params)}::jsonb")
        row = await conn.fetchrow(
            f"UPDATE claraos_kb_fields SET {', '.join(sets)} "
            f"WHERE id = $1::uuid AND collection_id = $2::uuid RETURNING *", *params)
    if not row:
        raise HTTPException(status_code=404, detail="Feld nicht gefunden")
    return {"field": _row_field(row)}


@router.delete("/collections/{collection_id}/fields/{field_id}")
async def delete_field(collection_id: str, field_id: str, request: Request):
    """Remove only the field DEFINITION; values in properties are kept
    (restore by creating the same key again)."""
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    field_id = _uuid(field_id, "field_id")
    async with user_tx(user) as conn:
        await _fetch_coll(conn, collection_id, user, write=True)
        await conn.execute(
            "DELETE FROM claraos_kb_fields WHERE id = $1::uuid AND collection_id = $2::uuid",
            field_id, collection_id)
    return {"ok": True}


@router.get("/collections/{collection_id}/views")
async def list_views(collection_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    async with user_tx(user) as conn:
        coll = await _fetch_coll(conn, collection_id, user)
        rows = await conn.fetch(
            "SELECT * FROM claraos_kb_views WHERE collection_id = $1::uuid "
            "ORDER BY position NULLS LAST, created_at", collection_id)
        if not rows:
            # Every collection has at least one default table view
            await conn.execute(
                "INSERT INTO claraos_kb_views (collection_id, name, layout, position, created_by) "
                "VALUES ($1::uuid, 'Alle Einträge', 'table', $2, $3)",
                collection_id, _frac_between(None, None), coll["owner"])
            rows = await conn.fetch(
                "SELECT * FROM claraos_kb_views WHERE collection_id = $1::uuid "
                "ORDER BY position NULLS LAST, created_at", collection_id)
    return {"views": [_row_view(r) for r in rows]}


@router.post("/collections/{collection_id}/views")
async def create_view(collection_id: str, body: ViewCreate, request: Request):
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    _validate(body.layout, _LAYOUTS, "layout")
    async with user_tx(user) as conn:
        await _fetch_coll(conn, collection_id, user, write=True)
        last = await conn.fetchval(
            "SELECT MAX(position) FROM claraos_kb_views WHERE collection_id = $1::uuid",
            collection_id)
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_kb_views (collection_id, name, layout, layout_setting, filters,
                                          sorts, group_setting, field_settings, position, created_by)
            VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
            RETURNING *
            """,
            collection_id, body.name.strip() or "Ansicht", body.layout,
            _jsonb(body.layout_setting), _jsonb(body.filters),
            json.dumps(body.sorts or []), _jsonb(body.group_setting),
            _jsonb(body.field_settings), _frac_between(last, None), user,
        )
    return {"view": _row_view(row)}


@router.patch("/collections/{collection_id}/views/{view_id}")
async def patch_view(collection_id: str, view_id: str, body: ViewPatch, request: Request):
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    view_id = _uuid(view_id, "view_id")
    if body.layout is not None:
        _validate(body.layout, _LAYOUTS, "layout")
    async with user_tx(user) as conn:
        await _fetch_coll(conn, collection_id, user, write=True)
        sets, params = ["updated_at = NOW()"], [view_id, collection_id]
        for col in ("name", "layout"):
            val = getattr(body, col)
            if val is not None:
                params.append(val.strip() if col == "name" else val)
                sets.append(f"{col} = ${len(params)}")
        for col in ("layout_setting", "filters", "group_setting", "field_settings"):
            val = getattr(body, col)
            if val is not None:
                params.append(_jsonb(val))
                sets.append(f"{col} = ${len(params)}::jsonb")
        if body.sorts is not None:
            params.append(json.dumps(body.sorts))
            sets.append(f"sorts = ${len(params)}::jsonb")
        row = await conn.fetchrow(
            f"UPDATE claraos_kb_views SET {', '.join(sets)} "
            f"WHERE id = $1::uuid AND collection_id = $2::uuid RETURNING *", *params)
    if not row:
        raise HTTPException(status_code=404, detail="Ansicht nicht gefunden")
    return {"view": _row_view(row)}


@router.delete("/collections/{collection_id}/views/{view_id}")
async def delete_view(collection_id: str, view_id: str, request: Request):
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    view_id = _uuid(view_id, "view_id")
    async with user_tx(user) as conn:
        await _fetch_coll(conn, collection_id, user, write=True)
        n = await conn.fetchval(
            "SELECT count(*) FROM claraos_kb_views WHERE collection_id = $1::uuid", collection_id)
        if n <= 1:
            raise HTTPException(status_code=400, detail="Die letzte Ansicht kann nicht gelöscht werden")
        await conn.execute(
            "DELETE FROM claraos_kb_views WHERE id = $1::uuid AND collection_id = $2::uuid",
            view_id, collection_id)
    return {"ok": True}


async def _rollup_values(conn, rows, fields, user: str) -> dict:
    """Rollups ON READ: for each rollup field, the aggregation over the target
    objects linked via relation. Visibility applies here too: other users'
    private targets do NOT flow into the sum (otherwise the number would leak)."""
    rollups = [f for f in fields if f["field_type"] == kb_query.FT_ROLLUP]
    if not rollups or not rows:
        return {}
    out: dict[str, dict] = {}
    for f in rollups:
        opt = f["type_option"]
        if isinstance(opt, str):
            opt = json.loads(opt)
        rel_key = opt.get("relation_field")
        target_key = opt.get("target_field")
        agg = (opt.get("aggregate") or "count").lower()
        if not rel_key or agg not in kb_query.AGGREGATES:
            continue
        for r in rows:
            props = r["properties"]
            if isinstance(props, str):
                props = json.loads(props)
            ids = props.get(rel_key) or []
            if not isinstance(ids, list) or not ids:
                continue
            valid = [str(i) for i in ids if isinstance(i, str) and len(i) == 36]
            if not valid:
                continue
            if agg == "count":
                val = await conn.fetchval(
                    f"SELECT count(*) FROM claraos_kb_objects "
                    f"WHERE id = ANY($1::uuid[]) AND {_VIS.format(u='$2')}", valid, user)
            else:
                p = kb_query.new_params(start=2)
                expr = kb_query.aggregate_expr(agg, target_key or "", p)
                val = await conn.fetchval(
                    f"SELECT {expr} FROM claraos_kb_objects "
                    f"WHERE id = ANY($1::uuid[]) AND {_VIS.format(u='$2')}",
                    valid, user, *p.values)
            out.setdefault(str(r["id"]), {})[f["key"]] = float(val) if val is not None else None
    return out


@router.get("/collections/{collection_id}/rows")
async def query_collection_rows(collection_id: str, request: Request,
                                view_id: str | None = None, limit: int = 200,
                                after: str | None = None):
    """Rows of a collection per a view's rules (filter/sort/group), compiled to
    SQL server-side. Visibility via the central _VIS clause."""
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    async with user_tx(user) as conn:
        coll = await _fetch_coll(conn, collection_id, user)
        field_rows = await _ensure_fields(conn, collection_id, coll)
        fields = {r["key"]: r["field_type"] for r in field_rows}
        view = None
        if view_id:
            view = await conn.fetchrow(
                "SELECT * FROM claraos_kb_views WHERE id = $1::uuid AND collection_id = $2::uuid",
                _uuid(view_id, "view_id"), collection_id)
            if not view:
                raise HTTPException(status_code=404, detail="Ansicht nicht gefunden")
        filters = (view["filters"] if view else None) or {}
        sorts = (view["sorts"] if view else None) or []
        if isinstance(filters, str):
            filters = json.loads(filters)
        if isinstance(sorts, str):
            sorts = json.loads(sorts)

        # $1 = user, $2 = collection_id → compiler parameters start at $3
        p = kb_query.new_params(start=2)
        try:
            where_extra = kb_query.compile_filter(filters, fields, p)
            order = kb_query.compile_sorts(sorts, fields, p)
        except kb_query.FilterError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        clauses = [
            _VIS.format(u="$1"),
            "EXISTS (SELECT 1 FROM claraos_kb_collection_items ci "
            "WHERE ci.object_id = claraos_kb_objects.id AND ci.collection_id = $2::uuid)",
        ]
        if where_extra:
            clauses.append(where_extra)
        params = [user, collection_id, *p.values]
        params.append(max(1, min(limit, 500)))
        rows = await conn.fetch(
            f"SELECT {_OBJ_COLS_Q}, {_edit_for('claraos_kb_objects.', '$1')} AS can_edit "
            f"FROM claraos_kb_objects "
            f"WHERE {' AND '.join(clauses)} ORDER BY {order} LIMIT ${len(params)}",
            *params,
        )
        rollups = await _rollup_values(conn, rows, field_rows, user)

    # Formulas ON READ, after the rollups so rollup("…") can be used
    formula_fields = [f for f in field_rows if f["field_type"] == kb_query.FT_FORMULA]
    out = []
    for r in rows:
        d = _row_obj(r, slim=True)
        rid = str(r["id"])
        if rid in rollups:
            d["rollups"] = rollups[rid]
        if formula_fields:
            props = d.get("properties") or {}
            values = {}
            for ff in formula_fields:
                opt = ff["type_option"]
                if isinstance(opt, str):
                    opt = json.loads(opt)
                values[ff["key"]] = kb_formula.evaluate(
                    (opt or {}).get("expression", ""), props, rollups.get(rid, {}))
            d["formulas"] = values
        out.append(d)
    return {"rows": out, "fields": [_row_field(f) for f in field_rows],
            "view_id": str(view["id"]) if view else None}


class FormulaPreview(BaseModel):
    expression: str
    limit: int = 3


@router.post("/collections/{collection_id}/formula/preview")
async def preview_formula(collection_id: str, body: FormulaPreview, request: Request):
    """Validate a formula and preview it on real rows BEFORE it is saved.

    Important: without this a formula editor would not be responsible. A formula
    is the only column whose result you cannot see before it exists; you type an
    expression and hope. This runs **exactly the same path** as reading the
    table (same rollups, same `evaluate`), just without saving; a preview that
    computes differently from the table would be worse than none.

    Read-only and side-effect free: no column is created, nothing is changed.
    """
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    try:
        kb_formula.validate(body.expression)
    except kb_formula.FormulaError as exc:
        return {"ok": False, "fehler": str(exc), "proben": []}

    grenze = max(1, min(body.limit, 5))
    async with user_tx(user) as conn:
        coll = await _fetch_coll(conn, collection_id, user)
        field_rows = await _ensure_fields(conn, collection_id, coll)
        rows = await conn.fetch(
            f"SELECT {_OBJ_COLS_Q} FROM claraos_kb_objects "
            f"WHERE {_VIS.format(u='$1')} AND EXISTS ("
            "  SELECT 1 FROM claraos_kb_collection_items ci "
            "  WHERE ci.object_id = claraos_kb_objects.id AND ci.collection_id = $2::uuid) "
            "ORDER BY claraos_kb_objects.updated_at DESC LIMIT $3",
            user, collection_id, grenze)
        rollups = await _rollup_values(conn, rows, field_rows, user)

    proben = []
    for r in rows:
        d = _row_obj(r, slim=True)
        proben.append({
            "titel": d.get("title"),
            "wert": kb_formula.evaluate(body.expression, d.get("properties") or {},
                                        rollups.get(str(r["id"]), {})),
        })
    return {"ok": True, "fehler": None, "proben": proben}


@router.get("/collections/{collection_id}/aggregate")
async def aggregate_collection(collection_id: str, request: Request,
                               key: str, agg: str = "count", view_id: str | None = None):
    """Footer aggregate of a column under the view's filters."""
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(collection_id, "collection_id")
    async with user_tx(user) as conn:
        coll = await _fetch_coll(conn, collection_id, user)
        field_rows = await _ensure_fields(conn, collection_id, coll)
        fields = {r["key"]: r["field_type"] for r in field_rows}
        if key not in fields:
            raise HTTPException(status_code=400, detail=f"Unbekanntes Feld: {key!r}")
        filters = {}
        if view_id:
            v = await conn.fetchrow(
                "SELECT filters FROM claraos_kb_views WHERE id = $1::uuid AND collection_id = $2::uuid",
                _uuid(view_id, "view_id"), collection_id)
            filters = (v["filters"] if v else {}) or {}
            if isinstance(filters, str):
                filters = json.loads(filters)
        p = kb_query.new_params(start=2)
        try:
            expr = kb_query.aggregate_expr(agg, key, p)
            where_extra = kb_query.compile_filter(filters, fields, p)
        except kb_query.FilterError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        clauses = [
            _VIS.format(u="$1"),
            "EXISTS (SELECT 1 FROM claraos_kb_collection_items ci "
            "WHERE ci.object_id = claraos_kb_objects.id AND ci.collection_id = $2::uuid)",
        ]
        if where_extra:
            clauses.append(where_extra)
        val = await conn.fetchval(
            f"SELECT {expr} FROM claraos_kb_objects WHERE {' AND '.join(clauses)}",
            user, collection_id, *p.values)
    return {"key": key, "aggregate": agg, "value": float(val) if val is not None else None}


class RelationSet(BaseModel):
    field_key: str
    target_ids: list[str]


@router.put("/objects/{object_id}/relations")
async def set_relation(object_id: str, body: RelationSet, request: Request,
                       background: BackgroundTasks):
    """Set a relation cell: writes {key: [ids]} into properties AND maintains
    kb_refs (kind=relation_prop), so the link automatically appears in the
    target's backlinks (inverse for free, Anytype pattern)."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    object_id = _uuid(object_id, "object_id")
    targets = [_uuid(t, "target_id") for t in body.target_ids][:100]
    async with user_tx(user) as conn:
        cur = await _require_editable(conn, object_id, user)
        # Only VISIBLE targets may be linked (no existence leak)
        visible = await conn.fetch(
            f"SELECT id FROM claraos_kb_objects WHERE id = ANY($1::uuid[]) AND {_VIS.format(u='$2')}",
            targets, user)
        keep = [str(r["id"]) for r in visible]
        props = cur["properties"]
        if isinstance(props, str):
            props = json.loads(props)
        props = {**(props or {}), body.field_key: keep}
        await conn.execute(
            "UPDATE claraos_kb_objects SET properties = $2::jsonb, updated_at = NOW(), "
            "rag_status = 'pending' WHERE id = $1::uuid",
            object_id, json.dumps(props))
        await conn.execute(
            "DELETE FROM claraos_kb_refs WHERE src_object_id = $1::uuid AND kind = 'relation_prop'",
            object_id)
        for t in keep:
            if t == object_id:
                continue
            await conn.execute(
                "INSERT INTO claraos_kb_refs (src_object_id, target_object_id, kind, anchor_text) "
                "VALUES ($1::uuid, $2::uuid, 'relation_prop', $3) ON CONFLICT DO NOTHING",
                object_id, t, body.field_key)
    background.add_task(kb_indexer.index_object, object_id)
    return {"ok": True, "linked": keep, "skipped": len(targets) - len(keep)}


# ── Types CRUD (user-defined) ───────────────────────────────────────────────

_PROP_KINDS = ("text", "number", "date", "select", "multi_select", "url", "checkbox")


def _validate_prop_schema(schema: list) -> list:
    if not isinstance(schema, list):
        raise HTTPException(status_code=400, detail="prop_schema muss eine Liste sein")
    seen = set()
    for p in schema:
        if not isinstance(p, dict) or not p.get("key") or not p.get("label"):
            raise HTTPException(status_code=400, detail="Jede Property braucht key + label")
        if p["key"] in seen:
            raise HTTPException(status_code=400, detail=f"Doppelter Property-Key: {p['key']!r}")
        seen.add(p["key"])
        _validate(p.get("kind", "text"), _PROP_KINDS, "property-kind")
    return schema


class TypeCreate(BaseModel):
    id: str
    name: str
    icon: str | None = None
    description: str | None = None
    prop_schema: list = []


class TypePatch(BaseModel):
    name: str | None = None
    icon: str | None = None
    description: str | None = None
    prop_schema: list | None = None


@router.post("/types")
async def create_type(body: TypeCreate, request: Request):
    await _ensure_tables()
    user = _caller(request)
    slug = body.id.strip().lower()
    if not slug or not slug.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="id: nur Kleinbuchstaben/Ziffern/-/_")
    _validate_prop_schema(body.prop_schema)
    async with user_tx(user) as conn:
        exists = await conn.fetchrow("SELECT id FROM claraos_kb_types WHERE id = $1", slug)
        if exists:
            raise HTTPException(status_code=409, detail=f"Typ {slug!r} existiert schon")
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_kb_types (id, name, icon, description, is_system, owner, prop_schema)
            VALUES ($1, $2, $3, $4, FALSE, $5, $6::jsonb)
            RETURNING id, name, icon, description, is_system, owner, prop_schema
            """,
            slug, body.name.strip(), body.icon, body.description, user, json.dumps(body.prop_schema),
        )
    d = dict(row)
    d["prop_schema"] = json.loads(d["prop_schema"]) if isinstance(d["prop_schema"], str) else d["prop_schema"]
    return {"type": d}


@router.patch("/types/{type_id}")
async def patch_type(type_id: str, body: TypePatch, request: Request):
    """Only own (user-defined) types; system types are fixed."""
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        row = await conn.fetchrow("SELECT owner, is_system FROM claraos_kb_types WHERE id = $1", type_id)
        if not row:
            raise HTTPException(status_code=404, detail="Typ nicht gefunden")
        if row["is_system"] or row["owner"] != user:
            raise HTTPException(status_code=403, detail="Nur eigene Typen sind änderbar")
        sets, params = ["updated_at = NOW()"], [type_id]
        for col in ("name", "icon", "description"):
            val = getattr(body, col)
            if val is not None:
                params.append(val)
                sets.append(f"{col} = ${len(params)}")
        if body.prop_schema is not None:
            _validate_prop_schema(body.prop_schema)
            params.append(json.dumps(body.prop_schema))
            sets.append(f"prop_schema = ${len(params)}::jsonb")
        await conn.execute(
            f"UPDATE claraos_kb_types SET {', '.join(sets)} WHERE id = $1", *params)
    return {"ok": True}


# ── Types / search / health ─────────────────────────────────────────────────

@router.get("/types")
async def list_types(request: Request):
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            "SELECT id, name, icon, description, is_system, owner, prop_schema "
            "FROM claraos_kb_types WHERE owner IS NULL OR owner = $1 ORDER BY is_system DESC, id",
            user,
        )
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("prop_schema"), str):
            d["prop_schema"] = json.loads(d["prop_schema"])
        out.append(d)
    return {"types": out}


def _build_snippet(text: str, query: str, radius: int = 90) -> str:
    """Outline pattern: regex highlight over the REAL text instead of ts_headline,
    avoiding stemming mis-highlights. Terms > 2 characters, first match wins."""
    text = text or ""
    terms = [re.escape(t) for t in re.findall(r"\w{3,}", query or "")][:6]
    if not terms or not text:
        return text[: radius * 2]
    m = re.search("|".join(terms), text, re.IGNORECASE)
    if not m:
        return text[: radius * 2]
    start = max(0, m.start() - radius)
    end = min(len(text), m.end() + radius)
    # Align to word boundaries
    if start > 0:
        sp = text.rfind(" ", 0, start + 20)
        start = sp + 1 if 0 <= sp < m.start() else start
    snippet = text[start:end]
    snippet = re.sub("|".join(terms), lambda x: f"**{x.group(0)}**", snippet, flags=re.IGNORECASE)
    return ("…" if start > 0 else "") + snippet + ("…" if end < len(text) else "")


@router.get("/search")
async def search_fulltext(request: Request, q: str, type: str | None = None, limit: int = 20):
    """UI quick search (weighted tsvector: title A > body B) + snippets;
    semantic search is /clara/search (Qdrant)."""
    await _ensure_tables()
    user = _caller(request)
    params: list = [user, q]
    where = [_VIS.format(u="$1"), "search_tsv @@ websearch_to_tsquery('german', $2)"]
    if type:
        params.append(type)
        where.append(f"type = ${len(params)}")
    params.append(max(1, min(limit, 50)))
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            f"""
            SELECT {_OBJ_COLS}, coalesce(text_content, body) AS _plain,
                   ts_rank(search_tsv, websearch_to_tsquery('german', $2)) AS rank
            FROM claraos_kb_objects WHERE {' AND '.join(where)}
            ORDER BY rank DESC LIMIT ${len(params)}
            """,
            *params,
        )
    results = []
    for r in rows:
        o = _row_obj(r, slim=True)
        o.pop("_plain", None)
        o.pop("rank", None)
        o["snippet"] = _build_snippet(r["_plain"], q)
        results.append(o)
    return {"results": results}


@router.get("/graph")
async def get_graph(request: Request):
    """All visible ideas/visions + links between them, for the graph view
    (one call instead of N detail fetches). Only edges with BOTH ends visible."""
    await _ensure_tables()
    user = _caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            f"SELECT {_OBJ_COLS} FROM claraos_kb_objects "
            f"WHERE {_VIS.format(u='$1')} AND type = ANY($2) "
            f"ORDER BY updated_at DESC LIMIT 300",
            user, list(IDEA_SUITE_TYPES),
        )
        links = await conn.fetch(
            """
            SELECT l.id, l.from_id, l.to_id, l.rel
            FROM claraos_kb_links l
            JOIN claraos_kb_objects a ON a.id = l.from_id
            JOIN claraos_kb_objects b ON b.id = l.to_id
            WHERE """ + _vis_for("a.", "$1") + """
              AND """ + _vis_for("b.", "$1") + """
            """,
            user,
        )
    return {
        "objects": [_row_obj(r, slim=True) for r in rows],
        "links": [{"id": str(l["id"]), "from_id": str(l["from_id"]),
                   "to_id": str(l["to_id"]), "rel": l["rel"]} for l in links],
    }


@router.get("/health")
async def health():
    await _ensure_tables()
    # Service path: household-wide counters without a user, plain pool on purpose.
    pool = await get_pool()
    async with pool.acquire() as conn:
        counts = await conn.fetchrow(
            "SELECT count(*) AS objects, "
            "count(*) FILTER (WHERE rag_status = 'ok') AS indexed, "
            "count(*) FILTER (WHERE rag_status IN ('pending','failed','deindex')) AS backlog "
            "FROM claraos_kb_objects WHERE deleted_at IS NULL"
        )
    return {"ok": True, "objects": counts["objects"], "rag_indexed": counts["indexed"],
            "rag_backlog": counts["backlog"], "qdrant_collection": kb_indexer.COLLECTION}


# ── Chat context resolver ───────────────────────────────────────────────────
# Called by chat_v2.py when an inline Clara chat is bound to an ideas object
# (meta.object_uri = claraos://ideas/object/<uuid>): returns a compact text
# block for the system message so Clara knows the idea WITHOUT first having
# to call get_object.

async def fetch_object_context(object_id: str, user: str) -> str | None:
    """Visibility-checked context block; None if invisible/missing."""
    await _ensure_tables()
    async with user_tx(user) as conn:
        row = await conn.fetchrow(
            f"SELECT id, type, title, body, stage, owner, visibility "
            f"FROM claraos_kb_objects WHERE id = $1::uuid AND {_VIS.format(u='$2')}",
            object_id, user,
        )
        if not row:
            return None
        questions = await conn.fetch(
            "SELECT content FROM claraos_kb_activity "
            "WHERE object_id = $1::uuid AND kind = 'question' AND actor = 'clara' "
            "ORDER BY created_at DESC LIMIT 3",
            object_id,
        )
        # Breadcrumb (visible ancestors) + backlink count in the context
        ancestors = await conn.fetch(
            """
            WITH RECURSIVE up AS (
                SELECT o.id, o.parent_id, o.title, o.owner, o.visibility, o.deleted_at, 0 AS depth
                FROM claraos_kb_objects o WHERE o.id = $1::uuid
                UNION ALL
                SELECT o.id, o.parent_id, o.title, o.owner, o.visibility, o.deleted_at, up.depth + 1
                FROM claraos_kb_objects o JOIN up ON o.id = up.parent_id
                WHERE up.depth < 32
            )
            SELECT title FROM up
            WHERE depth > 0 AND deleted_at IS NULL
              AND """ + _vis_core("up.", "$2") + """
            ORDER BY depth DESC
            """,
            object_id, user,
        )
        backlink_count = await conn.fetchval(
            "SELECT count(*) FROM claraos_kb_refs WHERE target_object_id = $1::uuid", object_id)
    kind = row["type"] + (f"/{row['stage']}" if row["stage"] else "")
    lines = [
        f"ideas object_id: {row['id']}",
        f"object: [{kind}] „{row['title']}“ (owner: {row['owner']}, {row['visibility']})",
    ]
    if ancestors:
        lines.append("breadcrumb: " + " › ".join(a["title"] for a in ancestors) + f" › {row['title']}")
    if backlink_count:
        lines.append(f"backlinks: {backlink_count} Objekt(e) verweisen hierauf (Tool get_backlinks)")
    body = (row["body"] or "").strip()
    if body:
        lines.append("object body (markdown):\n" + body[:1800] + ("…" if len(body) > 1800 else ""))
    if questions:
        lines.append("offene Clara-Rückfragen: " + " | ".join(q["content"] for q in reversed(questions)))
    return "\n".join(lines)


# ── Clara tools: flat endpoints for clara-tools.d/knowledge.yaml ────────────
# The gateway calls with X-Claraos-User (chat user) + X-Claraos-Actor: clara.
# Clara always acts AS the chat user (owner = user); the attribution
# (created_by/actor='clara') only shows WHO performed the action.

_SHARE_HINT = ("Saved as PRIVATE. Sharing with the family needs the user's explicit "
               "request; only then call again with visibility='family' and "
               "teilen_bestaetigt=true.")


def _clara_visibility(requested: str | None, confirmed: bool) -> tuple[str | None, str | None]:
    """Tool calls may not share on their own: 'family' needs `teilen_bestaetigt`.

    Tool calls must not widen visibility without explicit confirmation — a
    tool description alone is not enough to stop a model from sharing private
    objects with everyone in the family space. The /clara/* routes are only
    reached through the tool gateway, so the rule sits here, server-side,
    instead of in a prompt the model may ignore.
    Returns (visibility to use, hint for the result or None).
    """
    if requested == "family" and not confirmed:
        return "private", _SHARE_HINT
    return requested, None


def _object_link(object_id: str) -> str:
    base = (heim_default("CLARAOS_PUBLIC_URL") or "").rstrip("/")
    return f"{base}/?app=knowledge&do=open_object&object_id={object_id}"


async def _object_result(object_id: str, user: str, want: dict, extra: dict) -> dict:
    """Read the object back after a write; `verified` only if `want` matches."""
    async with user_tx(user) as conn:
        row = await conn.fetchrow(
            "SELECT id, type, title, visibility, stage, body, updated_at FROM claraos_kb_objects "
            "WHERE id = $1::uuid AND deleted_at IS NULL AND " + _VIS.format(u="$2"),
            object_id, user)
    link = _object_link(object_id)
    if row is None:
        return {"ok": False, "id": object_id, "verified": False, "link": link, **extra,
                "error": "Written, but the object could not be read back.",
                "hint": "Search for it before telling the user it worked."}
    mismatch = []
    for key, val in want.items():
        if key == "body_contains":
            continue
        got = row[key]
        if (str(got or "").strip() if key == "title" else got) != (str(val).strip() if key == "title" else val):
            mismatch.append(f"{key}: wanted {val!r}, stored {got!r}")
    if want.get("body_contains") and want["body_contains"].strip() not in (row["body"] or ""):
        mismatch.append("body: new text not found in the stored body")
    obj = {"id": str(row["id"]), "type": row["type"], "title": row["title"],
           "visibility": row["visibility"], "stage": row["stage"]}
    out = {"ok": not mismatch, "id": str(row["id"]), "verified": not mismatch, "link": link,
           "object": obj, "title": row["title"], "visibility": row["visibility"], **extra}
    if mismatch:
        out.update({"error": "Read-back differs: " + "; ".join(mismatch),
                    "hint": "Do not report success; tell the user what is stored."})
    return out


class ClaraCaptureIdea(BaseModel):
    title: str
    body: str = ""
    visibility: str = "private"
    teilen_bestaetigt: bool = False


@router.post("/clara/capture_idea")
async def clara_capture_idea(body: ClaraCaptureIdea, request: Request,
                             background: BackgroundTasks):
    await _ensure_tables()
    user = _caller(request)
    vis, hint = _clara_visibility(body.visibility, body.teilen_bestaetigt)
    obj = await _create_object(
        user, _actor(request, user),
        ObjectCreate(type="idea", title=body.title, body=body.body,
                     visibility=vis, stage="spark"),
        background,
    )
    out = {"ok": True, "id": str(obj["id"]), "link": _object_link(str(obj["id"])),
           "idea": {k: obj[k] for k in ("id", "title", "stage", "visibility")}}
    if hint:
        out["hinweis"] = hint
    return out


class ClaraListIdeas(BaseModel):
    stage: str | None = None
    query: str | None = None
    limit: int = 20


@router.post("/clara/list_ideas")
async def clara_list_ideas(body: ClaraListIdeas, request: Request):
    await _ensure_tables()
    user = _caller(request)
    _validate(body.stage, STAGES, "stage")
    params: list = [user]
    where = [_VIS.format(u="$1"), "type = 'idea'"]
    if body.stage:
        params.append(body.stage)
        where.append(f"stage = ${len(params)}")
    if body.query:
        params.append(body.query)
        where.append(f"search_tsv @@ websearch_to_tsquery('german', ${len(params)})")
    params.append(max(1, min(body.limit, 50)))
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            f"SELECT {_OBJ_COLS} FROM claraos_kb_objects WHERE {' AND '.join(where)} "
            f"ORDER BY updated_at DESC LIMIT ${len(params)}",
            *params,
        )
    return {"ideas": [
        {"id": str(r["id"]), "title": r["title"], "stage": r["stage"],
         "visibility": r["visibility"], "owner": r["owner"],
         "updated_at": r["updated_at"].isoformat(),
         "body_preview": (r["body"] or "")[:200]}
        for r in rows
    ]}


class ClaraObjectRef(BaseModel):
    object_id: str


@router.post("/clara/get_object")
async def clara_get_object(body: ClaraObjectRef, request: Request):
    return await get_object(body.object_id, request)


class ClaraCreateObject(BaseModel):
    type: str
    title: str
    body: str = ""
    properties: dict | None = None
    visibility: str = "private"
    collection_id: str | None = None
    teilen_bestaetigt: bool = False


@router.post("/clara/create_object")
async def clara_create_object(body: ClaraCreateObject, request: Request,
                              background: BackgroundTasks):
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    vis, hint = _clara_visibility(body.visibility, body.teilen_bestaetigt)
    obj = await _create_object(
        user, actor,
        ObjectCreate(type=body.type, title=body.title, body=body.body,
                     properties=body.properties, visibility=vis),
        background,
    )
    if body.collection_id:
        cid = _uuid(body.collection_id, "collection_id")
        async with user_tx(user) as conn:
            await _fetch_coll(conn, cid, user, write=True)
            await conn.execute(
                "INSERT INTO claraos_kb_collection_items (collection_id, object_id, added_by) "
                "VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT DO NOTHING",
                cid, obj["id"], actor,
            )
    out = await _object_result(str(obj["id"]), user, {"title": body.title, "visibility": vis},
                               {"collection_id": body.collection_id} if body.collection_id else {})
    if hint:
        out["hinweis"] = hint
    return out


@router.post("/clara/list_collections")
async def clara_list_collections(request: Request):
    res = await list_collections(request)
    return {"collections": [
        {"id": c["id"], "name": c["name"], "icon": c["icon"],
         "default_type": c["default_type"], "visibility": c["visibility"],
         "item_count": c["item_count"], "owner": c["owner"]}
        for c in res["collections"]
    ]}


class ClaraCreateCollection(BaseModel):
    name: str
    icon: str | None = None
    description: str | None = None
    default_type: str | None = None
    visibility: str = "private"
    teilen_bestaetigt: bool = False


@router.post("/clara/create_collection")
async def clara_create_collection(body: ClaraCreateCollection, request: Request):
    vis, hint = _clara_visibility(body.visibility, body.teilen_bestaetigt)
    res = await create_collection(
        CollectionCreate(name=body.name, icon=body.icon, description=body.description,
                         default_type=body.default_type, visibility=vis),
        request,
    )
    c = res["collection"]
    out = {"ok": True, "id": str(c["id"]),
           "link": f"{(heim_default('CLARAOS_PUBLIC_URL') or '').rstrip('/')}/?app=knowledge",
           "collection": {k: c[k] for k in ("id", "name", "visibility")}}
    if hint:
        out["hinweis"] = hint
    return out


class ClaraAddToCollection(BaseModel):
    collection_id: str
    object_id: str


@router.post("/clara/add_to_collection")
async def clara_add_to_collection(body: ClaraAddToCollection, request: Request):
    return await add_collection_item(
        body.collection_id, ItemAdd(object_id=body.object_id), request)


class ClaraDefineType(BaseModel):
    id: str
    name: str
    icon: str | None = None
    properties: list = []


@router.post("/clara/define_type")
async def clara_define_type(body: ClaraDefineType, request: Request):
    res = await create_type(
        TypeCreate(id=body.id, name=body.name, icon=body.icon, prop_schema=body.properties),
        request,
    )
    return {"ok": True, "type": {"id": res["type"]["id"], "name": res["type"]["name"]}}


class ClaraUpdateObject(BaseModel):
    object_id: str
    title: str | None = None
    body: str | None = None
    properties: dict | None = None
    stage: str | None = None
    visibility: str | None = None
    teilen_bestaetigt: bool = False


@router.post("/clara/update_object")
async def clara_update_object(body: ClaraUpdateObject, request: Request,
                              background: BackgroundTasks):
    await _ensure_tables()
    user = _caller(request)
    object_id = _uuid(body.object_id, "object_id")
    vis, hint = _clara_visibility(body.visibility, body.teilen_bestaetigt)
    if hint:
        vis = None   # an unconfirmed share request leaves the visibility as it is
    obj = await _patch_object(
        object_id, user, _actor(request, user),
        ObjectPatch(title=body.title, body=body.body, properties=body.properties,
                    stage=body.stage, visibility=vis),
        background,
    )
    want: dict = {}
    if body.title is not None:
        want["title"] = body.title
    if vis is not None:
        want["visibility"] = vis
    if body.stage is not None:
        want["stage"] = body.stage
    if body.body:
        want["body_contains"] = body.body[-200:]
    out = await _object_result(str(obj["id"]), user, want, {})
    if hint:
        out["hinweis"] = hint.replace("Saved as PRIVATE", "Visibility NOT changed")
    return out


class ClaraAddInsight(BaseModel):
    object_id: str
    content: str
    kind: str = "analysis"


@router.post("/clara/add_insight")
async def clara_add_insight(body: ClaraAddInsight, request: Request):
    """Analysis/question/answer/comment from Clara to the object's activity log."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    object_id = _uuid(body.object_id, "object_id")
    _validate(body.kind, ("analysis", "question", "answer", "comment"), "kind")
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="content darf nicht leer sein")
    async with user_tx(user) as conn:
        await _fetch_visible(conn, object_id, user)
        await _log_activity(conn, object_id, actor, body.kind, body.content.strip())
    return {"ok": True}


class ClaraLinkObjects(BaseModel):
    from_id: str
    to_id: str
    rel: str = "relates_to"


@router.post("/clara/link_objects")
async def clara_link_objects(body: ClaraLinkObjects, request: Request):
    return await create_link(body.from_id, LinkCreate(to_id=body.to_id, rel=body.rel), request)


class PlanTaskIn(BaseModel):
    title: str
    description: str | None = None
    due_date: str | None = None
    depends_on: list[int] | None = None  # 1-based indices


class ClaraPromoteIdea(BaseModel):
    object_id: str
    project_title: str | None = None
    project_description: str | None = None
    tasks: list[PlanTaskIn]


@router.post("/clara/promote_idea_to_plan")
async def clara_promote_idea_to_plan(body: ClaraPromoteIdea, request: Request,
                                     background: BackgroundTasks):
    """Idea → Vikunja project (loopback to the planner's clara route;
    deliberately NO import from planner.py, to keep the routers decoupled).
    Then stage='planned' + a handoff activity with planner_project_id."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    object_id = _uuid(body.object_id, "object_id")
    if not body.tasks:
        raise HTTPException(status_code=422, detail="tasks darf nicht leer sein")
    async with user_tx(user) as conn:
        obj = await _require_owner(conn, object_id, user)

    payload = {
        "title": body.project_title or obj["title"],
        "description": body.project_description or f"Aus der Idee „{obj['title']}“ (Ideen-App).",
        "tasks": [t.model_dump(exclude_none=True) for t in body.tasks],
    }
    # Internal loopback => send the service token, otherwise 401
    # (the planner routes require a trust anchor).
    fwd_headers = service_headers(user, request.headers.get("x-claraos-actor") or None)
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            "http://localhost:8090/api/claraos/planner/clara/create_project_from_plan",
            json=payload, headers=fwd_headers,
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=502,
                            detail=f"Planner-Übergabe fehlgeschlagen ({resp.status_code}): {resp.text[:300]}")
    plan = resp.json()
    project_id = plan.get("project_id")

    async with user_tx(user) as conn:
        cur = await conn.fetchrow(
            "SELECT stage, properties FROM claraos_kb_objects WHERE id = $1::uuid", object_id)
        props = cur["properties"]
        props = json.loads(props) if isinstance(props, str) else (props or {})
        props["planner_project_id"] = project_id
        await conn.execute(
            "UPDATE claraos_kb_objects SET stage = 'planned', properties = $2::jsonb, "
            "rag_status = 'pending', updated_at = NOW() WHERE id = $1::uuid",
            object_id, json.dumps(props),
        )
        await _log_activity(conn, object_id, actor, "stage_change",
                            meta={"from_stage": cur["stage"], "to_stage": "planned"})
        await _log_activity(conn, object_id, actor, "handoff",
                            content=f"An den Planner übergeben — Projekt „{plan.get('title')}“ "
                                    f"mit {len(plan.get('tasks', []))} Aufgaben.",
                            meta={"planner_project_id": project_id})
    background.add_task(kb_indexer.index_object, object_id)
    return {"ok": True, "project_id": project_id,
            "tasks_created": len(plan.get("tasks", [])),
            "relations_created": plan.get("relations_created", 0),
            "hint": plan.get("hint", "")}


class ClaraSearch(BaseModel):
    query: str
    type: str | None = None
    limit: int = 8


@router.post("/clara/search")
async def clara_search(body: ClaraSearch, request: Request):
    """Semantic search (Qdrant) with a server-side enforced visibility filter.

    The user comes EXCLUSIVELY from the trusted header, never from LLM args.
    Fallback when embeddings/Qdrant are unavailable: tsvector full-text search.
    """
    await _ensure_tables()
    user = _caller(request)
    if not body.query.strip():
        raise HTTPException(status_code=400, detail="query darf nicht leer sein")
    try:
        hits = await kb_indexer.search(body.query, user, type_filter=body.type,
                                       limit=body.limit)
        return {"results": hits, "mode": "semantic"}
    except Exception as exc:
        logger.warning("[knowledge] semantic search failed, tsvector fallback: %s", exc)
        res = await search_fulltext(request, q=body.query, type=body.type,
                                    limit=max(1, min(body.limit, 20)))
        return {"results": [
            {"object_id": r["id"], "title": r["title"], "type": r["type"],
             "stage": r.get("stage"), "snippet": r.get("body_preview", "")}
            for r in res["results"]
        ], "mode": "fulltext_fallback"}


class ClaraObjectId(BaseModel):
    object_id: str


@router.post("/clara/get_backlinks")
async def clara_get_backlinks(body: ClaraObjectId, request: Request):
    """Who references this object? (visibility-filtered)."""
    res = await get_backlinks(body.object_id, request, limit=30)
    return {"backlinks": [
        {"object_id": b["id"], "title": b["title"], "type": b["type"],
         "kind": b["kind"], "anchor_text": b["anchor_text"]}
        for b in res["backlinks"]
    ]}


class ClaraQueryCollection(BaseModel):
    collection_id: str
    filters: dict | None = None
    sorts: list | None = None
    limit: int = 25


@router.post("/clara/query_collection")
async def clara_query_collection(body: ClaraQueryCollection, request: Request):
    """Rows of a collection with an ad-hoc filter/sort (without saving a view).
    The filter tree is compiled to SQL and validated server-side."""
    await _ensure_tables()
    user = _caller(request)
    collection_id = _uuid(body.collection_id, "collection_id")
    async with user_tx(user) as conn:
        coll = await _fetch_coll(conn, collection_id, user)
        field_rows = await _ensure_fields(conn, collection_id, coll)
        fields = {r["key"]: r["field_type"] for r in field_rows}
        p = kb_query.new_params(start=2)
        try:
            where_extra = kb_query.compile_filter(body.filters or {}, fields, p)
            order = kb_query.compile_sorts(body.sorts or [], fields, p)
        except kb_query.FilterError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        clauses = [
            _VIS.format(u="$1"),
            "EXISTS (SELECT 1 FROM claraos_kb_collection_items ci "
            "WHERE ci.object_id = claraos_kb_objects.id AND ci.collection_id = $2::uuid)",
        ]
        if where_extra:
            clauses.append(where_extra)
        params = [user, collection_id, *p.values, max(1, min(body.limit, 50))]
        rows = await conn.fetch(
            f"SELECT {_OBJ_COLS_Q} FROM claraos_kb_objects WHERE {' AND '.join(clauses)} "
            f"ORDER BY {order} LIMIT ${len(params)}", *params)
        rollups = await _rollup_values(conn, rows, field_rows, user)
    out = []
    for r in rows:
        d = _row_obj(r, slim=True)
        entry = {"object_id": d["id"], "title": d["title"], "properties": d["properties"]}
        if str(r["id"]) in rollups:
            entry["rollups"] = rollups[str(r["id"])]
        out.append(entry)
    return {"rows": out, "fields": [{"key": f["key"], "name": f["name"],
                                     "field_type": f["field_type"]} for f in field_rows]}


class ClaraDefineField(BaseModel):
    collection_id: str
    key: str
    name: str
    field_type: int = 0
    options: list | None = None            # for select fields
    target_collection: str | None = None   # for relations
    relation_field: str | None = None      # for rollups
    target_field: str | None = None
    aggregate: str | None = None
    expression: str | None = None          # for formulas


@router.post("/clara/define_field")
async def clara_define_field(body: ClaraDefineField, request: Request):
    """Create a column in a collection, including relation (10), rollup (11)
    and formula (14). Formulas are validated before saving."""
    opt: dict = {}
    if body.options:
        opt["options"] = [str(o) for o in body.options][:50]
    if body.target_collection:
        opt["target_collection"] = _uuid(body.target_collection, "target_collection")
    for k in ("relation_field", "target_field", "aggregate", "expression"):
        v = getattr(body, k)
        if v:
            opt[k] = v
    res = await create_field(
        body.collection_id,
        FieldCreate(key=body.key, name=body.name, field_type=body.field_type, type_option=opt),
        request)
    f = res["field"]
    return {"ok": True, "field": {"key": f["key"], "name": f["name"],
                                  "field_type": f["field_type"]}}


class ClaraCreateView(BaseModel):
    collection_id: str
    name: str
    layout: str = "table"
    filters: dict | None = None
    sorts: list | None = None
    group_by: str | None = None
    date_field: str | None = None


@router.post("/clara/create_view")
async def clara_create_view(body: ClaraCreateView, request: Request):
    """Create a saved view (table/board/gallery/list/calendar/timeline)."""
    layout_setting = {"date_field": body.date_field} if body.date_field else {}
    res = await create_view(
        body.collection_id,
        ViewCreate(name=body.name, layout=body.layout, filters=body.filters,
                   sorts=body.sorts, layout_setting=layout_setting,
                   group_setting={"key": body.group_by} if body.group_by else None),
        request)
    v = res["view"]
    return {"ok": True, "view_id": v["id"], "name": v["name"], "layout": v["layout"]}


class ClaraSetRelation(BaseModel):
    object_id: str
    field_key: str
    target_ids: list[str]


@router.post("/clara/set_relation")
async def clara_set_relation(body: ClaraSetRelation, request: Request,
                             background: BackgroundTasks):
    """Set a relation cell (only visible targets are accepted)."""
    return await set_relation(
        body.object_id, RelationSet(field_key=body.field_key, target_ids=body.target_ids),
        request, background)


@router.post("/clara/list_templates")
async def clara_list_templates(request: Request):
    """Available templates."""
    res = await list_templates(request)
    return {"templates": [{"template_id": t["id"], "name": t["name"],
                           "target_type": t["target_type"], "is_default": t["is_default"]}
                          for t in res["templates"]]}


class ClaraFromTemplate(BaseModel):
    title: str
    template_id: str | None = None
    type: str | None = None
    collection_id: str | None = None


@router.post("/clara/create_from_template")
async def clara_create_from_template(body: ClaraFromTemplate, request: Request,
                                     background: BackgroundTasks):
    """Create an object from a template (without template_id: the type default)."""
    res = await create_from_template(
        FromTemplate(template_id=body.template_id, type=body.type, title=body.title,
                     collection_id=body.collection_id),
        request, background)
    o = res["object"]
    return {"ok": True, "object_id": o["id"], "title": o["title"],
            "from_template": res["from_template"]}


@router.post("/clara/duplicate_object")
async def clara_duplicate_object(body: ClaraObjectId, request: Request,
                                 background: BackgroundTasks):
    """Create a copy of an object."""
    res = await duplicate_object(body.object_id, request, background)
    return {"ok": True, "object_id": res["object"]["id"], "title": res["object"]["title"]}


@router.post("/clara/get_backmentions")
async def clara_get_backmentions(body: ClaraObjectId, request: Request):
    """Objects that mention the title in their text without being linked."""
    res = await backmentions(body.object_id, request)
    return {"backmentions": [{"object_id": b["id"], "title": b["title"], "type": b["type"]}
                             for b in res["backmentions"]]}


@router.post("/clara/get_history")
async def clara_get_history(body: ClaraObjectId, request: Request):
    """Version list of an object (for "what changed?")."""
    res = await list_history(body.object_id, request, limit=20)
    return {"history": res["history"]}


class ClaraRestoreVersion(BaseModel):
    object_id: str
    version: int


@router.post("/clara/restore_version")
async def clara_restore_version(body: ClaraRestoreVersion, request: Request,
                                background: BackgroundTasks):
    """Restore an old state (the current one is saved first)."""
    res = await restore_history_version(body.object_id, body.version, request, background)
    return {"ok": True, "object_id": res["object"]["id"], "restored_version": body.version}


class ClaraMoveObject(BaseModel):
    object_id: str
    parent_id: str | None = None


@router.post("/clara/move_object")
async def clara_move_object(body: ClaraMoveObject, request: Request):
    """Attach an object as a child page (parent_id=null → top level)."""
    res = await move_object(body.object_id, ObjectMove(parent_id=body.parent_id), request)
    o = res["object"]
    return {"ok": True, "object_id": o["id"], "parent_id": o.get("parent_id")}


# ── Collection templates (trip, project, research) ──────────────────────────
# A template = one collection with fields, saved views and an overview note,
# created in ONE call. The templates are data (kb_templates/collections.yaml);
# the model only picks one. Without them the assistant invented fields one by
# one, with a different shape every time and many more tool calls.

_TEMPLATE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "kb_templates", "collections.yaml")
_template_cache: dict = {"mtime": None, "data": {}}
_WOCHENTAGE = ("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So")


def load_collection_templates() -> dict:
    """Templates from the YAML file (re-read when the file changes)."""
    import yaml
    try:
        mtime = os.path.getmtime(_TEMPLATE_FILE)
    except OSError:
        return {}
    if _template_cache["mtime"] != mtime:
        with open(_TEMPLATE_FILE, encoding="utf-8") as fh:
            _template_cache["data"] = (yaml.safe_load(fh) or {}).get("templates") or {}
        _template_cache["mtime"] = mtime
    return _template_cache["data"]


def _iso_date(value: str | None, what: str) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(str(value).strip()[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{what}: Datum als JJJJ-MM-TT angeben")


def _zeitraum(von: dt.date | None, bis: dt.date | None) -> str:
    if von and bis:
        return f"{von:%d.%m.}–{bis:%d.%m.%Y}"
    if von:
        return f"ab {von:%d.%m.%Y}"
    return "noch offen"


def _tagesplan_zeilen(von: dt.date | None, bis: dt.date | None) -> str:
    """One table row per day (at most 31); one empty row without dates."""
    if not von or not bis or bis < von or (bis - von).days > 30:
        return "| 1 | – | – |"
    rows, tag = [], von
    while tag <= bis:
        rows.append(f"| **{_WOCHENTAGE[tag.weekday()]} {tag:%d.%m.}** | – | – |")
        tag += dt.timedelta(days=1)
    return "\n".join(rows)


def _fill(text: str, values: dict) -> str:
    for key, val in values.items():
        text = text.replace("{" + key + "}", val)
    return text


def render_template_overview(tpl: dict, values: dict) -> tuple[str, str, dict]:
    """(title, body, properties) of the overview note; empty placeholders drop out."""
    ov = tpl.get("overview") or {}
    title = _fill(str(ov.get("title") or "Übersicht {name}"), values).strip()
    body = _fill(str(ov.get("body") or ""), values)
    body = re.sub(r"\n{3,}", "\n\n", body).strip() + "\n"
    props = {}
    for key, val in (ov.get("properties") or {}).items():
        val = _fill(str(val), values).strip() if isinstance(val, str) else val
        if val not in ("", None):
            props[key] = val
    return title, body, props


class ClaraCollectionFromTemplate(BaseModel):
    template: str
    name: str
    ziel: str | None = None
    von: str | None = None
    bis: str | None = None
    beschreibung: str | None = None
    optionen: list[str] | None = None
    icon: str | None = None


@router.post("/clara/create_collection_from_template")
async def clara_create_collection_from_template(body: ClaraCollectionFromTemplate,
                                                request: Request, background: BackgroundTasks):
    """Collection + fields + views + overview note in one call. Always private."""
    await _ensure_tables()
    user = _caller(request)
    actor = _actor(request, user)
    templates = load_collection_templates()
    key = (body.template or "").strip().lower()
    tpl = templates.get(key)
    if not tpl:
        return {"ok": False, "verified": False,
                "error": f"Unknown template {body.template!r}",
                "hint": "Use one of: " + ", ".join(sorted(templates))}
    name = (body.name or "").strip()
    if not name:
        return {"ok": False, "verified": False, "error": "name is empty",
                "hint": "Give the collection a name, e.g. 'Summer trip 2026'."}
    von = _iso_date(body.von, "von")
    bis = _iso_date(body.bis, "bis")
    values = {
        "name": name,
        "ziel": (body.ziel or "").strip() or "–",
        "von": von.isoformat() if von else "",
        "bis": bis.isoformat() if bis else "",
        "zeitraum": _zeitraum(von, bis),
        "beschreibung": " ".join((body.beschreibung or "").split()),
        "tagesplan_zeilen": _tagesplan_zeilen(von, bis),
    }
    optionen = [o.strip()[:60] for o in (body.optionen or []) if isinstance(o, str) and o.strip()][:30]

    coll_id: str | None = None
    overview_id: str | None = None
    try:
        res = await create_collection(
            CollectionCreate(name=name, icon=body.icon or tpl.get("icon"),
                             description=tpl.get("description"),
                             default_type=tpl.get("default_type"), visibility="private"),
            request)
        coll_id = str(res["collection"]["id"])
        for f in tpl.get("fields") or []:
            opt = dict(f.get("type_option") or {})
            if f.get("options_param") and optionen:
                opt["options"] = optionen
            await create_field(coll_id, FieldCreate(key=f["key"], name=f["name"],
                                                    field_type=int(f.get("field_type", 0)),
                                                    type_option=opt), request)
        for v in tpl.get("views") or []:
            await create_view(coll_id, ViewCreate(
                name=v["name"], layout=v.get("layout", "table"),
                layout_setting=v.get("layout_setting"), filters=v.get("filters"),
                sorts=v.get("sorts"), group_setting=v.get("group_setting"),
                field_settings=v.get("field_settings")), request)
        title, md, props = render_template_overview(tpl, values)
        ov = tpl.get("overview") or {}
        obj = await _create_object(user, actor, ObjectCreate(
            type=ov.get("type", "note"), title=title, body=md, properties=props,
            visibility="private", icon=ov.get("icon")), background)
        overview_id = str(obj["id"])
        async with user_tx(user) as conn:
            await conn.execute(
                "INSERT INTO claraos_kb_collection_items (collection_id, object_id, position, added_by) "
                "VALUES ($1::uuid, $2::uuid, 0, $3) ON CONFLICT DO NOTHING",
                coll_id, overview_id, actor)
    except Exception as exc:  # noqa: BLE001 — undo the half-built collection
        logger.warning("template %s for %s failed: %s", key, user, exc)
        async with user_tx(user) as conn:
            if overview_id:
                await conn.execute("DELETE FROM claraos_kb_objects WHERE id = $1::uuid AND owner = $2",
                                   overview_id, user)
            if coll_id:
                await conn.execute("DELETE FROM claraos_kb_collections WHERE id = $1::uuid AND owner = $2",
                                   coll_id, user)
        detail = exc.detail if isinstance(exc, HTTPException) else f"{type(exc).__name__}: {exc}"
        return {"ok": False, "verified": False, "error": str(detail)[:300],
                "hint": "Nothing was kept. Fix the input and call the template again."}

    # Read back: what the user will actually see.
    async with user_tx(user) as conn:
        c = await conn.fetchrow("SELECT name, visibility FROM claraos_kb_collections WHERE id = $1::uuid", coll_id)
        fields = [r["name"] for r in await conn.fetch(
            "SELECT name FROM claraos_kb_fields WHERE collection_id = $1::uuid ORDER BY position", coll_id)]
        views = [r["name"] for r in await conn.fetch(
            "SELECT name FROM claraos_kb_views WHERE collection_id = $1::uuid ORDER BY position", coll_id)]
        o = await conn.fetchrow(
            "SELECT o.type, o.visibility FROM claraos_kb_objects o JOIN claraos_kb_collection_items ci "
            "ON ci.object_id = o.id WHERE ci.collection_id = $1::uuid AND o.id = $2::uuid "
            "AND o.deleted_at IS NULL", coll_id, overview_id)
    want_fields = len(tpl.get("fields") or [])
    want_views = len(tpl.get("views") or [])
    problems = []
    if not c or c["visibility"] != "private":
        problems.append("collection not private")
    if len(fields) != want_fields:
        problems.append(f"{len(fields)} of {want_fields} fields")
    if len(views) != want_views:
        problems.append(f"{len(views)} of {want_views} views")
    if not o or o["visibility"] != "private":
        problems.append("overview note missing from the collection")
    base = (heim_default("CLARAOS_PUBLIC_URL") or "").rstrip("/")
    out = {
        "ok": not problems, "verified": not problems, "id": coll_id,
        "template": key, "name": name, "visibility": "private",
        "link": f"{base}/?app=knowledge&do=open_collection&collection_id={coll_id}",
        "overview_id": overview_id, "overview_link": _object_link(overview_id),
        "fields": fields, "views": views,
    }
    if problems:
        out.update({"error": "Read-back differs: " + "; ".join(problems),
                    "hint": "Do not report success; tell the user what is missing."})
    return out
