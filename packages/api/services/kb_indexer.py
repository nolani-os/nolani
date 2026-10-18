"""kb_indexer — event-driven RAG indexing of knowledge objects into Qdrant.

Dedicated collection `claraos_objects` (1536-dim/cosine, text-embedding-3-small
via LiteLLM) — deliberately NOT a shared general knowledge collection: such
a collection may be searched UNFILTERED by other tools without user context;
private objects there would be an immediate leak. Access to claraos_objects goes
exclusively through the visibility-filtering endpoint in routers/knowledge.py.

Chunking = a section-aware markdown chunker (2000/2400 chars, 200 overlap). Point IDs are stable sha256(object_id#chunk_idx), update =
delete-by-filter + upsert (the chunk count can shrink).

Triggers: a BackgroundTask after every write (best effort) + a reconciler loop
(start_background() at API startup): every
60 s it catches up rag_status IN ('pending','failed','deindex') -> survives
LiteLLM/Qdrant outages and deploys. Failures NEVER block the CRUD path.
"""
from __future__ import annotations

from betriebsprofil import heim_default  # external deployment: no silent home-network fallback
import asyncio
import hashlib
import json
import logging
import os
import re

import httpx

from database import get_pool, user_tx

# Service paths: indexing, status updates and the reconciler run for every
# object regardless of user, on the plain pool (superuser, bypasses RLS).
# Only _user_collection_ids acts for a user and runs in user_tx.

logger = logging.getLogger(__name__)

QDRANT_URL = heim_default("KB_QDRANT_URL")
LITELLM_URL = (os.environ.get("KB_LITELLM_URL")
               or os.environ.get("LITELLM_BASE_URL")
               or heim_default("KB_LITELLM_URL", key="KB_LITELLM_URL@kb_indexer"))
# ── Data class (see services/datenklasse.py) ─────────────────────────────
# Warning: **found while introducing data classes:** every knowledge object —
# title and text — is sent to **OpenAI** for embedding. That affects the whole
# knowledge store, not individual requests. By classification this is
# `oeffentlich`, although the content would be `intern`.
#
# **Why it stays like this for now.** A local embedding model would be the
# replacement — but embeddings from
# different models are **not comparable**. Switching invalidates the entire
# vector index; every existing similarity search returns nonsense until
# everything is recomputed. That is a migration decision, not a line of code —
# and it belongs to the owner.
DATENKLASSE = "oeffentlich"
DATENKLASSE_ERZWUNGEN = False
DATENKLASSE_SOLL = "intern"   # achievable by rebuilding the index

EMBEDDING_MODEL = os.environ.get("KB_EMBEDDING_MODEL", "text-embedding-3-small")
COLLECTION = os.environ.get("KB_QDRANT_COLLECTION", "claraos_objects")
VECTOR_DIM = 1536

MAX_CHUNK = 2400
MIN_CHUNK_FOR_SPLIT = 2000
OVERLAP_CHARS = 200

RECONCILE_INTERVAL = int(os.environ.get("KB_RECONCILE_INTERVAL", "60"))
RECONCILE_BATCH = 20

_reconciler_task: asyncio.Task | None = None
_collection_ready = False


def _litellm_key() -> str:
    return os.environ.get("LITELLM_MASTER_KEY", "") or os.environ.get("KB_LITELLM_KEY", "")


# ── Chunking (adapted from index_knowledge_v2.py) ───────────────────────────

