/** BFF client for the "Ideas" app (routers/knowledge.py).
 * Same pattern as planner/api.ts: own http<T> wrapper, cookie auth.
 * No 424 onboarding needed; the backend requires no app tokens. */
import type { ActionPlan, GoalNode, KbActivity, KbCollection, KbCollectionShare, KbComment, KbDiffOp, KbField, KbHistoryEntry, KbNotification, KbObject, KbObjectSlim, KbPropDef, KbRow, KbTemplate, KbType, KbView, KpiProgress, KpiSource, KpiSourceError, KpiValue, IdeaProposal, MatrixItem, SuggestedRating, Analysis, Countermeasure, ParetoRow, WhyLink, Stage, Visibility } from "./types";

const BASE = "/api/claraos/knowledge";

/** Error carrying a sentence that can be shown to a person.
 *
 * Previously the app literally showed "500 : Internal Server Error", which is
 * the HTTP status line, not a message, and useless to non-technical users. The
 * technical version is kept (`technisch`); it belongs in the console, not on
 * the screen.
 */
export class ApiFehler extends Error {
  readonly status: number;
  readonly technisch: string;
  constructor(status: number, rumpf: string) {
    super(satzZu(status, rumpf));
    this.name = "ApiFehler";
    this.status = status;
    this.technisch = `${status}: ${rumpf}`.slice(0, 500);
  }
}

/** The server's explanation, if it sends one (`{"detail": "…"}`). */
function serverText(rumpf: string): string {
  try {
    const d = JSON.parse(rumpf)?.detail;
    if (typeof d === "string" && d.trim()) return d.trim();
  } catch {
    /* not JSON: fine, skip it */
  }
  return "";
}

function satzZu(status: number, rumpf: string): string {
  const eigen = serverText(rumpf);
  if (eigen) return eigen;                       // the server knows better
  if (status === 0) return "Keine Verbindung zum Server.";
  if (status === 401) return "Deine Anmeldung ist abgelaufen — bitte neu anmelden.";
  if (status === 403) return "Dafür fehlt dir die Berechtigung.";
  if (status === 404) return "Das gibt es nicht mehr.";
  if (status === 409) return "Das passt gerade nicht zusammen — bitte neu laden.";
  if (status === 413) return "Die Datei ist zu groß.";
  if (status === 429) return "Zu viele Anfragen auf einmal — kurz warten.";
  if (status >= 500) return "Der Server konnte das gerade nicht beantworten.";
  return "Die Anfrage ist fehlgeschlagen.";
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, {
      credentials: "include",
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    });
  } catch (e) {
    throw new ApiFehler(0, e instanceof Error ? e.message : String(e));
  }
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const fehler = new ApiFehler(r.status, text);
    console.warn("knowledge-api", path, fehler.technisch);
    throw fehler;
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

export interface ListFilter {
  type?: string;
  stage?: Stage;
  q?: string;
  collection_id?: string;
  limit?: number;
}

export interface ObjectCreate {
  type: string;
  title: string;
  body?: string;
  properties?: Record<string, unknown>;
  visibility?: Visibility;
  stage?: Stage;
  parent_id?: string | null;
  icon?: string | null;
  cover?: string | null;
}

export interface ObjectPatch {
  title?: string;
  body?: string;
  properties?: Record<string, unknown>;
  visibility?: Visibility;
  stage?: Stage;
  icon?: string | null;
  cover?: string | null;
}

