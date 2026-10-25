/**
 * Thin client for /api/claraos/chat/v2/* — Open WebUI proxy.
 * No state, no caching, no React. Pure fetch wrappers.
 */
import { i18n } from "@claraos/core";
import type { ChatSurface } from "@claraos/core";

const BASE = "/api/claraos/chat/v2";

export interface WebUIFolder {
  id: string;
  name: string;
  parent_id?: string | null;
  is_expanded?: boolean;
  user_id?: string;
  created_at?: number;
  updated_at?: number;
}

/** A card in the chat — a catalog instead of code. `kind` selects the
 *  component in Chat/blocks, `props` fills it; anything unknown is skipped. */
export interface ChatBlock {
  id: string;
  kind: string;
  props: Record<string, unknown>;
}

export interface WebUIMessage {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
  files?: { type: string; name?: string; url?: string }[];
  blocks?: ChatBlock[];
  /** Follow-up question chips (from `suggest`) and sources (from `final.sources`). */
  suggestions?: string[];
  sources?: { title: string; url: string }[];
  /**
   * Live activity state (current sub-agent, current tool, completed
   * sub-agent summaries). Driven by claraos_event SSE events; persisted to
   * WebUI message metadata so it survives chat reload.
   */
  activity?: ClaraActivity;
  /** "stimme": spoken in a live conversation (transcript), not typed. */
  via?: "stimme";
}

/** TodoWrite item — reflects the backend's TodoItem dataclass. */
export interface ClaraTodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Active plan card (before execute) — soft plan mode for complexity≥4. */
export interface ClaraPendingPlan {
  planId: string;
  plan: string;
  waitSeconds: number;
  proposedAt: number;  // Date.now() at receive
}

/** One input of a form card (ask_user_question with `fields`). */
export interface ClaraQuestionField {
  name: string;
  label: string;
  type: "text" | "choice" | "date" | "number";
  options?: string[];
  placeholder?: string;
  required?: boolean;
}

/** Active AskUserQuestion card. */
export interface ClaraPendingQuestion {
  questionId: string;
  question: string;
  options: { label: string; description?: string }[];
  /** Form instead of buttons; answered as a JSON object {name: value}. */
  fields?: ClaraQuestionField[];
  waitSeconds: number;
  proposedAt: number;
}

/** Live activity for an in-flight or completed assistant message. */
export interface ClaraActivity {
  phase: "thinking" | "planning" | "executing" | "finalizing" | "done";
  /**
   * Parallel sub-agents currently running (multi-intent splits dispatch
   * them simultaneously). Keyed by sub_id. This used to be a single
   * `activeAgent` slot, but parallel dispatches overwrote it.
   */
  activeAgents: Record<string, ClaraActiveAgent>;
  /**
   * Parallel in-flight tool calls. Keyed by tool_id (OpenAI tool-call id).
   * Same fix-rationale as activeAgents — react_agent fires tool.start in
   * parallel batches.
   */
  activeTools: Record<string, ClaraActiveTool>;
  activeMeta?: { domain: string; taskSummary?: string; startedAt: number };
  completedSubAgents: ClaraSubAgentSummary[];
  toolCalls: ClaraToolCall[];
  /** Live TodoWrite list, maintained by the agent. */
  todoList?: ClaraTodoItem[];
  /** Active plan card (before execute) — `null`/undefined when no plan
   * mode is active or the plan was already approved/rejected. */
  pendingPlan?: ClaraPendingPlan | null;
  /** Active ask_user_question card. */
  pendingQuestion?: ClaraPendingQuestion | null;
  startedAt: number;
  finishedAt?: number;
  agentUsed?: string;
  taskType?: string;
  toolsCount?: number;
  durationMs?: number;
  slowNotice?: string;
}

export interface ClaraActiveAgent {
  subId: string;
  agent: string;
  model?: string;
  intent?: string;
  startedAt: number;
}

export interface ClaraActiveTool {
  id?: string;
  name: string;
  argsSummary: string;
  icon?: string;
  server?: string;
  startedAt: number;
  /** Which active sub-agent this tool belongs to (for grouping). */
  subId?: string;
}

