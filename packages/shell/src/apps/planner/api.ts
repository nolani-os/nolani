/** BFF client for the Planner (routers/planner.py).
 * Same pattern as routines/api.ts: own http<T> wrapper, cookie auth.
 * 424 = no Vikunja token stored → dedicated error type for onboarding. */
import type {
  CostsOverview, InWorkEntry, ProjectCosts, TaskMeta, VikAttachment, VikBucket, VikComment, VikLabel,
  VikProject, VikTask, VikUser,
} from "./types";

const BASE = "/api/claraos/planner";

export class NotConnectedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "NotConnectedError";
  }
}

/** 409 — the event was changed elsewhere in the meantime.
 * A dedicated type, because the UI must react differently than to a failure:
 * not "try again" but **reload and then retry**. */
export class ConflictError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ConflictError";
  }
}

/** Extract the message from an error response. FastAPI puts it in `detail`;
 * previously the client threw the raw text including JSON braces into the UI
 * instead — technically correct and readable by nobody. */
async function fehlertext(r: Response, rueckfall: string): Promise<string> {
  const text = await r.text().catch(() => "");
  if (!text) return rueckfall;
  try {
    const j = JSON.parse(text);
    const d = j?.detail;
    if (typeof d === "string" && d.trim()) return d;
    if (Array.isArray(d) && d.length) return d.map((x) => x?.msg ?? String(x)).join("; ");
  } catch {
    /* not JSON — use the raw text then */
  }
  return text.slice(0, 300) || rueckfall;
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (r.status === 424) {
    throw new NotConnectedError(await fehlertext(r, "Kein Vikunja-Token hinterlegt."));
  }
  if (r.status === 409) {
    throw new ConflictError(
      await fehlertext(r, "Wurde zwischenzeitlich woanders geändert. Bitte neu laden."),
    );
  }
  if (!r.ok) {
    throw new Error(await fehlertext(r, `${r.status} ${r.statusText}`));
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

export const plannerApi = {
  // Projects
  listProjects: () => http<VikProject[]>("/api/projects"),
  getProject: (id: number) => http<VikProject>(`/api/projects/${id}`),
  createProject: (title: string) =>
    http<VikProject>("/api/projects", { method: "PUT", body: JSON.stringify({ title }) }),
  /** Like tasks: Vikunja updates are suspected full replaces → always send the full object. */
  updateProject: (p: VikProject) =>
    http<VikProject>(`/api/projects/${p.id}`, { method: "POST", body: JSON.stringify(p) }),
  async updateProjectFields(id: number, patch: Partial<VikProject>): Promise<VikProject> {
    const cur = await this.getProject(id);
    return this.updateProject({ ...cur, ...patch });
  },
  deleteProject: (id: number) => http<unknown>(`/api/projects/${id}`, { method: "DELETE" }),

  // Tasks
  listProjectTasks: (projectId: number, page = 1) =>
    http<VikTask[]>(`/api/projects/${projectId}/tasks?per_page=50&page=${page}`),
  // Vikunja 2.x: /tasks instead of /tasks/all; sorting is done by the client
  listAllTasks: (page = 1) =>
    http<VikTask[]>(`/api/tasks?per_page=50&page=${page}`),

  /** Open tasks across ALL projects — for lightweight consumers (widget).
   *
   * Filtered server-side first (`filter=done = false`; according to docs.json
   * Vikunja 2.3 supports this on /tasks). If Vikunja does NOT answer with 200 —
   * the filter language has already changed between 2.x versions — it falls
   * back to the PlannerApp pattern: paginate unfiltered and filter on the
   * client. That way the normal case is exact and the special case is still
   * not empty. `maxPages` caps both (no endless polling in the widget). */
  async listOpenTasks(maxPages = 6): Promise<VikTask[]> {
    const collect = async (query: (page: number) => string) => {
      const all: VikTask[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const batch = (await http<VikTask[]>(query(page))) || [];
        all.push(...batch);
        if (batch.length < 50) break;
      }
      return all;
    };
    try {
      const filtered = await collect(
        (p) => `/api/tasks?per_page=50&page=${p}&filter=${encodeURIComponent("done = false")}`,
      );
      return filtered.filter((t) => t && !t.done);
    } catch (e) {
      if (e instanceof NotConnectedError) throw e; // no token → caller shows a hint
      const raw = await collect((p) => `/api/tasks?per_page=50&page=${p}`);
      return raw.filter((t) => t && !t.done);
    }
  },
  getTask: (id: number) => http<VikTask>(`/api/tasks/${id}`),
  createTask: (projectId: number, body: Partial<VikTask>) =>
    http<VikTask>(`/api/projects/${projectId}/tasks`, { method: "PUT", body: JSON.stringify(body) }),
  /** Vikunja updates replace fields → always send the FULL task object
   * (read-modify-write is done by the caller or updateTaskFields). */
  updateTask: (task: VikTask) =>
    http<VikTask>(`/api/tasks/${task.id}`, { method: "POST", body: JSON.stringify(task) }),
  deleteTask: (id: number) => http<unknown>(`/api/tasks/${id}`, { method: "DELETE" }),

  /** Read-modify-write: fetch the fresh task, merge fields, update in full. */
  async updateTaskFields(id: number, patch: Partial<VikTask>): Promise<VikTask> {
    const cur = await this.getTask(id);
    return this.updateTask({ ...cur, ...patch });
  },

  // Kanban
  listBuckets: (projectId: number, viewId: number) =>
    http<VikBucket[]>(`/api/projects/${projectId}/views/${viewId}/buckets`),
  createBucket: (projectId: number, viewId: number, title: string) =>
    http<VikBucket>(`/api/projects/${projectId}/views/${viewId}/buckets`, {
      method: "PUT", body: JSON.stringify({ title }),
    }),
  moveTaskToBucket: (projectId: number, viewId: number, bucketId: number, taskId: number) =>
    http<unknown>(`/api/projects/${projectId}/views/${viewId}/buckets/${bucketId}/tasks`, {
      method: "POST", body: JSON.stringify({ task_id: taskId }),
    }),

  // Labels
  listLabels: () => http<VikLabel[] | null>("/api/labels"),
  createLabel: (title: string) =>
    http<VikLabel>("/api/labels", { method: "PUT", body: JSON.stringify({ title }) }),
  addTaskLabel: (taskId: number, labelId: number) =>
    http<unknown>(`/api/tasks/${taskId}/labels`, { method: "PUT", body: JSON.stringify({ label_id: labelId }) }),
  removeTaskLabel: (taskId: number, labelId: number) =>
    http<unknown>(`/api/tasks/${taskId}/labels/${labelId}`, { method: "DELETE" }),

  // Relations (dependencies)
  addRelation: (taskId: number, otherTaskId: number, kind: string) =>
    http<unknown>(`/api/tasks/${taskId}/relations`, {
      method: "PUT",
      body: JSON.stringify({ task_id: taskId, other_task_id: otherTaskId, relation_kind: kind }),
    }),
  removeRelation: (taskId: number, kind: string, otherTaskId: number) =>
    http<unknown>(`/api/tasks/${taskId}/relations/${kind}/${otherTaskId}`, { method: "DELETE" }),

  // Comments
  listComments: (taskId: number) => http<VikComment[]>(`/api/tasks/${taskId}/comments`),
  addComment: (taskId: number, comment: string) =>
    http<VikComment>(`/api/tasks/${taskId}/comments`, { method: "PUT", body: JSON.stringify({ comment }) }),

  // Attachments (Vikunja attachments)
  listAttachments: (taskId: number) =>
    http<VikAttachment[] | null>(`/api/tasks/${taskId}/attachments`),
  deleteAttachment: (taskId: number, attachmentId: number) =>
    http<unknown>(`/api/tasks/${taskId}/attachments/${attachmentId}`, { method: "DELETE" }),
  /** Download URL — same-origin, cookie auth → usable directly as <a href>. */
  attachmentUrl: (taskId: number, attachmentId: number) =>
    `${BASE}/api/tasks/${taskId}/attachments/${attachmentId}`,
  /** Upload as multipart (field name "files"). RAW fetch instead of http<T>:
   * do NOT set a Content-Type header — the browser generates the boundary. */
  uploadAttachments: async (taskId: number, files: File[]): Promise<void> => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name));
    const r = await fetch(`${BASE}/api/tasks/${taskId}/attachments`, {
      method: "PUT", credentials: "include", body: fd,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`Upload fehlgeschlagen: ${r.status} ${text}`);
    }
  },

  // Assignments
  addAssignee: (taskId: number, userId: number) =>
    http<unknown>(`/api/tasks/${taskId}/assignees`, { method: "PUT", body: JSON.stringify({ user_id: userId }) }),
  removeAssignee: (taskId: number, userId: number) =>
    http<unknown>(`/api/tasks/${taskId}/assignees/${userId}`, { method: "DELETE" }),
  projectUsers: (projectId: number) => http<VikUser[]>(`/api/projects/${projectId}/projectusers`),

  // Sidecar (claraos_planner_meta) + "Clara is working on it"
  getMeta: (projectId: number) => http<TaskMeta[]>(`/meta?project_id=${projectId}`),
  upsertMeta: (meta: Partial<TaskMeta> & { project_id: number; task_id: number }) =>
    http<unknown>("/meta", { method: "PUT", body: JSON.stringify(meta) }),
  inWork: () => http<InWorkEntry[]>("/in-work"),
  finishWork: (projectId: number, taskId: number, note?: string) =>
    http<{ ok: boolean }>("/work/finish", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, task_id: taskId, ...(note ? { note } : {}) }),
    }),
  health: () => http<{ ok: boolean }>("/health"),

  // Calendar: Nextcloud CalDAV merge + scheduling
  calendar: (startIso: string, endIso: string) =>
    http<{ events: CalEvent[]; tasks: CalTask[] }>(
      `/calendar?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`),

  // Calendar v2: full events (busy status, attendees, recurrences) + CRUD
  listEvents: (startIso: string, endIso: string) =>
    http<{ events: CalEventFull[]; tasks: CalTask[] }>(
      `/events?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`),
  getEvent: (uid: string, calendar?: string) =>
    http<CalEventFull>(`/events/${encodeURIComponent(uid)}${calendar ? `?calendar=${encodeURIComponent(calendar)}` : ""}`),
  createEvent: (body: EventWrite) =>
    http<{ ok: boolean; uid: string; calendar: string; warning?: string }>(
      "/events", { method: "POST", body: JSON.stringify(body) }),
  updateEvent: (uid: string, calendar: string | undefined, body: EventWrite & { rrule_keep?: boolean; only_this?: boolean; recurrence_id?: string | null }) =>
    http<{ ok: boolean; uid: string; warning?: string }>(
      `/events/${encodeURIComponent(uid)}${calendar ? `?calendar=${encodeURIComponent(calendar)}` : ""}`,
      { method: "PUT", body: JSON.stringify(body) }),
  deleteEvent: (uid: string, calendar?: string, recurrenceId?: string | null) => {
    const qs = new URLSearchParams();
    if (calendar) qs.set("calendar", calendar);
    if (recurrenceId) qs.set("recurrence_id", recurrenceId);
    const q = qs.toString();
    return http<{ ok: boolean }>(`/events/${encodeURIComponent(uid)}${q ? `?${q}` : ""}`, { method: "DELETE" });
  },
  scheduleTask: (taskId: number, body: { project_id: number; start: string; end?: string; calendar?: string }) =>
    http<{ ok: boolean; uid: string; calendar: string }>(`/tasks/${taskId}/schedule`, {
      method: "POST", body: JSON.stringify(body),
    }),
  unscheduleTask: (taskId: number, projectId: number) =>
    http<{ ok: boolean }>(`/tasks/${taskId}/schedule?project_id=${projectId}`, { method: "DELETE" }),

  // Cost/time transparency
  projectCosts: (projectId: number) => http<ProjectCosts>(`/projects/${projectId}/costs`),
  costsOverview: (days = 30) => http<CostsOverview>(`/costs/overview?days=${days}`),

  // User prefs (planner_app: saved filters etc.). PUT /prefs only merges
  // TOP-LEVEL keys → always read-modify-write the complete planner_app object.
  getPlannerPrefs: async (): Promise<Record<string, unknown>> => {
    const r = await fetch("/api/claraos/prefs", { credentials: "include" });
    if (!r.ok) return {};
    const p = await r.json().catch(() => null);
    return p && typeof p.planner_app === "object" && p.planner_app ? p.planner_app : {};
  },
  savePlannerPrefs: async (plannerApp: Record<string, unknown>): Promise<void> => {
    await fetch("/api/claraos/prefs", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planner_app: plannerApp }),
    });
  },
};

