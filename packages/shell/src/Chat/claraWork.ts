/**
 * claraWork — a single source for "what is Clara working on right now?".
 *
 * Previously every mount of `ActiveAgentsPanel` polled on its own. Since the
 * indicator sits in the taskbar (and is still embedded in the chat), that
 * would mean two pairs of requests in parallel. Hence a single
 * subscriber-counted poller: it starts with the first listener and stops with
 * the last one — without an open shell nothing runs.
 *
 * Deliberately not a zustand store: the shell has none of its own, they all
 * live in `@claraos/core`. `useSyncExternalStore` is plenty for a read stream.
 */
import { useSyncExternalStore } from "react";

export interface ActiveStream {
  id: string;
  app_id?: string | null;
  surface?: string | null;
  object_uri?: string | null;
  wrapp_instance_id?: string | null;
  duration_s: number;
  started_at: number;
  last_delta_at: number;
}

/** Planner worklog "Clara is working on task X" — longer-lived than streams. */
export interface PlannerWork {
  project_id: number;
  task_id: number;
  in_work_by: string;
  since: string | null;
  stale: boolean;
}

export interface ClaraWorkState {
  streams: ActiveStream[];
  plannerWork: PlannerWork[];
  taskTitles: Record<number, string>;
}

const STREAM_ENDPOINT = "/api/claraos/chat/v2/active-streams";
const PLANNER_ENDPOINT = "/api/claraos/planner/in-work";
const STREAM_POLL_MS = 2000;
// Planner in-work is a DB query and changes rarely → its own, slower interval.
const PLANNER_POLL_MS = 10000;

const EMPTY: ClaraWorkState = { streams: [], plannerWork: [], taskTitles: {} };

let snapshot: ClaraWorkState = EMPTY;
const listeners = new Set<() => void>();
let streamTimer: number | null = null;
let plannerTimer: number | null = null;
let running = false;

function emit(next: Partial<ClaraWorkState>): void {
  const merged = { ...snapshot, ...next };
  // Preserve referential equality when nothing changed — otherwise every
  // shell re-renders every 2 seconds even though Clara is doing nothing.
  if (
    merged.streams === snapshot.streams &&
    merged.plannerWork === snapshot.plannerWork &&
    merged.taskTitles === snapshot.taskTitles
  ) return;
  snapshot = merged;
  listeners.forEach((l) => l());
}

/** Same list? Then keep the old reference (see emit). */
function sameIds<T extends { id?: string; task_id?: number }>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => (x.id ?? x.task_id) === (b[i].id ?? b[i].task_id));
}

async function pollStreams(): Promise<void> {
  if (!running) return;
  try {
    const resp = await fetch(STREAM_ENDPOINT, { credentials: "include" });
    if (resp.ok) {
      const data = await resp.json();
      const next: ActiveStream[] = data.streams ?? [];
      // Duration keeps running → always take it, unless the list stayed empty.
      if (!(next.length === 0 && snapshot.streams.length === 0)) emit({ streams: next });
    }
  } catch {
    // Silent — the endpoint is briefly gone during a deploy.
  }
  if (running) streamTimer = window.setTimeout(pollStreams, STREAM_POLL_MS);
}

async function pollPlanner(): Promise<void> {
  if (!running) return;
  try {
    const resp = await fetch(PLANNER_ENDPOINT, { credentials: "include" });
    if (resp.ok) {
      const data: PlannerWork[] = await resp.json();
      if (Array.isArray(data) && !sameIds(data, snapshot.plannerWork)) {
        emit({ plannerWork: data });
        void loadTitles(data);
      }
    }
  } catch {
    // Silent — planner may not be connected/deployed.
  }
  if (running) plannerTimer = window.setTimeout(pollPlanner, PLANNER_POLL_MS);
}

/** Load task titles (only for new IDs; entries are rare → no batching needed). */
async function loadTitles(work: PlannerWork[]): Promise<void> {
  const missing = work.filter((w) => snapshot.taskTitles[w.task_id] === undefined).slice(0, 5);
  if (missing.length === 0) return;
  const add: Record<number, string> = {};
  for (const w of missing) {
    try {
      const r = await fetch(`/api/claraos/planner/api/tasks/${w.task_id}`, { credentials: "include" });
      add[w.task_id] = r.ok ? ((await r.json())?.title ?? `#${w.task_id}`) : `#${w.task_id}`;
    } catch {
      add[w.task_id] = `#${w.task_id}`;
    }
  }
  emit({ taskTitles: { ...snapshot.taskTitles, ...add } });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!running) {
    running = true;
    void pollStreams();
    void pollPlanner();
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size > 0) return;
    running = false;
    if (streamTimer != null) window.clearTimeout(streamTimer);
    if (plannerTimer != null) window.clearTimeout(plannerTimer);
    streamTimer = plannerTimer = null;
  };
}

const getSnapshot = () => snapshot;
// There is no server rendering here, but useSyncExternalStore requires the
// third parameter as soon as any build calls it.
const getServerSnapshot = () => EMPTY;

/** Subscribes to the shared stream. The poller only lives while someone is watching. */
export function useClaraWork(): ClaraWorkState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Number of running tasks — visibility and counter of the tray entry. */
export function useClaraWorkCount(): number {
  const { streams, plannerWork } = useClaraWork();
  return streams.length + plannerWork.length;
}
