/** Gantt — native (no library, house style): timeline in days, bars from
 * start_date/due_date, SVG arrows from relations (blocked), dragging moves
 * bars (updateTaskFields), blocked status shown visually. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "../PlannerApp.module.css";
import { plannerApi } from "../api";
import { hasDate, type VikProject, type VikTask } from "../types";
import { regionLocale } from "@claraos/core";

const DAY_W = 30;
const ROW_H = 34;
const LABEL_W = 220;
const MS_DAY = 86400000;

interface Bar {
  task: VikTask;
  startDay: number; // days since range start
  days: number;
  row: number;
  blockedByOpen: boolean;
  hasRealDates: boolean;
}

function dayFloor(d: Date): number {
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / MS_DAY);
}

export function GanttView({ project, onOpen }: { project: VikProject; onOpen: (t: VikTask) => void }) {
  const [tasks, setTasks] = useState<VikTask[]>([]);
  const [unscheduled, setUnscheduled] = useState<VikTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drag, setDrag] = useState<{ id: number; mode: "move" | "resize"; startX: number; deltaDays: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      let list = await plannerApi.listProjectTasks(project.id);
      list = (list || []).filter((t) => !t.done);
      // List responses may omit related_tasks → load details
      if (list.length && list.every((t) => !t.related_tasks)) {
        const details = await Promise.all(
          list.slice(0, 40).map((t) => plannerApi.getTask(t.id).catch(() => t)),
        );
        list = details;
      }
      setTasks(list.filter((t) => hasDate(t.due_date) || hasDate(t.start_date)));
      setUnscheduled(list.filter((t) => !hasDate(t.due_date) && !hasDate(t.start_date)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const { bars, rangeStart, totalDays, arrows } = useMemo(() => {
    const today = dayFloor(new Date());
    let lo = today, hi = today + 7;
    const ends = new Map<number, { s: number; e: number }>();
    tasks.forEach((t) => {
      const due = hasDate(t.due_date) ? dayFloor(new Date(t.due_date!)) : null;
      const start = hasDate(t.start_date) ? dayFloor(new Date(t.start_date!)) : null;
      const s = start ?? (due != null ? due : today);
      const e = due != null ? Math.max(due, s) : s + 1;
      ends.set(t.id, { s, e });
      lo = Math.min(lo, s);
      hi = Math.max(hi, e);
    });
    lo -= 2; hi += 3;
    const doneIds = new Set(tasks.filter((t) => t.done).map((t) => t.id));
    const bars: Bar[] = tasks.map((t, i) => {
      const { s, e } = ends.get(t.id)!;
      const blockers = t.related_tasks?.blocked ?? [];
      return {
        task: t,
        startDay: s - lo,
        days: Math.max(1, e - s + 1),
        row: i,
        blockedByOpen: blockers.some((b) => !b.done && !doneIds.has(b.id)),
        hasRealDates: hasDate(t.due_date) || hasDate(t.start_date),
      };
    });
    const rowOf = new Map<number, Bar>();
    bars.forEach((b) => rowOf.set(b.task.id, b));
    const arrows: { from: Bar; to: Bar }[] = [];
    bars.forEach((b) => {
      (b.task.related_tasks?.blocked ?? []).forEach((blocker) => {
        const fromBar = rowOf.get(blocker.id);
        if (fromBar) arrows.push({ from: fromBar, to: b });
      });
    });
    return { bars, rangeStart: lo, totalDays: hi - lo + 1, arrows };
  }, [tasks]);

  const commitDrag = useCallback(async () => {
    if (!drag || drag.deltaDays === 0) { setDrag(null); return; }
    const bar = bars.find((b) => b.task.id === drag.id);
    setDrag(null);
    if (!bar) return;
    const t = bar.task;
    try {
      if (drag.mode === "move") {
        const patch: Partial<VikTask> = {};
        if (hasDate(t.start_date)) patch.start_date = new Date(new Date(t.start_date!).getTime() + drag.deltaDays * MS_DAY).toISOString();
        if (hasDate(t.due_date)) patch.due_date = new Date(new Date(t.due_date!).getTime() + drag.deltaDays * MS_DAY).toISOString();
        await plannerApi.updateTaskFields(t.id, patch);
      } else {
        const base = hasDate(t.due_date) ? new Date(t.due_date!) : new Date();
        await plannerApi.updateTaskFields(t.id, {
          due_date: new Date(base.getTime() + drag.deltaDays * MS_DAY).toISOString(),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    load();
  }, [drag, bars, load]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      setDrag((d) => d && { ...d, deltaDays: Math.round((e.clientX - d.startX) / DAY_W) });
    };
    const onUp = () => commitDrag();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, commitDrag]);

  const days = useMemo(() => Array.from({ length: totalDays }, (_, i) => {
    const d = new Date((rangeStart + i) * MS_DAY);
    return { i, d, isToday: rangeStart + i === dayFloor(new Date()), isWeekend: [0, 6].includes(d.getDay()), isFirst: d.getDate() === 1 || i === 0 };
  }), [rangeStart, totalDays]);

  if (loading) return <div className={styles.loading}>Lade Gantt…</div>;

  const chartW = totalDays * DAY_W;
  const chartH = bars.length * ROW_H;

  return (
    <div className={styles.ganttWrap}>
      {error && <div className={styles.errorBox}>{error}</div>}
      {bars.length === 0 && <div className={styles.empty}>Keine terminierten Aufgaben — Fälligkeiten setzen, dann erscheinen sie hier.</div>}
      {bars.length > 0 && (
        <div className={styles.ganttScroll} ref={scrollRef}>
          <div className={styles.ganttGrid} style={{ width: LABEL_W + chartW }}>
            {/* Header row */}
            <div className={styles.ganttHeader} style={{ paddingLeft: LABEL_W }}>
              {days.map(({ i, d, isToday, isFirst }) => (
                <div key={i} className={`${styles.ganttDay} ${isToday ? styles.ganttToday : ""}`} style={{ width: DAY_W }}>
                  {isFirst && <span className={styles.ganttMonth}>{d.toLocaleDateString(regionLocale(), { month: "short" })}</span>}
                  {d.getDate()}
                </div>
              ))}
            </div>
            {/* Rows */}
            <div className={styles.ganttBody} style={{ height: chartH }}>
              {/* Day grid + weekend */}
              {days.map(({ i, isWeekend, isToday }) => (
                <div key={i}
                     className={`${styles.ganttCol} ${isWeekend ? styles.ganttWeekend : ""} ${isToday ? styles.ganttTodayCol : ""}`}
                     style={{ left: LABEL_W + i * DAY_W, width: DAY_W, height: chartH }} />
              ))}
              {/* Labels */}
              {bars.map((b) => (
                <div key={b.task.id} className={styles.ganttLabel}
                     style={{ top: b.row * ROW_H, width: LABEL_W, height: ROW_H }}
                     onClick={() => onOpen(b.task)} title={b.task.title}>
                  {b.blockedByOpen && <span title="wird blockiert">⛔ </span>}{b.task.title}
                </div>
              ))}
              {/* Bars */}
              {bars.map((b) => {
                const delta = drag?.id === b.task.id ? drag.deltaDays : 0;
                const isResize = drag?.id === b.task.id && drag.mode === "resize";
                const left = LABEL_W + (b.startDay + (isResize ? 0 : delta)) * DAY_W;
                const width = (b.days + (isResize ? delta : 0)) * DAY_W - 6;
                return (
                  <div key={b.task.id}
                       className={`${styles.ganttBar} ${b.blockedByOpen ? styles.ganttBarBlocked : ""} ${!b.hasRealDates ? styles.ganttBarSoft : ""}`}
                       style={{ top: b.row * ROW_H + 6, left, width: Math.max(DAY_W - 6, width), height: ROW_H - 12 }}
                       onMouseDown={(e) => {
                         e.preventDefault();
                         setDrag({ id: b.task.id, mode: "move", startX: e.clientX, deltaDays: 0 });
                       }}
                       onDoubleClick={() => onOpen(b.task)}
                       title={`${b.task.title} — Doppelklick: Details, Ziehen: verschieben`}>
                    <span className={styles.ganttBarText}>{b.task.title}</span>
                    <span className={styles.ganttResize}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDrag({ id: b.task.id, mode: "resize", startX: e.clientX, deltaDays: 0 });
                          }} />
                  </div>
                );
              })}
              {/* Dependency arrows */}
              <svg className={styles.ganttSvg} width={LABEL_W + chartW} height={chartH}>
                <defs>
                  <marker id="planner-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                    <path d="M0,0 L7,3.5 L0,7 z" fill="var(--accent, #38bdf8)" />
                  </marker>
                </defs>
                {arrows.map(({ from, to }, i) => {
                  const x1 = LABEL_W + (from.startDay + from.days) * DAY_W - 4;
                  const y1 = from.row * ROW_H + ROW_H / 2;
                  const x2 = LABEL_W + to.startDay * DAY_W + 2;
                  const y2 = to.row * ROW_H + ROW_H / 2;
                  const mx = Math.max(x1 + 12, x2 - 12);
                  return (
                    <path key={i}
                          d={`M ${x1} ${y1} L ${x1 + 8} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`}
                          fill="none" stroke="var(--accent, #38bdf8)" strokeWidth="1.6"
                          strokeOpacity="0.85" markerEnd="url(#planner-arrow)" />
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      )}
      {unscheduled.length > 0 && (
        <div className={styles.ganttUnscheduled}>
          <span className={styles.sectionTitle}>Ohne Termin:</span>
          {unscheduled.map((t) => (
            <button key={t.id} className={styles.labelChip} onClick={() => onOpen(t)}>{t.title}</button>
          ))}
        </div>
      )}
    </div>
  );
}
