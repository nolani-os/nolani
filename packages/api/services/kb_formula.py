"""Knowledge store: formula fields.

With this the knowledge suite has the complete Notion database trio
relation + rollup + formula — which NONE of the six OSS alternatives examined
offers (AFFiNE and AppFlowy only have footer aggregates, SiYuan relation+rollup).

SECURITY — formulas are user input evaluated on the server. Therefore NO
eval/exec, but:
  * `ast.parse(mode="eval")` followed by an interpreter that only accepts a
    whitelist of node types (literals, names, operators, comparisons, calls of
    known functions). Everything else -> FormulaError.
  * No attribute access, no indexing, no comprehensions, no lambdas — so
    there is no path to `__class__`/`__globals__`.
  * Hard limits for expression length, node count, nesting depth and string
    results (DoS protection), plus protection against huge powers.
Computed ON READ (like rollups) — nothing is materialised, so a changed
expression applies everywhere immediately and no caches go stale.
"""
from __future__ import annotations

import ast
import datetime as dt
import re

MAX_LEN = 500          # characters in the expression
MAX_NODES = 200        # AST nodes
MAX_DEPTH = 15         # nesting depth
MAX_STR = 2000         # length of a string result
MAX_POW = 1_000_000    # upper bound for power results


class FormulaError(ValueError):
    """Invalid or unsafe formula — shown to the user."""


_ALLOWED_NODES = (
    ast.Expression, ast.Constant, ast.Name, ast.Load,
    ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.Call, ast.IfExp,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow,
    ast.USub, ast.UAdd, ast.Not, ast.And, ast.Or,
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
)


def _num(v) -> float:
    """Cell value -> number. Empty/unreadable values count as 0 (Notion behaviour)."""
    if v is None or v == "":
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("€", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return 0.0


def _numeric(v) -> bool:
    """Can the value be read as a number? (Cell values are often text.)"""
    if isinstance(v, (int, float, bool)) or v is None or v == "":
        return True
    try:
        float(str(v).strip().replace("€", "").replace(",", "."))
        return True
    except ValueError:
        return False


def _date(v) -> dt.date | None:
    if not v:
        return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(v))
    if not m:
        return None
    try:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def _fn_prop(props: dict, name) -> object:
    return props.get(str(name), "")


def _build_functions(props: dict, rollups: dict):
    def _if(cond, a, b):
        return a if cond else b

    def _days_between(a, b):
        da, db = _date(a), _date(b)
        if not da or not db:
            return 0
        return (db - da).days

    return {
        "prop": lambda name: _fn_prop(props, name),
        "rollup": lambda name: rollups.get(str(name), 0),
        "num": _num,
        "iif": _if,
        "round": lambda x, n=0: round(_num(x), int(_num(n))),
        "abs": lambda x: abs(_num(x)),
        "min": lambda *xs: min(_num(x) for x in xs) if xs else 0,
        "max": lambda *xs: max(_num(x) for x in xs) if xs else 0,
        "len": lambda x: len(str(x or "")),
        "concat": lambda *xs: "".join(str(x if x is not None else "") for x in xs)[:MAX_STR],
        "contains": lambda hay, needle: str(needle).lower() in str(hay or "").lower(),
        "empty": lambda x: x in (None, "", [], {}),
        "today": lambda: dt.date.today().isoformat(),
        "days_between": _days_between,
        "days_until": lambda d: _days_between(dt.date.today().isoformat(), d),
    }


# Names of all allowed functions — checked during validation already, so the
# UI reports an unsafe formula BEFORE it is ever evaluated.
FUNCTION_NAMES = frozenset({
    "prop", "rollup", "num", "iif", "round", "abs", "min", "max", "len",
    "concat", "contains", "empty", "today", "days_between", "days_until",
})

# `if` is a keyword in Python and cannot be parsed as a function — but Notion
# formulas write `if(a, b, c)`. So the call is rewritten to the internal name
# `iif` before parsing.
_IF_CALL_RE = re.compile(r"\bif\s*\(")


def _preprocess(expression: str) -> str:
    return _IF_CALL_RE.sub("iif(", expression or "")


def _check(tree: ast.AST) -> None:
    count = 0
    def walk(node, depth):
        nonlocal count
        count += 1
        if count > MAX_NODES:
            raise FormulaError("Formel zu komplex")
        if depth > MAX_DEPTH:
            raise FormulaError("Formel zu tief verschachtelt")
        if not isinstance(node, _ALLOWED_NODES):
            raise FormulaError(f"In Formeln nicht erlaubt: {type(node).__name__}")
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name):
                raise FormulaError("Nur einfache Funktionsaufrufe sind erlaubt")
            if node.func.id not in FUNCTION_NAMES:
                raise FormulaError(f"Unbekannte Funktion: {node.func.id}()")
            if node.keywords:
                raise FormulaError("Benannte Argumente sind nicht erlaubt")
        for child in ast.iter_child_nodes(node):
            walk(child, depth + 1)
    walk(tree, 0)