export interface CalEvent {
  summary: string;
  start: string;
  end: string;
  uid: string;
  calendar: string;
  color: string;
  task_id: number | null;
  /** STATUS:CANCELLED — the organiser has cancelled. */
  cancelled?: boolean;
}

/** Calendar v2. */
export type BusyStatus = "free" | "busy" | "tentative" | "oof";

export interface AttendeeOut {
  email: string;
  name: string | null;
  partstat: string; // NEEDS-ACTION | ACCEPTED | DECLINED | TENTATIVE
}

export interface RRuleSimple {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  until: string | null;
  count: number | null;
}

export interface CalEventFull extends CalEvent {
  all_day: boolean;
  location: string;
  description: string;
  busy_status: BusyStatus;
  recurrence_id: string | null;
  is_recurring: boolean;
  rrule_raw: string;
  rrule_simple: RRuleSimple | null;
  alarm_minutes: number | null;
  organizer: string | null;
  attendees: AttendeeOut[];
}

export interface EventWrite {
  summary: string;
  start: string;
  end: string;
  all_day?: boolean;
  calendar?: string | null;
  location?: string | null;
  description?: string | null;
  busy_status?: BusyStatus;
  rrule?: Partial<RRuleSimple> | null;
  alarm_minutes?: number | null;
  attendees?: { email: string; name?: string | null }[];
  tzid?: string | null;
}

