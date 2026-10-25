/**
 * Composer — input card + attach/dictate/voice-mode/send.
 *
 * Composer pattern: one rounded card
 * that carries the textarea and a slim toolbar row. "+" (attach) sits
 * left, voice controls right; the round send arrow only appears once
 * there is something to send and turns into a stop button while the
 * answer streams. The cyan accent shows as a focus ring only — no
 * permanent bright border.
 *
 * Voice-mode (AudioLinesIcon) is a separate toggle from Mic (push-to-talk):
 *   * Mic    — single-shot dictation (record → transcribe → fill input)
 *   * Voice  — continuous loop (mic → STT → LLM → TTS → mic)  managed by hook
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveTranscript, VoiceState } from "./useClaraChat";
import {
  PaperclipIcon,
  MicIcon,
  AudioLinesIcon,
  LiveVoiceIcon,
  XIcon,
  StopIcon,
  SendIcon,
  PinIcon,
} from "./icons";
import { useVoiceStore, useTranslation } from "@claraos/core";
import { KameraSheet, sucherMoeglich } from "./KameraSheet";
import styles from "./ClaraChatPanel.module.css";

interface Props {
  onSend: (text: string, opts?: { files?: File[] }) => void;
  onAbort?: () => void;
  streaming?: boolean;
  /** Text waiting in the hook's queue while the previous answer streams. */
  queuedText?: string | null;
  voiceState: VoiceState;
  startRecording: () => void;
  stopRecording: () => void;
  /** Voice-mode toggle (continuous loop) — separate from push-to-talk mic. */
  voiceMode?: boolean;
  toggleVoiceMode?: () => void;
  /** Live conversation (LiveKit full-duplex) — a third, separate mode. */
  liveMode?: boolean;
  liveConnecting?: boolean;
  toggleLiveMode?: () => void;
  /** Pseudo-live transcript from the recorder. Interims rewrite the input's
   *  transcript suffix (a typed draft at record-start stays as prefix);
   *  final=true completes the utterance. New object identity per update. */
  liveTranscript?: LiveTranscript | null;
  /** When true (voice mode) the final transcript is sent automatically;
   *  otherwise it stays editable in the field (dictation). */
  voiceAutoSend?: boolean;
  /** Hide the in-composer Mic + Voice buttons (used when an external control,
   *  e.g. the mobile Clara overlay's orb, drives voice instead). */
  hideVoiceButtons?: boolean;
  /** Optional callback that opens the cross-source FilePickerModal. */
  onPickFromClaraOS?: () => void;
  /** Inline-Chat: short name of the current app object (used in dropdown label). */
  currentObjectName?: string;
  /** Inline-Chat: handler that fetches current object + injects as attachment. */
  onAttachCurrentObject?: () => void;
  /** Files pushed in from outside (picker confirm, drag-drop). Merged into pendingFiles. */
  injectedFiles?: File[];
  /**
   * Text pushed in from outside (UI-hook button click). Treated like
   * injectedFiles: each new value replaces the current input so the user
   * can review and edit before hitting send. Pass a new object identity
   * to re-trigger even when the string is unchanged.
   */
  pendingText?: { value: string } | null;
  /** Marker mode: true while user is picking a region (cursor crosshair). */
  markerPicking?: boolean;
  /** Toggle marker picking-mode. */
  onTogglePicking?: () => void;
  /** Pinned region label, shown as chip if set. */
  pinnedMarkerLabel?: string;
  /** Optional thumbnail (data: URL) for the chip hover preview. */
  pinnedMarkerThumb?: string;
  /** Clear the pinned marker. */
  onClearPin?: () => void;
  placeholder?: string;
  compact?: boolean;
  autoFocus?: boolean;
  /** Phone sheet — a pill with a "+" menu (camera, photos, file,
   *  ClaraOS files, mark region) and one button on the right that morphs
   *  mic → send → stop. Desktop keeps the card with a toolbar. */
  mobil?: boolean;
  /** Fullscreen voice view (orb) as an option from the live pill. */
  onVoiceVollbild?: () => void;
}

