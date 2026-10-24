/**
 * MessageList — renders a stream of WebUI chat messages.
 * Handles auto-scroll to bottom on new content.
 *
 * Clara's replies are rendered as Markdown (an article instead of raw text),
 * day separators instead of a timestamp per message, and an action bar with
 * copy · read aloud · retry · share — always visible on phones, because
 * there is no hover there.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import ClaraMark from "../Mobile/clara-c.svg?react";
import { WindowContextMenu, type ContextMenuItem } from "../components/WindowContextMenu";
import { speak, type WebUIMessage } from "./api";
import { ActivityCard } from "./ActivityCard";
import { NavActionCards } from "./NavActionCards";
import { SubAgentCard } from "./SubAgentCard";
import { PlanCard } from "./PlanCard";
import { QuestionCard } from "./QuestionCard";
import { Markdown } from "./Markdown";
import { BlockRenderer } from "./blocks/BlockRenderer";
import { DenkZeile } from "./DenkZeile";
import styles from "./ClaraChatPanel.module.css";
import { regionLocale, getBrand } from "@claraos/core";

/**
 * Strip leading/trailing `<think>...</think>` blocks defensively. Backend
 * stopped emitting them, but Sonnet itself sometimes wraps its
 * own reasoning in `<think>` — we hide those from the user content area.
 */
const THINK_RE = /<think>[\s\S]*?<\/think>/g;
const CLARAEV_RE = /\|\|\|CLARAEV\|\|\|[\s\S]*?\|\|\|\/CLARAEV\|\|\|/g;
function cleanContent(s: string): string {
  return s
    .replace(CLARAEV_RE, "")
    .replace(THINK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}

/** Normalize timestamps: WebUI delivers seconds, the hook milliseconds. */
function toMs(ts?: number): number | null {
  if (!ts || !Number.isFinite(ts)) return null;
  return ts < 1e12 ? ts * 1000 : ts;
}

function tagLabel(ms: number): string {
  const d = new Date(ms);
  const heute = new Date();
  const gestern = new Date(heute);
  gestern.setDate(heute.getDate() - 1);
  const gleich = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (gleich(d, heute)) return "Heute";
  if (gleich(d, gestern)) return "Gestern";
  return d.toLocaleDateString(regionLocale(), { weekday: "long", day: "numeric", month: "long" });
}

function tagKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// One reader for the whole list: a second tap stops the first.
let aktuellesAudio: HTMLAudioElement | null = null;
function vorlesenStoppen() {
  if (aktuellesAudio) {
    aktuellesAudio.pause();
    aktuellesAudio = null;
  }
}

/** Strip Markdown characters for reading aloud and sharing — crude, but audibly better. */
function nurText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " (Code) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\|/g, " ")
    .trim();
}

interface Props {
  messages: WebUIMessage[];
  streaming?: boolean;
  emptyHint?: React.ReactNode;
  /** Re-send the given user prompt (shown as "Nochmal" under the last answer). */
  onRetry?: (text: string) => void;
  /** Phone: activity as a thinking line instead of a large card. */
  kompakt?: boolean;
  /** Follow-up chip tapped → send. */
  onFollowup?: (text: string) => void;
}

