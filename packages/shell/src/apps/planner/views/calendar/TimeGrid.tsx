/** Shared hour grid for week (7 columns) and day view (1 column): all-day
 * row, now line, slot click = create, pointer drag = move, edge drag =
 * duration (GanttView pattern), task drop (dataTransfer "claraos/task") =
 * time-blocking. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "../../PlannerApp.module.css";
import type { CalEventFull } from "../../api";
import { EventBlock, busyClassOf } from "./EventBlock";
import { useTranslation } from "@claraos/core";
import { eventsByDay, layoutDay, snapTo15, ymdOf, type PlacedEvent } from "./calLayout";

const HOUR_PX = 48;

interface DragState {
  kind: "move" | "resize";
  ev: CalEventFull;
  durMin: number;       // move: duration stays
  grabOffsetMin: number; // move: pointer offset from event start
  day: string;          // current target day (ymd)
  startMin: number;     // current target start (move) or fixed start (resize)
  endMin: number;
}

export function TimeGrid({
  days, events, onSlotClick, onEventClick, onEventMoved, onTaskDrop, interactive = true,
}: {
  days: Date[];
  events: CalEventFull[];
  onSlotClick: (start: Date) => void;
  onEventClick: (ev: CalEventFull) => void;
  onEventMoved: (ev: CalEventFull, startIso: string, endIso: string) => void;
  onTaskDrop?: (taskId: number, projectId: number, estimateMinutes: number, start: Date) => void;
  /** false (mobile): no event drag/resize — pointer drag conflicts with
   * touch scrolling; times are changed in the editor (tap). */
  interactive?: boolean;
}) {
  const { t } = useTranslation("planner");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropSlot, setDropSlot] = useState<{ day: string; min: number } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const dayKeys = useMemo(() => days.map(ymdOf), [days]);
  const timed = useMemo(() => events.filter((e) => !e.all_day), [events]);
  const allDay = useMemo(() => eventsByDay(events.filter((e) => e.all_day), dayKeys), [events, dayKeys]);
  const byDay = useMemo(() => eventsByDay(timed, dayKeys), [timed, dayKeys]);
  const placedByDay = useMemo(() => {
    const m = new Map<string, PlacedEvent[]>();
    dayKeys.forEach((k) => m.set(k, layoutDay(byDay.get(k) ?? [], k)));
    return m;
  }, [byDay, dayKeys]);

  // Scroll to 07:00 on mount; update the now line every minute
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 7 * HOUR_PX });
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  /** Pointer position → (day index, minutes). */
  const locate = useCallback((clientX: number, clientY: number): { dayIdx: number; min: number } | null => {
    const body = bodyRef.current;
    if (!body) return null;
    const r = body.getBoundingClientRect();
    const x = clientX - r.left;
    // r.top moves with scrolling (dayCols fills the full 24h inside the
    // scroll container) → y is directly the position in the 24h grid.
    const y = clientY - r.top;
    if (x < 0) return null;
    const colW = r.width / days.length;
    const dayIdx = Math.max(0, Math.min(days.length - 1, Math.floor(x / colW)));
    const min = snapTo15((y / HOUR_PX) * 60);
    return { dayIdx, min };
  }, [days.length]);

  const dateAt = useCallback((dayIdx: number, min: number): Date => {
    const d = new Date(days[dayIdx]);
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    return d;
  }, [days]);

  // Drag starts only after 5px of movement — otherwise EVERY click on a
  // block would start a drag (the block unmounts for the ghost → click never
  // fires → editor unreachable; observed in E2E tests).
  const pendingRef = useRef<{ placed: PlacedEvent; kind: "move" | "resize"; x: number; y: number } | null>(null);
  const justDraggedRef = useRef(0);

  const beginDrag = useCallback((e: React.PointerEvent, placed: PlacedEvent, kind: "move" | "resize") => {
    pendingRef.current = { placed, kind, x: e.clientX, y: e.clientY };
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending && !drag) {
        if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < 5) return;
        const loc = locate(pending.x, pending.y);
        if (!loc) { pendingRef.current = null; return; }
        pendingRef.current = null;
        setDrag({
          kind: pending.kind, ev: pending.placed.ev,
          durMin: pending.placed.endMin - pending.placed.startMin,
          grabOffsetMin: loc.min - pending.placed.startMin,
          day: ymdOf(days[loc.dayIdx]),
          startMin: pending.placed.startMin,
          endMin: pending.placed.endMin,
        });
        return;
      }
      if (!drag) return;
      const loc = locate(e.clientX, e.clientY);
      if (!loc) return;
      setDrag((cur) => {
        if (!cur) return cur;
        if (cur.kind === "move") {
          const start = snapTo15(loc.min - cur.grabOffsetMin);
          return { ...cur, day: ymdOf(days[loc.dayIdx]), startMin: start, endMin: start + cur.durMin };
        }
        return { ...cur, endMin: Math.max(cur.startMin + 15, loc.min) };
      });
    };
    const up = () => {
      pendingRef.current = null;
      setDrag((cur) => {
        if (cur) {
          justDraggedRef.current = Date.now();
          const dayIdx = dayKeys.indexOf(cur.day);
          const start = dateAt(dayIdx === -1 ? 0 : dayIdx, cur.startMin);
          const end = dateAt(dayIdx === -1 ? 0 : dayIdx, cur.endMin);
          onEventMoved(cur.ev, start.toISOString(), end.toISOString());
        }
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, locate, dateAt, dayKeys, days, onEventMoved]);

  const now = new Date(nowTick);
  const nowKey = ymdOf(now);
  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <div className={styles.timeGridWrap}>
      {/* All-day row */}
      <div className={styles.allDayRow} style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <div className={styles.allDayLabel}>{t("calendar.allDay")}</div>
        {dayKeys.map((k) => (
          <div key={k} className={styles.allDayCell}>
            {(allDay.get(k) ?? []).map((ev) => (
              <div key={`${ev.uid}-${ev.recurrence_id ?? ""}`}
                   className={`${styles.allDayChip} ${busyClassOf(ev)}`}
                   style={ev.color ? { borderLeftColor: ev.color } : undefined}
                   onClick={() => onEventClick(ev)}>
                {ev.is_recurring ? "↻ " : ""}{ev.summary}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className={styles.timeGridScroll} ref={scrollRef}>
        <div className={styles.timeGridBody}
             style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)`, height: 24 * HOUR_PX }}>
          {/* Hour column */}
          <div className={styles.timeCol}>
            {hours.map((h) => (
              <div key={h} className={styles.timeColHour} style={{ top: h * HOUR_PX }}>
                {String(h).padStart(2, "0")}:00
              </div>
            ))}
          </div>
          {/* Day columns */}
          <div className={styles.dayCols} ref={bodyRef} style={{ gridColumn: `2 / span ${days.length}` }}>
            {days.map((_d, i) => {
              const key = dayKeys[i];
              const placed = placedByDay.get(key) ?? [];
              return (
                <div key={key} className={styles.dayCol}
                     onClick={(e) => {
                       // A click right after a drag is the drop's echo, not a create
                       if (Date.now() - justDraggedRef.current < 300) return;
                       const loc = locate(e.clientX, e.clientY);
                       if (loc) onSlotClick(dateAt(i, loc.min));
                     }}
                     onDragOver={(e) => {
                       if (!onTaskDrop || !e.dataTransfer.types.includes("claraos/task")) return;
                       e.preventDefault();
                       const loc = locate(e.clientX, e.clientY);
                       if (loc) setDropSlot({ day: key, min: loc.min });
                     }}
                     onDragLeave={() => setDropSlot((cur) => (cur?.day === key ? null : cur))}
                     onDrop={(e) => {
                       if (!onTaskDrop) return;
                       const raw = e.dataTransfer.getData("claraos/task");
                       if (!raw) return;
                       e.preventDefault();
                       setDropSlot(null);
                       const [tid, pid, est] = raw.split(":").map(Number);
                       const loc = locate(e.clientX, e.clientY);
                       if (tid && pid && loc) onTaskDrop(tid, pid, est || 60, dateAt(i, loc.min));
                     }}>
                  {hours.map((h) => (
                    <div key={h} className={styles.hourLine} style={{ top: h * HOUR_PX }} />
                  ))}
                  {placed.map((p) => (
                    (drag && drag.ev.uid === p.ev.uid && (drag.ev.recurrence_id ?? "") === (p.ev.recurrence_id ?? "")) ? null : (
                      <EventBlock key={`${p.ev.uid}-${p.ev.recurrence_id ?? ""}`}
                                  placed={p} hourPx={HOUR_PX}
                                  onClick={onEventClick}
                                  onMoveStart={interactive ? (e, pl) => beginDrag(e, pl, "move") : undefined}
                                  onResizeStart={interactive ? (e, pl) => beginDrag(e, pl, "resize") : undefined} />
                    )
                  ))}
                  {/* Drag-Ghost */}
                  {drag && drag.day === key && (
                    <div className={`${styles.evBlock} ${styles.evGhost}`}
                         style={{
                           top: (drag.startMin / 60) * HOUR_PX,
                           height: Math.max(((drag.endMin - drag.startMin) / 60) * HOUR_PX, 18),
                           left: 0, width: "calc(100% - 2px)",
                         }}>
                      <span className={styles.evTime}>
                        {`${String(Math.floor(drag.startMin / 60)).padStart(2, "0")}:${String(drag.startMin % 60).padStart(2, "0")}`}
                        –{`${String(Math.floor(drag.endMin / 60)).padStart(2, "0")}:${String(drag.endMin % 60).padStart(2, "0")}`}
                      </span>
                      <span className={styles.evTitle}>{drag.ev.summary}</span>
                    </div>
                  )}
                  {/* Task drop marker */}
                  {dropSlot?.day === key && (
                    <div className={styles.slotHover} style={{ top: (dropSlot.min / 60) * HOUR_PX }} />
                  )}
                  {/* Now line */}
                  {key === nowKey && (
                    <div className={styles.nowLine}
                         style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
