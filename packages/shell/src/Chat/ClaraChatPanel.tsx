/**
 * ClaraChatPanel — single chat component used in 4 surfaces.
 *
 *   variant="full"     → fullscreen window app (~ Win11 Notes-fullscreen feel)
 *   variant="sidebar"  → docked into the start menu (with folder tree)
 *   variant="inline"   → in-app right-panel (~340px) bound to currentObject
 *   variant="quick"    → desktop widget mini-chat (no folder tree)
 *
 * All variants share the same useClaraChat hook and Composer; layout
 * differences are CSS-only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatSurface, MarkerPayload } from "@claraos/core";
import { useAuthStore, useDragStore, useClaraChatSettings, useWindowsStore, useWrappStore, useIframeAppStore, useFileStore, useMarkerStore, useVoiceStore, useAppRegistryStore, objectShortName } from "@claraos/core";
import { berichtVomSchirm } from "./shellActionHandler";
import { useClaraChat } from "./useClaraChat";
import { useLiveVoice } from "./useLiveVoice";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";

/**
 * Reactive per-app extra meta — rebuilt on every store change so Clara's
 * next /completions call sees the current selection.
 *
 * Sources:
 *  - wrapp apps (registered manifests): useWrappStore for instance + selected node
 *  - iframe-apps that registered an iframe bridge: useIframeAppStore
 */
function useChatAppContext({ appId, windowId }: { appId?: string; windowId?: string }): Record<string, unknown> {
  const wrappInstances = useWrappStore((s) => s.instances);
  const wrappManifests = useWrappStore((s) => s.manifests);
  const wrappManifestIds = wrappManifests.map((m) => m.id);
  const iframeApps = useIframeAppStore((s) => s.apps);
  const winFocusedId = useWindowsStore((s) => s.focusedWindowId);
  const windows = useWindowsStore((s) => s.windows);
  const fileActiveSource = useFileStore((s) => s.activeSource);
  const fileCurrentPath = useFileStore((s) => s.currentPath);
  const fileSelected = useFileStore((s) => s.selectedFiles);
  const targetWindowId = windowId ?? winFocusedId ?? "";

  // Wrapp apps: native React; read from the wrapp store
  if (appId && wrappManifestIds.includes(appId)) {
    const instance = Object.values(wrappInstances).find((i) => i.windowId === targetWindowId);
    if (!instance) return { app_id: appId };
    const meta: Record<string, unknown> = {
      app_id: appId,
      wrapp_instance_id: instance.id,
      wrapp_manifest: instance.manifestId,
      active_tab: instance.activeTab,
    };
    const selectedId = instance.selectedNodeId;
    if (selectedId) {
      const found = findNode(instance.objectTree, selectedId);
      if (found) {
        meta.selected_node_id = found.id;
        meta.selected_node_name = found.name;
        meta.selected_node_type = found.type;
      }
    }
    return meta;
  }

  // Native ClaraOS apps — pull current state from their stores
  // so chat_v2.py can build a useful [ClaraOS context] system message.
  if (appId === "files") {
    const sel = fileSelected[fileSelected.length - 1] || "";
    return {
      app_id: "files",
      source: fileActiveSource,
      current_path: fileCurrentPath,
      selected_file: sel ? sel.split("/").pop() : "",
    };
  }
  if (appId === "image-viewer" || appId === "pdf-viewer" || appId === "video-player" || appId === "office-viewer" || appId === "model-viewer") {
    const win = targetWindowId ? windows[targetWindowId] : undefined;
    return {
      app_id: appId,
      path: win?.path ?? "",
      source: win?.source ?? "",
    };
  }
  if (appId === "text-editor") {
    const win = targetWindowId ? windows[targetWindowId] : undefined;
    return {
      app_id: "text-editor",
      path: win?.path ?? "",
      source: win?.source ?? "",
    };
  }

  // Iframe-app with an iframe bridge — pull whatever the iframe pushed.
  if (targetWindowId && iframeApps[targetWindowId]) {
    const entry = iframeApps[targetWindowId];
    return {
      app_id: entry.appId,
      bridge_ready: entry.ready,
      capabilities: entry.capabilities,
      ...entry.context,
    };
  }
  return {};
}

function findNode(node: { id: string; name?: string; type?: string; children?: unknown[] }, id: string): { id: string; name?: string; type?: string } | null {
  if (node.id === id) return { id: node.id, name: node.name, type: node.type };
  for (const child of node.children ?? []) {
    const f = findNode(child as { id: string; children?: unknown[] }, id);
    if (f) return f;
  }
  return null;
}