export function MessageList({ messages, streaming, emptyHint, onRetry, kompakt, onFollowup }: Props) {
  const [quellenOffen, setQuellenOffen] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [liest, setLiest] = useState<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Reading aloud ends with the list (sheet closed, chat switched).
  useEffect(() => () => vorlesenStoppen(), []);

  const vorlesen = async (i: number, text: string) => {
    if (liest === i) {
      vorlesenStoppen();
      setLiest(null);
      return;
    }
    vorlesenStoppen();
    setLiest(i);
    try {
      const blob = await speak(nurText(text).slice(0, 4000), { format: "wav" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      aktuellesAudio = audio;
      const zuEnde = () => {
        URL.revokeObjectURL(url);
        if (aktuellesAudio === audio) aktuellesAudio = null;
        setLiest((cur) => (cur === i ? null : cur));
      };
      audio.onended = zuEnde;
      audio.onerror = () => zuEnde();
      await audio.play();
    } catch {
      setLiest(null);
    }
  };

  const teilen = async (text: string) => {
    const t = nurText(text);
    try {
      if (navigator.share) {
        await navigator.share({ text: t });
        return;
      }
    } catch {
      /* aborted */
      return;
    }
    navigator.clipboard?.writeText(t).catch(() => undefined);
  };

  if (messages.length === 0) {
    return (
      <div className={styles.messages} ref={scrollRef}>
        {emptyHint ?? (
          <div className={styles.welcome}>
            <div className={styles.welcomeIcon}><ClaraMark className={styles.welcomeMark} /></div>
            <h3>Hallo! Ich bin {getBrand().assistant}.</h3>
            <p>Wie kann ich dir helfen?</p>
          </div>
        )}
      </div>
    );
  }

  let letzterTag: string | null = null;

  return (
    <div className={styles.messages} ref={scrollRef}>
      {messages.map((msg, i) => {
        const isLast = i === messages.length - 1;
        const showActivity =
          msg.role === "assistant" &&
          msg.activity &&
          msg.activity.phase !== "done";
        const showSubAgents =
          msg.role === "assistant" &&
          msg.activity &&
          msg.activity.completedSubAgents.length > 0;
        const cleaned = msg.role === "assistant" ? cleanContent(msg.content) : msg.content;
        const lastUserBefore = [...messages.slice(0, i)].reverse().find((m) => m.role === "user");
        const msgCtxItems: ContextMenuItem[] = [
          {
            id: "copy",
            label: "Nachricht kopieren",
            disabled: !cleaned,
            onSelect: () => { navigator.clipboard?.writeText(cleaned).catch(() => undefined); },
          },
          ...(msg.role === "assistant" && isLast && onRetry && lastUserBefore?.content
            ? [{ id: "retry", label: "Nochmal fragen", onSelect: () => onRetry(lastUserBefore.content) }]
            : []),
        ];

        // Day separator: only when the day changes (Gemini/WhatsApp pattern),
        // no timestamp per message.
        const ms = toMs(msg.timestamp);
        let trenner: React.ReactNode = null;
        if (ms) {
          const key = tagKey(ms);
          if (key !== letzterTag) {
            letzterTag = key;
            trenner = (
              <div className={styles.daySep} role="separator" aria-label={tagLabel(ms)}>
                <span>{tagLabel(ms)}</span>
              </div>
            );
          }
        }

        const fertig = !!cleaned && !(streaming && isLast);

        return (
          <Fragment key={msg.id ?? i}>
          {trenner}
          <WindowContextMenu items={msgCtxItems}>
          <div
            className={`${styles.msg} ${styles[`msg_${msg.role}`] ?? ""}`}
          >
            <div className={styles.msgRole}>
              {msg.role === "user" ? "Du" : msg.role === "assistant" ? getBrand().assistant : "System"}
            </div>
            <div className={`${styles.msgContent} ${msg.role === "assistant" ? styles.msgMd : ""}`}>
              {msg.role === "assistant" && cleaned ? (
                <Markdown text={cleaned} />
              ) : (
                cleaned ||
                (streaming && isLast && msg.role === "assistant" && !msg.activity
                  ? "…"
                  : "")
              )}
            </div>
            {msg.role === "assistant" && msg.blocks && msg.blocks.length > 0 && (
              <BlockRenderer blocks={msg.blocks} />
            )}
            {msg.role === "assistant" && msg.activity?.pendingPlan && (
              <PlanCard plan={msg.activity.pendingPlan} />
            )}
            {msg.role === "assistant" && msg.activity?.pendingQuestion && (
              <QuestionCard question={msg.activity.pendingQuestion} />
            )}
            {kompakt && msg.role === "assistant" && msg.activity && (msg.activity.phase !== "done" || (msg.activity.toolCalls ?? []).length > 0 || showSubAgents) ? (
              <DenkZeile activity={msg.activity}>
                {showActivity && <ActivityCard activity={msg.activity} />}
                {showSubAgents &&
                  msg.activity.completedSubAgents.map((sa, j) => (
                    <SubAgentCard
                      key={sa.subId || j}
                      index={j}
                      summary={sa}
                      tools={(msg.activity?.toolCalls ?? []).filter((tc) => tc.subId === sa.subId)}
                    />
                  ))}
                {msg.activity.phase === "done" && (msg.activity.toolCalls ?? []).length > 0 && (
                  <ul className={styles.werkzeugListe}>
                    {(msg.activity.toolCalls ?? []).slice(0, 12).map((tc, j) => (
                      <li key={j}>{tc.icon ? `${tc.icon} ` : ""}{tc.name.replace(/^claraos_modules_[a-z0-9]+_/, "").replace(/__/g, " › ").replace(/_/g, " ")}</li>
                    ))}
                  </ul>
                )}
              </DenkZeile>
            ) : (
              <>
                {showActivity && msg.activity && <ActivityCard activity={msg.activity} />}
                {showSubAgents &&
                  msg.activity?.completedSubAgents.map((sa, j) => (
                    <SubAgentCard
                      key={sa.subId || j}
                      index={j}
                      summary={sa}
                      tools={(msg.activity?.toolCalls ?? []).filter(
                        (tc) => tc.subId === sa.subId,
                      )}
                    />
                  ))}
              </>
            )}
            {msg.role === "assistant" && msg.activity?.phase === "done" && (
              <NavActionCards toolCalls={msg.activity.toolCalls} />
            )}
            {msg.role === "assistant" && fertig && msg.sources && msg.sources.length > 0 && (
              <div className={styles.quellen}>
                <button
                  type="button"
                  className={styles.quellenPille}
                  aria-expanded={quellenOffen === i}
                  onClick={() => setQuellenOffen((q) => (q === i ? null : i))}
                >
                  {msg.sources.length} {msg.sources.length === 1 ? "Quelle" : "Quellen"} {quellenOffen === i ? "▾" : "▸"}
                </button>
                {quellenOffen === i && (
                  <ol className={styles.quellenListe}>
                    {msg.sources.map((q, j) => (
                      <li key={j}>
                        <a href={q.url} target="_blank" rel="noopener noreferrer">{q.title || q.url}</a>
                        <span className={styles.quellenHost}>{(() => { try { return new URL(q.url).hostname.replace(/^www\./, ""); } catch { return ""; } })()}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
            {msg.files && msg.files.length > 0 && (
              <div className={styles.msgFiles}>
                {msg.files.map((f, j) => (
                  f.type === "image" && f.url ? (
                    <img key={j} className={styles.msgImg} src={f.url} alt={f.name ?? "Bild"} />
                  ) : (
                    <span key={j} className={styles.msgFile}>📎 {f.name ?? "Datei"}</span>
                  )
                ))}
              </div>
            )}
            {msg.role === "assistant" && fertig && (
              <div className={styles.msgActions}>
                <button
                  type="button"
                  className={styles.msgActionBtn}
                  title="Antwort kopieren"
                  onClick={() => {
                    navigator.clipboard?.writeText(cleaned).catch(() => undefined);
                  }}
                >
                  ⧉ Kopieren
                </button>
                <button
                  type="button"
                  className={`${styles.msgActionBtn} ${liest === i ? styles.msgActionBtnOn : ""}`}
                  title={liest === i ? "Vorlesen stoppen" : "Antwort vorlesen"}
                  aria-pressed={liest === i}
                  onClick={() => { void vorlesen(i, cleaned); }}
                >
                  {liest === i ? "■ Stopp" : "🔊 Vorlesen"}
                </button>
                {isLast && onRetry && lastUserBefore?.content && (
                  <button
                    type="button"
                    className={styles.msgActionBtn}
                    title="Frage erneut senden"
                    onClick={() => onRetry(lastUserBefore.content)}
                  >
                    ↻ Nochmal
                  </button>
                )}
                <button
                  type="button"
                  className={styles.msgActionBtn}
                  title="Antwort teilen"
                  onClick={() => { void teilen(cleaned); }}
                >
                  ↗ Teilen
                </button>
              </div>
            )}
            {msg.role === "assistant" && isLast && fertig && onFollowup && msg.suggestions && msg.suggestions.length > 0 && (
              <div className={styles.folgeChips} aria-label="Folgefragen">
                {msg.suggestions.slice(0, 3).map((f, j) => (
                  <button key={j} type="button" className={styles.folgeChip} onClick={() => onFollowup(f)}>
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
          </WindowContextMenu>
          </Fragment>
        );
      })}
    </div>
  );
}