def chunk_markdown(body: str, header_prefix: str = "") -> list[str]:
    """~2000-char chunks, H2/H3 section- and paragraph-aware, with overlap."""
    section_pattern = re.compile(r"(?=^##+\s)", re.M)
    sections = [s.strip() for s in section_pattern.split(body) if s.strip()]
    if not sections:
        sections = [body.strip()] if body.strip() else []

    chunks: list[str] = []
    current = ""
    for sec in sections:
        if len(sec) > MAX_CHUNK:
            for p in re.split(r"\n\n+", sec):
                if len(current) + len(p) + 2 > MAX_CHUNK and len(current) >= MIN_CHUNK_FOR_SPLIT:
                    chunks.append(current.strip())
                    current = p
                else:
                    current = (current + "\n\n" + p) if current else p
        else:
            if len(current) + len(sec) + 2 > MAX_CHUNK and len(current) >= MIN_CHUNK_FOR_SPLIT:
                chunks.append(current.strip())
                current = sec
            else:
                current = (current + "\n\n" + sec) if current else sec
    if current.strip():
        chunks.append(current.strip())

    if len(chunks) > 1 and OVERLAP_CHARS > 0:
        out = [chunks[0]]
        for prev, cur in zip(chunks, chunks[1:]):
            tail = prev[-OVERLAP_CHARS:]
            m = re.search(r"[.!?]\s", tail)
            if m:
                tail = tail[m.end():]
            out.append((tail + "\n\n" + cur).strip() if tail.strip() else cur)
        chunks = out

    if header_prefix:
        chunks = [f"{header_prefix}\n\n{c}" for c in chunks]
    return chunks


def make_point_id(object_id: str, chunk_idx: int) -> str:
    h = hashlib.sha256(f"{object_id}#{chunk_idx}".encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def build_embed_text(obj: dict) -> str:
    """Title + type/stage + flat properties as an anchor before the body."""
    lines = [f"# {obj.get('title') or ''}".strip()]
    kind = obj.get("type") or ""
    if obj.get("stage"):
        kind += f" / {obj['stage']}"
    if kind:
        lines.append(kind)
    props = obj.get("properties") or {}
    if isinstance(props, str):
        try:
            props = json.loads(props)
        except ValueError:
            props = {}
    for k, v in props.items():
        if isinstance(v, (str, int, float, bool)) and str(v).strip():
            lines.append(f"{k}: {v}")
    return "\n".join(lines), obj.get("body") or ""


# ── Qdrant / LiteLLM ────────────────────────────────────────────────────────

async def ensure_collection(client: httpx.AsyncClient) -> None:
    global _collection_ready
    if _collection_ready:
        return
    r = await client.get(f"{QDRANT_URL}/collections/{COLLECTION}")
    if r.status_code != 200:
        r = await client.put(
            f"{QDRANT_URL}/collections/{COLLECTION}",
            json={"vectors": {"size": VECTOR_DIM, "distance": "Cosine"}},
        )
        r.raise_for_status()
    for field in ("owner", "visibility", "type", "object_id", "shared_with", "collection_ids"):
        await client.put(
            f"{QDRANT_URL}/collections/{COLLECTION}/index",
            json={"field_name": field, "field_schema": "keyword"},
        )  # 4xx for an existing index is fine
    _collection_ready = True


async def embed_texts(client: httpx.AsyncClient, texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    r = await client.post(
        f"{LITELLM_URL}/v1/embeddings",
        json={"model": EMBEDDING_MODEL, "input": [t[:8000] for t in texts]},
        headers={"Authorization": f"Bearer {_litellm_key()}"},
        timeout=60.0,
    )
    r.raise_for_status()
    return [d["embedding"] for d in r.json()["data"]]


async def _delete_points(client: httpx.AsyncClient, object_id: str) -> None:
    r = await client.post(
        f"{QDRANT_URL}/collections/{COLLECTION}/points/delete?wait=true",
        json={"filter": {"must": [{"key": "object_id", "match": {"value": object_id}}]}},
    )
    r.raise_for_status()


async def _set_rag_status(object_id: str, status: str, stamp: bool = False) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE claraos_kb_objects SET rag_status = $2"
            + (", rag_indexed_at = NOW()" if stamp else "")
            + " WHERE id = $1::uuid",
            object_id, status,
        )


# ── Core operations ─────────────────────────────────────────────────────────

async def index_object(object_id: str) -> None:
    """(Re)index an object. Sets rag_status ok/failed/skip; never raises."""
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, type, owner, visibility, title, body, properties, stage, "
                "       updated_at, deleted_at "
                "FROM claraos_kb_objects WHERE id = $1::uuid",
                object_id,
            )
            shares = await conn.fetch(
                "SELECT shared_with FROM claraos_kb_shares WHERE object_id = $1::uuid",
                object_id,
            ) if row else []
            # Collection shares — the payload carries the collections the object
            # is in; WHO may see the collection is decided by the search at
            # runtime (no re-embedding when shares change).
            colls = await conn.fetch(
                "SELECT collection_id::text AS cid FROM claraos_kb_collection_items "
                "WHERE object_id = $1::uuid", object_id,
            ) if row else []
        if not row:
            return
        obj = dict(row)
        shared_with = [s["shared_with"] for s in shares]
        collection_ids = [c["cid"] for c in colls]
        if obj["deleted_at"] is not None:
            await deindex_object(object_id)
            return

        header, body = build_embed_text(obj)
        chunks = chunk_markdown(body, header_prefix=header) or [header]

        async with httpx.AsyncClient(timeout=30.0) as client:
            await ensure_collection(client)
            vectors = await embed_texts(client, chunks)
            await _delete_points(client, object_id)
            points = [
                {
                    "id": make_point_id(object_id, i),
                    "vector": vec,
                    "payload": {
                        "object_id": object_id,
                        "owner": obj["owner"],
                        "visibility": obj["visibility"],
                        "shared_with": shared_with,
                        "collection_ids": collection_ids,
                        "type": obj["type"],
                        "stage": obj["stage"],
                        "title": obj["title"],
                        "content": chunk[:3000],
                        "chunk_idx": i,
                        "updated_at": obj["updated_at"].isoformat(),
                    },
                }
                for i, (chunk, vec) in enumerate(zip(chunks, vectors))
            ]
            r = await client.put(
                f"{QDRANT_URL}/collections/{COLLECTION}/points?wait=true",
                json={"points": points},
            )
            r.raise_for_status()
        await _set_rag_status(object_id, "ok", stamp=True)
    except Exception as exc:
        logger.warning("[kb-indexer] index %s failed: %s", object_id, exc)
        try:
            await _set_rag_status(object_id, "failed")
        except Exception:
            pass


