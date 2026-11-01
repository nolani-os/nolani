/**
 * Knowledge formula engine — a port of the server's formula evaluator
 * (packages/api/services/kb_formula.py) for the device-local app.
 *
 * The contract is byte-identical behaviour: for every expression and row the
 * app must show exactly what the server shows. A formula that computes
 * differently on the device than on the server is worse than none. This file
 * therefore does not "implement formulas", it re-implements the parts of
 * CPython 3.14 (the server runs 3.14.10) that the evaluator relies on:
 *
 *   - the tokenizer and PEG parser for expressions (`ast.parse(mode="eval")`),
 *     including the second, error-reporting pass, because the evaluator shows
 *     `SyntaxError.msg` and the node type names of rejected syntax;
 *   - Python value semantics for the node types the evaluator accepts:
 *     int vs float, `str()`/`repr()` formatting, truthiness, `float(str)`
 *     parsing (Unicode digits and spaces included), `round()` (exact decimal,
 *     half-even), float `//` and `%`, and `**` as computed by glibc's `pow`
 *     (and `sincos`/`hypot` for negative bases) on the server's x86-64 CPU;
 *   - the server's response encoding (`evaluate` returns what the client
 *     receives after JSON serialisation).
 *
 * Input whose result this port cannot determine raises FormulaNotPortable
 * instead of guessing: `\N{...}` escapes (they need the Unicode name
 * database), more than 31 nested brackets (CPython's parser has a recursion
 * limit whose exact position is not portable), and statements after
 * `pass/break/continue ... if ... else`.
 *
 * The test `test/formula.diff.mjs` runs a corpus through this file and the
 * real Python implementation and fails on any difference.
 */

// ---------------------------------------------------------------------------
// Limits (same values as the server)
// ---------------------------------------------------------------------------

const MAX_LEN = 500;
const MAX_NODES = 200;
const MAX_DEPTH = 15;
const MAX_STR = 2000;
const MAX_POW = 1_000_000;

// ---------------------------------------------------------------------------
// Texts: the `formula.*` entries of locales/{de,en}/server.json
// ---------------------------------------------------------------------------

const CATALOG: Record<"de" | "en", Record<string, string>> = {
  de: {
    tooComplex: "Formel zu komplex",
    tooDeep: "Formel zu tief verschachtelt",
    notAllowed: "In Formeln nicht erlaubt: {what}",
    simpleCalls: "Nur einfache Funktionsaufrufe sind erlaubt",
    unknownFn: "Unbekannte Funktion: {name}()",
    noKeywords: "Benannte Argumente sind nicht erlaubt",
    textTooLong: "Text in der Formel zu lang",
    resultTooLong: "Ergebnis zu lang",
    textMultiply: "Text kann nicht multipliziert werden (nutze concat)",
    powerTooBig: "Potenz zu groß",
    resultTooBig: "Ergebnis zu groß",
    notEvaluable: "Ausdruck nicht auswertbar",
    empty: "Formel ist leer",
    tooLong: "Formel zu lang (max. {max} Zeichen)",
    syntax: "Syntaxfehler: {msg}",
    broken: "Formel fehlerhaft",
  },
  en: {
    tooComplex: "Formula too complex",
    tooDeep: "Formula nested too deeply",
    notAllowed: "Not allowed in formulas: {what}",
    simpleCalls: "Only simple function calls are allowed",
    unknownFn: "Unknown function: {name}()",
    noKeywords: "Named arguments are not allowed",
    textTooLong: "Text in the formula too long",
    resultTooLong: "Result too long",
    textMultiply: "Text cannot be multiplied (use concat)",
    powerTooBig: "Power too large",
    resultTooBig: "Result too large",
    notEvaluable: "Expression cannot be evaluated",
    empty: "The formula is empty",
    tooLong: "Formula too long (max. {max} characters)",
    syntax: "Syntax error: {msg}",
    broken: "Formula broken",
  },
};

/** `sprache.t`: German unless the language is exactly "en" (the server has
 * catalogs for "de" and "en" only and falls back to German). Placeholders are
 * filled like `str.format(**werte)`. */
function catalogText(lang: string, key: string, werte: Record<string, string>): string {
  const cat = lang === "en" ? CATALOG.en : CATALOG.de;
  const short = key.startsWith("formula.") ? key.slice("formula.".length) : key;
  const text = cat[short] ?? CATALOG.de[short];
  if (text === undefined) return key;
  let missing = false;
  const out = text.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (!(name in werte)) {
      missing = true;
      return "";
    }
    return werte[name];
  });
  return missing ? text : out;
}

/** Invalid or unsafe formula; carries the same message key and arguments as
 * the server's `FormulaError(Text(key, **werte))`. */
export class FormulaError extends Error {
  readonly key: string;
  readonly args: Record<string, string>;
  constructor(key: string, args: Record<string, string> = {}) {
    super(catalogText("de", key, args));
    this.name = "FormulaError";
    this.key = key;
    this.args = args;
  }
}

/** The text the server shows for a FormulaError (`sprache.fuer(lang, text)`). */
export function errorText(err: FormulaError, lang: string): string {
  return catalogText(lang, err.key, err.args);
}

/** The expression contains something whose meaning this port cannot know
 * offline (a `\N{NAME}` escape). Never thrown for anything the server could
 * compute differently from what this file returns. */
export class FormulaNotPortable extends Error {
  constructor(what: string) {
    super(`formula not computable offline: ${what}`);
    this.name = "FormulaNotPortable";
  }
}

/** A Python exception other than FormulaError (TypeError, OverflowError,
 * ValueError, ZeroDivisionError, ...). `evaluate` turns these into the
 * "formula broken" text like the server's `except Exception`. */
class PyError extends Error {
  readonly pyType: string;
  constructor(pyType: string, msg = "") {
    super(`${pyType}: ${msg}`);
    this.pyType = pyType;
  }
}

// ---------------------------------------------------------------------------
// Unicode helpers (Python's definitions; verified equal for Unicode 16)
// ---------------------------------------------------------------------------

/** Py_UNICODE_ISSPACE */
const PY_SPACE = new Set([
  9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
  8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288,
]);
/** Code points with decimal value 0 (each starts a run of ten digits). */
const DECIMAL_ZEROS = [
  48, 1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430, 3558, 3664, 3792, 3872,
  4160, 4240, 6112, 6160, 6470, 6608, 6784, 6800, 6992, 7088, 7232, 7248, 42528, 43216, 43264, 43472,
  43504, 43600, 44016, 65296, 66720, 68912, 68928, 69734, 69872, 69942, 70096, 70384, 70736, 70864,
  71248, 71360, 71376, 71386, 71472, 71904, 72016, 72688, 72784, 73040, 73120, 73552, 90416, 92768,
  92864, 93008, 93552, 118000, 120782, 120792, 120802, 120812, 120822, 123200, 123632, 124144, 124401,
  125264, 130032,
];
const RE_ND = /^\p{Nd}$/u;
const RE_NONPRINT = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
const RE_XID_START = /^[\p{XID_Start}_]$/u;
const RE_XID_CONT = /^\p{XID_Continue}$/u;

function chr(cp: number): string {
  return String.fromCodePoint(cp);
}
function isPySpace(cp: number): boolean {
  return PY_SPACE.has(cp);
}
/** Py_UNICODE_TODECIMAL: decimal digit value or -1. */
function decimalValue(cp: number): number {
  if (cp >= 48 && cp <= 57) return cp - 48;
  if (cp < 128 || !RE_ND.test(chr(cp))) return -1;
  let lo = 0;
  let hi = DECIMAL_ZEROS.length - 1;
  let zero = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (DECIMAL_ZEROS[mid] <= cp) {
      zero = DECIMAL_ZEROS[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return zero >= 0 && cp - zero < 10 ? cp - zero : -1;
}
function isPrintable(cp: number): boolean {
  if (cp === 0x20) return true;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  return !RE_NONPRINT.test(chr(cp));
}
/** Code points of a JS string (lone surrogates kept as their own value). */
function codePoints(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out.push(((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000);
        i++;
        continue;
      }
    }
    out.push(c);
  }
  return out;
}
function fromCodePoints(cps: number[]): string {
  let s = "";
  for (const cp of cps) s += cp >= 0xd800 && cp <= 0xdfff ? String.fromCharCode(cp) : chr(cp);
  return s;
}
function pyLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}
/** s[:n] in code points. */
function pySliceStart(s: string, n: number): string {
  if (s.length <= n) return s;
  const cps = codePoints(s);
  return cps.length <= n ? s : fromCodePoints(cps.slice(0, n));
}
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}
/** str.strip() */
function pyStrip(s: string): string {
  const cps = codePoints(s);
  let a = 0;
  let b = cps.length;
  while (a < b && isPySpace(cps[a])) a++;
  while (b > a && isPySpace(cps[b - 1])) b--;
  return a === 0 && b === cps.length ? s : fromCodePoints(cps.slice(a, b));
}
/** `needle in hay` on code points (a match may not split a surrogate pair). */
function pyContains(hay: string, needle: string): boolean {
  if (needle === "") return true;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    const before = i > 0 ? hay.charCodeAt(i - 1) : 0;
    const first = needle.charCodeAt(0);
    const last = needle.charCodeAt(needle.length - 1);
    const after = i + needle.length < hay.length ? hay.charCodeAt(i + needle.length) : 0;
    const splitStart = first >= 0xdc00 && first <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
    const splitEnd = last >= 0xd800 && last <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
    if (!splitStart && !splitEnd) return true;
    from = i + 1;
  }
}

// ---------------------------------------------------------------------------
// Python value model
//   None -> null, bool -> boolean, int -> bigint, float -> number,
//   str -> string, list -> PyVal[], dict -> PyDict, bytes -> PyBytes,
//   complex -> PyComplex, Ellipsis -> ELLIPSIS
// ---------------------------------------------------------------------------

class PyDict {
  constructor(readonly entries: [string, PyVal][]) {}
}
class PyBytes {
  constructor(readonly bytes: number[]) {}
}
class PyComplex {
  constructor(
    readonly re: number,
    readonly im: number,
  ) {}
}
class PyEllipsis {}
const ELLIPSIS = new PyEllipsis();

type PyVal = null | boolean | bigint | number | string | PyVal[] | PyDict | PyBytes | PyComplex | PyEllipsis;

/** A JSON value as the server sees it after the client's JSON.stringify and
 * the server's json.loads: integral numbers below 1e21 are printed as plain
 * digits and become Python ints (with exactly the printed digits), all other
 * numbers floats; NaN and infinities become null. (JSON text such as "3.0"
 * written by other producers would be a float on the server; after
 * JSON.parse it is indistinguishable from 3 — the app never writes such
 * numbers.) */
function fromJson(v: unknown): PyVal {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Number.isInteger(v) && Math.abs(v) < 1e21 ? BigInt(String(v)) : v;
  }
  if (Array.isArray(v)) return v.map(fromJson);
  if (typeof v === "object") {
    const entries: [string, PyVal][] = [];
    for (const [k, x] of Object.entries(v as object)) {
      if (x === undefined || typeof x === "function" || typeof x === "symbol") continue;
      entries.push([k, fromJson(x)]);
    }
    return new PyDict(entries);
  }
  return String(v);
}

function truthy(v: PyVal): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "number") return v !== 0; // NaN is truthy in Python
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof PyDict) return v.entries.length > 0;
  if (v instanceof PyBytes) return v.bytes.length > 0;
  if (v instanceof PyComplex) return v.re !== 0 || v.im !== 0;
  return true;
}

/** Shortest repr digits of a finite double: [digits, decimal point position]
 * such that value = 0.d1d2d3... * 10^decpt. */
function shortestDigits(x: number): [string, number] {
  const s = Math.abs(x).toExponential();
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) throw new Error("toExponential: " + s);
  let digits = m[1] + (m[2] ?? "");
  digits = digits.replace(/0+$/, "");
  if (digits === "") digits = "0";
  return [digits, parseInt(m[3], 10) + 1];
}

/** PyOS_double_to_string(x, 'r', 0, flags): repr of a float. addDot0 adds
 * ".0" to integral fixed-point output (float repr), sign forces "+". */
function formatFloatR(x: number, addDot0: boolean, sign: boolean): string {
  if (Number.isNaN(x)) return (sign ? "+" : "") + "nan";
  const neg = x < 0 || Object.is(x, -0);
  const pre = neg ? "-" : sign ? "+" : "";
  if (!Number.isFinite(x)) return pre + "inf";
  if (x === 0) return pre + (addDot0 ? "0.0" : "0");
  const [digits, decpt] = shortestDigits(x);
  if (decpt <= -4 || decpt > 16) {
    const exp = decpt - 1;
    const mant = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    const e = Math.abs(exp);
    return pre + mant + "e" + (exp < 0 ? "-" : "+") + (e < 10 ? "0" + e : String(e));
  }
  let body: string;
  if (decpt <= 0) {
    body = "0." + "0".repeat(-decpt) + digits;
  } else if (decpt >= digits.length) {
    body = digits + "0".repeat(decpt - digits.length) + (addDot0 ? ".0" : "");
  } else {
    body = digits.slice(0, decpt) + "." + digits.slice(decpt);
  }
  return pre + body;
}
function floatRepr(x: number): string {
  return formatFloatR(x, true, false);
}
function complexRepr(c: PyComplex): string {
  if (c.re === 0 && !Object.is(c.re, -0)) return formatFloatR(c.im, false, false) + "j";
  return "(" + formatFloatR(c.re, false, false) + formatFloatR(c.im, false, true) + "j)";
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}
/** repr() of a str */
function strRepr(s: string): string {
  const cps = codePoints(s);
  let quote = 0x27;
  if (cps.includes(0x27) && !cps.includes(0x22)) quote = 0x22;
  let out = String.fromCharCode(quote);
  for (const c of cps) {
    if (c === quote || c === 0x5c) out += "\\" + chr(c);
    else if (c === 9) out += "\\t";
    else if (c === 10) out += "\\n";
    else if (c === 13) out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + hex2(c);
    else if (c < 0x7f) out += chr(c);
    else if (isPrintable(c)) out += chr(c);
    else if (c <= 0xff) out += "\\x" + hex2(c);
    else if (c <= 0xffff) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += "\\U" + c.toString(16).padStart(8, "0");
  }
  return out + String.fromCharCode(quote);
}
function bytesRepr(b: PyBytes): string {
  let quote = 0x27;
  if (b.bytes.includes(0x27) && !b.bytes.includes(0x22)) quote = 0x22;
  let out = "b" + String.fromCharCode(quote);
  for (const c of b.bytes) {
    if (c === quote || c === 0x5c) out += "\\" + String.fromCharCode(c);
    else if (c === 9) out += "\\t";
    else if (c === 10) out += "\\n";
    else if (c === 13) out += "\\r";
    else if (c < 0x20 || c >= 0x7f) out += "\\x" + hex2(c);
    else out += String.fromCharCode(c);
  }
  return out + String.fromCharCode(quote);
}
function pyRepr(v: PyVal): string {
  if (typeof v === "string") return strRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (v instanceof PyDict) return "{" + v.entries.map(([k, x]) => strRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
  return pyStr(v);
}
/** str() */
function pyStr(v: PyVal): string {
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return floatRepr(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v) || v instanceof PyDict) return pyRepr(v);
  if (v instanceof PyBytes) return bytesRepr(v);
  if (v instanceof PyComplex) return complexRepr(v);
  return "Ellipsis";
}

/** float(int): correctly rounded; OverflowError beyond the double range. */
function intToFloat(i: bigint): number {
  const f = Number(i);
  if (!Number.isFinite(f)) throw new PyError("OverflowError", "int too large to convert to float");
  return f;
}

/** float(str) for a str argument; null when Python raises ValueError. */
function parseFloatStr(s: string): number | null {
  // _PyUnicode_TransformDecimalAndSpaceToASCII
  let ascii = "";
  for (const c of codePoints(s)) {
    if (c < 127) ascii += String.fromCharCode(c);
    else if (isPySpace(c)) ascii += " ";
    else {
      const d = decimalValue(c);
      if (d < 0) {
        ascii += "?";
        break;
      }
      ascii += String.fromCharCode(48 + d);
    }
  }
  // strip ASCII whitespace (Py_ISSPACE)
  const t = ascii.replace(/^[ \t\n\v\f\r]+/, "").replace(/[ \t\n\v\f\r]+$/, "");
  let u = t;
  if (t.includes("_")) {
    // _Py_string_to_number_with_underscores
    let out = t[0] ?? "";
    let prev = t[0] ?? "";
    for (let i = 1; i < t.length; i++) {
      const ch = t[i];
      if (ch === "_") {
        if (!(prev >= "0" && prev <= "9")) return null;
      } else {
        out += ch;
        if (prev === "_" && !(ch >= "0" && ch <= "9")) return null;
      }
      prev = ch;
    }
    if (prev === "_") return null;
    u = out;
  }
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(u);
  if (special) {
    if (special[2].toLowerCase() === "nan") return NaN;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(u)) return null;
  return Number(u);
}

/** The text of a value prepared for float(): str(v).strip(), "€" removed,
 * "," -> ".". */
function numberText(v: PyVal): string {
  return pyStrip(pyStr(v)).split("€").join("").split(",").join(".");
}
/** kb_formula._num: empty, unreadable and non-finite values count as 0. */
function num(v: PyVal): number {
  if (v === null || v === "") return 0.0;
  if (typeof v === "boolean") return v ? 1.0 : 0.0;
  if (typeof v === "bigint" || typeof v === "number") {
    const f = typeof v === "bigint" ? intToFloat(v) : v;
    return Number.isFinite(f) ? f : 0.0;
  }
  const f = parseFloatStr(numberText(v));
  return f !== null && Number.isFinite(f) ? f : 0.0;
}
/** kb_formula._as_number: the value as a number when it is one (int/float
 * or numeric text), else null. Empty text, None and bools are no numbers. */
function asNumber(v: PyVal): number | null {
  if (typeof v === "boolean" || v === null) return null;
  if (typeof v === "bigint" || typeof v === "number") {
    const f = typeof v === "bigint" ? intToFloat(v) : v;
    return Number.isFinite(f) ? f : null;
  }
  const s = numberText(v);
  if (!s) return null;
  const f = parseFloatStr(s);
  return f !== null && Number.isFinite(f) ? f : null;
}
/** kb_formula._numeric */
function numeric(v: PyVal): boolean {
  if (typeof v === "bigint" || typeof v === "number" || typeof v === "boolean" || v === null || v === "") return true;
  return parseFloatStr(numberText(v)) !== null;
}

// ---------------------------------------------------------------------------
// Tokenizer: port of CPython 3.14.10 Parser/lexer/lexer.c for string input in
// eval mode. Works on code points; columns are code point offsets (only used
// for adjacency checks, never shown).
// ---------------------------------------------------------------------------

const EOF = -1;
const TABSIZE = 8;
const MAXINDENT = 100;
const MAXLEVEL = 200;
const MAXFSTRINGLEVEL = 150;
const MAX_EXPR_NESTING = 3;

type TokType =
  | "NAME"
  | "NUMBER"
  | "STRING"
  | "NEWLINE"
  | "INDENT"
  | "DEDENT"
  | "ENDMARKER"
  | "ERRORTOKEN"
  | "OP"
  | "FSTRING_START"
  | "FSTRING_MIDDLE"
  | "FSTRING_END"
  | "TSTRING_START"
  | "TSTRING_MIDDLE"
  | "TSTRING_END";

interface Token {
  type: TokType;
  /** Operator / keyword text for OP and keyword tokens; source text otherwise. */
  str: string;
  kw: boolean;
  lineno: number;
  col: number;
  endLineno: number;
  endCol: number;
  level: number;
  /** set_ftstring_expr attached the expression text (debug and t-string
   * fields need it). */
  meta: boolean;
}

const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);
const SOFT_KEYWORDS = new Set(["_", "case", "match", "type"]);

const TWO_CHARS = new Set([
  "!=", "%=", "&=", "**", "*=", "+=", "-=", "->", "//", "/=", ":=", "<<", "<=", "==", ">=",
  ">>", "@=", "^=", "|=",
]);
const THREE_CHARS = new Set(["**=", "...", "//=", "<<=", ">>="]);

type Done = "OK" | "EOF" | "ERROR" | "LINECONT" | "DEDENT" | "TABSPACE" | "TOODEEP" | "EOFS" | "EOLS" | "DONE";

interface TokMode {
  kind: "REGULAR" | "FSTRING";
  quote: number;
  quoteSize: number;
  raw: boolean;
  stringKind: "f" | "t";
  curlyDepth: number;
  exprStartDepth: number;
  inFormatSpec: boolean;
  inDebug: boolean;
  start: number;
  firstLine: number;
}

function isPotentialIdentifierStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128;
}
function isPotentialIdentifierChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c >= 128;
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isXDigit(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}
function lower(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

class Lexer {
  src: number[];
  cur = 0;
  inp = 0;
  lineStart = 0;
  lineno = 0;
  colOffset = 0;
  done: Done = "OK";
  level = 0;
  parenstack: number[] = [];
  parenlinenostack: number[] = [];
  atbol = true;
  indent = 0;
  indstack: number[] = [0];
  altindstack: number[] = [0];
  pendin = 0;
  start = -1;
  startingColOffset = -1;
  firstLineno = 0;
  modes: TokMode[] = [];
  /** Pending SyntaxError raised by the tokenizer (message), if any. */
  err: string | null = null;
  errIsIndentation = false;
  pendingMeta = false;

  /** `tok_extra_tokens`: the mode of the `tokenize` module, which accepts
   * some input the parser's tokenizer rejects. */
  extra: boolean;

  constructor(src: number[], extra = false) {
    this.src = src;
    this.extra = extra;
    this.modes.push(this.newMode("REGULAR"));
  }

  newMode(kind: "REGULAR" | "FSTRING"): TokMode {
    return {
      kind, quote: 0, quoteSize: 1, raw: false, stringKind: "f", curlyDepth: 0, exprStartDepth: -1,
      inFormatSpec: false, inDebug: false, start: 0, firstLine: 0,
    };
  }
  get mode(): TokMode {
    return this.modes[this.modes.length - 1];
  }
  insideFstring(): boolean {
    return this.modes.length > 1;
  }
  prefix(): string {
    return this.mode.stringKind === "t" ? "t" : "f";
  }

  nextc(): number {
    for (;;) {
      if (this.cur !== this.inp) {
        this.colOffset++;
        return this.src[this.cur++];
      }
      if (this.done !== "OK") return EOF;
      // tok_underflow_string: next line
      if (this.inp >= this.src.length) {
        this.done = "EOF";
        return EOF;
      }
      let end = this.src.indexOf(10, this.inp);
      end = end < 0 ? this.src.length : end + 1;
      this.lineStart = this.cur;
      this.lineno++;
      this.colOffset = 0;
      this.inp = end;
    }
  }
  backup(c: number): void {
    if (c !== EOF) {
      this.cur--;
      this.colOffset--;
    }
  }
  syntaxError(msg: string): "ERRORTOKEN" {
    if (this.err === null) this.err = msg;
    this.done = "ERROR";
    return "ERRORTOKEN";
  }

  make(type: TokType, pStart: number, pEnd: number): Token {
    const text = pStart >= 0 && pEnd >= pStart ? fromCodePoints(this.src.slice(pStart, pEnd)) : "";
    const isStr = type === "STRING" || type === "FSTRING_MIDDLE" || type === "TSTRING_MIDDLE";
    const meta = this.pendingMeta;
    this.pendingMeta = false;
    return {
      meta,
      type,
      str: text,
      kw: false,
      lineno: isStr ? this.firstLineno : this.lineno,
      col: pStart >= 0 ? this.startingColOffset : -1,
      endLineno: this.lineno,
      endCol: pStart >= 0 ? this.colOffset : -1,
      level: this.level,
    };
  }

  lookahead(test: string): boolean {
    const consumed: number[] = [];
    let i = 0;
    let res = false;
    for (;;) {
      const c = this.nextc();
      if (i === test.length) {
        res = !isPotentialIdentifierChar(c);
      } else if (c === test.charCodeAt(i)) {
        consumed.push(c);
        i++;
        continue;
      }
      this.backup(c);
      while (consumed.length) this.backup(consumed.pop()!);
      return res;
    }
  }

  /** verify_end_of_number; false = error raised */
  verifyEndOfNumber(c: number, kind: string): boolean {
    if (this.extra) return true;
    let r = false;
    if (c === 97) r = this.lookahead("nd");
    else if (c === 101) r = this.lookahead("lse");
    else if (c === 102) r = this.lookahead("or");
    else if (c === 105) {
      const c2 = this.nextc();
      if (c2 === 102 || c2 === 110 || c2 === 115) r = true;
      this.backup(c2);
    } else if (c === 111) r = this.lookahead("r");
    else if (c === 110) r = this.lookahead("ot");
    if (r) {
      // SyntaxWarning "invalid <kind> literal" (a warning only)
      return true;
    }
    if (c < 128 && c !== EOF && isPotentialIdentifierChar(c)) {
      this.backup(c);
      this.syntaxError(`invalid ${kind} literal`);
      return false;
    }
    return true;
  }

  verifyIdentifier(): boolean {
    if (this.extra) return true;
    const cps = this.src.slice(this.start, this.cur);
    let invalid = cps.length;
    for (let i = 0; i < cps.length; i++) {
      const ok = i === 0 ? RE_XID_START.test(chr(cps[i])) : RE_XID_CONT.test(chr(cps[i]));
      if (!ok) {
        invalid = i;
        break;
      }
    }
    if (invalid < cps.length) {
      const ch = cps[invalid];
      const hex = ch.toString(16).toUpperCase().padStart(4, "0");
      if (isPrintable(ch)) this.syntaxError(`invalid character '${chr(ch)}' (U+${hex})`);
      else this.syntaxError(`invalid non-printable character U+${hex}`);
      return false;
    }
    return true;
  }

  decimalTail(): number {
    let c: number;
    for (;;) {
      do {
        c = this.nextc();
      } while (isDigit(c));
      if (c !== 95) break;
      c = this.nextc();
      if (!isDigit(c)) {
        this.backup(c);
        this.syntaxError("invalid decimal literal");
        return 0;
      }
    }
    return c;
  }

  continuationLine(): number {
    let c = this.nextc();
    if (c === 13) c = this.nextc();
    if (c !== 10) {
      this.done = "LINECONT";
      return -1;
    }
    c = this.nextc();
    if (c === EOF) {
      this.done = "EOF";
      this.cur = this.inp;
      return -1;
    }
    this.backup(c);
    return c;
  }

  get(): Token {
    const m = this.mode;
    if (m.kind === "REGULAR") return this.getNormal(m);
    return this.getFstring(m);
  }

  getNormal(cm: TokMode): Token {
    let c: number;
    let blankline: boolean;
    // nextline:
    for (;;) {
      this.start = -1;
      this.startingColOffset = -1;
      blankline = false;
      if (this.atbol) {
        let col = 0;
        let altcol = 0;
        this.atbol = false;
        let contLineCol = 0;
        for (;;) {
          c = this.nextc();
          if (c === 32) {
            col++;
            altcol++;
          } else if (c === 9) {
            col = (Math.floor(col / TABSIZE) + 1) * TABSIZE;
            altcol = altcol + 1;
          } else if (c === 12) {
            col = altcol = 0;
          } else if (c === 92) {
            contLineCol = contLineCol ? contLineCol : col;
            if ((c = this.continuationLine()) === -1) return this.make("ERRORTOKEN", -1, -1);
          } else {
            break;
          }
        }
        this.backup(c);
        if (c === 35 || c === 10 || c === 13) blankline = true;
        if (!blankline && this.level === 0) {
          col = contLineCol ? contLineCol : col;
          altcol = contLineCol ? contLineCol : altcol;
          if (col === this.indstack[this.indent]) {
            if (altcol !== this.altindstack[this.indent]) {
              this.done = "TABSPACE";
              this.cur = this.inp;
              return this.make("ERRORTOKEN", -1, -1);
            }
          } else if (col > this.indstack[this.indent]) {
            if (this.indent + 1 >= MAXINDENT) {
              this.done = "TOODEEP";
              this.cur = this.inp;
              return this.make("ERRORTOKEN", -1, -1);
            }
            if (altcol <= this.altindstack[this.indent]) {
              this.done = "TABSPACE";
              this.cur = this.inp;
              return this.make("ERRORTOKEN", -1, -1);
            }
            this.pendin++;
            this.indstack[++this.indent] = col;
            this.altindstack[this.indent] = altcol;
          } else {
            while (this.indent > 0 && col < this.indstack[this.indent]) {
              this.pendin--;
              this.indent--;
            }
            if (col !== this.indstack[this.indent]) {
              this.done = "DEDENT";
              this.cur = this.inp;
              return this.make("ERRORTOKEN", -1, -1);
            }
            if (altcol !== this.altindstack[this.indent]) {
              this.done = "TABSPACE";
              this.cur = this.inp;
              return this.make("ERRORTOKEN", -1, -1);
            }
          }
        }
      }

      this.start = this.cur;
      this.startingColOffset = this.colOffset;
      if (this.pendin !== 0) {
        if (this.pendin < 0) {
          this.pendin++;
          return this.make("DEDENT", -1, -1);
        }
        this.pendin--;
        return this.make("INDENT", -1, -1);
      }

      c = this.nextc();
      this.backup(c);

      // again:
      for (;;) {
        this.start = -1;
        do {
          c = this.nextc();
        } while (c === 32 || c === 9 || c === 12);
        this.start = this.cur - 1;
        this.startingColOffset = this.colOffset - 1;

        if (c === 35) {
          while (c !== EOF && c !== 10 && c !== 13) c = this.nextc();
        }

        if (c === EOF) {
          if (this.level) return this.make("ERRORTOKEN", -1, -1);
          return this.make(this.done === "EOF" ? "ENDMARKER" : "ERRORTOKEN", -1, -1);
        }

        // Identifier / string prefixes
        if (isPotentialIdentifierStart(c)) {
          let sawB = false, sawR = false, sawU = false, sawF = false, sawT = false;
          for (;;) {
            if (!sawB && (c === 98 || c === 66)) sawB = true;
            else if (!sawU && (c === 117 || c === 85)) sawU = true;
            else if (!sawR && (c === 114 || c === 82)) sawR = true;
            else if (!sawF && (c === 102 || c === 70)) sawF = true;
            else if (!sawT && (c === 116 || c === 84)) sawT = true;
            else break;
            c = this.nextc();
            if (c === 34 || c === 39) {
              const bad = this.prefixError(sawB, sawR, sawU, sawF, sawT);
              if (bad) return this.make(this.syntaxError(bad), -1, -1);
              if (sawF || sawT) return this.fstringQuote(c);
              return this.letterQuote(c);
            }
          }
          let nonascii = false;
          while (isPotentialIdentifierChar(c)) {
            if (c >= 128) nonascii = true;
            c = this.nextc();
          }
          this.backup(c);
          if (nonascii && !this.verifyIdentifier()) return this.make("ERRORTOKEN", -1, -1);
          return this.make("NAME", this.start, this.cur);
        }

        if (c === 13) c = this.nextc();

        if (c === 10) {
          this.atbol = true;
          if (blankline || this.level > 0) break; // goto nextline
          return this.make("NEWLINE", this.start, this.cur - 1);
        }

        if (c === 46) {
          c = this.nextc();
          if (isDigit(c)) return this.number(c, "fraction");
          if (c === 46) {
            c = this.nextc();
            if (c === 46) return this.make("OP", this.start, this.cur);
            this.backup(c);
            this.backup(46);
          } else {
            this.backup(c);
          }
          return this.make("OP", this.start, this.cur);
        }

        if (isDigit(c)) return this.number(c, "start");

        if (c === 34 || c === 39) return this.letterQuote(c);

        if (c === 92) {
          if ((c = this.continuationLine()) === -1) return this.make("ERRORTOKEN", -1, -1);
          continue; // goto again
        }

        // f-string expression punctuation
        const isPunct = c === 58 || c === 125 || c === 33 || c === 123;
        if (isPunct && this.insideFstring() && cm.exprStartDepth >= 0) {
          const cursor = cm.curlyDepth - (c !== 123 ? 1 : 0);
          const cursorValid = cursor === 0 || (cursor === 1 && (cm.inDebug || cm.inFormatSpec));
          if (cursorValid && c !== 123 && (this.mode.inDebug || this.mode.stringKind === "t")) this.pendingMeta = true;
          if (c === 58 && cursor === cm.exprStartDepth) {
            cm.kind = "FSTRING";
            cm.inFormatSpec = true;
            return this.make("OP", this.start, this.cur);
          }
        }

        {
          const c2 = this.nextc();
          const two = chr(c) + (c2 === EOF ? "" : chr(c2));
          if (c2 !== EOF && TWO_CHARS.has(two)) {
            const c3 = this.nextc();
            const three = two + (c3 === EOF ? "" : chr(c3));
            if (!(c3 !== EOF && THREE_CHARS.has(three))) this.backup(c3);
            return this.make("OP", this.start, this.cur);
          }
          this.backup(c2);
        }

        switch (c) {
          case 40:
          case 91:
          case 123:
            if (this.level >= MAXLEVEL) return this.make(this.syntaxError("too many nested parentheses"), -1, -1);
            this.parenstack[this.level] = c;
            this.parenlinenostack[this.level] = this.lineno;
            this.level++;
            if (this.insideFstring()) cm.curlyDepth++;
            break;
          case 41:
          case 93:
          case 125: {
            if (this.insideFstring() && !cm.curlyDepth && c === 125) {
              return this.make(this.syntaxError(`${this.prefix()}-string: single '}' is not allowed`), -1, -1);
            }
            if (!this.extra && !this.level) return this.make(this.syntaxError(`unmatched '${chr(c)}'`), -1, -1);
            if (this.level > 0) {
              this.level--;
              const opening = this.parenstack[this.level];
              if (!((opening === 40 && c === 41) || (opening === 91 && c === 93) || (opening === 123 && c === 125))) {
                if (this.insideFstring() && opening === 123) {
                  const previous = cm.curlyDepth - 1;
                  if (previous === cm.exprStartDepth) {
                    return this.make(this.syntaxError(`${this.prefix()}-string: unmatched '${chr(c)}'`), -1, -1);
                  }
                }
                if (this.extra) {
                  // tokenize allows other mismatched brackets
                } else if (this.parenlinenostack[this.level] !== this.lineno) {
                  return this.make(
                    this.syntaxError(
                      `closing parenthesis '${chr(c)}' does not match opening parenthesis '${chr(opening)}' on line ${this.parenlinenostack[this.level]}`,
                    ),
                    -1,
                    -1,
                  );
                } else {
                  return this.make(
                    this.syntaxError(`closing parenthesis '${chr(c)}' does not match opening parenthesis '${chr(opening)}'`),
                    -1,
                    -1,
                  );
                }
              }
            }
            if (this.insideFstring()) {
              cm.curlyDepth--;
              if (cm.curlyDepth < 0) {
                return this.make(this.syntaxError(`${this.prefix()}-string: unmatched '${chr(c)}'`), -1, -1);
              }
              if (c === 125 && cm.curlyDepth === cm.exprStartDepth) {
                cm.exprStartDepth--;
                cm.kind = "FSTRING";
                cm.inFormatSpec = false;
                cm.inDebug = false;
              }
            }
            break;
          }
          default:
            break;
        }

        if (!isPrintable(c)) {
          const hex = c.toString(16).toUpperCase().padStart(4, "0");
          return this.make(this.syntaxError(`invalid non-printable character U+${hex}`), -1, -1);
        }
        if (c === 61 && cm.exprStartDepth >= 0 && cm.curlyDepth - 1 === cm.exprStartDepth) {
          // INSIDE_FSTRING_EXPR_AT_TOP
          cm.inDebug = true;
        }
        return this.make("OP", this.start, this.cur);
      }
      // reached via `break` from the newline case: goto nextline
    }
  }

  prefixError(b: boolean, r: boolean, u: boolean, f: boolean, t: boolean): string | null {
    const e = (a: string, z: string) => `'${a}' and '${z}' prefixes are incompatible`;
    if (u && b) return e("u", "b");
    if (u && r) return e("u", "r");
    if (u && f) return e("u", "f");
    if (u && t) return e("u", "t");
    if (b && f) return e("b", "f");
    if (b && t) return e("b", "t");
    if (f && t) return e("f", "t");
    return null;
  }

  number(first: number, entry: "start" | "fraction"): Token {
    let c = first;
    if (entry === "fraction") return this.numberFraction(c);
    if (c === 48) {
      c = this.nextc();
      if (c === 120 || c === 88) {
        c = this.nextc();
        do {
          if (c === 95) c = this.nextc();
          if (!isXDigit(c)) {
            this.backup(c);
            return this.make(this.syntaxError("invalid hexadecimal literal"), -1, -1);
          }
          do {
            c = this.nextc();
          } while (isXDigit(c));
        } while (c === 95);
        if (!this.verifyEndOfNumber(c, "hexadecimal")) return this.make("ERRORTOKEN", -1, -1);
      } else if (c === 111 || c === 79) {
        c = this.nextc();
        do {
          if (c === 95) c = this.nextc();
          if (c < 48 || c >= 56) {
            if (isDigit(c)) return this.make(this.syntaxError(`invalid digit '${chr(c)}' in octal literal`), -1, -1);
            this.backup(c);
            return this.make(this.syntaxError("invalid octal literal"), -1, -1);
          }
          do {
            c = this.nextc();
          } while (c >= 48 && c < 56);
        } while (c === 95);
        if (isDigit(c)) return this.make(this.syntaxError(`invalid digit '${chr(c)}' in octal literal`), -1, -1);
        if (!this.verifyEndOfNumber(c, "octal")) return this.make("ERRORTOKEN", -1, -1);
      } else if (c === 98 || c === 66) {
        c = this.nextc();
        do {
          if (c === 95) c = this.nextc();
          if (c !== 48 && c !== 49) {
            if (isDigit(c)) return this.make(this.syntaxError(`invalid digit '${chr(c)}' in binary literal`), -1, -1);
            this.backup(c);
            return this.make(this.syntaxError("invalid binary literal"), -1, -1);
          }
          do {
            c = this.nextc();
          } while (c === 48 || c === 49);
        } while (c === 95);
        if (isDigit(c)) return this.make(this.syntaxError(`invalid digit '${chr(c)}' in binary literal`), -1, -1);
        if (!this.verifyEndOfNumber(c, "binary")) return this.make("ERRORTOKEN", -1, -1);
      } else {
        let nonzero = false;
        for (;;) {
          if (c === 95) {
            c = this.nextc();
            if (!isDigit(c)) {
              this.backup(c);
              return this.make(this.syntaxError("invalid decimal literal"), -1, -1);
            }
          }
          if (c !== 48) break;
          c = this.nextc();
        }
        if (isDigit(c)) {
          nonzero = true;
          c = this.decimalTail();
          if (c === 0) return this.make("ERRORTOKEN", -1, -1);
        }
        if (c === 46) {
          c = this.nextc();
          return this.numberFraction(c);
        } else if (c === 101 || c === 69) {
          return this.numberExponent(c);
        } else if (c === 106 || c === 74) {
          return this.numberImaginary();
        } else if (nonzero && !this.extra) {
          this.backup(c);
          return this.make(
            this.syntaxError(
              "leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers",
            ),
            -1,
            -1,
          );
        }
        if (!this.verifyEndOfNumber(c, "decimal")) return this.make("ERRORTOKEN", -1, -1);
      }
    } else {
      c = this.decimalTail();
      if (c === 0) return this.make("ERRORTOKEN", -1, -1);
      if (c === 46) {
        c = this.nextc();
        return this.numberFraction(c);
      }
      if (c === 101 || c === 69) return this.numberExponent(c);
      if (c === 106 || c === 74) return this.numberImaginary();
      if (!this.verifyEndOfNumber(c, "decimal")) return this.make("ERRORTOKEN", -1, -1);
    }
    this.backup(c);
    return this.make("NUMBER", this.start, this.cur);
  }

  numberFraction(c: number): Token {
    if (isDigit(c)) {
      c = this.decimalTail();
      if (c === 0) return this.make("ERRORTOKEN", -1, -1);
    }
    if (c === 101 || c === 69) return this.numberExponent(c);
    if (c === 106 || c === 74) return this.numberImaginary();
    if (!this.verifyEndOfNumber(c, "decimal")) return this.make("ERRORTOKEN", -1, -1);
    this.backup(c);
    return this.make("NUMBER", this.start, this.cur);
  }

  numberExponent(e: number): Token {
    let c = this.nextc();
    if (c === 43 || c === 45) {
      c = this.nextc();
      if (!isDigit(c)) {
        this.backup(c);
        return this.make(this.syntaxError("invalid decimal literal"), -1, -1);
      }
    } else if (!isDigit(c)) {
      this.backup(c);
      if (!this.verifyEndOfNumber(e, "decimal")) return this.make("ERRORTOKEN", -1, -1);
      this.backup(e);
      return this.make("NUMBER", this.start, this.cur);
    }
    c = this.decimalTail();
    if (c === 0) return this.make("ERRORTOKEN", -1, -1);
    if (c === 106 || c === 74) return this.numberImaginary();
    if (!this.verifyEndOfNumber(c, "decimal")) return this.make("ERRORTOKEN", -1, -1);
    this.backup(c);
    return this.make("NUMBER", this.start, this.cur);
  }

  numberImaginary(): Token {
    const c = this.nextc();
    if (!this.verifyEndOfNumber(c, "imaginary")) return this.make("ERRORTOKEN", -1, -1);
    this.backup(c);
    return this.make("NUMBER", this.start, this.cur);
  }

  fstringQuote(quote: number): Token {
    let quoteSize = 1;
    this.firstLineno = this.lineno;
    const afterQuote = this.nextc();
    if (afterQuote === quote) {
      const afterAfter = this.nextc();
      if (afterAfter === quote) quoteSize = 3;
      else {
        this.backup(afterAfter);
        this.backup(afterQuote);
      }
    }
    if (afterQuote !== quote) this.backup(afterQuote);
    if (this.modes.length >= MAXFSTRINGLEVEL) {
      return this.make(this.syntaxError("too many nested f-strings or t-strings"), -1, -1);
    }
    const m = this.newMode("FSTRING");
    m.quote = quote;
    m.quoteSize = quoteSize;
    m.start = this.start;
    m.firstLine = this.lineno;
    const s0 = lower(this.src[this.start]);
    const s1 = lower(this.src[this.start + 1]);
    if (s0 === 116) {
      m.raw = s1 === 114;
      m.stringKind = "t";
    } else if (s0 === 102) {
      m.raw = s1 === 114;
    } else {
      m.raw = true;
      if (s1 === 116) m.stringKind = "t";
    }
    this.modes.push(m);
    return this.make(m.stringKind === "t" ? "TSTRING_START" : "FSTRING_START", this.start, this.cur);
  }

  letterQuote(quote: number): Token {
    let quoteSize = 1;
    let endQuoteSize = 0;
    let hasEscapedQuote = false;
    this.firstLineno = this.lineno;
    let c = this.nextc();
    if (c === quote) {
      c = this.nextc();
      if (c === quote) quoteSize = 3;
      else endQuoteSize = 1;
    }
    if (c !== quote) this.backup(c);
    while (endQuoteSize !== quoteSize) {
      c = this.nextc();
      if (this.done === "ERROR") return this.make("ERRORTOKEN", -1, -1);
      if (c === EOF || (quoteSize === 1 && c === 10)) {
        const start = this.lineno;
        this.cur = this.start + 1;
        this.lineno = this.firstLineno;
        if (this.insideFstring()) {
          const m = this.mode;
          if (m.quote === quote && m.quoteSize === quoteSize) {
            return this.make(this.syntaxError(`${this.prefix()}-string: expecting '}'`), -1, -1);
          }
        }
        if (quoteSize === 3) {
          this.syntaxError(`unterminated triple-quoted string literal (detected at line ${start})`);
          if (c !== 10) this.done = "EOFS";
          return this.make("ERRORTOKEN", -1, -1);
        }
        if (hasEscapedQuote) {
          this.syntaxError(
            `unterminated string literal (detected at line ${start}); perhaps you escaped the end quote?`,
          );
        } else {
          this.syntaxError(`unterminated string literal (detected at line ${start})`);
        }
        if (c !== 10) this.done = "EOLS";
        return this.make("ERRORTOKEN", -1, -1);
      }
      if (c === quote) {
        endQuoteSize += 1;
      } else {
        endQuoteSize = 0;
        if (c === 92) {
          c = this.nextc();
          if (c === quote) hasEscapedQuote = true;
          if (c === 13) c = this.nextc();
        }
      }
    }
    return this.make("STRING", this.start, this.cur);
  }

  getFstring(cm: TokMode): Token {
    let endQuoteSize = 0;
    let unicodeEscape = false;
    this.start = this.cur;
    this.firstLineno = this.lineno;
    this.startingColOffset = this.colOffset;
    const startChar = this.nextc();
    if (startChar === 123) {
      const peek1 = this.nextc();
      this.backup(peek1);
      this.backup(startChar);
      if (peek1 !== 123) {
        cm.exprStartDepth++;
        if (cm.exprStartDepth >= MAX_EXPR_NESTING) {
          return this.make(this.syntaxError(`${this.prefix()}-string: expressions nested too deeply`), -1, -1);
        }
        this.mode.kind = "REGULAR";
        return this.getNormal(cm);
      }
    } else {
      this.backup(startChar);
    }
    let atEnd = true;
    const taken: number[] = [];
    for (let i = 0; i < cm.quoteSize; i++) {
      const q = this.nextc();
      if (q !== cm.quote) {
        this.backup(q);
        atEnd = false;
        break;
      }
      taken.push(q);
    }
    if (atEnd) {
      const tok = this.make(cm.stringKind === "t" ? "TSTRING_END" : "FSTRING_END", this.start, this.cur);
      this.modes.pop();
      return tok;
    }
    // CPython backs up only the last mismatching char; the quotes already
    // read stay consumed and become part of the middle.
    while (endQuoteSize !== cm.quoteSize) {
      const c = this.nextc();
      if (this.done === "ERROR") return this.make("ERRORTOKEN", -1, -1);
      const inFormatSpec = cm.inFormatSpec && cm.exprStartDepth >= 0;
      if (c === EOF || (cm.quoteSize === 1 && c === 10)) {
        if (inFormatSpec && c === 10) {
          if (cm.quoteSize === 1) {
            return this.make(
              this.syntaxError(
                `${this.prefix()}-string: newlines are not allowed in format specifiers for single quoted ${this.prefix()}-strings`,
              ),
              -1,
              -1,
            );
          }
          this.backup(c);
          this.mode.kind = "REGULAR";
          cm.inFormatSpec = false;
          return this.make(cm.stringKind === "t" ? "TSTRING_MIDDLE" : "FSTRING_MIDDLE", this.start, this.cur);
        }
        this.cur = cm.start + 1;
        const start = this.lineno;
        this.lineno = cm.firstLine;
        if (cm.quoteSize === 3) {
          this.syntaxError(`unterminated triple-quoted ${this.prefix()}-string literal (detected at line ${start})`);
          if (c !== 10) this.done = "EOFS";
          return this.make("ERRORTOKEN", -1, -1);
        }
        return this.make(
          this.syntaxError(`unterminated ${this.prefix()}-string literal (detected at line ${start})`),
          -1,
          -1,
        );
      }
      if (c === cm.quote) {
        endQuoteSize += 1;
        continue;
      }
      endQuoteSize = 0;
      if (c === 123) {
        const peek = this.nextc();
        if (peek !== 123 || inFormatSpec) {
          this.backup(peek);
          this.backup(c);
          cm.exprStartDepth++;
          if (cm.exprStartDepth >= MAX_EXPR_NESTING) {
            return this.make(this.syntaxError(`${this.prefix()}-string: expressions nested too deeply`), -1, -1);
          }
          this.mode.kind = "REGULAR";
          cm.inFormatSpec = false;
          return this.make(cm.stringKind === "t" ? "TSTRING_MIDDLE" : "FSTRING_MIDDLE", this.start, this.cur);
        }
        return this.make(cm.stringKind === "t" ? "TSTRING_MIDDLE" : "FSTRING_MIDDLE", this.start, this.cur - 1);
      } else if (c === 125) {
        if (unicodeEscape) {
          return this.make(cm.stringKind === "t" ? "TSTRING_MIDDLE" : "FSTRING_MIDDLE", this.start, this.cur);
        }
        const peek = this.nextc();
        const cursor = cm.curlyDepth;
        if (peek === 125 && !inFormatSpec && cursor === 0) {
          return this.make(cm.stringKind === "t" ? "TSTRING_MIDDLE" : "FSTRING_MIDDLE", this.start, this.cur - 1);
        }
        this.backup(peek);
        this.backup(c);
        this.mode.kind = "REGULAR";
        cm.inFormatSpec = false;
        return this.make(cm.stringKind === "t" ? "TSTRING_MIDDLE" : "FSTRING_MIDDLE", this.start, this.cur);
      } else if (c === 92) {
        let peek = this.nextc();
        if (peek === 13) peek = this.nextc();
        if (peek === 123 || peek === 125) {
          this.backup(peek);
          continue;
        }
        if (!cm.raw) {
          if (peek === 78) {
            peek = this.nextc();
            if (peek === 123) unicodeEscape = true;
            else this.backup(peek);
          }
        }
      }
    }
    for (let i = 0; i < cm.quoteSize; i++) this.backup(cm.quote);
    return this.make(cm.stringKind === "t" ? "TSTRING_MIDDLE" : "FSTRING_MIDDLE", this.start, this.cur);
  }
}

// ---------------------------------------------------------------------------
// Parser: transliteration of the expression part of CPython 3.14.10's PEG
// grammar (Grammar/python.gram, start rule `eval`), including the invalid_*
// rules of the second pass and the memoisation set of the generated parser
// (memoisation matters: results computed with invalid rules switched off are
// reused later, exactly as in CPython).
// ---------------------------------------------------------------------------

// AST nodes: `k` is the Python class name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = { k: string; [field: string]: any };

interface ParseError {
  kind: "syntax" | "other";
  msg: string;
  pyType: string;
}

function nodeName(e: Node): string {
  switch (e.k) {
    case "Attribute": return "attribute";
    case "Subscript": return "subscript";
    case "Starred": return "starred";
    case "Name": return "name";
    case "List": return "list";
    case "Tuple": return "tuple";
    case "Lambda": return "lambda";
    case "Call": return "function call";
    case "BoolOp":
    case "BinOp":
    case "UnaryOp": return "expression";
    case "GeneratorExp": return "generator expression";
    case "Yield":
    case "YieldFrom": return "yield expression";
    case "Await": return "await expression";
    case "ListComp": return "list comprehension";
    case "SetComp": return "set comprehension";
    case "DictComp": return "dict comprehension";
    case "Dict": return "dict literal";
    case "Set": return "set display";
    case "JoinedStr":
    case "FormattedValue": return "f-string expression";
    case "TemplateStr":
    case "Interpolation": return "t-string expression";
    case "Constant": {
      const v = e.value;
      if (v === null) return "None";
      if (v === false) return "False";
      if (v === true) return "True";
      if (v === ELLIPSIS) return "ellipsis";
      return "literal";
    }
    case "Compare": return "comparison";
    case "IfExp": return "conditional expression";
    case "NamedExpr": return "named expression";
    default: return "expression";
  }
}

/** _PyPegen_get_invalid_target */
function invalidTarget(e: Node | null, forTargets: boolean): Node | null {
  if (e === null) return null;
  switch (e.k) {
    case "List":
    case "Tuple":
      for (const x of e.elts as Node[]) {
        const c = invalidTarget(x, forTargets);
        if (c !== null) return c;
      }
      return null;
    case "Starred":
      return invalidTarget(e.value, forTargets);
    case "Compare":
      if (forTargets) {
        if (e.ops[0] === "In") return invalidTarget(e.left, forTargets);
        return null;
      }
      return e;
    case "Name":
    case "Subscript":
    case "Attribute":
      return null;
    default:
      return e;
  }
}

class Parser {
  lx: Lexer;
  toks: Token[] = [];
  mark = 0;
  callInvalid = false;
  errorIndicator = false;
  error: ParseError | null = null;
  memo: Map<string, { res: Node | null; end: number }>[] = [];

  constructor(lx: Lexer) {
    this.lx = lx;
  }

  // ---- errors -------------------------------------------------------------

  setError(kind: "syntax" | "other", msg: string, pyType: string): void {
    if (this.error === null) this.error = { kind, msg, pyType };
    this.errorIndicator = true;
  }
  /** _PyPegen_raise_error (all RAISE_* macros) */
  raise(msg: string, useMark = false, pyType = "SyntaxError"): null {
    if (this.errorIndicator && this.error) return null;
    if (this.toks.length === 0) {
      this.setError("syntax", msg, pyType);
      return null;
    }
    if (useMark && this.mark === this.toks.length && !this.fillToken()) {
      this.errorIndicator = true;
      return null;
    }
    this.setError("syntax", msg, pyType);
    return null;
  }

  tokenizerError(): void {
    if (this.error) {
      this.errorIndicator = true;
      return;
    }
    if (this.lx.err !== null) {
      this.setError("syntax", this.lx.err, "SyntaxError");
      return;
    }
    switch (this.lx.done) {
      case "EOF":
        if (this.lx.level) this.unclosedParen();
        else this.raise("unexpected EOF while parsing");
        return;
      case "DEDENT":
        this.raise("unindent does not match any outer indentation level", false, "IndentationError");
        return;
      case "TABSPACE":
        this.setError("syntax", "inconsistent use of tabs and spaces in indentation", "TabError");
        return;
      case "TOODEEP":
        this.setError("syntax", "too many levels of indentation", "IndentationError");
        return;
      case "LINECONT":
        this.setError("syntax", "unexpected character after line continuation character", "SyntaxError");
        return;
      default:
        this.setError("syntax", "unknown parsing error", "SyntaxError");
    }
  }
  unclosedParen(): void {
    const c = this.lx.parenstack[this.lx.level - 1];
    this.raise(`'${chr(c)}' was never closed`);
  }

  // ---- tokens -------------------------------------------------------------

  fillToken(): boolean {
    const t = this.lx.get();
    if (t.type === "NAME" && KEYWORDS.has(t.str)) t.kw = true;
    this.toks.push(t);
    this.memo.push(new Map());
    if (t.type === "ERRORTOKEN") {
      this.tokenizerError();
      return false;
    }
    return true;
  }
  peek(): Token | null {
    if (this.mark === this.toks.length && !this.fillToken()) {
      this.errorIndicator = true;
      return null;
    }
    return this.toks[this.mark];
  }
  /** _PyPegen_expect_token for operators and keywords */
  expect(s: string): Token | null {
    const t = this.peek();
    if (t === null) return null;
    const ok =
      (t.type === "OP" && t.str === s) || (t.kw && t.str === s);
    if (!ok) return null;
    this.mark++;
    return t;
  }
  expectType(type: TokType): Token | null {
    const t = this.peek();
    if (t === null) return null;
    if (t.type !== type || t.kw) return null;
    this.mark++;
    return t;
  }
  /** lookahead(positive, fn) */
  la(positive: boolean, fn: () => unknown): boolean {
    const m = this.mark;
    const r = fn();
    this.mark = m;
    return (r !== null && r !== undefined && r !== false) === positive;
  }

  // ---- memoisation ---------------------------------------------------------

  memoGet(name: string): { res: Node | null; end: number } | undefined | "ERR" {
    if (this.mark === this.toks.length && !this.fillToken()) {
      this.errorIndicator = true;
      return "ERR";
    }
    return this.memo[this.mark].get(name);
  }
  memoRule(name: string, body: () => Node | null): Node | null {
    if (this.errorIndicator) return null;
    const hit = this.memoGet(name);
    if (hit === "ERR") return null;
    if (hit !== undefined) {
      this.mark = hit.end;
      return hit.res;
    }
    const m = this.mark;
    const res = body();
    if (this.errorIndicator) return null;
    this.memo[m].set(name, { res, end: this.mark });
    return res;
  }
  leftRec(name: string, raw: () => Node | null): Node | null {
    if (this.errorIndicator) return null;
    const hit = this.memoGet(name);
    if (hit === "ERR") return null;
    if (hit !== undefined) {
      this.mark = hit.end;
      return hit.res;
    }
    const m = this.mark;
    let resmark = this.mark;
    let res: Node | null = null;
    for (;;) {
      this.memo[m].set(name, { res, end: this.mark });
      this.mark = m;
      const r = raw();
      if (this.errorIndicator) return null;
      if (r === null || this.mark <= resmark) break;
      resmark = this.mark;
      res = r;
    }
    this.mark = resmark;
    return res;
  }
  /** Rules with the `_without_invalid` suffix run with invalid rules off. */
  withoutInvalid<T>(fn: () => T): T {
    const prev = this.callInvalid;
    this.callInvalid = false;
    try {
      return fn();
    } finally {
      this.callInvalid = prev;
    }
  }

  // ---- node helpers --------------------------------------------------------

  nameNode(t: Token | null): Node | null {
    if (t === null) return null;
    let id = t.str;
    if (/[^\x00-\x7f]/.test(id)) id = id.normalize("NFKC");
    if (id === "None" || id === "True" || id === "False") {
      this.setError("other", `identifier field can't represent '${id}' constant`, "ValueError");
      return null;
    }
    return { k: "Name", id, tok: t };
  }
  name(): Node | null {
    return this.nameNode(this.expectType("NAME"));
  }
  softKeyword(): Node | null {
    const t = this.expectType("NAME");
    if (t === null) return null;
    if (!SOFT_KEYWORDS.has(t.str)) return null;
    return this.nameNode(t);
  }
  numberNode(): Node | null {
    const t = this.expectType("NUMBER");
    if (t === null) return null;
    return { k: "Constant", value: parseNumberLiteral(t.str), tok: t };
  }

  /** gather: ','.elem+ */
  gather(elem: () => Node | null): Node[] | null {
    const first = elem();
    if (first === null) return null;
    const out = [first];
    for (;;) {
      const m = this.mark;
      if (this.expect(",") === null) {
        this.mark = m;
        break;
      }
      const e = elem();
      if (e === null) {
        this.mark = m;
        break;
      }
      out.push(e);
    }
    return out;
  }
  /** loop1: elem+ */
  many1(elem: () => Node | null): Node[] | null {
    const out: Node[] = [];
    for (;;) {
      const m = this.mark;
      const e = elem();
      if (e === null) {
        this.mark = m;
        break;
      }
      out.push(e);
    }
    return out.length ? out : null;
  }
  many0(elem: () => Node | null): Node[] {
    return this.many1(elem) ?? [];
  }
  /** [x] — optional; returns the result or undefined when absent. */
  opt<T>(fn: () => T | null): T | undefined {
    const m = this.mark;
    const r = fn();
    if (r === null) {
      this.mark = m;
      return undefined;
    }
    return r;
  }
  /** A parenthesised sequence `(a b c)` as one item: all-or-nothing. */
  seq<T>(fn: () => T | null): T | null {
    const m = this.mark;
    const r = fn();
    if (r === null) this.mark = m;
    return r;
  }

  // ---- start rule -----------------------------------------------------------

  /** eval: expressions NEWLINE* ENDMARKER */
  evalRule(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const a = this.expressions();
    if (a !== null) {
      this.many0(() => this.expectType("NEWLINE") as Node | null);
      if (this.expectType("ENDMARKER") !== null) return { k: "Expression", body: a };
    }
    this.mark = m;
    return null;
  }

  // ---- expressions -----------------------------------------------------------

  expressions(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.expression();
      if (a !== null) {
        const b = this.many1(() => this.seq(() => (this.expect(",") !== null ? this.expression() : null)));
        if (b !== null) {
          this.opt(() => this.expect(","));
          return { k: "Tuple", elts: [a, ...b] };
        }
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    {
      const a = this.expression();
      if (a !== null && this.expect(",") !== null) return { k: "Tuple", elts: [a] };
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    return this.expression();
  }

  expression(): Node | null {
    return this.memoRule("expression", () => {
      const m = this.mark;
      if (this.callInvalid) {
        if (this.invalid_expression() !== null) return null;
        this.mark = m;
        if (this.errorIndicator) return null;
        if (this.invalid_legacy_expression() !== null) return null;
        this.mark = m;
        if (this.errorIndicator) return null;
      }
      {
        const a = this.disjunction();
        if (a !== null && this.expect("if") !== null) {
          const b = this.disjunction();
          if (b !== null && this.expect("else") !== null) {
            const c = this.expression();
            if (c !== null) return { k: "IfExp", test: b, body: a, orelse: c };
          }
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.disjunction();
        if (a !== null) return a;
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.lambdef();
        if (a !== null) return a;
        this.mark = m;
      }
      return null;
    });
  }

  yield_expr(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("yield") !== null && this.expect("from") !== null) {
      const a = this.expression();
      if (a !== null) return { k: "YieldFrom", value: a };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("yield") !== null) {
      const a = this.opt(() => this.star_expressions());
      return { k: "Yield", value: a ?? null };
    }
    this.mark = m;
    return null;
  }

  star_expressions(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.star_expression();
      if (a !== null) {
        const b = this.many1(() => this.seq(() => (this.expect(",") !== null ? this.star_expression() : null)));
        if (b !== null) {
          this.opt(() => this.expect(","));
          return { k: "Tuple", elts: [a, ...b] };
        }
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    {
      const a = this.star_expression();
      if (a !== null && this.expect(",") !== null) return { k: "Tuple", elts: [a] };
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    return this.star_expression();
  }

  star_expression(): Node | null {
    return this.memoRule("star_expression", () => {
      const m = this.mark;
      if (this.expect("*") !== null) {
        const a = this.bitwise_or();
        if (a !== null) return { k: "Starred", value: a };
      }
      this.mark = m;
      if (this.errorIndicator) return null;
      const e = this.expression();
      if (e !== null) return e;
      this.mark = m;
      return null;
    });
  }

  star_named_expressions(): Node[] | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const a = this.gather(() => this.star_named_expression());
    if (a !== null) {
      this.opt(() => this.expect(","));
      return a;
    }
    this.mark = m;
    return null;
  }

  star_named_expression(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("*") !== null) {
      const a = this.bitwise_or();
      if (a !== null) return { k: "Starred", value: a };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    const e = this.named_expression();
    if (e !== null) return e;
    this.mark = m;
    return null;
  }

  assignment_expression(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const a = this.name();
    if (a !== null && this.expect(":=") !== null) {
      // cut
      const b = this.expression();
      if (b !== null) return { k: "NamedExpr", target: a, value: b };
      this.mark = m;
      return null;
    }
    this.mark = m;
    return null;
  }

  named_expression(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.assignment_expression();
      if (a !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    if (this.callInvalid) {
      if (this.invalid_named_expression() !== null) return null;
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    {
      const a = this.expression();
      if (a !== null && this.la(false, () => this.expect(":="))) return a;
      this.mark = m;
    }
    return null;
  }

  disjunction(): Node | null {
    return this.memoRule("disjunction", () => {
      const m = this.mark;
      {
        const a = this.conjunction();
        if (a !== null) {
          const b = this.many1(() => this.seq(() => (this.expect("or") !== null ? this.conjunction() : null)));
          if (b !== null) return { k: "BoolOp", op: "Or", values: [a, ...b] };
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      const a = this.conjunction();
      if (a !== null) return a;
      this.mark = m;
      return null;
    });
  }

  conjunction(): Node | null {
    return this.memoRule("conjunction", () => {
      const m = this.mark;
      {
        const a = this.inversion();
        if (a !== null) {
          const b = this.many1(() => this.seq(() => (this.expect("and") !== null ? this.inversion() : null)));
          if (b !== null) return { k: "BoolOp", op: "And", values: [a, ...b] };
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      const a = this.inversion();
      if (a !== null) return a;
      this.mark = m;
      return null;
    });
  }

  inversion(): Node | null {
    return this.memoRule("inversion", () => {
      const m = this.mark;
      if (this.expect("not") !== null) {
        const a = this.inversion();
        if (a !== null) return { k: "UnaryOp", op: "Not", operand: a };
      }
      this.mark = m;
      if (this.errorIndicator) return null;
      const a = this.comparison();
      if (a !== null) return a;
      this.mark = m;
      return null;
    });
  }

  comparison(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.bitwise_or();
      if (a !== null) {
        const b = this.many1(() => this.compare_op_bitwise_or_pair());
        if (b !== null) {
          return { k: "Compare", left: a, ops: b.map((x) => x.op), comparators: b.map((x) => x.expr) };
        }
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const a = this.bitwise_or();
    if (a !== null) return a;
    this.mark = m;
    return null;
  }

  compare_op_bitwise_or_pair(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const simple: [string, string][] = [["==", "Eq"]];
    for (const [s, op] of simple) {
      if (this.expect(s) !== null) {
        const a = this.bitwise_or();
        if (a !== null) return { k: "pair", op, expr: a };
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    // noteq: (tok='!=' { check_barry_as_flufl(tok) ? NULL : tok }) bitwise_or
    {
      const t = this.expect("!=");
      if (t !== null) {
        const a = this.bitwise_or();
        if (a !== null) return { k: "pair", op: "NotEq", expr: a };
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    const rest: [string[], string][] = [
      [["<="], "LtE"],
      [["<"], "Lt"],
      [[">="], "GtE"],
      [[">"], "Gt"],
      [["not", "in"], "NotIn"],
      [["in"], "In"],
      [["is", "not"], "IsNot"],
      [["is"], "Is"],
    ];
    for (const [ss, op] of rest) {
      if (op === "Lt" && this.callInvalid) {
        // invalid_noteq: a='<' b='>' (adjacent) -> error, else NULL
        const a = this.expect("<");
        if (a !== null) {
          const b = this.expect(">");
          if (b !== null) {
            if (a.endLineno === b.lineno && a.endCol === b.col) {
              return this.raise("invalid syntax.  Maybe you meant '!=' instead of '<>'?");
            }
          }
        }
        this.mark = m;
        if (this.errorIndicator) return null;
      }
      let ok = true;
      for (const s of ss) {
        if (this.expect(s) === null) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const a = this.bitwise_or();
        if (a !== null) return { k: "pair", op, expr: a };
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    return null;
  }

  binLeftRec(name: string, self: () => Node | null, ops: [string, string][], next: () => Node | null): Node | null {
    return this.leftRec(name, () => {
      const m = this.mark;
      for (const [s, op] of ops) {
        const a = self();
        if (a !== null && this.expect(s) !== null) {
          const b = next();
          if (b !== null) return { k: "BinOp", left: a, op, right: b };
        }
        this.mark = m;
        if (this.errorIndicator) return null;
      }
      const b = next();
      if (b !== null) return b;
      this.mark = m;
      return null;
    });
  }

  bitwise_or(): Node | null {
    return this.binLeftRec("bitwise_or", () => this.bitwise_or(), [["|", "BitOr"]], () => this.bitwise_xor());
  }
  bitwise_xor(): Node | null {
    return this.binLeftRec("bitwise_xor", () => this.bitwise_xor(), [["^", "BitXor"]], () => this.bitwise_and());
  }
  bitwise_and(): Node | null {
    return this.binLeftRec("bitwise_and", () => this.bitwise_and(), [["&", "BitAnd"]], () => this.shift_expr());
  }
  shift_expr(): Node | null {
    return this.leftRec("shift_expr", () => {
      const m = this.mark;
      for (const [s, op] of [["<<", "LShift"], [">>", "RShift"]] as [string, string][]) {
        const a = this.shift_expr();
        if (a !== null && this.expect(s) !== null) {
          const b = this.sum();
          if (b !== null) return { k: "BinOp", left: a, op, right: b };
        }
        this.mark = m;
        if (this.errorIndicator) return null;
      }
      if (this.callInvalid) {
        if (this.invalid_arithmetic() !== null) return null;
        this.mark = m;
        if (this.errorIndicator) return null;
      }
      const b = this.sum();
      if (b !== null) return b;
      this.mark = m;
      return null;
    });
  }
  invalid_arithmetic(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.sum() !== null) {
      const opTok = this.seq(() => {
        for (const s of ["+", "-", "*", "/", "%", "//", "@"]) {
          const t = this.expect(s);
          if (t !== null) return t;
        }
        return null;
      });
      if (opTok !== null && this.expect("not") !== null && this.inversion() !== null) {
        return this.raise("'not' after an operator must be parenthesized");
      }
    }
    this.mark = m;
    return null;
  }
  sum(): Node | null {
    return this.binLeftRec("sum", () => this.sum(), [["+", "Add"], ["-", "Sub"]], () => this.term());
  }
  term(): Node | null {
    return this.leftRec("term", () => {
      const m = this.mark;
      const ops: [string, string][] = [
        ["*", "Mult"],
        ["/", "Div"],
        ["//", "FloorDiv"],
        ["%", "Mod"],
        ["@", "MatMult"],
      ];
      for (const [s, op] of ops) {
        const a = this.term();
        if (a !== null && this.expect(s) !== null) {
          const b = this.factor();
          if (b !== null) return { k: "BinOp", left: a, op, right: b };
        }
        this.mark = m;
        if (this.errorIndicator) return null;
      }
      if (this.callInvalid) {
        if (this.invalid_factor() !== null) return null;
        this.mark = m;
        if (this.errorIndicator) return null;
      }
      const b = this.factor();
      if (b !== null) return b;
      this.mark = m;
      return null;
    });
  }
  invalid_factor(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const t = this.seq(() => this.expect("+") ?? this.expect("-") ?? this.expect("~"));
    if (t !== null && this.expect("not") !== null && this.factor() !== null) {
      return this.raise("'not' after an operator must be parenthesized");
    }
    this.mark = m;
    return null;
  }
  factor(): Node | null {
    return this.memoRule("factor", () => {
      const m = this.mark;
      for (const [s, op] of [["+", "UAdd"], ["-", "USub"], ["~", "Invert"]] as [string, string][]) {
        if (this.expect(s) !== null) {
          const a = this.factor();
          if (a !== null) return { k: "UnaryOp", op, operand: a };
        }
        this.mark = m;
        if (this.errorIndicator) return null;
      }
      const a = this.power();
      if (a !== null) return a;
      this.mark = m;
      return null;
    });
  }
  power(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.await_primary();
      if (a !== null && this.expect("**") !== null) {
        const b = this.factor();
        if (b !== null) return { k: "BinOp", left: a, op: "Pow", right: b };
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const a = this.await_primary();
    if (a !== null) return a;
    this.mark = m;
    return null;
  }
  await_primary(): Node | null {
    return this.memoRule("await_primary", () => {
      const m = this.mark;
      if (this.expect("await") !== null) {
        const a = this.primary();
        if (a !== null) return { k: "Await", value: a };
      }
      this.mark = m;
      if (this.errorIndicator) return null;
      const a = this.primary();
      if (a !== null) return a;
      this.mark = m;
      return null;
    });
  }
  primary(): Node | null {
    return this.leftRec("primary", () => {
      const m = this.mark;
      {
        const a = this.primary();
        if (a !== null && this.expect(".") !== null) {
          const b = this.name();
          if (b !== null) return { k: "Attribute", value: a, attr: b.id };
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.primary();
        if (a !== null) {
          const b = this.genexp();
          if (b !== null) return { k: "Call", func: a, args: [b], keywords: [] };
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.primary();
        if (a !== null && this.expect("(") !== null) {
          const b = this.opt(() => this.arguments());
          if (this.expect(")") !== null) {
            return { k: "Call", func: a, args: b ? b.args : [], keywords: b ? b.keywords : [] };
          }
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.primary();
        if (a !== null && this.expect("[") !== null) {
          const b = this.slices();
          if (b !== null && this.expect("]") !== null) return { k: "Subscript", value: a, slice: b };
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      const a = this.atom();
      if (a !== null) return a;
      this.mark = m;
      return null;
    });
  }
  slices(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.slice();
      if (a !== null && this.la(false, () => this.expect(","))) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const a = this.gather(() => {
      const mm = this.mark;
      const s = this.slice();
      if (s !== null) return s;
      this.mark = mm;
      if (this.errorIndicator) return null;
      const st = this.starred_expression();
      if (st !== null) return st;
      this.mark = mm;
      return null;
    });
    if (a !== null) {
      this.opt(() => this.expect(","));
      return { k: "Tuple", elts: a };
    }
    this.mark = m;
    return null;
  }
  slice(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.opt(() => this.expression());
      if (this.errorIndicator) return null;
      if (this.expect(":") !== null) {
        const b = this.opt(() => this.expression());
        if (this.errorIndicator) return null;
        const c = this.opt(() =>
          this.seq(() => {
            if (this.expect(":") === null) return null;
            const d = this.opt(() => this.expression());
            return { k: "sliceStep", d: d ?? null };
          }),
        );
        if (this.errorIndicator) return null;
        return { k: "Slice", lower: a ?? null, upper: b ?? null, step: c ? c.d : null };
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const a = this.named_expression();
    if (a !== null) return a;
    this.mark = m;
    return null;
  }

  atom(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.name();
      if (a !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    for (const [kw, v] of [["True", true], ["False", false], ["None", null]] as [string, PyVal][]) {
      if (this.expect(kw) !== null) return { k: "Constant", value: v };
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    if (
      this.la(true, () => this.expectType("STRING") ?? this.expectType("FSTRING_START") ?? this.expectType("TSTRING_START"))
    ) {
      const a = this.strings();
      if (a !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    {
      const a = this.numberNode();
      if (a !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    if (this.la(true, () => this.expect("("))) {
      const a = this.seq(() => {
        const mm = this.mark;
        const t = this.tuple();
        if (t !== null) return t;
        this.mark = mm;
        if (this.errorIndicator) return null;
        const g = this.group();
        if (g !== null) return g;
        this.mark = mm;
        if (this.errorIndicator) return null;
        const ge = this.genexp();
        if (ge !== null) return ge;
        this.mark = mm;
        return null;
      });
      if (a !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    if (this.la(true, () => this.expect("["))) {
      const a = this.seq(() => {
        const mm = this.mark;
        const l = this.list();
        if (l !== null) return l;
        this.mark = mm;
        if (this.errorIndicator) return null;
        const lc = this.listcomp();
        if (lc !== null) return lc;
        this.mark = mm;
        return null;
      });
      if (a !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    if (this.la(true, () => this.expect("{"))) {
      const a = this.seq(() => {
        const mm = this.mark;
        for (const fn of [() => this.dict(), () => this.set(), () => this.dictcomp(), () => this.setcomp()]) {
          const r = fn();
          if (r !== null) return r;
          this.mark = mm;
          if (this.errorIndicator) return null;
        }
        return null;
      });
      if (a !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    if (this.expect("...") !== null) return { k: "Constant", value: ELLIPSIS };
    this.mark = m;
    return null;
  }

  group(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("(") !== null) {
      const a = this.seq(() => {
        const mm = this.mark;
        const y = this.yield_expr();
        if (y !== null) return y;
        this.mark = mm;
        if (this.errorIndicator) return null;
        const n = this.named_expression();
        if (n !== null) return n;
        this.mark = mm;
        return null;
      });
      if (a !== null && this.expect(")") !== null) return a;
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.callInvalid) {
      if (this.invalid_group() !== null) return null;
      this.mark = m;
    }
    return null;
  }
  invalid_group(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("(") !== null) {
      const a = this.starred_expression();
      if (a !== null && this.expect(")") !== null) return this.raise("cannot use starred expression here");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("(") !== null && this.expect("**") !== null) {
      if (this.expression() !== null && this.expect(")") !== null) {
        return this.raise("cannot use double starred expression here");
      }
    }
    this.mark = m;
    return null;
  }

  // ---- lambda -----------------------------------------------------------------

  lambdef(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("lambda") !== null) {
      this.opt(() => this.lambda_params());
      if (this.errorIndicator) return null;
      if (this.expect(":") !== null) {
        const b = this.expression();
        if (b !== null) return { k: "Lambda", body: b };
      }
    }
    this.mark = m;
    return null;
  }
  lambda_params(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.callInvalid) {
      if (this.invalid_lambda_parameters() !== null) return null;
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    const a = this.lambda_parameters();
    if (a !== null) return a;
    this.mark = m;
    return null;
  }
  lambda_parameters(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const P: Node = { k: "arguments" };
    {
      if (this.lambda_slash_no_default() !== null) {
        this.many0(() => this.lambda_param_no_default());
        this.many0(() => this.lambda_param_with_default());
        this.opt(() => this.lambda_star_etc());
        if (!this.errorIndicator) return P;
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    {
      if (this.lambda_slash_with_default() !== null) {
        this.many0(() => this.lambda_param_with_default());
        this.opt(() => this.lambda_star_etc());
        if (!this.errorIndicator) return P;
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    {
      if (this.many1(() => this.lambda_param_no_default()) !== null) {
        this.many0(() => this.lambda_param_with_default());
        this.opt(() => this.lambda_star_etc());
        if (!this.errorIndicator) return P;
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    {
      if (this.many1(() => this.lambda_param_with_default()) !== null) {
        this.opt(() => this.lambda_star_etc());
        if (!this.errorIndicator) return P;
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    if (this.lambda_star_etc() !== null) return P;
    this.mark = m;
    return null;
  }
  lambda_slash_no_default(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.many1(() => this.lambda_param_no_default()) !== null && this.expect("/") !== null && this.expect(",") !== null) {
      return { k: "x" };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (
      this.many1(() => this.lambda_param_no_default()) !== null &&
      this.expect("/") !== null &&
      this.la(true, () => this.expect(":"))
    ) {
      return { k: "x" };
    }
    this.mark = m;
    return null;
  }
  lambda_slash_with_default(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    for (const last of [() => this.expect(","), () => (this.la(true, () => this.expect(":")) ? ({} as Token) : null)]) {
      this.many0(() => this.lambda_param_no_default());
      if (this.many1(() => this.lambda_param_with_default()) !== null && this.expect("/") !== null && last() !== null) {
        return { k: "x" };
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    return null;
  }
  lambda_star_etc(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.callInvalid) {
      if (this.invalid_lambda_star_etc() !== null) return null;
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    if (this.expect("*") !== null && this.lambda_param_no_default() !== null) {
      this.many0(() => this.lambda_param_maybe_default());
      this.opt(() => this.lambda_kwds());
      if (!this.errorIndicator) return { k: "x" };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("*") !== null && this.expect(",") !== null && this.many1(() => this.lambda_param_maybe_default()) !== null) {
      this.opt(() => this.lambda_kwds());
      if (!this.errorIndicator) return { k: "x" };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.lambda_kwds() !== null) return { k: "x" };
    this.mark = m;
    return null;
  }
  lambda_kwds(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.callInvalid) {
      if (this.invalid_lambda_kwds() !== null) return null;
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    if (this.expect("**") !== null) {
      const a = this.lambda_param_no_default();
      if (a !== null) return a;
    }
    this.mark = m;
    return null;
  }
  lambda_param_no_default(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.lambda_param();
      if (a !== null && this.expect(",") !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const a = this.lambda_param();
    if (a !== null && this.la(true, () => this.expect(":"))) return a;
    this.mark = m;
    return null;
  }
  lambda_param_with_default(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.lambda_param();
      if (a !== null && this.default_() !== null && this.expect(",") !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const a = this.lambda_param();
    if (a !== null && this.default_() !== null && this.la(true, () => this.expect(":"))) return a;
    this.mark = m;
    return null;
  }
  lambda_param_maybe_default(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.lambda_param();
      if (a !== null) {
        this.opt(() => this.default_());
        if (!this.errorIndicator && this.expect(",") !== null) return a;
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const a = this.lambda_param();
    if (a !== null) {
      this.opt(() => this.default_());
      if (!this.errorIndicator && this.la(true, () => this.expect(":"))) return a;
    }
    this.mark = m;
    return null;
  }
  lambda_param(): Node | null {
    return this.name();
  }
  default_(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("=") !== null) {
      const a = this.expression();
      if (a !== null) return a;
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.callInvalid) {
      if (this.invalid_default() !== null) return null;
      this.mark = m;
    }
    return null;
  }
  invalid_default(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("=") !== null && this.la(true, () => this.expect(")") ?? this.expect(","))) {
      return this.raise("expected default value expression");
    }
    this.mark = m;
    return null;
  }
  invalid_lambda_parameters(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    // "/" ','
    if (this.expect("/") !== null && this.expect(",") !== null) return this.raise("at least one argument must precede /");
    this.mark = m;
    if (this.errorIndicator) return null;
    // (lambda_slash_no_default | lambda_slash_with_default) lambda_param_maybe_default* '/'
    {
      const s = this.seq(() => {
        const mm = this.mark;
        const a = this.lambda_slash_no_default();
        if (a !== null) return a;
        this.mark = mm;
        if (this.errorIndicator) return null;
        const b = this.lambda_slash_with_default();
        if (b !== null) return b;
        this.mark = mm;
        return null;
      });
      if (s !== null) {
        this.many0(() => this.lambda_param_maybe_default());
        if (this.expect("/") !== null) return this.raise("/ may appear only once");
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    // lambda_slash_no_default? lambda_param_no_default* invalid_lambda_parameters_helper lambda_param_no_default
    {
      this.opt(() => this.lambda_slash_no_default());
      this.many0(() => this.lambda_param_no_default());
      if (this.invalid_lambda_parameters_helper() !== null && this.lambda_param_no_default() !== null) {
        return this.raise("parameter without a default follows parameter with a default");
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    // lambda_param_no_default* '(' ','.lambda_param+ ','? ')'
    {
      this.many0(() => this.lambda_param_no_default());
      if (this.expect("(") !== null && this.gather(() => this.lambda_param()) !== null) {
        this.opt(() => this.expect(","));
        if (this.expect(")") !== null) return this.raise("Lambda expression parameters cannot be parenthesized");
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    // (lambda_slash_no_default | lambda_slash_with_default)? lambda_param_maybe_default* '*' (',' | lambda_param_no_default) lambda_param_maybe_default* '/'
    {
      this.opt(() =>
        this.seq(() => {
          const mm = this.mark;
          const a = this.lambda_slash_no_default();
          if (a !== null) return a;
          this.mark = mm;
          if (this.errorIndicator) return null;
          const b = this.lambda_slash_with_default();
          if (b !== null) return b;
          this.mark = mm;
          return null;
        }),
      );
      this.many0(() => this.lambda_param_maybe_default());
      if (this.expect("*") !== null) {
        const x = this.seq(() => (this.expect(",") as Node | null) ?? this.lambda_param_no_default());
        if (x !== null) {
          this.many0(() => this.lambda_param_maybe_default());
          if (this.expect("/") !== null) return this.raise("/ must be ahead of *");
        }
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    // lambda_param_maybe_default+ '/' '*'
    if (
      this.many1(() => this.lambda_param_maybe_default()) !== null &&
      this.expect("/") !== null &&
      this.expect("*") !== null
    ) {
      return this.raise("expected comma between / and *");
    }
    this.mark = m;
    return null;
  }
  invalid_lambda_parameters_helper(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const a = this.lambda_slash_with_default();
    if (a !== null) return a;
    this.mark = m;
    if (this.errorIndicator) return null;
    const b = this.many1(() => this.lambda_param_with_default());
    if (b !== null) return { k: "x" };
    this.mark = m;
    return null;
  }
  invalid_lambda_star_etc(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("*") !== null) {
      const x = this.seq(() => {
        if (this.expect(":") !== null) return {} as Node;
        const mm = this.mark;
        if (this.expect(",") !== null && (this.expect(":") ?? this.expect("**")) !== null) return {} as Node;
        this.mark = mm;
        return null;
      });
      if (x !== null) return this.raise("named arguments must follow bare *");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("*") !== null && this.lambda_param() !== null && this.expect("=") !== null) {
      return this.raise("var-positional argument cannot have default value");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("*") !== null) {
      const x = this.seq(() => this.lambda_param_no_default() ?? (this.expect(",") as Node | null));
      if (x !== null) {
        this.many0(() => this.lambda_param_maybe_default());
        if (this.expect("*") !== null) {
          const y = this.seq(() => this.lambda_param_no_default() ?? (this.expect(",") as Node | null));
          if (y !== null) return this.raise("* argument may appear only once");
        }
      }
    }
    this.mark = m;
    return null;
  }
  invalid_lambda_kwds(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("**") !== null && this.lambda_param() !== null && this.expect("=") !== null) {
      return this.raise("var-keyword argument cannot have default value");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("**") !== null && this.lambda_param() !== null && this.expect(",") !== null && this.lambda_param() !== null) {
      return this.raise("arguments cannot follow var-keyword argument");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("**") !== null && this.lambda_param() !== null && this.expect(",") !== null) {
      if ((this.expect("*") ?? this.expect("**") ?? this.expect("/")) !== null) {
        return this.raise("arguments cannot follow var-keyword argument");
      }
    }
    this.mark = m;
    return null;
  }

  // ---- strings ----------------------------------------------------------------

  strings(): Node | null {
    return this.memoRule("strings", () => {
      const m = this.mark;
      if (this.callInvalid) {
        if (this.invalid_string_tstring_concat() !== null) return null;
        this.mark = m;
        if (this.errorIndicator) return null;
      }
      {
        const a = this.many1(() => this.fstringOrString());
        if (a !== null) return this.concatenateStrings(a);
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.many1(() => this.tstring());
        if (a !== null) return { k: "TemplateStr" };
        this.mark = m;
      }
      return null;
    });
  }
  fstringOrString(): Node | null {
    const m = this.mark;
    const f = this.fstring();
    if (f !== null) return f;
    this.mark = m;
    if (this.errorIndicator) return null;
    const s = this.string();
    if (s !== null) return s;
    this.mark = m;
    return null;
  }
  string(): Node | null {
    if (this.errorIndicator) return null;
    const t = this.expectType("STRING");
    if (t === null) return null;
    const v = parseStringToken(t.str);
    if (v instanceof DecodeFailure) {
      if (v.syntaxMsg !== null) this.raise(v.syntaxMsg);
      else this.raise(v.decodeMsg);
      return null;
    }
    return { k: "Constant", value: v, tok: t };
  }
  concatenateStrings(parts: Node[]): Node | null {
    let f = false;
    let u = false;
    let b = false;
    for (const e of parts) {
      if (e.k === "Constant") {
        if (e.value instanceof PyBytes) b = true;
        else u = true;
      } else {
        f = true;
      }
    }
    if ((u || f) && b) return this.raise("cannot mix bytes and nonbytes literals");
    if (!f) {
      if (parts.length === 1) return parts[0];
      if (b) return { k: "Constant", value: new PyBytes(parts.flatMap((p) => (p.value as PyBytes).bytes)) };
      return { k: "Constant", value: parts.map((p) => p.value as string).join("") };
    }
    return { k: "JoinedStr" };
  }
  invalid_string_tstring_concat(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.many1(() => this.fstringOrString()) !== null && this.tstring() !== null) {
      return this.raise("cannot mix t-string literals with string or bytes literals");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.many1(() => this.tstring()) !== null && this.fstringOrString() !== null) {
      return this.raise("cannot mix t-string literals with string or bytes literals");
    }
    this.mark = m;
    return null;
  }

  fstring(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const a = this.expectType("FSTRING_START");
    if (a !== null) {
      const b = this.many0(() => this.ftMiddle("f"));
      if (this.errorIndicator) return null;
      const c = this.expectType("FSTRING_END");
      if (c !== null) return this.joinedStr(a, b, "JoinedStr");
    }
    this.mark = m;
    return null;
  }
  tstring(): Node | null {
    return this.memoRule("tstring", () => {
      const m = this.mark;
      const a = this.expectType("TSTRING_START");
      if (a !== null) {
        const b = this.many0(() => this.ftMiddle("t"));
        if (this.errorIndicator) return null;
        const c = this.expectType("TSTRING_END");
        if (c !== null) return this.joinedStr(a, b, "TemplateStr");
      }
      this.mark = m;
      return null;
    });
  }
  /** _get_resized_exprs: decode the literal parts. */
  joinedStr(start: Token, parts: Node[], k: string): Node | null {
    const isRaw = /[rR]/.test(start.str);
    for (const item of parts) {
      if (item.k === "Constant" && typeof item.value === "string") {
        const raw = item.value as string;
        const text = raw === "{{" || raw === "}}" ? raw.slice(0, 1) : raw;
        const r = decodeStr(text, isRaw || !text.includes("\\"));
        if (r instanceof DecodeFailure) {
          return this.raise(r.syntaxMsg ?? r.decodeMsg);
        }
      }
    }
    return { k };
  }
  /** fstring_middle / tstring_middle */
  ftMiddle(kind: "f" | "t"): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const rf = this.replacementField(kind);
    if (rf !== null) return rf;
    this.mark = m;
    if (this.errorIndicator) return null;
    const t = this.expectType(kind === "f" ? "FSTRING_MIDDLE" : "TSTRING_MIDDLE");
    if (t !== null) return { k: "Constant", value: t.str };
    this.mark = m;
    return null;
  }
  /** fstring_replacement_field / tstring_replacement_field /
   * tstring_format_spec_replacement_field */
  replacementField(kind: "f" | "t"): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("{") !== null) {
      const a = this.annotated_rhs();
      if (a !== null) {
        const debug = this.opt(() => this.expect("="));
        if (this.errorIndicator) return null;
        const conv = this.opt(() => this.fstring_conversion());
        if (this.errorIndicator) return null;
        const spec = this.opt(() => this.fullFormatSpec(kind));
        if (this.errorIndicator) return null;
        const rbrace = this.expect("}");
        if (rbrace !== null) {
          // _PyPegen_formatted_value: the debug text comes from the metadata
          // of the '!', ':' or '}' token; without it _PyAST_Constant fails.
          const metaTok: Token = conv ? conv.bang : spec ? spec.colon : rbrace;
          if (debug !== undefined && !metaTok.meta) {
            this.setError("other", "field 'value' is required for Constant", "ValueError");
            return null;
          }
          return { k: kind === "f" ? "FormattedValue" : "Interpolation" };
        }
      }
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.callInvalid) {
      if (this.invalid_replacement_field(kind) !== null) return null;
      this.mark = m;
    }
    return null;
  }
  fstring_conversion(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const convTok = this.expect("!");
    if (convTok !== null) {
      const conv = this.name();
      if (conv !== null) {
        const ct: Token = conv.tok;
        if (convTok.endLineno !== ct.lineno || convTok.endCol !== ct.col) {
          return this.raise(`${this.lx.prefix()}-string: conversion type must come right after the exclamation mark`);
        }
        const id: string = conv.id;
        if (pyLen(id) > 1 || !(id === "s" || id === "r" || id === "a")) {
          return this.raise(
            `${this.lx.prefix()}-string: invalid conversion character ${strRepr(id)}: expected 's', 'r', or 'a'`,
          );
        }
        return { ...conv, bang: convTok };
      }
    }
    this.mark = m;
    return null;
  }
  fullFormatSpec(kind: "f" | "t"): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const colon = this.expect(":");
    if (colon !== null) {
      this.many0(() => this.formatSpec(kind));
      if (!this.errorIndicator) return { k: "spec", colon };
    }
    this.mark = m;
    return null;
  }
  formatSpec(kind: "f" | "t"): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const t = this.expectType(kind === "f" ? "FSTRING_MIDDLE" : "TSTRING_MIDDLE");
    if (t !== null) {
      // _PyPegen_decoded_constant_from_token: raw if the innermost open
      // f-string is raw; a decode error here is not turned into SyntaxError.
      const raw = this.lx.insideFstring() ? this.lx.mode.raw : false;
      const r = decodeStr(t.str, raw);
      if (r instanceof DecodeFailure) {
        if (r.syntaxMsg !== null) this.raise(r.syntaxMsg);
        else this.setError("other", r.decodeMsg.replace(/^\(unicode error\) /, ""), "UnicodeDecodeError");
        return null;
      }
      return { k: "Constant", value: r };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    const rf = this.replacementField(kind);
    if (rf !== null) return rf;
    this.mark = m;
    return null;
  }
  invalid_replacement_field(kind: "f" | "t"): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const P = `${kind}-string`;
    for (const s of ["=", "!", ":", "}"]) {
      if (this.expect("{") !== null && this.expect(s) !== null) {
        return this.raise(`${P}: valid expression required before '${s}'`);
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    if (this.expect("{") !== null && this.la(false, () => this.annotated_rhs())) {
      return this.raise(`${P}: expecting a valid expression after '{'`, true);
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (
      this.expect("{") !== null &&
      this.annotated_rhs() !== null &&
      this.la(false, () => this.expect("=") ?? this.expect("!") ?? this.expect(":") ?? this.expect("}"))
    ) {
      return this.raise(`${P}: expecting '=', or '!', or ':', or '}'`, true);
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (
      this.expect("{") !== null &&
      this.annotated_rhs() !== null &&
      this.expect("=") !== null &&
      this.la(false, () => this.expect("!") ?? this.expect(":") ?? this.expect("}"))
    ) {
      return this.raise(`${P}: expecting '!', or ':', or '}'`, true);
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("{") !== null && this.annotated_rhs() !== null) {
      this.opt(() => this.expect("="));
      if (this.invalid_conversion_character(kind) !== null) return null;
      if (this.errorIndicator) return null;
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("{") !== null && this.annotated_rhs() !== null) {
      this.opt(() => this.expect("="));
      this.opt(() => this.seq(() => (this.expect("!") !== null ? this.name() : null)));
      if (this.errorIndicator) return null;
      if (this.la(false, () => this.expect(":") ?? this.expect("}"))) {
        return this.raise(`${P}: expecting ':' or '}'`, true);
      }
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("{") !== null && this.annotated_rhs() !== null) {
      this.opt(() => this.expect("="));
      this.opt(() => this.seq(() => (this.expect("!") !== null ? this.name() : null)));
      if (this.errorIndicator) return null;
      if (this.expect(":") !== null) {
        this.many0(() => this.formatSpec("f"));
        if (this.errorIndicator) return null;
        if (this.la(false, () => this.expect("}"))) return this.raise(`${P}: expecting '}', or format specs`, true);
      }
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("{") !== null && this.annotated_rhs() !== null) {
      this.opt(() => this.expect("="));
      this.opt(() => this.seq(() => (this.expect("!") !== null ? this.name() : null)));
      if (this.errorIndicator) return null;
      if (this.la(false, () => this.expect("}"))) return this.raise(`${P}: expecting '}'`, true);
    }
    this.mark = m;
    return null;
  }
  invalid_conversion_character(kind: "f" | "t"): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("!") !== null && this.la(true, () => this.expect(":") ?? this.expect("}"))) {
      return this.raise(`${kind}-string: missing conversion character`, true);
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("!") !== null && this.la(false, () => this.name())) {
      return this.raise(`${kind}-string: invalid conversion character`, true);
    }
    this.mark = m;
    return null;
  }
  annotated_rhs(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const y = this.yield_expr();
    if (y !== null) return y;
    this.mark = m;
    if (this.errorIndicator) return null;
    const s = this.star_expressions();
    if (s !== null) return s;
    this.mark = m;
    return null;
  }

  // ---- displays ---------------------------------------------------------------

  list(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("[") !== null) {
      const a = this.opt(() => this.star_named_expressions());
      if (this.errorIndicator) return null;
      if (this.expect("]") !== null) return { k: "List", elts: a ?? [] };
    }
    this.mark = m;
    return null;
  }
  tuple(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("(") !== null) {
      const a = this.opt(() =>
        this.seq(() => {
          const y = this.star_named_expression();
          if (y === null || this.expect(",") === null) return null;
          const z = this.opt(() => this.star_named_expressions());
          if (this.errorIndicator) return null;
          return [y, ...(z ?? [])];
        }),
      );
      if (this.errorIndicator) return null;
      if (this.expect(")") !== null) return { k: "Tuple", elts: a ?? [] };
    }
    this.mark = m;
    return null;
  }
  set(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("{") !== null) {
      const a = this.star_named_expressions();
      if (a !== null && this.expect("}") !== null) return { k: "Set", elts: a };
    }
    this.mark = m;
    return null;
  }
  dict(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("{") !== null) {
      this.opt(() => this.double_starred_kvpairs());
      if (this.errorIndicator) return null;
      if (this.expect("}") !== null) return { k: "Dict" };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("{") !== null && this.invalid_double_starred_kvpairs() !== null && this.expect("}") !== null) {
      return { k: "Name", id: "" };
    }
    this.mark = m;
    return null;
  }
  double_starred_kvpairs(): Node[] | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const a = this.gather(() => this.double_starred_kvpair());
    if (a !== null) {
      this.opt(() => this.expect(","));
      return a;
    }
    this.mark = m;
    return null;
  }
  double_starred_kvpair(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("**") !== null) {
      const a = this.bitwise_or();
      if (a !== null) return { k: "kv", key: null, value: a };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    const kv = this.kvpair();
    if (kv !== null) return kv;
    this.mark = m;
    return null;
  }
  kvpair(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const a = this.expression();
    if (a !== null && this.expect(":") !== null) {
      const b = this.expression();
      if (b !== null) return { k: "kv", key: a, value: b };
    }
    this.mark = m;
    return null;
  }
  invalid_double_starred_kvpairs(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.gather(() => this.double_starred_kvpair()) !== null && this.expect(",") !== null) {
      const r = this.invalid_kvpair();
      if (r !== null) return r;
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expression() !== null && this.expect(":") !== null && this.expect("*") !== null && this.bitwise_or() !== null) {
      return this.raise("cannot use a starred expression in a dictionary value");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expression() !== null && this.expect(":") !== null && this.la(true, () => this.expect("}") ?? this.expect(","))) {
      return this.raise("expression expected after dictionary key and ':'");
    }
    this.mark = m;
    return null;
  }
  invalid_kvpair(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expression() !== null && this.la(false, () => this.expect(":"))) {
      return this.raise("':' expected after dictionary key");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expression() !== null && this.expect(":") !== null && this.expect("*") !== null && this.bitwise_or() !== null) {
      return this.raise("cannot use a starred expression in a dictionary value");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expression() !== null && this.expect(":") !== null && this.la(true, () => this.expect("}") ?? this.expect(","))) {
      return this.raise("expression expected after dictionary key and ':'");
    }
    this.mark = m;
    return null;
  }

  // ---- comprehensions ---------------------------------------------------------

  for_if_clauses(): Node[] | null {
    if (this.errorIndicator) return null;
    return this.many1(() => this.for_if_clause());
  }
  for_if_clause(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    for (const isAsync of [true, false]) {
      let cut = false;
      if ((!isAsync || this.expect("async") !== null) && this.expect("for") !== null) {
        const a = this.star_targets();
        if (a !== null && this.expect("in") !== null) {
          cut = true;
          const b = this.disjunction();
          if (b !== null) {
            const c = this.many0(() => this.seq(() => (this.expect("if") !== null ? this.disjunction() : null)));
            if (this.errorIndicator) return null;
            return { k: "comprehension", target: a, iter: b, ifs: c };
          }
        }
      }
      this.mark = m;
      if (cut) return null;
      if (this.errorIndicator) return null;
    }
    if (this.callInvalid) {
      if (this.invalid_for_if_clause() !== null) return null;
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    if (this.callInvalid) {
      if (this.invalid_for_target() !== null) return null;
      this.mark = m;
    }
    return null;
  }
  invalid_for_if_clause(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    this.opt(() => this.expect("async"));
    if (this.expect("for") !== null) {
      const ok = this.seq(() => {
        if (this.bitwise_or() === null) return null;
        this.many0(() => this.seq(() => (this.expect(",") !== null ? this.bitwise_or() : null)));
        if (this.errorIndicator) return null;
        this.opt(() => this.expect(","));
        return {} as Node;
      });
      if (ok !== null && this.la(false, () => this.expect("in"))) {
        return this.raise("'in' expected after for-loop variables");
      }
    }
    this.mark = m;
    return null;
  }
  invalid_for_target(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    this.opt(() => this.expect("async"));
    if (this.expect("for") !== null) {
      const a = this.star_expressions();
      if (a !== null) return this.invalidTargetError(a, true);
    }
    this.mark = m;
    return null;
  }
  invalidTargetError(e: Node, forTargets: boolean): null {
    const t = invalidTarget(e, forTargets);
    if (t !== null) {
      return this.raise(`cannot assign to ${nodeName(t)}`);
    }
    return null;
  }
  comprehensionBody(open: string, close: string, k: string): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect(open) !== null) {
      const a = this.named_expression();
      if (a !== null && this.for_if_clauses() !== null && this.expect(close) !== null) return { k };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.callInvalid) {
      if (this.invalid_comprehension() !== null) return null;
      this.mark = m;
    }
    return null;
  }
  listcomp(): Node | null {
    return this.comprehensionBody("[", "]", "ListComp");
  }
  setcomp(): Node | null {
    return this.comprehensionBody("{", "}", "SetComp");
  }
  genexp(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("(") !== null) {
      const a = this.seq(() => {
        const mm = this.mark;
        const x = this.assignment_expression();
        if (x !== null) return x;
        this.mark = mm;
        if (this.errorIndicator) return null;
        const y = this.expression();
        if (y !== null && this.la(false, () => this.expect(":="))) return y;
        this.mark = mm;
        return null;
      });
      if (a !== null && this.for_if_clauses() !== null && this.expect(")") !== null) return { k: "GeneratorExp" };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.callInvalid) {
      if (this.invalid_comprehension() !== null) return null;
      this.mark = m;
    }
    return null;
  }
  dictcomp(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("{") !== null && this.kvpair() !== null && this.for_if_clauses() !== null && this.expect("}") !== null) {
      return { k: "DictComp" };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.callInvalid) {
      if (this.invalid_dict_comprehension() !== null) return null;
      this.mark = m;
    }
    return null;
  }
  invalid_comprehension(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if ((this.expect("[") ?? this.expect("(") ?? this.expect("{")) !== null) {
      if (this.starred_expression() !== null && this.for_if_clauses() !== null) {
        return this.raise("iterable unpacking cannot be used in comprehension");
      }
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if ((this.expect("[") ?? this.expect("{")) !== null) {
      if (
        this.star_named_expression() !== null &&
        this.expect(",") !== null &&
        this.star_named_expressions() !== null &&
        this.for_if_clauses() !== null
      ) {
        return this.raise("did you forget parentheses around the comprehension target?");
      }
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if ((this.expect("[") ?? this.expect("{")) !== null) {
      if (this.star_named_expression() !== null && this.expect(",") !== null && this.for_if_clauses() !== null) {
        return this.raise("did you forget parentheses around the comprehension target?");
      }
    }
    this.mark = m;
    return null;
  }
  invalid_dict_comprehension(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (
      this.expect("{") !== null &&
      this.expect("**") !== null &&
      this.bitwise_or() !== null &&
      this.for_if_clauses() !== null &&
      this.expect("}") !== null
    ) {
      return this.raise("dict unpacking cannot be used in dict comprehension");
    }
    this.mark = m;
    return null;
  }

  // ---- call arguments ------------------------------------------------------------

  arguments(): Node | null {
    return this.memoRule("arguments", () => {
      const m = this.mark;
      {
        const a = this.args();
        if (a !== null) {
          this.opt(() => this.expect(","));
          if (!this.errorIndicator && this.la(true, () => this.expect(")"))) return a;
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      if (this.callInvalid) {
        if (this.invalid_arguments() !== null) return null;
        this.mark = m;
      }
      return null;
    });
  }
  /** (starred_expression | (assignment_expression | expression !':=') !'=') */
  posArg(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const s = this.starred_expression();
    if (s !== null) return s;
    this.mark = m;
    if (this.errorIndicator) return null;
    const x = this.seq(() => {
      const mm = this.mark;
      const a = this.assignment_expression();
      if (a !== null) return a;
      this.mark = mm;
      if (this.errorIndicator) return null;
      const b = this.expression();
      if (b !== null && this.la(false, () => this.expect(":="))) return b;
      this.mark = mm;
      return null;
    });
    if (x !== null && this.la(false, () => this.expect("="))) return x;
    this.mark = m;
    return null;
  }
  args(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.gather(() => this.posArg());
      if (a !== null) {
        const b = this.opt(() => this.seq(() => (this.expect(",") !== null ? this.kwargs() : null)));
        if (this.errorIndicator) return null;
        const extra = b ?? [];
        return {
          k: "Call",
          args: [...a, ...extra.filter((x) => !x.isKeyword).map((x) => x.element)],
          keywords: extra.filter((x) => x.isKeyword).map((x) => x.element),
        };
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const kw = this.kwargs();
    if (kw !== null) {
      return {
        k: "Call",
        args: kw.filter((x) => !x.isKeyword).map((x) => x.element),
        keywords: kw.filter((x) => x.isKeyword).map((x) => x.element),
      };
    }
    this.mark = m;
    return null;
  }
  kwargs(): Node[] | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.gather(() => this.kwarg_or_starred());
      if (a !== null && this.expect(",") !== null) {
        const b = this.gather(() => this.kwarg_or_double_starred());
        if (b !== null) return [...a, ...b];
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    {
      const a = this.gather(() => this.kwarg_or_starred());
      if (a !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const a = this.gather(() => this.kwarg_or_double_starred());
    if (a !== null) return a;
    this.mark = m;
    return null;
  }
  starred_expression(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.callInvalid) {
      if (this.invalid_starred_expression_unpacking() !== null) return null;
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    if (this.expect("*") !== null) {
      const a = this.expression();
      if (a !== null) return { k: "Starred", value: a };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.callInvalid) {
      if (this.invalid_starred_expression() !== null) return null;
      this.mark = m;
    }
    return null;
  }
  invalid_starred_expression_unpacking(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("*") !== null && this.expression() !== null && this.expect("=") !== null && this.expression() !== null) {
      return this.raise("cannot assign to iterable argument unpacking");
    }
    this.mark = m;
    return null;
  }
  invalid_starred_expression(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.expect("*") !== null) return this.raise("Invalid star expression");
    this.mark = m;
    return null;
  }
  kwarg_or_starred(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.callInvalid) {
      if (this.invalid_kwarg() !== null) return null;
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    {
      const a = this.name();
      if (a !== null && this.expect("=") !== null) {
        const b = this.expression();
        if (b !== null) return { k: "kos", isKeyword: true, element: { k: "keyword", arg: a.id, value: b } };
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const s = this.starred_expression();
    if (s !== null) return { k: "kos", isKeyword: false, element: s };
    this.mark = m;
    return null;
  }
  kwarg_or_double_starred(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    if (this.callInvalid) {
      if (this.invalid_kwarg() !== null) return null;
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    {
      const a = this.name();
      if (a !== null && this.expect("=") !== null) {
        const b = this.expression();
        if (b !== null) return { k: "kos", isKeyword: true, element: { k: "keyword", arg: a.id, value: b } };
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    if (this.expect("**") !== null) {
      const a = this.expression();
      if (a !== null) return { k: "kos", isKeyword: true, element: { k: "keyword", arg: null, value: a } };
    }
    this.mark = m;
    return null;
  }
  invalid_kwarg(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.expect("True") ?? this.expect("False") ?? this.expect("None");
      if (a !== null && this.expect("=") !== null) return this.raise(`cannot assign to ${a.str}`);
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    if (this.name() !== null && this.expect("=") !== null && this.expression() !== null && this.for_if_clauses() !== null) {
      return this.raise("invalid syntax. Maybe you meant '==' or ':=' instead of '='?");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.la(false, () => this.seq(() => (this.name() !== null ? this.expect("=") : null)))) {
      if (this.expression() !== null && this.expect("=") !== null) {
        return this.raise('expression cannot contain assignment, perhaps you meant "=="?');
      }
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("**") !== null && this.expression() !== null && this.expect("=") !== null && this.expression() !== null) {
      return this.raise("cannot assign to keyword argument unpacking");
    }
    this.mark = m;
    return null;
  }
  invalid_arguments(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    // ((','.(starred_expression | (assignment_expression | expression !':=') !'=')+ ',' kwargs) | kwargs) ',' ','.(starred_expression !'=')+
    {
      const head = this.seq(() => {
        const mm = this.mark;
        const g = this.gather(() => this.posArg());
        if (g !== null && this.expect(",") !== null && this.kwargs() !== null) return {} as Node;
        this.mark = mm;
        if (this.errorIndicator) return null;
        if (this.kwargs() !== null) return {} as Node;
        this.mark = mm;
        return null;
      });
      if (head !== null && this.expect(",") !== null) {
        const g = this.gather(() => {
          const mm = this.mark;
          const s = this.starred_expression();
          if (s !== null && this.la(false, () => this.expect("="))) return s;
          this.mark = mm;
          return null;
        });
        if (g !== null) return this.raise("iterable argument unpacking follows keyword argument unpacking");
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    // expression for_if_clauses ',' [args | expression for_if_clauses]
    {
      if (this.expression() !== null && this.for_if_clauses() !== null && this.expect(",") !== null) {
        this.opt(() =>
          this.seq(() => {
            const mm = this.mark;
            const a = this.args();
            if (a !== null) return a;
            this.mark = mm;
            if (this.errorIndicator) return null;
            if (this.expression() !== null && this.for_if_clauses() !== null) return {} as Node;
            this.mark = mm;
            return null;
          }),
        );
        if (this.errorIndicator) return null;
        return this.raise("Generator expression must be parenthesized");
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    // NAME '=' expression for_if_clauses
    if (this.name() !== null && this.expect("=") !== null && this.expression() !== null && this.for_if_clauses() !== null) {
      return this.raise("invalid syntax. Maybe you meant '==' or ':=' instead of '='?");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    // (args ',')? NAME '=' &(',' | ')')
    {
      this.opt(() => this.seq(() => (this.args() !== null && this.expect(",") !== null ? ({} as Node) : null)));
      if (this.errorIndicator) return null;
      if (this.name() !== null && this.expect("=") !== null && this.la(true, () => this.expect(",") ?? this.expect(")"))) {
        return this.raise("expected argument value expression");
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    // args for_if_clauses
    {
      const a = this.args();
      if (a !== null && this.for_if_clauses() !== null) {
        if ((a.args as Node[]).length <= 1) return null;
        return this.raise("Generator expression must be parenthesized");
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    // args ',' expression for_if_clauses
    if (this.args() !== null && this.expect(",") !== null && this.expression() !== null && this.for_if_clauses() !== null) {
      return this.raise("Generator expression must be parenthesized");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    // args ',' args
    {
      const a = this.args();
      if (a !== null && this.expect(",") !== null && this.args() !== null) {
        const unpack = (a.keywords as Node[]).some((k) => k.arg === null);
        return this.raise(
          unpack ? "positional argument follows keyword argument unpacking" : "positional argument follows keyword argument",
        );
      }
    }
    this.mark = m;
    return null;
  }

  // ---- targets ---------------------------------------------------------------------

  star_targets(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.star_target();
      if (a !== null && this.la(false, () => this.expect(","))) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const a = this.star_target();
    if (a !== null) {
      const b = this.many0(() => this.seq(() => (this.expect(",") !== null ? this.star_target() : null)));
      if (this.errorIndicator) return null;
      this.opt(() => this.expect(","));
      return { k: "Tuple", elts: [a, ...b] };
    }
    this.mark = m;
    return null;
  }
  star_targets_list_seq(): Node[] | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const a = this.gather(() => this.star_target());
    if (a !== null) {
      this.opt(() => this.expect(","));
      return a;
    }
    this.mark = m;
    return null;
  }
  star_targets_tuple_seq(): Node[] | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.star_target();
      if (a !== null) {
        const b = this.many1(() => this.seq(() => (this.expect(",") !== null ? this.star_target() : null)));
        if (b !== null) {
          this.opt(() => this.expect(","));
          return [a, ...b];
        }
      }
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    const a = this.star_target();
    if (a !== null && this.expect(",") !== null) return [a];
    this.mark = m;
    return null;
  }
  star_target(): Node | null {
    return this.memoRule("star_target", () => {
      const m = this.mark;
      if (this.expect("*") !== null) {
        const a = this.seq(() => (this.la(false, () => this.expect("*")) ? this.star_target() : null));
        if (a !== null) return { k: "Starred", value: a };
      }
      this.mark = m;
      if (this.errorIndicator) return null;
      const t = this.target_with_star_atom();
      if (t !== null) return t;
      this.mark = m;
      return null;
    });
  }
  target_with_star_atom(): Node | null {
    return this.memoRule("target_with_star_atom", () => {
      const m = this.mark;
      {
        const a = this.t_primary();
        if (a !== null && this.expect(".") !== null) {
          const b = this.name();
          if (b !== null && this.la(false, () => this.t_lookahead())) return { k: "Attribute", value: a, attr: b.id };
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.t_primary();
        if (a !== null && this.expect("[") !== null) {
          const b = this.slices();
          if (b !== null && this.expect("]") !== null && this.la(false, () => this.t_lookahead())) {
            return { k: "Subscript", value: a, slice: b };
          }
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      const s = this.star_atom();
      if (s !== null) return s;
      this.mark = m;
      return null;
    });
  }
  star_atom(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    {
      const a = this.name();
      if (a !== null) return a;
      this.mark = m;
    }
    if (this.errorIndicator) return null;
    if (this.expect("(") !== null) {
      const a = this.target_with_star_atom();
      if (a !== null && this.expect(")") !== null) return a;
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("(") !== null) {
      const a = this.opt(() => this.star_targets_tuple_seq());
      if (this.errorIndicator) return null;
      if (this.expect(")") !== null) return { k: "Tuple", elts: a ?? [] };
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    if (this.expect("[") !== null) {
      const a = this.opt(() => this.star_targets_list_seq());
      if (this.errorIndicator) return null;
      if (this.expect("]") !== null) return { k: "List", elts: a ?? [] };
    }
    this.mark = m;
    return null;
  }
  t_lookahead(): Token | null {
    return this.expect("(") ?? this.expect("[") ?? this.expect(".");
  }
  t_primary(): Node | null {
    return this.leftRec("t_primary", () => {
      const m = this.mark;
      {
        const a = this.t_primary();
        if (a !== null && this.expect(".") !== null) {
          const b = this.name();
          if (b !== null && this.la(true, () => this.t_lookahead())) return { k: "Attribute", value: a, attr: b.id };
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.t_primary();
        if (a !== null && this.expect("[") !== null) {
          const b = this.slices();
          if (b !== null && this.expect("]") !== null && this.la(true, () => this.t_lookahead())) {
            return { k: "Subscript", value: a, slice: b };
          }
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.t_primary();
        if (a !== null) {
          const b = this.genexp();
          if (b !== null && this.la(true, () => this.t_lookahead())) return { k: "Call", func: a, args: [b], keywords: [] };
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.t_primary();
        if (a !== null && this.expect("(") !== null) {
          const b = this.opt(() => this.arguments());
          if (this.errorIndicator) return null;
          if (this.expect(")") !== null && this.la(true, () => this.t_lookahead())) {
            return { k: "Call", func: a, args: b ? b.args : [], keywords: b ? b.keywords : [] };
          }
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      const a = this.atom();
      if (a !== null && this.la(true, () => this.t_lookahead())) return a;
      this.mark = m;
      return null;
    });
  }

  // ---- invalid expression rules ---------------------------------------------------

  expression_without_invalid(): Node | null {
    return this.withoutInvalid(() => {
      if (this.errorIndicator) return null;
      const m = this.mark;
      {
        const a = this.disjunction();
        if (a !== null && this.expect("if") !== null) {
          const b = this.disjunction();
          if (b !== null && this.expect("else") !== null) {
            const c = this.expression();
            if (c !== null) return { k: "IfExp", test: b, body: a, orelse: c };
          }
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.disjunction();
        if (a !== null) return a;
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      const a = this.lambdef();
      if (a !== null) return a;
      this.mark = m;
      return null;
    });
  }

  invalid_expression(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    // STRING (!STRING expression_without_invalid)+ STRING
    if (this.expectType("STRING") !== null) {
      const a = this.many1(() =>
        this.seq(() => (this.la(false, () => this.expectType("STRING")) ? this.expression_without_invalid() : null)),
      );
      if (a !== null && this.expectType("STRING") !== null) {
        return this.raise("invalid syntax. Is this intended to be part of the string?");
      }
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    // !(NAME STRING | SOFT_KEYWORD) disjunction expression_without_invalid
    if (
      this.la(false, () => {
        const mm = this.mark;
        if (this.name() !== null && this.expectType("STRING") !== null) return true;
        this.mark = mm;
        if (this.errorIndicator) return null;
        const s = this.softKeyword();
        if (s !== null) return true;
        this.mark = mm;
        return null;
      })
    ) {
      const a = this.disjunction();
      if (a !== null) {
        const b = this.expression_without_invalid();
        if (b !== null) {
          if (a.k === "Name" && (a.id === "print" || a.id === "exec")) return null;
          if (this.toks[this.mark - 1].level === 0) return null;
          return this.raise("invalid syntax. Perhaps you forgot a comma?");
        }
      }
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    // disjunction 'if' disjunction !('else'|':')
    if (this.disjunction() !== null && this.expect("if") !== null && this.disjunction() !== null) {
      if (this.la(false, () => this.expect("else") ?? this.expect(":"))) {
        return this.raise("expected 'else' after 'if' expression");
      }
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    // disjunction 'if' disjunction 'else' !expression
    if (
      this.disjunction() !== null &&
      this.expect("if") !== null &&
      this.disjunction() !== null &&
      this.expect("else") !== null &&
      this.la(false, () => this.expression())
    ) {
      return this.raise("expected expression after 'else', but statement is given", true);
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    // (pass_stmt|break_stmt|continue_stmt) 'if' disjunction 'else' simple_stmt
    if (
      (this.expect("pass") ?? this.expect("break") ?? this.expect("continue")) !== null &&
      this.expect("if") !== null &&
      this.disjunction() !== null &&
      this.expect("else") !== null
    ) {
      throw new FormulaNotPortable("statement after 'pass/break/continue ... if ... else'");
    }
    this.mark = m;
    if (this.errorIndicator) return null;
    // 'lambda' [lambda_params] ':' &FSTRING_MIDDLE / &TSTRING_MIDDLE
    for (const [tt, prefix] of [["FSTRING_MIDDLE", "f"], ["TSTRING_MIDDLE", "t"]] as [TokType, string][]) {
      if (this.expect("lambda") !== null) {
        this.opt(() => this.lambda_params());
        if (this.errorIndicator) return null;
        if (this.expect(":") !== null && this.la(true, () => this.expectType(tt))) {
          return this.raise(`${prefix}-string: lambda expressions are not allowed without parentheses`);
        }
      }
      this.mark = m;
      if (this.errorIndicator) return null;
    }
    return null;
  }

  invalid_legacy_expression(): Node | null {
    if (this.errorIndicator) return null;
    const m = this.mark;
    const a = this.name();
    if (a !== null && this.la(false, () => this.expect("("))) {
      const b = this.star_expressions();
      if (b !== null) {
        if (a.id === "print" || a.id === "exec") {
          return this.raise(`Missing parentheses in call to '${a.id}'. Did you mean ${a.id}(...)?`);
        }
        return null;
      }
    }
    this.mark = m;
    return null;
  }

  invalid_named_expression(): Node | null {
    return this.memoRule("invalid_named_expression", () => {
      const m = this.mark;
      {
        const a = this.expression();
        if (a !== null && this.expect(":=") !== null && this.expression() !== null) {
          return this.raise(`cannot use assignment expressions with ${nodeName(a)}`);
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      {
        const a = this.name();
        if (a !== null && this.expect("=") !== null && this.bitwise_or() !== null) {
          if (this.la(false, () => this.expect("=") ?? this.expect(":="))) {
            return this.raise("invalid syntax. Maybe you meant '==' or ':=' instead of '='?");
          }
        }
        this.mark = m;
      }
      if (this.errorIndicator) return null;
      if (
        this.la(false, () => {
          const mm = this.mark;
          for (const fn of [() => this.list(), () => this.tuple(), () => this.genexp()]) {
            const r = fn();
            if (r !== null) return r;
            this.mark = mm;
            if (this.errorIndicator) return null;
          }
          return this.expect("True") ?? this.expect("None") ?? this.expect("False");
        })
      ) {
        const a = this.bitwise_or();
        if (a !== null && this.expect("=") !== null && this.bitwise_or() !== null) {
          if (this.la(false, () => this.expect("=") ?? this.expect(":="))) {
            return this.raise(`cannot assign to ${nodeName(a)} here. Maybe you meant '==' instead of '='?`);
          }
        }
      }
      this.mark = m;
      return null;
    });
  }
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

/** parsenumber() for a NUMBER token (the tokenizer already validated it). */
function parseNumberLiteral(text: string): PyVal {
  const s = text.split("_").join("");
  const last = s[s.length - 1];
  if (last === "j" || last === "J") return new PyComplex(0, Number(s.slice(0, -1)));
  if (/^0[xXoObB]/.test(s)) return BigInt(s.toLowerCase());
  if (/[.eE]/.test(s)) return Number(s);
  return BigInt(s.replace(/^0+(?=\d)/, ""));
}

class DecodeFailure {
  /** A SyntaxError raised directly (bytes with non-ASCII characters). */
  syntaxMsg: string | null;
  /** The SyntaxError message after `_Pypegen_raise_decode_error`. */
  decodeMsg: string;
  constructor(syntaxMsg: string | null, decodeMsg: string) {
    this.syntaxMsg = syntaxMsg;
    this.decodeMsg = decodeMsg;
  }
}

function unicodeDecodeErrorText(buf: number[], start: number, end: number, reason: string): string {
  if (end === start + 1 && start < buf.length) {
    return `'unicodeescape' codec can't decode byte 0x${hex2(buf[start])} in position ${start}: ${reason}`;
  }
  return `'unicodeescape' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`;
}

/** Characters allowed in a Unicode character name (case-insensitive lookup). */
const NAME_CHARS = /^[A-Za-z0-9 -]+$/;

/** decode_unicode_with_escapes / raw decoding of a str literal body. */
function decodeStr(body: string, raw: boolean): string | DecodeFailure {
  if (raw) return body;
  // Build the escaped ASCII buffer exactly like CPython (non-ASCII -> \UXXXXXXXX,
  // a backslash before non-ASCII or at the end -> \).
  const cps = codePoints(body);
  const buf: number[] = [];
  const push = (s: string) => {
    for (let i = 0; i < s.length; i++) buf.push(s.charCodeAt(i));
  };
  let i = 0;
  while (i < cps.length) {
    if (cps[i] === 92) {
      buf.push(92);
      i++;
      if (i >= cps.length || cps[i] >= 0x80) {
        push("u005c");
        if (i >= cps.length) break;
      }
    }
    if (cps[i] >= 0x80) {
      while (i < cps.length && cps[i] >= 0x80) {
        push("\\U" + cps[i].toString(16).padStart(8, "0"));
        i++;
      }
    } else {
      buf.push(cps[i]);
      i++;
    }
  }
  // _PyUnicode_DecodeUnicodeEscapeInternal2 (strict)
  const out: number[] = [];
  let s = 0;
  const end = buf.length;
  const fail = (start: number, endpos: number, reason: string) =>
    new DecodeFailure(null, "(unicode error) " + unicodeDecodeErrorText(buf, start, endpos, reason));
  while (s < end) {
    let c = buf[s++];
    if (c !== 92) {
      out.push(c);
      continue;
    }
    const startinpos = s - 1;
    if (s >= end) return fail(startinpos, end, "\\ at end of string");
    c = buf[s++];
    switch (c) {
      case 10:
        continue;
      case 92: out.push(92); continue;
      case 39: out.push(39); continue;
      case 34: out.push(34); continue;
      case 98: out.push(8); continue;
      case 102: out.push(12); continue;
      case 116: out.push(9); continue;
      case 110: out.push(10); continue;
      case 114: out.push(13); continue;
      case 118: out.push(11); continue;
      case 97: out.push(7); continue;
      case 48: case 49: case 50: case 51: case 52: case 53: case 54: case 55: {
        let ch = c - 48;
        if (s < end && buf[s] >= 48 && buf[s] <= 55) {
          ch = (ch << 3) + buf[s++] - 48;
          if (s < end && buf[s] >= 48 && buf[s] <= 55) ch = (ch << 3) + buf[s++] - 48;
        }
        out.push(ch);
        continue;
      }
      case 120:
      case 117:
      case 85: {
        let count = c === 120 ? 2 : c === 117 ? 4 : 8;
        const message = c === 120 ? "truncated \\xXX escape" : c === 117 ? "truncated \\uXXXX escape" : "truncated \\UXXXXXXXX escape";
        let ch = 0;
        for (; count; ++s, --count) {
          if (s >= end) return fail(startinpos, s, message);
          const d = buf[s];
          ch *= 16;
          if (d >= 48 && d <= 57) ch += d - 48;
          else if (d >= 97 && d <= 102) ch += d - 87;
          else if (d >= 65 && d <= 70) ch += d - 55;
          else return fail(startinpos, s, message);
        }
        if (ch > 0x10ffff) return fail(startinpos, s, "illegal Unicode character");
        out.push(ch);
        continue;
      }
      case 78: {
        const message = "malformed \\N character escape";
        if (s >= end) return fail(startinpos, s, message);
        if (buf[s] === 123) {
          const nameStart = ++s;
          while (s < end && buf[s] !== 125) s++;
          if (s >= end) return fail(startinpos, s, message);
          const namelen = s - nameStart;
          if (namelen) {
            s++;
            const name = String.fromCharCode(...buf.slice(nameStart, nameStart + namelen));
            if (NAME_CHARS.test(name)) throw new FormulaNotPortable(`\\N{${name}}`);
            return fail(startinpos, s, "unknown Unicode character name");
          }
        }
        return fail(startinpos, s, message);
      }
      default:
        // invalid escape: a SyntaxWarning only; the backslash is kept
        out.push(92, c);
        continue;
    }
  }
  return fromCodePoints(out);
}

/** _PyBytes_DecodeEscape2 (strict) on the literal body. */
function decodeBytes(body: number[]): PyBytes | DecodeFailure {
  const out: number[] = [];
  let s = 0;
  const end = body.length;
  while (s < end) {
    if (body[s] !== 92) {
      out.push(body[s++]);
      continue;
    }
    s++;
    if (s === end) return new DecodeFailure(null, "(value error) Trailing \\ in string");
    const c = body[s++];
    switch (c) {
      case 10: break;
      case 92: out.push(92); break;
      case 39: out.push(39); break;
      case 34: out.push(34); break;
      case 98: out.push(8); break;
      case 102: out.push(12); break;
      case 116: out.push(9); break;
      case 110: out.push(10); break;
      case 114: out.push(13); break;
      case 118: out.push(11); break;
      case 97: out.push(7); break;
      case 48: case 49: case 50: case 51: case 52: case 53: case 54: case 55: {
        let v = c - 48;
        if (s < end && body[s] >= 48 && body[s] <= 55) {
          v = (v << 3) + body[s++] - 48;
          if (s < end && body[s] >= 48 && body[s] <= 55) v = (v << 3) + body[s++] - 48;
        }
        out.push(v & 0xff);
        break;
      }
      case 120: {
        if (s + 1 < end && isXDigit(body[s]) && isXDigit(body[s + 1])) {
          out.push(parseInt(String.fromCharCode(body[s], body[s + 1]), 16));
          s += 2;
          break;
        }
        return new DecodeFailure(null, `(value error) invalid \\x escape at position ${s - 2}`);
      }
      default:
        out.push(92);
        s--;
    }
  }
  return new PyBytes(out);
}

/** _PyPegen_parse_string for a STRING token. */
function parseStringToken(tok: string): PyVal | DecodeFailure {
  const cps = codePoints(tok);
  let i = 0;
  let bytesmode = false;
  let rawmode = false;
  for (;;) {
    const q = cps[i];
    if (q === 98 || q === 66) bytesmode = true;
    else if (q === 117 || q === 85) {
      /* u prefix */
    } else if (q === 114 || q === 82) rawmode = true;
    else break;
    i++;
  }
  const quote = cps[i];
  let body = cps.slice(i + 1, cps.length - 1);
  if (body.length >= 4 && body[0] === quote && body[1] === quote) body = body.slice(2, body.length - 2);
  rawmode = rawmode || !body.includes(92);
  if (bytesmode) {
    if (body.some((c) => c >= 0x80)) return new DecodeFailure("bytes can only contain ASCII literal characters", "");
    if (rawmode) return new PyBytes(body);
    return decodeBytes(body);
  }
  return decodeStr(fromCodePoints(body), rawmode);
}

// ---------------------------------------------------------------------------
// ast.parse(source, mode="eval")
// ---------------------------------------------------------------------------

/** str() of the UnicodeEncodeError that encoding `s` to UTF-8 raises (the
 * first run of lone surrogates, positions in code points). */
function utf8SurrogateError(s: string): string {
  const cps = codePoints(s);
  const isSur = (c: number) => c >= 0xd800 && c <= 0xdfff;
  const start = cps.findIndex(isSur);
  let end = start + 1;
  while (end < cps.length && isSur(cps[end])) end++;
  const reason = "surrogates not allowed";
  if (end === start + 1) {
    return `'utf-8' codec can't encode character '\\u${cps[start].toString(16).padStart(4, "0")}' in position ${start}: ${reason}`;
  }
  return `'utf-8' codec can't encode characters in position ${start}-${end - 1}: ${reason}`;
}

type ParseResult = { ok: true; tree: Node } | { ok: false; error: ParseError };

function astParse(source: string): ParseResult {
  if (hasLoneSurrogate(source)) {
    return { ok: false, error: { kind: "other", msg: utf8SurrogateError(source), pyType: "UnicodeEncodeError" } };
  }
  if (source.includes("\0")) {
    return {
      ok: false,
      error: { kind: "syntax", msg: "source code string cannot contain null bytes", pyType: "SyntaxError" },
    };
  }
  // translate_newlines: \r\n and \r -> \n
  const src = codePoints(source.replace(/\r\n?/g, "\n"));
  // Deep bracket nesting is refused instead of parsed: CPython's parser
  // stops with MemoryError ("Parser stack overflowed") at a recursion depth of
  // 6000, which depends on the exact call structure of its generated code
  // (measured on the server: never below 160 nested brackets), and this
  // recursive-descent port needs about 9 KB of JS stack per bracket level
  // before the JIT has warmed up. 31 levels stay far below both limits; real
  // formulas nest a handful.
  if (maxBracketDepth(src) >= MAX_PORTABLE_NESTING) {
    throw new FormulaNotPortable(`more than ${MAX_PORTABLE_NESTING - 1} nested brackets`);
  }
  const lx = new Lexer(src);
  const p = new Parser(lx);
  const res = p.evalRule();
  if (res !== null && p.error === null) return { ok: true, tree: res };
  if (p.error !== null && p.error.kind === "other") return { ok: false, error: p.error };
  // second pass with the invalid_* rules
  const lastToken = p.toks[p.toks.length - 1];
  for (let i = 0; i < p.memo.length; i++) p.memo[i] = new Map();
  p.mark = 0;
  p.callInvalid = true;
  p.evalRule();
  if (p.error !== null && p.error.kind === "other") return { ok: false, error: p.error };
  setSyntaxError(p, lastToken);
  return { ok: false, error: p.error ?? { kind: "syntax", msg: "invalid syntax", pyType: "SyntaxError" } };
}

const MAX_PORTABLE_NESTING = 32;

/** Deepest bracket nesting the tokenizer reaches (up to its first error). */
function maxBracketDepth(src: number[]): number {
  const lx = new Lexer(src);
  let max = 0;
  for (let i = 0; i < 4 * src.length + 16; i++) {
    const t = lx.get();
    if (lx.level > max) max = lx.level;
    if (t.type === "ERRORTOKEN" || t.type === "ENDMARKER") break;
  }
  return max;
}

/** _Pypegen_set_syntax_error */
function setSyntaxError(p: Parser, lastToken: Token): void {
  if (p.error !== null) {
    // Only a tokenizer that has not finished (E_OK/E_DONE; not E_EOF or an
    // error) is run to the end to look for a tokenizer error that wins.
    if (p.lx.done === "OK" || p.lx.done === "DONE") tokenizeRestForErrors(p);
    return;
  }
  if (lastToken.type === "ERRORTOKEN" && p.lx.done === "EOF") {
    if (p.lx.level) p.unclosedParen();
    else p.raise("unexpected EOF while parsing");
    return;
  }
  if (lastToken.type === "INDENT" || lastToken.type === "DEDENT") {
    p.setError("syntax", lastToken.type === "INDENT" ? "unexpected indent" : "unexpected unindent", "IndentationError");
    return;
  }
  p.setError("syntax", "invalid syntax", "SyntaxError");
  tokenizeRestForErrors(p);
}

/** _PyPegen_tokenize_full_source_to_check_for_errors */
function tokenizeRestForErrors(p: Parser): void {
  const saved = p.error;
  const currentErrLine = p.toks[p.toks.length - 1].lineno;
  p.lx.err = null;
  let replaced: ParseError | null = null;
  for (;;) {
    const t = p.lx.get();
    if (t.type === "ERRORTOKEN") {
      if (p.lx.err !== null) {
        replaced = { kind: "syntax", msg: p.lx.err, pyType: "SyntaxError" };
        break;
      }
      if (p.lx.level !== 0) {
        const errorLineno = p.lx.parenlinenostack[p.lx.level - 1];
        if (currentErrLine > errorLineno) {
          const c = p.lx.parenstack[p.lx.level - 1];
          replaced = { kind: "syntax", msg: `'${chr(c)}' was never closed`, pyType: "SyntaxError" };
        }
      }
      break;
    }
    if (t.type === "ENDMARKER") break;
  }
  if (replaced !== null && p.lx.modes.length <= 1) p.error = replaced;
  else p.error = saved;
}

// ---------------------------------------------------------------------------
// kb_formula: validation
// ---------------------------------------------------------------------------

const FUNCTION_NAMES = new Set([
  "prop", "rollup", "num", "iif", "round", "abs", "min", "max", "len",
  "concat", "contains", "empty", "today", "days_between", "days_until",
]);
const ALLOWED = new Set([
  "Expression", "Constant", "Name", "Load", "BinOp", "UnaryOp", "BoolOp", "Compare", "Call", "IfExp",
  "Add", "Sub", "Mult", "Div", "FloorDiv", "Mod", "Pow", "USub", "UAdd", "Not", "And", "Or",
  "Eq", "NotEq", "Lt", "LtE", "Gt", "GtE",
]);

function childNodes(n: Node): Node[] {
  const op = (o: string): Node => ({ k: o });
  switch (n.k) {
    case "Expression": return [n.body];
    case "Name": return [{ k: "Load" }];
    case "BinOp": return [n.left, op(n.op), n.right];
    case "UnaryOp": return [op(n.op), n.operand];
    case "BoolOp": return [op(n.op), ...n.values];
    case "Compare": return [n.left, ...n.ops.map(op), ...n.comparators];
    case "Call": return [n.func, ...n.args, ...n.keywords];
    case "IfExp": return [n.test, n.body, n.orelse];
    default: return [];
  }
}

/** Only values a cell can show: None, bool, int, float, str. */
function checkConstant(v: PyVal): void {
  if (v === null || typeof v === "boolean" || typeof v === "bigint" || typeof v === "number" || typeof v === "string") return;
  const what = v instanceof PyBytes ? "bytes" : v instanceof PyComplex ? "complex" : v instanceof PyEllipsis ? "ellipsis" : "object";
  throw new FormulaError("formula.notAllowed", { what });
}

/** kb_formula._check */
function check(tree: Node): void {
  let count = 0;
  const walk = (node: Node, depth: number): void => {
    count += 1;
    if (count > MAX_NODES) throw new FormulaError("formula.tooComplex");
    if (depth > MAX_DEPTH) throw new FormulaError("formula.tooDeep");
    const kind = node.k;
    if (!ALLOWED.has(kind)) throw new FormulaError("formula.notAllowed", { what: kind });
    if (kind === "Constant") checkConstant(node.value);
    if (kind === "Call") {
      if (node.func.k !== "Name") throw new FormulaError("formula.simpleCalls");
      if (!FUNCTION_NAMES.has(node.func.id)) throw new FormulaError("formula.unknownFn", { name: node.func.id });
      if (node.keywords.length) throw new FormulaError("formula.noKeywords");
    }
    for (const child of childNodes(node)) walk(child, depth + 1);
  };
  walk(tree, 0);
}

/** Python's str.splitlines(keepends=True): start offsets (code points) of
 * the lines, plus the end. */
function splitlineStarts(cps: number[]): number[] {
  const starts = [0];
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === 13 && cps[i + 1] === 10) {
      i++;
      starts.push(i + 1);
    } else if (c === 10 || c === 13 || c === 11 || c === 12 || (c >= 0x1c && c <= 0x1e) || c === 0x85 || c === 0x2028 || c === 0x2029) {
      starts.push(i + 1);
    }
  }
  if (starts[starts.length - 1] !== cps.length) starts.push(cps.length);
  return starts;
}

/** kb_formula._preprocess: `if` -> `iif` for every NAME token `if` that the
 * `tokenize` module reports directly before an OP `(` (comments, NL,
 * NEWLINE, INDENT, DEDENT and ENDMARKER skipped). If tokenize fails anywhere
 * the source is returned unchanged. Offsets are computed like the server
 * does: tokenize rows (lines end at "\n") mapped through str.splitlines(). */
function preprocess(expression: string): string {
  const src = expression;
  // tokenize fails on lone surrogates (UnicodeEncodeError) and NUL bytes
  if (src === "" || hasLoneSurrogate(src) || src.includes("\0")) return src;
  const cps = codePoints(src);
  // readline input: the last line gets an implicit "\n"
  const lx = new Lexer(cps[cps.length - 1] === 10 ? cps : [...cps, 10], true);
  const toks: Token[] = [];
  for (let guard = 0; guard < 4 * cps.length + 16; guard++) {
    const t = lx.get();
    if (t.type === "ERRORTOKEN") return src;
    if (t.type === "ENDMARKER") break;
    if (t.type !== "NEWLINE" && t.type !== "INDENT" && t.type !== "DEDENT") toks.push(t);
  }
  const starts = splitlineStarts(cps);
  const offsets: number[] = [];
  for (let i = 0; i + 1 < toks.length; i++) {
    const t = toks[i];
    const nxt = toks[i + 1];
    if (t.type === "NAME" && t.str === "if" && nxt.type === "OP" && nxt.str === "(") {
      offsets.push(starts[t.lineno - 1] + t.col);
    }
  }
  let out = cps;
  for (let k = offsets.length - 1; k >= 0; k--) {
    const off = offsets[k];
    out = [...out.slice(0, off), 105, 105, 102, ...out.slice(off + 2)];
  }
  return offsets.length ? fromCodePoints(out) : src;
}

const VALUE_ERRORS = new Set(["ValueError", "UnicodeEncodeError", "UnicodeDecodeError"]);

function parseOrThrow(expression: string): Node {
  let r: ParseResult;
  try {
    r = astParse(preprocess(expression));
  } catch (e) {
    if (e instanceof RangeError) throw new FormulaNotPortable("expression too complex for this device's stack");
    throw e;
  }
  if (r.ok) return r.tree;
  // validate(): SyntaxError and (since the server fix) ValueError,
  // MemoryError and RecursionError from ast.parse are syntax errors
  if (r.error.kind === "syntax" || VALUE_ERRORS.has(r.error.pyType)) {
    throw new FormulaError("formula.syntax", { msg: r.error.msg || r.error.pyType });
  }
  throw new PyError(r.error.pyType, r.error.msg);
}

/** kb_formula.validate: check syntax and safety without evaluating. Throws
 * FormulaError like the server; any other exception (the server would answer
 * 500 there) is thrown as a plain Error. */
export function validate(expression: string): void {
  validateValue(expression);
}

function validateValue(expression: unknown): Node {
  if (!truthy(fromJson(expression))) throw new FormulaError("formula.empty");
  if (typeof expression !== "string") throw new PyError("AttributeError", "strip");
  if (!pyStrip(expression)) throw new FormulaError("formula.empty");
  if (pyLen(expression) > MAX_LEN) throw new FormulaError("formula.tooLong", { max: String(MAX_LEN) });
  const tree = parseOrThrow(expression);
  check(tree);
  return tree;
}

// ---------------------------------------------------------------------------
// kb_formula: evaluation
// ---------------------------------------------------------------------------

let todayProvider: (() => string) | null = null;

/** Replace the clock used by today()/days_until(); null restores the default.
 * The default is the current UTC date: the server evaluates
 * `date.today()` in its container, which runs in UTC, so between local
 * midnight and the UTC date change the server's "today" is yesterday's date
 * for users east of Greenwich — reproduced here on purpose. */
export function setTodayProvider(fn: (() => string) | null): void {
  todayProvider = fn;
}
function todayIso(): string {
  if (todayProvider) return todayProvider();
  const d = new Date();
  return (
    String(d.getUTCFullYear()).padStart(4, "0") +
    "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

/** Days since 0001-01-01 (proleptic Gregorian), like date.toordinal(). */
function ordinal(y: number, m: number, d: number): number {
  const before = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const yy = y - 1;
  return yy * 365 + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + before[m] + (m > 2 && leap ? 1 : 0) + d;
}
function daysInMonth(y: number, m: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m];
}
/** kb_formula._date: ordinal or null */
function pyDate(v: PyVal): number | null {
  if (!truthy(v)) return null;
  const cps = codePoints(pyStr(v));
  const digitsAt = (from: number, n: number): number | null => {
    let val = 0;
    for (let i = 0; i < n; i++) {
      if (from + i >= cps.length) return null;
      const d = decimalValue(cps[from + i]);
      if (d < 0) return null;
      val = val * 10 + d;
    }
    return val;
  };
  const y = digitsAt(0, 4);
  if (y === null || cps[4] !== 45) return null;
  const mo = digitsAt(5, 2);
  if (mo === null || cps[7] !== 45) return null;
  const d = digitsAt(8, 2);
  if (d === null) return null;
  if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return ordinal(y, mo, d);
}
function daysBetween(a: PyVal, b: PyVal): bigint {
  const da = pyDate(a);
  const db = pyDate(b);
  if (da === null || db === null) return 0n;
  return BigInt(db - da);
}

/** Python round(float, ndigits) via exact decimal rounding (half-even). */
function pyRound(x: number, ndigitsF: number): number {
  // int(_num(n))
  if (Number.isNaN(ndigitsF)) throw new PyError("ValueError", "cannot convert float NaN to integer");
  if (!Number.isFinite(ndigitsF)) throw new PyError("OverflowError", "cannot convert float infinity to integer");
  const nd = Math.trunc(ndigitsF);
  if (!Number.isFinite(x)) return x;
  if (nd > 323) return x;
  if (nd < -308) return 0.0 * x;
  if (x === 0) return x;
  // x = mant * 2^exp exactly
  const neg = x < 0;
  const ax = Math.abs(x);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, ax);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const bexp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2: number;
  if (bexp === 0) e2 = -1074;
  else {
    mant |= 1n << 52n;
    e2 = bexp - 1075;
  }
  let num = mant;
  let den = 1n;
  if (e2 >= 0) num <<= BigInt(e2);
  else den <<= BigInt(-e2);
  if (nd >= 0) num *= 10n ** BigInt(nd);
  else den *= 10n ** BigInt(-nd);
  let q = num / den;
  const r = num - q * den;
  const twice = 2n * r;
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  const out = Number(`${neg ? "-" : ""}${q}e${-nd}`);
  if (!Number.isFinite(out)) throw new PyError("OverflowError", "rounded value too large to represent");
  return out;
}

/** float // float (CPython _float_div_mod); y != 0. C truthiness: NaN is
 * true, so tests are written as `!== 0`. */
function floorDiv(vx: number, wx: number): number {
  let mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod !== 0) {
    if (wx < 0 !== mod < 0) {
      mod += wx;
      div -= 1.0;
    }
  }
  let floordiv: number;
  if (div !== 0) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
  } else {
    floordiv = Math.sign(vx / wx) < 0 || Object.is(vx / wx, -0) ? -0 : 0;
  }
  return floordiv;
}
/** float % float (CPython float_rem); y != 0 */
function floatMod(vx: number, wx: number): number {
  let mod = vx % wx;
  if (mod !== 0) {
    if (wx < 0 !== mod < 0) mod += wx;
  } else {
    mod = wx < 0 || Object.is(wx, -0) ? -0 : 0;
  }
  return mod;
}

type Fn = (args: PyVal[]) => PyVal;

function arity(args: PyVal[], min: number, max: number): void {
  if (args.length < min || args.length > max) throw new PyError("TypeError", "wrong number of arguments");
}
function dictGet(d: PyDict, key: string): PyVal | undefined {
  for (const [k, v] of d.entries) if (k === key) return v;
  return undefined;
}

function buildFunctions(props: PyDict, rollups: PyDict): Record<string, Fn> {
  return {
    prop: (a) => {
      arity(a, 1, 1);
      const v = dictGet(props, pyStr(a[0]));
      return v === undefined ? "" : v;
    },
    rollup: (a) => {
      arity(a, 1, 1);
      const v = dictGet(rollups, pyStr(a[0]));
      return v === undefined ? 0n : v;
    },
    num: (a) => {
      arity(a, 1, 1);
      return num(a[0]);
    },
    iif: (a) => {
      arity(a, 3, 3);
      return truthy(a[0]) ? a[1] : a[2];
    },
    round: (a) => {
      arity(a, 1, 2);
      const x = num(a[0]);
      const n = num(a.length > 1 ? a[1] : 0n);
      return pyRound(x, n);
    },
    abs: (a) => {
      arity(a, 1, 1);
      return Math.abs(num(a[0]));
    },
    min: (a) => minMax(a, true),
    max: (a) => minMax(a, false),
    len: (a) => {
      arity(a, 1, 1);
      return BigInt(pyLen(pyStr(truthy(a[0]) ? a[0] : "")));
    },
    concat: (a) => pySliceStart(a.map((x) => pyStr(x !== null ? x : "")).join(""), MAX_STR),
    contains: (a) => {
      arity(a, 2, 2);
      return pyContains(pyStr(truthy(a[0]) ? a[0] : "").toLowerCase(), pyStr(a[1]).toLowerCase());
    },
    empty: (a) => {
      arity(a, 1, 1);
      const x = a[0];
      return (
        x === null ||
        x === "" ||
        (Array.isArray(x) && x.length === 0) ||
        (x instanceof PyDict && x.entries.length === 0)
      );
    },
    today: (a) => {
      arity(a, 0, 0);
      return todayIso();
    },
    days_between: (a) => {
      arity(a, 2, 2);
      return daysBetween(a[0], a[1]);
    },
    days_until: (a) => {
      arity(a, 1, 1);
      return daysBetween(todayIso(), a[0]);
    },
  };
}
function minMax(xs: PyVal[], isMin: boolean): PyVal {
  if (!xs.length) return 0n;
  let best = num(xs[0]);
  for (let i = 1; i < xs.length; i++) {
    const v = num(xs[i]);
    if (isMin ? v < best : v > best) best = v;
  }
  return best;
}

const NAME_CONSTANTS: Record<string, PyVal> = {
  true: true, false: false, null: null, True: true, False: false, None: null,
};

function evalNode(node: Node, funcs: Record<string, Fn>): PyVal {
  switch (node.k) {
    case "Expression":
      return evalNode(node.body, funcs);
    case "Constant": {
      const v = node.value as PyVal;
      checkConstant(v);
      if (typeof v === "string" && pyLen(v) > MAX_STR) throw new FormulaError("formula.textTooLong");
      return v;
    }
    case "Name":
      return Object.prototype.hasOwnProperty.call(NAME_CONSTANTS, node.id) ? NAME_CONSTANTS[node.id] : node.id;
    case "UnaryOp": {
      const v = evalNode(node.operand, funcs);
      if (node.op === "Not") return !truthy(v);
      return node.op === "USub" ? -num(v) : num(v);
    }
    case "BoolOp": {
      const vals = (node.values as Node[]).map((v) => evalNode(v, funcs));
      return node.op === "And" ? vals.every(truthy) : vals.some(truthy);
    }
    case "IfExp":
      return truthy(evalNode(node.test, funcs)) ? evalNode(node.body, funcs) : evalNode(node.orelse, funcs);
    case "BinOp": {
      const a = evalNode(node.left, funcs);
      const b = evalNode(node.right, funcs);
      if (node.op === "Add" && (typeof a === "string" || typeof b === "string")) {
        const out = pyStr(a) + pyStr(b);
        if (pyLen(out) > MAX_STR) throw new FormulaError("formula.resultTooLong");
        return out;
      }
      if (node.op === "Mult" && !(numeric(a) && numeric(b))) throw new FormulaError("formula.textMultiply");
      const x = num(a);
      const y = num(b);
      switch (node.op) {
        case "Add": return x + y;
        case "Sub": return x - y;
        case "Mult": return x * y;
        case "Div":
        case "FloorDiv":
          if (y === 0) return 0n;
          return node.op === "Div" ? x / y : floorDiv(x, y);
        case "Mod":
          return y !== 0 ? floatMod(x, y) : 0n; // Python: NaN is truthy
        case "Pow": {
          if (Math.abs(y) > 32 || Math.abs(x) > 1000) throw new FormulaError("formula.powerTooBig");
          const r = pyFloatPow(x, y, powVariantFma);
          if (r.kind === "error") throw new PyError(r.exc);
          if (r.kind === "complex") throw new FormulaError("formula.notEvaluable");
          if (Math.abs(r.v) > MAX_POW) throw new FormulaError("formula.resultTooBig");
          return r.v;
        }
      }
      throw new FormulaError("formula.notEvaluable");
    }
    case "Compare": {
      let left = evalNode(node.left, funcs);
      for (let i = 0; i < node.ops.length; i++) {
        const op = node.ops[i] as string;
        const right = evalNode(node.comparators[i], funcs);
        let ok: boolean;
        if (op === "Eq" || op === "NotEq") {
          // numbers compare as numbers, everything else by its text
          const a = asNumber(left);
          const b = asNumber(right);
          const same = a !== null && b !== null ? a === b : pyStr(left) === pyStr(right);
          ok = op === "Eq" ? same : !same;
        } else {
          const a = num(left);
          const b = num(right);
          ok = op === "Lt" ? a < b : op === "LtE" ? a <= b : op === "Gt" ? a > b : a >= b;
        }
        if (!ok) return false;
        left = right;
      }
      return true;
    }
    case "Call": {
      const fn = funcs[node.func.id];
      if (fn === undefined) throw new FormulaError("formula.unknownFn", { name: node.func.id });
      return fn((node.args as Node[]).map((a) => evalNode(a, funcs)));
    }
    default:
      throw new FormulaError("formula.notEvaluable");
  }
}

/** The pow() variant of the server's CPU: glibc picks its FMA build on CPUs
 * with FMA and AVX2 (every current x86-64 server). */
let powVariantFma = true;
/** Select the glibc pow() variant to reproduce (tests against a server
 * without FMA use false). */
export function setPowVariant(fma: boolean): void {
  powVariantFma = fma;
}

/** kb_formula.evaluate before response encoding: the Python value. */
function evaluatePy(expression: unknown, props: unknown, rollups: unknown, lang: string): PyVal {
  try {
    validateValue(expression);
    const tree = parseOrThrow(expression as string);
    const p = fromJson(props);
    const r = fromJson(rollups);
    const funcs = buildFunctions(
      p instanceof PyDict && truthy(p) ? p : new PyDict([]),
      r instanceof PyDict && truthy(r) ? r : new PyDict([]),
    );
    let val = evalNode(tree, funcs);
    if (typeof val === "number" && !Number.isFinite(val)) throw new FormulaError("formula.notEvaluable");
    if (typeof val === "number" && Number.isInteger(val)) val = BigInt(val);
    if (typeof val === "string" && pyLen(val) > MAX_STR) val = pySliceStart(val, MAX_STR);
    // json.dumps(val, allow_nan=False, ensure_ascii=False).encode("utf-8")
    if (!jsonSendable(val)) throw new PyError("ValueError", "not serialisable");
    return val;
  } catch (e) {
    if (e instanceof FormulaNotPortable) throw e;
    if (e instanceof FormulaError) return "⚠ " + errorText(e, lang);
    return "⚠ " + catalogText(lang, "formula.broken", {});
  }
}

/** Can json.dumps(allow_nan=False) encode the value and can the result be
 * encoded as UTF-8? */
function jsonSendable(v: PyVal): boolean {
  if (v === null || typeof v === "boolean" || typeof v === "bigint") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return !hasLoneSurrogate(v);
  if (Array.isArray(v)) return v.every(jsonSendable);
  if (v instanceof PyDict) return v.entries.every(([k, x]) => !hasLoneSurrogate(k) && jsonSendable(x));
  return false;
}

/** The client-side JSON value of a result that passed jsonSendable. */
function toClient(v: PyVal): unknown {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(toClient);
  if (v instanceof PyDict) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of v.entries) o[k] = toClient(x);
    return o;
  }
  return v;
}

/**
 * Evaluate a formula for one row, exactly like the server's
 * `kb_formula.evaluate(expression, properties, rollups, lang)` followed by
 * the JSON response encoding: the returned value is what the client would
 * receive (number, string, boolean, null, or a JSON array/object for a raw
 * property value). Errors in the formula are returned as "⚠ ..." text like on
 * the server. Throws FormulaNotPortable for input this port cannot decide.
 */
export function evaluate(
  expression: string,
  props: Record<string, unknown>,
  rollups: Record<string, unknown>,
  lang: string,
): unknown {
  return toClient(evaluatePy(expression, props, rollups, lang));
}

/** Test hook: the Python-level result of evaluate, tagged like the Python
 * side of the differential test (int/float/str/bytes/complex distinguished). */
export function evaluateTagged(expression: string, props: unknown, rollups: unknown, lang: string): unknown {
  return tag(evaluatePy(expression, props, rollups, lang));
}
/** Test hook: outcome of validate() in the shape of the Python oracle. */
export function validateTagged(expression: string): unknown {
  try {
    validateValue(expression);
    return "ok";
  } catch (e) {
    if (e instanceof FormulaError) {
      return { key: e.key, werte: e.args, de: errorText(e, "de"), en: errorText(e, "en") };
    }
    if (e instanceof PyError) return { exc: e.pyType };
    throw e;
  }
}
function floatHex(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x < 0 ? "-inf" : "inf";
  const neg = x < 0 || Object.is(x, -0);
  if (x === 0) return neg ? "-0x0.0p+0" : "0x0.0p+0";
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x));
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const bexp = (hi >>> 20) & 0x7ff;
  const mant = ((BigInt(hi & 0xfffff) << 32n) | BigInt(lo)).toString(16).padStart(13, "0");
  const lead = bexp === 0 ? "0" : "1";
  const e = bexp === 0 ? -1022 : bexp - 1023;
  return `${neg ? "-" : ""}0x${lead}.${mant}p${e >= 0 ? "+" : ""}${e}`;
}
function tag(v: PyVal): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "bigint") return { int: v.toString() };
  if (typeof v === "number") return { float: floatRepr(v), hex: floatHex(v) };
  if (typeof v === "string") return hasLoneSurrogate(v) ? { str: codePoints(v) } : v;
  if (v instanceof PyBytes) return { bytes: v.bytes.map(hex2).join("") };
  if (v instanceof PyComplex) return { complex: [floatHex(v.re), floatHex(v.im)] };
  if (v instanceof PyEllipsis) return { ellipsis: true };
  if (Array.isArray(v)) return { list: v.map(tag) };
  return { dict: (v as PyDict).entries.map(([k, x]) => [k, tag(x)]) };
}

// ---------------------------------------------------------------------------
// Exponentiation
// ---------------------------------------------------------------------------

// Bit-exact reproduction of CPython 3.14 `float ** float` on x86_64 Linux
// (glibc 2.41 libm). V8's Math.pow differs from glibc's pow in the last bit
// for a noticeable share of inputs, so glibc's algorithm is ported here.
//
// glibc selects one of two pow implementations at load time:
//   fma = true : __ieee754_pow_fma  (CPUs with FMA + AVX2)
//   fma = false: __ieee754_pow_sse2 (generic code, no fused multiply-add)
// They differ in rare last-bit cases, so the caller picks the variant that
// matches the server it mirrors.

type PowResult =
  | { kind: "float"; v: number }
  | { kind: "complex" }
  | { kind: "error"; exc: "ZeroDivisionError" | "OverflowError" | "ValueError" };

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);
const M64 = (1n << 64n) - 1n;

function asuint64(x: number): bigint {
  F64[0] = x;
  return U64[0];
}
function asdouble(i: bigint): number {
  U64[0] = BigInt.asUintN(64, i);
  return F64[0];
}
function top12(x: number): number {
  return Number(asuint64(x) >> 52n);
}

// 2^n as a double, exact for -1074 <= n <= 1023.
function pow2(n: number): number {
  if (n > 1023) return Infinity;
  if (n >= -1022) return asdouble(BigInt(n + 1023) << 52n);
  if (n >= -1074) return asdouble(1n << BigInt(n + 1074));
  return 0;
}

// Split a finite double into an integer mantissa and a binary exponent.
function decompose(x: number): [bigint, number] {
  const b = asuint64(x);
  const neg = b >> 63n === 1n;
  const e = Number((b >> 52n) & 0x7ffn);
  let m = b & 0xfffffffffffffn;
  let ex: number;
  if (e === 0) ex = -1074;
  else {
    m |= 1n << 52n;
    ex = e - 1075;
  }
  return [neg ? -m : m, ex];
}

// Round m * 2^e to the nearest double (ties to even), with subnormals and
// overflow handled as in IEEE 754 binary64.
function roundExact(m: bigint, e: number): number {
  const neg = m < 0n;
  let a = neg ? -m : m;
  const bitlen = a.toString(2).length;
  const top = e + bitlen - 1;
  const shift = top >= -1022 ? bitlen - 53 : -1074 - e;
  let ex = e;
  if (shift > 0) {
    const s = BigInt(shift);
    let q = a >> s;
    const rem = a - (q << s);
    const half = 1n << (s - 1n);
    if (rem > half || (rem === half && (q & 1n) === 1n)) q += 1n;
    a = q;
    ex = e + shift;
  }
  // a has at most 54 bits here (53 + a possible carry), so Number(a) is exact.
  let v = Number(a);
  if (ex > 900) v = v * pow2(900) * pow2(ex - 900);
  else if (ex < -900) v = v * pow2(ex + 900) * pow2(-900);
  else v = v * pow2(ex);
  return neg ? -v : v;
}

// Correctly rounded fused multiply-add a*b + c.
function fma(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return a * b + c;
  if (a === 0 || b === 0) return a * b + c; // exact product, IEEE zero-sign rules
  const [ma, ea] = decompose(a);
  const [mb, eb] = decompose(b);
  const mp = ma * mb;
  const ep = ea + eb;
  if (c === 0) return roundExact(mp, ep);
  const [mc, ec] = decompose(c);
  const e = Math.min(ep, ec);
  const s = (mp << BigInt(ep - e)) + (mc << BigInt(ec - e));
  if (s === 0n) return 0; // exact cancellation is +0 in round-to-nearest
  return roundExact(s, e);
}

// glibc tables (e_pow_log_data.c: invc, logc, logctail; e_exp_data.c: tab)
const POW_LOG_TAB = new Float64Array([
1.4140625,-0.3464667673462145,5.929407345889625e-15,
1.40625,-0.34092658697056777,-2.544157440035963e-14,
1.3984375,-0.3353555419211034,-3.443525940775045e-14,
1.390625,-0.3297532863724655,-2.500123826022799e-15,
1.3828125,-0.32411946865420305,-8.929337133850617e-15,
1.375,-0.31845373111855224,1.7625431312172662e-14,
1.3671875,-0.31275571000389846,1.5688303180062087e-15,
1.359375,-0.3070250352949415,2.9655274673691784e-14,
1.3515625,-0.3012613305781997,3.7923164802093147e-14,
1.34375,-0.2954642128938758,3.993416384387844e-14,
1.3359375,-0.28963329258306203,1.9352855826489123e-14,
1.3359375,-0.28963329258306203,1.9352855826489123e-14,
1.328125,-0.28376817313062475,-1.9852665484979036e-14,
1.3203125,-0.27786845100342816,-2.814323765595281e-14,
1.3125,-0.2719337154836694,2.7643769993528702e-14,
1.3046875,-0.2659635484970977,-4.025092402293806e-14,
1.296875,-0.25995752443691345,-1.2621729398885316e-14,
1.2890625,-0.25391520998095984,-3.600176732637335e-15,
1.2890625,-0.25391520998095984,-3.600176732637335e-15,
1.28125,-0.2478361639045943,1.3029797173308663e-14,
1.2734375,-0.2417199368871934,4.8230289429940886e-14,
1.265625,-0.23556607131274632,-2.0592242769647135e-14,
1.2578125,-0.22937410106487732,3.149265065191484e-14,
1.25,-0.22314355131425145,4.169796584527195e-14,
1.25,-0.22314355131425145,4.169796584527195e-14,
1.2421875,-0.21687393830063684,2.2477465222466186e-14,
1.234375,-0.21056476910735,3.6507188831790577e-16,
1.2265625,-0.2042155414286526,-3.827767260205414e-14,
1.2265625,-0.2042155414286526,-3.827767260205414e-14,
1.21875,-0.19782574332987224,-4.7641388950792196e-14,
1.2109375,-0.19139485299967873,4.9278276214647115e-14,
1.203125,-0.18492233849406148,4.9485167661250996e-14,
1.203125,-0.18492233849406148,4.9485167661250996e-14,
1.1953125,-0.1784076574728033,-1.5003333854266542e-14,
1.1875,-0.17185025692663203,-2.7194441649495324e-14,
1.1875,-0.17185025692663203,-2.7194441649495324e-14,
1.1796875,-0.1652495728952772,-2.99659267292569e-14,
1.171875,-0.15860503017665906,2.0472357800461955e-14,
1.171875,-0.15860503017665906,2.0472357800461955e-14,
1.1640625,-0.15191604202584585,3.879296723063646e-15,
1.15625,-0.1451820098444614,-3.6506824353335045e-14,
1.1484375,-0.13840232285906495,-5.4183331379008994e-14,
1.1484375,-0.13840232285906495,-5.4183331379008994e-14,
1.140625,-0.131576357788731,1.1729485484531301e-14,
1.140625,-0.131576357788731,1.1729485484531301e-14,
1.1328125,-0.12470347850091912,-3.811763084710266e-14,
1.125,-0.11778303565643,4.654729747598445e-14,
1.125,-0.11778303565643,4.654729747598445e-14,
1.1171875,-0.11081436634026431,-2.5799991283069902e-14,
1.109375,-0.10379679368168127,3.7700471749674615e-14,
1.109375,-0.10379679368168127,3.7700471749674615e-14,
1.1015625,-0.09672962645856842,1.7306161136093256e-14,
1.1015625,-0.09672962645856842,1.7306161136093256e-14,
1.09375,-0.089612158689647,-4.012913552726574e-14,
1.0859375,-0.08244366921110213,2.7541708360737882e-14,
1.0859375,-0.08244366921110213,2.7541708360737882e-14,
1.078125,-0.07522342123763792,5.0396178134370583e-14,
1.078125,-0.07522342123763792,5.0396178134370583e-14,
1.0703125,-0.06795066190852594,1.8195060030168815e-14,
1.0625,-0.06062462181648698,5.213620639136504e-14,
1.0625,-0.06062462181648698,5.213620639136504e-14,
1.0546875,-0.053244514518837605,2.532168943117445e-14,
1.0546875,-0.053244514518837605,2.532168943117445e-14,
1.046875,-0.045809536031242715,-5.148849572685811e-14,
1.046875,-0.045809536031242715,-5.148849572685811e-14,
1.0390625,-0.038318864302141264,4.6652946995830086e-15,
1.0390625,-0.038318864302141264,4.6652946995830086e-15,
1.03125,-0.03077165866670839,-4.529814257790929e-14,
1.03125,-0.03077165866670839,-4.529814257790929e-14,
1.0234375,-0.023167059281490765,-4.361324067851568e-14,
1.015625,-0.015504186535963527,-1.7274567499706107e-15,
1.015625,-0.015504186535963527,-1.7274567499706107e-15,
1.0078125,-0.0077821404420319595,-2.298941004620351e-14,
1.0078125,-0.0077821404420319595,-2.298941004620351e-14,
1.0,0.0,0.0,
1.0,0.0,0.0,
0.9921875,0.007843177461040796,-1.4902732911301337e-14,
0.984375,0.01574835696817445,-3.527980389655325e-14,
0.9765625,0.023716526617363343,-4.730054772033249e-14,
0.96875,0.03174869831457272,7.580310369375161e-15,
0.9609375,0.039845908547249564,-4.9893776716773285e-14,
0.953125,0.048009219186383234,-2.262629393030674e-14,
0.9453125,0.056239718322899535,-2.345674491018699e-14,
0.94140625,0.06038051098892083,-1.3352588834854848e-14,
0.93359375,0.06871389254808946,-3.765296820388875e-14,
0.92578125,0.07711730334438016,5.1128335719851986e-14,
0.91796875,0.08559193033545398,-5.046674438470119e-14,
0.9140625,0.08985632912185793,3.1218748807418837e-15,
0.90625,0.09844007281321865,3.3871241029241416e-14,
0.8984375,0.10709813555638448,-1.7376727386423858e-14,
0.89453125,0.11145544092528326,3.957125899799804e-14,
0.88671875,0.12022742699821265,-5.2849453521890294e-14,
0.8828125,0.12464244520731427,-3.767012502308738e-14,
0.875,0.13353139262449076,3.1859736349078334e-14,
0.87109375,0.13800567301939282,5.0900642926060466e-14,
0.86328125,0.14701474296180095,8.710783796122478e-15,
0.859375,0.15154989812720032,6.157896229122976e-16,
0.8515625,0.16068238169043525,3.821577743916796e-14,
0.84765625,0.16528009093906348,3.9440046718453496e-14,
0.83984375,0.17453941635187675,2.2924522154618074e-14,
0.8359375,0.17920142945774842,-3.742530094732263e-14,
0.83203125,0.18388527877016259,-2.5223102140407338e-14,
0.82421875,0.1933193110035063,-1.0320443688698849e-14,
0.8203125,0.19806991376208316,1.0634128304268335e-14,
0.8125,0.20763936477828793,-4.3425422595242564e-14,
0.80859375,0.21245865121420593,-1.2527395755711364e-14,
0.8046875,0.21730127569003344,-5.204008743405884e-14,
0.80078125,0.22216746534115828,-3.979844515951702e-15,
0.79296875,0.2319714654378231,-4.7955860343296286e-14,
0.7890625,0.2369097470783572,5.015686013791602e-16,
0.78515625,0.24187253642048745,-7.252318953240293e-16,
0.78125,0.2468600779315011,2.4688324156011588e-14,
0.7734375,0.2569104137850218,5.465121253624792e-15,
0.76953125,0.26197371574153294,4.102651071698446e-14,
0.765625,0.2670627852490952,-4.996736502345936e-14,
0.76171875,0.27217788591576664,4.903580708156347e-14,
0.7578125,0.27731928541618345,5.089628039500759e-14,
0.75390625,0.28248725557466514,1.1782016386565151e-14,
0.74609375,0.29290401643288533,4.727452940514406e-14,
0.7421875,0.29815337231912054,-4.4204083338755686e-14,
0.73828125,0.3034304294199046,1.548345993498083e-14,
0.734375,0.30873548164959175,2.1522127491642888e-14,
0.73046875,0.3140688276249648,1.1054030169005386e-14,
0.7265625,0.31943077076641657,-5.534326352070679e-14,
0.72265625,0.3248216194012912,-5.351646604259541e-14,
0.71875,0.33024168687052224,5.4612144489920215e-14,
0.71484375,0.3356912916381134,2.8136969901227338e-14,
0.7109375,0.3411707574027787,-1.156568624616423e-14]);
const EXP_TAB = [
0x0n,
0x3ff0000000000000n,
0x3c9b3b4f1a88bf6en,
0x3feff63da9fb3335n,
0xbc7160139cd8dc5dn,
0x3fefec9a3e778061n,
0xbc905e7a108766d1n,
0x3fefe315e86e7f85n,
0x3c8cd2523567f613n,
0x3fefd9b0d3158574n,
0xbc8bce8023f98efan,
0x3fefd06b29ddf6den,
0x3c60f74e61e6c861n,
0x3fefc74518759bc8n,
0x3c90a3e45b33d399n,
0x3fefbe3ecac6f383n,
0x3c979aa65d837b6dn,
0x3fefb5586cf9890fn,
0x3c8eb51a92fdeffcn,
0x3fefac922b7247f7n,
0x3c3ebe3d702f9cd1n,
0x3fefa3ec32d3d1a2n,
0xbc6a033489906e0bn,
0x3fef9b66affed31bn,
0xbc9556522a2fbd0en,
0x3fef9301d0125b51n,
0xbc5080ef8c4eea55n,
0x3fef8abdc06c31ccn,
0xbc91c923b9d5f416n,
0x3fef829aaea92de0n,
0x3c80d3e3e95c55afn,
0x3fef7a98c8a58e51n,
0xbc801b15eaa59348n,
0x3fef72b83c7d517bn,
0xbc8f1ff055de323dn,
0x3fef6af9388c8dean,
0x3c8b898c3f1353bfn,
0x3fef635beb6fcb75n,
0xbc96d99c7611eb26n,
0x3fef5be084045cd4n,
0x3c9aecf73e3a2f60n,
0x3fef54873168b9aan,
0xbc8fe782cb86389dn,
0x3fef4d5022fcd91dn,
0x3c8a6f4144a6c38dn,
0x3fef463b88628cd6n,
0x3c807a05b0e4047dn,
0x3fef3f49917ddc96n,
0x3c968efde3a8a894n,
0x3fef387a6e756238n,
0x3c875e18f274487dn,
0x3fef31ce4fb2a63fn,
0x3c80472b981fe7f2n,
0x3fef2b4565e27cddn,
0xbc96b87b3f71085en,
0x3fef24dfe1f56381n,
0x3c82f7e16d09ab31n,
0x3fef1e9df51fdee1n,
0xbc3d219b1a6fbffan,
0x3fef187fd0dad990n,
0x3c8b3782720c0ab4n,
0x3fef1285a6e4030bn,
0x3c6e149289cecb8fn,
0x3fef0cafa93e2f56n,
0x3c834d754db0abb6n,
0x3fef06fe0a31b715n,
0x3c864201e2ac744cn,
0x3fef0170fc4cd831n,
0x3c8fdd395dd3f84an,
0x3feefc08b26416ffn,
0xbc86a3803b8e5b04n,
0x3feef6c55f929ff1n,
0xbc924aedcc4b5068n,
0x3feef1a7373aa9cbn,
0xbc9907f81b512d8en,
0x3feeecae6d05d866n,
0xbc71d1e83e9436d2n,
0x3feee7db34e59ff7n,
0xbc991919b3ce1b15n,
0x3feee32dc313a8e5n,
0x3c859f48a72a4c6dn,
0x3feedea64c123422n,
0xbc9312607a28698an,
0x3feeda4504ac801cn,
0xbc58a78f4817895bn,
0x3feed60a21f72e2an,
0xbc7c2c9b67499a1bn,
0x3feed1f5d950a897n,
0x3c4363ed60c2ac11n,
0x3feece086061892dn,
0x3c9666093b0664efn,
0x3feeca41ed1d0057n,
0x3c6ecce1daa10379n,
0x3feec6a2b5c13cd0n,
0x3c93ff8e3f0f1230n,
0x3feec32af0d7d3den,
0x3c7690cebb7aafb0n,
0x3feebfdad5362a27n,
0x3c931dbdeb54e077n,
0x3feebcb299fddd0dn,
0xbc8f94340071a38en,
0x3feeb9b2769d2ca7n,
0xbc87deccdc93a349n,
0x3feeb6daa2cf6642n,
0xbc78dec6bd0f385fn,
0x3feeb42b569d4f82n,
0xbc861246ec7b5cf6n,
0x3feeb1a4ca5d920fn,
0x3c93350518fdd78en,
0x3feeaf4736b527dan,
0x3c7b98b72f8a9b05n,
0x3feead12d497c7fdn,
0x3c9063e1e21c5409n,
0x3feeab07dd485429n,
0x3c34c7855019c6ean,
0x3feea9268a5946b7n,
0x3c9432e62b64c035n,
0x3feea76f15ad2148n,
0xbc8ce44a6199769fn,
0x3feea5e1b976dc09n,
0xbc8c33c53bef4da8n,
0x3feea47eb03a5585n,
0xbc845378892be9aen,
0x3feea34634ccc320n,
0xbc93cedd78565858n,
0x3feea23882552225n,
0x3c5710aa807e1964n,
0x3feea155d44ca973n,
0xbc93b3efbf5e2228n,
0x3feea09e667f3bcdn,
0xbc6a12ad8734b982n,
0x3feea012750bdabfn,
0xbc6367efb86da9een,
0x3fee9fb23c651a2fn,
0xbc80dc3d54e08851n,
0x3fee9f7df9519484n,
0xbc781f647e5a3ecfn,
0x3fee9f75e8ec5f74n,
0xbc86ee4ac08b7db0n,
0x3fee9f9a48a58174n,
0xbc8619321e55e68an,
0x3fee9feb564267c9n,
0x3c909ccb5e09d4d3n,
0x3feea0694fde5d3fn,
0xbc7b32dcb94da51dn,
0x3feea11473eb0187n,
0x3c94ecfd5467c06bn,
0x3feea1ed0130c132n,
0x3c65ebe1abd66c55n,
0x3feea2f336cf4e62n,
0xbc88a1c52fb3cf42n,
0x3feea427543e1a12n,
0xbc9369b6f13b3734n,
0x3feea589994cce13n,
0xbc805e843a19ff1en,
0x3feea71a4623c7adn,
0xbc94d450d872576en,
0x3feea8d99b4492edn,
0x3c90ad675b0e8a00n,
0x3feeaac7d98a6699n,
0x3c8db72fc1f0eab4n,
0x3feeace5422aa0dbn,
0xbc65b6609cc5e7ffn,
0x3feeaf3216b5448cn,
0x3c7bf68359f35f44n,
0x3feeb1ae99157736n,
0xbc93091fa71e3d83n,
0x3feeb45b0b91ffc6n,
0xbc5da9b88b6c1e29n,
0x3feeb737b0cdc5e5n,
0xbc6c23f97c90b959n,
0x3feeba44cbc8520fn,
0xbc92434322f4f9aan,
0x3feebd829fde4e50n,
0xbc85ca6cd7668e4bn,
0x3feec0f170ca07ban,
0x3c71affc2b91ce27n,
0x3feec49182a3f090n,
0x3c6dd235e10a73bbn,
0x3feec86319e32323n,
0xbc87c50422622263n,
0x3feecc667b5de565n,
0x3c8b1c86e3e231d5n,
0x3feed09bec4a2d33n,
0xbc91bbd1d3bcbb15n,
0x3feed503b23e255dn,
0x3c90cc319cee31d2n,
0x3feed99e1330b358n,
0x3c8469846e735ab3n,
0x3feede6b5579fdbfn,
0xbc82dfcd978e9db4n,
0x3feee36bbfd3f37an,
0x3c8c1a7792cb3387n,
0x3feee89f995ad3adn,
0xbc907b8f4ad1d9fan,
0x3feeee07298db666n,
0xbc55c3d956dcaeban,
0x3feef3a2b84f15fbn,
0xbc90a40e3da6f640n,
0x3feef9728de5593an,
0xbc68d6f438ad9334n,
0x3feeff76f2fb5e47n,
0xbc91eee26b588a35n,
0x3fef05b030a1064an,
0x3c74ffd70a5fddcdn,
0x3fef0c1e904bc1d2n,
0xbc91bdfbfa9298acn,
0x3fef12c25bd71e09n,
0x3c736eae30af0cb3n,
0x3fef199bdd85529cn,
0x3c8ee3325c9ffd94n,
0x3fef20ab5fffd07an,
0x3c84e08fd10959acn,
0x3fef27f12e57d14bn,
0x3c63cdaf384e1a67n,
0x3fef2f6d9406e7b5n,
0x3c676b2c6c921968n,
0x3fef3720dcef9069n,
0xbc808a1883ccb5d2n,
0x3fef3f0b555dc3fan,
0xbc8fad5d3ffffa6fn,
0x3fef472d4a07897cn,
0xbc900dae3875a949n,
0x3fef4f87080d89f2n,
0x3c74a385a63d07a7n,
0x3fef5818dcfba487n,
0xbc82919e2040220fn,
0x3fef60e316c98398n,
0x3c8e5a50d5c192acn,
0x3fef69e603db3285n,
0x3c843a59ac016b4bn,
0x3fef7321f301b460n,
0xbc82d52107b43e1fn,
0x3fef7c97337b9b5fn,
0xbc892ab93b470dc9n,
0x3fef864614f5a129n,
0x3c74b604603a88d3n,
0x3fef902ee78b3ff6n,
0x3c83c5ec519d7271n,
0x3fef9a51fbc74c83n,
0xbc8ff7128fd391f0n,
0x3fefa4afa2a490dan,
0xbc8dae98e223747dn,
0x3fefaf482d8e67f1n,
0x3c8ec3bc41aa2008n,
0x3fefba1bee615a27n,
0x3c842b94c3a9eb32n,
0x3fefc52b376bba97n,
0x3c8a64a931d185een,
0x3fefd0765b6e4540n,
0xbc8e37bae43be3edn,
0x3fefdbfdad9cbe14n,
0x3c77893b4d91cd9dn,
0x3fefe7c1819e90d8n,
0x3c5305c14160cc89n,
0x3feff3c22b8f71f1n];

// ---- glibc sysdeps/ieee754/dbl-64/e_pow.c --------------------------------

const LN2HI = 0.6931471805598903 /* 0x1.62e42fefa3800p-1 */;
const LN2LO = 5.497923018708371e-14 /* 0x1.ef35793c76730p-45 */;
const A0 = -0.5;
const A1 = 0.3333333333333339 /* 0x1.555555555556p-2 */ * -2;
const A2 = -0.25000000000000033 /* 0x1.0000000000006p-2 */ * -2;
const A3 = 0.1999999998830994 /* 0x1.999999959554ep-3 */ * 4;
const A4 = -0.16666666658719348 /* 0x1.555555529a47ap-3 */ * 4;
const A5 = 0.14286370355743763 /* 0x1.2495b9b4845e9p-3 */ * -8;
const A6 = -0.12500519079594427 /* 0x1.0002b8b263fc3p-3 */ * -8;
const OFF = 0x3fe6955500000000n;

const INV_LN2N = 1.4426950408889634 /* 0x1.71547652b82fep0 */ * 128;
const NEG_LN2HI_N = -0.005415212348111709 /* 0x1.62e42fefa0000p-8 */;
const NEG_LN2LO_N = -1.2864023111638346e-14 /* 0x1.cf79abc9e3b3ap-47 */;
const SHIFT = 6755399441055744.0 /* 0x1.8p52 */;
const C2 = 0.49999999999996786 /* 0x1.ffffffffffdbdp-2 */;
const C3 = 0.16666666666665886 /* 0x1.555555555543cp-3 */;
const C4 = 0.0416666808410674 /* 0x1.55555cf172b91p-5 */;
const C5 = 0.008333335853059549 /* 0x1.1111167a4d017p-7 */;
const SIGN_BIAS = 0x800n << 7n;

let logTail = 0;

function logInline(ix: bigint, useFma: boolean): number {
  const tmp = (ix - OFF) & M64;
  const i = Number((tmp >> 45n) % 128n);
  const k = Number(BigInt.asIntN(64, tmp) >> 52n);
  const iz = (ix - (tmp & (0xfffn << 52n))) & M64;
  const z = asdouble(iz);
  const kd = k;
  const invc = POW_LOG_TAB[3 * i];
  const logc = POW_LOG_TAB[3 * i + 1];
  const logctail = POW_LOG_TAB[3 * i + 2];
  let hi: number, lo: number, p: number;
  if (useFma) {
    // Operation order and fused operations exactly as in the shipped
    // __ieee754_pow_fma (GCC contracts several a*b+c beyond the explicit fma).
    const r = fma(z, invc, -1.0);
    const t1 = fma(kd, LN2HI, logc);
    const t2 = t1 + r;
    const lo1 = fma(kd, LN2LO, logctail);
    const lo2 = t1 - t2 + r;
    const ar = A0 * r;
    const ar2 = r * ar;
    const ar3 = r * ar2;
    hi = t2 + ar2;
    const lo3 = fma(ar, r, -ar2);
    const lo4 = t2 - hi + ar2;
    const q1 = fma(fma(r, A6, A5), ar2, fma(r, A4, A3));
    const q2 = fma(ar2, q1, fma(r, A2, A1));
    lo = fma(ar3, q2, lo1 + lo2 + lo3 + lo4);
  } else {
    const zhi = asdouble((iz + (1n << 31n)) & (M64 ^ 0xffffffffn));
    const zlo = z - zhi;
    const rhi = zhi * invc - 1.0;
    const rlo = zlo * invc;
    const r = rhi + rlo;
    const t1 = kd * LN2HI + logc;
    const t2 = t1 + r;
    const lo1 = kd * LN2LO + logctail;
    const lo2 = t1 - t2 + r;
    const ar = A0 * r;
    const ar2 = r * ar;
    const ar3 = r * ar2;
    const arhi = A0 * rhi;
    const arhi2 = rhi * arhi;
    hi = t2 + arhi2;
    const lo3 = rlo * (ar + arhi);
    const lo4 = t2 - hi + arhi2;
    p = ar3 * (A1 + r * A2 + ar2 * (A3 + r * A4 + ar2 * (A5 + r * A6)));
    lo = lo1 + lo2 + lo3 + lo4 + p;
  }
  const y = hi + lo;
  logTail = hi - y + lo;
  return y;
}

function specialcase(tmp: number, sbits: bigint, ki: bigint, useFma: boolean): number {
  if ((ki & 0x80000000n) === 0n) {
    sbits = (sbits - (1009n << 52n)) & M64;
    const scale = asdouble(sbits);
    return 5.486124068793689e+303 /* 0x1p1009 */ * (useFma ? fma(scale, tmp, scale) : scale + scale * tmp);
  }
  sbits = (sbits + (1022n << 52n)) & M64;
  const scale = asdouble(sbits);
  let y = scale + scale * tmp;
  if (Math.abs(y) < 1.0) {
    let one = 1.0;
    if (y < 0.0) one = -1.0;
    let lo = scale - y + scale * tmp;
    const hi = one + y;
    lo = one - hi + y + lo;
    y = hi + lo - one;
    if (y === 0.0) y = asdouble(sbits & 0x8000000000000000n);
  }
  return 2.2250738585072014e-308 /* 0x1p-1022 */ * y;
}

function expInline(x: number, xtail: number, signBias: bigint, useFma: boolean): number {
  let abstop = top12(x) & 0x7ff;
  if (((abstop - 0x3c9) >>> 0) >= 0x408 - 0x3c9) {
    if (((abstop - 0x3c9) >>> 0) >= 0x80000000) {
      const one = 1.0 + x;
      return signBias ? -one : one;
    }
    if (abstop >= 0x409) {
      if (asuint64(x) >> 63n) return signBias ? -0 : 0;
      return signBias ? -Infinity : Infinity;
    }
    abstop = 0;
  }
  const z = INV_LN2N * x;
  let kd = useFma ? fma(INV_LN2N, x, SHIFT) : z + SHIFT;
  const ki = asuint64(kd);
  kd -= SHIFT;
  let r: number;
  if (useFma) r = fma(kd, NEG_LN2LO_N, fma(kd, NEG_LN2HI_N, x));
  else r = x + kd * NEG_LN2HI_N + kd * NEG_LN2LO_N;
  r += xtail;
  const idx = Number(2n * (ki % 128n));
  const top = ((ki + signBias) << 45n) & M64;
  const tail = asdouble(EXP_TAB[idx]);
  const sbits = (EXP_TAB[idx + 1] + top) & M64;
  const r2 = r * r;
  const tmp = useFma
    ? fma(fma(r, C5, C4), r2 * r2, fma(fma(r, C3, C2), r2, tail + r))
    : tail + r + r2 * (C2 + r * C3) + r2 * r2 * (C4 + r * C5);
  if (abstop === 0) return specialcase(tmp, sbits, ki, useFma);
  const scale = asdouble(sbits);
  return useFma ? fma(scale, tmp, scale) : scale + scale * tmp;
}

function checkint(iy: bigint): number {
  const e = Number((iy >> 52n) & 0x7ffn);
  if (e < 0x3ff) return 0;
  if (e > 0x3ff + 52) return 2;
  if (iy & ((1n << BigInt(0x3ff + 52 - e)) - 1n)) return 0;
  if (iy & (1n << BigInt(0x3ff + 52 - e))) return 1;
  return 2;
}

const INF_BITS = 0x7ff0000000000000n;
function zeroinfnan(i: bigint): boolean {
  return ((2n * i - 1n) & M64) >= 2n * INF_BITS - 1n;
}

// glibc pow(x, y).
function glibcPow(x: number, y: number, useFma: boolean): number {
  let signBias = 0n;
  let ix = asuint64(x);
  const iy = asuint64(y);
  let topx = top12(x);
  const topy = top12(y);
  if (((topx - 1) >>> 0) >= 0x7ff - 1 || (((topy & 0x7ff) - 0x3be) >>> 0) >= 0x43e - 0x3be) {
    if (zeroinfnan(iy)) {
      if (((2n * iy) & M64) === 0n) return 1.0;
      if (ix === asuint64(1.0)) return 1.0;
      if (((2n * ix) & M64) > 2n * INF_BITS || ((2n * iy) & M64) > 2n * INF_BITS) return x + y;
      if (((2n * ix) & M64) === 2n * asuint64(1.0)) return 1.0;
      if ((((2n * ix) & M64) < 2n * asuint64(1.0)) === !(iy >> 63n)) return 0.0;
      return y * y;
    }
    if (zeroinfnan(ix)) {
      let x2 = x * x;
      if (ix >> 63n && checkint(iy) === 1) x2 = -x2;
      return iy >> 63n ? 1 / x2 : x2;
    }
    if (ix >> 63n) {
      const yint = checkint(iy);
      if (yint === 0) return NaN;
      if (yint === 1) signBias = SIGN_BIAS;
      ix &= 0x7fffffffffffffffn;
      topx &= 0x7ff;
    }
    if ((((topy & 0x7ff) - 0x3be) >>> 0) >= 0x43e - 0x3be) {
      if (ix === asuint64(1.0)) return 1.0;
      if ((topy & 0x7ff) < 0x3be) return ix > asuint64(1.0) ? 1.0 + y : 1.0 - y;
      return (ix > asuint64(1.0)) === topy < 0x800 ? Infinity : 0;
    }
    if (topx === 0) {
      ix = asuint64(x * 4503599627370496.0 /* 0x1p52 */);
      ix &= 0x7fffffffffffffffn;
      ix -= 52n << 52n;
    }
  }
  const hi = logInline(ix, useFma);
  const lo = logTail;
  let ehi: number, elo: number;
  if (useFma) {
    ehi = y * hi;
    elo = fma(y, lo, fma(y, hi, -ehi));
  } else {
    const yhi = asdouble(iy & (M64 ^ ((1n << 27n) - 1n)));
    const ylo = y - yhi;
    const lhi = asdouble(asuint64(hi) & (M64 ^ ((1n << 27n) - 1n)));
    const llo = hi - lhi + lo;
    ehi = yhi * lhi;
    elo = ylo * lhi + y * llo;
  }
  return expInline(ehi, elo, signBias, useFma);
}

// glibc __sincostab (sin/cos table, 440 doubles)
// ---- CPython Objects/floatobject.c float_pow ------------------------------

function isOddInteger(v: number): boolean {
  return Math.abs(v) % 2.0 === 1.0;
}

/** CPython `x ** y` for two floats. `fma` picks the glibc pow variant. */
function pyFloatPow(x: number, y: number, fma: boolean): PowResult {
  let iv = x;
  const iw = y;
  let negate = false;
  if (iw === 0) return { kind: "float", v: 1.0 };
  if (Number.isNaN(iv)) return { kind: "float", v: iv };
  if (Number.isNaN(iw)) return { kind: "float", v: iv === 1.0 ? 1.0 : iw };
  if (!Number.isFinite(iw)) {
    iv = Math.abs(iv);
    if (iv === 1.0) return { kind: "float", v: 1.0 };
    if (iw > 0.0 === iv > 1.0) return { kind: "float", v: Math.abs(iw) };
    return { kind: "float", v: 0.0 };
  }
  if (!Number.isFinite(iv)) {
    const odd = isOddInteger(iw);
    if (iw > 0.0) return { kind: "float", v: odd ? iv : Math.abs(iv) };
    return { kind: "float", v: odd ? (iv < 0 ? -0 : 0) : 0.0 };
  }
  if (iv === 0.0) {
    const odd = isOddInteger(iw);
    if (iw < 0.0) return { kind: "error", exc: "ZeroDivisionError" };
    return { kind: "float", v: odd ? iv : 0.0 };
  }
  if (iv < 0.0) {
    if (iw !== Math.floor(iw)) return complexPow(iv, iw, fma);
    iv = -iv;
    negate = isOddInteger(iw);
  }
  if (iv === 1.0) return { kind: "float", v: negate ? -1.0 : 1.0 };
  let ix = glibcPow(iv, iw, fma);
  // _Py_ADJUST_ERANGE1: an infinite result from finite inputs is an overflow;
  // underflow to zero is not an error.
  if (ix === Infinity || ix === -Infinity) return { kind: "error", exc: "OverflowError" };
  if (negate) ix = -ix;
  return { kind: "float", v: ix };
}


// CPython complex_pow -> _Py_c_pow for a negative real base and a real,
// non-integral exponent: len = pow(|x|, y), result len * (cos, sin)(pi * y).
// The formula engine rejects every complex result, so only the error case
// matters: _Py_ADJUST_ERANGE2 turns an infinite part into OverflowError, and
// with a non-integral exponent cos and sin are never 0, so a part is infinite
// exactly when len is.
function complexPow(x: number, y: number, fma: boolean): PowResult {
  const len = glibcPow(Math.abs(x), y, fma);
  if (len === Infinity) return { kind: "error", exc: "OverflowError" };
  return { kind: "complex" };
}
