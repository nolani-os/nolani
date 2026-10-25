"""Marker / region-selection context injection for Clara chat.

When the user pins a region with the ChatPanel pin button, the next /completions
request carries it under `body.meta.marker`. We translate that into:

  * a structured text block prepended to the last user message, so the LLM
    sees identifiers (object-id, IFC class, GeoJSON bounds, …) without having
    to OCR them from the image
  * for image-bearing kinds (bbox-img, cad-object) — an `image_url` content
    block appended to the same user message, so vision-capable models see
    the marked-up snapshot directly

Both happen via in-place mutation of the messages list so downstream code
(WebUI strip-and-replay system message, etc.) does not need to know about
markers at all.

**Vision pre-pass:** clara-agent (the default 'clara' model) is
NOT vision-capable in its text-pipeline (multipart content gets flattened in
_flatten_content, image_url is dropped). To still give it useful image
context, we run a Gemini-Flash pre-pass on bbox-img / cad-object markers
BEFORE injection — the resulting description is embedded into the text-block
so even text-only routes have rich context. Pre-pass is hash-cached for
5 min to avoid duplicate calls when the user edits & re-sends.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from typing import Any

import httpx
from betriebsprofil import IS_CELL
from services import datenklasse

logger = logging.getLogger(__name__)

# ── Vision pre-pass cache (snapshot-hash → (timestamp, description)) ────────
_VISION_CACHE: dict[str, tuple[float, str]] = {}
_VISION_TTL_S = 300
# The vision model as the gateway names it: a cell's LiteLLM lists plain names
# (deploy/cell), the home gateway tiered ones. With the wrong name every image was
# answered with "description not available". CLARAOS_VISION_MODEL overrides both.
_VISION_MODEL = (os.environ.get("CLARAOS_VISION_MODEL")
                 or ("gemini-flash" if IS_CELL else "cheap/gemini-flash"))


async def vision_describe(
    snapshot_b64: str,
    hint: str,
    *,
    litellm_url: str,
    litellm_key: str,
    bbox_hint: str = "",
    timeout: float = 20.0,
) -> str:
    """Run a single-pass vision describe via LiteLLM directly (bypasses
    OpenWebUI which strips image_url blocks from /api/chat/completions).
    Returns a 2-4-sentence description or empty string on failure.
    Cached by snapshot-hash for 5 min.

    The PNG arriving here is *annotated* — MarkerJS has rendered the user's
    drawn rectangle / arrow / freehand strokes on top of the source image.
    The prompt explicitly redirects Gemini to describe ONLY what's inside
    or directly under the markup, not the rest of the image.
    """
    if not snapshot_b64 or not litellm_url or not litellm_key:
        return ""
    # Cache key includes bbox so a different region on same image isn't reused
    cache_input = f"{snapshot_b64}|{bbox_hint}"
    h = hashlib.sha256(cache_input.encode()).hexdigest()[:16]
    now = time.time()
    cached = _VISION_CACHE.get(h)
    if cached and now - cached[0] < _VISION_TTL_S:
        return cached[1]

    bbox_line = f"\n\nThe primary annotation is at: {bbox_hint}." if bbox_hint else ""

    prompt = (
        "The image you see has been ANNOTATED by a user — they have drawn "
        "one or more visible markings on it (red/colored bounding boxes, "
        "arrows, freehand strokes, highlights, text labels).\n\n"
        "Your task: describe in 2-4 sentences ONLY what is inside or "
        "directly underneath the user's annotation. Ignore the surrounding "
        "image content unless it's needed for context.\n\n"
        "Rules:\n"
        "- If a box is drawn, describe what is *inside* the box.\n"
        "- If an arrow points to something, describe what it points AT.\n"
        "- If a freehand stroke circles something, describe what's circled.\n"
        "- If multiple annotations exist, describe each briefly.\n"
        "- Be concrete: name objects, colors, text, components. No fluff.\n"
        f"- Reply in German if the source hint suggests a German context.\n\n"
        f"Source hint: {hint}{bbox_line}"
    )

    # Warning: data class `oeffentlich` (public) — **with an open issue**. A
    # screenshot of the user's screen goes to the model here, and nobody knows
    # in advance what it shows: it may be a Wikipedia page or a bank statement.
    # Unlike the mail inbox, there is **no `_gate()`** that checks beforehand.
    #
    # Important: deliberately not made stricter silently: `intern` would disable
    # the feature today, because no verified vision-capable EU or local model is
    # configured. This classification is therefore the most honest one
    # available — and this is the line to revisit once a vision-capable local
    # model is running.
    modell = datenklasse.waehlen("oeffentlich", _VISION_MODEL, bild=True)
    body = {
        "model": modell,
        # Gemini 3 Flash "thinks" before answering and used up its whole budget
        # with 300 tokens (finish=length, 93 characters of text). More budget +
        # low reasoning, otherwise every description stops mid-sentence.
        "max_tokens": 1500,
        "reasoning_effort": "low",
        "stream": False,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{snapshot_b64}"},
                    },
                ],
            }
        ],
    }
    url = f"{litellm_url.rstrip('/')}/v1/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                url,
                json=body,
                headers={
                    "Authorization": f"Bearer {litellm_key}",
                    "Accept": "application/json",
                },
            )
        if resp.status_code != 200:
            logger.warning(
                "vision pre-pass HTTP %s: %s",
                resp.status_code,
                resp.text[:200],
            )
            return ""
        data = resp.json()
    except Exception:  # noqa: BLE001
        logger.exception("vision pre-pass failed (network/parse)")
        return ""

    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if isinstance(content, list):
        content = " ".join(
            p.get("text", "")
            for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
    desc = (content or "").strip()
    if desc:
        _VISION_CACHE[h] = (now, desc)
    return desc


async def bild_beschreiben(
    bild_b64: str,
    name: str,
    *,
    litellm_url: str,
    litellm_key: str,
    mime: str = "image/jpeg",
    timeout: float = 25.0,
) -> str:
    """General description of an image attached by the user (phone photo,
    screenshot, photo of a document). Unlike `vision_describe` there is NO
    annotation here — the marker prompt answered a plain photo with "no
    annotation found" and gave up. Describes the whole image, readable text
    verbatim."""
    if not bild_b64 or not litellm_url or not litellm_key:
        return ""
    h = hashlib.sha256(("anhang|" + bild_b64).encode()).hexdigest()[:16]
    now = time.time()
    cached = _VISION_CACHE.get(h)
    if cached and now - cached[0] < _VISION_TTL_S:
        return cached[1]
    prompt = (
        "Beschreibe dieses Bild in 3-6 Sätzen auf Deutsch, konkret und ohne "
        "Floskeln: Was ist zu sehen (Objekte, Personen ohne Identifizierung, "
        "Farben, Formen, Anordnung), welcher Art ist das Bild (Foto, Screenshot, "
        "Dokument, Zeichnung)? Steht Text im Bild, gib ihn wörtlich wieder "
        "(Zahlen, Beträge, Zählerstände, Etiketten). Nenne Unsicheres als "
        f"unsicher. Dateiname: {name}"
    )
    modell = datenklasse.waehlen("oeffentlich", _VISION_MODEL, bild=True)
    body = {
        "model": modell,
        "max_tokens": 1500,          # see vision_describe: reasoning tokens count too
        "reasoning_effort": "low",
        "stream": False,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{bild_b64}"}},
        ]}],
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{litellm_url.rstrip('/')}/v1/chat/completions", json=body,
                headers={"Authorization": f"Bearer {litellm_key}", "Accept": "application/json"},
            )
        if resp.status_code != 200:
            logger.warning("bild_beschreiben HTTP %s: %s", resp.status_code, resp.text[:200])
            return ""
        data = resp.json()
    except Exception:  # noqa: BLE001
        logger.exception("bild_beschreiben failed (network/parse)")
        return ""
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if isinstance(content, list):
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    desc = (content or "").strip()
    if desc:
        _VISION_CACHE[h] = (now, desc)
    return desc


async def enrich_marker_with_vision(
    marker: dict[str, Any],
    *,
    litellm_url: str,
    litellm_key: str,
) -> dict[str, Any]:
    """If marker is image-bearing (bbox-img / cad-object), run a vision
    pre-pass and attach `vision_description` to a copy of the marker. The
    description is then embedded into the marker text-block by
    `_build_text_block` below.

    Returns the marker unchanged for non-image kinds or on pre-pass failure.
    Never raises — caller should always be able to use the returned dict.
    """
    if not isinstance(marker, dict):
        return marker
    kind = marker.get("kind")
    if kind not in ("bbox-img", "cad-object"):
        return marker
    snapshot = marker.get("snapshot_b64") or marker.get("snapshotB64")
    if not snapshot:
        return marker

    app_id = marker.get("app_id") or marker.get("appId") or "unknown"
    obj_id = marker.get("object_id") or marker.get("objectId") or ""
    hint = f"app={app_id}" + (f", object={obj_id}" if obj_id else "")

    # Pass the bbox to the describer so it can prefer the marked area when
    # the image has multiple visual elements but only one user-drawn region.
    bbox = marker.get("bbox_px") or marker.get("bboxPx")
    bbox_hint = ""
    if isinstance(bbox, dict):
        bbox_hint = (
            f"x={bbox.get('x')}, y={bbox.get('y')}, "
            f"w={bbox.get('w')}, h={bbox.get('h')} (pixels)"
        )

    try:
        desc = await vision_describe(
            snapshot,
            hint,
            litellm_url=litellm_url,
            litellm_key=litellm_key,
            bbox_hint=bbox_hint,
        )
    except Exception:  # noqa: BLE001
        logger.exception("enrich_marker_with_vision: pre-pass raised")
        desc = ""

    if not desc:
        return marker
    enriched = dict(marker)
    enriched["vision_description"] = desc
    return enriched


def _build_text_block(marker: dict[str, Any]) -> str:
    """Context paragraph describing the pinned region.

    Phrased as natural first-person user text rather than bracketed labels —
    this avoids triggering Sonnet's prompt-injection defense (which flags
    headers like `[VISION DESCRIPTION (...)]` and `NOTE:` as suspicious
    pseudo-system instructions and tells the model to ignore them).
    """
    kind = marker.get("kind")
    app_id = marker.get("app_id") or marker.get("appId") or "unknown"
    obj_uri = marker.get("object_uri") or marker.get("objectUri") or ""

    if kind == "bbox-img":
        bbox = marker.get("bbox_px") or marker.get("bboxPx")
        bbox_str = ""
        if isinstance(bbox, dict):
            bbox_str = (
                f" (Pixel-Bbox x={bbox.get('x')}, y={bbox.get('y')}, "
                f"w={bbox.get('w')}, h={bbox.get('h')})"
            )
        desc = marker.get("vision_description") or ""
        if desc:
            return (
                f"Ich habe in der App **{app_id}** "
                f"({obj_uri}) eine Region markiert{bbox_str}. "
                f"Hier eine automatische Bildbeschreibung:\n\n"
                f"{desc}\n\n"
                f"Meine Frage dazu:"
            )
        return (
            f"Ich habe in der App **{app_id}** "
            f"({obj_uri}) eine Region markiert{bbox_str}. "
            f"Eine Bildbeschreibung steht gerade nicht zur Verfügung — "
            f"frag mich gerne, was im markierten Bereich zu sehen ist. "
            f"Meine Frage dazu:"
        )

    if kind == "svg-element":
        elem_id = marker.get("element_id") or marker.get("elementId") or "(unbekannt)"
        outer = marker.get("outer_html") or marker.get("outerHTML") or ""
        snippet = outer[:1000]
        truncated = "" if len(outer) <= 1000 else "\n…(gekürzt)"
        return (
            f"Ich habe in der App **{app_id}** "
            f"({obj_uri}) ein Diagramm-Element angewählt: id=`{elem_id}`. "
            f"Das Markup-Schnipsel sieht so aus:\n\n"
            f"```xml\n{snippet}{truncated}\n```\n\n"
            f"Meine Frage dazu:"
        )

    if kind == "geojson":
        feature = marker.get("feature")
        feat_str = "(leer)"
        if feature is not None:
            try:
                feat_str = json.dumps(feature, ensure_ascii=False)[:1500]
            except Exception:  # noqa: BLE001
                feat_str = "(nicht serialisierbar)"
        return (
            f"Ich habe in der App **{app_id}** "
            f"({obj_uri}) auf der Karte eine Region gezogen. "
            f"GeoJSON-Feature:\n\n"
            f"```json\n{feat_str}\n```\n\n"
            f"Meine Frage dazu:"
        )

    if kind == "cad-object":
        obj_id = marker.get("object_id") or marker.get("objectId") or "(unbekannt)"
        bim = marker.get("bim_props") or marker.get("bimProps") or {}
        bim_str = "(keine)"
        if isinstance(bim, dict) and bim:
            try:
                bim_str = json.dumps(bim, ensure_ascii=False)
            except Exception:  # noqa: BLE001
                bim_str = "(nicht serialisierbar)"
        desc = marker.get("vision_description") or ""
        intro = (
            f"Ich habe in der App **{app_id}** "
            f"({obj_uri}) ein 3D-Objekt angewählt: id=`{obj_id}`. "
            f"Eigenschaften: {bim_str}."
        )
        if desc:
            return (
                f"{intro}\n\n"
                f"Hier eine automatische Beschreibung des 3D-Standbilds:\n\n"
                f"{desc}\n\n"
                f"Meine Frage dazu:"
            )
        return (
            f"{intro}\n"
            f"Ein 3D-Standbild ist angehängt; eine automatische Beschreibung "
            f"liegt gerade nicht vor. Meine Frage dazu:"
        )

    return f"(Marker mit unbekanntem Typ: {kind})"


def _snapshot_b64(marker: dict[str, Any]) -> str | None:
    """Return base64 PNG payload (without data: prefix) if the marker carries one."""
    raw = marker.get("snapshot_b64") or marker.get("snapshotB64")
    if isinstance(raw, str) and raw:
        return raw
    return None


def apply_marker_to_messages(messages: list[dict[str, Any]], marker: dict[str, Any]) -> None:
    """Mutate `messages` in-place to inject the marker context.

    * Prepends a structured text block to the LAST user message.
    * For image-bearing kinds, converts that user message to OpenAI multipart
      format and appends an `image_url` block with a `data:image/png;base64,…`
      URL holding the snapshot.

    No-op if `messages` has no user message or `marker` is empty/invalid.
    """
    if not isinstance(marker, dict) or not marker:
        return
    if not isinstance(messages, list) or not messages:
        return

    text_block = _build_text_block(marker)
    snapshot = _snapshot_b64(marker)
    needs_image = bool(snapshot) and marker.get("kind") in ("bbox-img", "cad-object")

    # Find the LAST user message (mutate it).
    target_idx = -1
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            target_idx = i
            break
    if target_idx < 0:
        return

    target = messages[target_idx]
    existing = target.get("content")

    if needs_image:
        # Convert to multipart array; prepend our text block, append image.
        parts: list[dict[str, Any]] = []
        parts.append({"type": "text", "text": text_block})
        if isinstance(existing, str):
            if existing:
                parts.append({"type": "text", "text": existing})
        elif isinstance(existing, list):
            parts.extend(existing)
        parts.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{snapshot}"},
            }
        )
        target["content"] = parts
        return

    # Text-only kinds: prepend block to existing content.
    if isinstance(existing, str):
        target["content"] = text_block + "\n\n" + existing if existing else text_block
    elif isinstance(existing, list):
        target["content"] = [{"type": "text", "text": text_block}] + existing
    else:
        target["content"] = text_block
