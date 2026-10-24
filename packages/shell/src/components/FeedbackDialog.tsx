/**
 * Feedback dialog — passive submission path for user feedback.
 *
 * Opened via the CustomEvent "claraos-open-feedback" (detail: { source?,
 * appId? }) — senders are the start menu footer (desktop), the quick settings
 * tile (mobile) and the satisfaction nudge. The active app is preselected as
 * context (can be deselected). Submitting goes to
 * POST /api/claraos/feedback → the configured feedback inbox.
 *
 * Dictation: VoiceRecorderSession from the Clara chat (same STT chain,
 * POST /api/claraos/chat/v2/audio/transcribe). Annotate: fullscreen capture
 * (lib/screenshots) → MarkerOverlay (markerjs, own callback instead of
 * useMarkerStore — otherwise the pin slot collides with the Clara chat chip) →
 * annotated PNG as attachment_b64 on the conversation.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation, useWindowsStore } from "@claraos/core";
import { VoiceRecorderSession } from "../Chat/useVoiceRecorder";
import { captureToDataUrl } from "../lib/screenshots";
import MarkerOverlay from "../Marker/MarkerOverlay";
import styles from "./FeedbackDialog.module.css";

/** Labels: "components" catalog, `feedback.category.<id>`. */
const CATEGORIES = [
  { id: "bug", icon: "🐞" },
  { id: "idee", icon: "💡" },
  { id: "kritik", icon: "😕" },
  { id: "lob", icon: "💚" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

interface OpenDetail {
  source?: string;
  appId?: string;
}

export function openFeedbackDialog(detail: OpenDetail = {}) {
  window.dispatchEvent(new CustomEvent("claraos-open-feedback", { detail }));
}

export function FeedbackDialogHost() {
  const [open, setOpen] = useState<OpenDetail | null>(null);
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [text, setText] = useState("");
  const [appCtx, setAppCtx] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  // Dictation
  const [recState, setRecState] = useState<"idle" | "arming" | "recording" | "transcribing">("idle");
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const sessionRef = useRef<VoiceRecorderSession | null>(null);
  const baseTextRef = useRef("");
  // Annotate
  const [phase, setPhase] = useState<"form" | "capturing" | "annotate">("form");
  const [shotBlob, setShotBlob] = useState<Blob | null>(null);
  const [attachment, setAttachment] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation("components");

  const stopDictation = useCallback(() => {
    sessionRef.current?.stop();
  }, []);

  const disposeDictation = useCallback(() => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setRecState("idle");
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = ((e as CustomEvent).detail ?? {}) as OpenDetail;
      const { focusedWindowId, windows } = useWindowsStore.getState();
      const activeApp =
        detail.appId ?? (focusedWindowId ? windows[focusedWindowId]?.appId : undefined);
      setOpen(detail);
      setCategory(null);
      setText("");
      setAppCtx(activeApp ?? "");
      setStatus("idle");
      setPhase("form");
      setShotBlob(null);
      setAttachment(null);
      setVoiceErr(null);
    };
    window.addEventListener("claraos-open-feedback", onOpen);
    return () => window.removeEventListener("claraos-open-feedback", onOpen);
  }, []);

  const close = useCallback(() => {
    if (status === "sending") return;
    disposeDictation();
    setOpen(null);
  }, [status, disposeDictation]);

  useEffect(() => {
    if (!open || phase !== "form") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, phase, close]);

  // Do not leave an open recording behind on unmount
  useEffect(() => () => disposeDictation(), [disposeDictation]);

  const startDictation = useCallback(async () => {
    if (sessionRef.current) return;
    setVoiceErr(null);
    baseTextRef.current = text.length && !text.endsWith(" ") ? text + " " : text;
    const session = new VoiceRecorderSession(
      {
        onState: (s) => {
          if (sessionRef.current !== session) return;
          setRecState(s === "stopped" ? "transcribing" : s);
        },
        onLevel: () => undefined,
        onInterim: (t) => {
          if (sessionRef.current !== session) return;
          setText(baseTextRef.current + t);
        },
        onFinal: (t, { hadSpeech }) => {
          if (sessionRef.current !== session) return;
          sessionRef.current = null;
          setRecState("idle");
          setText(hadSpeech && t ? baseTextRef.current + t + " " : baseTextRef.current);
          textRef.current?.focus();
        },
        onError: (msg) => {
          if (sessionRef.current === session) sessionRef.current = null;
          setRecState("idle");
          setVoiceErr(msg);
        },
      },
      { language: "de" },
    );
    sessionRef.current = session;
    await session.start();
  }, [text]);

  // Annotate: remove the dialog from the DOM → wait 2 frames → fullscreen capture
  useEffect(() => {
    if (phase !== "capturing") return;
    let cancelled = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(async () => {
        try {
          const dataUrl = await captureToDataUrl(document.body, { maxSize: 2200 });
          if (cancelled) return;
          if (!dataUrl) {
            setPhase("form");
            setVoiceErr(t("feedback.captureFailed"));
            return;
          }
          const blob = await (await fetch(dataUrl)).blob();
          if (cancelled) return;
          setShotBlob(blob);
          setPhase("annotate");
        } catch {
          if (!cancelled) {
            setPhase("form");
            setVoiceErr(t("feedback.captureFailed"));
          }
        }
      }),
    );
    return () => { cancelled = true; };
  }, [phase, t]);

  const send = useCallback(async () => {
    if (!category || text.trim().length < 3 || status === "sending") return;
    stopDictation();
    setStatus("sending");
    try {
      const r = await fetch("/api/claraos/feedback", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          text: text.trim(),
          app_context: appCtx || null,
          source: open?.source ?? "dialog",
          attachment_b64: attachment,
        }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setStatus("done");
      window.setTimeout(() => setOpen(null), 1800);
    } catch {
      setStatus("error");
    }
  }, [category, text, appCtx, status, open, attachment, stopDictation]);

  if (!open) return null;

  // Completely out of the DOM during the screen capture (otherwise the
  // dialog itself would be in the screenshot).
  if (phase === "capturing") return null;

  if (phase === "annotate" && shotBlob) {
    return (
      <MarkerOverlay
        imageBlob={shotBlob}
        onConfirm={(annotatedDataUrl) => {
          const b64 = annotatedDataUrl.split(",", 2)[1] ?? "";
          setAttachment(b64 || null);
          setShotBlob(null);
          setPhase("form");
        }}
        onCancel={() => {
          setShotBlob(null);
          setPhase("form");
        }}
      />
    );
  }

  return (
    <div className={styles.overlay} onClick={close}>
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={t("feedback.title")}
        data-testid="feedback-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        {status === "done" ? (
          <div className={styles.doneBox} data-testid="feedback-done">
            <div className={styles.doneIcon}>💌</div>
            <div className={styles.doneText}>
              {t("feedback.done")}
            </div>
          </div>
        ) : (
          <>
            <div className={styles.title}>{t("feedback.title")}</div>
            <div className={styles.subtitle}>{t("feedback.subtitle")}</div>
            <div className={styles.cats}>
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={category === c.id ? styles.catActive : styles.cat}
                  data-testid={`feedback-cat-${c.id}`}
                  onClick={() => setCategory(c.id)}
                >
                  <span aria-hidden="true">{c.icon}</span> {t(`feedback.category.${c.id}`)}
                </button>
              ))}
            </div>
            <textarea
              ref={textRef}
              className={styles.text}
              data-testid="feedback-text"
              placeholder={
                recState === "recording" ? t("feedback.placeholderListening") : t("feedback.placeholder")
              }
              rows={4}
              maxLength={4000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className={styles.tools}>
              <button
                type="button"
                className={recState === "idle" ? styles.toolBtn : styles.toolBtnActive}
                data-testid="feedback-mic"
                title={recState === "idle" ? t("feedback.dictateTitle") : t("feedback.stopRecordingTitle")}
                disabled={recState === "transcribing"}
                onClick={() => {
                  if (recState === "idle") void startDictation();
                  else stopDictation();
                }}
              >
                {recState === "idle" ? t("feedback.dictate")
                  : recState === "transcribing" ? t("feedback.transcribing")
                  : t("feedback.stop")}
              </button>
              <button
                type="button"
                className={styles.toolBtn}
                data-testid="feedback-marker"
                title={t("feedback.markTitle")}
                onClick={() => {
                  stopDictation();
                  setPhase("capturing");
                }}
              >
                {t("feedback.mark")}
              </button>
            </div>
            {attachment && (
              <div className={styles.attach} data-testid="feedback-attach">
                <img
                  className={styles.attachThumb}
                  src={`data:image/png;base64,${attachment}`}
                  alt={t("feedback.attachmentAlt")}
                />
                <span className={styles.attachLabel}>{t("feedback.attachmentLabel")}</span>
                <button
                  type="button"
                  className={styles.ctxClear}
                  title={t("feedback.removeAttachment")}
                  data-testid="feedback-attach-remove"
                  onClick={() => setAttachment(null)}
                >
                  ✕
                </button>
              </div>
            )}
            {appCtx && (
              <div className={styles.ctx}>
                {t("feedback.concerns")} <b>{appCtx}</b>
                <button
                  type="button"
                  className={styles.ctxClear}
                  title={t("feedback.removeAppContext")}
                  onClick={() => setAppCtx("")}
                >
                  ✕
                </button>
              </div>
            )}
            {voiceErr && <div className={styles.error}>{voiceErr}</div>}
            {status === "error" && (
              <div className={styles.error} data-testid="feedback-error">
                {t("feedback.sendFailed")}
              </div>
            )}
            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={close}
                      data-testid="feedback-cancel">
                {t("feedback.cancel")}
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                data-testid="feedback-send"
                disabled={!category || text.trim().length < 3 || status === "sending"}
                onClick={() => void send()}
              >
                {status === "sending" ? t("feedback.sending") : t("feedback.send")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