/** Human label for the pinned-marker chip, e.g. "📍 Region in <tab>" or "📍 <object id>". */
function markerLabel(p: MarkerPayload): string {
  switch (p.kind) {
    case "bbox-img":
      return `Region in ${p.appId.split(":").pop()}`;   // "<wrapp>:<tab>" -> tab
    case "svg-element":
      return p.elementId || "SVG-Element";
    case "geojson":
      return "Polygon (Karte)";
    case "cad-object": {
      const ifc = (p.bimProps && typeof p.bimProps === "object" && "ifcClass" in p.bimProps)
        ? String((p.bimProps as Record<string, unknown>).ifcClass)
        : undefined;
      return ifc ? `${p.objectId} (${ifc})` : p.objectId;
    }
  }
}

import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { FolderTree } from "./FolderTree";
import { FilePickerModal } from "./FilePickerModal";
import ClaraMark from "../Mobile/clara-c.svg?react";
import { folders as foldersApi, chats as chatsApi } from "./api";
import { UiHookButtons } from "./UiHookButtons";
import type { ClaraUiHook } from "./toolsApi";
import { useDialogs } from "./Dialogs";
import styles from "./ClaraChatPanel.module.css";

/** Verb chips shown in the empty state (tasks, not questions). */
const WELCOME_CHIPS = [
  { icon: "📄", label: "Dokument zusammenfassen", prompt: "Fasse mir dieses Dokument zusammen: " },
  { icon: "🖼️", label: "Fotos finden", prompt: "Suche in Immich nach Fotos von " },
  { icon: "📅", label: "Tag planen", prompt: "Hilf mir, meinen Tag zu planen. Heute steht an: " },
];

const READ_API = "/api/claraos/files/v2";

async function readClaraosFile(source: string, path: string): Promise<File | null> {
  try {
    const url = `${READ_API}/read?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`;
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return null;
    const data = await resp.json();
    const name = path.split("/").pop() || "file";
    let bytes: Uint8Array;
    if (data.encoding === "base64") {
      const bin = atob(data.content);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(data.content ?? "");
    }
    return new File([bytes as BlobPart], name);
  } catch {
    return null;
  }
}

export interface ClaraChatPanelProps {
  variant: ChatSurface;
  /** App context for inline-chat binding. */
  appId?: string;
  objectKey?: string;
  /** Optional model override. */
  model?: string;
  /** Quick variant: handler invoked when user clicks the expand button. */
  onExpand?: () => void;
  /** Inline variant: handler invoked when user closes the panel. */
  onClose?: () => void;
  /** Optional starting chat ID (if you want to resume a specific conversation). */
  initialChatId?: string;
  /** Optional draft text seeded into the composer on mount / identity change
   *  (carry-over from the start-menu launcher input). */
  initialText?: { value: string } | null;
  /** Local copy of the conversation for initialChatId — bridges the gap
   *  until WebUI has persisted the just-streamed assistant message. */
  initialMessages?: import("./api").WebUIMessage[];
  /** Hide the panel's own header row (host renders a fused header instead). */
  hideHeader?: boolean;
  /** Optional CSS class for the outer wrapper. */
  className?: string;
  /** When true, auto-start mic recording right after mount (voice-mode entry). */
  autoRecord?: boolean;
  /** Window id this panel is rendered inside (used by inline variant for app-context). */
  windowId?: string;
  /** Hide the composer's Mic + Voice buttons (external control drives voice). */
  hideVoiceButtons?: boolean;
  /** Hide the "Modul-Aktionen" ui-hook chips (mobile: too little space). */
  hideModuleActions?: boolean;
  /** Phone sheet (ClaraOverlay). Enables the mobile empty state with app
   *  suggestions and the context chips above the composer. */
  mobil?: boolean;
  /** Reports chatId + local thread on every change — hosts that unmount/remount
   *  the panel (mobile overlay close→FAB→reopen) restore continuity by feeding
   *  these back as initialChatId/initialMessages (losing the history on
   *  remount produced requests without a user message → "Ich konnte keine Antwort…"). */
  onThreadChange?: (chatId: string | null, messages: import("./api").WebUIMessage[]) => void;
  /** Surface voice controls to a parent (e.g. mobile overlay orb). Called with
   *  the control fns on mount and null on unmount. */
  onVoiceBind?: (
    api: {
      startRecording: () => void;
      stopRecording: () => void;
      stopSpeaking: () => void;
      toggleVoiceMode: () => void;
      /** true: the fns drive the live conversation (tap = start/end). */
      live?: boolean;
    } | null,
  ) => void;
  /** Reports the live activity of the newest assistant message whenever it
   *  changes (mobile overlay: cobrowse auto-trigger + status strip). */
  onActivityChange?: (activity: import("./api").ClaraActivity | null, streaming: boolean) => void;
  /** Chat state and actions for the header of the phone sheet (title, new,
   *  history). Reported again on every change. */
  onChatBind?: (api: ChatBind | null) => void;
  /** Request the fullscreen voice view (orb) from the live pill. */
  onVoiceVollbild?: () => void;
}

