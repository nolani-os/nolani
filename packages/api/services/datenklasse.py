"""Data class — what a call processes, not which model it wants.

**The problem this module solves.** Previously every caller chose a *model*
itself — `cheap/gemini-flash`, `premium/claude-sonnet`. But a model name says
nothing about whether the data may leave the house. "Local for sensitive data"
was thus an **intention, not a property**: it lived in comments, nowhere in
the actual flow.

Here the caller instead declares **what it processes**. Which model may see
that is decided by this file — in one place, auditable.

    oeffentlich   (public)        any model
    intern        (internal)      EU-hosted or local only
    vertraulich   (confidential)  local only — **error** if unavailable

Important: **without a value, `vertraulich` applies.** The same failure
direction as `inbox_classify._gate()`: whoever says nothing gets the
protection, not the convenience. A forgotten parameter must never be a leak.

Important: **an outage stays an outage.** There is deliberately no "in an
emergency just use the cloud" branch. That is how the promise dies silently —
the caller gets a normal answer and notices nothing.

---

**Why a table and not a prefix test.** The obvious approach would be
`modell.startswith("local/")`. Checked against the running gateway
configuration, it would be wrong in several places:

  * Some aliases without a `local/` prefix (e.g. a generic `classifier`
    alias) may point to a local model. They are **local** but not named
    that way. Going by the prefix forbids them needlessly.
  * Aliases with a price prefix such as `cheap/` or `premium/` may run at an
    EU-hosted provider. The prefix describes the *price*, not the
    *location*. Going by the prefix treats these EU models as non-EU models.
  * `clara/everyday` points to the agent, and **it picks a model itself**.
    Its location fundamentally cannot be read from the name.

The table is therefore generated from the running configuration and checked
against it by a drift check. A table nobody maintains would
be a lie after the first new model.
"""
from __future__ import annotations

from betriebsprofil import heim_struktur

KLASSEN: tuple[str, ...] = ("oeffentlich", "intern", "vertraulich")

# Warning: the default is the strictest class. Do not change it lightly —
# the module's entire failure direction depends on this line.
STANDARD = "vertraulich"

ORTE: tuple[str, ...] = ("lokal", "eu", "extern", "durchgereicht")

ERLAUBTE_ORTE: dict[str, frozenset[str]] = {
    "oeffentlich": frozenset(ORTE),
    "intern": frozenset({"lokal", "eu"}),
    "vertraulich": frozenset({"lokal"}),
}

# Where each model of the gateway runs, which ones read images, and the
# fallback order within a class. The values belong to an installation's own
# gateway configuration (keep them in sync with a drift check); the product
# ships only the one entry it can vouch for in every installation
# (`clara/everyday`). An installation supplies its tables via `heim_werte`.
#
# Important: a model missing from ORT counts as `extern` — see `ort()`. An alias
# whose name suggests a local model proves nothing: in the cell configuration
# `claude-haiku-4-5` is the hosted model, in another installation the same
# alias may point to a local one. Only the table of the installation decides.
_ORT_PRODUKT: dict[str, str] = {
    # Routes onward by itself — the location cannot be guaranteed.
    "clara/everyday": "durchgereicht",
}
ORT: dict[str, str] = heim_struktur("HEIM_MODELL_ORT", _ORT_PRODUKT)

# How the gateway reports itself on fallback — measured, not assumed: when a
# model is unreachable and the gateway falls back, the response reports the
# provider's raw model name without the provider prefix, not the alias. Without
# the raw names, a successfully answering local model would count as `extern`
# and the post-check in `llm.py` would reject exactly the request it protects.
ORT_ROH: dict[str, str] = heim_struktur("HEIM_MODELL_ORT_ROH", {})

# Which models can read images. Only what is proven belongs here: a guess would
# be worse than a gap (the gap costs an error message, the guess a failure in
# the middle of an operation).
BILDFAEHIG: frozenset[str] = heim_struktur("HEIM_MODELL_BILDFAEHIG", frozenset())

# Fallback **within** the class, best first; none for `oeffentlich` (there the
# caller's choice applies). The first entry should be the model that stays
# loaded on the local model server, and only models that actually answer belong
# here — a model the provider rejects silently falls back to whatever the
# gateway's fallback is.
VORZUG: dict[str, tuple[str, ...]] = heim_struktur("HEIM_MODELL_VORZUG", {})


class DatenklasseVerletzt(Exception):
    """The call would have sent data to a disallowed location.

    Deliberately an exception and not a silent substitute: whoever says
    `vertraulich` and has no local model should **notice**.
    """


def normalisieren(klasse: str | None) -> str:
    """Unknown or missing values become the strictest class."""
    k = (klasse or "").strip().lower()
    return k if k in KLASSEN else STANDARD


def ort(modell: str) -> str:
    """Where does this model run? Unknown counts as `extern`.

    Fail-closed in the likely direction: a model that newly appears in the
    configuration and is missing here is far more often a new cloud model than
    a new local one. Treating it as `extern` blocks it for `vertraulich` — the
    safe side of the error.
    """
    name = (modell or "").strip()
    if name in ORT:
        return ORT[name]
    # Fallback answers carry the raw name without provider prefix.
    return ORT_ROH.get(name.split("/", 1)[-1], "extern")


def erlaubt(modell: str, klasse: str | None) -> bool:
    return ort(modell) in ERLAUBTE_ORTE[normalisieren(klasse)]


def pruefen(modell: str, klasse: str | None) -> None:
    """Raises if `modell` is not allowed for `klasse`."""
    k = normalisieren(klasse)
    if not erlaubt(modell, k):
        raise DatenklasseVerletzt(
            f"Datenklasse {k!r} erlaubt keinen Aufruf an {modell!r} "
            f"(Ort: {ort(modell)}; erlaubt: {', '.join(sorted(ERLAUBTE_ORTE[k]))})")


def waehlen(klasse: str | None, wunsch: str = "", *, bild: bool = False) -> str:
    """The model this call may use.

    The requested model applies if it fits the class. Otherwise it is replaced
    **within** the class — never beyond. If nothing is left,
    `DatenklasseVerletzt` is raised.
    """
    k = normalisieren(klasse)
    wunsch = (wunsch or "").strip()

    if wunsch and erlaubt(wunsch, k) and (not bild or wunsch in BILDFAEHIG):
        return wunsch

    for kandidat in VORZUG.get(k, ()):
        if erlaubt(kandidat, k) and (not bild or kandidat in BILDFAEHIG):
            return kandidat

    if k == "oeffentlich" and wunsch:
        return wunsch

    raise DatenklasseVerletzt(
        f"Fuer Datenklasse {k!r} steht kein "
        f"{'bildfaehiges ' if bild else ''}Modell zur Verfuegung"
        + (f" (gewuenscht war {wunsch!r}, Ort {ort(wunsch)})" if wunsch else ""))