/** Auto-grow limit — ~5 lines at 13px/1.4 before the textarea scrolls. */
const MAX_INPUT_HEIGHT = 120;

export function Composer({
  onSend,
  onAbort,
  streaming,
  queuedText,
  voiceState,
  startRecording,
  stopRecording,
  voiceMode,
  toggleVoiceMode,
  liveMode,
  liveConnecting,
  toggleLiveMode,
  liveTranscript,
  voiceAutoSend,
  hideVoiceButtons,
  onPickFromClaraOS,
  currentObjectName,
  onAttachCurrentObject,
  injectedFiles,
  pendingText,
  markerPicking,
  onTogglePicking,
  pinnedMarkerLabel,
  pinnedMarkerThumb,
  onClearPin,
  placeholder: placeholderProp,
  compact,
  autoFocus,
  mobil,
  onVoiceVollbild,
}: Props) {
  const { t } = useTranslation("chat");
  const placeholder = placeholderProp ?? t("composer.placeholder");
  // Level for the live pill's waves (leaf re-render only)
  const micLevel = useVoiceStore((s) => s.micLevel);
  const voiceFehler = useVoiceStore((s) => s.error);
  const [text, setText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [plusOffen, setPlusOffen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const kameraInputRef = useRef<HTMLInputElement>(null);
  // Warning: "Kamera" used to open a hidden `<input capture>`. The web page
  // does everything right there — the companion app just does not honour
  // `capture` (`onShowFileChooser` builds the intent with
  // `params.createIntent()`, and `isCaptureEnabled()` is never used in the
  // Android project). So on phones a file picker appeared instead of the
  // camera. This exact finding was documented at the top of
  // `apps/kamera/sucher.ts` — the chat had just never adopted it.
  const [kameraOffen, setKameraOffen] = useState(false);
  /** Viewfinder if possible; otherwise the old path (browser without getUserMedia). */
  const kameraOeffnen = useCallback(() => {
    if (sucherMoeglich()) setKameraOffen(true);
    else kameraInputRef.current?.click();
  }, []);
  const fotoInputRef = useRef<HTMLInputElement>(null);
  // Preview images for attached images (object URLs, released on removal)
  const [thumbs, setThumbs] = useState<Map<File, string>>(new Map());
  useEffect(() => {
    setThumbs((prev) => {
      const next = new Map(prev);
      for (const f of pendingFiles) {
        if (f.type.startsWith("image/") && !next.has(f)) next.set(f, URL.createObjectURL(f));
      }
      for (const [f, u] of next) {
        if (!pendingFiles.includes(f)) { URL.revokeObjectURL(u); next.delete(f); }
      }
      return next;
    });
  }, [pendingFiles]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Merge injectedFiles whenever the parent pushes new ones.
  const lastInjectedRef = useRef<File[] | undefined>(undefined);
  if (injectedFiles && injectedFiles !== lastInjectedRef.current) {
    lastInjectedRef.current = injectedFiles;
    if (injectedFiles.length) {
      setPendingFiles((prev) => [...prev, ...injectedFiles]);
    }
  }

  // Same pattern for text injected from UI-hook chips.
  const lastPendingTextRef = useRef<typeof pendingText>(undefined);
  if (pendingText && pendingText !== lastPendingTextRef.current) {
    lastPendingTextRef.current = pendingText;
    setText(pendingText.value);
  }

  // Auto-grow: 1 line at rest, grows with content up to MAX_INPUT_HEIGHT.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [text]);

  const send = useCallback(() => {
    const msg = text.trim();
    if (!msg && pendingFiles.length === 0) return;
    onSend(msg, pendingFiles.length ? { files: pendingFiles } : undefined);
    setText("");
    setPendingFiles([]);
  }, [text, pendingFiles, onSend]);

  // ── Live dictation: transcript flows into the text field ──
  // A draft typed before recording is preserved as prefix; each interim
  // rewrites only the transcript suffix behind it.
  const draftPrefixRef = useRef("");
  const prevVoiceStateRef = useRef<VoiceState>("idle");
  useEffect(() => {
    const prev = prevVoiceStateRef.current;
    prevVoiceStateRef.current = voiceState;
    if (voiceState === "arming" && prev !== "arming") {
      draftPrefixRef.current = text.trim();
    }
  }, [voiceState, text]);

  const lastLiveTranscriptRef = useRef<typeof liveTranscript>(undefined);
  useEffect(() => {
    if (!liveTranscript || liveTranscript === lastLiveTranscriptRef.current) return;
    lastLiveTranscriptRef.current = liveTranscript;
    const prefix = draftPrefixRef.current;
    const combined = prefix ? `${prefix} ${liveTranscript.value}`.trim() : liveTranscript.value;
    if (liveTranscript.final && voiceAutoSend) {
      // voice mode: the finished utterance goes out immediately
      draftPrefixRef.current = "";
      const msg = combined.trim();
      if (msg || pendingFiles.length) {
        onSend(msg, pendingFiles.length ? { files: pendingFiles } : undefined);
        setText("");
        setPendingFiles([]);
      }
      return;
    }
    // interim — or final dictation (stays editable in the field)
    setText(combined);
  }, [liveTranscript, voiceAutoSend, onSend, pendingFiles]);

  const arming = voiceState === "arming";
  const recording = voiceState === "recording";
  const transcribing = voiceState === "transcribing";
  const speaking = voiceState === "speaking";
  const hasContent = !!text.trim() || pendingFiles.length > 0;

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("application/x-claraos-file") || e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback(() => setDragOver(false), []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    // Native file drop (from OS file manager)
    const native = Array.from(e.dataTransfer.files ?? []);
    if (native.length) {
      setPendingFiles((prev) => [...prev, ...native]);
    }
    // ClaraOS DraggedItem (file/files from the cross-source FileBrowser) is
    // handled by ClaraChatPanel via useDragStore — this component only catches
    // native drops here.
  }, []);

  return (
    <div
      className={`${styles.composer} ${compact ? styles.composerCompact : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* In-chat viewfinder — sits as its own sheet above everything, hence
          here at the root and independent of the phone or desktop branch. */}
      {kameraOffen && (
        <KameraSheet
          onFoto={(datei) => { setPendingFiles((p) => [...p, datei]); setKameraOffen(false); }}
          onAbbrechen={() => setKameraOffen(false)}
          onSystemkamera={() => { setKameraOffen(false); kameraInputRef.current?.click(); }}
        />
      )}
      {pendingFiles.length > 0 && (
        <div className={styles.pendingFiles}>
          {pendingFiles.map((f, i) => (
            <span key={i} className={`${styles.pendingFile} ${thumbs.get(f) ? styles.pendingFileImg : ""}`}>
              {thumbs.get(f)
                ? <img src={thumbs.get(f)} alt="" className={styles.pendingThumb} />
                : <><PaperclipIcon size={11} /> {f.name}</>}
              <button
                type="button"
                className={styles.pendingRemove}
                onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                title={t("composer.remove")}
              >
                <XIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {pinnedMarkerLabel && (
        <div className={styles.pendingFiles}>
          <span className={styles.pendingFile} title={pinnedMarkerThumb ? t("composer.pinnedTitle") : undefined}>
            {pinnedMarkerThumb && (
              <img
                src={pinnedMarkerThumb}
                alt=""
                style={{ width: 18, height: 18, objectFit: "cover", borderRadius: 2, marginRight: 4 }}
              />
            )}
            <PinIcon size={11} /> {pinnedMarkerLabel}
            {onClearPin && (
              <button
                type="button"
                className={styles.pendingRemove}
                onClick={onClearPin}
                title={t("composer.clearPin")}
              >
                <XIcon size={11} />
              </button>
            )}
          </span>
        </div>
      )}
      {queuedText && (
        <div className={styles.queuedHint} title={queuedText}>
          ⏳ {t("composer.queued", { text: queuedText.length > 60 ? `${queuedText.slice(0, 57)}…` : queuedText })}
        </div>
      )}
      {mobil && voiceMode ? (
      <div className={styles.liveWrap} data-live-pille data-voice-state={voiceState}>
        {/* Transcript, max. three lines (Gemini pattern): what was spoken then appears as a message in the history */}
        <div className={styles.liveTranskript} aria-live="polite">
          {text
            ? <><b>{t("composer.you")}</b> · {text}</>
            : voiceFehler
              ? <span className={styles.liveFehler}>{voiceFehler}</span>
              : arming ? t("composer.voice.arming")
                : recording ? t("composer.voice.listening")
                  : transcribing ? t("composer.voice.transcribing")
                    : speaking ? t("composer.voice.speaking")
                      : t("composer.voice.idle")}
        </div>
        <div className={styles.livePille}>
          <button type="button" className={styles.pilleBtn} aria-label={t("composer.takePhoto")} title={t("composer.photoTo")} onClick={kameraOeffnen}>📷</button>
          <button
            type="button"
            className={styles.liveWellen}
            aria-label={recording ? t("composer.stopRecordingLabel") : t("composer.speak")}
            onClick={recording ? stopRecording : startRecording}
            disabled={transcribing}
          >
            {Array.from({ length: 14 }).map((_, i) => {
              const f = recording ? Math.max(0.12, Math.min(1, micLevel * (0.6 + Math.abs(Math.sin(i * 1.7)) * 0.9))) : speaking ? 0.35 + 0.3 * Math.abs(Math.sin(i)) : 0.15;
              return <i key={i} style={{ height: `${Math.round(4 + f * 18)}px` }} />;
            })}
          </button>
          <button type="button" className={styles.pilleBtn} aria-label={t("composer.voiceModeEnd")} title={t("composer.voiceModeEndTitle")} onClick={toggleVoiceMode}>✕</button>
          {onVoiceVollbild && (
            <button type="button" className={styles.pilleBtn} aria-label={t("composer.voiceFullscreen")} title={t("composer.voiceFullscreenTitle")} onClick={onVoiceVollbild}>⤢</button>
          )}
        </div>
        <input type="file" ref={kameraInputRef} style={{ display: "none" }} accept="image/*" capture="environment"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) setPendingFiles((p) => [...p, ...fs]); e.target.value = ""; }} />
      </div>
      ) : mobil ? (
      <div className={`${styles.pille} ${voiceMode ? styles.composerVoiceMode : ""}`}>
        <button
          type="button"
          className={styles.pillePlus}
          aria-label={t("composer.plusLabel")}
          aria-expanded={plusOffen}
          onClick={() => setPlusOffen((o) => !o)}
        >
          +
        </button>
        <textarea
          ref={inputRef}
          className={`${styles.composerInput} ${styles.pilleInput}`}
          placeholder={
            arming ? t("composer.voice.arming")
              : recording ? t("composer.voice.dictating")
                : transcribing ? t("composer.voice.transcribing")
                  : speaking ? t("composer.voice.answering")
                    : voiceMode ? t("composer.voice.active")
                      : placeholder
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!recording && !transcribing) send();
            }
          }}
          rows={1}
          data-no-drag
          disabled={transcribing}
        />
        {/* One button that morphs: stop (streaming) → send (content) → mic (empty) */}
        {streaming ? (
          <button type="button" className={`${styles.pilleBtn} ${styles.pilleStop}`} onClick={onAbort} aria-label={t("composer.stop")} title={t("composer.stop")}>
            <StopIcon size={16} />
          </button>
        ) : hasContent ? (
          <button type="button" className={`${styles.pilleBtn} ${styles.pilleSend}`} onClick={send} disabled={transcribing || recording} aria-label={t("composer.send")} title={t("composer.send")}>
            <SendIcon size={16} />
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.pilleBtn} ${recording ? styles.pilleRec : ""}`}
            onClick={recording ? stopRecording : startRecording}
            disabled={transcribing || voiceMode}
            aria-label={recording ? t("composer.dictateEnd") : t("composer.dictate")}
            title={recording ? t("composer.dictateEnd") : t("composer.dictate")}
          >
            {recording ? <StopIcon size={16} /> : <MicIcon size={16} />}
          </button>
        )}
        <input type="file" ref={kameraInputRef} style={{ display: "none" }} accept="image/*" capture="environment"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) setPendingFiles((p) => [...p, ...fs]); e.target.value = ""; }} />
        <input type="file" ref={fotoInputRef} style={{ display: "none" }} accept="image/*" multiple
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) setPendingFiles((p) => [...p, ...fs]); e.target.value = ""; }} />
        <input type="file" ref={fileInputRef} style={{ display: "none" }} multiple
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) setPendingFiles((p) => [...p, ...fs]); e.target.value = ""; }} />
        {plusOffen && (
          <>
            <div className={styles.plusScrim} onClick={() => setPlusOffen(false)} aria-hidden="true" />
            <div className={styles.plusSheet} role="menu" aria-label={t("composer.attach")}>
              <span className={styles.plusHandle} aria-hidden="true" />
              <div className={styles.plusTiles}>
                <button type="button" role="menuitem" className={styles.plusTile} onClick={() => { setPlusOffen(false); kameraOeffnen(); }}>
                  <span aria-hidden="true">📷</span>{t("composer.plus.camera")}
                </button>
                <button type="button" role="menuitem" className={styles.plusTile} onClick={() => { setPlusOffen(false); fotoInputRef.current?.click(); }}>
                  <span aria-hidden="true">🖼️</span>{t("composer.plus.photos")}
                </button>
                <button type="button" role="menuitem" className={styles.plusTile} onClick={() => { setPlusOffen(false); fileInputRef.current?.click(); }}>
                  <span aria-hidden="true">📄</span>{t("composer.plus.file")}
                </button>
                {onPickFromClaraOS && (
                  <button type="button" role="menuitem" className={styles.plusTile} onClick={() => { setPlusOffen(false); onPickFromClaraOS(); }}>
                    <span aria-hidden="true">🗂️</span>{t("composer.plus.productFiles")}
                  </button>
                )}
              </div>
              <div className={styles.plusListe}>
                {onTogglePicking && (
                  <button type="button" role="menuitem" className={styles.plusZeile} onClick={() => { setPlusOffen(false); onTogglePicking(); }}>
                    <span><PinIcon size={16} /></span>
                    <span><b>{t("composer.markArea")}</b><small>{t("composer.markAreaHint")}</small></span>
                  </button>
                )}
                {toggleLiveMode && (
                  <button type="button" role="menuitem" className={styles.plusZeile} onClick={() => { setPlusOffen(false); toggleLiveMode(); }} disabled={voiceMode || recording || transcribing}>
                    <span><LiveVoiceIcon size={16} /></span>
                    <span><b>{liveMode ? t("composer.liveEnd") : t("composer.live")}</b><small>{t("composer.liveHint")}</small></span>
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      ) : (
      <div
        className={`${styles.composerCard} ${voiceMode ? styles.composerVoiceMode : ""} ${dragOver ? styles.composerDragOver : ""}`}
      >
        <textarea
          ref={inputRef}
          className={styles.composerInput}
          placeholder={
            arming ? t("composer.voice.arming")
              : recording ? t("composer.voice.dictating")
                : transcribing ? t("composer.voice.transcribing")
                  : speaking ? t("composer.voice.answering")
                    : voiceMode ? t("composer.voice.active")
                      : placeholder
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!recording && !transcribing) send();
            }
          }}
          rows={compact ? 1 : 2}
          autoFocus={autoFocus}
          data-no-drag
          disabled={transcribing}
        />
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: "none" }}
          multiple
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) setPendingFiles((prev) => [...prev, ...files]);
            e.target.value = "";
          }}
        />
        <div className={styles.composerToolbar}>
          <div className={styles.composerLeft}>
            <div className={styles.attachWrapper}>
              <button
                type="button"
                className={styles.composerAction}
                title={t("composer.attach")}
                onClick={() => {
                  if (onPickFromClaraOS) {
                    setPickerOpen((o) => !o);
                  } else {
                    fileInputRef.current?.click();
                  }
                }}
              >
                <PaperclipIcon size={16} />
              </button>
              {pickerOpen && (
                <div className={styles.attachMenu} role="menu">
                  {currentObjectName && onAttachCurrentObject && (
                    <button
                      type="button"
                      className={`${styles.attachMenuItem} ${styles.attachMenuItemPrimary}`}
                      onClick={() => {
                        setPickerOpen(false);
                        onAttachCurrentObject();
                      }}
                    >
                      📌 {t("composer.attachCurrent", { name: currentObjectName })}
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.attachMenuItem}
                    onClick={() => {
                      setPickerOpen(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    {t("composer.uploadFromDevice")}
                  </button>
                  {onPickFromClaraOS && (
                    <button
                      type="button"
                      className={styles.attachMenuItem}
                      onClick={() => {
                        setPickerOpen(false);
                        onPickFromClaraOS();
                      }}
                    >
                      {t("composer.fromProductFiles")}
                    </button>
                  )}
                </div>
              )}
            </div>
            {onTogglePicking && (
              <button
                type="button"
                className={`${styles.composerAction} ${markerPicking ? styles.composerActionActive : ""}`}
                title={markerPicking ? t("composer.markCancel") : t("composer.markArea")}
                onClick={onTogglePicking}
                disabled={transcribing}
              >
                <PinIcon size={16} />
              </button>
            )}
          </div>
          <div className={styles.composerRight}>
            {!hideVoiceButtons && (
              <button
                type="button"
                className={`${styles.composerAction} ${recording ? styles.composerActionActive : ""}`}
                title={recording ? t("composer.stopRecording") : t("composer.dictate")}
                onClick={recording ? stopRecording : startRecording}
                disabled={transcribing || voiceMode}
              >
                {recording ? <StopIcon size={16} /> : <MicIcon size={16} />}
              </button>
            )}
            {toggleVoiceMode && !hideVoiceButtons && (
              <button
                type="button"
                className={`${styles.composerAction} ${voiceMode ? styles.composerActionActive : ""}`}
                title={voiceMode ? t("composer.voiceModeEnd") : t("composer.voiceModeStart")}
                onClick={toggleVoiceMode}
                disabled={liveMode || liveConnecting}
              >
                <AudioLinesIcon size={16} />
              </button>
            )}
            {toggleLiveMode && !hideVoiceButtons && (
              <button
                type="button"
                className={`${styles.composerAction} ${liveMode ? styles.composerActionActive : ""}`}
                title={
                  liveMode
                    ? t("composer.liveEnd")
                    : t("composer.liveStartTitle")
                }
                onClick={toggleLiveMode}
                disabled={voiceMode || recording || transcribing}
              >
                <LiveVoiceIcon size={16} />
              </button>
            )}
            {streaming ? (
              <button
                type="button"
                className={styles.composerStop}
                onClick={onAbort}
                title={t("composer.stop")}
              >
                <StopIcon size={14} />
              </button>
            ) : hasContent ? (
              <button
                type="button"
                className={styles.composerSend}
                onClick={send}
                disabled={transcribing || recording}
                title={t("composer.send")}
              >
                <SendIcon size={16} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
