// Calendar widget v2 (desktop + mobile homescreen): Nextcloud calendar.
// Agenda ⇄ mini month, composer with date/time/target calendar, inline detail
// with edit/delete, calendar selection (coloured) in the settings.
// All writes go to nc_pim (per-user CalDAV). Known limitation: RRULE is not
// expanded — recurring events appear only as the master event.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore, useTranslation, i18n } from "@claraos/core";
import type { WidgetProps } from "./registry";
import {
  CheckList,
  CheckRow,
  GroupLabel,
  SettingsOverlay,
  useWidgetSettingsOpen,
} from "./settingsControls";
import s from "./MobileListWidgets.module.css";
import c from "./CalendarWidget.module.css";
import { regionLocale } from "@claraos/core";

interface NcEvent {
  summary: string;
  start: string; // ISO datetime, or YYYY-MM-DD for all-day
  end: string;
  location: string;
  uid: string;
  calendar: string;
  color: string;
}

interface NcCalendar {
  name: string;
  color: string;
  writable: boolean;
}

const POLL_MS = 5 * 60 * 1000;

const isAllDay = (ev: NcEvent) => ev.start.length === 10;
const unescapeIcs = (v: string) => v.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ");
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr.length === 10 ? `${dateStr}T12:00:00` : dateStr);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return i18n.t("desktop:widgets.calendar.today");
  if (sameDay(d, tomorrow)) return i18n.t("desktop:widgets.calendar.tomorrow");
  const dm = d.toLocaleDateString(regionLocale(), { day: "numeric", month: "long" });
  const wd = d.toLocaleDateString(regionLocale(), { weekday: "long" }).toUpperCase();
  return `${dm} · ${wd}`;
}

function timeLabel(ev: NcEvent): string {
  if (isAllDay(ev)) return "24H";
  return new Date(ev.start).toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" });
}

/** Composer/editor state */
interface Draft {
  summary: string;
  date: string;      // YYYY-MM-DD
  allDay: boolean;
  from: string;      // HH:MM
  to: string;
  calendar: string;  // target (only when creating)
  uid?: string;      // set = editing
}

const emptyDraft = (date?: string): Draft => ({
  summary: "",
  date: date ?? ymd(new Date()),
  allDay: false,
  from: "12:00",
  to: "13:00",
  calendar: "",
});

/** Extract the message from an error response. FastAPI puts it in `detail`;
 * shown raw, the user would see JSON brackets instead of a sentence. */
async function meldung(r: Response, rueckfall: string): Promise<string> {
  try {
    const j = await r.json();
    if (typeof j?.detail === "string" && j.detail.trim()) return j.detail;
  } catch {
    /* not JSON */
  }
  return rueckfall;
}

