/** Agenda — chronological list of the next 14 days: events + due tasks
 * mixed, day headers, same click semantics as the grid. */
import { useMemo } from "react";
import styles from "../../PlannerApp.module.css";
import type { CalEventFull, CalTask } from "../../api";
import { addDays, ymdOf } from "./calLayout";
import { busyClassOf, eventTimeLabel } from "./EventBlock";
import { regionLocale, useTranslation } from "@claraos/core";

/** Busy states that get a label in the agenda ("busy" is the default and stays silent). */
const LABELLED_BUSY = new Set(["free", "tentative", "oof"]);

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
  const { t } = useTranslation("planner");
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => addDays(anchor, i)), [anchor, days]);

  const byDay = useMemo(() => {
    const m = new Map<string, AgendaItem[]>();
    dayList.forEach((d) => m.set(ymdOf(d), []));
    for (const ev of events) {
      if (!ev.start) continue;
      const key = ev.all_day ? ev.start.slice(0, 10) : ymdOf(new Date(ev.start));
      m.get(key)?.push({ kind: "event", sort: ev.all_day ? "0000" : ev.start, ev });
    }
    for (const task of tasks) {
      if (!task.due_date) continue;
      m.get(ymdOf(new Date(task.due_date)))?.push({ kind: "task", sort: task.due_date, task });
    }
    m.forEach((items) => items.sort((a, b) => a.sort.localeCompare(b.sort)));
    return m;
  }, [dayList, events, tasks]);

  const today = ymdOf(new Date());
  const nonEmpty = dayList.filter((d) => (byDay.get(ymdOf(d)) ?? []).length > 0);

  return (
    <div className={styles.agendaWrap}>
      {nonEmpty.length === 0 && <div className={styles.empty}>{t("calendar.agenda.empty")}</div>}
      {nonEmpty.map((d) => {
        const key = ymdOf(d);
        return (
          <section key={key} className={styles.section}>
            <h3 className={`${styles.agendaDay} ${key === today ? styles.agendaToday : ""}`}>
              {d.toLocaleDateString(regionLocale(), { weekday: "long", day: "numeric", month: "long" })}
              {key === today ? ` · ${t("calendar.today")}` : ""}
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
                    {LABELLED_BUSY.has(item.ev.busy_status) ? `${t(`calendar.busy.${item.ev.busy_status}`)} · ` : ""}
                    {item.ev.calendar}
                  </span>
                </div>
              ) : (
                <div key={`t-${item.task.id}`}
                     className={`${styles.agendaRow} ${styles.agendaTask} ${item.task.done ? styles.taskDone : ""}`}
                     onClick={() => onTaskClick(item.task.id)}>
                  <span className={styles.agendaTime}>
                    {new Date(item.task.due_date).toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className={styles.agendaTitle}>{item.task.done ? "✓" : "○"} {item.task.title}</span>
                  <span className={styles.agendaSub}>{t("calendar.agenda.taskDue")}</span>
                </div>
              ),
            )}
          </section>
        );
      })}
    </div>
  );
}
