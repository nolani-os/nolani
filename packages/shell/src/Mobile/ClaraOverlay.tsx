/**
 * ClaraOverlay — fullscreen voice assistant for mobile (clara-glass look).
 *
 * One single control: the big central orb.
 *   - tap = speak; silence-VAD ends the utterance automatically (tap = send now)
 *   - the spoken words appear live in the chat composer below (pseudo-live STT)
 *   - Clara answers (text) and speaks back (TTS); tapping the orb during
 *     playback barges in (stop TTS → listen again)
 * Every pipeline state is visible: orb variant (data-voice-state), level ring
 * while recording, status line, mic errors in red with tap-to-retry.
 *
 * Cobrowse: when Clara operates an app — via shell actions OR app tool calls
 * (toolAppMap) — the top half shows the live app instead of the orb, with a
 * status strip narrating the current step. Same quick-chat continues below.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAppRegistryStore, useVoiceStore, useTranslation, getBrand } from "@claraos/core";
import { ClaraChatPanel } from "../Chat";
import type { ChatBind } from "../Chat/ClaraChatPanel";
import type { ClaraActivity } from "../Chat/api";
import { VerlaufSheet } from "./VerlaufSheet";
import { appIdForTool } from "../Chat/toolAppMap";
import { resolveMobileStrategy } from "../apps/mobileStrategies";
import { CobrowseStatusStrip } from "./CobrowseStatusStrip";
import ClaraC from "./clara-c.svg?react";
import styles from "./ClaraOverlay.module.css";

// Thread continuity across remounts (close -> FAB -> reopen):
// a module singleton instead of state — survives the overlay's unmount.
//
// Warning: this was a trap users could not get out of. Two things are
// deliberately different from before:
//  1. `onThreadChange` only updated the state when `id || msgs.length` was set.
//     After `startNewChat()` BOTH are empty — so the singleton kept the old
//     chat ID exactly when the user wanted to get rid of it.
//  2. The ID was additionally stored in localStorage. On the next mount the
//     old ID went back in as `initialChatId`, `loadChat` fetched the old
//     history — and THAT load wrote the ID back into localStorage. The trap
//     re-armed itself; "New chat" could not win, and even a reload did not help.
// Design decision: every open starts fresh. This storage is therefore only a
// BRIDGE across the unmount, not persistent storage — nothing survives a
// reload or the night any more.
let _quickThread: { chatId: string | null; messages: import("../Chat/api").WebUIMessage[] } = {
  chatId: null,
  messages: [],
};

// One-time cleanup: devices that ran the old version still carry the chat ID
// in storage. It is no longer read anywhere — but a key named exactly like
// the trap is an invitation for the next person to read it again. So remove
// it as soon as this version has loaded once.
try {
  localStorage.removeItem("claraos-mobile-chat-id");
} catch { /* no storage */ }

/** The next open starts empty.
 *
 *  The mobile shell calls this on open — but NOT while an answer is running
 *  or waiting unread. Otherwise "fresh" would mean data loss: the corner grip
 *  says "answer ready", and tapping it would throw away exactly the answer
 *  the user was waiting for. */
export function claraThreadZuruecksetzen(): void {
  _quickThread = { chatId: null, messages: [] };
}

const THREAD_GESETZT_EVENT = "claraos-clara-thread-gesetzt";

/** The next open (or the open overlay right away) shows chat `chatId` —
 *  used by job notifications that lead into the chat where the job ran. */
export function claraThreadSetzen(chatId: string): void {
  _quickThread = { chatId, messages: [] };
  window.dispatchEvent(new CustomEvent(THREAD_GESETZT_EVENT, { detail: { chatId } }));
}

type VoiceApi = {
  startRecording: () => void;
  stopRecording: () => void;
  stopSpeaking: () => void;
  toggleVoiceMode: () => void;
  /** true: the orb drives a live conversation (full-duplex), see ClaraChatPanel. */
  live?: boolean;
};