export default function CalendarAgendaWidget({ widgetId, config, guardRef, onOpenApp }: WidgetProps) {
  const { t: tr } = useTranslation("desktop");
  const updateWidgetConfig = useWorkspaceStore((st) => st.updateWidgetConfig);
  const cfgCalendars: string[] = Array.isArray(config?.calendars) ? (config.calendars as string[]) : [];

  const [events, setEvents] = useState<NcEvent[] | null>(null);
  const [error, setError] = useState(false);
  // A failed save must never vanish SILENTLY (`if (r.ok)` and nothing else).
  // The server answers a concurrent change with 409, which would be the most
  // common case: the event looks saved but is not.
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<NcCalendar[]>([]);
  const [view, setView] = useState<"agenda" | "month">(
    config?.view === "month" ? "month" : "agenda",
  );
  const [monthCursor, setMonthCursor] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [openUid, setOpenUid] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const [settingsOpen, setSettingsOpen] = useWidgetSettingsOpen(widgetId);
  const [draftCals, setDraftCals] = useState<string[]>(cfgCalendars);

  // ── Load data ────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/claraos/nc/calendar/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          days: 62,
          days_past: 31, // month view also needs past days
          calendars: cfgCalendars.length ? cfgCalendars : undefined,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (!aliveRef.current) return;
      setEvents(Array.isArray(data.events) ? data.events : []);
      setError(false);
    } catch {
      if (aliveRef.current) setError(true);
    }
  }, [cfgCalendars.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    aliveRef.current = true;
    load();
    const iv = setInterval(load, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      aliveRef.current = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  // calendar list (colours, target selection) — loaded once
  useEffect(() => {
    fetch("/api/claraos/nc/calendar/calendars", { method: "POST" })
      .then((r) => (r.ok ? r.json() : { calendars: [] }))
      .then((d) => setCalendars(Array.isArray(d.calendars) ? d.calendars : []))
      .catch(() => {});
  }, []);

  const writableCals = useMemo(() => calendars.filter((x) => x.writable), [calendars]);

  // ── Create / edit / delete ──────────────────────────────────────────────
  const submitDraft = useCallback(async () => {
    if (!draft || !draft.summary.trim()) return;
    const start = draft.allDay ? draft.date : `${draft.date}T${draft.from}:00`;
    const end = draft.allDay ? undefined : `${draft.date}T${draft.to}:00`;
    const isEdit = !!draft.uid;
    const payload = isEdit
      ? { uid: draft.uid, summary: draft.summary.trim(), start, end: end ?? "" }
      : {
          summary: draft.summary.trim(),
          start,
          end,
          calendar: draft.calendar || undefined,
        };
    setDraft(null);
    setOpenUid(null);
    try {
      const r = await fetch(`/api/claraos/nc/calendar/${isEdit ? "update" : "add"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        setHinweis(null);
        setTimeout(load, 500);
      } else {
        setHinweis(await meldung(r, i18n.t("desktop:widgets.calendar.saveFailed")));
        load();   // on 409 the other party's version is correct — show it right away
      }
    } catch {
      setHinweis(i18n.t("desktop:widgets.calendar.unreachableNotSaved"));
    }
  }, [draft, load]);

  const deleteEvent = useCallback(
    async (ev: NcEvent) => {
      if (!window.confirm(i18n.t("desktop:widgets.calendar.confirmDelete", { title: unescapeIcs(ev.summary) || i18n.t("desktop:widgets.calendar.eventFallback") }))) return;
      setOpenUid(null);
      setEvents((prev) => (prev ?? []).filter((x) => x.uid !== ev.uid)); // optimistic
      try {
        const r = await fetch("/api/claraos/nc/calendar/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid: ev.uid }),
        });
        // Important: the removal above was optimistic. If it fails, the row
        // must come back — otherwise the user believes the event was deleted.
        if (!r.ok) setHinweis(await meldung(r, i18n.t("desktop:widgets.calendar.deleteFailed")));
        else setHinweis(null);
        setTimeout(load, 500);
      } catch {
        setHinweis(i18n.t("desktop:widgets.calendar.unreachableNotDeleted"));
        load();
      }
    },
    [load],
  );

  const startEdit = useCallback((ev: NcEvent) => {
    const allDay = isAllDay(ev);
    const st = allDay ? null : new Date(ev.start);
    const en = !allDay && ev.end ? new Date(ev.end) : null;
    const hm = (d: Date | null, fb: string) =>
      d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : fb;
    setDraft({
      summary: unescapeIcs(ev.summary),
      date: ev.start.slice(0, 10),
      allDay,
      from: hm(st, "12:00"),
      to: hm(en, "13:00"),
      calendar: ev.calendar,
      uid: ev.uid,
    });
  }, []);

  const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();
  const openApp = () => {
    if (!guardRef?.current) onOpenApp?.();
  };

  const saveSettings = useCallback(() => {
    updateWidgetConfig(widgetId, { calendars: draftCals, view });
    setSettingsOpen(false);
    setEvents(null);
  }, [widgetId, draftCals, view, updateWidgetConfig, setSettingsOpen]);

  const toggleView = useCallback(() => {
    const v = view === "agenda" ? "month" : "agenda";
    setView(v);
    setSelectedDay(null);
    updateWidgetConfig(widgetId, { calendars: cfgCalendars, view: v });
  }, [view, widgetId, cfgCalendars, updateWidgetConfig]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const today = new Date();
  const todayStr = ymd(today);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, NcEvent[]>();
    for (const ev of events ?? []) {
      if (!ev.start) continue;
      const key = ev.start.slice(0, 10);
      const list = map.get(key) ?? [];
      list.push(ev);
      map.set(key, list);
    }
    return map;
  }, [events]);

  const upcoming = useMemo(
    () => (events ?? []).filter((ev) => ev.start && ev.start.slice(0, 10) >= todayStr),
    [events, todayStr],
  );

  // agenda row (shared between agenda view and month day list)
  const renderRow = (ev: NcEvent, i: number) => (
    <div key={`${ev.uid}-${i}`}>
      <div
        className={s.row}
        onClick={(e) => {
          stop(e);
          if (guardRef?.current) return;
          setOpenUid((u) => (u === ev.uid ? null : ev.uid));
          setDraft(null);
        }}
      >
        <span
          className={c.calDot}
          style={{ background: ev.color || "#7b9fff" }}
          title={ev.calendar}
        />
        <span className={`${s.time} ${isAllDay(ev) ? s.allday : ""}`}>{timeLabel(ev)}</span>
        <span className={s.title}>{ev.summary ? unescapeIcs(ev.summary) : tr("widgets.calendar.untitled")}</span>
        {ev.location && <span className={s.loc}>{unescapeIcs(ev.location)}</span>}
      </div>
      {openUid === ev.uid && !draft && (
        <div className={c.detail} onPointerDown={stop}>
          <div className={c.detailMeta}>
            {dayLabel(ev.start)}
            {!isAllDay(ev) && ` · ${timeLabel(ev)}${ev.end ? `–${new Date(ev.end).toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" })}` : ""}`}
            {` · ${ev.calendar}`}
            {ev.location ? ` · ${unescapeIcs(ev.location)}` : ""}
          </div>
          <div className={c.detailActions}>
            <button className={c.dBtn} onClick={(e) => { stop(e); startEdit(ev); }}>
              {tr("widgets.calendar.edit")}
            </button>
            <button className={`${c.dBtn} ${c.dDanger}`} onClick={(e) => { stop(e); deleteEvent(ev); }}>
              {tr("widgets.calendar.delete")}
            </button>
            <button className={c.dBtn} onClick={(e) => { stop(e); openApp(); }}>
              {tr("widgets.calendar.inCalendar")}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // agenda grouped
  const agendaRows: Array<{ kind: "head"; label: string } | { kind: "event"; ev: NcEvent; i: number }> = [];
  {
    let last = "";
    upcoming.forEach((ev, i) => {
      const label = dayLabel(ev.start);
      if (label !== last) {
        agendaRows.push({ kind: "head", label });
        last = label;
      }
      agendaRows.push({ kind: "event", ev, i });
    });
  }

  // month grid (Mon-Sun)
  const monthDays = useMemo(() => {
    const first = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // Monday = 0
    const start = new Date(first);
    start.setDate(1 - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [monthCursor]);

  const shiftMonth = (delta: number) =>
    setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));

  const dayEvents = selectedDay ? (eventsByDay.get(selectedDay) ?? []) : [];

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className={s.widget}>
      <div className={s.header}>
        <span className={s.headerDay}>{today.getDate()}</span>
        <span className={s.headerMeta}>
          {today.toLocaleDateString(regionLocale(), { weekday: "long", month: "long" })}
        </span>
        {/* Important: `data-dicht="ja"` is the opt-out from the 44 px minimum
            height provided by `tokens.css`. Reason (required there): four
            round buttons sit in a narrow widget header — at 44 px they push
            out the month name. Without the opt-out they would become 30 x 44,
            i.e. ovals. The touch area stays 44 px, see `.iconBtn::after`. */}
        <span className={s.headerActions} data-dicht="ja">
          <button
            className={s.iconBtn}
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              setDraft((d) => (d ? null : emptyDraft(selectedDay ?? undefined)));
              setOpenUid(null);
            }}
            aria-label={tr("widgets.calendar.add")}
          >
            ＋
          </button>
          <button
            className={s.iconBtn}
            onPointerDown={stop}
            onClick={(e) => { stop(e); toggleView(); }}
            aria-label={view === "agenda" ? tr("widgets.calendar.monthView") : tr("widgets.calendar.listView")}
          >
            {view === "agenda" ? "▦" : "≣"}
          </button>
          <button className={s.iconBtn} onPointerDown={stop} onClick={(e) => { stop(e); load(); }} aria-label={tr("widgets.calendar.refresh")}>
            ⟳
          </button>
          <button className={s.iconBtn} onPointerDown={stop} onClick={(e) => { stop(e); openApp(); }} aria-label={tr("widgets.calendar.open")}>
            ⚙
          </button>
        </span>
      </div>

      {draft && (
        <div className={c.composer2} onPointerDown={stop}>
          <div className={c.composerRow}>
            <input
              className={c.cInput}
              autoFocus
              placeholder={draft.uid ? tr("widgets.calendar.editPlaceholder") : tr("widgets.calendar.newPlaceholder")}
              value={draft.summary}
              onChange={(e) => setDraft((d) => d && { ...d, summary: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitDraft();
                if (e.key === "Escape") setDraft(null);
              }}
            />
          </div>
          <div className={c.composerRow}>
            <input
              type="date"
              className={`${c.cInput} ${c.cDate}`}
              value={draft.date}
              onChange={(e) => setDraft((d) => d && { ...d, date: e.target.value })}
            />
            <label className={c.cCheck}>
              <input
                type="checkbox"
                checked={draft.allDay}
                onChange={(e) => setDraft((d) => d && { ...d, allDay: e.target.checked })}
              />
              {tr("widgets.calendar.allDay")}
            </label>
            {!draft.allDay && (
              <>
                <input
                  type="time"
                  className={`${c.cInput} ${c.cTime}`}
                  value={draft.from}
                  onChange={(e) => setDraft((d) => d && { ...d, from: e.target.value })}
                />
                <input
                  type="time"
                  className={`${c.cInput} ${c.cTime}`}
                  value={draft.to}
                  onChange={(e) => setDraft((d) => d && { ...d, to: e.target.value })}
                />
              </>
            )}
          </div>
          <div className={c.composerRow}>
            {!draft.uid && writableCals.length > 1 && (
              <select
                className={c.cInput}
                value={draft.calendar}
                onChange={(e) => setDraft((d) => d && { ...d, calendar: e.target.value })}
              >
                <option value="">{tr("widgets.calendar.defaultCalendar")}</option>
                {writableCals.map((x) => (
                  <option key={x.name} value={x.name}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
            <button className={c.cBtn} disabled={!draft.summary.trim()} onClick={submitDraft}>
              {draft.uid ? tr("widgets.calendar.save") : tr("widgets.calendar.create")}
            </button>
            <button className={c.dBtn} onClick={() => setDraft(null)}>
              {tr("widgets.calendar.cancel")}
            </button>
          </div>
        </div>
      )}

      {hinweis && (
        <div className={c.hinweisBox} role="alert" onClick={() => setHinweis(null)}>
          {hinweis}
        </div>
      )}

      {view === "agenda" ? (
        <div className={s.scroll}>
          {events === null && !error && <div className={s.empty}>{tr("widgets.calendar.loading")}</div>}
          {events === null && error && <div className={s.empty}>{tr("widgets.calendar.unreachable")}</div>}
          {events !== null && agendaRows.length === 0 && <div className={s.empty}>{tr("widgets.calendar.empty")}</div>}
          {agendaRows.map((r, i) =>
            r.kind === "head" ? (
              <div key={`h-${i}`} className={s.dayHead}>
                {r.label}
              </div>
            ) : (
              renderRow(r.ev, r.i)
            ),
          )}
        </div>
      ) : (
        <div className={c.month} onPointerDown={stop}>
          <div className={c.monthNav}>
            <button className={c.navBtn} onClick={() => shiftMonth(-1)} aria-label={tr("widgets.calendar.prevMonth")}>
              ‹
            </button>
            <span className={c.monthName}>
              {monthCursor.toLocaleDateString(regionLocale(), { month: "long", year: "numeric" })}
            </span>
            <button className={c.navBtn} onClick={() => shiftMonth(1)} aria-label={tr("widgets.calendar.nextMonth")}>
              ›
            </button>
          </div>
          <div className={c.grid}>
            {["mo", "tu", "we", "th", "fr", "sa", "su"].map((w) => (
              <span key={w} className={c.wd}>
                {tr(`widgets.calendar.weekday.${w}`)}
              </span>
            ))}
            {monthDays.map((d) => {
              const key = ymd(d);
              const evs = eventsByDay.get(key) ?? [];
              const other = d.getMonth() !== monthCursor.getMonth();
              return (
                <div
                  key={key}
                  className={`${c.day} ${other ? c.dayOther : ""} ${key === todayStr ? c.dayToday : ""} ${key === selectedDay ? c.daySelected : ""}`}
                  onClick={() => setSelectedDay((cur) => (cur === key ? null : key))}
                >
                  <span>{d.getDate()}</span>
                  <span className={c.dots}>
                    {evs.slice(0, 3).map((ev, i) => (
                      <span key={i} className={c.dot} style={{ background: ev.color || "#7b9fff" }} />
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
          <div className={c.monthAgenda}>
            {selectedDay === null && <div className={s.empty}>{tr("widgets.calendar.tapDay")}</div>}
            {selectedDay !== null && dayEvents.length === 0 && (
              <div className={s.empty}>{tr("widgets.calendar.emptyOn", { date: new Date(`${selectedDay}T12:00:00`).toLocaleDateString(regionLocale()) })}</div>
            )}
            {dayEvents.map((ev, i) => renderRow(ev, i))}
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsOverlay
          title={tr("widgets.calendar.settingsTitle")}
          onCancel={() => setSettingsOpen(false)}
          onSave={saveSettings}
        >
          <GroupLabel>{tr("widgets.calendar.shownCalendars")}</GroupLabel>
          <CheckList>
            {calendars.length === 0 && <span style={{ fontSize: 11, opacity: 0.6 }}>{tr("widgets.calendar.loadingCalendars")}</span>}
            {calendars.map((x) => (
              <CheckRow
                key={x.name}
                label={x.name}
                swatch={x.color || "#7b9fff"}
                checked={draftCals.length === 0 ? true : draftCals.includes(x.name)}
                onChange={(v) => {
                  setDraftCals((cur) => {
                    // empty selection = all → make it explicit on the first deselection
                    const base = cur.length === 0 ? calendars.map((y) => y.name) : cur;
                    return v ? [...new Set([...base, x.name])] : base.filter((n) => n !== x.name);
                  });
                }}
              />
            ))}
          </CheckList>
        </SettingsOverlay>
      )}
    </div>
  );
}
