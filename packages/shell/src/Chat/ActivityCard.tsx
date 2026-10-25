/**
 * ActivityCard — live indicator under the streaming assistant message.
 *
 * Shows ONLY the current action (current sub-agent + current tool +
 * elapsed-seconds counter). History collapses into separate SubAgentCards
 * once the activity finishes.
 *
 * Also tracks parallel agents and tools.
 */
import { i18n, useTranslation } from "@claraos/core";
import { useEffect, useState } from "react";
import type { ClaraActivity } from "./api";
import styles from "./ActivityCard.module.css";
import { statusFertig, statusLaeuft } from "./toolStatus";

// Getters: the assistant can be renamed and the language switched at runtime.
const PHASE_LABELS: Record<ClaraActivity["phase"], string> = {
  get thinking() { return i18n.t("chat:activity.thinking"); },
  get planning() { return i18n.t("chat:activity.planning"); },
  get executing() { return i18n.t("chat:activity.executing"); },
  get finalizing() { return i18n.t("chat:activity.finalizing"); },
  get done() { return i18n.t("chat:activity.done"); },
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
  const { t } = useTranslation("chat");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (activity.phase === "done") return;
    const timer = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [activity.phase]);

  const elapsedMs =
    (activity.finishedAt ?? Date.now()) - (activity.startedAt ?? Date.now());

  const phase = activity.phase;
  const label = PHASE_LABELS[phase] ?? t("activity.executing");

  // Track parallel agents + tools (multi-intent splits).
  const agents = Object.values(activity.activeAgents ?? {});
  const tools = Object.values(activity.activeTools ?? {});
  const completedCount = activity.completedSubAgents.length;

  // Sub-agent line — show count if multiple in-flight, else show the one.
  let subAgentLine: string | null = null;
  if (agents.length === 1) {
    const a = agents[0];
    const m = a.model?.split("/").pop();
    subAgentLine = `${t("activity.subAgent", { name: a.intent ?? a.agent })}${m ? ` · ${m}` : ""}`;
  } else if (agents.length > 1) {
    subAgentLine = `${t("activity.subAgentsParallel", { count: agents.length })}${
      completedCount ? ` · ${t("activity.doneCount", { count: completedCount })}` : ""
    }`;
  } else if (completedCount > 0 && phase !== "done") {
    subAgentLine = t("activity.subAgentsDone", { count: completedCount });
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
  for (const tool of tools.slice(0, 3)) {
    activeLines.push({
      icon: tool.icon ?? "🔧",
      label: statusLaeuft(tool.name, tool.argsSummary),
      sinceMs: Date.now() - tool.startedAt,
    });
  }
  const moreTools = Math.max(0, tools.length - 3);

  // The last two finished steps stay visible while Clara works ("Termin
  // angelegt ✓"), so progress reads like a short log instead of blinking past.
  if (phase !== "done") {
    const recent = activity.toolCalls.filter((tc) => tc.endedAt).slice(-2);
    for (const tc of recent) {
      activeLines.push({
        icon: tc.ok ? "✓" : "⚠",
        label: statusFertig(tc.name, tc.ok),
        sinceMs: tc.durationMs ?? 0,
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
          <span className={styles.label}>{t("activity.moreTools", { count: moreTools })}</span>
        </div>
      )}
      {langLaeufer && (
        <div className={styles.slowNotice}>{t("activity.slow")}</div>
      )}
      {activity.slowNotice && (
        <div className={styles.slowNotice}>{activity.slowNotice}</div>
      )}
      {activity.todoList && activity.todoList.length > 0 && (
        <div className={styles.todoBox}>
          <div className={styles.todoTitle}>📋 {t("activity.plan")}</div>
          {activity.todoList.map((todo) => (
            <div key={todo.id} className={`${styles.todoItem} ${styles[`todo_${todo.status}`] ?? ""}`}>
              <span className={styles.todoIcon}>
                {todo.status === "completed" ? "✅" : todo.status === "in_progress" ? "🔄" : "⏳"}
              </span>
              <span className={styles.todoText}>{todo.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
