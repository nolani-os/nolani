// In-memory port of the server's collection query compiler (filters, sorts,
// footer aggregates). The server compiles a view's rules to PostgreSQL over
// `claraos_kb_objects.properties` (JSONB); this module evaluates the same rules
// over already loaded rows and must return identical results. A differential
// test against a real PostgreSQL lives in test/query.diff.mjs.
//
// What is reproduced on purpose (all of it mirrors what PostgreSQL does):
//   * `properties ->> key` text rendering of JSON values (jsonb number format,
//     key order and spacing of arrays/objects, string escapes).
//   * Text order = Unicode code point order. The server database runs on an
//     Alpine image (musl libc) whose en_US.utf8 collation compares bytes.
//   * ILIKE = PostgreSQL's LIKE matcher on lower()-ed text; lower() uses the
//     musl per-character case table, embedded below so the result does not
//     depend on the JavaScript engine's Unicode version.
//   * Numbers: exact decimal arithmetic. The filter value is a binary double
//     (the driver sends it to `numeric` exactly), so 0.1 never equals "0.1".
//   * avg() uses PostgreSQL's numeric division scale and rounding.
//   * NULLS LAST, three-valued logic, and the final `updated_at DESC` order.
//   * FilterError messages are byte-identical to the server (they are shown
//     to the user as the HTTP 400 detail), including Python repr() quoting.
//
// Errors:
//   * FilterError   -> the server answers 400 with the same message.
//   * QueryError    -> the server's database raises an error (HTTP 500).
//   * UnsupportedError -> a date literal outside the subset of PostgreSQL's
//     date input syntax that this module implements. Raised instead of
//     guessing.

export const FT_TEXT = 0;
export const FT_NUMBER = 1;
export const FT_DATE = 2;
export const FT_SELECT = 3;
export const FT_MULTI_SELECT = 4;
export const FT_URL = 5;
export const FT_CHECKBOX = 6;
export const FT_CHECKLIST = 7;
export const FT_MEDIA = 8;
export const FT_PERSON = 9;
export const FT_RELATION = 10;
export const FT_ROLLUP = 11;
export const FT_CREATED_TIME = 12;
export const FT_UPDATED_TIME = 13;
export const FT_FORMULA = 14;

export const AGGREGATES = [
  "count", "count_empty", "count_not_empty", "count_unique",
  "sum", "avg", "min", "max", "range",
] as const;
export type Aggregate = (typeof AGGREGATES)[number];

/** A collection object. The compiler only reads `properties` and `updated_at`;
 *  created/updated-time fields read `properties[key]` like the server does. */
export interface Row {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  properties: Record<string, unknown>;
  [extra: string]: unknown;
}

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterError";
  }
}

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}

const TEXT_OPS = ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with",
  "is_empty", "is_not_empty"];
const NUM_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"];
const DATE_OPS = ["on", "before", "after", "on_or_before", "on_or_after", "between",
  "is_empty", "is_not_empty"];
const SELECT_OPS = ["is", "is_not", "contains_any", "contains_all", "contains_none",
  "is_empty", "is_not_empty"];
const BOOL_OPS = ["is_checked", "is_unchecked"];
const REL_OPS = ["contains_any", "contains_none", "is_empty", "is_not_empty"];

const OPS_BY_TYPE: Record<number, string[]> = {
  [FT_TEXT]: TEXT_OPS, [FT_URL]: TEXT_OPS, [FT_PERSON]: SELECT_OPS,
  [FT_NUMBER]: NUM_OPS, [FT_ROLLUP]: NUM_OPS,
  [FT_DATE]: DATE_OPS, [FT_CREATED_TIME]: DATE_OPS, [FT_UPDATED_TIME]: DATE_OPS,
  [FT_SELECT]: SELECT_OPS, [FT_MULTI_SELECT]: SELECT_OPS,
  [FT_CHECKBOX]: BOOL_OPS, [FT_CHECKLIST]: ["is_complete", "is_incomplete"],
  [FT_RELATION]: REL_OPS, [FT_MEDIA]: ["is_empty", "is_not_empty"],
};

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// Python str()/repr()/float() as the server applies them to filter values

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shortest round-trip digits and decimal exponent of a finite non-zero double. */
function shortestDigits(x: number): { digits: string; exp: number } {
  const [m, e] = Math.abs(x).toExponential().split("e");
  return { digits: m.replace(".", ""), exp: Number(e) };
}

function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const { digits, exp } = shortestDigits(x);
  if (exp < -4 || exp >= 16) {
    const mant = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    const es = Math.abs(exp) < 10 ? "0" + Math.abs(exp) : String(Math.abs(exp));
    return `${sign}${mant}e${exp < 0 ? "-" : "+"}${es}`;
  }
  let s: string;
  if (exp < 0) s = "0." + "0".repeat(-exp - 1) + digits;
  else if (digits.length <= exp + 1) s = digits + "0".repeat(exp + 1 - digits.length) + ".0";
  else s = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
  return sign + s;
}

/** A JSON number the way Python's json module reads it: int unless it was
 *  written with a fraction or exponent (JavaScript writes integers below 1e21
 *  without either). */