export interface ChatBind {
  chatId: string | null;
  title: string;
  chats: import("./api").WebUIChatSummary[];
  streaming: boolean;
  startNewChat: () => void;
  loadChat: (id: string) => Promise<void>;
  removeChat: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function ClaraChatPanel(props: ClaraChatPanelProps) {
  const {
    variant,
    appId,
    objectKey,
    model,
    onExpand,
    onClose,
    initialChatId,
    initialText,
    initialMessages,
    hideHeader,
    className,
    autoRecord,
    windowId,
    hideVoiceButtons,
    hideModuleActions,
    mobil,
    onThreadChange,
    onVoiceBind,
    onActivityChange,
    onChatBind,
    onVoiceVollbild,
  } = props;

  const settingsModel = useClaraChatSettings((s: { model: string }) => s.model);
  const effectiveModel = model ?? settingsModel;

  // Build per-app extra meta (wrapp instance + selected node for wrapp apps).
  // Re-evaluated reactively so Clara's next /completions sees the latest
  // selection without us having to re-create the chat.
  const baseMeta = useChatAppContext({ appId, windowId });

  // Marker / region selection from the global store. The pinned payload
  // rides along with the next user message via extraMeta.marker, then is
  // cleared when send() resolves successfully.
  const markerMode = useMarkerStore((s) => s.mode);
  const pinnedMarker = useMarkerStore((s) => s.pinned);
  const startPicking = useMarkerStore((s) => s.startPicking);
  const cancelPicking = useMarkerStore((s) => s.cancelPicking);
  const clearMarker = useMarkerStore((s) => s.clear);

  const extraMeta = useMemo(
    () => (pinnedMarker ? { ...baseMeta, marker: pinnedMarker } : baseMeta),
    [baseMeta, pinnedMarker],
  );

  const chat = useClaraChat({
    surface: variant,
    appId,
    objectKey,
    model: effectiveModel,
    extraMeta,
  });
  // Live conversation (LiveKit full-duplex) — a separate mode next to the
  // classic voice loop; it excludes that loop while running.
  const live = useLiveVoice({
    onTranscript: chat.appendSpoken,
    onUiEvent: chat.applySpokenEvent,
  });
  // For users the API allows, an external orb (mobile overlay) drives the
  // live conversation instead of the record → send → read-aloud loop; the
  // phone hides the composer's own live button. One failed connect (e.g. no
  // media path while away) falls back to that loop for the rest of the session.
  const [liveErlaubt, setLiveErlaubt] = useState<boolean | null>(onVoiceBind ? null : false);
  const [liveGescheitert, setLiveGescheitert] = useState(false);
  useEffect(() => {
    if (!onVoiceBind) return;
    let vorbei = false;
    fetch("/api/claraos/chat/v2/voice/config", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { live: false }))
      .then((d) => { if (!vorbei) setLiveErlaubt(!!d?.live); })
      .catch(() => { if (!vorbei) setLiveErlaubt(false); });
    return () => { vorbei = true; };
    // the host binds once; a changing callback identity must not refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const orbLive = !!liveErlaubt && !liveGescheitert;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [extraFiles, setExtraFiles] = useState<File[]>([]);
  const [pendingText, setPendingText] = useState<{ value: string } | null>(null);
  const { dialogHost, confirmDlg, promptDlg, alertDlg } = useDialogs();
  const user = useAuthStore((s) => s.user);

  // Carry-over draft from the launcher input (start-menu expansion).
  useEffect(() => {
    if (initialText?.value) setPendingText({ value: initialText.value });
  }, [initialText]);

  // The phone sheet header gets title, history and actions.
  // The history on phones shows ALL of the user's chats (with an app chip), not
  // only those of the open app — the hook filters its list by appId.
  const [alleChats, setAlleChats] = useState<import("./api").WebUIChatSummary[]>([]);
  const ladeAlle = useCallback(async () => {
    try {
      setAlleChats(await chatsApi.list({ include_folders: true, limit: 100 }));
    } catch { /* history is nice-to-have */ }
  }, []);
  useEffect(() => { if (onChatBind) void ladeAlle(); }, [onChatBind, ladeAlle, chat.chatId, chat.messages.length]);
  useEffect(() => {
    if (!onChatBind) return;
    const eigener = alleChats.find((c) => c.id === chat.chatId) ?? chat.chatList.find((c) => c.id === chat.chatId);
    const ersteFrage = chat.messages.find((m) => m.role === "user")?.content ?? "";
    onChatBind({
      chatId: chat.chatId,
      title: (eigener?.title || ersteFrage).slice(0, 60),
      chats: alleChats.length ? alleChats : chat.chatList,
      streaming: chat.streaming,
      startNewChat: () => chat.startNewChat(),
      loadChat: (id) => chat.loadChat(id),
      removeChat: async (id) => { await chat.removeChat(id); await ladeAlle(); },
      refresh: async () => { await chat.refresh(); await ladeAlle(); },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChatBind, chat.chatId, chat.chatList, alleChats, chat.messages.length, chat.streaming]);
  useEffect(() => () => { onChatBind?.(null); }, [onChatBind]);

  // ── Empty state + context chips on phones ──────────────────────────────
  // Suggestions per app from the server (curated list in chat_v2, not the
  // tool hints). Gemini/ChatGPT show in an empty chat what you can ask;
  // on mobile this used to show only "Hallo! Ich bin Clara."
  type Vorschlag = { label: string; prompt: string; sofort?: boolean };
  const [vorschlaege, setVorschlaege] = useState<Vorschlag[]>([]);
  useEffect(() => {
    if (!mobil) return;
    let tot = false;
    const q = appId ? `?app=${encodeURIComponent(appId)}` : "";
    fetch(`/api/claraos/chat/v2/vorschlaege${q}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!tot && j && Array.isArray(j.vorschlaege)) setVorschlaege(j.vorschlaege); })
      .catch(() => undefined);
    return () => { tot = true; };
  }, [mobil, appId]);
  // "Zu dieser App" (about this app): on = Clara gets the app as context
  // (default); off = a question without app reference. "Bildschirm lesen" (read
  // screen): attaches the shell's text report (same as read_screen) to the NEXT message.
  const [mitApp, setMitApp] = useState(true);
  const [mitSchirm, setMitSchirm] = useState(false);
  const appName = useAppRegistryStore((s) => (appId ? s.getApp(appId)?.name : undefined));

  const handleUiHook = useCallback(
    (hook: ClaraUiHook, resolved: Record<string, unknown>) => {
      const resolvedKeys = Object.keys(resolved);
      const missing = (hook.context ?? []).filter((k) => !(k in resolved));
      let prompt = `${hook.label}.`;
      if (resolvedKeys.length) {
        // Render each value as a one-line k: v summary. Arrays/objects get
        // JSON.stringify so Clara can see structure; long strings are
        // truncated so the composer stays readable (Clara still sees the
        // full extraMeta payload on send).
        const lines = resolvedKeys.map((k) => {
          const v = resolved[k];
          let s: string;
          if (typeof v === "string") s = v;
          else s = JSON.stringify(v);
          if (s.length > 280) s = s.slice(0, 277) + "...";
          return `${k}: ${s}`;
        });
        prompt += `\n\n${lines.join("\n")}`;
      }
      if (missing.length) {
        prompt += `\n\n(missing context: ${missing.join(", ")})`;
      }
      setPendingText({ value: prompt });
    },
    [],
  );

  useEffect(() => {
    // Do not reload the chat we are currently in — the overlay passes the
    // just-created chat ID back as initialChatId, and the server state then
    // overwrote the local one (error text gone).
    if (initialChatId && initialChatId !== chat.chatId) {
      chat
        .loadChat(initialChatId, initialMessages?.length ? { fallbackMessages: initialMessages } : undefined)
        .catch(() => undefined);
    }
    // run once on mount; chat.loadChat is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChatId]);

  // Enter full voice-mode (not just a one-shot recording): this starts the
  // mic AND enables the speak-back + auto-relisten loop so Clara actually
  // answers by voice. Ref-guarded so StrictMode's double effect-run doesn't
  // toggle twice (on→off = dead mic, a former dev-only bug).
  const autoRecordedRef = useRef(false);
  useEffect(() => {
    // waits for the live decision, otherwise the first mic would be the wrong one
    if (!autoRecord || autoRecordedRef.current || liveErlaubt === null) return;
    autoRecordedRef.current = true;
    if (orbLive) void live.start();
    else if (!chat.voiceMode) chat.toggleVoiceMode();
    // toggleVoiceMode and live.start are stable inside their hooks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRecord, liveErlaubt]);

  // Live connect failed (token, SDK, no media path): continue with the classic
  // loop right away instead of leaving the user at a dead orb.
  useEffect(() => {
    if (orbLive && live.state === "error") {
      setLiveGescheitert(true);
      if (!chat.voiceMode) chat.toggleVoiceMode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbLive, live.state]);

  // Mirror the chat's internal voice state into the global voice store so
  // external surfaces (mobile Clara overlay, desktop VoiceBubble) can reflect
  // the full state machine incl. errors. Reset on unmount.
  // A running live conversation maps onto the same states, so the orb glows
  // and pulses exactly as in the classic loop.
  const liveUi =
    live.state === "connecting" ? "arming"
      : live.state === "listening" ? "recording"
        : live.state === "speaking" ? "speaking"
          : null;
  useEffect(() => {
    useVoiceStore.getState().setVoiceUi(
      orbLive && live.active && liveUi
        ? { state: liveUi, error: null }
        : { state: chat.voiceState, error: chat.voiceError },
    );
  }, [chat.voiceState, chat.voiceError, orbLive, live.active, liveUi]);
  useEffect(() => () => {
    useVoiceStore.getState().setVoiceUi({ state: "idle", error: null });
  }, []);

  // Surface the voice control fns to a parent (mobile overlay orb). The fns are
  // stable (useCallback in the hook), so this binds once and clears on unmount.
  useEffect(() => {
    if (!onVoiceBind) return;
    if (orbLive) {
      // Tap = start or end the conversation; interrupting works by voice.
      onVoiceBind({
        startRecording: live.toggle,
        stopRecording: () => void live.stop(),
        stopSpeaking: () => {},
        toggleVoiceMode: live.toggle,
        live: true,
      });
    } else {
      onVoiceBind({
        startRecording: chat.startRecording,
        stopRecording: chat.stopRecording,
        stopSpeaking: chat.stopSpeaking,
        toggleVoiceMode: chat.toggleVoiceMode,
      });
    }
    return () => onVoiceBind(null);
  }, [onVoiceBind, orbLive, live.toggle, live.stop, chat.startRecording, chat.stopRecording, chat.stopSpeaking, chat.toggleVoiceMode]);

  // Thread continuity for remounting hosts (see onThreadChange prop).
  useEffect(() => {
    onThreadChange?.(chat.chatId, chat.messages);
  }, [onThreadChange, chat.chatId, chat.messages]);

  // Report the newest assistant message's live activity to the host (mobile
  // overlay drives the cobrowse split + status strip from this).
  const lastAssistantActivity = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m.role === "assistant") return m.activity ?? null;
    }
    return null;
  }, [chat.messages]);
  useEffect(() => {
    onActivityChange?.(lastAssistantActivity, chat.streaming);
  }, [onActivityChange, lastAssistantActivity, chat.streaming]);

  const handleNewChat = useCallback(
    (folderId?: string) => {
      chat.startNewChat({ folderId });
    },
    [chat],
  );

  const handleCreateFolder = useCallback(
    async (parentId?: string) => {
      const name = await promptDlg("Ordnername:");
      if (!name) return;
      try {
        await foldersApi.create(name, parentId);
        await chat.refresh();
      } catch (err) {
        console.error("create folder failed", err);
      }
    },
    [chat, promptDlg],
  );

  // ── Drop-zone for ClaraOS DraggedItems (file/files from FileBrowser) ──
  const handlePanelDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const item = useDragStore.getState().current;
    if (item && (item.type === "file" || item.type === "files")) {
      e.preventDefault();
    }
  }, []);

  const handlePanelDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    const item = useDragStore.getState().current;
    if (!item) return;
    e.preventDefault();
    let resolved: File[] = [];
    if (item.type === "file") {
      const f = await readClaraosFile(item.source, item.path);
      if (f) resolved = [f];
    } else if (item.type === "files") {
      const all = await Promise.all(item.paths.map((p) => readClaraosFile(item.source, p)));
      resolved = all.filter((f): f is File => f !== null);
    }
    if (resolved.length) setExtraFiles((prev) => [...prev, ...resolved]);
    useDragStore.getState().endDrag();
  }, []);

  const showTree = variant === "full" || variant === "sidebar";
  const compactComposer = variant === "quick";

  return (
    <div
      className={[
        styles.panel,
        styles[`variant_${variant}`] ?? "",
        className ?? "",
      ].join(" ")}
      data-no-drag
      data-claraos-chat-surface={`${variant}:${appId ?? "shell"}`}
      onDragOver={handlePanelDragOver}
      onDrop={handlePanelDrop}
    >
      {showTree && (
        <aside className={styles.tree}>
          <FolderTree
            folders={chat.folderTree}
            chats={chat.chatList}
            activeChatId={chat.chatId}
            onSelectChat={(id) => chat.loadChat(id)}
            onNewChat={handleNewChat}
            onCreateFolder={handleCreateFolder}
            onRenameChat={async (id, currentTitle) => {
              const name = await promptDlg("Chat umbenennen:", currentTitle);
              if (!name || name === currentTitle) return;
              try {
                await chatsApi.rename(id, name);
                await chat.refresh();
              } catch (err) {
                console.error("rename chat failed", err);
              }
            }}
            onRenameFolder={async (id, currentName) => {
              const name = await promptDlg("Ordner umbenennen:", currentName);
              if (!name || name === currentName) return;
              try {
                await foldersApi.rename(id, name);
                await chat.refresh();
              } catch (err) {
                console.error("rename folder failed", err);
              }
            }}
            onDeleteFolder={async (id, name) => {
              if (await confirmDlg(`Ordner „${name}“ samt enthaltenen Chats löschen?`, "Löschen")) {
                try {
                  await foldersApi.remove(id);
                  await chat.refresh();
                } catch (err) {
                  console.error("delete folder failed", err);
                }
              }
            }}
            onDeleteChat={async (id) => {
              const title = chat.chatList.find((c) => c.id === id)?.title;
              if (await confirmDlg(`Chat${title ? ` „${title}“` : ""} löschen?`, "Löschen")) {
                await chat.removeChat(id);
              }
            }}
            onRefresh={() => chat.refresh()}
            onCleanupAutoFolders={async () => {
              try {
                const preview = await foldersApi.cleanupCandidates();
                const n = preview.candidates.length;
                if (n === 0) {
                  await alertDlg("Keine leeren Auto-Ordner zum Aufräumen.");
                  return;
                }
                if (!(await confirmDlg(`${n} leere Auto-Ordner werden gelöscht. Fortfahren?`, "Aufräumen"))) return;
                const result = await foldersApi.cleanup();
                await chat.refresh();
                await alertDlg(`${result.count} Ordner aufgeräumt.`);
              } catch (err) {
                console.error("cleanup failed", err);
                await alertDlg("Aufräumen fehlgeschlagen — siehe Console.");
              }
            }}
          />
        </aside>
      )}

      <div className={styles.main}>
        {variant !== "full" && !hideHeader && (
          <header className={styles.header}>
            <div className={styles.titleRow}>
              <span className={styles.brandIcon} aria-hidden="true">
                <ClaraMark className={styles.brandMark} />
              </span>
              <span className={styles.brandName}>Clara</span>
              {appId && objectKey && (
                <span className={styles.brandContext} title={objectKey}>
                  · {objectShortName(objectKey)}
                </span>
              )}
            </div>
            <div className={styles.headerActions}>
              {chat.error && (
                <span className={styles.errorBadge} title={chat.error}>
                  ⚠
                </span>
              )}
              {onExpand && (
                <button
                  type="button"
                  className={styles.headerBtn}
                  onClick={onExpand}
                  title="Im Vollbild öffnen"
                >
                  ↗
                </button>
              )}
              {onClose && (
                <button
                  type="button"
                  className={styles.headerBtn}
                  onClick={onClose}
                  title="Schließen"
                >
                  ×
                </button>
              )}
            </div>
          </header>
        )}

        {/* Other running Clara tasks (other chat / other app) visible directly
            in the chat — the own stream is filtered out via surface+app. */}
        {/* Warning: on phones only the header row — the bar sits OUTSIDE the
            message list and permanently took up to 180 px plus header there,
            i.e. a quarter of the sheet, with a running-task count permanently
            above the chat. A tap expands it. */}
        <ActiveAgentsPanel excludeSurface={variant} excludeAppId={appId ?? null} kompakt={mobil} />

        <MessageList
          messages={chat.messages}
          streaming={chat.streaming}
          kompakt={mobil}
          onFollowup={mobil || variant === "full" || variant === "sidebar" ? (t) => { chat.send(t).catch(() => undefined); } : undefined}
          onRetry={
            variant === "full" || variant === "sidebar" || mobil
              ? (t) => { chat.send(t).catch(() => undefined); }
              : undefined
          }
          emptyHint={
            mobil ? (
              <div className={`${styles.welcome} ${styles.welcomeMobil}`}>
                <h3>
                  Hallo{user?.name ? ` ${user.name.split(" ")[0]}` : user?.username ? ` ${user.username}` : ""}.
                </h3>
                <p>
                  {appId && appName
                    ? `Ich sehe ${appName}. Was soll ich tun?`
                    : "Was kann ich für dich tun?"}
                </p>
                <div className={styles.welcomeChips}>
                  {(vorschlaege.length ? vorschlaege : WELCOME_CHIPS.map((c) => ({ label: c.label, prompt: c.prompt, sofort: false }))).map((v) => (
                    <button
                      key={v.label}
                      type="button"
                      className={styles.welcomeChip}
                      onClick={() => {
                        if (v.sofort) chat.send(v.prompt).catch(() => undefined);
                        else setPendingText({ value: v.prompt });
                      }}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : variant === "inline" && objectKey ? (
              <div className={styles.welcome}>
                <p>Du arbeitest mit <code>{objectKey}</code>.</p>
                <p>Frag Clara nach Hilfe oder lass etwas erledigen.</p>
              </div>
            ) : variant === "full" || variant === "sidebar" ? (
              <div className={styles.welcome}>
                <div className={styles.welcomeIcon}><ClaraMark className={styles.welcomeMark} /></div>
                <h3>
                  Hallo{user?.name ? ` ${user.name.split(" ")[0]}` : user?.username ? ` ${user.username}` : ""}!
                </h3>
                <p>Wie kann ich dir helfen?</p>
                <div className={styles.welcomeChips}>
                  {WELCOME_CHIPS.map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      className={styles.welcomeChip}
                      onClick={() => setPendingText({ value: c.prompt })}
                    >
                      <span aria-hidden="true">{c.icon}</span> {c.label}
                    </button>
                  ))}
                </div>
                {chat.chatList[0] && (
                  <button
                    type="button"
                    className={styles.welcomeContinue}
                    onClick={() => chat.loadChat(chat.chatList[0].id)}
                    title="Letzte Konversation fortsetzen"
                  >
                    ↻ Weiter mit: <strong>{chat.chatList[0].title || "Letzter Chat"}</strong>
                  </button>
                )}
              </div>
            ) : undefined
          }
        />

        {!hideModuleActions && (
          <UiHookButtons appId={appId} appContext={baseMeta} onHookSelected={handleUiHook} />
        )}

        {/* TTS stop (Gemini pattern): a visible bar while Clara is speaking —
            "read instead of listened to" needs no orb tap. Pure stopSpeaking
            (no auto-relisten as with barge-in). */}
        {/* Live conversation status: full-duplex — interrupting allowed */}
        {live.state !== "idle" && (
          <div className={styles.speakingBar} data-testid="live-voice-bar">
            <span className={styles.speakingDot} aria-hidden="true" />
            <span className={styles.speakingLabel}>
              {live.state === "connecting" && "Live-Gespräch: verbinde …"}
              {live.state === "listening" && "Live-Gespräch: Clara hört zu …"}
              {live.state === "speaking" && "Clara spricht — du darfst reinreden"}
              {live.state === "error" && `Live-Gespräch: ${live.error ?? "Fehler"}`}
            </span>
            <button
              type="button"
              className={styles.speakingStop}
              onClick={() => void live.stop()}
              aria-label="Live-Gespräch beenden"
            >
              ⏹ Beenden
            </button>
          </div>
        )}

        {chat.voiceState === "speaking" && (
          <div className={styles.speakingBar} data-testid="speaking-bar">
            <span className={styles.speakingDot} aria-hidden="true" />
            <span className={styles.speakingLabel}>Clara spricht …</span>
            <button
              type="button"
              className={styles.speakingStop}
              onClick={chat.stopSpeaking}
              aria-label="Vorlesen stoppen"
            >
              ⏹ Stopp
            </button>
          </div>
        )}

        {mobil && (
          <div className={styles.kontextChips} aria-label="Kontext für Clara">
            {appId && (
              <button
                type="button"
                className={`${styles.kontextChip} ${mitApp ? styles.kontextChipOn : ""}`}
                aria-pressed={mitApp}
                onClick={() => setMitApp((v) => !v)}
                title={mitApp ? "Clara sieht diese App als Kontext" : "Ohne App-Bezug fragen"}
              >
                {mitApp ? "✓ " : ""}Zu dieser App
              </button>
            )}
            <button
              type="button"
              className={`${styles.kontextChip} ${mitSchirm ? styles.kontextChipOn : ""}`}
              aria-pressed={mitSchirm}
              onClick={() => setMitSchirm((v) => !v)}
              title="Hängt an die nächste Frage an, was gerade auf dem Bildschirm steht"
            >
              {mitSchirm ? "✓ " : ""}Bildschirm lesen
            </button>
          </div>
        )}

        <Composer
          onSend={async (t, opts) => {
            // Snapshot the pinned marker for THIS send and clear the chip
            // immediately for instant visual feedback. The marker rides on
            // `extraMetaOverride` so it lands in the request even though
            // the store is already cleared by the time chat.send reads
            // extraMetaRef.current (which is too late after the React
            // re-render scheduled by clearMarker()).
            const pin = pinnedMarker;
            let overrideMeta: Record<string, unknown> | undefined = pin
              ? { ...baseMeta, marker: pin }
              : undefined;
            if (pin) clearMarker();
            // Context chips. `app_id: null` overrides the app from the hook
            // (chat_v2 reads meta.app_id); the screen report applies only to
            // this one message.
            if (mobil && (!mitApp || mitSchirm)) {
              overrideMeta = { ...(overrideMeta ?? baseMeta) };
              if (!mitApp) overrideMeta.app_id = null;
              if (mitSchirm) {
                try { overrideMeta.screen_report = berichtVomSchirm().detail; } catch { /* no report */ }
                setMitSchirm(false);
              }
            }
            const ok = await chat.send(t, { ...opts, extraMetaOverride: overrideMeta });
            // Submission failed (e.g. chat creation) — restore the text so
            // the user can retry instead of losing the message silently.
            if (!ok && t) setPendingText({ value: t });
          }}
          onAbort={chat.abort}
          streaming={chat.streaming}
          queuedText={chat.queued}
          voiceState={chat.voiceState}
          startRecording={chat.startRecording}
          stopRecording={chat.stopRecording}
          voiceMode={chat.voiceMode}
          toggleVoiceMode={chat.toggleVoiceMode}
          liveMode={live.active}
          liveConnecting={live.state === "connecting"}
          toggleLiveMode={() => {
            if (!live.active && chat.voiceMode) chat.toggleVoiceMode();
            live.toggle();
          }}
          liveTranscript={chat.interimTranscript}
          voiceAutoSend={chat.voiceMode}
          hideVoiceButtons={hideVoiceButtons}
          onPickFromClaraOS={() => setPickerOpen(true)}
          currentObjectName={
            variant === "inline" && objectKey ? objectShortName(objectKey) : undefined
          }
          onAttachCurrentObject={
            variant === "inline" && objectKey
              ? async () => {
                  // objectKey was built as "<source>://<path>" — split it back
                  const sep = objectKey.indexOf("://");
                  if (sep < 0) return;
                  const source = objectKey.slice(0, sep);
                  const path = objectKey.slice(sep + 3);
                  const file = await readClaraosFile(source, path);
                  if (file) setExtraFiles((prev) => [...prev, file]);
                }
              : undefined
          }
          injectedFiles={extraFiles}
          pendingText={pendingText}
          markerPicking={markerMode === "picking"}
          onTogglePicking={() => (markerMode === "picking" ? cancelPicking() : startPicking())}
          pinnedMarkerLabel={pinnedMarker ? markerLabel(pinnedMarker) : undefined}
          pinnedMarkerThumb={pinnedMarker ? `data:image/png;base64,${pinnedMarker.snapshotB64}` : undefined}
          onClearPin={pinnedMarker ? clearMarker : undefined}
          compact={compactComposer}
          mobil={mobil}
          onVoiceVollbild={onVoiceVollbild}
          autoFocus={variant !== "quick"}
          placeholder={
            variant === "quick"
              ? "Nachricht an Clara …"
              : appId
                ? `Frag Clara zu ${appId} …`
                : "Frag Clara …"
          }
        />

        <FilePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onPick={(files) => {
            setExtraFiles((prev) => [...prev, ...files]);
            setPickerOpen(false);
          }}
        />

        {/* In voice mode the mic error is shown in the live pill — not twice */}
        {(chat.error || (chat.voiceError && !(mobil && chat.voiceMode))) && (variant === "full" || variant === "quick") && (
          <div className={styles.errorBar}>{chat.error ?? chat.voiceError}</div>
        )}
      </div>

      {dialogHost}
    </div>
  );
}

export default ClaraChatPanel;