export interface ClaraToolCall {
  id?: string;
  name: string;
  argsSummary: string;
  icon?: string;
  server?: string;
  ok: boolean;
  resultSummary?: string;
  durationMs?: number;
  subId?: string;
  /** When the tool ended (used for "sticky" display in
   * ActivityCard so very fast tools stay visible for ~2s). */
  endedAt?: number;
  /** Original args of a successful navigate_to call — the chat UI renders
   * clickable deep-link cards from them that repeat the navigation via
   * POST /actions/navigate. */
  navArgs?: { app_id?: string; pattern_key?: string; params?: Record<string, unknown> };
}

export interface ClaraSubAgentSummary {
  subId: string;
  intent: string;
  agent: string;
  model?: string;
  toolsCalled: string[];
  toolCallIds?: string[];
  summary?: string;
  durationMs?: number;
}

export interface WebUIChatMeta {
  app_id?: string;
  object_uri?: string;
  surface?: ChatSurface;
  [key: string]: unknown;
}

export interface WebUIChatSummary {
  id: string;
  title: string;
  folder_id?: string | null;
  pinned?: boolean;
  archived?: boolean;
  meta?: WebUIChatMeta;
  updated_at?: number;
  created_at?: number;
}

export interface WebUIChatDetail extends WebUIChatSummary {
  chat?: {
    title?: string;
    messages?: WebUIMessage[];
    history?: { messages: Record<string, WebUIMessage>; currentId?: string | null };
    models?: string[];
    meta?: WebUIChatMeta;
  };
}