function pyNumberRepr(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return String(x);
  return pyFloatRepr(x);
}

const PY_PRINTABLE_EXCLUDED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp < 0x7f || ch === " " || !PY_PRINTABLE_EXCLUDED.test(ch)) out += ch;
    else if (cp <= 0xff) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp <= 0xffff) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += "\\U" + cp.toString(16).padStart(8, "0");
  }
  return out + quote;
}

export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return pyNumberRepr(v);
  if (typeof v === "string") return pyStrRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (isPlainObject(v)) {
    return "{" + Object.keys(v).map((k) => `${pyStrRepr(k)}: ${pyRepr(v[k])}`).join(", ") + "}";
  }
  return String(v);
}

function pyStr(v: unknown): string {
  return typeof v === "string" ? v : pyRepr(v);
}

// Characters Python's str.isspace() accepts (float() strips them).
const PY_SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const PY_FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const PY_SPECIAL_RE = /^[+-]?(?:inf|infinity|nan)$/i;

/** Value of a Unicode decimal digit (general category Nd). Nd digits come in
 *  contiguous runs that start at zero. */
function ndValue(cp: number): number {
  let start = cp;
  while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/** Python float(value); raises the server's FilterError on failure. */
function pyFloat(value: unknown): number {
  const fail = () => new FilterError("Zahlen-Filter braucht einen numerischen Wert");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw fail();
  let ascii = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) ascii += ch;
    else if (PY_SPACE.test(ch)) ascii += " ";
    else if (/\p{Nd}/u.test(ch)) ascii += String(ndValue(cp));
    else throw fail();
  }
  const s = ascii.replace(/^[\t\n\v\f\r\x1c-\x1f ]+|[\t\n\v\f\r\x1c-\x1f ]+$/g, "");
  if (PY_SPECIAL_RE.test(s)) {
    const neg = s.startsWith("-");
    return /nan/i.test(s) ? NaN : neg ? -Infinity : Infinity;
  }
  if (!PY_FLOAT_RE.test(s)) throw fail();
  return Number(s.replace(/_/g, ""));
}

// ---------------------------------------------------------------------------
// jsonb text rendering (`properties ->> key`)

/** numeric_out of the number JavaScript wrote into the JSON. */
function numericText(x: number): string {
  if (x === 0) return "0";
  const { digits, exp } = shortestDigits(x);
  const sign = x < 0 ? "-" : "";
  const scale = digits.length - 1 - exp;
  if (scale <= 0) return sign + digits + "0".repeat(-scale);
  const padded = digits.padStart(scale + 1, "0");
  return sign + padded.slice(0, padded.length - scale) + "." + padded.slice(padded.length - scale);
}

function jsonbString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** jsonb key order: shorter UTF-8 byte length first, then bytewise. */
function jsonbKeyCmp(a: string, b: string): number {
  const la = utf8Len(a), lb = utf8Len(b);
  if (la !== lb) return la - lb;
  return cmpCodePoints(a, b);
}

function jsonbSerialize(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return numericText(v);
  if (typeof v === "string") return jsonbString(v);
  if (Array.isArray(v)) return "[" + v.map(jsonbSerialize).join(", ") + "]";
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort(jsonbKeyCmp);
    return "{" + keys.map((k) => `${jsonbString(k)}: ${jsonbSerialize(v[k])}`).join(", ") + "}";
  }
  return jsonbString(String(v));
}

/** `json ->> key` given the JSON value (undefined = key missing). */
function jsonText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  return jsonbSerialize(v);
}

/** `properties -> key` is an empty JSON array. */
const isEmptyArray = (v: unknown) => Array.isArray(v) && v.length === 0;

/** jsonb `?` operator: array string element, object key, or equal string scalar. */
function jsonbExists(v: unknown, s: string): boolean {
  if (Array.isArray(v)) return v.some((e) => e === s);
  if (isPlainObject(v)) return hasOwn(v, s);
  return v === s;
}

// ---------------------------------------------------------------------------
// Text: code point order and lower()

/** Compares two strings by Unicode code point (= UTF-8 byte order). */
export function cmpCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    // Surrogates (astral code points) sort after U+E000..U+FFFF.
    if (x >= 0xd800 && y >= 0xd800) {
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    }
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

