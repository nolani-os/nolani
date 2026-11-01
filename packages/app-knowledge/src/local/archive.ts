/**
 * Import of Notion/Markdown exports and export as ZIP — the device-local twin
 * of services/kb_import.py. Same file layout, same CSV dialect (Python's
 * `csv` module: minimal quoting, CRLF line ends), same link rewriting, so an
 * archive moves between the app and a cell without surprises.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const NOTION_ID_RE = /\s+([0-9a-f]{32})(?:_all)?$/i;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

export type ParsedPage = {
  notion_id: string | null; title: string; body: string;
  parent_notion_id: string | null; source_name: string;
};
export type ParsedDatabase = {
  notion_id: string | null; name: string; columns: string[];
  rows: { title: string; props: Record<string, string> }[]; source_name: string;
};

function stripNotionId(name: string): [string, string | null] {
  const stem = name.replace(/\.(md|csv)$/i, "");
  const m = stem.match(NOTION_ID_RE);
  if (m && m.index !== undefined) return [stem.slice(0, m.index).trim(), m[1].toLowerCase()];
  return [stem.trim(), null];
}

const splitLines = (s: string) => s.split(/\r\n|\r|\n/);

function firstHeading(md: string): string | null {
  for (const line of splitLines(md || "")) {
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return null;
}

function dropLeadingHeading(md: string, title: string): string {
  const lines = splitLines(md || "");
  if (lines.length && lines[0].trim() === `# ${title}`) {
    const rest = lines.slice(1);
    while (rest.length && !rest[0].trim()) rest.shift();
    return rest.join("\n");
  }
  return md;
}

/** Python `str[:n]` counts code points. */
const cut = (s: string, n: number) => [...s].slice(0, n).join("");

/** RFC 4180 reader in the spirit of Python's csv module (excel dialect). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += c;
    }
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === "") && r.length > 0);
}

/** csv.DictReader semantics: first row = header; missing cells → null, extra cells dropped. */
function dictRows(text: string): { fieldnames: string[]; rows: Record<string, string | null>[] } {
  const all = parseCsv(text);
  if (!all.length) return { fieldnames: [], rows: [] };
  const [header, ...body] = all;
  return {
    fieldnames: header,
    rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, i < r.length ? r[i] : null]))),
  };
}

export function parseZip(data: Uint8Array): { pages: ParsedPage[]; databases: ParsedDatabase[] } {
  const files = unzipSync(data);
  const allNames = Object.keys(files);
  const names = allNames.filter((n) => !n.endsWith("/"));
  // Only explicit directory entries, as in the server's parser
  const dirs = new Set(allNames.filter((n) => n.endsWith("/")).map((n) => n.replace(/\/+$/, "")));
  const folderIds = new Map<string, string>();
  for (const d of dirs) {
    const [, nid] = stripNotionId(d.split("/").pop()!);
    if (nid) folderIds.set(d, nid);
  }
  const csvAll = names.filter((n) => n.toLowerCase().endsWith("_all.csv")).map((n) => n.toLowerCase());
  const pages: ParsedPage[] = [];
  const databases: ParsedDatabase[] = [];
  for (const name of names) {
    const low = name.toLowerCase();
    const parentDir = name.split("/").slice(0, -1).join("/");
    const parentId = folderIds.get(parentDir) ?? null;
    const base = name.split("/").pop()!;
    let [title, nid] = stripNotionId(base);
    if (low.endsWith(".md")) {
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(files[name]);
      title = firstHeading(raw) ?? title;
      pages.push({
        notion_id: nid, title: cut(title, 300) || "Ohne Titel",
        body: dropLeadingHeading(raw, title), parent_notion_id: parentId, source_name: base,
      });
    } else if (low.endsWith(".csv")) {
      if (!low.endsWith("_all.csv") && csvAll.some((c) => c.startsWith(low.slice(0, -4)))) continue;
      let raw = new TextDecoder("utf-8", { fatal: false }).decode(files[name]);
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const { fieldnames, rows: dr } = dictRows(raw);
      const cols = fieldnames.filter((c) => c);
      const rows = dr.map((r) => {
        const vals: Record<string, string> = {};
        for (const [k, v] of Object.entries(r)) if (k) vals[k] = (v ?? "").trim();
        const rowTitle = (cols.length ? vals[cols[0]] ?? "" : "") || "Ohne Titel";
        const props: Record<string, string> = {};
        for (const [k, v] of Object.entries(vals)) if (k !== (cols[0] ?? "") && v) props[k] = v;
        return { title: cut(rowTitle, 300), props };
      });
      databases.push({
        notion_id: nid, name: cut(title, 200) || "Import", columns: cols.slice(1), rows, source_name: base,
      });
    }
  }
  return { pages, databases };
}