async def update_collection_ids(object_id: str) -> None:
    """After adding to/removing from a collection, update only the payload —
    without re-embedding. Objects without points (rag_status != ok) are left
    alone; they get their collections on the next index_object. Never raises."""
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            colls = await conn.fetch(
                "SELECT collection_id::text AS cid FROM claraos_kb_collection_items "
                "WHERE object_id = $1::uuid", object_id)
        ids = [c["cid"] for c in colls]
        async with httpx.AsyncClient(timeout=30.0) as client:
            await ensure_collection(client)
            r = await client.post(
                f"{QDRANT_URL}/collections/{COLLECTION}/points/payload?wait=true",
                json={"payload": {"collection_ids": ids},
                      "filter": {"must": [{"key": "object_id", "match": {"value": object_id}}]}},
            )
            r.raise_for_status()
    except Exception as exc:
        logger.warning("[kb-indexer] collection_ids %s failed: %s", object_id, exc)


async def backfill_collection_ids() -> int:
    """One-off after introducing collection shares: all objects that are in
    collections get `collection_ids` in their payload."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT object_id::text AS oid FROM claraos_kb_collection_items")
    for r in rows:
        await update_collection_ids(r["oid"])
    return len(rows)


async def _user_collection_ids(user: str) -> list[str]:
    """Collections the user owns or that are shared with them (user path: RLS)."""
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            "SELECT c.id::text AS cid FROM claraos_kb_collections c "
            "WHERE c.owner = $1 OR EXISTS (SELECT 1 FROM claraos_kb_collection_shares s "
            "WHERE s.collection_id = c.id AND s.shared_with = $1)", user)
    return [r["cid"] for r in rows]


async def deindex_object(object_id: str) -> None:
    """Remove the points of a (deleted) object. Never raises."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            await ensure_collection(client)
            await _delete_points(client, object_id)
        await _set_rag_status(object_id, "skip")
    except Exception as exc:
        logger.warning("[kb-indexer] deindex %s failed: %s", object_id, exc)
        try:
            await _set_rag_status(object_id, "deindex")  # reconciler retries
        except Exception:
            pass


