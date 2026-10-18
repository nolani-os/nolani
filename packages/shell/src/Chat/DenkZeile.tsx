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
import styles from "./DenkZeile.module.css";
import { statusFertig, statusLaeuft } from "./toolStatus";

const PHASE: Record<string, string> = {
  thinking: "Denkt nach",
  planning: "Plant",
  executing: "Arbeitet",
  finalizing: "Formuliert",
  done: "Fertig",
};

function sekunden(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min` : `${s} s`;
}

export function DenkZeile({ activity, children }: { activity: ClaraActivity; children?: ReactNode }) {
  const [offen, setOffen] = useState(false);
  const [, setTick] = useState(0);
  const laeuft = activity.phase !== "done";
  useEffect(() => {
    if (!laeuft) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [laeuft]);

  const dauer = (activity.finishedAt ?? Date.now()) - (activity.startedAt ?? Date.now());
  const tools = Object.values(activity.activeTools ?? {});
  const aktuell = tools[tools.length - 1];
  const anzahl = (activity.toolCalls ?? []).length;
  const zuletzt = (activity.toolCalls ?? []).filter((t) => t.endedAt).slice(-1)[0];
  const schritt = aktuell
    ? `${aktuell.icon ? `${aktuell.icon} ` : ""}${statusLaeuft(aktuell.name, aktuell.argsSummary)}`
    : zuletzt ? statusFertig(zuletzt.name, zuletzt.ok) : PHASE[activity.phase] || "Arbeitet";
  const text = laeuft
    ? `${schritt} · ${sekunden(dauer)}`
    : `${anzahl ? `${anzahl} Werkzeug${anzahl === 1 ? "" : "e"} · ` : ""}${sekunden(dauer)}`;

  return (
    <div className={styles.wrap} data-phase={activity.phase}>
      <button
        type="button"
        className={styles.zeile}
        onClick={() => setOffen((o) => !o)}
        aria-expanded={offen}
        title={offen ? "Schritte ausblenden" : "Schritte ansehen"}
      >
        <span className={`${styles.punkt} ${laeuft ? styles.punktAktiv : ""}`} aria-hidden="true" />
        <span className={styles.text}>{text}</span>
        <span className={styles.pfeil} aria-hidden="true">{offen ? "▾" : "▸"}</span>
      </button>
      {offen && <div className={styles.details}>{children}</div>}
    </div>
  );
}
