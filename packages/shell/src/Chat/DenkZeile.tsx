/**
 * DenkZeile ("thinking line") — Clara is working, but quietly.
 *
 * On phones a single line replaces the large activity card in the flow: phase,
 * current tool, seconds. When done it collapses to "3 tools · 12 s ▸";
 * a tap expands the full card (tools, sub-agents, todos).
 * Similar to Gemini's "See thinking steps" in a menu instead of in the flow,
 * or OpenClaw's "Ran 13 commands".
 */
import { useEffect, useState, type ReactNode } from "react";
import type { ClaraActivity } from "./api";
import { i18n, useTranslation } from "@claraos/core";
import styles from "./DenkZeile.module.css";
import { statusFertig, statusLaeuft } from "./toolStatus";

const PHASES = new Set(["thinking", "planning", "executing", "finalizing", "done"]);

/** Short phase label, read at render time so a language switch applies. */
function phaseLabel(phase: string): string {
  return i18n.t(`chat:thinkingLine.phase.${PHASES.has(phase) ? phase : "executing"}`);
}

function sekunden(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60
    ? i18n.t("chat:thinkingLine.minutes", { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` })
    : i18n.t("chat:thinkingLine.seconds", { count: s });
}

export function DenkZeile({ activity, children }: { activity: ClaraActivity; children?: ReactNode }) {
  const { t } = useTranslation("chat");
  const [offen, setOffen] = useState(false);
  const [, setTick] = useState(0);
  const laeuft = activity.phase !== "done";
  useEffect(() => {
    if (!laeuft) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(timer);
  }, [laeuft]);

  const dauer = (activity.finishedAt ?? Date.now()) - (activity.startedAt ?? Date.now());
  const tools = Object.values(activity.activeTools ?? {});
  const aktuell = tools[tools.length - 1];
  const anzahl = (activity.toolCalls ?? []).length;
  const zuletzt = (activity.toolCalls ?? []).filter((tc) => tc.endedAt).slice(-1)[0];
  const schritt = aktuell
    ? `${aktuell.icon ? `${aktuell.icon} ` : ""}${statusLaeuft(aktuell.name, aktuell.argsSummary)}`
    : zuletzt ? statusFertig(zuletzt.name, zuletzt.ok) : phaseLabel(activity.phase);
  const text = laeuft
    ? `${schritt} · ${sekunden(dauer)}`
    : `${anzahl ? `${t("thinkingLine.tools", { count: anzahl })} · ` : ""}${sekunden(dauer)}`;

  return (
    <div className={styles.wrap} data-phase={activity.phase}>
      <button
        type="button"
        className={styles.zeile}
        onClick={() => setOffen((o) => !o)}
        aria-expanded={offen}
        title={offen ? t("thinkingLine.hideSteps") : t("thinkingLine.showSteps")}
      >
        <span className={`${styles.punkt} ${laeuft ? styles.punktAktiv : ""}`} aria-hidden="true" />
        <span className={styles.text}>{text}</span>
        <span className={styles.pfeil} aria-hidden="true">{offen ? "▾" : "▸"}</span>
      </button>
      {offen && <div className={styles.details}>{children}</div>}
    </div>
  );
}
