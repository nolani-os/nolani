/**
 * SubAgentCard — collapsed summary of a completed sub-agent run.
 *
 * Shown after `activity.phase === "done"` for each entry in
 * `activity.completedSubAgents`. Default: collapsed (one-liner). Click
 * toggles to show the tool-call list with short result summaries.
 */
import { useState } from "react";
import type { ClaraSubAgentSummary, ClaraToolCall } from "./api";
import { useTranslation } from "@claraos/core";
import styles from "./SubAgentCard.module.css";

function shortName(toolName: string): string {
  const parts = toolName.split("_");
  return parts.length <= 2 ? toolName : parts.slice(1).join("_");
}

function formatMs(ms?: number): string {
  if (!ms || ms < 0) return "";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  return `${Math.round(s)} s`;
}

interface SubAgentCardProps {
  index: number;
  summary: ClaraSubAgentSummary;
  /** Tool calls from activity.toolCalls, filtered to summary.subId. */
  tools?: ClaraToolCall[];
  defaultOpen?: boolean;
}

export function SubAgentCard({ index, summary, tools = [], defaultOpen = false }: SubAgentCardProps) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(defaultOpen);
  const modelShort = summary.model?.split("/").pop();
  const toolCount = tools.length || summary.toolsCalled.length;
  return (
    <div
      className={styles.card}
      data-claraos-subagent-card
      data-sub-id={summary.subId}
    >
      <div className={styles.header} onClick={() => setOpen((o) => !o)}>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}>
          ▸
        </span>
        <span className={styles.title}>
          {t("subAgent.title", { number: index + 1 })} · {summary.intent}
          {modelShort ? ` · ${modelShort}` : ""}
        </span>
        <span className={styles.meta}>
          {t("subAgent.tools", { count: toolCount })}
          {summary.durationMs ? ` · ${formatMs(summary.durationMs)}` : ""}
        </span>
      </div>
      {open && (
        <div className={styles.body}>
          {summary.summary && (
            <div className={styles.summary}>{summary.summary}</div>
          )}
          {tools.length > 0
            ? tools.map((tc, i) => (
                <div key={tc.id || `${tc.name}-${i}`} className={styles.toolItem}>
                  <span className={styles.icon}>{tc.icon ?? "🔧"}</span>
                  <span className={styles.name}>{shortName(tc.name)}</span>
                  <span className={styles.arrow}>→</span>
                  <span
                    className={`${styles.result} ${
                      tc.ok ? "" : styles.resultErr
                    }`}
                    title={tc.resultSummary ?? ""}
                  >
                    {tc.resultSummary ??
                      (tc.ok ? t("subAgent.ok") : t("subAgent.error"))}
                  </span>
                </div>
              ))
            : summary.toolsCalled.map((name, i) => (
                <div key={`${name}-${i}`} className={styles.toolItem}>
                  <span className={styles.icon}>🔧</span>
                  <span className={styles.name}>{shortName(name)}</span>
                </div>
              ))}
        </div>
      )}
    </div>
  );
}
