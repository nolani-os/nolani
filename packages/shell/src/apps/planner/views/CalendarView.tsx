/** Calendar v2 — container: month/week/day/agenda switcher, event CRUD
 * via the editor, drag = move/resize in the time grid, task time blocking
 * (sidebar → slot), view stored in localStorage. Data source: /events
 * (expanded recurrences + busy status/attendees). */
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "../PlannerApp.module.css";
import { Icon } from "../../../components/Icon";
import { kalenderApi, ncApi, plannerApi, type CalEventFull, type CalTask } from "../api";
import { KalenderEinstellungen, KalenderTeilenDialog, type KalenderPrefs } from "./calendar/Phase5";
import type { VikTask } from "../types";
import { addDays, MS_DAY, startOfWeek, ymdOf } from "./calendar/calLayout";
import { TimeGrid } from "./calendar/TimeGrid";
import { MonthGrid } from "./calendar/MonthGrid";
import { AgendaList } from "./calendar/AgendaList";
import { EventEditor, type EditorInit } from "./calendar/EventEditor";
import { TaskSidebar } from "./calendar/TaskSidebar";
import { BottomSheet } from "../../../components/BottomSheet";
import { useIsMobile } from "../../../Mobile/useIsMobile";
import { busyClassOf, eventTimeLabel } from "./calendar/EventBlock";
import { regionLocale } from "@claraos/core";

type ViewMode = "month" | "week" | "workweek" | "day" | "agenda";
const LS_VIEW = "claraos.planner.calView";
const LS_VIEW_MOBILE = "claraos.planner.calView.mobile";
const AGENDA_DAYS = 14;

const VIEW_LABELS: { key: ViewMode; label: string }[] = [
  { key: "day", label: "Tag" },
  { key: "workweek", label: "Arbeitswoche" },
  { key: "week", label: "Woche" },
  { key: "month", label: "Monat" },
  { key: "agenda", label: "Agenda" },
];
// Mobile: no week view (7 columns unusable), agenda is the default
const VIEW_LABELS_MOBILE = VIEW_LABELS.filter((v) => v.key !== "week" && v.key !== "workweek");