// Voice states with their own status line in the "mobile" catalog
// (overlay.live.* for a live conversation, overlay.status.* otherwise).
const LIVE_STATES = new Set(["idle", "arming", "recording", "speaking"]);
const STATUS_STATES = new Set(["idle", "arming", "recording", "transcribing", "thinking", "speaking"]);

/** Leaf component so the ~15 Hz level ticks re-render only this ring. */
function LevelRing() {
  const level = useVoiceStore((s) => s.micLevel);
  return <span className={styles.levelRing} style={{ "--mic-level": level } as CSSProperties} />;
}

export function ClaraOverlay({ open, onClose, voice = false, versteckt = false, onStreamingChange, appSlot = null, cobrowseAppId = null, onExitCobrowse }: {
  open: boolean;
  onClose: () => void;
  /** Glow: mounted but invisible — the stream keeps running while the sheet
   *  is "closed"; the corner grip shows the state. */
  versteckt?: boolean;
  onStreamingChange?: (streaming: boolean) => void;
  /** true = voice mode immediately (swipe/long press), false = text chat (tap). */
  voice?: boolean;
  /** When set, split-view: this live app renders on top, the same quick-chat below. */
  appSlot?: ReactNode;
  /** App currently in the split (guards the auto-cobrowse trigger). */
  cobrowseAppId?: string | null;
  onExitCobrowse?: () => void;
}) {
  const cobrowse = !!appSlot;
  const { t } = useTranslation("mobile");
  // Fine-grained voice state is mirrored from the chat's engine by
  // ClaraChatPanel — the overlay reflects it (no mic driving here).
  const voiceUi = useVoiceStore((s) => s.state);
  const voiceError = useVoiceStore((s) => s.error);
  const [api, setApi] = useState<VoiceApi | null>(null);

  const recording = voiceUi === "recording";
  const active = recording || voiceUi === "speaking";

  // Live activity of the newest assistant message (cobrowse trigger + strip).
  const [activity, setActivity] = useState<ClaraActivity | null>(null);
  const streamingRef = useRef(false);
  const seenToolIdsRef = useRef<Set<string>>(new Set());
  const shownAppsRef = useRef<Set<string>>(new Set());
  const lastSwitchAtRef = useRef(0);
  const onActivityChange = (a: ClaraActivity | null, streaming: boolean) => {
    setStreamt(streaming);
    onStreamingChange?.(streaming);
    if (streaming && !streamingRef.current) {
      // new stream — forget the previous turn's tools/apps
      seenToolIdsRef.current.clear();
      shownAppsRef.current.clear();
    }
    streamingRef.current = streaming;
    setActivity(a);
  };

  // Auto-cobrowse on app tool calls: a new tool.start whose tool maps to an
  // app with a mobile UI brings that app into the split — the user watches
  // Clara work instead of a pulsing orb. Not gated on `streaming`: fast
  // streams finish before React flushes, so we gate on tool recency instead
  // (also keeps rehydrated old chats from re-triggering the split).
  useEffect(() => {
    if (!open || !activity) return;
    const now = Date.now();
    for (const [toolId, tool] of Object.entries(activity.activeTools)) {
      if (seenToolIdsRef.current.has(toolId)) continue;
      seenToolIdsRef.current.add(toolId);
      if (now - tool.startedAt > 15_000) continue; // stale (reloaded history)
      const appId = appIdForTool(tool.name);
      if (!appId || appId === cobrowseAppId) continue;
      if (shownAppsRef.current.has(appId)) continue; // once per stream
      const app = useAppRegistryStore.getState().getApp(appId);
      if (!app || app.activated === false) continue;
      if (resolveMobileStrategy(app).strategy === "redirect") continue; // split would only show a landing page
      if (now - lastSwitchAtRef.current < 5000) continue; // max one auto-switch / 5s
      lastSwitchAtRef.current = now;
      shownAppsRef.current.add(appId);
      window.dispatchEvent(new CustomEvent("claraos:mobile-cobrowse", { detail: { appId } }));
      break;
    }
  }, [open, activity, cobrowseAppId]);

  // Warning: click guard after opening. The grip sits bottom left, exactly
  // where the sheet mounts its attach button. A trailing `click` (touch ->
  // synthetic click) hit it and opened the attach menu unasked (probe: touch
  // 2/2). 350 ms without pointer events on the sheet — shorter than any
  // deliberate second touch.
  const [frisch, setFrisch] = useState(false);
  useEffect(() => {
    if (!open) return;
    setFrisch(true);
    const timer = window.setTimeout(() => setFrisch(false), 350);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Double tap (half <-> full) existed but was documented nowhere.
  // Show a hint three times on open, then never again.
  const HINWEIS_KEY = "claraos-mobile-griff-hinweis";
  const [hinweisZeigen, setHinweisZeigen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let gesehen = 3;
    try {
      gesehen = Number(localStorage.getItem(HINWEIS_KEY) || 0);
    } catch { /* no storage -> do not show at all */ }
    if (gesehen >= 3) return;
    try {
      localStorage.setItem(HINWEIS_KEY, String(gesehen + 1));
    } catch { /* ignore */ }
    setHinweisZeigen(true);
    const timer = window.setTimeout(() => setHinweisZeigen(false), 4500);
    return () => window.clearTimeout(timer);
  }, [open]);

  const handleClose = () => {
    useVoiceStore.getState().stopListening();
    useVoiceStore.getState().setSpeaking(false);
    onClose();
  };

  // ── Chat sheet with drag resize ─────────────────────────────────────────
  // Two snap points: "voice" (46vh chat, big orb — the old layout) and
  // "chat" (chat fills almost everything, the orb gives way to the mini orb in
  // the top bar). Default = "chat": reading is the everyday case; last choice persists.
  // Three detents for the text chat — "strip" (last line + composer, the app
  // stays usable), "half" (default), "full". "voice" remains the orb layout
  // for voice mode.
  type Snap = "voice" | "strip" | "half" | "full";
  const [snap, setSnapState] = useState<Snap>(() => {
    try {
      const s = localStorage.getItem("claraos-mobile-chat-snap");
      return s === "full" || s === "half" ? s : "half";
    } catch {
      return "half";
    }
  });
  const setSnap = (next: Snap) => setSnapState(next);
  // Voice mode via swipe -> orb layout; text -> last text detent.
  // Voice starts in the live pill (half sheet), not in the full-screen orb —
  // that remains available as an option via ⤢ in the pill.
  useEffect(() => {
    setSnapState((s) => (s === "voice" ? "half" : s));
  }, [voice, open]);
  const [verlaufOffen, setVerlaufOffen] = useState(false);
  const [bind, setBind] = useState<ChatBind | null>(null);
  // Already open with another chat: load the requested one into the panel.
  // (Closed: the panel mounts later and reads _quickThread itself.)
  useEffect(() => {
    const laden = (e: Event) => {
      const id = (e as CustomEvent<{ chatId?: string }>).detail?.chatId;
      if (bind && id && bind.chatId !== id) void bind.loadChat(id);
    };
    window.addEventListener(THREAD_GESETZT_EVENT, laden);
    return () => window.removeEventListener(THREAD_GESETZT_EVENT, laden);
  }, [bind]);
  const [streamt, setStreamt] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Also track velocity so a swipe carries intent (a fling down should close,
  // not snap in halfway).
  const dragRef = useRef<
    { startY: number; startH: number; lastY: number; lastT: number; v: number } | null
  >(null);
  // A single state change per gesture (show detent lines) — the height itself
  // still goes through direct style mutation, without a re-render per move.
  const [zieht, setZieht] = useState(false);
  // Cobrowse split: chat share freely draggable (25–78dvh), last choice persists.
  const [cobrowseH, setCobrowseH] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem("claraos-mobile-cobrowse-h"));
      return (v >= 25 && v <= 78) || v === 14 ? v : 45;
    } catch {
      return 45;
    }
  });

  const applySnap = (next: Snap) => {
    setSnap(next);
    if (next === "voice") return;
    try {
      localStorage.setItem("claraos-mobile-chat-snap", next);
    } catch { /* ignore */ }
  };

  // Drag on the handle: height follows the finger (direct style mutation, no
  // re-render per move); on release it snaps to the nearest point.
  const onHandlePointerDown = (e: React.PointerEvent) => {
    const el = panelRef.current;
    if (!el) return;
    dragRef.current = {
      startY: e.clientY,
      startH: el.getBoundingClientRect().height,
      lastY: e.clientY,
      lastT: performance.now(),
      v: 0,
    };
    el.setAttribute("data-dragging", "true");
    setZieht(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onHandlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = panelRef.current;
    if (!d || !el) return;
    const jetzt = performance.now();
    const dt = jetzt - d.lastT;
    // Smoothed, otherwise the last 4 ms jitter decides the gesture.
    if (dt > 0) d.v = 0.7 * ((e.clientY - d.lastY) / dt) + 0.3 * d.v;
    d.lastY = e.clientY;
    d.lastT = jetzt;
    const max = window.innerHeight * 0.92;
    // Important: lower bound below the strip (120 px): otherwise the gesture
    // gets stuck there and the sheet cannot be swiped away downward.
    const min = 56;
    const h = Math.min(max, Math.max(min, d.startH + (d.startY - e.clientY)));
    el.style.height = `${h}px`;
  };
  const onHandlePointerUp = () => {
    const d = dragRef.current;
    const el = panelRef.current;
    dragRef.current = null;
    setZieht(false);
    if (!d || !el) return;
    const h = el.getBoundingClientRect().height;
    el.style.height = "";
    el.removeAttribute("data-dragging");
    // px/ms; 0.6 ≈ 600 px/s — below that it is a drag, above it a fling.
    const schnell = Math.abs(d.v) > 0.6;
    const runter = d.v > 0;
    if (cobrowse) {
      // Split resize: free height (the app pane fills the rest) — but below 25 %
      // the strip snaps in: last line + composer, the app above gets almost
      // everything. data-sheet="strip" hides actions.
      const roh = (h / window.innerHeight) * 100;
      const pct = roh < 25 ? 14 : Math.min(78, Math.max(25, roh));
      setSnapState(roh < 25 ? "strip" : "half");
      setCobrowseH(Math.round(pct));
      try {
        localStorage.setItem("claraos-mobile-cobrowse-h", String(Math.round(pct)));
      } catch { /* ignore */ }
      return;
    }
    // Three detents: < 28 % -> strip, < 72 % -> half, otherwise full.
    // In voice mode the orb stays; dragging does not switch modes there.
    if (snap === "voice") return;
    const anteil = h / window.innerHeight;
    // Important: dragging down out of the sheet CLOSES it (Material 3 / iOS
    // convention). Previously the gesture got stuck at 96 px — the only exit
    // was the ✕ at the top right, which nobody finds blindly on a phone.
    if (anteil < 0.12 || (runter && schnell && snap === "strip")) {
      handleClose();
      return;
    }
    const stufen: Snap[] = ["strip", "half", "full"];
    let ziel: Snap = anteil < 0.28 ? "strip" : anteil < 0.72 ? "half" : "full";
    if (schnell) {
      // A fling carries the intent further than the finger travelled.
      const i = stufen.indexOf(ziel);
      ziel = stufen[Math.min(stufen.length - 1, Math.max(0, i + (runter ? -1 : 1)))];
    }
    applySnap(ziel);
  };

  // The orb is the single voice control:
  //   recording → tap ends the utterance (→ transcribe → send)
  //   speaking  → barge-in (stop TTS, listen again)
  //   idle      → (re)open the mic — also the error-retry path
  //   arming/transcribing/thinking → no-op (self-guarded anyway)
  const onOrbTap = () => {
    if (!api) return;
    if (voiceUi === "recording") api.stopRecording();
    else if (voiceUi === "speaking") {
      api.stopSpeaking();
      api.startRecording();
    } else if (voiceUi === "idle") api.startRecording();
  };

  const status =
    voiceError ??
    (api?.live && LIVE_STATES.has(voiceUi) ? t(`overlay.live.${voiceUi}`) : undefined) ??
    t(`overlay.status.${STATUS_STATES.has(voiceUi) ? voiceUi : "idle"}`);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={styles.overlay}
          data-cobrowse={cobrowse ? "true" : undefined}
          data-sheet={snap}
          data-streamt={streamt ? "true" : undefined}
          data-versteckt={versteckt ? "true" : undefined}
          aria-hidden={versteckt ? true : undefined}
          style={versteckt ? { visibility: "hidden", pointerEvents: "none" } : undefined}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className={`${styles.glow} ${active ? styles.glowActive : ""}`} />

          {/* While dragging, show where it will snap — otherwise users guess. The
              reference is the screen, hence here at the root and not in the
              grip (.panelWrap is position:relative, where dvh would be the
              wrong reference frame). */}
          {zieht && !cobrowse && snap !== "voice" && (
            <div className={styles.rastLinien} aria-hidden>
              <span data-rast="strip" />
              <span data-rast="half" />
              <span data-rast="full" />
            </div>
          )}

          {/* Cobrowse split: the live app Clara operates (same quick-chat continues below) */}
          <div className={styles.splitApp}>
            {appSlot}
            {cobrowse && <CobrowseStatusStrip activity={activity} />}
          </div>

          <div className={styles.topBar}>
            {/* The title is the second way into the history. Previously only a
                ☰ among four identical round buttons led there — whoever was in
                the wrong conversation could not find the way out. */}
            <button
              type="button"
              className={styles.titleRow}
              onClick={() => { if (!bind) return; void bind.refresh(); setVerlaufOffen((v) => !v); }}
              disabled={!bind}
              aria-label={bind ? t("overlay.openHistory") : undefined}
              aria-expanded={bind ? verlaufOffen : undefined}
            >
              <ClaraC className={styles.titleLogo} />
              <span className={styles.title}>{cobrowse ? `${getBrand().assistant} · live` : (bind?.title || getBrand().assistant)}</span>
              {bind && !cobrowse && <span className={styles.titleCaret} aria-hidden>▾</span>}
            </button>
            <div className={styles.topBarAktionen}>
              {snap !== "voice" && bind && (
                <>
                  <button
                    className={styles.close}
                    onClick={() => { bind.startNewChat(); setVerlaufOffen(false); }}
                    aria-label={t("overlay.newChat")}
                    title={t("overlay.newChat")}
                  >
                    ＋
                  </button>
                  <button
                    className={styles.close}
                    onClick={() => { void bind.refresh(); setVerlaufOffen((v) => !v); }}
                    aria-label={t("overlay.history")}
                    aria-expanded={verlaufOffen}
                    title={t("overlay.history")}
                  >
                    ☰
                  </button>
                </>
              )}
              {/* Mini orb: voice stays reachable when the big orb has given
                  way to the chat (snap "chat" or cobrowse). */}
              {(snap !== "voice" || cobrowse) && (
                <button
                  className={styles.miniOrb}
                  data-voice-state={voiceUi}
                  data-voice-error={voiceError ? "true" : undefined}
                  onClick={onOrbTap}
                  aria-label={recording ? t("overlay.send") : voiceUi === "speaking" ? t("overlay.interrupt") : t("overlay.speak")}
                >
                  {recording ? "➤" : voiceUi === "speaking" ? "🔊" : "🎤"}
                </button>
              )}
              {cobrowse && onExitCobrowse && (
                <button className={styles.close} onClick={onExitCobrowse} aria-label={t("overlay.fullscreenChat")}>⤢</button>
              )}
              <button className={styles.close} onClick={handleClose} aria-label={t("overlay.close")}>✕</button>
            </div>
          </div>

          {/* Single tappable orb = the only voice control */}
          <div className={styles.orbArea}>
            <button
              className={`${styles.orbBtn} ${active ? styles.orbBtnActive : ""}`}
              data-voice-state={voiceUi}
              data-voice-error={voiceError ? "true" : undefined}
              onClick={onOrbTap}
              aria-label={recording ? t("overlay.send") : voiceUi === "speaking" ? t("overlay.interrupt") : t("overlay.speak")}
            >
              <span className={styles.orb} />
              {recording && <LevelRing />}
              {/* idle = the Clara mark (brand); recording/speaking keep their
                  functional glyphs — the status line explains the tap anyway */}
              <span className={styles.orbIcon}>
                {recording ? "➤" : voiceUi === "speaking" ? "🔊" : <ClaraC className={styles.orbLogo} />}
              </span>
            </button>
            <div
              className={`${styles.statusLine} ${voiceError ? styles.statusError : ""}`}
              data-testid="voice-status"
            >
              {status}
            </div>
          </div>

          {/* Clara-cyan listening bar */}
          <div className={`${styles.sweep} ${active ? styles.sweepActive : ""}`} />

          <motion.div
            ref={panelRef}
            className={styles.panelWrap}
            style={{
              ...(cobrowse ? { height: `${cobrowseH}dvh` } : {}),
              ...(frisch ? { pointerEvents: "none" as const } : {}),
            }}
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: "spring", damping: 28, stiffness: 320 }}
          >
            {(
              <div
                className={styles.sheetHandle}
                onPointerDown={onHandlePointerDown}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                onPointerCancel={onHandlePointerUp}
                onDoubleClick={() => { if (!cobrowse && snap !== "voice") applySnap(snap === "full" ? "half" : "full"); }}
                role="separator"
                aria-label={t("overlay.resizeChat")}
                data-zieht={zieht ? "true" : undefined}
              >
                <span className={styles.sheetHandleBar} />
                {hinweisZeigen && !cobrowse && snap !== "strip" && snap !== "voice" && (
                  <span className={styles.griffHinweis}>{t("overlay.gripHint")}</span>
                )}
              </div>
            )}
            {verlaufOffen && bind && (
              <VerlaufSheet
                chats={bind.chats}
                aktiv={bind.chatId}
                onWaehlen={(id) => { void bind.loadChat(id); if (snap === "strip") applySnap("half"); }}
                onLoeschen={(id) => bind.removeChat(id)}
                onNeu={() => bind.startNewChat()}
                onSchliessen={() => setVerlaufOffen(false)}
              />
            )}
            <ClaraChatPanel
              variant="quick"
              mobil
              onChatBind={setBind}
              onVoiceVollbild={() => applySnap("voice")}
              appId={cobrowseAppId ?? undefined}
              autoRecord={voice}
              hideHeader
              hideVoiceButtons
              hideModuleActions
              initialChatId={_quickThread.chatId ?? undefined}
              initialMessages={_quickThread.messages.length ? _quickThread.messages : undefined}
              onThreadChange={(id, msgs) => {
                // Important: always update, even when empty: a freshly cleared
                // thread IS a state, not "nothing happened". Exactly this
                // condition was the trap (see comment at _quickThread).
                _quickThread = { chatId: id, messages: msgs };
              }}
              onVoiceBind={setApi}
              onActivityChange={onActivityChange}
              onClose={handleClose}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
