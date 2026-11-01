#!/usr/bin/env node
// Differential test: src/local/formula.ts against the server's formula engine.
//
// Every corpus expression is evaluated for several property sets in "de" and
// "en" by both implementations; the test fails on any difference in
//   - validate()  (FormulaError key, arguments and texts, or exception type),
//   - the Python-level result (int/float/str/bytes/complex kept apart),
//   - the client-visible JSON value (the server must always be able to send it).
//
// The reference runs the real packages/api/services/kb_formula.py (and
// sprache.py with the server's text catalogs). Point FORMULA_ORACLE at a shell
// command that runs Python 3.14 reading a script from stdin — ideally a
// throwaway container of the server's own image, which also reproduces its
// CPU-dependent libm (the pow variant follows the oracle's CPU), e.g.
//   FORMULA_ORACLE='docker run --rm -i --network none --entrypoint python docker-claraos-api -I -'
//   FORMULA_ORACLE='docker run --rm -i --network none python:3.14-slim python -I -'
// Default: `python3 -I -` (must be Python 3.14).
//
// Run: node packages/app-knowledge/test/formula.diff.mjs

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const claraos = resolve(appRoot, "..", "..");
const apiRoot = resolve(claraos, "packages", "api");

// ---- load formula.ts (transpiled with the repo's esbuild) ------------------

function findEsbuild() {
  const pnpm = join(claraos, "node_modules", ".pnpm");
  const dirs = readdirSync(pnpm).filter((d) => /^esbuild@\d/.test(d)).sort();
  if (!dirs.length) throw new Error("esbuild not found under " + pnpm);
  return createRequire(import.meta.url)(join(pnpm, dirs[dirs.length - 1], "node_modules", "esbuild"));
}
const esbuild = findEsbuild();
const tsSource = readFileSync(join(appRoot, "src", "local", "formula.ts"), "utf8");
const js = esbuild.transformSync(tsSource, { loader: "ts", format: "esm", target: "es2022" }).code;
const tmp = mkdtempSync(join(tmpdir(), "formula-diff-"));
writeFileSync(join(tmp, "formula.mjs"), js);
const F = await import(pathToFileURL(join(tmp, "formula.mjs")).href);
rmSync(tmp, { recursive: true, force: true });

// ---- corpus ------------------------------------------------------------------

const LONG = "x".repeat(2600);
const PROPS = [
  {},
  {
    Preis: "1200",
    Menge: 3,
    Rabatt: "10,5",
    Name: "Äpfel",
    Datum: "2024-02-29",
    Ende: "2024-12-31T10:00",
    Aktiv: true,
    Leer: "",
    Nichts: null,
    Tags: ["a", "B"],
    Obj: { x: 1, y: [1.5, null, "it's"] },
    Neg: -2.5,
    Big: 1e20,
    Euro: "1.234,56 €",
    Euro2: "19,99 €",
    Pct: "12%",
    Unicode: "٣٤٥",
    Space: " 42 ",
    Inf: "inf",
    NaN: "nan",
    Under: "1_000",
    Frac: 0.1,
    Zero: 0,
    NegZero: "-0",
    Emoji: "😀x",
    Sigma: "ΟΔΟΣ",
    Turk: "İstanbul",
    Date2: "２０２４-01-15",
    Bad: "2023-02-29",
    Long: LONG,
    Lone: "\ud800",
    Quote: 'say "hi"',
    Ctl: "a\tb\u0007\u00a0\u200b",
  },
  {
    Preis: 19.99,
    Menge: "abc",
    Rabatt: 0.25,
    Name: "",
    Datum: "",
    Ende: "2024-03-01",
    Aktiv: false,
    Tags: [],
    Obj: {},
    Neg: "-1e3",
    Big: 9007199254740991,
    Euro: "€5",
    Space: "\u3000 7\u2003",
    Zero: 0.0,
    Frac: 1.5,
    Date2: "2024-13-01",
  },
  {
    Preis: null,
    Menge: true,
    Name: "if (x)",
    Datum: "1999-12-31",
    Ende: "2000-01-01",
    Tags: ["x", 1, 2.5, true, null, { a: "b" }],
    Obj: { "k'": "v\"", n: -0.5 },
    Neg: "  -3,75  ",
    Big: -1e-7,
  },
];
const ROLLUPS = [{}, { Summe: 42.5, Anzahl: 7, Liste: [1, 2], Text: "x", Nan: "nan" }];