export function CalendarView({
  allTasks, onOpenTask, onReloadTasks,
}: {
  allTasks: VikTask[];
  onOpenTask: (t: VikTask) => void;
  onReloadTasks: () => void;
}) {
  const isMobile = useIsMobile();
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (window.innerWidth < 768) {
      const m = localStorage.getItem(LS_VIEW_MOBILE) as ViewMode;
      return m && m !== "week" && m !== "workweek" ? m : "agenda";
    }
    return (localStorage.getItem(LS_VIEW) as ViewMode) || "week";
  });
  const [anchor, setAnchor] = useState(() => new Date());
  const [daySheet, setDaySheet] = useState<Date | null>(null);
  const [events, setEvents] = useState<CalEventFull[]>([]);
  const [tasks, setTasks] = useState<CalTask[]>([]);
  const [calendars, setCalendars] = useState<{ name: string; color?: string; writable?: boolean }[]>([]);
  const [editor, setEditor] = useState<EditorInit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Holidays, sharing dialog, settings
  const [kPrefs, setKPrefs] = useState<KalenderPrefs>({});
  const [states, setStates] = useState<{ code: string; name: string }[]>([]);
  const [holidays, setHolidays] = useState<CalEventFull[]>([]);
  const [teilen, setTeilen] = useState(false);
  const [einstellungen, setEinstellungen] = useState(false);

  useEffect(() => { localStorage.setItem(isMobile ? LS_VIEW_MOBILE : LS_VIEW, viewMode); }, [viewMode, isMobile]);
  // Breakpoint change: no week view on mobile
  useEffect(() => {
    if (isMobile && (viewMode === "week" || viewMode === "workweek")) setViewMode("agenda");
  }, [isMobile, viewMode]);
  useEffect(() => { ncApi.calendars().then(setCalendars).catch(() => undefined); }, []);
  useEffect(() => {
    plannerApi.getPlannerPrefs().then((p) => setKPrefs({
      holiday_state: typeof p.holiday_state === "string" ? p.holiday_state : "",
      reminders_push: p.reminders_push !== false,
      show_holidays: p.show_holidays !== false,
    })).catch(() => undefined);
  }, []);

  /** Visible range per view. */
  const range = useMemo((): { start: Date; end: Date } => {
    if (viewMode === "month") {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const wd = (first.getDay() + 6) % 7;
      const gridStart = new Date(first.getTime() - wd * MS_DAY);
      return { start: gridStart, end: new Date(gridStart.getTime() + 42 * MS_DAY) };
    }
    if (viewMode === "week" || viewMode === "workweek") {
      const s = startOfWeek(anchor);
      return { start: s, end: addDays(s, viewMode === "workweek" ? 5 : 7) };
    }
    if (viewMode === "day") {
      const s = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      return { start: s, end: addDays(s, 1) };
    }
    const s = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    return { start: s, end: addDays(s, AGENDA_DAYS) };
  }, [viewMode, anchor]);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await plannerApi.listEvents(range.start.toISOString(), range.end.toISOString());
      setEvents(res.events || []);
      setTasks(res.tasks || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  // Holidays as all-day pseudo events (not editable)
  useEffect(() => {
    if (kPrefs.show_holidays === false) { setHolidays([]); return; }
    const years = Array.from(new Set([range.start.getFullYear(), range.end.getFullYear()]));
    Promise.all(years.map((y) => kalenderApi.feiertage(y, kPrefs.holiday_state ?? ""))).then((rs) => {
      if (rs[0]?.states?.length) setStates(rs[0].states);
      setHolidays(rs.flatMap((r) => r.holidays).map((h) => ({
        uid: `holiday:${h.date}`, summary: h.name, start: h.date, end: h.date, all_day: true,
        calendar: "Feiertage", color: "#9ca3af", task_id: null, location: "", description: h.regional ? "regionaler Feiertag" : "bundesweiter Feiertag",
        busy_status: "free", recurrence_id: null, is_recurring: false, rrule_raw: "", rrule_simple: null,
        alarm_minutes: null, organizer: null, attendees: [],
      })));
    }).catch(() => setHolidays([]));
  }, [range, kPrefs.show_holidays, kPrefs.holiday_state]);
  const shown = useMemo(() => (holidays.length ? [...holidays, ...events] : events), [holidays, events]);

  const navigate = (dir: -1 | 1) => {
    if (viewMode === "month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    else if (viewMode === "week" || viewMode === "workweek") setAnchor(addDays(anchor, dir * 7));
    else if (viewMode === "day") setAnchor(addDays(anchor, dir));
    else setAnchor(addDays(anchor, dir * AGENDA_DAYS));
  };

  const rangeLabel = useMemo(() => {
    if (viewMode === "month") return anchor.toLocaleDateString(regionLocale(), { month: "long", year: "numeric" });
    if (viewMode === "day") return anchor.toLocaleDateString(regionLocale(), { weekday: "long", day: "numeric", month: "long" });
    if (viewMode === "week" || viewMode === "workweek") {
      const s = startOfWeek(anchor);
      const e = addDays(s, viewMode === "workweek" ? 4 : 6);
      return `${s.toLocaleDateString(regionLocale(), { day: "numeric", month: "short" })} – ${e.toLocaleDateString(regionLocale(), { day: "numeric", month: "short", year: "numeric" })}`;
    }
    return `ab ${anchor.toLocaleDateString(regionLocale(), { day: "numeric", month: "long" })}`;
  }, [viewMode, anchor]);

  const openTaskById = useCallback((taskId: number) => {
    plannerApi.getTask(taskId).then(onOpenTask).catch(() => undefined);
  }, [onOpenTask]);

  /** Click on an event: load the master; pass along the series instance
   * ("this event only" / "whole series" in the editor). Holidays are not editable. */
  const openEditor = useCallback(async (ev: CalEventFull) => {
    if (ev.uid.startsWith("holiday:")) return;
    if (ev.is_recurring && ev.recurrence_id) {
      try {
        const master = await plannerApi.getEvent(ev.uid, ev.calendar);
        setEditor({ mode: "edit", ev: master, instance: ev });
        return;
      } catch { /* Fallback: edit the instance data */ }
    }
    setEditor({ mode: "edit", ev });
  }, []);

  const moveEvent = useCallback(async (ev: CalEventFull, startIso: string, endIso: string) => {
    if (ev.uid.startsWith("holiday:")) return;
    // optimistic: move the block immediately, reload on error
    setEvents((cur) => cur.map((e) =>
      e.uid === ev.uid && (e.recurrence_id ?? "") === (ev.recurrence_id ?? "")
        ? { ...e, start: startIso, end: endIso } : e));
    try {
      await plannerApi.updateEvent(ev.uid, ev.calendar, {
        summary: ev.summary, start: startIso, end: endIso, all_day: false,
        location: ev.location || null, description: ev.description || null,
        busy_status: ev.busy_status, alarm_minutes: ev.alarm_minutes,
        attendees: ev.attendees.map((a) => ({ email: a.email, name: a.name ?? undefined })),
        rrule_keep: true, rrule: null,
        // A dragged series instance only moves this occurrence
        ...(ev.recurrence_id ? { only_this: true, recurrence_id: ev.recurrence_id } : {}),
      });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  }, [load]);

  const moveTaskDue = useCallback(async (t: CalTask, dayKey: string) => {
    const old = new Date(t.due_date);
    const nd = new Date(`${dayKey}T00:00:00`);
    nd.setHours(old.getHours(), old.getMinutes(), 0, 0);
    try {
      await plannerApi.updateTaskFields(t.id, { due_date: nd.toISOString() });
      load(); onReloadTasks();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load, onReloadTasks]);

  const scheduleTaskAt = useCallback(async (taskId: number, projectId: number, estimateMinutes: number, start: Date) => {
    try {
      const end = new Date(start.getTime() + Math.max(estimateMinutes, 15) * 60_000);
      await plannerApi.scheduleTask(taskId, {
        project_id: projectId, start: start.toISOString(), end: end.toISOString(),
      });
      load(); onReloadTasks();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load, onReloadTasks]);

  /** Entries of a day for the mobile day sheet (agenda sorting). */
  const dayItems = useCallback((d: Date) => {
    const key = ymdOf(d);
    const items: ({ kind: "event"; sort: string; ev: CalEventFull } | { kind: "task"; sort: string; task: CalTask })[] = [];
    for (const ev of shown) {
      if (!ev.start) continue;
      const k = ev.all_day ? ev.start.slice(0, 10) : ymdOf(new Date(ev.start));
      if (k === key) items.push({ kind: "event", sort: ev.all_day ? "0000" : ev.start, ev });
    }
    for (const t of tasks) {
      if (t.due_date && ymdOf(new Date(t.due_date)) === key) items.push({ kind: "task", sort: t.due_date, task: t });
    }
    return items.sort((a, b) => a.sort.localeCompare(b.sort));
  }, [shown, tasks]);

  const weekDays = useMemo(() => {
    if (viewMode === "day") return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
    const s = startOfWeek(anchor);
    return Array.from({ length: viewMode === "workweek" ? 5 : 7 }, (_, i) => addDays(s, i));
  }, [viewMode, anchor]);

  const showGrid = viewMode === "week" || viewMode === "workweek" || viewMode === "day";

  return (
    <div className={styles.view} style={{ maxWidth: "none" }}>
      <header className={styles.viewHeader}>
        <h2><Icon name="calendar" size={18} /> Kalender</h2>
        <div className={styles.viewTools}>
          <div className={styles.calSwitch}>
            {(isMobile ? VIEW_LABELS_MOBILE : VIEW_LABELS).map((v) => (
              <button key={v.key}
                      className={`${styles.projTab} ${viewMode === v.key ? styles.projTabActive : ""}`}
                      onClick={() => setViewMode(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
          <button className={styles.btn} onClick={() => navigate(-1)}>‹</button>
          <span className={styles.calMonthLabel}>{rangeLabel}</span>
          <button className={styles.btn} onClick={() => navigate(1)}>›</button>
          <button className={styles.btn} onClick={() => setAnchor(new Date())}>Heute</button>
          {!isMobile && (
            <button className={styles.btn} title="Kalender freigeben" onClick={() => setTeilen(true)}><Icon name="share" size={14} /></button>
          )}
          <button className={styles.btn} title="Kalender-Einstellungen (Feiertage, Erinnerungen)" onClick={() => setEinstellungen(true)}><Icon name="gear" size={14} /></button>
          {isMobile && (
            <button className={styles.btnPrimary} title="Neuer Termin"
                    onClick={() => {
                      const s = new Date();
                      s.setMinutes(s.getMinutes() < 30 ? 30 : 60, 0, 0);
                      setEditor({ mode: "create", start: s });
                    }}>＋ Termin</button>
          )}
          {!isMobile && (
            <button className={styles.btnPrimary}
                    onClick={() => {
                      const s = new Date();
                      s.setMinutes(s.getMinutes() < 30 ? 30 : 60, 0, 0);
                      setEditor({ mode: "create", start: s });
                    }}>
              + Termin
            </button>
          )}
        </div>
      </header>
      {error && <div className={styles.errorBox}>{error} <button className={styles.btn} onClick={() => { setError(null); load(); }}>↻</button></div>}
      {notice && <div className={styles.hint}>{notice} <button className={styles.btn} onClick={() => setNotice(null)}>OK</button></div>}
      {loading ? <div className={styles.loading}>Lade Kalender…</div> : (
        <div className={showGrid ? styles.calWithSidebar : undefined}>
          <div className={styles.calMain}>
            {viewMode === "month" && (
              <MonthGrid
                month={new Date(anchor.getFullYear(), anchor.getMonth(), 1)}
                events={shown} tasks={tasks}
                onEventClick={openEditor}
                onTaskClick={openTaskById}
                onTaskDueMoved={moveTaskDue}
                onDayCreate={(d) => setEditor({ mode: "create", start: d, allDay: true })}
                onDayTap={isMobile ? (d) => setDaySheet(d) : undefined}
              />
            )}
            {showGrid && (
              <TimeGrid
                days={weekDays}
                events={shown}
                onSlotClick={(start) => setEditor({ mode: "create", start })}
                onEventClick={openEditor}
                onEventMoved={moveEvent}
                onTaskDrop={isMobile ? undefined : scheduleTaskAt}
                interactive={!isMobile}
              />
            )}
            {viewMode === "agenda" && (
              <AgendaList
                anchor={anchor} days={AGENDA_DAYS}
                events={shown} tasks={tasks}
                onEventClick={openEditor}
                onTaskClick={openTaskById}
              />
            )}
          </div>
          {showGrid && !isMobile && <TaskSidebar tasks={allTasks} onOpenTask={onOpenTask} />}
        </div>
      )}

      {/* Warning: "+ event" used to float here as a second round button in
          the same corner as Clara's — exactly the flaw already removed in the
          Knowledge app. The button now sits in the header, where "Today"
          is anyway. */}
      {isMobile && (
        <BottomSheet open={daySheet != null} onClose={() => setDaySheet(null)}
                     title={daySheet?.toLocaleDateString(regionLocale(), { weekday: "long", day: "numeric", month: "long" })}>
          {daySheet && (
            <div className={styles.daySheetList}>
              {dayItems(daySheet).map((item) =>
                item.kind === "event" ? (
                  <div key={`e-${item.ev.uid}-${item.ev.recurrence_id ?? ""}`}
                       className={`${styles.agendaRow} ${busyClassOf(item.ev)}`}
                       style={item.ev.color ? { borderLeftColor: item.ev.color } : undefined}
                       onClick={() => {
                         setDaySheet(null);
                         if (item.ev.task_id != null) openTaskById(item.ev.task_id);
                         else openEditor(item.ev);
                       }}>
                    <span className={styles.agendaTime}>{eventTimeLabel(item.ev)}</span>
                    <span className={styles.agendaTitle}>
                      {item.ev.task_id != null ? <Icon name="collections" size={12} /> : null}{item.ev.is_recurring ? <Icon name="repeat" size={12} /> : null}{item.ev.summary}
                    </span>
                  </div>
                ) : (
                  <div key={`t-${item.task.id}`}
                       className={`${styles.agendaRow} ${styles.agendaTask} ${item.task.done ? styles.taskDone : ""}`}
                       onClick={() => { setDaySheet(null); openTaskById(item.task.id); }}>
                    <span className={styles.agendaTime}>
                      {new Date(item.task.due_date).toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className={styles.agendaTitle}><Icon name={item.task.done ? "done" : "blind"} size={13} /> {item.task.title}</span>
                  </div>
                ),
              )}
              {dayItems(daySheet).length === 0 && (
                <div className={styles.empty}>Nichts an diesem Tag — „+" legt einen Termin an.</div>
              )}
            </div>
          )}
        </BottomSheet>
      )}

      {teilen && (
        <KalenderTeilenDialog calendars={calendars} onClose={() => setTeilen(false)}
                              onNotice={(m) => setNotice(m)} />
      )}
      {einstellungen && (
        <KalenderEinstellungen prefs={kPrefs} states={states} onClose={() => setEinstellungen(false)}
                               onChange={(p) => setKPrefs(p)} />
      )}
      {editor && (
        <EventEditor
          init={editor}
          calendars={calendars}
          onClose={() => setEditor(null)}
          onSaved={(warning) => {
            setEditor(null);
            if (warning) setNotice(warning);
            load();
          }}
          onDeleted={() => { setEditor(null); load(); onReloadTasks(); }}
          onError={(m, konflikt) => {
            setEditor(null);
            setError(m);
            // 409: the other version is the correct one — reload immediately,
            // otherwise the view keeps showing something that no longer applies.
            if (konflikt) load();
          }}
        />
      )}
    </div>
  );
}
