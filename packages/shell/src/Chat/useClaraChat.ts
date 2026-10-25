/**
 * useClaraChat — React hook driving the unified ClaraChatPanel.
 *
 * Responsibilities:
 *   * load / create the active chat for the given (surface, appId, objectUri)
 *   * stream messages via /api/claraos/chat/v2/completions
 *   * manage voice-mode state (idle / recording / transcribing / speaking)
 *   * lazy-create auto-folders for inline / quick chats
 *
 * State is local to the hook (useState / useRef). Global store coupling is
 * limited to the voice store: mic level ticks (~15 Hz) are written straight to
 * useVoiceStore so only leaf components subscribed to it re-render.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildObjectUri,
  defaultAppChatFolderPath,
  QUICK_CHATS_FOLDER,
  useVoiceStore,
  type ChatSurface,
  i18n,
} from "@claraos/core";
import { VoiceRecorderSession } from "./useVoiceRecorder";
import { parseQuestionFields } from "./questionForm";
import { jobBlock } from "./jobBlock";
import {
  folders as foldersApi,
  chats as chatsApi,
  streamCompletion,
  cancelStream,
  speak as speakApi,
  uploadFile,
  bildVerkleinern,
  type WebUIChatDetail,
  type WebUIChatSummary,
  type WebUIFolder,
  type WebUIMessage,
  type ClaraActivity,
  type ClaraActiveTool,
  type ClaraSubAgentSummary,
  type ClaraToolCall,
  type ClaraosStreamEvent,
} from "./api";

export type VoiceState = "idle" | "arming" | "recording" | "transcribing" | "thinking" | "speaking";

/** Live transcript surfaced to the composer. New object identity per update
 *  (identity-trigger pattern, same as pendingText). final=true means the
 *  utterance is complete — the composer decides whether to auto-send. */
export interface LiveTranscript {
  value: string;
  final?: boolean;
}

/**
 * Reduce a claraos_event into the per-message ClaraActivity state.
 * Pure / immutable so React state updates work cleanly. The frontend reads
 * `activity.phase`, `activity.activeTool`, `activity.completedSubAgents`
 * etc. to render the live ActivityCard + collapsed SubAgentCards.
 */
