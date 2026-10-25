/**
 * listTransform: pure sort/filter/group transformation of the files lists
 * (client-side; the server still delivers the full depth-1 listing).
 * Deliberately DOM-free and therefore unit-testable; desktop and mobile share it.
 */
import { i18n, type FileNode, type SortKey, type SortDir, type GroupBy } from "@claraos/core";
import { getFileTypeInfo, categoryName, folderTypeName, type FileCategory } from "../../lib/fileTypeMeta";

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

type DateBucket = "today" | "yesterday" | "thisWeek" | "thisMonth" | "earlier" | "unknown";

function dateBucket(node: FileNode, now: Date): DateBucket {
  const t = node.modified ? Date.parse(String(node.modified)) : NaN;
  if (Number.isNaN(t)) return "unknown";
  const d = new Date(t);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = startOfDay(now);
  const day = startOfDay(d);
  const dayMs = 86_400_000;
  if (day === today) return "today";
  if (day === today - dayMs) return "yesterday";
  if (day > today - 7 * dayMs) return "thisWeek";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "thisMonth";
  return "earlier";
}

const DATE_BUCKET_ORDER: DateBucket[] = ["today", "yesterday", "thisWeek", "thisMonth", "earlier", "unknown"];

/** Group key (language-independent); the label is derived from it. */
function groupKey(node: FileNode, groupBy: GroupBy, now: Date): string {
  return groupBy === "type" ? categoryOf(node) : dateBucket(node, now);
}

function groupLabel(key: string, groupBy: GroupBy): string {
  if (groupBy === "type") return key === "folder" ? folderTypeName() : categoryName(key as FileCategory);
  return i18n.t(`files:groups.date.${key}`);
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
    const key = groupKey(n, opts.groupBy, now);
    const g = groups.get(key);
    if (g) g.push(n);
    else groups.set(key, [n]);
  }

  const labelOf = new Map([...groups.keys()].map((k) => [k, groupLabel(k, opts.groupBy)]));
  const keys = [...groups.keys()];
  if (opts.groupBy === "date") {
    keys.sort((a, b) => DATE_BUCKET_ORDER.indexOf(a as DateBucket) - DATE_BUCKET_ORDER.indexOf(b as DateBucket));
  } else {
    // Folders first, rest alphabetical by their (translated) label
    keys.sort((a, b) => (a === "folder" ? -1 : b === "folder" ? 1 : collator.compare(labelOf.get(a)!, labelOf.get(b)!)));
  }
  return keys.map((key) => ({ label: labelOf.get(key)!, items: groups.get(key)! }));
}