async function http<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
    credentials: "include",
    ...init,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`chat-v2 ${method} ${path} failed: ${resp.status} ${txt.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

// ── Folders ──
export const folders = {
  list: () => http<WebUIFolder[]>("GET", "/folders"),
  create: (name: string, parent_id?: string) =>
    http<WebUIFolder>("POST", "/folders", { name, parent_id }),
  rename: (id: string, name: string) =>
    http<unknown>("PATCH", `/folders/${id}`, { name }),
  reparent: (id: string, parent_id: string | null) =>
    http<unknown>("PATCH", `/folders/${id}`, { parent_id }),
  remove: (id: string) => http<unknown>("DELETE", `/folders/${id}`),
  cleanupCandidates: () =>
    http<{ candidates: { id: string; name: string; parent_id?: string | null }[] }>(
      "GET",
      "/folders/cleanup-candidates",
    ),
  cleanup: () =>
    http<{ deleted: string[]; failed: unknown[]; count: number }>(
      "POST",
      "/folders/cleanup",
    ),
};

// ── Chats ──
export const chats = {
  list: (params: { folder_id?: string; app_id?: string; object_uri?: string; include_folders?: boolean; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v != null && v !== false && qs.set(k, String(v)));
    const tail = qs.toString();
    return http<WebUIChatSummary[]>("GET", `/chats${tail ? `?${tail}` : ""}`);
  },
  get: (id: string) => http<WebUIChatDetail>("GET", `/chats/${id}`),
  create: (input: {
    title: string;
    folder_id?: string;
    app_id?: string;
    object_uri?: string;
    surface?: ChatSurface;
    models?: string[];
    messages?: WebUIMessage[];
  }) => http<WebUIChatDetail>("POST", "/chats", input),
  remove: (id: string) => http<unknown>("DELETE", `/chats/${id}`),
  rename: (id: string, title: string) =>
    http<unknown>("PATCH", `/chats/${id}`, { title }),
  /** Save the thread server-side after the stream ends (quick chats
   *  otherwise only persisted the first user message). */
  saveMessages: (id: string, messages: WebUIMessage[]) =>
    http<unknown>("PATCH", `/chats/${id}`, {
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        ...(m.files?.length ? { files: m.files } : {}),
        ...(m.blocks?.length ? { blocks: m.blocks } : {}),
        ...(m.sources?.length ? { sources: m.sources } : {}),
        ...(m.suggestions?.length ? { suggestions: m.suggestions } : {}),
      })),
    }),
  moveToFolder: (id: string, folderId: string | null) =>
    http<unknown>("PATCH", `/chats/${id}/folder`, { folder_id: folderId }),
};

// ── Streaming completions ──
export interface StreamChunk {
  /** Server-side run id (header X-Claraos-Stream-Id), needed to stop the run. */
  streamId?: string;
  delta?: string;
  /** Structured side-channel events (claraos_event). */
  event?: ClaraosStreamEvent;
  finish?: boolean;
  raw?: unknown;
  error?: string;
}

/**
 * Side-channel events emitted by clara-agent's _claraos_event()
 * helper. WebUI/LiteLLM pass through unknown JSON keys at the SSE-data root,
 * so these arrive as `{claraos_event: {type, ...}}` next to standard
 * `{choices: [...]}` chunks.
 */
export interface ClaraosStreamEvent {
  type:
    | "phase"
    | "tool.start"
    | "tool.end"
    | "agent.start"
    | "agent.switch"
    | "agent.end"
    | "meta.start"
    | "meta.end"
    | "slow.notice"
    | "progress"
    | "final"
    | "question.proposal"
    | "question.answered"
    | "plan.proposal"
    | "plan.approved"
    | "plan.cancelled"
    | "todo.update"
    | "draft.reset"
    | "ui.block"
    | "ui.block.update"
    | "job.started"
    | "job.done"
    | "job.failed"
    | "suggest";
  // Free-form payload — fields depend on type.
  [key: string]: unknown;
}

/**
 * Extract `«CLARAEV»{json}«/CLARAEV»` markers from a content
 * string. Returns the parsed events + the cleaned content (markers stripped).
 * Tolerant: skips invalid JSON inside a marker rather than throwing.
 */
// The marker is chosen to survive WebUI/LiteLLM content filtering. The
// rare unicode brackets `«»` get stripped, but plain-ASCII triple-pipes
// pass through intact.
const CLARAEV_RE = /\|\|\|CLARAEV\|\|\|([\s\S]*?)\|\|\|\/CLARAEV\|\|\|/g;
function extractClaraosEvents(text: string): {
  events: ClaraosStreamEvent[];
  cleaned: string;
} {
  if (!text.includes("|||CLARAEV|||")) return { events: [], cleaned: text };
  const events: ClaraosStreamEvent[] = [];
  const cleaned = text.replace(CLARAEV_RE, (_, body) => {
    try {
      const parsed = JSON.parse(body) as ClaraosStreamEvent;
      events.push(parsed);
    } catch {
      /* malformed marker — drop silently */
    }
    return "";
  });
  return { events, cleaned };
}

export async function streamCompletion(
  body: {
    model?: string;
    messages: WebUIMessage[];
    chat_id?: string;
    meta?: WebUIChatMeta;
    stream?: boolean;
    /** Files stored in Open WebUI (RAG context). */
    files?: { type: string; id?: string; name?: string }[];
  },
  onChunk: (c: StreamChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(`${BASE}/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    credentials: "include",
    signal,
  });
  if (!resp.ok || !resp.body) {
    onChunk({ error: `HTTP ${resp.status}` });
    return;
  }
  // Open WebUI answers a request for an invisible model with HTTP 200 and
  // the JSON body {"detail":"Model not found"} — no SSE. Previously this
  // vanished silently: the reply stayed empty, no error bar, nothing.
  // An error that looks like silence is the worst kind of error.
  const ctype = resp.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    let detail = i18n.t("chatWork:errors.unknown");
    try {
      const j = await resp.json();
      detail = typeof j?.detail === "string" ? j.detail : JSON.stringify(j).slice(0, 200);
    } catch { /* empty body */ }
    onChunk({ error: detail === "Model not found"
      ? i18n.t("chatWork:errors.modelNotFound")
      : detail });
    return;
  }
  // The run continues server-side when the connection drops (the answer is
  // stored in the chat). Stopping it on purpose needs this id.
  const streamId = resp.headers.get("x-claraos-stream-id");
  if (streamId) onChunk({ streamId });
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // The proxy also passes the error body through with text/event-stream
  // (probe: {"detail":"Model not found"} without a single data: line).
  // So remember whether any data frame arrived at all, and read the rest at the end.
  let datenrahmen = 0;
  let fremdtext = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) { if (line) fremdtext += line; continue; }
      datenrahmen++;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        onChunk({ finish: true });
        return;
      }
      try {
        const json = JSON.parse(data);
        // Structured side-channel event (legacy: separate root key)
        if (json.claraos_event) {
          onChunk({ event: json.claraos_event as ClaraosStreamEvent, raw: json });
          continue;
        }
        const rawDelta =
          json.choices?.[0]?.delta?.content ??
          json.choices?.[0]?.message?.content ??
          undefined;
        if (typeof rawDelta === "string") {
          // WebUI strips unknown SSE root-keys, so events are
          // embedded inline in content. Extract marker-wrapped events and
          // strip them before forwarding the cleaned text as `delta`.
          const { events, cleaned } = extractClaraosEvents(rawDelta);
          for (const ev of events) onChunk({ event: ev, raw: json });
          if (cleaned) onChunk({ delta: cleaned, raw: json });
          else if (events.length === 0) onChunk({ raw: json });
        } else {
          onChunk({ raw: json });
        }
      } catch {
        /* heartbeat or partial */
      }
    }
  }
  if (datenrahmen === 0) {
    const rest = (fremdtext + buf).trim();
    if (rest) {
      let detail = rest.slice(0, 200);
      try {
        const j = JSON.parse(rest);
        if (typeof j?.detail === "string") detail = j.detail;
      } catch { /* not JSON */ }
      onChunk({ error: detail === "Model not found"
        ? i18n.t("chatWork:errors.modelNotFound")
        : detail });
      return;
    }
  }
  onChunk({ finish: true });
}

