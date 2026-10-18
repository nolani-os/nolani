"""Knowledge store: import from Notion/Markdown exports + export.

Notion exports "Markdown & CSV" as a ZIP:
    Page title <32-hex-id>.md           -> one page
    Page title <32-hex-id>/             -> subpages of that page
    Database name <32-hex-id>.csv       -> one database (rows = objects)
    Database name <32-hex-id>_all.csv   -> variant with all columns (preferred)
Links between pages appear as URL-encoded file names in the Markdown.

Import strategy:
  1. pass: create all pages/databases, remember Notion ID -> our UUID
  2. pass: rewrite links in the Markdown to `#kb-<uuid>` (our mention form —
     the post-save hook turns them into real backlinks)
Rule as in SiYuan: IDs are assigned where none exist and preserved where
they come along.
"""
from __future__ import annotations

import csv
import io
import re
import urllib.parse
import zipfile

NOTION_ID_RE = re.compile(r"\s+([0-9a-f]{32})(?:_all)?$", re.I)
MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")


def _strip_notion_id(name: str) -> tuple[str, str | None]:
    """'Meine Seite abc123…' → ('Meine Seite', 'abc123…')"""
    stem = re.sub(r"\.(md|csv)$", "", name, flags=re.I)
    m = NOTION_ID_RE.search(stem)
    if m:
        return stem[: m.start()].strip(), m.group(1).lower()
    return stem.strip(), None


def _first_heading(md: str) -> str | None:
    for line in (md or "").splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return None


def _drop_leading_heading(md: str, title: str) -> str:
    """Notion repeats the title as H1 — that would be duplicated here."""
    lines = (md or "").splitlines()
    if lines and lines[0].strip() == f"# {title}":
        rest = lines[1:]
        while rest and not rest[0].strip():
            rest.pop(0)
        return "\n".join(rest)
    return md


def parse_zip(data: bytes) -> dict:
    """ZIP -> {"pages": [...], "databases": [...]} (no DB access yet).

    pages:     {notion_id, title, body, parent_notion_id}
    databases: {notion_id, name, columns: [...], rows: [{title, props}]}
    """
    pages: list[dict] = []
    databases: list[dict] = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = [n for n in zf.namelist() if not n.endswith("/")]
        # folder -> Notion ID of the parent (subpage hierarchy)
        folder_ids: dict[str, str] = {}
        for n in zf.namelist():
            if n.endswith("/"):
                base = n.rstrip("/").split("/")[-1]
                _, nid = _strip_notion_id(base)
                if nid:
                    folder_ids[n.rstrip("/")] = nid

        csv_all = {n for n in names if n.lower().endswith("_all.csv")}
        for name in names:
            low = name.lower()
            parent_dir = "/".join(name.split("/")[:-1])
            parent_id = folder_ids.get(parent_dir)
            base = name.split("/")[-1]
            title, nid = _strip_notion_id(base)

            if low.endswith(".md"):
                raw = zf.read(name).decode("utf-8", errors="replace")
                title = _first_heading(raw) or title
                pages.append({
                    "notion_id": nid, "title": title[:300] or "Ohne Titel",
                    "body": _drop_leading_heading(raw, title),
                    "parent_notion_id": parent_id, "source_name": base,
                })
            elif low.endswith(".csv"):
                # If there is an _all variant, skip the slimmer one
                if not low.endswith("_all.csv") and any(
                        c.lower().startswith(low[:-4]) for c in csv_all):
                    continue
                raw = zf.read(name).decode("utf-8-sig", errors="replace")
                reader = csv.DictReader(io.StringIO(raw))
                cols = [c for c in (reader.fieldnames or []) if c]
                rows = []
                for r in reader:
                    vals = {k: (v or "").strip() for k, v in r.items() if k}
                    row_title = (vals.get(cols[0], "") if cols else "") or "Ohne Titel"
                    props = {k: v for k, v in vals.items() if k != (cols[0] if cols else "") and v}
                    rows.append({"title": row_title[:300], "props": props})
                databases.append({
                    "notion_id": nid, "name": title[:200] or "Import",
                    "columns": cols[1:], "rows": rows, "source_name": base,
                })
    return {"pages": pages, "databases": databases}


def guess_field_type(values: list[str]) -> int:
    """Guess the column type from the values (0 text, 1 number, 2 date, 4 multi_select)."""
    vals = [v for v in values if v]
    if not vals:
        return 0
    if all(re.fullmatch(r"-?\d+([.,]\d+)?\s*€?", v) for v in vals):
        return 1
    if all(re.fullmatch(r"\d{4}-\d{2}-\d{2}([ T].*)?", v) for v in vals):
        return 2
    if any("," in v for v in vals) and all(len(v) < 120 for v in vals):
        return 4
    return 0


def rewrite_links(body: str, id_map: dict[str, str]) -> str:
    """Notion file links -> `#kb-<uuid>` (our mention form)."""
    def repl(m: re.Match) -> str:
        label, target = m.group(1), m.group(2)
        if target.startswith(("http://", "https://", "#", "claraos://")):
            return m.group(0)
        decoded = urllib.parse.unquote(target)
        _, nid = _strip_notion_id(decoded.split("/")[-1])
        if nid and nid in id_map:
            return f"[{label}](#kb-{id_map[nid]})"
        return m.group(0)
    return MD_LINK_RE.sub(repl, body or "")


def build_export_zip(objects: list[dict], collections: list[dict] | None = None) -> bytes:
    """Objects as Markdown files (+ one CSV per collection) in a ZIP."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        used: set[str] = set()
        for o in objects:
            safe = re.sub(r"[^\w \-().]", "_", o["title"])[:120] or "objekt"
            fname = f"{safe}.md"
            i = 2
            while fname in used:
                fname = f"{safe} ({i}).md"
                i += 1
            used.add(fname)
            front = [f"# {o['title']}", ""]
            if o.get("properties"):
                front.append("<!-- Eigenschaften")
                for k, v in o["properties"].items():
                    front.append(f"{k}: {v}")
                front.append("-->")
                front.append("")
            zf.writestr(fname, "\n".join(front) + (o.get("body") or ""))
        for c in (collections or []):
            cols = c.get("columns") or []
            out = io.StringIO()
            w = csv.writer(out)
            w.writerow(["Titel", *cols])
            for r in c.get("rows", []):
                w.writerow([r.get("title", ""), *[r.get("props", {}).get(k, "") for k in cols]])
            safe = re.sub(r"[^\w \-().]", "_", c["name"])[:120] or "sammlung"
            zf.writestr(f"{safe}.csv", out.getvalue())
    return buf.getvalue()