function reduceActivity(prev: ClaraActivity | undefined, ev: ClaraosStreamEvent): ClaraActivity {
  const now = Date.now();
  const base: ClaraActivity = prev ?? {
    phase: "thinking",
    activeAgents: {},
    activeTools: {},
    completedSubAgents: [],
    toolCalls: [],
    startedAt: now,
  };
  switch (ev.type) {
    case "phase": {
      const phase = (ev.phase as ClaraActivity["phase"]) || base.phase;
      return { ...base, phase };
    }
    case "agent.start": {
      const subId = String(ev.sub_id ?? `sub-${Object.keys(base.activeAgents).length}`);
      return {
        ...base,
        activeAgents: {
          ...base.activeAgents,
          [subId]: {
            subId,
            agent: String(ev.agent ?? ev.intent ?? ""),
            model: typeof ev.model === "string" ? ev.model : undefined,
            intent: typeof ev.intent === "string" ? ev.intent : undefined,
            startedAt: now,
          },
        },
        phase: "executing",
      };
    }
    case "agent.switch": {
      // Treat as a re-anchor of the named agent.
      const subId = String(ev.sub_id ?? "");
      if (!subId) return base;
      return {
        ...base,
        activeAgents: {
          ...base.activeAgents,
          [subId]: {
            subId,
            agent: String(ev.to ?? ev.agent ?? ""),
            model: typeof ev.model === "string" ? ev.model : undefined,
            intent: typeof ev.intent === "string" ? ev.intent : undefined,
            startedAt: now,
          },
        },
      };
    }
    case "agent.end": {
      const subId = String(ev.sub_id ?? "");
      const summary: ClaraSubAgentSummary = {
        subId,
        intent: String(ev.intent ?? ""),
        agent: String(ev.agent ?? `sub-${ev.intent ?? ""}`),
        model: typeof ev.model === "string" ? ev.model : undefined,
        toolsCalled: Array.isArray(ev.tools_called)
          ? (ev.tools_called as string[])
          : [],
        summary: typeof ev.summary === "string" ? ev.summary : undefined,
        durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : undefined,
      };
      const remainingAgents = { ...base.activeAgents };
      delete remainingAgents[subId];
      return {
        ...base,
        activeAgents: remainingAgents,
        completedSubAgents: [...base.completedSubAgents, summary],
      };
    }
    case "tool.start": {
      const tid = String(ev.tool_id ?? `t-${Object.keys(base.activeTools).length}`);
      // Pick which sub-agent "owns" this tool: the most-recently-started one.
      const agentEntries = Object.values(base.activeAgents);
      const owningSubId = agentEntries.length
        ? agentEntries.reduce((a, b) => (a.startedAt > b.startedAt ? a : b)).subId
        : undefined;
      return {
        ...base,
        activeTools: {
          ...base.activeTools,
          [tid]: {
            id: tid,
            name: String(ev.tool ?? ""),
            argsSummary: String(ev.args_summary ?? ""),
            icon: typeof ev.icon === "string" ? ev.icon : undefined,
            server: typeof ev.server === "string" ? ev.server : undefined,
            startedAt: now,
            // Annotate the owning sub-agent so the SubAgentCard can group.
            ...(owningSubId ? { subId: owningSubId as string } : {}),
          } as ClaraActiveTool & { subId?: string },
        },
        phase: "executing",
      };
    }
    case "tool.end": {
      const tid = String(ev.tool_id ?? "");
      const started = tid ? base.activeTools[tid] : undefined;
      const owningSubId = (started as (ClaraActiveTool & { subId?: string }) | undefined)?.subId;
      const call: ClaraToolCall = {
        id: tid || undefined,
        name: String(ev.tool ?? started?.name ?? ""),
        argsSummary: started?.argsSummary ?? "",
        icon: started?.icon,
        server: started?.server,
        ok: ev.ok !== false,
        resultSummary: typeof ev.result_summary === "string" ? ev.result_summary : undefined,
        durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : undefined,
        subId: owningSubId,
        endedAt: now,
        navArgs: (ev as { nav_args?: ClaraToolCall["navArgs"] }).nav_args || undefined,
      };
      const remainingTools = { ...base.activeTools };
      if (tid) delete remainingTools[tid];
      return {
        ...base,
        toolCalls: [...base.toolCalls, call],
        activeTools: remainingTools,
      };
    }
    case "meta.start": {
      return {
        ...base,
        activeMeta: {
          domain: String(ev.domain ?? ""),
          taskSummary: typeof ev.task_summary === "string" ? ev.task_summary : undefined,
          startedAt: now,
        },
      };
    }
    case "meta.end": {
      return { ...base, activeMeta: undefined };
    }
    case "question.proposal": {
      const opts = Array.isArray(ev.options) ? ev.options : [];
      return {
        ...base,
        pendingQuestion: {
          questionId: String(ev.question_id ?? ""),
          question: String(ev.question ?? ""),
          options: opts.map((o) => {
            const oo = o as Record<string, unknown>;
            return {
              label: String(oo.label ?? ""),
              description: typeof oo.description === "string" ? oo.description : undefined,
            };
          }),
          fields: parseQuestionFields(ev.fields),
          waitSeconds: typeof ev.wait_seconds === "number" ? ev.wait_seconds : 60,
          proposedAt: now,
        },
      };
    }
    case "question.answered": {
      return { ...base, pendingQuestion: null };
    }
    case "plan.proposal": {
      // Plan card before execute. The frontend renders a card with
      // stop/edit/start-now buttons + an 8 s countdown.
      return {
        ...base,
        pendingPlan: {
          planId: String(ev.plan_id ?? ""),
          plan: String(ev.plan ?? ""),
          waitSeconds: typeof ev.wait_seconds === "number" ? ev.wait_seconds : 8,
          proposedAt: now,
        },
        phase: "planning",
      };
    }
    case "plan.cancelled": {
      // Plan rejected — clear pendingPlan so the card disappears.
      return { ...base, pendingPlan: null };
    }
    case "plan.approved": {
      // Plan approved — clear pendingPlan, phase to executing.
      return { ...base, pendingPlan: null, phase: "executing" };
    }
    case "todo.update": {
      // TodoWrite state updated. Full list, replaces the previous state
      // (the backend always sends the complete list).
      const todos = Array.isArray(ev.todos) ? ev.todos : [];
      return {
        ...base,
        todoList: todos.map((t) => {
          const obj = t as Record<string, unknown>;
          return {
            id: String(obj.id ?? ""),
            content: String(obj.content ?? ""),
            status: (obj.status as "pending" | "in_progress" | "completed") || "pending",
          };
        }),
      };
    }
    case "slow.notice": {
      const elapsed = typeof ev.elapsed_s === "number" ? ev.elapsed_s : 0;
      return {
        ...base,
        slowNotice: i18n.t("chatWork:notices.slow", { seconds: elapsed }),
      };
    }
    case "final": {
      return {
        ...base,
        phase: "done",
        finishedAt: now,
        agentUsed: typeof ev.agent_used === "string" ? ev.agent_used : undefined,
        taskType: typeof ev.task_type === "string" ? ev.task_type : undefined,
        toolsCount: typeof ev.tools_count === "number" ? ev.tools_count : undefined,
        durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : undefined,
        // Clear open cards — after `final` the agent no longer accepts
        // answers, so a clickable card would be a lie.
        pendingQuestion: null,
        pendingPlan: null,
      };
    }
    default:
      return base;
  }
}