// Per-character lowercase table of the database's C library (musl), as
// produced by PostgreSQL's lower(). Format: "start,end,step,delta;" with hex
// numbers; every code point start, start+step, ..., end maps to cp + delta.
const LOWER_TABLE = "c0,d6,1,20;d8,de,1,20;100,12e,2,1;130,130,1,-c7;132,136,2,1;139,147,2,1;14a,176,2,1;178,178,1,-79;179,17d,2,1;181,181,1,d2;182,184,2,1;186,186,1,ce;187,187,1,1;189,18a,1,cd;18b,18b,1,1;18e,18e,1,4f;18f,18f,1,ca;190,190,1,cb;191,191,1,1;193,193,1,cd;194,194,1,cf;196,196,1,d3;197,197,1,d1;198,198,1,1;19c,19c,1,d3;19d,19d,1,d5;19f,19f,1,d6;1a0,1a4,2,1;1a6,1a6,1,da;1a7,1a7,1,1;1a9,1a9,1,da;1ac,1ac,1,1;1ae,1ae,1,da;1af,1af,1,1;1b1,1b2,1,d9;1b3,1b5,2,1;1b7,1b7,1,db;1b8,1b8,1,1;1bc,1bc,1,1;1c4,1c4,1,2;1c5,1c5,1,1;1c7,1c7,1,2;1c8,1c8,1,1;1ca,1ca,1,2;1cb,1db,2,1;1de,1ee,2,1;1f1,1f1,1,2;1f2,1f4,2,1;1f6,1f6,1,-61;1f7,1f7,1,-38;1f8,21e,2,1;220,220,1,-82;222,232,2,1;23a,23a,1,2a2b;23b,23b,1,1;23d,23d,1,-a3;23e,23e,1,2a28;241,241,1,1;243,243,1,-c3;244,244,1,45;245,245,1,47;246,24e,2,1;370,372,2,1;376,376,1,1;37f,37f,1,74;386,386,1,26;388,38a,1,25;38c,38c,1,40;38e,38f,1,3f;391,3a1,1,20;3a3,3ab,1,20;3cf,3cf,1,8;3d8,3ee,2,1;3f4,3f4,1,-3c;3f7,3f7,1,1;3f9,3f9,1,-7;3fa,3fa,1,1;3fd,3ff,1,-82;400,40f,1,50;410,42f,1,20;460,480,2,1;48a,4be,2,1;4c0,4c0,1,f;4c1,4cd,2,1;4d0,52e,2,1;531,556,1,30;10a0,10c5,1,1c60;10c7,10c7,1,1c60;10cd,10cd,1,1c60;13a0,13ef,1,97d0;13f0,13f5,1,8;1c90,1cba,1,-bc0;1cbd,1cbf,1,-bc0;1e00,1e94,2,1;1e9e,1e9e,1,-1dbf;1ea0,1efe,2,1;1f08,1f0f,1,-8;1f18,1f1d,1,-8;1f28,1f2f,1,-8;1f38,1f3f,1,-8;1f48,1f4d,1,-8;1f59,1f5f,2,-8;1f68,1f6f,1,-8;1f88,1f8f,1,-8;1f98,1f9f,1,-8;1fa8,1faf,1,-8;1fb8,1fb9,1,-8;1fba,1fbb,1,-4a;1fbc,1fbc,1,-9;1fc8,1fcb,1,-56;1fcc,1fcc,1,-9;1fd8,1fd9,1,-8;1fda,1fdb,1,-64;1fe8,1fe9,1,-8;1fea,1feb,1,-70;1fec,1fec,1,-7;1ff8,1ff9,1,-80;1ffa,1ffb,1,-7e;1ffc,1ffc,1,-9;2126,2126,1,-1d5d;212a,212a,1,-20bf;212b,212b,1,-2046;2132,2132,1,1c;2160,216f,1,10;2183,2183,1,1;2c00,2c2e,1,30;2c60,2c60,1,1;2c62,2c62,1,-29f7;2c63,2c63,1,-ee6;2c64,2c64,1,-29e7;2c67,2c6b,2,1;2c6d,2c6d,1,-2a1c;2c6e,2c6e,1,-29fd;2c6f,2c6f,1,-2a1f;2c70,2c70,1,-2a1e;2c72,2c72,1,1;2c75,2c75,1,1;2c7e,2c7f,1,-2a3f;2c80,2ce2,2,1;2ceb,2ced,2,1;2cf2,2cf2,1,1;a640,a66c,2,1;a680,a69a,2,1;a722,a72e,2,1;a732,a76e,2,1;a779,a77b,2,1;a77d,a77d,1,-8a04;a77e,a786,2,1;a78b,a78b,1,1;a78d,a78d,1,-a528;a790,a792,2,1;a796,a7a8,2,1;a7aa,a7aa,1,-a544;a7ab,a7ab,1,-a54f;a7ac,a7ac,1,-a54b;a7ad,a7ad,1,-a541;a7ae,a7ae,1,-a544;a7b0,a7b0,1,-a512;a7b1,a7b1,1,-a52a;a7b2,a7b2,1,-a515;a7b3,a7b3,1,3a0;a7b4,a7be,2,1;a7c2,a7c2,1,1;a7c4,a7c4,1,-30;a7c5,a7c5,1,-a543;a7c6,a7c6,1,-8a38;ff21,ff3a,1,20;10400,10427,1,28;104b0,104d3,1,28;10c80,10cb2,1,40;118a0,118bf,1,20;16e40,16e5f,1,20;1e900,1e921,1,22";

let lowerMap: Map<number, number> | null = null;
function lowerCp(cp: number): number {
  if (cp < 0x80) return cp >= 0x41 && cp <= 0x5a ? cp + 32 : cp;
  if (!lowerMap) {
    lowerMap = new Map();
    for (const part of LOWER_TABLE.split(";")) {
      if (!part) continue;
      const [s, e, st, d] = part.split(",").map((x) => parseInt(x, 16));
      for (let c = s; c <= e; c += st) lowerMap.set(c, c + d);
    }
  }
  return lowerMap.get(cp) ?? cp;
}

