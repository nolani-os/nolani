"""Which optional apps this cell runs — for the tests (same rule as betriebsprofil.py).

run_tests.sh passes CLARAOS_OPTIONAL_APPS from .env. Unset or `all` = everything a
cell had before the switch existed (all apps except Odoo). EMPTY = only the core —
not the same as unset (an `or "all"` here once turned a core-only cell into "all
apps on" for every test).
"""
import os

_ALLE = {"photos", "documents", "browser", "office", "teams"}
_roh = os.environ.get("CLARAOS_OPTIONAL_APPS")
_roh = "all" if _roh is None else _roh.strip().lower()
AN = _ALLE if _roh == "all" else {a.strip() for a in _roh.split(",") if a.strip()}


def an(app: str) -> bool:
    return app in AN


def uebersprungen(nummer: str, was: str, app: str) -> None:
    print(f"{nummer} {was}: App „{app}“ aus — übersprungen")
