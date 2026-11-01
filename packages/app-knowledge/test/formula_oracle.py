"""Reference side of the formula differential test.

Runs the real server formula engine (packages/api/services/kb_formula.py and
packages/api/sprache.py) on a corpus and prints one JSON document with the
results. The driver (formula.diff.mjs) sends this script on stdin with the source
files and the corpus embedded, so it runs in any Python 3.14 environment,
including a throwaway container (`python -I -`): it needs nothing but the
standard library (FastAPI is used for response encoding when it is installed,
otherwise an equivalent of its encoder for the value types a formula can
produce is used).

Output per case:
  validate: "ok" | {"key", "werte", "de", "en"} for FormulaError | {"exc": type}
  raw:      the Python value returned by evaluate(), tagged so int/float/str
            /bytes/complex survive JSON exactly
  client:   the JSON text the HTTP response would contain for that value, or
            {"unserialisable": type} when the response could not be encoded
"""
import datetime
import json
import os
import sys
import tempfile
import types


def run(payload: dict) -> None:
    root = tempfile.mkdtemp(prefix="formula-oracle-")
    for rel, text in payload["files"].items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
    sys.path.insert(0, root)

    try:
        import fastapi  # noqa: F401
        from fastapi.encoders import jsonable_encoder
        have_fastapi = True
    except ImportError:
        # sprache.py only needs fastapi.Request at import time.
        stub = types.ModuleType("fastapi")
        stub.Request = type("Request", (), {})
        sys.modules["fastapi"] = stub
        jsonable_encoder = None
        have_fastapi = False

    from services import kb_formula  # noqa: E402
    import sprache  # noqa: E402

    def encode(v):
        """jsonable_encoder for the value types evaluate() can return."""
        if jsonable_encoder is not None:
            return jsonable_encoder(v)
        if v is None or isinstance(v, (bool, int, float, str)):
            return v
        if isinstance(v, bytes):
            return v.decode()
        if isinstance(v, list):
            return [encode(x) for x in v]
        if isinstance(v, dict):
            return {encode(k): encode(x) for k, x in v.items()}
        raise ValueError(f"cannot encode {type(v).__name__}")

    def client(v):
        try:
            body = json.dumps(encode(v), ensure_ascii=False, allow_nan=False,
                              indent=None, separators=(",", ":")).encode("utf-8")
            return body.decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            return {"unserialisable": type(exc).__name__}

    def tag(v):
        if v is None or isinstance(v, bool):
            return v
        if isinstance(v, int):
            return {"int": str(v)}
        if isinstance(v, float):
            return {"float": repr(v), "hex": v.hex()}
        if isinstance(v, str):
            return {"str": [ord(c) for c in v]} if any(0xD800 <= ord(c) <= 0xDFFF for c in v) else v
        if isinstance(v, bytes):
            return {"bytes": v.hex()}
        if isinstance(v, complex):
            return {"complex": [v.real.hex(), v.imag.hex()]}
        if v is Ellipsis:
            return {"ellipsis": True}
        if isinstance(v, list):
            return {"list": [tag(x) for x in v]}
        if isinstance(v, dict):
            return {"dict": [[k, tag(x)] for k, x in v.items()]}
        return {"other": type(v).__name__}

    props_sets = payload.get("props", [])
    rollup_sets = payload.get("rollups", [])
    out = []
    for case in payload["cases"]:
        props = props_sets[case["pi"]] if "pi" in case else case.get("props")
        rollups = rollup_sets[case["ri"]] if "ri" in case else case.get("rollups")
        expr = case["expr"]
        if isinstance(expr, dict) and "codepoints" in expr:
            expr = "".join(chr(c) for c in expr["codepoints"])
        res = {}
        try:
            kb_formula.validate(expr)
            res["validate"] = "ok"
        except kb_formula.FormulaError as exc:
            text = exc.args[0]
            res["validate"] = {
                "key": text.key,
                "werte": {k: str(v) for k, v in text.werte.items()},
                "de": sprache.fuer("de", text),
                "en": sprache.fuer("en", text),
            }
        except Exception as exc:  # noqa: BLE001
            res["validate"] = {"exc": type(exc).__name__}
        val = kb_formula.evaluate(expr, props, rollups, case.get("lang", "de"))
        res["raw"] = tag(val)
        res["client"] = client(val)
        out.append(res)

    flags = ""
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("flags"):
                    flags = line
                    break
    except OSError:
        pass
    cpu = set(flags.split())
    import hashlib
    with open(kb_formula.__file__, "rb") as fh:
        kb_sha = hashlib.sha256(fh.read()).hexdigest()
    print(json.dumps({
        "python": sys.version,
        "kb_formula_sha256": kb_sha,
        "fastapi": have_fastapi,
        "fma": "fma" in cpu and "avx2" in cpu,
        "today": datetime.date.today().isoformat(),
        "results": out,
    }, ensure_ascii=True))
    sys.stdout.flush()


if __name__ == "__main__" and not globals().get("_EMBEDDED"):
    run(json.loads(sys.stdin.read()))