export const ideasApi = {
  listObjects: (f: ListFilter = {}) => {
    const p = new URLSearchParams();
    if (f.type) p.set("type", f.type);
    if (f.stage) p.set("stage", f.stage);
    if (f.q) p.set("q", f.q);
    if (f.collection_id) p.set("collection_id", f.collection_id);
    p.set("limit", String(f.limit ?? 200));
    return http<{ objects: KbObjectSlim[] }>(`/objects?${p}`).then((r) => r.objects);
  },
  getObject: (id: string) =>
    http<{ object: KbObject }>(`/objects/${id}`).then((r) => r.object),
  createObject: (body: ObjectCreate) =>
    http<{ object: KbObject }>("/objects", { method: "POST", body: JSON.stringify(body) })
      .then((r) => r.object),
  patchObject: (id: string, patch: ObjectPatch) =>
    http<{ object: KbObject }>(`/objects/${id}`, { method: "PATCH", body: JSON.stringify(patch) })
      .then((r) => r.object),
  deleteObject: (id: string) => http<unknown>(`/objects/${id}`, { method: "DELETE" }),

  listActivity: (id: string) =>
    http<{ activity: KbActivity[] }>(`/objects/${id}/activity`).then((r) => r.activity),
  addActivity: (id: string, content: string, kind = "comment") =>
    http<unknown>(`/objects/${id}/activity`, {
      method: "POST", body: JSON.stringify({ kind, content }),
    }),

  createLink: (fromId: string, toId: string, rel = "relates_to") =>
    http<{ link_id: string }>(`/objects/${fromId}/links`, {
      method: "POST", body: JSON.stringify({ to_id: toId, rel }),
    }),
  deleteLink: (linkId: string) => http<unknown>(`/links/${linkId}`, { method: "DELETE" }),

  listTypes: () => http<{ types: KbType[] }>("/types").then((r) => r.types),

  getGraph: () =>
    http<{ objects: KbObjectSlim[]; links: { id: string; from_id: string; to_id: string; rel: string }[] }>("/graph"),

  addShare: (objectId: string, username: string) =>
    http<unknown>(`/objects/${objectId}/shares`, { method: "POST", body: JSON.stringify({ username }) }),
  removeShare: (objectId: string, username: string) =>
    http<unknown>(`/objects/${objectId}/shares/${encodeURIComponent(username)}`, { method: "DELETE" }),
  createType: (t: { id: string; name: string; icon?: string; prop_schema: KbPropDef[] }) =>
    http<{ type: KbType }>("/types", { method: "POST", body: JSON.stringify(t) }).then((r) => r.type),
  patchType: (id: string, patch: { name?: string; icon?: string; prop_schema?: KbPropDef[] }) =>
    http<unknown>(`/types/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  listCollections: () =>
    http<{ collections: KbCollection[] }>("/collections").then((r) => r.collections),
  createCollection: (c: { name: string; icon?: string; description?: string; default_type?: string; visibility?: Visibility }) =>
    http<{ collection: KbCollection }>("/collections", { method: "POST", body: JSON.stringify(c) })
      .then((r) => r.collection),
  patchCollection: (id: string, patch: Partial<Pick<KbCollection, "name" | "icon" | "description" | "default_type" | "visibility" | "settings">>) =>
    http<{ collection: KbCollection }>(`/collections/${id}`, { method: "PATCH", body: JSON.stringify(patch) })
      .then((r) => r.collection),
  deleteCollection: (id: string) => http<unknown>(`/collections/${id}`, { method: "DELETE" }),
  addToCollection: (collectionId: string, objectId: string, position = 0) =>
    http<unknown>(`/collections/${collectionId}/items`, {
      method: "POST", body: JSON.stringify({ object_id: objectId, position }),
    }),
  removeFromCollection: (collectionId: string, objectId: string) =>
    http<unknown>(`/collections/${collectionId}/items/${objectId}`, { method: "DELETE" }),
  // Collection shares (read / edit); anyone with access sees every member.
  listCollectionShares: (collectionId: string) =>
    http<{ owner: string; visibility: Visibility; permission: "owner" | "write" | "read"; shares: KbCollectionShare[] }>(
      `/collections/${collectionId}/shares`),
  addCollectionShare: (collectionId: string, username: string, permission: "read" | "write") =>
    http<{ ok: boolean; share: KbCollectionShare }>(`/collections/${collectionId}/shares`, {
      method: "POST", body: JSON.stringify({ username, permission }),
    }),
  patchCollectionShare: (collectionId: string, username: string, permission: "read" | "write") =>
    http<{ ok: boolean; share: KbCollectionShare }>(
      `/collections/${collectionId}/shares/${encodeURIComponent(username)}`, {
        method: "PATCH", body: JSON.stringify({ permission }),
      }),
  removeCollectionShare: (collectionId: string, username: string) =>
    http<unknown>(`/collections/${collectionId}/shares/${encodeURIComponent(username)}`, { method: "DELETE" }),
  search: (q: string, type?: string) => {
    const p = new URLSearchParams({ q });
    if (type) p.set("type", type);
    return http<{ results: (KbObjectSlim & { snippet?: string })[] }>(`/search?${p}`).then((r) => r.results);
  },

  // ── Tree, backlinks, favorites, trash ──────────────────────────────────────
  getAncestors: (id: string) =>
    http<{ ancestors: { id: string; title: string; icon: string | null; type: string }[] }>(
      `/objects/${id}/ancestors`).then((r) => r.ancestors),
  getChildren: (id: string) =>
    http<{ children: KbObjectSlim[] }>(`/objects/${id}/children`).then((r) => r.children),
  getBacklinks: (id: string) =>
    http<{ backlinks: (KbObjectSlim & { kind: string; anchor_text: string })[] }>(
      `/objects/${id}/backlinks`).then((r) => r.backlinks),
  moveObject: (id: string, parentId: string | null, afterId?: string | null) =>
    http<{ object: KbObject }>(`/objects/${id}/move`, {
      method: "PATCH", body: JSON.stringify({ parent_id: parentId, after_id: afterId ?? null }),
    }).then((r) => r.object),
  listFavorites: () =>
    http<{ favorites: KbObjectSlim[] }>("/favorites").then((r) => r.favorites),
  addFavorite: (id: string) => http<unknown>(`/objects/${id}/favorite`, { method: "PUT" }),
  removeFavorite: (id: string) => http<unknown>(`/objects/${id}/favorite`, { method: "DELETE" }),
  listTrash: () =>
    http<{ trash: (KbObjectSlim & { deleted_at: string | null })[] }>("/trash").then((r) => r.trash),
  restoreObject: (id: string) => http<unknown>(`/objects/${id}/restore`, { method: "POST" }),
  listHistory: (id: string) =>
    http<{ history: KbHistoryEntry[] }>(`/objects/${id}/history`).then((r) => r.history),
  // Diff is computed on read; snapshots remain untouched
  diffHistory: (id: string, version: number, against?: number) =>
    http<{ ops: KbDiffOp[]; summary: { added_chars: number; removed_chars: number; changed: boolean } }>(
      `/objects/${id}/history/${version}/diff${against !== undefined ? `?against=${against}` : ""}`),
  restoreHistory: (id: string, version: number) =>
    http<unknown>(`/objects/${id}/history/${version}/restore`, { method: "POST" }),
  renameHistory: (id: string, version: number, name: string) =>
    http<unknown>(`/objects/${id}/history/${version}`, {
      method: "PATCH", body: JSON.stringify({ name }),
    }),
  importArchive: async (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    const r = await fetch("/api/claraos/knowledge/import", {
      method: "POST", credentials: "include", body: form,
    });
    if (!r.ok) throw new Error(`Import fehlgeschlagen (${r.status})`);
    return r.json() as Promise<{ pages: number; collections: number; rows: number; links_rewritten: number }>;
  },
  exportUrl: (collectionId?: string) =>
    `/api/claraos/knowledge/export${collectionId ? `?collection_id=${collectionId}` : ""}`,

  // ── Templates, duplicate, knowledge graph, mentions ────────────────────────
  listTemplates: (targetType?: string) =>
    http<{ templates: KbTemplate[] }>(
      `/templates${targetType ? `?target_type=${targetType}` : ""}`).then((r) => r.templates),
  createTemplate: (t: {
    name: string; target_type?: string; body?: string; icon?: string;
    default_properties?: Record<string, unknown>; is_default?: boolean;
    visibility?: string; from_object_id?: string;
  }) => http<{ template: { id: string; name: string } }>("/templates", {
    method: "POST", body: JSON.stringify(t),
  }).then((r) => r.template),
  deleteTemplate: (id: string) => http<unknown>(`/templates/${id}`, { method: "DELETE" }),
  createFromTemplate: (b: {
    template_id?: string; type?: string; title: string;
    collection_id?: string; parent_id?: string;
  }) => http<{ object: KbObject }>("/objects/from-template", {
    method: "POST", body: JSON.stringify(b),
  }).then((r) => r.object),
  duplicateObject: (id: string) =>
    http<{ object: KbObject }>(`/objects/${id}/duplicate`, { method: "POST" }).then((r) => r.object),
  knowledgeGraph: () =>
    http<{ nodes: { id: string; title: string; type: string; icon: string | null }[];
           edges: { from: string; to: string; kind: string }[] }>("/knowledge-graph"),
  // Web clipper: fetch the page server-side and save it as an object
  clipPage: (c: {
    url: string; selection?: string; note?: string; title?: string;
    collection_id?: string; fetch_page?: boolean;
  }) => http<{ object: KbObject; warning: string | null; chars: number }>("/clip", {
    method: "POST", body: JSON.stringify(c),
  }),
  getBookmarklet: () =>
    http<{ bookmarklet: string; hinweis: string }>("/clip/bookmarklet"),
  backmentions: (id: string) =>
    http<{ backmentions: KbObjectSlim[] }>(`/objects/${id}/backmentions`).then((r) => r.backmentions),

  // ── Fields, views, filtered rows, relations ────────────────────────────────
  /** Validate a formula and preview it on real rows, without saving. */
  formelVorschau: (collectionId: string, expression: string) =>
    http<{ ok: boolean; fehler: string | null;
           proben: { titel: string; wert: unknown }[] }>(
      `/collections/${collectionId}/formula/preview`,
      { method: "POST", body: JSON.stringify({ expression }) }),
  listFields: (collectionId: string) =>
    http<{ fields: KbField[] }>(`/collections/${collectionId}/fields`).then((r) => r.fields),
  createField: (collectionId: string, f: { key: string; name: string; field_type: number; type_option?: Record<string, unknown>; is_primary?: boolean }) =>
    http<{ field: KbField }>(`/collections/${collectionId}/fields`, {
      method: "POST", body: JSON.stringify(f),
    }).then((r) => r.field),
  patchField: (collectionId: string, fieldId: string, patch: { name?: string; field_type?: number; type_option?: Record<string, unknown> }) =>
    http<{ field: KbField }>(`/collections/${collectionId}/fields/${fieldId}`, {
      method: "PATCH", body: JSON.stringify(patch),
    }).then((r) => r.field),
  deleteField: (collectionId: string, fieldId: string) =>
    http<unknown>(`/collections/${collectionId}/fields/${fieldId}`, { method: "DELETE" }),

  listViews: (collectionId: string) =>
    http<{ views: KbView[] }>(`/collections/${collectionId}/views`).then((r) => r.views),
  createView: (collectionId: string, v: Partial<KbView> & { name: string }) =>
    http<{ view: KbView }>(`/collections/${collectionId}/views`, {
      method: "POST", body: JSON.stringify(v),
    }).then((r) => r.view),
  patchView: (collectionId: string, viewId: string, patch: Partial<KbView>) =>
    http<{ view: KbView }>(`/collections/${collectionId}/views/${viewId}`, {
      method: "PATCH", body: JSON.stringify(patch),
    }).then((r) => r.view),
  deleteView: (collectionId: string, viewId: string) =>
    http<unknown>(`/collections/${collectionId}/views/${viewId}`, { method: "DELETE" }),

  queryRows: (collectionId: string, viewId?: string) => {
    const p = new URLSearchParams();
    if (viewId) p.set("view_id", viewId);
    return http<{ rows: KbRow[]; fields: KbField[]; view_id: string | null }>(
      `/collections/${collectionId}/rows?${p}`);
  },
  aggregate: (collectionId: string, key: string, agg: string, viewId?: string) => {
    const p = new URLSearchParams({ key, agg });
    if (viewId) p.set("view_id", viewId);
    return http<{ key: string; aggregate: string; value: number | null }>(
      `/collections/${collectionId}/aggregate?${p}`);
  },
  setRelation: (objectId: string, fieldKey: string, targetIds: string[]) =>
    http<{ ok: boolean; linked: string[]; skipped: number }>(`/objects/${objectId}/relations`, {
      method: "PUT", body: JSON.stringify({ field_key: fieldKey, target_ids: targetIds }),
    }),

  // ── Comments and notifications ─────────────────────────────────────────────
  listComments: (objectId: string, includeResolved = true) =>
    http<{ comments: KbComment[] }>(
      `/objects/${objectId}/comments?include_resolved=${includeResolved}`).then((r) => r.comments),
  createComment: (objectId: string, c: {
    body: string; anchor_text?: string; anchor_prefix?: string; anchor_suffix?: string;
    parent_id?: string;
  }) => http<{ comment: { id: string } }>(`/objects/${objectId}/comments`, {
    method: "POST", body: JSON.stringify(c),
  }),
  patchComment: (commentId: string, patch: { body?: string; resolved?: boolean }) =>
    http<unknown>(`/comments/${commentId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteComment: (commentId: string) =>
    http<unknown>(`/comments/${commentId}`, { method: "DELETE" }),
  listNotifications: (unreadOnly = false) =>
    http<{ notifications: KbNotification[] }>(
      `/notifications?unread_only=${unreadOnly}`).then((r) => r.notifications),
  markNotificationsRead: () => http<unknown>("/notifications/read", { method: "POST" }),

  /* ── Strategy layer: goal tree and KPIs ─────────────────────────────── */
  goalsTree: (rootId?: string) =>
    http<{ tree: GoalNode[]; count: number }>(
      `/goals/tree${rootId ? `?root_id=${encodeURIComponent(rootId)}` : ""}`),
  /** All KPIs at once: one request instead of one per tile. */
  kpiDashboard: (days = 90) =>
    http<{ kpis: {
             id: string; title: string;
             goal: { id: string; title: string } | null;
             progress: KpiProgress;
             series: { ts: string; value: number }[];
             updated_at: string | null;
           }[]; generated_at: string; days: number }>(`/kpi/dashboard?days=${days}`),

  kpiProgress: (kpiId: string) =>
    http<{ kpi: { id: string; title: string }; progress: KpiProgress;
           series: { ts: string; value: number }[];
           source: KpiSource | null; source_error: KpiSourceError | null }>(
      `/kpi/${kpiId}/progress`),
  /** "Fetch now": fetches immediately without waiting for the polling interval. */
  collectKpi: (kpiId: string) =>
    http<{ result: { value?: number; error?: string; skipped?: string; kind: string } }>(
      `/kpi/${kpiId}/collect`, { method: "POST" }).then((r) => r.result),
  kpiValues: (kpiId: string, limit = 200) =>
    http<{ values: KpiValue[] }>(`/kpi/${kpiId}/values?limit=${limit}`).then((r) => r.values),
  addKpiValue: (kpiId: string, v: { value: number; ts?: string; note?: string; source?: string }) =>
    http<{ ok: true; value_id: string }>(`/kpi/${kpiId}/values`, {
      method: "POST", body: JSON.stringify(v),
    }),
  deleteKpiValue: (kpiId: string, valueId: string) =>
    http<unknown>(`/kpi/${kpiId}/values/${valueId}`, { method: "DELETE" }),
  /** Set a milestone (same date = correction) or remove it. */
  addMilestone: (kpiId: string, date: string, value: number, label?: string) =>
    http<{ ok: true }>(`/kpi/${kpiId}/milestones`, {
      method: "POST", body: JSON.stringify({ date, value, label }),
    }),
  deleteMilestone: (kpiId: string, date: string) =>
    http<unknown>(`/kpi/${kpiId}/milestones/${date}`, { method: "DELETE" }),

  /* ── Action plan in the planner ─────────────────────────────────────── */
  actionPlan: (goalId: string) =>
    http<ActionPlan>(`/goals/${goalId}/action-plan`),
  createActionPlan: (goalId: string) =>
    http<{ ok: true; project_id: number; created: boolean }>(
      `/goals/${goalId}/action-plan`, { method: "POST" }),
  linkTaskToGoal: (goalId: string, projectId: number, taskId: number) =>
    http<{ ok: true }>(`/goals/${goalId}/tasks`, {
      method: "POST", body: JSON.stringify({ project_id: projectId, task_id: taskId }),
    }),
  unlinkTaskFromGoal: (goalId: string, projectId: number, taskId: number) =>
    http<{ ok: true }>(`/goals/${goalId}/tasks/${taskId}?project_id=${projectId}`,
      { method: "DELETE" }),

  /* ── Clara ideas, concepts, impact/effort ───────────────────────────── */
  suggestIdeas: (goalId: string, n = 5) =>
    http<{ ideas: IdeaProposal[] }>(`/goals/${goalId}/suggest-ideas`, {
      method: "POST", body: JSON.stringify({ n }),
    }).then((r) => r.ideas),
  acceptIdea: (goalId: string, p: IdeaProposal) =>
    http<{ object: KbObject }>(`/goals/${goalId}/ideas`, {
      method: "POST", body: JSON.stringify(p),
    }),
  developConcept: (ideaId: string, goalId?: string) =>
    http<{ object: KbObject }>(`/objects/${ideaId}/develop-concept`, {
      method: "POST", body: JSON.stringify({ goal_id: goalId ?? null }),
    }),
  goalMatrix: (goalId: string) =>
    http<{ goal: { id: string; title: string }; items: MatrixItem[] }>(
      `/goals/${goalId}/matrix`),
  setContribution: (goalId: string, objectId: string, impact: number, effort: number) =>
    http<{ link_id: string }>(`/goals/${goalId}/contributions/${objectId}`, {
      method: "POST", body: JSON.stringify({ impact, effort }),
    }),
  rateContribution: (goalId: string, objectId: string) =>
    http<{ suggested: SuggestedRating }>(
      `/goals/${goalId}/contributions/${objectId}/rate`, { method: "POST" }),
  removeContribution: (goalId: string, objectId: string) =>
    http<unknown>(`/goals/${goalId}/contributions/${objectId}`, { method: "DELETE" }),
  promoteToPlan: (goalId: string, objectId: string) =>
    http<{ ok: true; project_id: number; task_id: number }>(
      `/goals/${goalId}/promote/${objectId}`, { method: "POST" }),

  /* ── Kaizen ─────────────────────────────────────────────────────────── */
  fiveWhyStep: (goalId: string, problem: string, chain: WhyLink[]) =>
    http<{ question: string | null; candidates: string[]; done: boolean; note: string | null }>(
      `/goals/${goalId}/five-why/step`, {
        method: "POST", body: JSON.stringify({ problem, chain }),
      }),
  fiveWhyFinish: (goalId: string, problem: string, chain: WhyLink[]) =>
    http<{ object: KbObject; root_cause: string; countermeasures: Countermeasure[] }>(
      `/goals/${goalId}/five-why`, {
        method: "POST", body: JSON.stringify({ problem, chain }),
      }),
  paretoCauses: (goalId: string, problem: string) =>
    http<{ unit: string; causes: string[] }>(`/goals/${goalId}/pareto/causes`, {
      method: "POST", body: JSON.stringify({ problem }),
    }),
  pareto: (goalId: string, problem: string, items: { cause: string; value: string; unit: string }[]) =>
    http<{ object: KbObject; result: { items: ParetoRow[]; vital_few: string[] } }>(
      `/goals/${goalId}/pareto`, {
        method: "POST", body: JSON.stringify({ problem, items }),
      }),
  goalAnalyses: (goalId: string) =>
    http<{ analyses: Analysis[] }>(`/goals/${goalId}/analyses`).then((r) => r.analyses),
  addPlanTask: (goalId: string, title: string, description?: string) =>
    http<{ ok: true; task_id: number }>(`/goals/${goalId}/action-plan/tasks`, {
      method: "POST", body: JSON.stringify({ title, description }),
    }),
};