export interface UseClaraChatOptions {
  surface: ChatSurface;
  appId?: string;
  objectKey?: string;          // raw object key (e.g. file path); URI gets built
  defaultFolderName?: string;  // override auto-folder root
  model?: string;              // optional model override
  /** when true the hook auto-resolves a folder for the surface/app/object on mount */
  autoFolder?: boolean;
  /** Per-app dynamic meta merged into each /completions call's `meta` field
   *  (e.g. wrapp_instance_id, selected_node_id for a wrapp app). */
  extraMeta?: Record<string, unknown>;
}

export interface UseClaraChatResult {
  // active state
  chatId: string | null;
  messages: WebUIMessage[];
  streaming: boolean;
  voiceState: VoiceState;
  voiceMode: boolean;
  /** Pseudo-live transcript while/after recording — the composer renders it. */
  interimTranscript: LiveTranscript | null;
  /** Mic/STT error to surface on the voice UI (orb/bubble), not just the error bar. */
  voiceError: string | null;
  error: string | null;
  /** Text queued while a previous answer is still streaming (sent automatically afterwards). */
  queued: string | null;
  // chats / folders
  chatList: WebUIChatSummary[];
  folderTree: WebUIFolder[];
  activeFolderId: string | null;
  // actions
  /** Resolves false when the message could NOT be submitted (e.g. chat
   *  creation failed) — callers should restore the text into the composer. */
  send: (text: string, opts?: { files?: File[]; extraMetaOverride?: Record<string, unknown> }) => Promise<boolean>;
  startNewChat: (opts?: { title?: string; folderId?: string }) => void;
  loadChat: (id: string, opts?: { fallbackMessages?: WebUIMessage[] }) => Promise<void>;
  removeChat: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  /** Barge-in: stop TTS playback immediately (state → idle). */
  stopSpeaking: () => void;
  toggleVoiceMode: () => void;
  abort: () => void;
  /** Live conversation: a spoken sentence (yours or Clara's) as chat text. */
  appendSpoken: (role: "user" | "assistant", text: string) => void;
  /** Live conversation: a card from Clara's run (e.g. a confirmation). */
  applySpokenEvent: (ev: Record<string, unknown>) => void;
}

const DEFAULT_MODEL = "clara/everyday";

