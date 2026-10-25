/** Month grid — extracted from the old CalendarView: 42 cells, events as
 * chips, dragging a task chip moves its due date.
 * Clicking an event opens the editor; double-clicking a day creates an all-day event. */
import { useMemo, useState } from "react";
import styles from "../../PlannerApp.module.css";
import { Icon } from "../../../../components/Icon";
import type { CalEventFull, CalTask } from "../../api";
import { addDays, ymdOf } from "./calLayout";
import { busyClassOf } from "./EventBlock";
import { regionLocale, useTranslation } from "@claraos/core";

/** Short weekday names Monday..Sunday in the region locale (2024-01-01 was a Monday). */
function weekdayNames(): string[] {
  const fmt = new Intl.DateTimeFormat(regionLocale(), { weekday: "short" });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
}

export function MonthGrid({
  month, events, tasks, onEventClick, onTaskClick, onTaskDueMoved, onDayCreate, onDayTap,
}: {
  month: Date; // first day of the month
  events: CalEventFull[];
  tasks: CalTask[];
  onEventClick: (ev: CalEventFull) => void;
  onTaskClick: (taskId: number) => void;
  onTaskDueMoved: (t: CalTask, dayKey: string) => void;
  onDayCreate: (day: Date) => void;
  /** Mobile: tapping a cell opens the day list (chips are hidden). */
  onDayTap?: (day: Date) => void;
}) {
  const { t } = useTranslation("planner");
  const [dragTask, setDragTask] = useState<CalTask | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);

  const gridStart = useMemo(() => {
    const first = new Date(month);
    const wd = (first.getDay() + 6) % 7; // Monday=0
    return addDays(first, -wd);
  }, [month]);

  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => {
    // Calendar days, not 24h steps: a DST day has 23 or 25 hours.
    const d = addDays(gridStart, i);
    return { d, key: ymdOf(d), inMonth: d.getMonth() === month.getMonth(), isToday: ymdOf(d) === ymdOf(new Date()) };
  }), [gridStart, month]);

  const byDay = useMemo(() => {
    const m = new Map<string, { events: CalEventFull[]; tasks: CalTask[] }>();
    const bucket = (k: string) => {
      if (!m.has(k)) m.set(k, { events: [], tasks: [] });
      return m.get(k)!;
    };
    events.forEach((e) => e.start && bucket(e.all_day ? e.start.slice(0, 10) : ymdOf(new Date(e.start))).events.push(e));
    tasks.forEach((task) => task.due_date && bucket(ymdOf(new Date(task.due_date))).tasks.push(task));
    return m;
  }, [events, tasks]);

  return (
    <div className={styles.calGrid}>
      {weekdayNames().map((w, i) => (
        <div key={i} className={styles.calWeekday}>{w}</div>
      ))}
      {cells.map(({ d, key, inMonth, isToday }) => {
        const day = byDay.get(key);
        return (
          <div key={key}
               className={`${styles.calCell} ${inMonth ? "" : styles.calOutside} ${isToday ? styles.calToday : ""} ${dropDay === key ? styles.bucketDrop : ""}`}
               onClick={onDayTap ? () => onDayTap(d) : undefined}
               onDoubleClick={() => onDayCreate(d)}
               onDragOver={(e) => { if (dragTask) { e.preventDefault(); setDropDay(key); } }}
               onDragLeave={() => setDropDay((cur) => (cur === key ? null : cur))}
               onDrop={(e) => {
                 e.preventDefault();
                 setDropDay(null);
                 if (dragTask) onTaskDueMoved(dragTask, key);
                 setDragTask(null);
               }}>
            <span className={styles.calDayNum}>{d.getDate()}</span>
            {/* Mobile: dot markers (chips are hidden via media query) */}
            {((day?.events.length ?? 0) > 0 || (day?.tasks.length ?? 0) > 0) && (
              <span className={styles.calDots}>
                {(day?.events ?? []).slice(0, 4).map((ev, i) => (
                  <span key={`e${i}`} className={styles.calDot}
                        style={ev.color ? { background: ev.color } : undefined} />
                ))}
                {(day?.tasks ?? []).slice(0, 3).map((task) => (
                  <span key={`t${task.id}`} className={`${styles.calDot} ${styles.calDotTask}`} />
                ))}
              </span>
            )}
            {(day?.events ?? []).slice(0, 3).map((ev) => (
              <div key={`${ev.uid}-${ev.recurrence_id ?? ""}`}
                   className={`${styles.calEvent} ${busyClassOf(ev)}`}
                   style={ev.color ? { borderLeftColor: ev.color } : undefined}
                   title={`${ev.summary} (${ev.calendar})`}
                   onClick={() => (ev.task_id != null ? onTaskClick(ev.task_id) : onEventClick(ev))}>
                {ev.task_id != null ? <Icon name="collections" size={11} /> : null}{ev.is_recurring ? <Icon name="repeat" size={11} /> : null}
                {!ev.all_day && ev.start.length > 10 ? new Date(ev.start).toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" }) + " " : ""}
                {ev.summary}
              </div>
            ))}
            {(day?.tasks ?? []).slice(0, 3).map((task) => (
              <div key={task.id}
                   className={`${styles.calTask} ${task.done ? styles.taskDone : ""}`}
                   draggable
                   onDragStart={(e) => { setDragTask(task); e.dataTransfer.setData("text/plain", String(task.id)); }}
                   onDragEnd={() => { setDragTask(null); setDropDay(null); }}
                   onClick={() => onTaskClick(task.id)}
                   title={t("calendar.month.dragTaskHint", { title: task.title })}>
                <Icon name={task.done ? "done" : "blind"} size={12} /> {task.title}
              </div>
            ))}
            {((day?.events.length ?? 0) > 3 || (day?.tasks.length ?? 0) > 3) && (
              <span className={styles.calMore}>…</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