function lowerCps(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(lowerCp(ch.codePointAt(0)!));
  return out;
}

const PCT = 0x25, USC = 0x5f, BSL = 0x5c;
const LIKE_TRUE = 1, LIKE_FALSE = 0, LIKE_ABORT = -1;

/** Port of PostgreSQL's MatchText (like_match.c) for a deterministic collation,
 *  on code points. Raises where PostgreSQL raises. */
function matchText(t: number[], ti: number, p: number[], pi: number): number {
  const plen0 = p.length - pi;
  if (plen0 === 1 && p[pi] === PCT) return LIKE_TRUE;
  while (ti < t.length && pi < p.length) {
    if (p[pi] === BSL) {
      pi++;
      if (pi >= p.length) throw new QueryError("LIKE pattern must not end with escape character");
      if (p[pi] !== t[ti]) return LIKE_FALSE;
    } else if (p[pi] === PCT) {
      pi++;
      while (pi < p.length) {
        if (p[pi] === PCT) pi++;
        else if (p[pi] === USC) {
          if (ti >= t.length) return LIKE_ABORT;
          ti++;
          pi++;
        } else break;
      }
      if (pi >= p.length) return LIKE_TRUE;
      let firstpat: number;
      if (p[pi] === BSL) {
        if (p.length - pi < 2) throw new QueryError("LIKE pattern must not end with escape character");
        firstpat = p[pi + 1];
      } else firstpat = p[pi];
      while (ti < t.length) {
        if (t[ti] === firstpat) {
          const m = matchText(t, ti, p, pi);
          if (m !== LIKE_FALSE) return m;
        }
        ti++;
      }
      return LIKE_ABORT;
    } else if (p[pi] === USC) {
      ti++;
      pi++;
      continue;
    } else if (p[pi] !== t[ti]) {
      return LIKE_FALSE;
    }
    ti++;
    pi++;
  }
  if (ti < t.length) return LIKE_FALSE;
  while (pi < p.length && p[pi] === PCT) pi++;
  if (pi >= p.length) return LIKE_TRUE;
  return LIKE_ABORT;
}

/** `text ILIKE pattern` (text not NULL). */
function ilike(text: string, pattern: string): boolean {
  return matchText(lowerCps(text), 0, lowerCps(pattern), 0) === LIKE_TRUE;
}

// ---------------------------------------------------------------------------
// Exact decimals (PostgreSQL numeric) with BigInt

interface Dec { int: bigint; scale: number } // value = int / 10^scale

const NUM_RE = /^-?[0-9]+(\.[0-9]+)?$/;
const pow10 = (n: number) => 10n ** BigInt(n);

function parseDec(s: string): Dec {
  const dot = s.indexOf(".");
  if (dot < 0) return { int: BigInt(s), scale: 0 };
  return { int: BigInt(s.slice(0, dot) + s.slice(dot + 1)), scale: s.length - dot - 1 };
}

/** `CASE WHEN text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN text::numeric END` */
function numOf(text: string | null): Dec | null {
  return text !== null && NUM_RE.test(text) ? parseDec(text) : null;
}

function alignTo(d: Dec, scale: number): bigint {
  return d.int * pow10(scale - d.scale);
}

function cmpDec(a: Dec, b: Dec): number {
  const s = Math.max(a.scale, b.scale);
  const x = alignTo(a, s), y = alignTo(b, s);
  return x < y ? -1 : x > y ? 1 : 0;
}

function addDec(a: Dec, b: Dec, sign: 1n | -1n = 1n): Dec {
  const s = Math.max(a.scale, b.scale);
  return { int: alignTo(a, s) + sign * alignTo(b, s), scale: s };
}

/** Exact value of a finite double as m * 2^e. */
function doubleParts(x: number): { m: bigint; e: number } {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const neg = hi >>> 31 === 1;
  const bexp = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (bexp === 0) e = -1074;
  else {
    m |= 1n << 52n;
    e = bexp - 1075;
  }
  return { m: neg ? -m : m, e };
}

/** Compares a numeric with a double sent as numeric (NaN sorts above all). */
function cmpDecDouble(d: Dec, x: number): number {
  if (Number.isNaN(x) || x === Infinity) return -1;
  if (x === -Infinity) return 1;
  const { m, e } = doubleParts(x);
  let left = d.int, right = m * pow10(d.scale);
  if (e >= 0) right <<= BigInt(e);
  else left <<= BigInt(-e);
  return left < right ? -1 : left > right ? 1 : 0;
}

const bitLen = (n: bigint) => n.toString(2).length;

