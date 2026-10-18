/**
 * listTransform: pure sort/filter/group transformation of the files lists
 * (client-side; the server still delivers the full depth-1 listing).
 * Deliberately DOM-free and therefore unit-testable; desktop and mobile share it.
 */
import type { FileNode, SortKey, SortDir, GroupBy } from "@claraos/core";
import { getFileTypeInfo, CATEGORY_META, type FileCategory } from "../../lib/fileTypeMeta";

export type { SortKey, SortDir, GroupBy };

export interface ListTransformOpts {
  sortKey: SortKey;
  sortDir: SortDir;
  /** Folders before files (Windows/Nautilus default). */
  dirsFirst: boolean;
  /** Show dotfiles? */
  showHidden: boolean;
  groupBy: GroupBy;
  /** Instant filter of the toolbar search (case-insensitive substring). */
  filterQuery: string;
}

export const DEFAULT_TRANSFORM: ListTransformOpts = {
  sortKey: "name",
  sortDir: "asc",
  dirsFirst: true,
  showHidden: false,
  groupBy: "none",
  filterQuery: "",
};

export interface ListGroup {
  /** null = no grouping active (one anonymous group). */
  label: string | null;
  items: FileNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function categoryOf(node: FileNode): FileCategory | "folder" {
  return node.isDir ? "folder" : getFileTypeInfo(node.name).category;
}

function compare(a: FileNode, b: FileNode, key: SortKey): number {
  switch (key) {
    case "size":
      // Folders have no size: sort them to the "small" end
      return (a.isDir ? -1 : a.size ?? 0) - (b.isDir ? -1 : b.size ?? 0);
    case "modified": {
      const ta = a.modified ? Date.parse(String(a.modified)) || 0 : 0;
      const tb = b.modified ? Date.parse(String(b.modified)) || 0 : 0;
      return ta - tb;
    }
    case "type": {
      const ca = String(categoryOf(a));
      const cb = String(categoryOf(b));
      return ca === cb ? collator.compare(a.name, b.name) : collator.compare(ca, cb);
    }
    default:
      return collator.compare(a.name, b.name);
  }
}

function dateBucket(node: FileNode, now: Date): string {
  const t = node.modified ? Date.parse(String(node.modified)) : NaN;
  if (Number.isNaN(t)) return "Unbekannt";
  const d = new Date(t);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = startOfDay(now);
  const day = startOfDay(d);
  const dayMs = 86_400_000;
  if (day === today) return "Heute";
  if (day === today - dayMs) return "Gestern";
  if (day > today - 7 * dayMs) return "Diese Woche";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "Dieser Monat";
  return "Früher";
}

const DATE_BUCKET_ORDER = ["Heute", "Gestern", "Diese Woche", "Dieser Monat", "Früher", "Unbekannt"];

function typeGroupLabel(node: FileNode): string {
  if (node.isDir) return "Ordner";
  return CATEGORY_META[getFileTypeInfo(node.name).category].name;
}

/** Filter → sort → group. Always returns ≥0 groups;
 *  without groupBy exactly one group with label:null. */
export function prepareItems(
  children: FileNode[] | undefined,
  opts: ListTransformOpts,
  now: Date = new Date(),
): ListGroup[] {
  let items = children ?? [];

  if (!opts.showHidden) items = items.filter((n) => !n.name.startsWith("."));
  if (opts.filterQuery.trim()) {
    const q = opts.filterQuery.trim().toLowerCase();
    items = items.filter((n) => n.name.toLowerCase().includes(q));
  }

  items = [...items].sort((a, b) => {
    if (opts.dirsFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const c = compare(a, b, opts.sortKey);
    return opts.sortDir === "desc" ? -c : c;
  });

  if (opts.groupBy === "none") return [{ label: null, items }];

  const groups = new Map<string, FileNode[]>();
  for (const n of items) {
    const label = opts.groupBy === "type" ? typeGroupLabel(n) : dateBucket(n, now);
    const g = groups.get(label);
    if (g) g.push(n);
    else groups.set(label, [n]);
  }

  const labels = [...groups.keys()];
  if (opts.groupBy === "date") {
    labels.sort((a, b) => DATE_BUCKET_ORDER.indexOf(a) - DATE_BUCKET_ORDER.indexOf(b));
  } else {
    // "Ordner" (folders) first, rest alphabetical
    labels.sort((a, b) => (a === "Ordner" ? -1 : b === "Ordner" ? 1 : collator.compare(a, b)));
  }
  return labels.map((label) => ({ label, items: groups.get(label)! }));
}
