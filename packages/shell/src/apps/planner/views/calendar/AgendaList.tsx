/** Agenda — chronological list of the next 14 days: events + due tasks
 * mixed, day headers, same click semantics as the grid. */
import { useMemo } from "react";
import styles from "../../PlannerApp.module.css";
import type { CalEventFull, CalTask } from "../../api";
import { addDays, ymdOf } from "./calLayout";
import { busyClassOf, eventTimeLabel } from "./EventBlock";

const BUSY_LABEL: Record<string, string> = {
  free: "Frei", busy: "", tentative: "Mit Vorbehalt", oof: "Außer Haus",
};

type AgendaItem =
  | { kind: "event"; sort: string; ev: CalEventFull }
  | { kind: "task"; sort: string; task: CalTask };

export function AgendaList({
  anchor, days, events, tasks, onEventClick, onTaskClick,
}: {
  anchor: Date;
  days: number;
  events: CalEventFull[];
  tasks: CalTask[];
  onEventClick: (ev: CalEventFull) => void;
  onTaskClick: (taskId: number) => void;
}) {
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => addDays(anchor, i)), [anchor, days]);

  const byDay = useMemo(() => {
    const m = new Map<string, AgendaItem[]>();
    dayList.forEach((d) => m.set(ymdOf(d), []));
    for (const ev of events) {
      if (!ev.start) continue;
      const key = ev.all_day ? ev.start.slice(0, 10) : ymdOf(new Date(ev.start));
      m.get(key)?.push({ kind: "event", sort: ev.all_day ? "0000" : ev.start, ev });
    }
    for (const t of tasks) {
      if (!t.due_date) continue;
      m.get(ymdOf(new Date(t.due_date)))?.push({ kind: "task", sort: t.due_date, task: t });
    }
    m.forEach((items) => items.sort((a, b) => a.sort.localeCompare(b.sort)));
    return m;
  }, [dayList, events, tasks]);

  const today = ymdOf(new Date());
  const nonEmpty = dayList.filter((d) => (byDay.get(ymdOf(d)) ?? []).length > 0);

  return (
    <div className={styles.agendaWrap}>
      {nonEmpty.length === 0 && <div className={styles.empty}>Keine Termine oder fälligen Aufgaben im Zeitraum.</div>}
      {nonEmpty.map((d) => {
        const key = ymdOf(d);
        return (
          <section key={key} className={styles.section}>
            <h3 className={`${styles.agendaDay} ${key === today ? styles.agendaToday : ""}`}>
              {d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}
              {key === today ? " · Heute" : ""}
            </h3>
            {(byDay.get(key) ?? []).map((item, i) =>
              item.kind === "event" ? (
                <div key={`e-${item.ev.uid}-${item.ev.recurrence_id ?? i}`}
                     className={`${styles.agendaRow} ${busyClassOf(item.ev)}`}
                     style={item.ev.color ? { borderLeftColor: item.ev.color } : undefined}
                     onClick={() => (item.ev.task_id != null ? onTaskClick(item.ev.task_id) : onEventClick(item.ev))}>
                  <span className={styles.agendaTime}>{eventTimeLabel(item.ev)}</span>
                  <span className={styles.agendaTitle}>
                    {item.ev.task_id != null ? "🗂️ " : ""}{item.ev.is_recurring ? "↻ " : ""}
                    {item.ev.attendees.length > 0 ? "👥 " : ""}{item.ev.summary}
                  </span>
                  <span className={styles.agendaSub}>
                    {item.ev.location ? `📍 ${item.ev.location} · ` : ""}
                    {BUSY_LABEL[item.ev.busy_status] ? `${BUSY_LABEL[item.ev.busy_status]} · ` : ""}
                    {item.ev.calendar}
                  </span>
                </div>
              ) : (
                <div key={`t-${item.task.id}`}
                     className={`${styles.agendaRow} ${styles.agendaTask} ${item.task.done ? styles.taskDone : ""}`}
                     onClick={() => onTaskClick(item.task.id)}>
                  <span className={styles.agendaTime}>
                    {new Date(item.task.due_date).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className={styles.agendaTitle}>{item.task.done ? "✓" : "○"} {item.task.title}</span>
                  <span className={styles.agendaSub}>Aufgabe fällig</span>
                </div>
              ),
            )}
          </section>
        );
      })}
    </div>
  );
}
