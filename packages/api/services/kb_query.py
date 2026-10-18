"""Knowledge store: filter/sort compiler for collection views.

Translates the stored filter tree of a view into parameterised SQL over
`claraos_kb_objects.properties` (JSONB). Vocabulary borrowed from AppFlowy
(condition enums per field type) + Anytype (relative date options) + SiYuan
(quantifiers any/all/none for multi-values).

SECURITY — the compiler is the only place where view JSON becomes SQL.
Therefore, without exception:
  * operators only from the whitelist (_OPS), otherwise 400.
  * property keys are NEVER interpolated freely into SQL (see _key_lit below
    for the strict whitelist + character class).
  * values go out exclusively as $n parameters.
This keeps the path injection-free even if a view JSON is manipulated.

Scale: filtering/sorting runs in Postgres (not in-memory like SiYuan/AFFiNE)
-> handles team-sized data too; properties has a GIN index.
"""
from __future__ import annotations

from typing import Any

# field_type IDs (stable, append-only — docs: migrations/019)
FT_TEXT, FT_NUMBER, FT_DATE, FT_SELECT, FT_MULTI_SELECT, FT_URL = 0, 1, 2, 3, 4, 5
FT_CHECKBOX, FT_CHECKLIST, FT_MEDIA, FT_PERSON = 6, 7, 8, 9
FT_RELATION, FT_ROLLUP, FT_CREATED_TIME, FT_UPDATED_TIME, FT_FORMULA = 10, 11, 12, 13, 14

# Allowed conditions per "family" of field types (AppFlowy vocabulary).
_TEXT_OPS = ("is", "is_not", "contains", "not_contains", "starts_with", "ends_with",
             "is_empty", "is_not_empty")
_NUM_OPS = ("eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty")
_DATE_OPS = ("on", "before", "after", "on_or_before", "on_or_after", "between",
             "is_empty", "is_not_empty")
_SELECT_OPS = ("is", "is_not", "contains_any", "contains_all", "contains_none",
               "is_empty", "is_not_empty")
_BOOL_OPS = ("is_checked", "is_unchecked")
_REL_OPS = ("contains_any", "contains_none", "is_empty", "is_not_empty")

_OPS_BY_TYPE: dict[int, tuple[str, ...]] = {
    FT_TEXT: _TEXT_OPS, FT_URL: _TEXT_OPS, FT_PERSON: _SELECT_OPS,
    FT_NUMBER: _NUM_OPS, FT_ROLLUP: _NUM_OPS,
    FT_DATE: _DATE_OPS, FT_CREATED_TIME: _DATE_OPS, FT_UPDATED_TIME: _DATE_OPS,
    FT_SELECT: _SELECT_OPS, FT_MULTI_SELECT: _SELECT_OPS,
    FT_CHECKBOX: _BOOL_OPS, FT_CHECKLIST: ("is_complete", "is_incomplete"),
    FT_RELATION: _REL_OPS, FT_MEDIA: ("is_empty", "is_not_empty"),
}


class FilterError(ValueError):
    """Invalid filter tree — the router turns it into a 400."""


class _Params:
    """Collects SQL parameters and returns stable $n placeholders."""

    def __init__(self, start: int = 0) -> None:
        self.values: list[Any] = []
        self._offset = start

    def add(self, value: Any) -> str:
        self.values.append(value)
        return f"${self._offset + len(self.values)}"


import re as _re

# Property keys are embedded as SQL literals — NOT as parameters:
# `properties ->> $n` is ambiguous for Postgres (-> / ->> are overloaded for
# text AND int) and fails with "could not determine data type"; a ::text cast
# did not help either. This is safe because a key has to pass two hurdles:
#   1. it MUST be in the collection's field registry (whitelist), and
#   2. it must match this character class (no quote gets through).
# VALUES still go out exclusively as $n parameters.
_KEY_RE = _re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


def _key_lit(key: str) -> str:
    if not _KEY_RE.match(key or ""):
        raise FilterError(f"Ungültiger Feld-Schlüssel: {key!r}")
    return "'" + key + "'"


def _text_expr(p: _Params, key: str) -> str:
    return f"(claraos_kb_objects.properties ->> {_key_lit(key)})"


