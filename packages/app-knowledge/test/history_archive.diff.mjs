// Differential test: src/local/diff.ts and src/local/archive.ts against the
// server's services/kb_diff.py and services/kb_import.py.
//
// Run (python3 and node 20; no network, no containers):
//
//   node packages/app-knowledge/test/history_archive.diff.mjs   (from projects/claraos)
//
// Diff: 400+ generated text pairs, ops and summary must be identical.
// Archive: the same objects/collections exported by both sides (file names
// and file contents compared after unzipping), the same Notion-like archive
// parsed by both, links rewritten, field types guessed. Exit code 0 means
// zero mismatches.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const API = resolve(APP, "../api");
const pnpm = resolve(APP, "../../node_modules/.pnpm");
const esbuildDir = readdirSync(pnpm).filter((d) => /^esbuild@\d/.test(d)).sort().pop();
if (!esbuildDir) throw new Error("esbuild not found under " + pnpm);
const esbuild = createRequire(import.meta.url)(join(pnpm, esbuildDir, "node_modules/esbuild"));

const work = mkdtempSync(join(tmpdir(), "kb-hist-arc-"));
try {
  const bundle = (entry, out) => esbuild.buildSync({
    entryPoints: [join(APP, entry)], bundle: true, format: "esm", platform: "node", target: "node20",
    outfile: join(work, out), nodePaths: [join(APP, "node_modules")], logLevel: "warning",
  });
  bundle("src/local/diff.ts", "diff.mjs");
  bundle("src/local/archive.ts", "archive.mjs");
  const { diffMarkdown, summarize } = await import(pathToFileURL(join(work, "diff.mjs")).href);
  const { buildExportZip, parseZip, rewriteLinks, guessFieldType, strFromU8 } =
    await import(pathToFileURL(join(work, "archive.mjs")).href);
  const { unzipSync } = createRequire(join(APP, "package.json"))("fflate");

  const oracle = String.raw`
import io, json, random, sys, zipfile
sys.path.insert(0, sys.argv[1])
import kb_diff, kb_import
out = sys.argv[2]
random.seed(7)
words = ["Haus", "Garten", "über", "die", "Kosten", "123", "€", "\n", "  ", "- Punkt", "**fett**",
         "Ölpreis", "naïve", "🎉", "end.", "\t", "a", "b", "c"]
def rnd(n):
    return "".join(random.choice(words) + random.choice([" ", "", "\n", "  "]) for _ in range(n))
pairs = [("", ""), ("", "neu"), ("alt", ""), ("gleich", "gleich"), ("a b c d e", "a x c d y"),
         ("1 2 3 4 5 6 7 8", "1 2 X 4 5 Y 7 8"), ("eins\nzwei\ndrei", "eins\nZWEI\ndrei\nvier"),
         ("  führend", "führend  "), ("🎉 a 🎉", "🎉 b 🎉")]
for _ in range(400):
    a = rnd(random.randint(0, 40))
    b = a.split(" ")
    for _ in range(random.randint(0, 8)):
        op = random.random()
        if op < .3 and b: b.pop(random.randrange(len(b)))
        elif op < .6: b.insert(random.randint(0, len(b)), random.choice(words))
        elif b: b[random.randrange(len(b))] = random.choice(words)
    pairs.append((a, " ".join(b)))
diffs = [{"ops": kb_diff.diff_markdown(a, b), "summary": kb_diff.summarize(kb_diff.diff_markdown(a, b))}
         for a, b in pairs]
objs = [
  {"title": "Einkauf/Liste: Öl & Brot", "body": "- Brot\n- Öl", "properties": {"preis": 3.5, "n": 2,
   "ok": True, "tags": ["a", "b's"], "leer": None, "x": {"k": 1}, "big": 1e20, "klein": 1e-05}},
  {"title": "Einkauf/Liste: Öl & Brot", "body": "Duplikat", "properties": {}},
  {"title": "", "body": "", "properties": {"emoji": "🎉"}},
  {"title": 'Notiz 🎉 mit "Quote"', "body": "Text\r\nmit CRLF", "properties": {"neg": -0.25}},
]
colls = [{"name": "Rezepte/2026", "columns": ["Dauer", "Notiz, lang"], "rows": [
  {"title": "Braten", "props": {"Dauer": "90", "Notiz, lang": 'mit "Soße"\nzweite Zeile'}},
  {"title": "Salat, grün", "props": {"Dauer": ""}}]}]
z = zipfile.ZipFile(io.BytesIO(kb_import.build_export_zip(objs, colls)))
export = {n: z.read(n).decode() for n in z.namelist()}
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as zf:
    zf.writestr("Projekt abcdef0123456789abcdef0123456789/", "")
    zf.writestr("Projekt abcdef0123456789abcdef0123456789.md", "# Projekt\n\n\nSiehe [Unterseite](Projekt%20abcdef0123456789abcdef0123456789/Unter%2011111111111111111111111111111111.md) und [web](https://x.de)")
    zf.writestr("Projekt abcdef0123456789abcdef0123456789/Unter 11111111111111111111111111111111.md", "# Unterseite\nInhalt")
    zf.writestr("Aufgaben 22222222222222222222222222222222.csv", '﻿Name,Status,Preis,Datum,Tags\nA,offen,"1,5",2026-01-02,"x, y"\nB,,3 €,2026-02-03,z\n"C ""q""",zu,4,2026-03-04 10:00,\n')
    zf.writestr("Aufgaben 22222222222222222222222222222222_all.csv", 'Name,Status,Preis,Datum,Tags,Extra\nA,offen,"1,5",2026-01-02,"x, y",e\n')
    zf.writestr("Lose.md", "kein Titel hier")
open(out + "/import.zip", "wb").write(buf.getvalue())
p = kb_import.parse_zip(buf.getvalue())
idmap = {pg["notion_id"]: "00000000-0000-0000-0000-%012d" % i for i, pg in enumerate(p["pages"]) if pg["notion_id"]}
p["rewritten"] = [kb_import.rewrite_links(pg["body"], idmap) for pg in p["pages"]]
p["types"] = [kb_import.guess_field_type([r["props"].get(c, "") for r in d["rows"]]) for d in p["databases"] for c in d["columns"]]
guess_in = [["1"], ["1,5", "2 €"], ["2026-01-01"], ["a, b"], ["a"], [], ["", ""], ["-3.25"]]
p["guess"] = [kb_import.guess_field_type(v) for v in guess_in]
json.dump({"pairs": pairs, "diffs": diffs, "objs": objs, "colls": colls, "export": export,
           "parsed": p, "idmap": idmap, "guess_in": guess_in}, open(out + "/ref.json", "w"), ensure_ascii=False)
`;
  writeFileSync(join(work, "oracle.py"), oracle);
  execFileSync("python3", ["-I", join(work, "oracle.py"), join(API, "services"), work], { stdio: "inherit" });
  const ref = JSON.parse(readFileSync(join(work, "ref.json"), "utf8"));

  let bad = 0;
  const cmp = (label, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) {
      if (bad++ < 5) console.log(`MISMATCH ${label}\n  ts ${g.slice(0, 400)}\n  py ${w.slice(0, 400)}`);
    }
  };
  ref.pairs.forEach(([a, b], i) => {
    const ops = diffMarkdown(a, b);
    cmp(`diff #${i}`, { ops, summary: summarize(ops) }, ref.diffs[i]);
  });
  const files = unzipSync(buildExportZip(ref.objs, ref.colls));
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  cmp("export", sorted(Object.fromEntries(Object.entries(files).map(([n, d]) => [n, strFromU8(d)]))), sorted(ref.export));
  const deep = (o) => Array.isArray(o) ? o.map(deep)
    : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, deep(o[k])])) : o;
  const p = parseZip(new Uint8Array(readFileSync(join(work, "import.zip"))));
  const idmap = new Map(Object.entries(ref.idmap));
  p.rewritten = p.pages.map((pg) => rewriteLinks(pg.body, idmap));
  p.types = p.databases.flatMap((d) => d.columns.map((c) => guessFieldType(d.rows.map((r) => r.props[c] ?? ""))));
  p.guess = ref.guess_in.map(guessFieldType);
  cmp("import", deep(p), deep(ref.parsed));

  console.log(`history/archive diff: ${ref.pairs.length} diff pairs, export + import compared, ${bad} mismatches`);
  process.exitCode = bad ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
}