export function useClaraChat(options: UseClaraChatOptions): UseClaraChatResult {
  const { surface, appId, objectKey, model = DEFAULT_MODEL, autoFolder = true, extraMeta } = options;
  // Keep latest extraMeta in a ref so send() always reads the current value
  // without re-binding.
  const extraMetaRef = useRef(extraMeta);
  extraMetaRef.current = extraMeta;
  const objectUri = useMemo(
    () => (appId && objectKey ? buildObjectUri(appId, objectKey) : undefined),
    [appId, objectKey],
  );

  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WebUIMessage[]>([]);
  // Ref mirror so the post-stream localStorage flush can read the
  // final messages list without depending on the closure capture.
  const messagesRef = useRef<WebUIMessage[]>([]);
  messagesRef.current = messages;
  const [streaming, setStreaming] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceMode, setVoiceMode] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState<LiveTranscript | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatList, setChatList] = useState<WebUIChatSummary[]>([]);
  const [folderTree, setFolderTree] = useState<WebUIFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Id of the server-side run; only the stop button uses it (leaving the chat
  // or closing the tab lets the run finish and store its answer).
  const streamIdRef = useRef<string | null>(null);
  const voiceSessionRef = useRef<VoiceRecorderSession | null>(null);
  // one automatic re-arm after a silent utterance in voice mode; a second
  // consecutive silence closes the mic (user taps the orb to resume)
  const silentRearmedRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const voiceModeRef = useRef(false);
  // streaming as a ref so send() can be re-entered from the queue flush
  // without waiting for a re-render; sendRef breaks the closure cycle.
  const streamingRef = useRef(false);
  const sendRef = useRef<UseClaraChatResult["send"] | null>(null);
  const queuedRef = useRef<{ text: string; opts?: { files?: File[]; extraMetaOverride?: Record<string, unknown> } } | null>(null);
  const [queued, setQueued] = useState<string | null>(null);

  // ── auto-folder resolution ──
  const ensureFolder = useCallback(async (): Promise<string | null> => {
    if (!autoFolder) return null;
    const path =
      surface === "quick"
        ? [QUICK_CHATS_FOLDER]
        : appId
          ? defaultAppChatFolderPath(appId, objectKey)
          : null;
    if (!path) return null;
    const tree = await foldersApi.list();
    let parent: string | null = null;
    for (const segment of path) {
      // Prefer exact (name + parent) match — that's the canonical home.
      let existing = tree.find(
        (f) => f.name === segment && (f.parent_id ?? null) === parent,
      );
      // Fallback: WebUI 0.8.3 enforces folder-name uniqueness *globally* per
      // user. If a folder with this name lives at a different parent (e.g. an
  // orphan from before the "App Chats" grouping was introduced), reuse
      // it — creating a duplicate name at any level would fail with 400.
      if (!existing) {
        existing = tree.find((f) => f.name === segment);
      }
      if (existing) {
        parent = existing.id;
        continue;
      }
      const created = await foldersApi.create(segment, parent ?? undefined);
      tree.push(created);
      parent = created.id;
    }
    setFolderTree(tree);
    return parent;
  }, [autoFolder, surface, appId, objectKey]);

  // ── refresh: reload folder + chat list ──
  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [tree, list] = await Promise.all([
        foldersApi.list(),
        // include_folders: WebUI's page listing hides folder chats — merge
        // them in so history/"Weiter machen" see EVERY conversation.
        chatsApi.list({ app_id: appId, object_uri: objectUri, include_folders: true, limit: 50 }),
      ]);
      setFolderTree(tree);
      setChatList(list);
    } catch (err) {
      setError(String(err));
    }
  }, [appId, objectUri]);

  // ── load on mount ──
  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  // ── start new (in-memory) chat ──
  const startNewChat = useCallback(
    (opts?: { title?: string; folderId?: string }) => {
      // A still-running stream belongs to the old chat — abort it, otherwise
      // its deltas keep writing into the fresh chat.
      abortRef.current?.abort();
      abortRef.current = null;
      setStreaming(false);
      streamingRef.current = false;
      setChatId(null);
      setMessages([]);
      setActiveFolderId(opts?.folderId ?? null);
    },
    [],
  );

  // ── load existing chat ──
  const loadChat = useCallback(async (id: string, opts?: { fallbackMessages?: WebUIMessage[] }) => {
    try {
      setError(null);
      const detail: WebUIChatDetail = await chatsApi.get(id);
      setChatId(detail.id);
      let msgs =
        detail.chat?.messages ??
        Object.values(detail.chat?.history?.messages ?? {}) ??
        [];
      // Race guard: right after a stream ends WebUI may not have persisted
      // the assistant message yet. When the caller hands us its local copy
      // of the SAME conversation and it is more complete, prefer it.
      const fallback = opts?.fallbackMessages;
      if (fallback && fallback.length > msgs.length) {
        msgs = fallback;
      }
      // Rehydrate ClaraActivity from localStorage so collapsed
      // SubAgentCards survive a chat reload. Keyed by chat_id + index since
      // WebUI doesn't preserve our custom message-meta server-side (V1).
      const rehydrated = msgs.map((m, idx) => {
        if (m.role !== "assistant") return m;
        try {
          const raw = localStorage.getItem(`claraActivity:${id}:${idx}`);
          if (!raw) return m;
          const stored = JSON.parse(raw) as Partial<ClaraActivity>;
          // Ensure Map fields exist even for older snapshots
          // that saved with single `activeAgent`/`activeTool` slots.
          const activity: ClaraActivity = {
            phase: stored.phase ?? "done",
            activeAgents: stored.activeAgents ?? {},
            activeTools: stored.activeTools ?? {},
            completedSubAgents: stored.completedSubAgents ?? [],
            toolCalls: stored.toolCalls ?? [],
            startedAt: stored.startedAt ?? 0,
            finishedAt: stored.finishedAt,
            agentUsed: stored.agentUsed,
            taskType: stored.taskType,
            toolsCount: stored.toolsCount,
            durationMs: stored.durationMs,
            slowNotice: stored.slowNotice,
            activeMeta: stored.activeMeta,
          };
          return { ...m, activity };
        } catch {
          return m;
        }
      });
      setMessages(rehydrated);
      setActiveFolderId(detail.folder_id ?? null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const removeChat = useCallback(
    async (id: string) => {
      try {
        await chatsApi.remove(id);
        if (chatId === id) {
          setChatId(null);
          setMessages([]);
        }
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [chatId, refresh],
  );

  // ── send message + stream answer ──
  const send = useCallback(
    async (text: string, _opts?: { files?: File[]; extraMetaOverride?: Record<string, unknown> }): Promise<boolean> => {
      let t = text.trim();
      const anhaenge = _opts?.files ?? [];
      // Only an attachment, no text — send anyway. Previously files were
      // collected and then silently discarded here.
      if (!t && anhaenge.length) {
        t = anhaenge.every((f) => f.type.startsWith("image/")) ? "Was ist auf dem Bild?" : "Sieh dir den Anhang an.";
      }
      if (!t) return true;
      // While an answer is still streaming, queue instead of silently
      // dropping — the queued message is sent right after the stream ends.
      if (streamingRef.current) {
        queuedRef.current = { text: t, opts: _opts };
        setQueued(t);
        return true;
      }

      // Prepare attachments: images downscaled as base64 in meta.bilder
      // (vision pre-pass in chat_v2, since Open WebUI drops image_url), other
      // files into the WebUI file store (RAG). The history shows one entry
      // with a preview image per attachment.
      const bilder: { name: string; b64: string; mime: string }[] = [];
      const dateien: { type: string; id?: string; name?: string }[] = [];
      const anzeige: NonNullable<WebUIMessage["files"]> = [];
      for (const f of anhaenge) {
        try {
          if (f.type.startsWith("image/")) {
            const b = await bildVerkleinern(f);
            bilder.push({ name: b.name, b64: b.b64, mime: b.mime });
            anzeige.push({ type: "image", name: b.name, url: b.thumb });
          } else {
            const up = await uploadFile(f);
            dateien.push({ type: "file", id: up.id, name: up.filename ?? f.name });
            anzeige.push({ type: "file", name: f.name });
          }
        } catch (err) {
          setError(i18n.t("chatWork:errors.attachmentFailed", { name: f.name, error: String(err) }));
        }
      }
      const userMsg: WebUIMessage = {
        role: "user",
        content: t,
        timestamp: Date.now(),
        ...(anzeige.length ? { files: anzeige } : {}),
      };
      const placeholder: WebUIMessage = {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg, placeholder]);

      setStreaming(true);
      streamingRef.current = true;
      setError(null);

      let activeChatId = chatId;
      try {
        if (!activeChatId) {
          const folder = activeFolderId ?? (await ensureFolder());
          const created = await chatsApi.create({
            title: t.slice(0, 60),
            folder_id: folder ?? undefined,
            app_id: appId,
            object_uri: objectUri,
            surface,
            models: model ? [model] : [],
            messages: [userMsg],
          });
          activeChatId = created.id;
          setChatId(created.id);
        }
      } catch (err) {
        setError(String(err));
        // Submission failed: roll back BOTH optimistic messages so the
        // conversation doesn't show a user message that never went out.
        // The caller restores the text into the composer (send → false).
        setMessages((prev) => prev.slice(0, -2));
        setStreaming(false);
        streamingRef.current = false;
        return false;
      }

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await streamCompletion(
          {
            model,
            messages: messages.concat(userMsg).map((m) => ({
              role: m.role,
              content: m.content,
            })),
            chat_id: activeChatId ?? undefined,
            ...(dateien.length ? { files: dateien } : {}),
            meta: {
              app_id: appId,
              object_uri: objectUri,
              surface,
              // The brain's prompts are partly German; the UI language tells it
              // which language the user reads.
              ui_language: i18n.resolvedLanguage ?? i18n.language,
              ...(_opts?.extraMetaOverride ?? extraMetaRef.current ?? {}),
              ...(bilder.length ? { bilder } : {}),
              ...(dateien.length ? { dateien: dateien.map((d) => ({ name: d.name })) } : {}),
            },
          },
          (chunk) => {
            if (chunk.streamId) {
              streamIdRef.current = chunk.streamId;
              return;
            }
            if (chunk.error) {
              setError(chunk.error);
              // The error bar gets cleared by the history refresh after the
              // stream — the user saw an empty reply and nothing else. So the
              // error belongs IN the reply, where it stays. An error that
              // looks like silence is the worst kind of error.
              const fehlertext = chunk.error;
              const mitFehler = (prev: WebUIMessage[]) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant" && !last.content.trim()) {
                  next[next.length - 1] = { ...last, content: `⚠️ ${fehlertext}` };
                }
                return next;
              };
              // Also set the ref immediately: the PATCH in finally reads
              // messagesRef.current BEFORE React has flushed the state —
              // otherwise the empty reply lands on the server, and the next
              // reload deletes the error text again (probe: visible until
              // t+20 s, then gone).
              messagesRef.current = mitFehler(messagesRef.current ?? []);
              setMessages(mitFehler);
              return;
            }
            if (chunk.event) {
              const ev = chunk.event;
              if (ev.type === "job.started" || ev.type === "job.done" || ev.type === "job.failed") {
                // A long-running job becomes a status card (one id per job, so
                // done/failed update the same card). Same mapping as the API's
                // stored copy (services/jobs.py job_block).
                const blk = jobBlock(ev);
                if (blk) {
                  const mitJob = (prev: WebUIMessage[]) => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    if (!last || last.role !== "assistant") return prev;
                    const blocks = [...(last.blocks ?? [])];
                    const idx = blocks.findIndex((b) => b.id === blk.id);
                    const neu = { ...blk, props: { ...(idx >= 0 ? blocks[idx].props : {}), ...blk.props } };
                    if (idx >= 0) blocks[idx] = neu; else blocks.push(neu);
                    next[next.length - 1] = { ...last, blocks };
                    return next;
                  };
                  messagesRef.current = mitJob(messagesRef.current ?? []);
                  setMessages(mitJob);
                }
                return;
              }
              if (ev.type === "ui.block" || ev.type === "ui.block.update") {
                // Attach a card to the running reply, or update an existing
                // one (same id). Write the ref immediately so the PATCH after
                // the stream saves it.
                const blk = ev.block as { id?: string; kind?: string; props?: Record<string, unknown> } | undefined;
                if (blk && typeof blk.id === "string" && typeof blk.kind === "string") {
                  const mitBlock = (prev: WebUIMessage[]) => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    if (!last || last.role !== "assistant") return prev;
                    const blocks = [...(last.blocks ?? [])];
                    const idx = blocks.findIndex((b) => b.id === blk.id);
                    const neu = { id: blk.id!, kind: blk.kind!, props: { ...(idx >= 0 ? blocks[idx].props : {}), ...(blk.props ?? {}) } };
                    if (idx >= 0) blocks[idx] = neu; else blocks.push(neu);
                    next[next.length - 1] = { ...last, blocks };
                    return next;
                  };
                  messagesRef.current = mitBlock(messagesRef.current ?? []);
                  setMessages(mitBlock);
                }
                return;
              }
              if (ev.type === "suggest" || (ev.type === "final" && Array.isArray(ev.sources))) {
                // Attach follow-up questions and sources to the reply
                // (ref immediately, so the PATCH saves them).
                const folge = ev.type === "suggest" && Array.isArray(ev.followups)
                  ? (ev.followups as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 3)
                  : null;
                const quellen = ev.type === "final" && Array.isArray(ev.sources)
                  ? (ev.sources as unknown[]).filter((x): x is { title: string; url: string } =>
                      !!x && typeof x === "object" && typeof (x as { url?: unknown }).url === "string").slice(0, 8)
                  : null;
                const anhaengen = (prev: WebUIMessage[]) => {
                  const next = [...prev];
                  const last = next[next.length - 1];
                  if (!last || last.role !== "assistant") return prev;
                  next[next.length - 1] = {
                    ...last,
                    ...(folge && folge.length ? { suggestions: folge } : {}),
                    ...(quellen && quellen.length ? { sources: quellen } : {}),
                  };
                  return next;
                };
                messagesRef.current = anhaengen(messagesRef.current ?? []);
                setMessages(anhaengen);
                if (ev.type === "suggest") return;
              }
              if (ev.type === "draft.reset") {
                // The agent started a new LLM call (tools in between) or the
                // final text differs from the draft — the draft is discarded,
                // the history stays.
                const ohneEntwurf = (prev: WebUIMessage[]) => {
                  const next = [...prev];
                  const last = next[next.length - 1];
                  if (last && last.role === "assistant") next[next.length - 1] = { ...last, content: "" };
                  return next;
                };
                messagesRef.current = ohneEntwurf(messagesRef.current ?? []);
                setMessages(ohneEntwurf);
                return;
              }
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  next[next.length - 1] = {
                    ...last,
                    activity: reduceActivity(last.activity, ev),
                  };
                }
                return next;
              });
              return;
            }
            if (chunk.delta) {
              // Warning: the ref MUST be updated here. `saveMessages` in
              // finally reads `messagesRef.current` — and otherwise the ref
              // is only set on render. Anything that streamed in after the
              // last React commit was therefore never saved. In one observed
              // case Clara wrote 321 characters and only 127 were saved — cut
              // off right before "… but the viewer did not load it". The
              // honest part of her reply was missing from the history, and
              // the user read a success message she never actually gave.
              // Errors, cards, follow-ups and sources already do this
              // correctly — only the text path, the most common of all, was
              // missing from the list.
              const mitText = (prev: WebUIMessage[]) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  next[next.length - 1] = {
                    ...last,
                    content: last.content + chunk.delta,
                  };
                }
                return next;
              };
              messagesRef.current = mitText(messagesRef.current ?? []);
              setMessages(mitText);
            }
          },
          ctrl.signal,
        );
      } catch (err) {
        if ((err as Error).name !== "AbortError") setError(String(err));
      } finally {
        abortRef.current = null;
        streamIdRef.current = null;
        setStreaming(false);
        streamingRef.current = false;
        // Flush a message that was queued while this answer streamed.
        const q = queuedRef.current;
        if (q) {
          queuedRef.current = null;
          setQueued(null);
          setTimeout(() => sendRef.current?.(q.text, q.opts), 0);
        }
        // Persist final activity to localStorage so it rehydrates
        // on next chat reload. Keyed by chat_id + assistant-message index.
        try {
          if (activeChatId) {
            const finalMessages = messagesRef.current ?? [];
            finalMessages.forEach((m, idx) => {
              if (m.role === "assistant" && m.activity?.phase === "done") {
                localStorage.setItem(
                  `claraActivity:${activeChatId}:${idx}`,
                  JSON.stringify(m.activity),
                );
              }
            });
          }
        } catch {
          /* localStorage unavailable / quota — non-fatal */
        }
        // Save the thread server-side — quick chats only persisted the
        // first user message (POST on creation); replies + follow-up
        // questions lived only in frontend state and were gone after a
        // remount/device switch. Fire-and-forget, errors non-fatal.
        if (activeChatId) {
          chatsApi
            .saveMessages(activeChatId, messagesRef.current ?? [])
            .catch(() => undefined);
        }
      }
      return true;
    },
    [chatId, activeFolderId, ensureFolder, appId, objectUri, surface, model, messages],
  );
  sendRef.current = send;

  // ── voice ──
  // Recording is a VoiceRecorderSession (useVoiceRecorder.ts): level meter +
  // client-side VAD auto-stop + pseudo-live interim transcripts. The hook no
  // longer send()s the transcript itself — it surfaces interimTranscript and
  // the Composer writes it into the text field (and auto-sends in voice mode).
  const startRecording = useCallback(async () => {
    // Ref-based guards (not voiceState) so a barge-in can call
    // stopSpeaking() + startRecording() back-to-back without waiting a render.
    if (voiceSessionRef.current) return; // already arming/recording/transcribing
    if (audioRef.current) return; // TTS playing — stopSpeaking() first (barge-in)
    setVoiceError(null);
    const session = new VoiceRecorderSession(
      {
        onState: (s) => {
          if (voiceSessionRef.current !== session) return;
          if (s === "arming") setVoiceState("arming");
          else if (s === "recording") setVoiceState("recording");
          else setVoiceState("transcribing");
        },
        onLevel: (l) => {
          useVoiceStore.getState().setMicLevel(l);
        },
        onInterim: (text) => {
          if (voiceSessionRef.current !== session) return;
          setInterimTranscript({ value: text });
          useVoiceStore.getState().setTranscript(text);
        },
        onFinal: (text, { hadSpeech }) => {
          if (voiceSessionRef.current !== session) return;
          voiceSessionRef.current = null;
          useVoiceStore.getState().setMicLevel(0);
          if (hadSpeech && text) {
            silentRearmedRef.current = false;
            setInterimTranscript({ value: text, final: true });
            useVoiceStore.getState().setTranscript(text);
            setVoiceState("idle");
            return;
          }
          // silence / empty result — nothing to send
          setInterimTranscript(null);
          setVoiceState("idle");
          if (voiceModeRef.current && !silentRearmedRef.current) {
            silentRearmedRef.current = true;
            setTimeout(() => {
              if (voiceModeRef.current) startRecordingRef.current?.().catch(() => undefined);
            }, 250);
          }
        },
        onError: (msg) => {
          if (voiceSessionRef.current === session) voiceSessionRef.current = null;
          useVoiceStore.getState().setMicLevel(0);
          setVoiceError(msg);
          setVoiceState("idle");
        },
      },
      { language: "de" },
    );
    voiceSessionRef.current = session;
    await session.start();
  }, []);
  // self-reference for the delayed re-arm without a closure cycle
  const startRecordingRef = useRef<typeof startRecording | null>(null);
  startRecordingRef.current = startRecording;

  const stopRecording = useCallback(async () => {
    voiceSessionRef.current?.stop();
  }, []);

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setVoiceState("idle");
  }, []);

  const abort = useCallback(() => {
    if (streamIdRef.current) cancelStream(streamIdRef.current);
    streamIdRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    streamingRef.current = false;
  }, []);

  // Unmount (panel/VoiceBubble closed): tear down the stream too — the reply
  // is assembled client-side and would be lost anyway; without abort() the
  // agent would keep running server-side and callbacks would fire against dead state.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // ── Voice-Mode loop: after streaming ends, speak last assistant message,
  //                     then auto-restart mic for next utterance ──
  const lastSpokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!voiceMode) return;
    if (streaming) return;
    // user already talks again (barge-in / early re-arm) — don't speak over them
    if (voiceSessionRef.current) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || !last.content) return;
    const speakText = last.content;
    // dedupe — don't re-speak when chatList refreshes for the same message
    const key = `${chatId ?? ""}:${messages.length}:${speakText.slice(0, 40)}`;
    if (lastSpokenRef.current === key) return;
    lastSpokenRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        setVoiceState("speaking");
        const blob = await speakApi(speakText, { format: "wav" });
        if (cancelled || !voiceModeRef.current) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (audioRef.current === audio) audioRef.current = null; // unblock startRecording guard
          if (!voiceModeRef.current) {
            setVoiceState("idle");
            return;
          }
          setVoiceState("idle");
          // chain: open mic again
          startRecording().catch(() => undefined);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          if (audioRef.current === audio) audioRef.current = null;
          setVoiceState("idle");
        };
        await audio.play();
      } catch (err) {
        setError(String(err));
        setVoiceState("idle");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode, streaming, messages, chatId]);

  // keep ref synced so onended-callbacks see latest value
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  const toggleVoiceMode = useCallback(() => {
    setVoiceMode((prev) => {
      const next = !prev;
      voiceModeRef.current = next;
      return next;
    });
  }, []);

  // Voice-mode lifecycle lives in an effect (NOT inside the setState updater —
  // StrictMode double-mount would otherwise dispose the session on the
  // simulated unmount and never restart it, leaving a dead mic).
  useEffect(() => {
    if (voiceMode) {
      silentRearmedRef.current = false;
      if (!voiceSessionRef.current && !audioRef.current) {
        startRecording().catch(() => undefined);
      }
    } else {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      voiceSessionRef.current?.dispose();
      voiceSessionRef.current = null;
      useVoiceStore.getState().setMicLevel(0);
      setVoiceState("idle");
    }
  }, [voiceMode, startRecording]);

  // ── live conversation → chat ──
  // The voice server streams final transcripts of both sides; they become
  // ordinary messages of the open chat (created on the first sentence) and are
  // saved like a typed exchange. Consecutive sentences of one speaker merge
  // into one message — GPT-Live speaks in short segments ("one moment" → answer).
  const spokenChatRef = useRef<Promise<string | null> | null>(null);
  const spokenSaveRef = useRef<number | null>(null);
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;

  const spokenSpeichern = useCallback(() => {
    if (spokenSaveRef.current) window.clearTimeout(spokenSaveRef.current);
    spokenSaveRef.current = window.setTimeout(async () => {
      spokenSaveRef.current = null;
      let id = chatIdRef.current;
      if (!id) {
        if (!spokenChatRef.current) {
          const erste = (messagesRef.current ?? []).find((m) => m.role === "user")?.content ?? i18n.t("chatWork:voice.liveChatTitle");
          spokenChatRef.current = (async () => {
            try {
              const folder = activeFolderId ?? (await ensureFolder());
              const created = await chatsApi.create({
                title: erste.slice(0, 60),
                folder_id: folder ?? undefined,
                app_id: appId,
                object_uri: objectUri,
                surface,
                models: model ? [model] : [],
                messages: messagesRef.current ?? [],
              });
              setChatId(created.id);
              chatIdRef.current = created.id;
              return created.id;
            } catch {
              return null; // stays visible locally; the next sentence retries
            } finally {
              spokenChatRef.current = null;
            }
          })();
        }
        id = await spokenChatRef.current;
      }
      if (id) chatsApi.saveMessages(id, messagesRef.current ?? []).catch(() => undefined);
    }, 1500);
  }, [activeFolderId, ensureFolder, appId, objectUri, surface, model]);

  const appendSpoken = useCallback((role: "user" | "assistant", text: string) => {
    const t = text.trim();
    if (!t) return;
    const mit = (prev: WebUIMessage[]) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role && last.via === "stimme") {
        return [...prev.slice(0, -1), { ...last, content: `${last.content} ${t}`.trim() }];
      }
      return [...prev, { role, content: t, timestamp: Date.now(), via: "stimme" as const }];
    };
    messagesRef.current = mit(messagesRef.current ?? []);
    setMessages(mit);
    spokenSpeichern();
  }, [spokenSpeichern]);

  const applySpokenEvent = useCallback((ev: Record<string, unknown>) => {
    const typ = (ev.type ?? ev.kind) as string | undefined;
    if (typ !== "ui.block" && typ !== "ui.block.update") return;
    const blk = ev.block as { id?: string; kind?: string; props?: Record<string, unknown> } | undefined;
    if (!blk || typeof blk.id !== "string" || typeof blk.kind !== "string") return;
    const mit = (prev: WebUIMessage[]) => {
      // a card from a later update may belong to an older message
      for (let i = prev.length - 1; i >= 0; i--) {
        const blocks = prev[i].blocks ?? [];
        const idx = blocks.findIndex((b) => b.id === blk.id);
        if (idx >= 0) {
          const neu = [...blocks];
          neu[idx] = { id: blk.id!, kind: blk.kind!, props: { ...blocks[idx].props, ...(blk.props ?? {}) } };
          const next = [...prev];
          next[i] = { ...prev[i], blocks: neu };
          return next;
        }
      }
      const block = { id: blk.id!, kind: blk.kind!, props: blk.props ?? {} };
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") {
        return [...prev.slice(0, -1), { ...last, blocks: [...(last.blocks ?? []), block] }];
      }
      return [...prev, { role: "assistant" as const, content: "", timestamp: Date.now(), via: "stimme" as const, blocks: [block] }];
    };
    messagesRef.current = mit(messagesRef.current ?? []);
    setMessages(mit);
    spokenSpeichern();
  }, [spokenSpeichern]);

  // Voice mode: while Clara streams the reply, the orb should read "thinking"
  // (the TTS effect below switches to "speaking" once playback starts).
  useEffect(() => {
    if (streaming && voiceModeRef.current) setVoiceState("thinking");
  }, [streaming]);

  // Hard teardown on unmount — stop mic tracks, close AudioContext, stop TTS.
  useEffect(
    () => () => {
      voiceSessionRef.current?.dispose();
      voiceSessionRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      useVoiceStore.getState().setMicLevel(0);
    },
    [],
  );

  return {
    chatId,
    messages,
    streaming,
    voiceState,
    voiceMode,
    interimTranscript,
    voiceError,
    error,
    queued,
    chatList,
    folderTree,
    activeFolderId,
    send,
    startNewChat,
    loadChat,
    removeChat,
    refresh,
    startRecording,
    stopRecording,
    stopSpeaking,
    toggleVoiceMode,
    abort,
    appendSpoken,
    applySpokenEvent,
  };
}