// ── Free/busy, sharing, replies, holidays ──
export interface Person { username: string; name: string; email: string }
export interface BusyBlock { start: string; end: string; status: "busy" | "tentative" }
export interface FreeBusyResult {
  people: { username: string; busy: BusyBlock[]; available: boolean }[];
  suggestions: { start: string; end: string }[];
}
export interface KalenderFreigabe { principal: string; username: string; name: string; access: "read" | "write" }
export interface Feiertag { date: string; name: string; regional: boolean }

export const kalenderApi = {
  people: () => http<{ people: Person[]; me: { username: string; addresses: string[] } }>("/people"),
  freebusy: (body: { people: string[]; start: string; end: string; duration_minutes?: number; day_start_hour?: number; day_end_hour?: number; weekdays_only?: boolean }) =>
    http<FreeBusyResult>("/freebusy", { method: "POST", body: JSON.stringify(body) }),
  freigaben: (calendar: string) => http<{ calendar: string; shares: KalenderFreigabe[] }>(`/calendars/shares?calendar=${encodeURIComponent(calendar)}`),
  freigeben: (body: { calendar: string; username: string; access?: "read" | "write"; remove?: boolean }) =>
    http<{ ok: boolean; message: string }>("/calendars/shares", { method: "POST", body: JSON.stringify(body) }),
  antworten: (uid: string, body: { partstat: "ACCEPTED" | "TENTATIVE" | "DECLINED"; comment?: string; proposed_start?: string; proposed_end?: string; calendar?: string }) =>
    http<{ ok: boolean; partstat: string; organizer_notified: boolean }>(`/events/${encodeURIComponent(uid)}/respond`, { method: "POST", body: JSON.stringify(body) }),
  feiertage: (year: number, state: string) =>
    http<{ year: number; state: string; holidays: Feiertag[]; states: { code: string; name: string }[] }>(`/holidays?year=${year}&state=${encodeURIComponent(state)}`),
};

/** Nextcloud contacts/calendar directly via the nc_pim routes (same cookie auth). */
export const ncApi = {
  calendars: async (): Promise<{ name: string; color?: string; writable?: boolean }[]> => {
    const r = await fetch("/api/claraos/nc/calendar/calendars", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!r.ok) return [];
    const data = await r.json().catch(() => null);
    return Array.isArray(data?.calendars) ? data.calendars : Array.isArray(data) ? data : [];
  },
  contactsList: async (query: string): Promise<{ name: string; emails: string[]; org?: string }[]> => {
    const r = await fetch("/api/claraos/nc/contacts/list", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) return [];
    const data = await r.json().catch(() => null);
    return Array.isArray(data?.contacts) ? data.contacts : Array.isArray(data) ? data : [];
  },
};

export interface CalTask {
  id: number;
  project_id: number;
  title: string;
  done: boolean;
  due_date: string;
  priority?: number;
}