def _json_expr(p: _Params, key: str) -> str:
    return f"(claraos_kb_objects.properties -> {_key_lit(key)})"


def _compile_condition(cond: dict, fields: dict[str, int], p: _Params) -> str:
    key = cond.get("key")
    op = cond.get("op")
    if not isinstance(key, str) or not key:
        raise FilterError("Filter ohne key")
    ftype = fields.get(key)
    if ftype is None:
        raise FilterError(f"Unbekanntes Feld im Filter: {key!r}")
    allowed = _OPS_BY_TYPE.get(ftype, _TEXT_OPS)
    if op not in allowed:
        raise FilterError(f"Operator {op!r} ist für dieses Feld nicht erlaubt")
    value = cond.get("value")

    # Empty/not-empty applies regardless of type
    if op == "is_empty":
        return (f"({_text_expr(p, key)} IS NULL OR {_text_expr(p, key)} = ''"
                f" OR {_json_expr(p, key)} = '[]'::jsonb)")
    if op == "is_not_empty":
        return (f"({_text_expr(p, key)} IS NOT NULL AND {_text_expr(p, key)} <> ''"
                f" AND {_json_expr(p, key)} IS DISTINCT FROM '[]'::jsonb)")

    if ftype in (FT_TEXT, FT_URL) or (ftype == FT_SELECT and op in ("is", "is_not")):
        t = _text_expr(p, key)
        if op == "is":
            return f"{t} = {p.add(str(value))}"
        if op == "is_not":
            return f"({t} IS DISTINCT FROM {p.add(str(value))})"
        if op == "contains":
            return f"{t} ILIKE {p.add(f'%{value}%')}"
        if op == "not_contains":
            return f"({t} IS NULL OR {t} NOT ILIKE {p.add(f'%{value}%')})"
        if op == "starts_with":
            return f"{t} ILIKE {p.add(f'{value}%')}"
        if op == "ends_with":
            return f"{t} ILIKE {p.add(f'%{value}')}"

    if ftype in (FT_NUMBER, FT_ROLLUP):
        # Non-numeric values must not break the cast
        num = (f"(CASE WHEN {_text_expr(p, key)} ~ '^-?[0-9]+(\\.[0-9]+)?$' "
               f"THEN ({_text_expr(p, key)})::numeric END)")
        try:
            val = float(value)
        except (TypeError, ValueError):
            raise FilterError("Zahlen-Filter braucht einen numerischen Wert")
        sym = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
        return f"({num} {sym} {p.add(val)})"

    if ftype in (FT_DATE, FT_CREATED_TIME, FT_UPDATED_TIME):
        base = (f"(CASE WHEN {_text_expr(p, key)} ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}' "
                f"THEN ({_text_expr(p, key)})::date END)")
        if op == "between":
            if not isinstance(value, (list, tuple)) or len(value) != 2:
                raise FilterError("between erwartet [start, ende]")
            return f"({base} BETWEEN {p.add(str(value[0]))}::date AND {p.add(str(value[1]))}::date)"
        rel = _relative_date(value)
        sym = {"on": "=", "before": "<", "after": ">", "on_or_before": "<=", "on_or_after": ">="}[op]
        if rel is not None:
            return f"({base} {sym} (CURRENT_DATE + {p.add(rel)}::int))"
        return f"({base} {sym} {p.add(str(value))}::date)"

    if ftype in (FT_MULTI_SELECT, FT_PERSON, FT_RELATION, FT_SELECT):
        j = _json_expr(p, key)
        vals = value if isinstance(value, (list, tuple)) else [value]
        vals = [str(v) for v in vals]
        # ?| / ?& need text[] — cast explicitly as well
        if op == "contains_any":
            return f"({j} ?| ({p.add(vals)})::text[])"
        if op == "contains_all":
            return f"({j} ?& ({p.add(vals)})::text[])"
        if op == "contains_none":
            return f"(NOT COALESCE({j} ?| ({p.add(vals)})::text[], FALSE))"

    if ftype == FT_CHECKBOX:
        t = _text_expr(p, key)
        want = "true" if op == "is_checked" else "false"
        if op == "is_checked":
            return f"({t} = 'true')"
        return f"({t} IS NULL OR {t} = '{want}')"

    if ftype == FT_CHECKLIST:
        pct = f"(({_json_expr(p, key)} ->> 'percentage'))"
        return (f"({pct} = '100')" if op == "is_complete"
                else f"({pct} IS DISTINCT FROM '100')")

    raise FilterError(f"Operator {op!r} für Feldtyp {ftype} nicht unterstützt")


