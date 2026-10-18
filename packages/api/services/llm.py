"""The central call site for the model gateway.

**Why this file exists.** Before it, many modules called the gateway and only
one of them had a safeguard. Not out of carelessness — there simply was no
place where a safeguard could have lived. Every call built its own
`httpx.post`.

This is that place. `datenklasse` (data class) is a **required argument**:
whoever calls must state what kind of data is being processed. It cannot be
forgotten — Python rejects the call before any data flows.

**Why required instead of a default.** `datenklasse.STANDARD` is
`vertraulich` (confidential), so a default would be safe. But it would also be
**silent**: a new caller would quietly get "local only" and the author would
only notice in production that a decision had been made they never made.
The class is a statement about the data — only the caller can make it.
"""
from __future__ import annotations
from betriebsprofil import heim_default  # no silent home fallback in a cell

import logging
import os
from typing import Any

import httpx

from . import datenklasse as dk

logger = logging.getLogger("claraos.llm")

GATEWAY = (os.environ.get("KB_LITELLM_URL")
           or os.environ.get("LITELLM_URL")
           or heim_default("KB_LITELLM_URL", key="KB_LITELLM_URL@llm"))


def _schluessel() -> str:
    return os.environ.get("LITELLM_MASTER_KEY", "")


async def anfragen(
    *,
    nachrichten: list[dict[str, Any]],
    datenklasse: str,
    modell: str = "",
    max_tokens: int = 1024,
    timeout: float = 60.0,
    bild: bool = False,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Send one request to the gateway, checked against the data class.

    Raises `datenklasse.DatenklasseVerletzt` if the class allows no suitable
    model.

    **The up-front check alone is not enough.** A first version checked the
    class, chose a model and sent. A "`vertraulich` with a cloud model
    requested" call was correctly replaced by a local model — but because
    the local model was unreachable, the gateway silently fell back to a cloud
    provider. The check at the top had passed, yet the data left the house.
    Only the post-check below fired, **after** the data was gone.

    Hence three stages instead of one, and only the middle one actually
    prevents anything:
      1. **before**  — check the model against the class (catches caller mistakes)
      2. **during** — `disable_fallbacks` for everything except `oeffentlich`
         (catches gateway fallbacks — the only real prevention)
      3. **after**  — check the reported model against the class (catches what
         the first two missed; reports, does not prevent)

    Returns the raw gateway response; parsing is left to the caller because
    callers expect very different shapes.
    """
    gewaehlt = dk.waehlen(datenklasse, modell, bild=bild)
    if modell and gewaehlt != modell:
        # Loud, not silent: a substitution changes quality and cost. Without
        # it in the log, you later search in the wrong place.
        logger.info("llm: %r ersetzt durch %r wegen Datenklasse %r",
                    modell, gewaehlt, dk.normalisieren(datenklasse))

    koerper: dict[str, Any] = {
        "model": gewaehlt,
        "messages": nachrichten,
        "max_tokens": max_tokens,
        "stream": False,
    }
    # Warning: **this is the line that makes the difference.** Without it the
    # gateway picks a substitute on its own when a model is unreachable — and
    # its fallback list knows nothing about data classes. Verified:
    # `disable_fallbacks: true` makes the request fail with HTTP 500 instead
    # of rerouting it. That is exactly what we want: an outage stays an
    # outage.
    #
    # For `oeffentlich` (public) fallbacks stay on — there availability is
    # the goal and there is nothing to protect.
    #
    # For `intern` this also costs the *allowed* fallbacks within the EU
    # (`eu/large` -> `eu/medium`). Once the cross-class
    # fallbacks in the gateway are closed (a drift check),
    # this may be relaxed again.
    if dk.normalisieren(datenklasse) != "oeffentlich":
        koerper["disable_fallbacks"] = True

    if extra:
        koerper.update(extra)

    async with httpx.AsyncClient(timeout=timeout) as client:
        antwort = await client.post(
            f"{GATEWAY.rstrip('/')}/v1/chat/completions",
            json=koerper,
            headers={"Authorization": f"Bearer {_schluessel()}",
                     "Accept": "application/json"},
        )
    if antwort.status_code != 200:
        raise httpx.HTTPStatusError(
            f"Gateway antwortete mit {antwort.status_code}: {antwort.text[:200]}",
            request=antwort.request, response=antwort)

    daten = antwort.json()
    # Post-check against the model **actually** used — belt and braces for the
    # above. It **no longer prevents anything**: whatever is caught here has
    # already been sent. It is still here because a noticed leak is different
    # from an unnoticed one — and because it fires if `disable_fallbacks` is
    # renamed or silently ignored in a future LiteLLM version.
    benutzt = str(daten.get("model") or "")
    if benutzt and not dk.erlaubt(benutzt, datenklasse):
        logger.error("llm: Gateway benutzte %r (Ort %s) fuer Datenklasse %r — "
                     "Rueckfall verletzt die Zusage",
                     benutzt, dk.ort(benutzt), dk.normalisieren(datenklasse))
        raise dk.DatenklasseVerletzt(
            f"Gateway wich auf {benutzt!r} aus, unzulaessig fuer "
            f"{dk.normalisieren(datenklasse)!r}")
    return daten
