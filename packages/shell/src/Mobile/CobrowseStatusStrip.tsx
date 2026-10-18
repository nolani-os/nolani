/**
 * CobrowseStatusStrip — glass pill over the cobrowse app view that narrates
 * what Clara is doing right now ("Clara: adding 12 photos …"). Fed by the
 * same claraos_event activity the ActivityCard renders in the chat below;
 * this is deliberately a featherweight strip (no todos, timers, sub-agents).
 */
import { useEffect, useState } from "react";
import type { ClaraActivity } from "../Chat/api";
import styles from "./ClaraOverlay.module.css";

const PHASE_LABEL: Record<string, string> = {
  thinking: "Clara denkt nach …",
  planning: "Clara plant Schritte …",
  executing: "Clara arbeitet …",
  finalizing: "Clara formuliert die Antwort …",
};

function shortToolName(name: string): string {
  // claraos_modules_media_immich__search → search; immich_create_album → create_album
  const bridged = name.split("__")[1];
  const base = bridged ?? name.replace(/^[a-z0-9]+_/, "");
  return base.replace(/_/g, " ");
}

export function CobrowseStatusStrip({ activity }: { activity: ClaraActivity | null }) {
  const done = !activity || activity.phase === "done";
  // keep the pill visible for a beat after done, then fade (CSS transition)
  const [hidden, setHidden] = useState(done);
  useEffect(() => {
    if (!done) {
      setHidden(false);
      return;
    }
    const t = window.setTimeout(() => setHidden(true), 3000);
    return () => window.clearTimeout(t);
  }, [done]);

  if (hidden) return null;

  let text: string;
  let icon: string | undefined;
  if (done) {
    text = "✓ Fertig";
  } else {
    const tools = Object.values(activity.activeTools);
    const newest = tools.reduce<(typeof tools)[number] | null>(
      (a, t) => (!a || t.startedAt > a.startedAt ? t : a),
      null,
    );
    if (newest) {
      icon = newest.icon;
      text = `Clara: ${newest.argsSummary || shortToolName(newest.name)}`;
    } else {
      text = PHASE_LABEL[activity.phase] ?? "Clara arbeitet …";
    }
  }

  return (
    <div className={`${styles.statusStrip} ${done ? styles.statusStripDone : ""}`} data-testid="cobrowse-strip">
      {!done && <span className={styles.statusStripDot} />}
      <span className={styles.statusStripText}>
        {icon ? `${icon} ` : ""}
        {text}
      </span>
    </div>
  );
}
