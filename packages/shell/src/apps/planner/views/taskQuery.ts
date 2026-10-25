/** Tasks view v2 — pure filter/sort/group logic (no React).
 * Sorting is ALWAYS client-side: Vikunja 2.x answers sort_by with 400. */
import { i18n } from "@claraos/core";
import { hasDate, type VikTask } from "../types";
import { isDueToday, isOverdue, prioLabel, ymd } from "../shared";

/** Translate at call time (never at module load: the language can change). */
function tr(key: string, opts?: Record<string, unknown>): string {
  return i18n.t(`planner:${key}`, opts);
}

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

/** Due buckets in display order (neutral ids; labels are translated at render). */
export type DueGroup = "overdue" | "today" | "tomorrow" | "thisWeek" | "later" | "withoutDate";
const DUE_ORDER: DueGroup[] = ["overdue", "today", "tomorrow", "thisWeek", "later", "withoutDate"];

function dueGroupOf(t: VikTask): DueGroup {
  if (isOverdue(t)) return "overdue";
  if (isDueToday(t)) return "today";
  if (!hasDate(t.due_date)) return "withoutDate";
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (ymd(new Date(t.due_date!)) === ymd(tomorrow)) return "tomorrow";
  if (dueWithinDays(t, 7)) return "thisWeek";
  return "later";
}

export interface TaskGroup {
  /** Stable, language-neutral id (React key, overdue styling). */
  id: string;
  /** Display label in the current UI language (or user data: project/label title). */
  label: string;
  tasks: VikTask[];
}

/** Groups tasks (order is stable, taken from the given, already sorted list).
 * With group="label" a task can appear in several groups (intended).
 * Ids are neutral ("due:overdue", "prio:3", "project:7", "label:12", "label:none");
 * labels are resolved at call time, so call this during render. */
export function groupTasks(
  tasks: VikTask[], key: GroupKey, projectTitles: Map<number, string>,
): TaskGroup[] {
  if (key === "none") return tasks.length ? [{ id: "all", label: tr("views.tasks.allTasks"), tasks }] : [];
  const g = new Map<string, TaskGroup>();
  const push = (id: string, label: () => string, t: VikTask) => {
    if (!g.has(id)) g.set(id, { id, label: label(), tasks: [] });
    g.get(id)!.tasks.push(t);
  };
  for (const t of tasks) {
    if (key === "due") {
      const d = dueGroupOf(t);
      push(`due:${d}`, () => tr(`dates.${d}`), t);
    } else if (key === "project") {
      push(`project:${t.project_id}`,
        () => projectTitles.get(t.project_id) ?? tr("views.tasks.projectFallback", { id: t.project_id }), t);
    } else if (key === "priority") {
      const p = t.priority ?? 0;
      push(`prio:${p}`, () => (p >= 1 && p <= 5 ? prioLabel(p) : tr("priority.none")), t);
    } else if (key === "label") {
      if (t.labels?.length) t.labels.forEach((l) => push(`label:${l.id}`, () => l.title, t));
      else push("label:none", () => tr("views.tasks.noTag"), t);
    }
  }
  const rank = (grp: TaskGroup): number => {
    if (key === "due") return DUE_ORDER.indexOf(grp.id.slice(4) as DueGroup);
    if (key === "priority") return -Number(grp.id.slice(5)); // highest first
    return 0;
  };
  return [...g.values()].sort((a, b) => {
    if (key === "due" || key === "priority") return rank(a) - rank(b);
    return a.label.localeCompare(b.label, "de");
  });
}

/** Predefined smart lists (not deletable, shown before saved filters).
 * `label` is a getter, so it is always in the current UI language. */
export const SMART_LISTS: { readonly id: string; readonly label: string; filter: FilterState; sort: SortKey; group: GroupKey }[] = [
  { id: "week", get label() { return `📆 ${tr("views.tasks.smart.week")}`; }, filter: { ...EMPTY_FILTER, due: "week" }, sort: "due", group: "due" },
  { id: "important", get label() { return `⚑ ${tr("views.tasks.smart.important")}`; }, filter: { ...EMPTY_FILTER, priorityMin: 3 }, sort: "priority", group: "priority" },
  { id: "nodate", get label() { return `∅ ${tr("views.tasks.smart.noDate")}`; }, filter: { ...EMPTY_FILTER, due: "none" }, sort: "created", group: "project" },
];