const S = (n) => "x".repeat(n);
const EXPRS = [
  // arithmetic and number formatting
  "1+1", "1+2*3", "7/2", "7//2", "-7//2", "7%3", "-7%3", "7%-3", "5.5%2", "-5.5//2", "7 // 'nan'", "7 % 'nan'", "'nan' // 2", "'inf' // 2", "7 // 'inf'", "-7 // 'inf'",
  "-7 % 'inf'", "7 % '-inf'", "'inf' % 2", "concat(0.0 // -3)", "concat(-0.0 % 5)", "1/0", "1//0", "1%0",
  "0/0", "0.0/0", "1/-0.0", "-1//-0.0", "2**10", "2**0.5", "2**-1", "(-8)**(1/3)", "(-2)**2", "(-2)**3",
  "(-2)**0.5", "concat((-8)**(1/3))", "concat((-2)**0.5)", "concat((-1000)**0.3)", "1000**2", "10**6",
  "10**7", "1001**2", "2**33", "2**32", "0**-1", "0**0", "0**2", "(-0.0)**3", "num('nan')**0",
  "num('nan')**2", "1**num('nan')", "1e308*10", "-0.0", "concat(-0.0)", "0.1+0.2", "concat(0.1+0.2)",
  "1e16", "1e15+0.3", "concat(1e16)", "concat(1e-5)", "concat(0.0001)", "concat(123456789.123456789)",
  "3.0", "concat(3.0)", "concat(3)", "10**-5", "concat(10**-5)", "1.1**10", "0.07**3", "2.5**2.5",
  "999.9**-31.5", "1e-20**-32", "1e-300**32", "concat(1e-300**2)", "3 - 5.5", "prop('Preis') * 1.19",
  "round(prop('Preis') * 1.19, 2)", "prop('Menge') / 3", "round(prop('Menge') / 3, 2)", "1e400",
  "concat(1e400)", "-1e400 + 1e400", "concat(2**0.5 * 2**0.5)",
  // round
  "round(2.5)", "round(3.5)", "round(-2.5)", "round(2.675, 2)", "round(0.125, 2)", "round(0.375, 2)",
  "round(1234.5678, -2)", "round(-0.4)", "concat(round(-0.4))", "round(1e300, -308)",
  "round(1.7976931348623157e308, -308)", "round(5, 400)", "round(5, -400)", "concat(round(5, -400))",
  "round(prop('Preis'), 'x')", "round(1.5, 1.9)", "round(num('nan'))", "round(1, num('nan'))",
  "round(1, num('inf'))", "round(123.456, 1e30)", "round(123.456, -1e30)", "round()", "round(1, 2, 3)",
  "concat(round(2.5))", "round(0.5)", "round(1.5)", "round(-1.5)", "round(2.5, 0)", "round(1e-320, 322)",
  "round(5e-324, 323)", "round(0.1 + 0.2, 15)", "round(1.0000000000000002, 16)",
  // abs / min / max
  "abs(-3)", "abs('-3,5')", "min(3, 1, 2)", "max()", "min()", "min(num('nan'), 1)", "min(1, num('nan'))",
  "max('10', 9)", "min(0.0, -0.0)", "concat(min(0.0, -0.0))", "concat(max(-0.0, 0.0))", "concat(abs(-0.0))",
  "max(prop('Preis'), prop('Menge'), prop('Neg'))",
  // len / concat / contains / empty
  "len('äöü')", "len('😀')", "len(prop('Tags'))", "len(0)", "len(prop('Obj'))", "len(1.5)", "len(prop('Emoji'))",
  "len(prop('Long'))", "concat('a', 1, 2.0, True, None, prop('Tags'))", "concat()", "concat(prop('Obj'))",
  "concat(prop('Long'), prop('Long'))", "prop('Long')", "prop('Long') + 'x'", "concat(prop('Quote'))",
  "concat(prop('Ctl'), prop('Tags'))", "concat([prop('Ctl')])", "concat(prop('Lone'))", "prop('Lone')",
  "len(prop('Lone'))", "contains('Hallo', 'ALL')", "contains(prop('Tags'), 'b')", "contains(prop('Sigma'), 'ς')",
  "contains(prop('Sigma'), 'σ')", "contains('İ', 'i')", "contains(prop('Turk'), 'istanbul')",
  "contains(None, 'none')", "contains(0, '')", "contains(prop('Emoji'), '\\ud83d')", "empty('')",
  "empty(prop('Tags'))", "empty(prop('Leer'))", "empty(0)", "empty(prop('Nichts'))", "empty(prop('fehlt'))",
  "empty(prop('Obj'))", "empty(False)",
  // prop / rollup and text-as-number
  "prop('Preis') * prop('Menge')", "prop('Preis') + prop('Menge')", "prop('Name') + prop('Menge')",
  "prop('Name') * 2", "prop('Euro') * 1", "prop('Euro2') * 2", "prop('Rabatt') * 1", "prop('Unicode') * 1",
  "prop('Space') + 0", "prop('Inf') * 1", "prop('NaN') + 0", "prop('Under') * 1", "prop('Pct') * 1",
  "prop('NegZero') * 1", "concat(prop('NegZero') * 1)", "prop('Neg') * 2", "prop('Big')", "prop('Big') + 1",
  "concat(prop('Big'))", "prop(1)", "prop(None)", "prop()", "rollup('Summe') + 1", "rollup('fehlt')",
  "rollup('Liste')", "rollup('Text') * 2", "rollup('Anzahl') / 2", "rollup('Nan') * 1", "prop('Obj')",
  "prop('Tags')", "prop('Nichts')", "prop('Aktiv')", "prop('Frac')", "prop('Zero')", "num(prop('Date2'))",
  "num('1e5')", "num('.5')", "num('5.')", "num('1_0.5')", "num('_1')", "num('1__0')", "num('0x10')",
  "num('Infinity')", "num('-inf')", "num(' 12 ')", "num('١٢')", "num('１２.５')", "num(True)",
  "num(prop('Tags'))",
  // if() rewrite and conditionals
  "if(prop('Aktiv'), 'ja', 'nein')", "if (1 > 2, 'a', 'b')", "IF(1, 2, 3)", "concat('if (x')",
  "elif(1, 2, 3)", "_if(1, 2, 3)", "éif(1, 2, 3)", "iif(0, 1)", "1 if 2 else 3", "'x' if prop('Leer') else 'y'",
  "if(1, 2, 3) if 0 else 4", "if(prop('Menge') > 2, 'viel', 'wenig')", "if\u3000(1, 2, 3)", "if\t\n(1,2,3)",
  // comparisons and boolean logic
  "1 == 1.0", "1 == 1", "'1' == 1", "prop('Menge') == 3", "True == 'True'", "1 < 2 < 3", "3 > 2 > 2",
  "'10' > '9'", "'abc' < 1", "None == 'None'", "num('nan') == num('nan')", "num('nan') < 1", "1 != 2",
  "prop('Tags') == \"['a', 'B']\"", "prop('Big') == 1e20", "not 0", "not ''", "not 'a'", "1 and 0", "1 or 0",
  "prop('Aktiv') and prop('Menge')", "0 and 1/0", "0 and round()", "not num('nan')", "1 < prop('Nichts')",
  "0.1 + 0.2 == 0.3",
  // names
  "true", "false", "null", "foo", "ｐｒｏｐ('Preis')", "Ｔｒｕｅ", "x_1", "ﬁ", "match", "_",
  // dates
  "days_between('2024-01-01', '2024-12-31')", "days_between(prop('Datum'), prop('Ende'))",
  "days_between('2023-02-29', '2024-01-01')", "days_between(prop('Date2'), '2024-01-01')",
  "days_between('0000-01-01', '2024-01-01')", "days_between('9999-12-31', '0001-01-01')",
  "days_between('', '2024-01-01')", "days_between(20240101, '2024-01-01')", "days_until('2099-01-01') > 0",
  "days_until(today())", "today()", "len(today())", "days_between('2024-1-01', '2024-01-02')",
  "days_between('2024-02-30x', '2024-03-01')", "days_until(prop('Datum'))", "days_between(prop('Bad'), today())",
  // unary
  "-'5'", "+'5'", "-prop('Leer')", "--5", "-(-0.0)", "concat(-prop('Zero'))", "not not 1", "-True",
  // literals
  "'a' + 'b'", "'a' 'b'", "b'x'", "b'x' + 'y'", "concat(b'\\xff')", "b'\\xff'", "b'abc'", "'\\x41'",
  "'\\u00e4'", "'\\N{BULLET'", "'\\x4'", "'\\U00110000'", "'\\d'", "r'\\d'", "'\\101'", "'\\777'",
  "u'x'", "rb'\\x'", "b'\\x4'", "b'ä'", "'''tri'''", "'a' * 3", "'1' * '2'", "'ab' - 'a'", "'%s' % 1",
  "'\\\\'", "'a\\\nb'", "'\\ud800'", "'\\N{}'", "'\\Nx'", "\"it's\"", "concat(\"it's\", 'say \"x\"')", "b'\\777'",
  "1j", "concat(1j)", "concat(2.5j)", "concat(1e400j)", "...", "concat(...)", "0x1F", "0o17", "0b101",
  "1_000_000", "concat(0xFFFFFFFFFFFFFFFFFFFF)", "123456789012345678901234567890",
  "concat(123456789012345678901234567890)", "num(123456789012345678901234567890)", "num(1" + "0".repeat(400) + ")",
  "09.5", "0e0", "1E3", "1.e2", ".5", "concat(5.)",
  // rejected syntax (node types)
  "[1, 2]", "(1, 2)", "1,", "{1: 2}", "{1}", "{}", "()", "x.y", "x[0]", "x[1:2]", "prop('a').upper()",
  "lambda: 1", "lambda x, *y, z=1, **k: x", "[x for x in y]", "(x for x in y)", "{x: 1 for x in y}",
  "{x for x in y}", "f'{1}'", "f'a' 'b'", "t'{1}'", "(x := 1)", "1 | 2", "1 & 2", "1 ^ 2", "1 << 2",
  "1 >> 2", "1 @ 2", "~1", "1 in [1]", "1 is 1", "1 not in 2", "1 is not 2", "await x", "(yield)",
  "(yield from x)", "prop(*a)", "prop(a=1)", "prop(**a)", "foo(1)", "prop('a')(1)", "(prop)('Preis')",
  "sum(1)", "round(1, n=2)", "prop(x for x in y)", "1 + [2]", "abs(-1) + {1}", "1 if 2 else [3]",
  "f'{x!r:>{w}}'", "f'{x=}'", "f\"{'a' 'b'}\"",
  // limits
  "+".repeat(0) + Array(80).fill("1").join("+"), Array(67).fill("1").join("+"), Array(66).fill("1").join("+"),
  "abs(".repeat(15) + "1" + ")".repeat(15), "abs(".repeat(14) + "1" + ")".repeat(14), "-".repeat(14) + "1",
  "-".repeat(15) + "1", "-".repeat(499) + "1", "-".repeat(497) + "1 1", "not ".repeat(100) + "1",
  "(".repeat(31) + "1" + ")".repeat(31), "(".repeat(31) + "1 1" + ")".repeat(31),
  "[".repeat(31) + "-".repeat(400) + "*" + "]".repeat(31), "{".repeat(31) + "1:" + "}".repeat(31),
  "(".repeat(31) + "lambda:".repeat(50) + "1 2" + ")".repeat(31), "f(".repeat(31) + "1 1" + ")".repeat(31),
  "{1:".repeat(31) + "1 1" + "}".repeat(31), "abs(".repeat(31) + "1" + ")".repeat(31),
  "1+" .repeat(250) + "1", "1+".repeat(249) + "1", "'" + S(498) + "'", "'" + S(499) + "'", "", "   ", "\n",
  "\t", "# only comment", "1 # comment", "x" + "ä".repeat(499), "x" + "ä".repeat(500),
  // syntax errors
  "1 +", "(1", "1)", "(1]", "(1\n]", "'abc", "\"abc", "'''abc", "1 2", "prop('a' prop('b'))", "a b",
  "1 if 2", "1 if 2 else", "print 1", "print(1) 2", "x = 1", "x == = 1", "f(x=1, 2)", "f(**x, *y)",
  "f(x for x in y, 1)", "f(a, b for b in c)", "f(a=1 for a in b)", "1 + not 2", "- not 1", "f'{'", "f'{}'",
  "f'{1!x}'", "f'{1!}'", "f'{1! r}'", "f'{1'", "f'}'", "f'{1:{2}}'", "f'{1:\n}'", "f'''{1:\n}'''", "{1: *a}",
  "{1:}", "{1: 2, 3}", "[*a for a in b]", "[a, b for a in c]", "(*a)", "(**a)", "lambda (x): 1",
  "lambda x=1, y: 1", "lambda *: 1", "lambda **k, a: 1", "1 + € 2", "prop('a') × 2", "1\u00a0+ 2", "\u0001",
  " 1", "1\n2", "1\n", "(1\n+2)", "1 \\\n+ 2", "1 \\ 2", "'a' if", "if", "else", "not", "1 not 2", "x.", "x..y",
  "1..2", "1.__class__", "0b2", "0o8", "0xg", "0x", "0b", "0o", "1e+", "1_", "1__0", "007", "00", "1abc",
  "1if 1 else 2", "1else", "ub''", "bf''", "ft''", "'\\'", "\"abc\ndef\"", "a\u0000b", "'a' 'b' + 'c' 'd'",
  "'a' 1 'b'", "1 <> 2", "a := 1", "*a", "**a", "1 = 2", "f(1 = 2)", "f(True=1)", "f(a.b=1)", "f(**a=1)",
  "f(*a=1)", "(a, b) = 1", "[x for x in]", "[x for in y]", "[x for 1 in y]", "for x in y", "print",
  "exec 'x'", "f(a b)", "f(a, b c)", "[1 2]", "{1 2}", "(1 2)", "f'{lambda x: 1}'", "f'{yield}'",
  "pass if 1 else 2", "1 if 2 else pass", "a.1", "1.e", "1j2", "0_1", "1e1_0", "1e_1", "'a' ' b' 1",
  "f(**)", "f(*)", "f(,)", "f(1,,2)", "(,)", "[,]", "1 +* 2", "x[]", "x()()", "1 if else 2",
  "'unterminated\n'", "(1\n", "[1, 2\n", "{'a': 1\n", "())", "f'{x!s:{y!r}}'", "t'a' 'b'", "'a' t'b'",
  "f'{x:{y:{z}}}'", "f'{{}}'", "f'}}'", "f'{'a'}'", "f'{\"a\"}'", "f'\\N{BULLET}'", "rf'\\N{x}'",
  "1 if 2 else 3 if 4", "not", "(not)", "-", "**2", "2**", "2***3", "x[1:2:3:4]", "x[*a]", "x[a:=1]",
  "\\", "1\\", "\u200b", "\ufeff1", "a\u200bb", "1 < > 2", "1 <>2", "1 <\n> 2", "(1 <\n> 2)", "1 <= > 2",
];