def _eval(node, funcs: dict):
    if isinstance(node, ast.Expression):
        return _eval(node.body, funcs)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, str) and len(node.value) > MAX_STR:
            raise FormulaError("Text in der Formel zu lang")
        return node.value
    if isinstance(node, ast.Name):
        # bare names are constants like true/false/null
        return {"true": True, "false": False, "null": None,
                "True": True, "False": False, "None": None}.get(node.id, node.id)
    if isinstance(node, ast.UnaryOp):
        v = _eval(node.operand, funcs)
        if isinstance(node.op, ast.Not):
            return not v
        return -_num(v) if isinstance(node.op, ast.USub) else _num(v)
    if isinstance(node, ast.BoolOp):
        vals = [_eval(v, funcs) for v in node.values]
        return all(vals) if isinstance(node.op, ast.And) else any(vals)
    if isinstance(node, ast.IfExp):
        return _eval(node.body, funcs) if _eval(node.test, funcs) else _eval(node.orelse, funcs)
    if isinstance(node, ast.BinOp):
        a, b = _eval(node.left, funcs), _eval(node.right, funcs)
        if isinstance(node.op, ast.Add) and (isinstance(a, str) or isinstance(b, str)):
            out = f"{a}{b}"
            if len(out) > MAX_STR:
                raise FormulaError("Ergebnis zu lang")
            return out
        if isinstance(node.op, ast.Mult) and not (_numeric(a) and _numeric(b)):
            # Cell values arrive as text ("1200") and may be computed with; REAL
            # text times a number, however, would be a convenient memory bomb.
            raise FormulaError("Text kann nicht multipliziert werden (nutze concat)")
        x, y = _num(a), _num(b)
        if isinstance(node.op, ast.Add):
            return x + y
        if isinstance(node.op, ast.Sub):
            return x - y
        if isinstance(node.op, ast.Mult):
            return x * y
        if isinstance(node.op, (ast.Div, ast.FloorDiv)):
            if y == 0:
                return 0  # division by 0 yields 0 instead of an error (Notion-like)
            return x / y if isinstance(node.op, ast.Div) else x // y
        if isinstance(node.op, ast.Mod):
            return x % y if y else 0
        if isinstance(node.op, ast.Pow):
            if abs(y) > 32 or abs(x) > 1000:
                raise FormulaError("Potenz zu groß")
            r = x ** y
            if abs(r) > MAX_POW:
                raise FormulaError("Ergebnis zu groß")
            return r
    if isinstance(node, ast.Compare):
        left = _eval(node.left, funcs)
        for op, comp in zip(node.ops, node.comparators):
            right = _eval(comp, funcs)
            if isinstance(op, (ast.Eq, ast.NotEq)):
                same = str(left) == str(right)
                ok = same if isinstance(op, ast.Eq) else not same
            else:
                a, b = _num(left), _num(right)
                ok = {ast.Lt: a < b, ast.LtE: a <= b,
                      ast.Gt: a > b, ast.GtE: a >= b}[type(op)]
            if not ok:
                return False
            left = right
        return True
    if isinstance(node, ast.Call):
        fn = funcs.get(node.func.id)
        if fn is None:
            raise FormulaError(f"Unbekannte Funktion: {node.func.id}()")
        return fn(*[_eval(a, funcs) for a in node.args])
    raise FormulaError("Ausdruck nicht auswertbar")


def validate(expression: str) -> None:
    """Check syntax and safety — without evaluating values."""
    if not expression or not expression.strip():
        raise FormulaError("Formel ist leer")
    if len(expression) > MAX_LEN:
        raise FormulaError(f"Formel zu lang (max. {MAX_LEN} Zeichen)")
    try:
        tree = ast.parse(_preprocess(expression), mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"Syntaxfehler: {exc.msg}")
    _check(tree)


def evaluate(expression: str, properties: dict, rollups: dict | None = None):
    """Evaluate a formula for ONE row. Errors are returned as text so a broken
    formula does not make the table unusable."""
    try:
        validate(expression)
        tree = ast.parse(_preprocess(expression), mode="eval")
        val = _eval(tree, _build_functions(properties or {}, rollups or {}))
        if isinstance(val, float) and val.is_integer():
            return int(val)
        if isinstance(val, str) and len(val) > MAX_STR:
            return val[:MAX_STR]
        return val
    except FormulaError as exc:
        return f"⚠ {exc}"
    except Exception:  # noqa: BLE001 — never break the whole query
        return "⚠ Formel fehlerhaft"
