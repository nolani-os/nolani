/**
 * Calendar in the Teams app — the native ClaraOS view instead of the Nextcloud
 * UI. Matrix and Nextcloud act as backends the user never sees.
 *
 * Deliberately NOTHING is rebuilt here. The Planner already ships a full
 * calendar (day/week/month/agenda, event editor, recurrence, drag, time
 * blocks) on the same CalDAV data. This file is just the wrapper: load tasks,
 * mount the view, hand task clicks to the Planner app.
 *
 * Why this works without state collisions: `CalendarView` fetches calendars
 * and events itself via `ncApi`/`plannerApi` and keeps its state local. There
 * is no shared store as with the Files app — two open calendar views do not
 * interfere with each other.
 */
import { useCallback, useEffect, useState } from "react";
import { useWindowsStore } from "@claraos/core";
import { CalendarView } from "../../planner/views/CalendarView";
import { plannerApi } from "../../planner/api";
import type { VikTask } from "../../planner/types";
import styles from "./CallsView.module.css";

export function KalenderView() {
  const [aufgaben, setAufgaben] = useState<VikTask[]>([]);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neuLaden, setNeuLaden] = useState(0);

  // Tasks only feed the side column for time blocking. The calendar itself
  // doesn't need them — so an error here is no reason to refuse the view; it
  // simply runs without the side column.
  useEffect(() => {
    let abgebrochen = false;
    (async () => {
      try {
        const alle: VikTask[] = [];
        // Paged as in the Planner; 40 pages (2,000) as a safety net against endless loops.
        for (let seite = 1; seite <= 40; seite++) {
          const teil = (await plannerApi.listAllTasks(seite)) || [];
          alle.push(...teil);
          if (teil.length < 50) break;
        }
        if (abgebrochen) return;
        setAufgaben(alle.filter(Boolean));
        setFehler(null);
      } catch (e) {
        if (!abgebrochen) setFehler(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      abgebrochen = true;
    };
  }, [neuLaden]);

  // A task belongs in the Planner, not in the Teams app — that is where its
  // full context lives (project, checklist, costs, comments). So we open the
  // Planner window instead of building a second task view here.
  const aufgabeOeffnen = useCallback(() => {
    useWindowsStore.getState().openWindow("planner");
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {fehler && (
        <div className={styles.hint} style={{ padding: "8px 16px", color: "#f38ba8" }}>
          Aufgaben für die Zeitplanung konnten nicht geladen werden: {fehler}
        </div>
      )}
      <CalendarView
        allTasks={aufgaben}
        onOpenTask={aufgabeOeffnen}
        onReloadTasks={() => setNeuLaden((n) => n + 1)}
      />
    </div>
  );
}