// Server fixes: if( only as a call token, finite numbers, numeric ==,
// rejected constants and complex powers, parse errors as syntax errors.
EXPRS.push(
  "concat('if (x')", "'if(' + 'x'", "if(1, 'if (a)', 'b')", "if (1, 2, 3) # if (comment", "1 # if(x)\n",
  "if(1,\n 2, 3)", "(if\n(1, 2, 3))", "if  (1, 2, 3)", "if\t(1, 2, 3)", "IF(1, 2, 3)", "elif(1, 2, 3)",
  "x.if(1)", "f'{if(1, 2, 3)}'", "f'if(1,2,3)'", "if(1, 2, 3) + 'abc", "if(1, 2, 3) + 1abc", "if(1, 2, 3)) + 1",
  "if(1, 2, 3)]", "if(1, 2, (3]", "if(1, 2, 3) + 0777", "if(1, 2, 3) + €", "\u00a0if(1, 2, 3)",
  "if(1,2,3)\r+ 1", "1\rif(1, 2, 3)", "1 +\u2028if(1, 2, 3)", "(1 +\u0085if(1, 2, 3))", "(1 +\fif(1, 2, 3))",
  "(1,\nif(1, 2, 3))", "(1,\v\nif(1, 2, 3))", " if(1, 2, 3)", "if(1, 2, 3)\n  ", "if(if(1, 2, 3), 4, 5)",
  "ｉｆ(1, 2, 3)", "if(1, 2, 3) \\\n+ 1", "if(1, 2, 3) + '\ud800'", "if(1, '\\x4', 3)",
  "num('nan')", "num('inf')", "num('-Infinity') + 1", "prop('Inf') + 1", "prop('NaN') == 0", "min(num('nan'), 1)",
  "round(1, num('nan'))", "1e308 * 10", "-1e400", "1e308 * 10 - 1e308 * 10", "concat(1e308 * 10)",
  "1e308 * 10 == 1e400", "concat(prop('Inf'))", "num('nan') == num('nan')", "(-8) ** (1 / 3)", "(-2) ** 0.5",
  "(-1e-20) ** -31.5", "(-1e-20) ** 31.5", "concat((-8) ** (1 / 3))", "...", "b''", "b'x'", "1j", "concat(1j)",
  "iif(1, ..., 2)", "0 and b'x'", "1 == 1.0", "1 != 1.0", "'1,5' == 1.5", "'' == 0", "None == 0", "True == 'True'",
  "True == 1", "'1e3' == 1000", "' 3 ' == 3", "'3€' == 3", "'abc' == 'abc'", "'nan' == 'nan'", "'inf' == 1e400",
  "prop('Menge') == '3'", "prop('Preis') == 1200", "prop('Euro2') == 19.99", "prop('Tags') == 0",
  "prop('Big') == 1e20", "10**400 == 1", "1 == 2 == 2", "prop('Lone')", "concat(prop('Lone'))", "'\ud800'",
  "'a\ud800b' + 'c'", "[prop('Lone')]", "prop('Tags')", "a\u0000b", "'\u0000'", "1 +\u0000 2", "Ｔｒｕｅ",
  "Ｎｏｎｅ + 1", "f'{1:\\x4}'", "f'{1:\\N{x}}'",
  "f'{x:{y:{z=}}}'", "t'{x:{y:{z=}}}'", "f'{x:{y:{z=!r}}}'", "f'{x:{y:{z=:>3}}}'", "f'{x:{y=}}'", "f'{x=:{y=}}'",
  "t'{x:{y:{z}}}'", "f'{x=!r:{y}}'", "t'{x=}'", "f'{x = }'", "f'{x!=y=}'",
);
// Cases where formula.ts must refuse instead of guessing.
const NOT_PORTABLE = new Set([
  "'\\N{BULLET}'", "f'\\N{BULLET}'", "'\\N{BLLET}'", "pass if 1 else 2", "f'{1:\\N{x}}'",
  "(".repeat(32) + "1" + ")".repeat(32), "(".repeat(119) + "1 1" + ")".repeat(119),
  "(".repeat(193) + "1 1" + ")".repeat(193),
  "[".repeat(199) + "]".repeat(199), "(".repeat(200) + "1" + ")".repeat(200),
]);
EXPRS.push(...NOT_PORTABLE);

