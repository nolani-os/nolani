"""Import one card from a source — the same rule for ALL sources.

Why this is a module of its own: the order here is subtle and justified case
by case. If it existed twice in the code (once for vCard, once for Google), it
would certainly drift apart — precisely where nobody notices, because both
paths "somehow work".

The order, top to bottom:

1. **Tombstone first.** If the contact was removed in ClaraOS, it stays
   removed — even if the source keeps delivering it. Otherwise deleting would
   have no effect as long as Google still knows the contact. The source shadow
   is still updated: we want to know what the source showed last.

2. **Source reports deletion.** NOT deleted in ClaraOS (ClaraOS is the source
   of truth), but flagged as `source_deleted`. The contact stays, the hint is
   shown on the card.

3. **Unchanged.** If the source shows exactly the same state as last time,
   nothing happens — no revision, no `updated_at`. This is the guard against a
   revision explosion: 2000 contacts synced nightly would otherwise produce
   2000 revisions per night.

4. **Real conflict.** The source changed AND ClaraOS changed too. ClaraOS
   wins here, and the foreign value is **not discarded** but recorded as a
   suggestion. No automatic merge, no silent decision.

5. **Only the source changed.** Take it over, old state goes into the history.

6. **Unknown.** Create a new contact and set the source shadow.
"""
from __future__ import annotations

import logging
from typing import Any

from services import kontakte_store as store

logger = logging.getLogger(__name__)

# Possible outcomes of an import
NEU = "neu"
GEAENDERT = "geaendert"
UNVERAENDERT = "unveraendert"
UEBERSPRUNGEN = "uebersprungen"
KONFLIKT = "konflikt"


async def einspielen(owner: str, quelle: str, konto: str, kennung: str,
                     data: dict[str, Any], handles: list[dict] | None = None,
                     geloescht: bool = False) -> str:
    """Import one card. Returns what happened (see constants)."""
    bekannt = await store.quelle_finden(owner, quelle, konto, kennung)

    # ── 2) The source reports: deleted there ───────────────────────────────
    if geloescht:
        if bekannt:
            await store.quelle_zustand(owner, quelle, konto, kennung, "source_deleted")
        return UEBERSPRUNGEN

    if bekannt:
        # ── 1) Tombstone: "removed" means removed ─────────────────────────────
        if bekannt.get("kontakt_state") == "removed":
            await store.quelle_merken(owner, bekannt["contact_id"], quelle, konto, kennung, data)
            return UEBERSPRUNGEN

        # Source row without a contact (permanently deleted) — creating it
        # again would be a resurrection through the back door.
        if bekannt.get("kontakt_state") is None:
            return UEBERSPRUNGEN

        neu_hash = store.inhalt_hash(data)

        # ── 3) The source has not changed ───────────────────────────────────
        if bekannt["last_seen_hash"] == neu_hash:
            await store.quelle_merken(owner, bekannt["contact_id"], quelle, konto, kennung, data)
            return UNVERAENDERT

        # ── 4) Did BOTH change? ─────────────────────────────────────────────
        # The current ClaraOS state differs from the last seen source state
        # => it was edited by hand here. And the source changed too
        # (otherwise we would have exited in 3).
        try:
            aktuell = await store.hole(owner, bekannt["contact_id"])
        except store.KontaktFehlt:
            return UEBERSPRUNGEN
        eigener_hash = store.inhalt_hash(aktuell["data"])
        if eigener_hash != bekannt["last_seen_hash"]:
            # ClaraOS wins, the foreign value is NOT lost: it is recorded as a
            # suggestion on the card. This is rare enough to show to a human,
            # and too consequential to guess.
            await store.vorschlag_merken(owner, bekannt["contact_id"], quelle, konto,
                                         kennung, data)
            return KONFLIKT

        # ── 5) Only the source changed ──────────────────────────────────────
        veraendert = await store.aendern(owner, bekannt["contact_id"], data,
                                         changed_by=f"import:{quelle}",
                                         reason=store.GRUND_IMPORT)
        await store.quelle_merken(owner, bekannt["contact_id"], quelle, konto, kennung, data)
        return GEAENDERT if veraendert else UNVERAENDERT

    # ── 6) Unknown ──────────────────────────────────────────────────────────
    cid = await store.anlegen(owner, data, changed_by=f"import:{quelle}", handles=handles)
    await store.quelle_merken(owner, cid, quelle, konto, kennung, data)
    return NEU


def zaehler() -> dict[str, int]:
    return {"gesehen": 0, "neu": 0, "geaendert": 0, "unveraendert": 0,
            "uebersprungen": 0, "konflikt": 0}


def zaehlen(z: dict[str, int], ergebnis: str) -> None:
    z["gesehen"] += 1
    z[ergebnis] = z.get(ergebnis, 0) + 1
