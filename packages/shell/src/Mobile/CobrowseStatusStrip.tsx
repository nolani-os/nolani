/**
 * CobrowseStatusStrip — glass pill over the cobrowse app view that narrates
 * what Clara is doing right now ("Clara: adding 12 photos …"). Fed by the
 * same claraos_event activity the ActivityCard renders in the chat below;
 * this is deliberately a featherweight strip (no todos, timers, sub-agents).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "@claraos/core";
import type { ClaraActivity } from "../Chat/api";
import styles from "./ClaraOverlay.module.css";

// Phases with their own label in the "mobile" catalog (cobrowse.phase.*).
const PHASES = new Set(["thinking", "planning", "executing", "finalizing"]);

function shortToolName(name: string): string {
  // claraos_modules_media_immich__search → search; immich_create_album → create_album
  const bridged = name.split("__")[1];
  const base = bridged ?? name.replace(/^[a-z0-9]+_/, "");
  return base.replace(/_/g, " ");
}

export function CobrowseStatusStrip({ activity }: { activity: ClaraActivity | null }) {
  const { t } = useTranslation("mobile");
  const done = !activity || activity.phase === "done";
  // keep the pill visible for a beat after done, then fade (CSS transition)
  const [hidden, setHidden] = useState(done);
  useEffect(() => {
    if (!done) {
      setHidden(false);
      return;
    }
    const timer = window.setTimeout(() => setHidden(true), 3000);
    return () => window.clearTimeout(timer);
  }, [done]);

  if (hidden) return null;

  let text: string;
  let icon: string | undefined;
  if (done) {
    text = t("cobrowse.done");
  } else {
    const tools = Object.values(activity.activeTools);
    const newest = tools.reduce<(typeof tools)[number] | null>(
      (a, tool) => (!a || tool.startedAt > a.startedAt ? tool : a),
      null,
    );
    if (newest) {
      icon = newest.icon;
      text = t("cobrowse.tool", { action: newest.argsSummary || shortToolName(newest.name) });
    } else {
      text = t(PHASES.has(activity.phase) ? `cobrowse.phase.${activity.phase}` : "cobrowse.phase.executing");
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