const cases = [];
for (const expr of EXPRS) {
  for (let pi = 0; pi < PROPS.length; pi++) {
    for (const lang of ["de", "en"]) {
      cases.push({ expr, pi, ri: pi % 2, lang });
    }
  }
}

// ---- reference side ------------------------------------------------------------

function readTree(dir, rel, files) {
  for (const name of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${name.name}` : name.name;
    if (name.isDirectory()) readTree(dir, r, files);
    else files[r] = readFileSync(join(dir, r), "utf8");
  }
}
const files = {
  "services/__init__.py": "",
  "services/kb_formula.py": readFileSync(join(apiRoot, "services", "kb_formula.py"), "utf8"),
  "sprache.py": readFileSync(join(apiRoot, "sprache.py"), "utf8"),
};
const locales = {};
readTree(join(apiRoot, "locales"), "", locales);
for (const [k, v] of Object.entries(locales)) if (k.endsWith("server.json")) files[`locales/${k}`] = v;

const payload = Buffer.from(JSON.stringify({ files, cases, props: PROPS, rollups: ROLLUPS })).toString("base64");
const script =
  "_EMBEDDED = True\n" +
  readFileSync(join(here, "formula_oracle.py"), "utf8") +
  `\nimport base64 as _b64\nrun(json.loads(_b64.b64decode("${payload}").decode("utf-8")))\n`;
const oracleCmd = process.env.FORMULA_ORACLE || "python3 -I -";
const proc = spawnSync("sh", ["-c", oracleCmd], { input: script, maxBuffer: 1 << 30, encoding: "utf8" });
if (proc.status !== 0) {
  console.error(proc.stderr);
  throw new Error(`oracle failed (${oracleCmd}), exit ${proc.status}`);
}
const oracle = JSON.parse(proc.stdout);
if (!/^3\.14\./.test(oracle.python)) {
  throw new Error(`oracle runs Python ${oracle.python}; the server runs 3.14 — set FORMULA_ORACLE`);
}
if (!/^3\.14\.10\b/.test(oracle.python)) {
  console.log(
    `NOTE: formula.ts follows CPython 3.14.10 (the server's version); this oracle runs ${oracle.python.split(" ")[0]}. ` +
      "Syntax error texts can differ between patch releases (3.14.7 has no message for '<>').",
  );
}
if (oracle.kb_formula_sha256 !== createHash("sha256").update(files["services/kb_formula.py"]).digest("hex")) {
  throw new Error("the oracle did not evaluate the working-tree kb_formula.py");
}
if (oracle.results.length !== cases.length) throw new Error("oracle returned a different number of results");

// ---- compare --------------------------------------------------------------------

F.setPowVariant(oracle.fma);
F.setTodayProvider(() => oracle.today);

function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",")}}`;
  }
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : JSON.stringify(v);
  return JSON.stringify(v);
}

let mismatches = 0;
let notPortable = 0;
const shown = new Set();
const report = (i, what, py, ts) => {
  mismatches++;
  const c = cases[i];
  const key = `${c.expr}|${what}`;
  if (shown.has(key) || shown.size > 60) return;
  shown.add(key);
  console.log(`MISMATCH ${what}: ${JSON.stringify(c.expr)} props#${c.pi} ${c.lang}`);
  console.log(`   python: ${JSON.stringify(py)}`);
  console.log(`   ts:     ${JSON.stringify(ts)}`);
};

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const py = oracle.results[i];
  let tsValidate, tsRaw, tsClient;
  try {
    tsValidate = F.validateTagged(c.expr);
    tsRaw = F.evaluateTagged(c.expr, PROPS[c.pi], ROLLUPS[c.ri], c.lang);
    tsClient = canon(JSON.parse(JSON.stringify(F.evaluate(c.expr, PROPS[c.pi], ROLLUPS[c.ri], c.lang))));
  } catch (e) {
    if (e instanceof F.FormulaNotPortable && NOT_PORTABLE.has(c.expr)) {
      notPortable++;
      continue;
    }
    report(i, "exception", py, String(e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
    continue;
  }
  if (NOT_PORTABLE.has(c.expr)) report(i, "expected FormulaNotPortable", py.raw, tsRaw);
  if (canon(py.validate) !== canon(tsValidate)) report(i, "validate", py.validate, tsValidate);
  if (canon(py.raw) !== canon(tsRaw)) report(i, "raw", py.raw, tsRaw);
  const pyClient = typeof py.client === "string" ? canon(JSON.parse(py.client)) : "UNSERIALISABLE";
  if (pyClient !== tsClient) report(i, "client", pyClient, tsClient);
}

console.log(
  `formula diff: ${EXPRS.length} expressions, ${cases.length} cases (x3 checks), ` +
    `oracle Python ${oracle.python.split(" ")[0]}, pow variant ${oracle.fma ? "fma" : "sse2"}, ` +
    `${notPortable} refused as not portable (expected), ${mismatches} mismatches`,
);
process.exit(mismatches ? 1 : 0);