async def search(query: str, user: str, type_filter: str | None = None,
                 limit: int = 8) -> list[dict]:
    """Semantic search WITH a server-side visibility filter.

    `user` MUST come from the trusted header (routers/knowledge.py) — never
    from LLM arguments. Filter: own objects OR family-visible objects OR shared
    with me OR in a collection that I own / that is shared with me (the same
    four sources as `_VIS` in routers/knowledge.py).
    """
    coll_ids = await _user_collection_ids(user)
    async with httpx.AsyncClient(timeout=30.0) as client:
        await ensure_collection(client)
        vec = (await embed_texts(client, [query]))[0]
        should: list[dict] = [
            {"key": "owner", "match": {"value": user}},
            {"key": "visibility", "match": {"value": "family"}},
            # objects shared with me (payload array, match = contains)
            {"key": "shared_with", "match": {"value": user}},
        ]
        if coll_ids:
            # Qdrant >= 1.1: `any` = intersection between payload array and list
            should.append({"key": "collection_ids", "match": {"any": coll_ids}})
        flt: dict = {"must": [{"should": should}]}
        if type_filter:
            flt["must"].append({"key": "type", "match": {"value": type_filter}})
        r = await client.post(
            f"{QDRANT_URL}/collections/{COLLECTION}/points/search",
            json={"vector": vec, "filter": flt,
                  "limit": max(1, min(limit, 20)), "with_payload": True},
        )
        r.raise_for_status()
        hits = r.json().get("result", [])
    # only the best chunk per object
    best: dict[str, dict] = {}
    for h in hits:
        p = h.get("payload") or {}
        oid = p.get("object_id")
        if oid and (oid not in best or h.get("score", 0) > best[oid]["score"]):
            best[oid] = {
                "object_id": oid, "title": p.get("title"), "type": p.get("type"),
                "stage": p.get("stage"), "snippet": (p.get("content") or "")[:400],
                "score": round(h.get("score", 0), 4),
            }
    return sorted(best.values(), key=lambda x: -x["score"])


# ── Reconciler ──────────────────────────────────────────────────────────────

async def _reconcile_once() -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id::text AS id, rag_status FROM claraos_kb_objects "
            "WHERE rag_status IN ('pending','failed','deindex') "
            "ORDER BY updated_at LIMIT $1",
            RECONCILE_BATCH,
        )
    for r in rows:
        if r["rag_status"] == "deindex":
            await deindex_object(r["id"])
        else:
            await index_object(r["id"])
    return len(rows)


async def _reconcile_loop() -> None:
    # small start delay so the API start does not collide with Qdrant checks
    await asyncio.sleep(10)
    while True:
        try:
            n = await _reconcile_once()
            if n:
                logger.info("[kb-indexer] reconciled %d object(s)", n)
        except Exception as exc:
            logger.warning("[kb-indexer] reconcile loop error: %s", exc)
        await asyncio.sleep(RECONCILE_INTERVAL)


def start_background() -> None:
    global _reconciler_task
    if _reconciler_task is None or _reconciler_task.done():
        _reconciler_task = asyncio.get_event_loop().create_task(_reconcile_loop())
        logger.warning("[kb-indexer] reconciler started (interval=%ss)", RECONCILE_INTERVAL)


def stop_background() -> None:
    global _reconciler_task
    if _reconciler_task is not None:
        _reconciler_task.cancel()
        _reconciler_task = None