/** Guess the column type from the values (0 text, 1 number, 2 date, 4 multi_select). */
export function guessFieldType(values: string[]): number {
  const vals = values.filter((v) => v);
  if (!vals.length) return 0;
  if (vals.every((v) => /^-?\d+([.,]\d+)?\s*€?$/u.test(v))) return 1;
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}([ T][\s\S]*)?$/u.test(v))) return 2;
  if (vals.some((v) => v.includes(",")) && vals.every((v) => [...v].length < 120)) return 4;
  return 0;
}

/** Notion file links → `#kb-<uuid>` (our mention form). */
export function rewriteLinks(body: string, idMap: Map<string, string>): string {
  return (body || "").replace(MD_LINK_RE, (whole, label: string, target: string) => {
    if (/^(https?:\/\/|#|claraos:\/\/)/.test(target)) return whole;
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      /* keep as is, like urllib's lenient unquote */
    }
    const [, nid] = stripNotionId(decoded.split("/").pop()!);
    if (nid && idMap.has(nid)) return `[${label}](#kb-${idMap.get(nid)})`;
    return whole;
  });
}

/** Python's `\w` (Unicode) for the file-name sanitizer. */
const unsafe = /[^\p{L}\p{N}_ \-().]/gu;

/** Python `str(value)` for property values in the export. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  // JSON has no int/float distinction; a whole number below 1e16 reads as Python int.
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(v) : pyFloat(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  }
  return String(v);
}

/** Python's float repr: shortest round-trip digits, exponent form below 1e-4 and from 1e16. */
function pyFloat(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  const [mant, expStr] = v.toExponential().split("e");
  const exp = Number(expStr);
  if (exp < -4 || exp >= 16) {
    return `${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const s = v.toFixed(Math.max(0, (mant.split(".")[1]?.length ?? 0) - exp));
  return s.includes(".") ? s : `${s}.0`;
}

function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
  }
  return pyStr(v);
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildExportZip(
  objects: { title: string; body: string; properties: Record<string, unknown> }[],
  collections: { name: string; columns: string[]; rows: { title: string; props: Record<string, string> }[] }[] = [],
): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const o of objects) {
    const safe = cut(o.title.replace(unsafe, "_"), 120) || "objekt";
    let fname = `${safe}.md`;
    for (let i = 2; used.has(fname); i++) fname = `${safe} (${i}).md`;
    used.add(fname);
    const front = [`# ${o.title}`, ""];
    const props = o.properties ?? {};
    if (Object.keys(props).length) {
      front.push("<!-- Eigenschaften");
      for (const [k, v] of Object.entries(props)) front.push(`${k}: ${pyStr(v)}`);
      front.push("-->", "");
    }
    files[fname] = strToU8(front.join("\n") + (o.body || ""));
  }
  for (const c of collections) {
    const cols = c.columns ?? [];
    const lines = [["Titel", ...cols], ...c.rows.map((r) => [r.title ?? "", ...cols.map((k) => r.props?.[k] ?? "")])];
    const csv = lines.map((l) => l.map(csvCell).join(",") + "\r\n").join("");
    const safe = cut(c.name.replace(unsafe, "_"), 120) || "sammlung";
    files[`${safe}.csv`] = strToU8(csv);
  }
  return zipSync(files, { level: 6 });
}

export { strFromU8 };