/** Correctly rounded double of n / d (d > 0), like Python's float(Decimal). */
function ratToDouble(n: bigint, d: bigint): number {
  if (n === 0n) return 0;
  const neg = n < 0n;
  if (neg) n = -n;
  let e = bitLen(n) - bitLen(d) - 53;
  const quot = (ex: number) => {
    const num = ex >= 0 ? n : n << BigInt(-ex);
    const den = ex >= 0 ? d << BigInt(ex) : d;
    return { q: num / den, r: num % den, den };
  };
  let r = quot(e);
  while (r.q >= 1n << 53n) r = quot(++e);
  while (r.q < 1n << 52n) r = quot(--e);
  if (e < -1074) {
    e = -1074;
    r = quot(e);
  }
  let q = r.q;
  const twice = r.r * 2n;
  if (twice > r.den || (twice === r.den && (q & 1n) === 1n)) q += 1n;
  if (q === 1n << 53n) {
    q >>= 1n;
    e += 1;
  }
  if (e > 971) return neg ? -Infinity : Infinity;
  const v = Number(q) * 2 ** e;
  return neg ? -v : v;
}

const decToDouble = (d: Dec) => ratToDouble(d.int, pow10(d.scale));

/** Weight and first digit of |d| in PostgreSQL's base-10000 representation. */
function nbaseLead(d: Dec): { weight: number; first: bigint } {
  const a = d.int < 0n ? -d.int : d.int;
  if (a === 0n) return { weight: 0, first: 0n };
  const lead = a.toString().length - 1 - d.scale; // decimal exponent of leading digit
  const weight = Math.floor(lead / 4);
  const shift = -4 * weight - d.scale;
  const first = shift >= 0 ? a * pow10(shift) : a / pow10(-shift);
  return { weight, first };
}

/** numeric_div(sum, count) with select_div_scale and half-away rounding. */
function divDecByCount(sum: Dec, count: number): Dec {
  const n: Dec = { int: BigInt(count), scale: 0 };
  const a = nbaseLead(sum), b = nbaseLead(n);
  let qweight = a.weight - b.weight;
  if (a.first <= b.first) qweight--;
  let rscale = 16 - qweight * 4;
  rscale = Math.min(Math.max(rscale, sum.scale, n.scale, 0), 1000);
  const num = (sum.int < 0n ? -sum.int : sum.int) * pow10(rscale - sum.scale);
  const den = BigInt(count);
  let q = num / den;
  if ((num % den) * 2n >= den) q += 1n;
  return { int: sum.int < 0n ? -q : q, scale: rscale };
}

// ---------------------------------------------------------------------------
// Dates (day numbers since 1970-01-01, proleptic Gregorian)

function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const daysInMonth = (y: number, m: number) =>
  m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(m) ? 30 : 31;

// PostgreSQL's date range: Julian day 0 up to (excluding) 5874898-01-01.
const DATE_MIN = -2440588;
const DATE_END = 2147483494 - 2440588;

const DATE_PREFIX_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}/;
// The implemented subset of PostgreSQL's date input: an ISO date, optionally a
// time (T, t or blanks as separator) and a zone; the time and zone are ignored
// for the date value but still validated.
const DATE_INPUT_RE = new RegExp(
  "^(\\d{4})-(\\d{1,2})-(\\d{1,2})" +
  "(?:(?:[Tt]| +)(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?)?" +
  "(?: ?(?:([Zz])|([+-])(\\d{2})(?::?(\\d{2}))?))?$",
);

/** `text::date`; `isParam` = filter value input (special words, 1-2 digit month/day). */
function castDate(raw: string, today: number, isParam: boolean): number {
  const text = isParam ? raw.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "")
    : raw.replace(/[ \t\n\r\f\v]+$/, "");
  if (isParam) {
    const special = text.toLowerCase();
    if (special === "infinity") return Infinity;
    if (special === "-infinity") return -Infinity;
    if (special === "epoch") return 0;
    if (special === "today" || special === "now") return today;
    if (special === "tomorrow") return today + 1;
    if (special === "yesterday") return today - 1;
  }
  // Without digits only a special word can make a date (year and day need
  // numbers), so a digit-free value without one is a certain input error.
  if (!/[0-9]/.test(text)) {
    const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
    const SPECIAL = ["epoch", "infinity", "now", "today", "tomorrow", "yesterday", "allballs"];
    if (!words.some((w) => SPECIAL.includes(w))) {
      throw new QueryError(`invalid input syntax for type date: "${raw}"`);
    }
  }
  const m = DATE_INPUT_RE.exec(text);
  if (!m || (!isParam && (m[2].length !== 2 || m[3].length !== 2))) {
    throw new UnsupportedError(`date value not supported locally: ${JSON.stringify(raw)}`);
  }
  const outOfRange = () => new QueryError(`date/time field value out of range: "${raw}"`);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) throw outOfRange();
  if (m[4] !== undefined) {
    const h = Number(m[4]), mi = Number(m[5]), s = m[6] === undefined ? 0 : Number(m[6]);
    const frac = m[7] !== undefined && /[1-9]/.test(m[7]);
    if (h > 24 || mi > 59 || s > 60 || (h === 24 && (mi > 0 || s > 0 || frac))) throw outOfRange();
  }
  if (m[9] !== undefined) {
    const oh = Number(m[10]), om = m[11] === undefined ? 0 : Number(m[11]);
    if (oh > 15 || om > 59) throw new QueryError(`time zone displacement out of range: "${raw}"`);
  }
  return daysFromCivil(y, mo, d);
}

