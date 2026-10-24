/**
 * ActivityCard — live indicator under the streaming assistant message.
 *
 * Shows ONLY the current action (current sub-agent + current tool +
 * elapsed-seconds counter). History collapses into separate SubAgentCards
 * once the activity finishes.
 *
 * Also tracks parallel agents and tools.
 */
import { getBrand } from "@claraos/core";
import { useEffect, useState } from "react";
import type { ClaraActivity } from "./api";
import styles from "./ActivityCard.module.css";
import { statusFertig, statusLaeuft } from "./toolStatus";

// Getters: the assistant can be renamed at runtime.
const PHASE_LABELS: Record<ClaraActivity["phase"], string> = {
  get thinking() { return `${getBrand().assistant} denkt nach …`; },
  get planning() { return `${getBrand().assistant} plant Schritte …`; },
  get executing() { return `${getBrand().assistant} arbeitet …`; },
  get finalizing() { return `${getBrand().assistant} formuliert die Antwort …`; },
  done: "Fertig",
};

function formatTimer(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return mm > 0 ? `${mm}:${String(ss).padStart(2, "0")}` : `${ss}s`;
}

export function ActivityCard({ activity }: { activity: ClaraActivity }) {
  // Tick every 500 ms so the elapsed-seconds counter updates without re-
  // rendering on every message-chunk.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (activity.phase === "done") return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [activity.phase]);

  const elapsedMs =
    (activity.finishedAt ?? Date.now()) - (activity.startedAt ?? Date.now());

  const phase = activity.phase;
  const label = PHASE_LABELS[phase] ?? `${getBrand().assistant} arbeitet …`;

  // Track parallel agents + tools (multi-intent splits).
  const agents = Object.values(activity.activeAgents ?? {});
  const tools = Object.values(activity.activeTools ?? {});
  const completedCount = activity.completedSubAgents.length;

  // Sub-agent line — show count if multiple in-flight, else show the one.
  let subAgentLine: string | null = null;
  if (agents.length === 1) {
    const a = agents[0];
    const m = a.model?.split("/").pop();
    subAgentLine = `Sub-Agent: ${a.intent ?? a.agent}${m ? ` · ${m}` : ""}`;
  } else if (agents.length > 1) {
    subAgentLine = `${agents.length} Sub-Agents parallel${
      completedCount ? ` · ${completedCount} fertig` : ""
    }`;
  } else if (completedCount > 0 && phase !== "done") {
    subAgentLine = `${completedCount} Sub-Agent${completedCount === 1 ? "" : "s"} fertig`;
  }

  // Active-tools line — render up to 3 currently-running tools, plus a
  // "+N more" counter if there are more. If no tools are active right now
  // BUT a recent tool just finished (< 2 s ago), still show it briefly so
  // very fast tool-calls remain visible to the user.
  const activeLines: { icon: string; label: string; sinceMs: number; done?: boolean }[] = [];
  if (activity.activeMeta) {
    activeLines.push({
      icon: "🧠",
      label: `Meta-Platform: domain=${activity.activeMeta.domain}${
        activity.activeMeta.taskSummary ? ` · ${activity.activeMeta.taskSummary}` : ""
      }`,
      sinceMs: Date.now() - activity.activeMeta.startedAt,
    });
  }
  for (const t of tools.slice(0, 3)) {
    activeLines.push({
      icon: t.icon ?? "🔧",
      label: statusLaeuft(t.name, t.argsSummary),
      sinceMs: Date.now() - t.startedAt,
    });
  }
  const moreTools = Math.max(0, tools.length - 3);

  // The last two finished steps stay visible while Clara works ("Termin
  // angelegt ✓"), so progress reads like a short log instead of blinking past.
  if (phase !== "done") {
    const recent = activity.toolCalls.filter((tc) => tc.endedAt).slice(-2);
    for (const t of recent) {
      activeLines.push({
        icon: t.ok ? "✓" : "⚠",
        label: statusFertig(t.name, t.ok),
        sinceMs: t.durationMs ?? 0,
        done: true,
      });
    }
  }
  // Long runs: say early that leaving is safe — the answer is stored
  // server-side even if this window closes.
  const langLaeufer = phase !== "done" && !activity.slowNotice && elapsedMs > 20_000;

  return (
    <div className={styles.card} data-claraos-activity-card data-phase={phase}>
      <div className={styles.headerRow}>
        <span className={styles.spinner} aria-hidden="true" />
        <span className={styles.phaseLabel}>{label}</span>
        <span className={styles.timer}>{formatTimer(elapsedMs)}</span>
      </div>
      {subAgentLine && (
        <div className={styles.subRow}>
          <span className={styles.icon}>↳</span>
          <span className={styles.label}>{subAgentLine}</span>
        </div>
      )}
      {activeLines.map((line, i) => (
        <div key={i} className={`${styles.subRow} ${line.done ? styles.subRowDone : ""}`}>
          <span className={styles.icon}>{line.icon}</span>
          <span className={styles.label}>{line.label}</span>
          <span className={styles.duration}>{formatTimer(line.sinceMs)}</span>
        </div>
      ))}
      {moreTools > 0 && (
        <div className={styles.subRow}>
          <span className={styles.icon}>…</span>
          <span className={styles.label}>+{moreTools} weitere Tools laufen</span>
        </div>
      )}
      {langLaeufer && (
        <div className={styles.slowNotice}>{getBrand().assistant} arbeitet noch. Du kannst den Chat schließen, die Antwort wird gespeichert.</div>
      )}
      {activity.slowNotice && (
        <div className={styles.slowNotice}>{activity.slowNotice}</div>
      )}
      {activity.todoList && activity.todoList.length > 0 && (
        <div className={styles.todoBox}>
          <div className={styles.todoTitle}>📋 Plan</div>
          {activity.todoList.map((t) => (
            <div key={t.id} className={`${styles.todoItem} ${styles[`todo_${t.status}`] ?? ""}`}>
              <span className={styles.todoIcon}>
                {t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳"}
              </span>
              <span className={styles.todoText}>{t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