/** Stop button: end a running answer on purpose (fire and forget). */
export function cancelStream(streamId: string): void {
  fetch(`${BASE}/streams/${encodeURIComponent(streamId)}/cancel`, {
    method: "POST",
    credentials: "include",
  }).catch(() => undefined);
}

// ── Image attachments ──
/** Downscale an image in the browser: long edge `max` px, JPEG. Returns plain
 *  base64 (without data: prefix) for the vision pre-pass in chat_v2, and a
 *  small preview image as a data URL for the history. */
export async function bildVerkleinern(
  file: File,
  max = 1280,
  thumbMax = 240,
): Promise<{ name: string; b64: string; mime: string; thumb: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error(i18n.t("chatWork:errors.imageUnreadable")));
      i.src = url;
    });
    const zeichne = (grenze: number, qualitaet: number) => {
      const f = Math.min(1, grenze / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * f));
      c.height = Math.max(1, Math.round(img.naturalHeight * f));
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", qualitaet);
    };
    const gross = zeichne(max, 0.85);
    const thumb = zeichne(thumbMax, 0.7);
    return { name: file.name || "bild.jpg", b64: gross.split(",")[1] ?? "", mime: "image/jpeg", thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── File upload ──
export async function uploadFile(file: File): Promise<{ id?: string; url?: string; filename?: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const resp = await fetch(`${BASE}/files`, {
    method: "POST",
    body: fd,
    credentials: "include",
  });
  if (!resp.ok) throw new Error(`upload failed: ${resp.status}`);
  return resp.json();
}

// ── STT ──
export async function transcribe(
  blob: Blob,
  language = "de",
  opts: { signal?: AbortSignal; filename?: string } = {},
): Promise<{ text?: string }> {
  const fd = new FormData();
  fd.append("file", blob, opts.filename ?? "speech.webm");
  fd.append("language", language);
  const resp = await fetch(`${BASE}/audio/transcribe`, {
    method: "POST",
    body: fd,
    credentials: "include",
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`transcribe failed: ${resp.status}`);
  return resp.json();
}

// ── TTS ──
export async function speak(
  text: string,
  opts: { voice?: string; model?: string; format?: "wav" | "mp3" } = {},
): Promise<Blob> {
  const resp = await fetch(`${BASE}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Default TTS model and voice; the API overrides legacy values server-side anyway
      // (cached PWAs), this is just hygiene.
      model: opts.model ?? "supertonic-3",
      input: text,
      voice: opts.voice ?? "F1",
      response_format: opts.format ?? "wav",
    }),
    credentials: "include",
  });
  if (!resp.ok) throw new Error(`tts failed: ${resp.status}`);
  return resp.blob();
}
