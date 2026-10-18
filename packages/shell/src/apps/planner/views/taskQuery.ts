/** Tasks view v2 — pure filter/sort/group logic (no React).
 * Sorting is ALWAYS client-side: Vikunja 2.x answers sort_by with 400. */
import { hasDate, type VikTask } from "../types";
import { isDueToday, isOverdue, ymd } from "../shared";

export interface FilterState {
  q: string;
  priorityMin: number; // 0 = all
  labelIds: number[];
  projectIds: number[];
  due: "any" | "overdue" | "today" | "week" | "none";
  assigneeId: number | null;
  includeDone: boolean;
}

export type SortKey = "due" | "priority" | "alpha" | "created";
export type GroupKey = "due" | "project" | "priority" | "label" | "none";

export interface SavedFilter {
  id: string;
  label: string;
  filter: FilterState;
  sort: SortKey;
  group: GroupKey;
}

export const EMPTY_FILTER: FilterState = {
  q: "",
  priorityMin: 0,
  labelIds: [],
  projectIds: [],
  due: "any",
  assigneeId: null,
  includeDone: false,
};

/** Are two filters equivalent in content?
 *
 * Why this is needed: the chips at the top ("This week", "Important" …) do
 * nothing but set this filter — they ARE presets. Tracking separately which
 * chip was clicked (`activeList`) drifts apart: setting the same filter by
 * hand would not highlight the chip, and picking a chip and then filtering
 * something else would keep it highlighted. Two sources of truth for one
 * state. Instead, the highlight is DERIVED from the filter — one state, one
 * writer. */
export function gleicherFilter(a: FilterState, b: FilterState): boolean {
  const liste = (x: number[]) => [...x].sort((p, q) => p - q).join(",");
  return a.q.trim() === b.q.trim()
    && a.priorityMin === b.priorityMin
    && a.due === b.due
    && (a.assigneeId ?? null) === (b.assigneeId ?? null)
    && liste(a.labelIds) === liste(b.labelIds)
    && liste(a.projectIds) === liste(b.projectIds);
}

export function isEmptyFilter(f: FilterState): boolean {
  return (
    !f.q.trim() && f.priorityMin === 0 && f.labelIds.length === 0 &&
    f.projectIds.length === 0 && f.due === "any" && f.assigneeId == null
  );
}

/** Vikunja descriptions can be HTML (web UI editor) — strip it for search. */
function plain(html?: string): string {
  return (html ?? "").replace(/<[^>]+>/g, " ");
}

function dueWithinDays(t: VikTask, days: number): boolean {
  if (!hasDate(t.due_date)) return false;
  const limit = new Date();
  limit.setDate(limit.getDate() + days);
  limit.setHours(23, 59, 59, 999);
  return new Date(t.due_date!).getTime() <= limit.getTime();
}

export function applyFilter(tasks: VikTask[], f: FilterState): VikTask[] {
  const q = f.q.trim().toLowerCase();
  return tasks.filter((t) => {
    if (!f.includeDone && t.done) return false;
    if (q && !t.title.toLowerCase().includes(q) && !plain(t.description).toLowerCase().includes(q)) return false;
    if (f.priorityMin > 0 && (t.priority ?? 0) < f.priorityMin) return false;
    if (f.labelIds.length > 0 && !f.labelIds.some((id) => t.labels?.some((l) => l.id === id))) return false;
    if (f.projectIds.length > 0 && !f.projectIds.includes(t.project_id)) return false;
    if (f.assigneeId != null && !t.assignees?.some((a) => a.id === f.assigneeId)) return false;
    switch (f.due) {
      case "overdue": return isOverdue(t);
      case "today": return isDueToday(t);
      case "week": return dueWithinDays(t, 7);
      case "none": return !hasDate(t.due_date);
      default: return true;
    }
  });
}

const NO_DATE = "9999";

export function sortTasks(tasks: VikTask[], key: SortKey): VikTask[] {
  const s = [...tasks];
  switch (key) {
    case "due":
      return s.sort((a, b) =>
        (hasDate(a.due_date) ? a.due_date! : NO_DATE).localeCompare(hasDate(b.due_date) ? b.due_date! : NO_DATE));
    case "priority":
      return s.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    case "alpha":
      return s.sort((a, b) => a.title.localeCompare(b.title, "de"));
    case "created":
      return s.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
  }
}

const PRIO_GROUPS: Record<number, string> = {
  5: "SOFORT", 4: "Dringend", 3: "Hoch", 2: "Mittel", 1: "Niedrig", 0: "Keine Priorität",
};
const DUE_ORDER = ["Überfällig", "Heute", "Morgen", "Diese Woche", "Später", "Ohne Datum"];

function dueGroupOf(t: VikTask): string {
  if (isOverdue(t)) return "Überfällig";
  if (isDueToday(t)) return "Heute";
  if (!hasDate(t.due_date)) return "Ohne Datum";
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (ymd(new Date(t.due_date!)) === ymd(tomorrow)) return "Morgen";
  if (dueWithinDays(t, 7)) return "Diese Woche";
  return "Später";
}

/** Groups tasks (order is stable, taken from the given, already sorted list).
 * With group="label" a task can appear in several groups (intended). */
export function groupTasks(
  tasks: VikTask[], key: GroupKey, projectTitles: Map<number, string>,
): [string, VikTask[]][] {
  if (key === "none") return tasks.length ? [["Alle Aufgaben", tasks]] : [];
  const g = new Map<string, VikTask[]>();
  const push = (label: string, t: VikTask) => {
    if (!g.has(label)) g.set(label, []);
    g.get(label)!.push(t);
  };
  for (const t of tasks) {
    if (key === "due") push(dueGroupOf(t), t);
    else if (key === "project") push(projectTitles.get(t.project_id) ?? `Projekt ${t.project_id}`, t);
    else if (key === "priority") push(PRIO_GROUPS[t.priority ?? 0] ?? "Keine Priorität", t);
    else if (key === "label") {
      if (t.labels?.length) t.labels.forEach((l) => push(l.title, t));
      else push("Ohne Tag", t);
    }
  }
  const prioOrder = Object.values(PRIO_GROUPS);
  return [...g.entries()].sort((a, b) => {
    if (key === "due") return DUE_ORDER.indexOf(a[0]) - DUE_ORDER.indexOf(b[0]);
    if (key === "priority") return prioOrder.indexOf(a[0]) - prioOrder.indexOf(b[0]);
    return a[0].localeCompare(b[0], "de");
  });
}

/** Predefined smart lists (not deletable, shown before saved filters). */
export const SMART_LISTS: { id: string; label: string; filter: FilterState; sort: SortKey; group: GroupKey }[] = [
  { id: "week", label: "📆 Diese Woche", filter: { ...EMPTY_FILTER, due: "week" }, sort: "due", group: "due" },
  { id: "important", label: "⚑ Wichtig", filter: { ...EMPTY_FILTER, priorityMin: 3 }, sort: "priority", group: "priority" },
  { id: "nodate", label: "∅ Ohne Termin", filter: { ...EMPTY_FILTER, due: "none" }, sort: "created", group: "project" },
];