def _relative_date(value: Any) -> int | None:
    """Anytype pattern: 'today' | 'tomorrow' | 'yesterday' | {'days_ago': n} ...
    -> day offset relative to CURRENT_DATE; None = absolute date."""
    if isinstance(value, str):
        return {"today": 0, "tomorrow": 1, "yesterday": -1}.get(value.lower())
    if isinstance(value, dict):
        if isinstance(value.get("days_ago"), int):
            return -int(value["days_ago"])
        if isinstance(value.get("days_from_now"), int):
            return int(value["days_from_now"])
    return None


def compile_filter(node: dict | None, fields: dict[str, int], p: _Params,
                   depth: int = 0) -> str | None:
    """Filter tree -> SQL fragment (or None if empty).

    Nodes: {"op": "and"|"or", "children": [...]}  |  {"key", "op", "value"}
    """
    if not node or not isinstance(node, dict):
        return None
    if depth > 8:
        raise FilterError("Filterbaum zu tief verschachtelt (max. 8)")
    op = node.get("op")
    if op in ("and", "or"):
        children = node.get("children")
        if not isinstance(children, list):
            raise FilterError("Gruppe ohne children")
        parts = [c for c in (compile_filter(ch, fields, p, depth + 1) for ch in children) if c]
        if not parts:
            return None
        joiner = " AND " if op == "and" else " OR "
        return "(" + joiner.join(parts) + ")"
    return _compile_condition(node, fields, p)


def compile_sorts(sorts: Any, fields: dict[str, int], p: _Params) -> str:
    """Sort list -> ORDER BY. Unknown keys are ignored (not fatal: a deleted
    field should not make the view unusable)."""
    parts: list[str] = []
    for s in (sorts if isinstance(sorts, list) else []):
        if not isinstance(s, dict):
            continue
        key = s.get("key")
        if not isinstance(key, str) or key not in fields:
            continue
        direction = "DESC" if str(s.get("dir", "asc")).lower() == "desc" else "ASC"
        ftype = fields[key]
        if ftype in (FT_NUMBER, FT_ROLLUP):
            expr = (f"(CASE WHEN {_text_expr(p, key)} ~ '^-?[0-9]+(\\.[0-9]+)?$' "
                    f"THEN ({_text_expr(p, key)})::numeric END)")
        elif ftype in (FT_DATE, FT_CREATED_TIME, FT_UPDATED_TIME):
            expr = (f"(CASE WHEN {_text_expr(p, key)} ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}' "
                    f"THEN ({_text_expr(p, key)})::date END)")
        else:
            expr = _text_expr(p, key)
        parts.append(f"{expr} {direction} NULLS LAST")
    parts.append("claraos_kb_objects.updated_at DESC")
    return ", ".join(parts)


# Footer aggregates (AFFiNE statCalcType / AppFlowy calculations)
AGGREGATES = ("count", "count_empty", "count_not_empty", "count_unique",
              "sum", "avg", "min", "max", "range")


def aggregate_expr(agg: str, key: str, p: _Params) -> str:
    if agg not in AGGREGATES:
        raise FilterError(f"Unbekanntes Aggregat: {agg!r}")
    t = _text_expr(p, key)
    num = (f"(CASE WHEN {_text_expr(p, key)} ~ '^-?[0-9]+(\\.[0-9]+)?$' "
           f"THEN ({_text_expr(p, key)})::numeric END)")
    return {
        "count": "count(*)",
        "count_empty": f"count(*) FILTER (WHERE {t} IS NULL OR {t} = '')",
        "count_not_empty": f"count(*) FILTER (WHERE {t} IS NOT NULL AND {t} <> '')",
        "count_unique": f"count(DISTINCT {t})",
        "sum": f"sum({num})",
        "avg": f"avg({num})",
        "min": f"min({num})",
        "max": f"max({num})",
        "range": f"(max({num}) - min({num}))",
    }[agg]


def new_params(start: int = 0) -> _Params:
    return _Params(start)