/** `CASE WHEN text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN text::date END` */
function dateOf(text: string | null, today: number): number | null {
  return text !== null && DATE_PREFIX_RE.test(text) ? castDate(text, today, false) : null;
}

function relativeDate(value: unknown): number | null {
  if (typeof value === "string") {
    const v = value.toLowerCase();
    return v === "today" ? 0 : v === "tomorrow" ? 1 : v === "yesterday" ? -1 : null;
  }
  if (isPlainObject(value)) {
    // Python: isinstance(x, int) is also true for booleans.
    const asInt = (x: unknown): number | null =>
      typeof x === "boolean" ? (x ? 1 : 0)
        : typeof x === "number" && Number.isInteger(x) && Math.abs(x) < 1e21 ? x : null;
    const ago = asInt(value.days_ago);
    if (ago !== null) return -ago;
    const ahead = asInt(value.days_from_now);
    if (ahead !== null) return ahead;
  }
  return null;
}

function todayOf(now: Date, timeZone: "utc" | "local"): number {
  return timeZone === "utc"
    ? daysFromCivil(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate())
    : daysFromCivil(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** `timestamptz` of updated_at in microseconds (the final sort key). */
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
function timestampMicros(s: string): number {
  const m = TS_RE.exec(s);
  if (!m) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? -Infinity : ms * 1000;
  }
  const days = daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
  const secs = Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6] ?? 0);
  const micros = m[7] ? Math.round(Number("0." + m[7]) * 1e6) : 0;
  let offset = 0;
  if (m[8] && m[8] !== "Z") {
    const z = m[8].replace(":", "");
    offset = (Number(z.slice(1, 3)) * 3600 + Number(z.slice(3, 5) || 0) * 60) * (z[0] === "-" ? -1 : 1);
  }
  return (days * 86400 + secs - offset) * 1e6 + micros;
}

// ---------------------------------------------------------------------------
// Compiler

const KEY_RE = /^[A-Za-z0-9_\-]{1,64}\n?$/; // Python's `$` also matches before a final newline

function checkKey(key: string): void {
  if (!KEY_RE.test(key)) throw new FilterError(`Ungültiger Feld-Schlüssel: ${pyRepr(key)}`);
}

type Ctx = { today: number };
type Pred = (row: Row, ctx: Ctx) => boolean;
type Prepare = (ctx: Ctx) => void; // raises errors of constant parameters (date casts)

const prop = (row: Row, key: string): unknown =>
  row.properties && hasOwn(row.properties, key) ? row.properties[key] : undefined;

const textOf = (row: Row, key: string) => jsonText(prop(row, key));

