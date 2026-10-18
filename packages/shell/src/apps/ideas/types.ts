/** Types for the "Ideas" app (BFF: routers/knowledge.py, tables claraos_kb_*). */

export type Stage = "spark" | "developing" | "elaborated" | "planned" | "done" | "archived";
export type Visibility = "private" | "family" | "shared";
export type ObjectType = "idea" | "vision" | "note" | string;

export interface KbObjectSlim {
  id: string;
  type: ObjectType;
  owner: string;
  visibility: Visibility;
  title: string;
  properties: Record<string, unknown>;
  stage: Stage | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  body_preview: string;
  /** Page tree and polish fields */
  parent_id?: string | null;
  position?: string | null;
  icon?: string | null;
  cover?: string | null;
  /** Enforced by the server: owner OR member with write access of a collection
   *  containing the object. If the field is missing (older responses), the UI
   *  falls back to comparing the owner. */
  can_edit?: boolean;
}

export interface KbLink {
  id: string;
  rel: string;
  direction: "out" | "in";
  other_id: string;
  other_title: string;
  other_type: ObjectType;
}

export interface KbActivity {
  id: string;
  object_id: string;
  actor: string;
  kind: "comment" | "analysis" | "question" | "answer" | "stage_change" | "edit" | "handoff";
  content: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface KbObject extends Omit<KbObjectSlim, "body_preview"> {
  body: string;
  /** Collections containing this object. The server includes them so the
   *  detail view can show the collection's COLUMNS, not just the object
   *  type's prop_schema. */
  collections?: { id: string; name: string; icon: string | null }[];
  deleted_at: string | null;
  rag_status: string;
  rag_indexed_at: string | null;
  links: KbLink[];
  activity: KbActivity[];
  /** Only included for the owner (recipients of the share) */
  shares?: string[];
}

export interface KbCollection {
  id: string;
  owner: string;
  visibility: Visibility;
  name: string;
  icon: string | null;
  description: string | null;
  default_type: string | null;
  item_count?: number;
  /** Free-form collection settings: row templates and lock.
   *  `gesperrt` ("locked") protects the STRUCTURE (columns, views, deletion),
   *  not the contents. Notion calls this "lock database", and that is exactly
   *  the intent: editing yes, restructuring no. */
  settings?: {
    gesperrt?: boolean;
    zeilen_vorlagen?: { name: string; icon?: string; properties: Record<string, unknown> }[];
  };
  created_at: string;
  updated_at: string;
  /** The caller's role on the collection (collection shares). */
  permission?: "owner" | "write" | "read";
  is_owner?: boolean;
  can_edit?: boolean;
}

export type CollPermission = "read" | "write";

/** A collection shared with one person. */
export interface KbCollectionShare {
  username: string;
  permission: CollPermission;
  created_by: string;
  created_at: string | null;
}

export interface KbPropDef {
  key: string;
  label: string;
  kind: "text" | "number" | "date" | "select" | "multi_select" | "url" | "checkbox";
  options?: string[];
}

export interface KbType {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  is_system: boolean;
  owner: string | null;
  prop_schema: KbPropDef[];
}

/** Field registry and named views per collection.
 * field_type IDs are STABLE (append-only); see migrations/019. */
export const FieldType = {
  Text: 0, Number: 1, Date: 2, Select: 3, MultiSelect: 4, Url: 5,
  Checkbox: 6, Checklist: 7, Media: 8, Person: 9,
  Relation: 10, Rollup: 11, CreatedTime: 12, UpdatedTime: 13, Formula: 14,
} as const;

export const FIELD_TYPE_LABEL: Record<number, string> = {
  0: "Text", 1: "Zahl", 2: "Datum", 3: "Auswahl", 4: "Mehrfachauswahl",
  5: "Link", 6: "Häkchen", 7: "Checkliste", 8: "Medien", 9: "Person",
  10: "Verknüpfung", 11: "Rollup", 12: "Erstellt am", 13: "Geändert am", 14: "Formel",
};

export interface KbField {
  id: string;
  collection_id: string;
  key: string;
  name: string;
  field_type: number;
  type_option: Record<string, unknown>;
  is_primary: boolean;
  position: string | null;
}

export type ViewLayout = "table" | "board" | "gallery" | "list" | "calendar" | "timeline";

/** Filter tree: group {op:"and"|"or", children} or condition {key, op, value} */
export interface KbFilterNode {
  op: string;
  children?: KbFilterNode[];
  key?: string;
  value?: unknown;
}

export interface KbView {
  id: string;
  collection_id: string;
  name: string;
  layout: ViewLayout;
  layout_setting: Record<string, unknown>;
  filters: KbFilterNode | Record<string, never>;
  sorts: { key: string; dir: "asc" | "desc" }[];
  group_setting: Record<string, unknown>;
  /** Per column: visible? width? plus the footer aggregate (`agg`, a key
   *  from `services/kb_query.py`; the server stores the field as open JSONB,
   *  so no backend change is needed). */
  /** Per column, all for THIS view only (Notion pattern):
   *  `visible` shown · `width` width · `agg` footer calculation ·
   *  `umbruch` wrap text in the cell · `anzeige` display variant
   *  (for relations "namen" = names or "anzahl" = count). */
  field_settings: Record<string, {
    visible?: boolean; width?: number; agg?: string;
    umbruch?: boolean; anzeige?: string;
  }>;
  position: string | null;
}

export interface KbRow extends KbObjectSlim {
  /** Rollup values computed on read, key → number */
  rollups?: Record<string, number | null>;
  /** Formula results computed on read, key → value or "⚠ …" */
  formulas?: Record<string, string | number | boolean | null>;
}

/** Inline comment. The anchor is a QUOTE: the server re-locates it in the
 * current body, hence anchor_status ("orphan" = the quoted text no longer
 * exists). */
export interface KbComment {
  id: string;
  parent_id: string | null;
  author: string;
  body: string;
  anchor_text: string;
  anchor_status: "exact" | "fuzzy" | "orphan" | "none";
  anchor_start: number | null;
  resolved: boolean;
  resolved_by: string | null;
  created_at: string;
}

/** Version history with a diff computed on read. */
export interface KbHistoryEntry {
  version: number;
  name: string | null;
  title: string;
  actor: string;
  created_at: string;
  body_len?: number;
}

export interface KbDiffOp {
  type: "equal" | "insert" | "delete";
  text: string;
}

/** Template: body plus default properties per type. */
export interface KbTemplate {
  id: string;
  name: string;
  icon: string | null;
  target_type: string | null;
  body: string;
  default_properties: Record<string, unknown>;
  is_default: boolean;
  visibility: string;
  owner: string;
}

export interface KbNotification {
  id: string;
  object_id: string | null;
  object_title: string | null;
  kind: "comment" | "mention" | "reply";
  actor: string;
  snippet: string;
  read: boolean;
  created_at: string;
}

/* ── Strategy layer ────────────────────────────────────────────────────────
 * Goals form a tree via parent_id; KPIs attach to a goal via the edge
 * rel='measured_by'. Progress arrives fully computed from the server
 * (services/kpi_progress.py). The UI recomputes NOTHING, otherwise the status
 * color in the tree and the one on the KPI card would drift apart. */

// "observing": already measuring, but still collecting baseline values.
export type KpiStatus = "done" | "on_track" | "at_risk" | "blind" | "behind" | "observing";

/** Dated milestone on the way to the target value. */
export interface Milestone {
  date: string;
  value: number;
  label?: string;
  /** Position on the bar (attainment of this milestone) */
  attainment?: number | null;
}

export interface KpiProgress {
  unit: string;
  direction: "up" | "down";
  baseline: number | null;
  target: number | null;
  current: number | null;
  current_ts: string | null;
  samples: number;
  attainment: number | null;
  expected: number | null;
  /** Where the value should be today; follows the path through the milestones */
  expected_value?: number | null;
  milestones?: Milestone[];
  next_milestone?: Milestone | null;
  pace: number | null;
  /** Direction over recent weeks. `null` = too little data to say,
   *  explicitly NOT the same as "flat". */
  trend?: "up" | "down" | "flat" | null;
  /** Slope per week in the KPI's unit. */
  trend_per_week?: number | null;
  /** How well the regression line fits (0…1); separates a trend from noise. */
  trend_r2?: number | null;
  /** Does the direction help the goal? `null` when stagnant. */
  trend_good?: boolean | null;
  trend_samples?: number;
  /** Distance to the expected value, in the unit. Positive = behind plan. */
  behind_by?: number | null;
  /** The planned path (start → milestones → deadline) for the chart. */
  plan_path?: { date: string; value: number }[];
  weight: number;
  aggregation: string;
  status: KpiStatus;
  /** Plain-language reason for the status; shown as a tooltip in the UI. */
  reason: string;
}

/** Where values come from. `manual` = entered by a person. Optional
 *  site-specific kinds may be registered (heim/kpiSources.tsx). */
export type KpiSourceKind = "manual" | "planner" | "formula" | (string & {});

export interface KpiSource {
  kind: KpiSourceKind;
  /** Depending on kind, e.g. {project_id,metric} (planner) | {expression,inputs} (formula) */
  config?: Record<string, unknown>;
  every_minutes?: number;
}

/** Last failure of the source; shown on the card, never swallowed. */
export interface KpiSourceError {
  at: string;
  message: string;
}

export interface KpiNode {
  id: string;
  title: string;
  icon: string | null;
  owner: string;
  progress: KpiProgress;
  source?: KpiSource | null;
  source_error?: KpiSourceError | null;
}

export interface GoalNode {
  id: string;
  type: "vision" | "goal";
  title: string;
  icon: string | null;
  owner: string;
  stage: Stage | null;
  depth: number;
  parent_id: string | null;
  properties: Record<string, unknown>;
  kpis: KpiNode[];
  children: GoalNode[];
  progress: { attainment: number | null; status: KpiStatus; parts: number };
}

/* ── Action plan (Vikunja remains the single source of truth) ────────────── */

export interface PlanTask {
  project_id: number;
  task_id: number;
  title: string;
  done: boolean;
  due_date?: string | null;
  /** Task is linked but can no longer be read from the planner (deleted?) */
  missing?: boolean;
}

export interface ActionPlan {
  project_id: number | null;
  total: number;
  done: number;
  open: number;
  next_due: string | null;
  tasks: PlanTask[];
  /** Set when something could NOT be read. An unreadable project is not
   *  an empty plan and must not look like one. */
  warning: string | null;
}

/* ── Ideas, concepts, impact/effort ──────────────────────────────────────── */

/** Clara's estimate; kept separate from the confirmed rating. */
export interface SuggestedRating {
  impact: number;
  effort: number;
  confidence?: number;
  reason?: string;
}

export interface MatrixItem {
  link_id: string;
  id: string;
  type: string;
  title: string;
  stage: Stage | null;
  owner: string;
  body_preview: string;
  /** Confirmed by a person (null = only a suggestion or nothing at all) */
  impact: number | null;
  effort: number | null;
  rated_by?: string;
  suggested?: SuggestedRating | null;
}

export interface IdeaProposal {
  title: string;
  why: string;
  effort: number;
  impact: number;
}

/* ── Kaizen (5 Whys, Pareto) ─────────────────────────────────────────────── */

export interface WhyLink {
  question: string;
  answer: string;
}

export interface Countermeasure {
  title: string;
  why?: string;
}

export interface ParetoRow {
  cause: string;
  value: number;
  unit: string;
  share: number;
  /** Cumulative share; entries up to 0.8 belong to the "vital few" */
  cumulative: number;
}

export interface Analysis {
  id: string;
  title: string;
  method: "five_why" | "pareto" | string;
  problem: string;
  root_cause?: string;
  countermeasures: Countermeasure[];
  vital_few: string[];
  pareto: ParetoRow[];
  unit?: string;
  created_at: string;
}

export interface KpiValue {
  id: string;
  ts: string;
  value: number;
  source: string;
  note: string | null;
  created_by: string;
}
