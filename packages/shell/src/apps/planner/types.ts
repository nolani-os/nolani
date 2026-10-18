/** Vikunja types (subset) + Planner sidecar. Everything comes via the BFF
 * /api/claraos/planner (routers/planner.py) — never directly from Vikunja. */

export interface VikUser {
  id: number;
  username: string;
  name?: string;
}

export interface VikLabel {
  id: number;
  title: string;
  hex_color?: string;
}

export interface TaskMeta {
  project_id: number;
  task_id: number;
  estimate_eur?: number | null;
  estimate_tokens?: number | null;
  estimate_minutes?: number | null;
  links?: { kind: string; uri: string; label?: string }[];
  in_work_by?: string | null;
  in_work_since?: string | null;
  event_uid?: string | null;
  event_calendar?: string | null;
}

export interface VikTask {
  id: number;
  project_id: number;
  title: string;
  description?: string;
  done: boolean;
  done_at?: string;
  due_date?: string; // "0001-01-01T00:00:00Z" == no date
  start_date?: string;
  end_date?: string;
  priority?: number; // 0-5
  percent_done?: number;
  labels?: VikLabel[] | null;
  assignees?: VikUser[] | null;
  reminders?: { reminder: string }[] | null;
  repeat_after?: number; // seconds
  repeat_mode?: number;
  related_tasks?: Record<string, VikTask[]> | null;
  bucket_id?: number;
  created?: string;
  updated?: string;
  _meta?: TaskMeta;
}

export interface VikView {
  id: number;
  title: string;
  view_kind: string; // list | gantt | table | kanban
}

export interface VikProject {
  id: number;
  title: string;
  description?: string;
  hex_color?: string;
  is_archived?: boolean;
  is_favorite?: boolean;
  views?: VikView[];
}

export interface VikBucket {
  id: number;
  title: string;
  project_view_id?: number;
  tasks?: VikTask[] | null;
  count?: number;
}

export interface VikAttachment {
  id: number;
  task_id?: number;
  file?: { name?: string; size?: number; mime?: string };
  created?: string;
  created_by?: VikUser;
}

export interface VikComment {
  id: number;
  comment: string;
  author?: VikUser;
  created?: string;
}

export interface InWorkEntry {
  project_id: number;
  task_id: number;
  in_work_by: string;
  since?: string | null;
  session_id?: string | null;
  stale: boolean;
}

/** Cost/time transparency. */
export interface TaskCost {
  task_id: number;
  cost_eur: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  events: number | null;
  estimate_eur: number | null;
  estimate_tokens: number | null;
  estimate_minutes: number | null;
  worked_minutes: number | null;
  open_sessions: number;
}

export interface ProjectCosts {
  project_id: number;
  cost_available: boolean;
  total: { cost_eur: number; input_tokens: number; output_tokens: number; events: number } | null;
  project_estimate: { estimate_eur: number | null; estimate_tokens: number | null; estimate_minutes: number | null } | null;
  tasks: TaskCost[];
}

/** Global cost overview (GET /costs/overview). */
export interface CostsOverviewProject {
  project_id: number;
  title: string;
  is_archived: boolean;
  cost_eur: number | null;
  range_cost_eur: number | null;
  tokens: number | null;
  events: number | null;
  estimate_eur: number | null;
  worked_minutes: number | null;
  open_sessions: number;
}

export interface CostsOverview {
  cost_available: boolean;
  days: number;
  total: { cost_eur: number; tokens: number; events: number } | null;
  range_total: { cost_eur: number; tokens: number; events: number } | null;
  projects: CostsOverviewProject[];
  top_tasks: { project_id: number; task_id: number; cost_eur: number; tokens: number; events: number }[];
}

/** Detect Vikunja's "no date" sentinel. */
export function hasDate(iso?: string): boolean {
  return !!iso && !iso.startsWith("0001-");
}

export const RELATION_KINDS_BLOCKED = "blocked"; // this task is blocked by …
export const RELATION_KINDS_BLOCKING = "blocking"; // this task blocks …