function compileCondition(cond: Record<string, unknown>, fields: Record<string, number>,
  prepares: Prepare[]): Pred {
  const key = cond.key;
  const op = cond.op;
  if (typeof key !== "string" || !key) throw new FilterError("Filter ohne key");
  if (!hasOwn(fields, key) || fields[key] === null || fields[key] === undefined) {
    throw new FilterError(`Unbekanntes Feld im Filter: ${pyRepr(key)}`);
  }
  const ftype = fields[key];
  const allowed = OPS_BY_TYPE[ftype] ?? TEXT_OPS;
  if (typeof op !== "string" || !allowed.includes(op)) {
    throw new FilterError(`Operator ${pyRepr(op)} ist für dieses Feld nicht erlaubt`);
  }
  const value = cond.value;

  if (op === "is_empty" || op === "is_not_empty") {
    checkKey(key);
    const empty = (row: Row) => {
      const v = prop(row, key);
      const t = jsonText(v);
      return t === null || t === "" || isEmptyArray(v);
    };
    return op === "is_empty" ? (row) => empty(row) : (row) => !empty(row);
  }

  if (ftype === FT_TEXT || ftype === FT_URL || (ftype === FT_SELECT && (op === "is" || op === "is_not"))) {
    checkKey(key);
    const sv = pyStr(value);
    switch (op) {
      case "is": return (row) => textOf(row, key) === sv;
      case "is_not": return (row) => textOf(row, key) !== sv;
      case "contains": return (row) => { const t = textOf(row, key); return t !== null && ilike(t, `%${sv}%`); };
      case "not_contains": return (row) => { const t = textOf(row, key); return t === null || !ilike(t, `%${sv}%`); };
      case "starts_with": return (row) => { const t = textOf(row, key); return t !== null && ilike(t, `${sv}%`); };
      case "ends_with": return (row) => { const t = textOf(row, key); return t !== null && ilike(t, `%${sv}`); };
    }
  }

  if (ftype === FT_NUMBER || ftype === FT_ROLLUP) {
    checkKey(key);
    const val = pyFloat(value);
    const test: Record<string, (c: number) => boolean> = {
      eq: (c) => c === 0, neq: (c) => c !== 0, gt: (c) => c > 0,
      gte: (c) => c >= 0, lt: (c) => c < 0, lte: (c) => c <= 0,
    };
    const t = test[op];
    return (row) => {
      const n = numOf(textOf(row, key));
      return n !== null && t(cmpDecDouble(n, val));
    };
  }

  if (ftype === FT_DATE || ftype === FT_CREATED_TIME || ftype === FT_UPDATED_TIME) {
    checkKey(key);
    const base = (row: Row, ctx: Ctx) => dateOf(textOf(row, key), ctx.today);
    if (op === "between") {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new FilterError("between erwartet [start, ende]");
      }
      const [a, b] = [pyStr(value[0]), pyStr(value[1])];
      let lo = 0, hi = 0;
      prepares.push((ctx) => {
        lo = castDate(a, ctx.today, true);
        hi = castDate(b, ctx.today, true);
      });
      return (row, ctx) => { const d = base(row, ctx); return d !== null && d >= lo && d <= hi; };
    }
    const rel = relativeDate(value);
    const test: Record<string, (d: number, x: number) => boolean> = {
      on: (d, x) => d === x, before: (d, x) => d < x, after: (d, x) => d > x,
      on_or_before: (d, x) => d <= x, on_or_after: (d, x) => d >= x,
    };
    const t = test[op];
    let target = 0;
    if (rel !== null) {
      prepares.push((ctx) => {
        if (Math.abs(rel) > 2147483647) {
          throw new QueryError(`invalid input for query argument: ${rel} (value out of int32 range)`);
        }
        target = ctx.today + rel;
        if (target < DATE_MIN || target >= DATE_END) throw new QueryError("date out of range");
      });
    } else {
      const sv = pyStr(value);
      prepares.push((ctx) => { target = castDate(sv, ctx.today, true); });
    }
    return (row, ctx) => { const d = base(row, ctx); return d !== null && t(d, target); };
  }

  if (ftype === FT_MULTI_SELECT || ftype === FT_PERSON || ftype === FT_RELATION || ftype === FT_SELECT) {
    checkKey(key);
    const vals = (Array.isArray(value) ? value : [value]).map(pyStr);
    const any = (row: Row): boolean | null => {
      const j = prop(row, key);
      if (j === undefined) return null;
      return vals.some((v) => jsonbExists(j, v));
    };
    if (op === "contains_any") return (row) => any(row) === true;
    if (op === "contains_all") {
      return (row) => {
        const j = prop(row, key);
        return j !== undefined && vals.every((v) => jsonbExists(j, v));
      };
    }
    if (op === "contains_none") return (row) => !(any(row) ?? false);
  }

  if (ftype === FT_CHECKBOX) {
    checkKey(key);
    if (op === "is_checked") return (row) => textOf(row, key) === "true";
    return (row) => { const t = textOf(row, key); return t === null || t === "false"; };
  }

  if (ftype === FT_CHECKLIST) {
    checkKey(key);
    const pct = (row: Row) => {
      const j = prop(row, key);
      return isPlainObject(j) && hasOwn(j, "percentage") ? jsonText(j.percentage) : null;
    };
    return op === "is_complete" ? (row) => pct(row) === "100" : (row) => pct(row) !== "100";
  }

  throw new FilterError(`Operator ${pyRepr(op)} für Feldtyp ${ftype} nicht unterstützt`);
}

function compileNode(node: unknown, fields: Record<string, number>, prepares: Prepare[],
  depth: number): Pred | null {
  if (!isPlainObject(node) || Object.keys(node).length === 0) return null;
  if (depth > 8) throw new FilterError("Filterbaum zu tief verschachtelt (max. 8)");
  const op = node.op;
  if (op === "and" || op === "or") {
    const children = node.children;
    if (!Array.isArray(children)) throw new FilterError("Gruppe ohne children");
    const parts: Pred[] = [];
    for (const ch of children) {
      const c = compileNode(ch, fields, prepares, depth + 1);
      if (c) parts.push(c);
    }
    if (parts.length === 0) return null;
    return op === "and"
      ? (row, ctx) => parts.every((p) => p(row, ctx))
      : (row, ctx) => parts.some((p) => p(row, ctx));
  }
  return compileCondition(node, fields, prepares);
}

type SortKey = { kind: "text" | "num" | "date"; key: string; desc: boolean };

function compileSortKeys(sorts: unknown, fields: Record<string, number>): SortKey[] {
  const out: SortKey[] = [];
  for (const s of Array.isArray(sorts) ? sorts : []) {
    if (!isPlainObject(s)) continue;
    const key = s.key;
    if (typeof key !== "string" || !hasOwn(fields, key)) continue;
    const dir = hasOwn(s, "dir") ? s.dir : "asc";
    const desc = typeof dir === "string" && dir.toLowerCase() === "desc";
    const ftype = fields[key];
    checkKey(key);
    const kind = ftype === FT_NUMBER || ftype === FT_ROLLUP ? "num"
      : ftype === FT_DATE || ftype === FT_CREATED_TIME || ftype === FT_UPDATED_TIME ? "date" : "text";
    out.push({ kind, key, desc });
  }
  return out;
}

function runSort<T extends Row>(rows: T[], keys: SortKey[], ctx: Ctx): T[] {
  // Precompute keys (date casts raise here, for every row, like PostgreSQL).
  const decorated = rows.map((row, idx) => ({
    row, idx,
    ts: timestampMicros(String(row.updated_at)),
    vals: keys.map((k): string | Dec | number | null => {
      const t = textOf(row, k.key);
      return k.kind === "num" ? numOf(t) : k.kind === "date" ? dateOf(t, ctx.today) : t;
    }),
  }));
  decorated.sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const x = a.vals[i], y = b.vals[i];
      if (x === null || y === null) {
        if (x === y) continue;
        return x === null ? 1 : -1; // NULLS LAST in both directions
      }
      const k = keys[i];
      const c = k.kind === "num" ? cmpDec(x as Dec, y as Dec)
        : k.kind === "date" ? Math.sign((x as number) - (y as number))
          : cmpCodePoints(x as string, y as string);
      if (c !== 0) return k.desc ? -c : c;
    }
    if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1; // updated_at DESC
    return a.idx - b.idx;
  });
  return decorated.map((d) => d.row);
}

function makeCtx(now: Date | undefined, timeZone: "utc" | "local"): Ctx {
  return { today: todayOf(now ?? new Date(), timeZone) };
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Rows matching a view's filter tree (`compile_filter`). Input order is kept.
 * `timeZone` picks the calendar day for relative dates and "today": the
 * server uses its database session time zone, which is UTC by default.
 */
export function filterRows<T extends Row>(rows: T[], filters: unknown,
  fields: Record<string, number>, now?: Date, timeZone: "utc" | "local" = "utc"): T[] {
  const prepares: Prepare[] = [];
  const pred = compileNode(filters, fields, prepares, 0);
  const ctx = makeCtx(now, timeZone);
  for (const p of prepares) p(ctx);
  return pred ? rows.filter((r) => pred(r, ctx)) : rows.slice();
}

/** Rows in a view's sort order (`compile_sorts`), ending with updated_at DESC.
 *  Stable: complete ties keep their input order. */
export function sortRows<T extends Row>(rows: T[], sorts: unknown,
  fields: Record<string, number>, now?: Date, timeZone: "utc" | "local" = "utc"): T[] {
  return runSort(rows, compileSortKeys(sorts, fields), makeCtx(now, timeZone));
}

/** Filter + sort with the server's error precedence: both are compiled
 *  (FilterError) before any row is evaluated (QueryError). */
export function queryRows<T extends Row>(rows: T[], filters: unknown, sorts: unknown,
  fields: Record<string, number>, now?: Date, timeZone: "utc" | "local" = "utc"): T[] {
  const prepares: Prepare[] = [];
  const pred = compileNode(filters, fields, prepares, 0);
  const keys = compileSortKeys(sorts, fields);
  const ctx = makeCtx(now, timeZone);
  for (const p of prepares) p(ctx);
  return runSort(pred ? rows.filter((r) => pred(r, ctx)) : rows, keys, ctx);
}

/** Footer aggregate over already filtered rows (`aggregate_expr`), returned
 *  as the server returns it: float(value) or null. */
export function aggregate(rows: Row[], agg: string, key: string): number | null {
  if (!(AGGREGATES as readonly string[]).includes(agg)) {
    throw new FilterError(`Unbekanntes Aggregat: ${pyRepr(agg)}`);
  }
  checkKey(key);
  if (agg === "count") return rows.length;
  const texts = rows.map((r) => textOf(r, key));
  switch (agg) {
    case "count_empty": return texts.filter((t) => t === null || t === "").length;
    case "count_not_empty": return texts.filter((t) => t !== null && t !== "").length;
    case "count_unique": return new Set(texts.filter((t) => t !== null)).size;
  }
  const nums = texts.map(numOf).filter((n): n is Dec => n !== null);
  if (nums.length === 0) return null;
  const sum = () => nums.reduce((acc, n) => addDec(acc, n), { int: 0n, scale: 0 } as Dec);
  const min = () => nums.reduce((a, b) => (cmpDec(b, a) < 0 ? b : a));
  const max = () => nums.reduce((a, b) => (cmpDec(b, a) > 0 ? b : a));
  switch (agg) {
    case "sum": return decToDouble(sum());
    case "avg": return decToDouble(divDecByCount(sum(), nums.length));
    case "min": return decToDouble(min());
    case "max": return decToDouble(max());
    default: return decToDouble(addDec(max(), min(), -1n));
  }
}

/** The aggregate endpoint's order: aggregate checks, then the filter. */
export function aggregateQuery(rows: Row[], agg: string, key: string, filters: unknown,
  fields: Record<string, number>, now?: Date, timeZone: "utc" | "local" = "utc"): number | null {
  if (!(AGGREGATES as readonly string[]).includes(agg)) {
    throw new FilterError(`Unbekanntes Aggregat: ${pyRepr(agg)}`);
  }
  checkKey(key);
  return aggregate(filterRows(rows, filters, fields, now, timeZone), agg, key);
}
