/** Event editor (dialogOverlay pattern): title, location, description, times,
 * all-day, calendar (writable only), availability (Outlook), simple
 * recurrence, reminder, attendees from Nextcloud contacts, delete. */
import { useEffect, useRef, useState } from "react";
import styles from "../../PlannerApp.module.css";
import { Icon } from "../../../../components/Icon";
import { ConflictError, kalenderApi, ncApi, plannerApi, type AttendeeOut, type BusyStatus, type CalEventFull, type EventWrite, type Person } from "../../api";
import { EinladungAntwort, FreiGebucht } from "./Phase5";
import { useTranslation } from "@claraos/core";

export interface EditorInit {
  mode: "create" | "edit";
  ev?: CalEventFull;       // edit: loaded master
  instance?: CalEventFull; // edit: the clicked instance of a series ("this event only")
  start?: Date;            // create: pre-filled slot
  allDay?: boolean;
}

const TZ_OPTIONS = [
  "Europe/Berlin", "Europe/London", "Europe/Lisbon", "Europe/Athens", "Europe/Istanbul", "Europe/Moscow",
  "America/New_York", "America/Chicago", "America/Los_Angeles", "America/Sao_Paulo",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "UTC",
];

/** Wall time "YYYY-MM-DDTHH:MM" in time zone `tz` → ISO UTC. */
function wallToIso(local: string, tz: string): string {
  const guess = new Date(`${local}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return new Date(guess.getTime() - (asUtc - guess.getTime())).toISOString();
}

// Option lists: values are API values, labels are translated at render time.
const BUSY_OPTIONS: { value: BusyStatus; dot: string }[] = [
  { value: "free", dot: "🟢" },
  { value: "busy", dot: "🔵" },
  { value: "tentative", dot: "🟡" },
  { value: "oof", dot: "🟣" },
];
const FREQ_OPTIONS: { value: string; key: string }[] = [
  { value: "", key: "none" },
  { value: "DAILY", key: "daily" },
  { value: "WEEKLY", key: "weekly" },
  { value: "MONTHLY", key: "monthly" },
  { value: "YEARLY", key: "yearly" },
];
const ALARM_MINUTES = ["", "5", "15", "30", "60", "1440"];

/** Reminder label key + count: "n minutes/hours/days before". */
function alarmLabel(value: string): [string, number] {
  if (value === "") return ["event.alarm.none", 0];
  const m = Number(value);
  if (m % 1440 === 0) return ["event.alarm.daysBefore", m / 1440];
  if (m % 60 === 0) return ["event.alarm.hoursBefore", m / 60];
  return ["event.alarm.minutesBefore", m];
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function isoToLocalInput(iso: string): string {
  return toLocalInput(new Date(iso));
}

const PARTSTAT_BADGE: Record<string, string> = {
  ACCEPTED: "✓", DECLINED: "✗", TENTATIVE: "~", "NEEDS-ACTION": "?",
};

export function EventEditor({
  init, calendars, onClose, onSaved, onDeleted, onError,
}: {
  init: EditorInit;
  calendars: { name: string; color?: string; writable?: boolean }[];
  onClose: () => void;
  onSaved: (warning?: string) => void;
  onDeleted: () => void;
  /** `konflikt` = 409: the event was changed elsewhere. The view must
   * then RELOAD, otherwise it keeps showing the outdated state. */
  onError: (msg: string, konflikt?: boolean) => void;
}) {
  const { t } = useTranslation("planner");
  const ev = init.ev;
  const inst = init.instance && init.instance.recurrence_id ? init.instance : undefined;
  const [scope, setScope] = useState<"this" | "series">(inst ? "this" : "series");
  const timeSrc = scope === "this" && inst ? inst : ev;
  const defStart = init.start ?? new Date();
  const defEnd = new Date(defStart.getTime() + 3600_000);
  const [summary, setSummary] = useState(ev?.summary ?? "");
  const [location, setLocation] = useState(ev?.location ?? "");
  const [description, setDescription] = useState(ev?.description ?? "");
  const [allDay, setAllDay] = useState(ev?.all_day ?? init.allDay ?? false);
  const [tzid, setTzid] = useState("Europe/Berlin");
  const [people, setPeople] = useState<Person[]>([]);
  const [myAddresses, setMyAddresses] = useState<string[]>([]);
  const [showFb, setShowFb] = useState(false);
  const [start, setStart] = useState(timeSrc ? (timeSrc.all_day ? timeSrc.start.slice(0, 10) : isoToLocalInput(timeSrc.start)) : (init.allDay ? toLocalInput(defStart).slice(0, 10) : toLocalInput(defStart)));
  const [end, setEnd] = useState(timeSrc ? (timeSrc.all_day ? timeSrc.end.slice(0, 10) : isoToLocalInput(timeSrc.end || timeSrc.start)) : (init.allDay ? toLocalInput(defStart).slice(0, 10) : toLocalInput(defEnd)));
  const [calendar, setCalendar] = useState(ev?.calendar ?? calendars.find((c) => c.writable !== false)?.name ?? "");
  const [busy, setBusy] = useState<BusyStatus>(ev?.busy_status ?? "busy");
  const customRRule = !!ev && !!ev.rrule_raw && !ev.rrule_simple;
  const [freq, setFreq] = useState(ev?.rrule_simple?.freq ?? "");
  const [until, setUntil] = useState(ev?.rrule_simple?.until ?? "");
  const [alarm, setAlarm] = useState(ev?.alarm_minutes != null ? String(ev.alarm_minutes) : "");
  const [attendees, setAttendees] = useState<{ email: string; name?: string | null; partstat?: string }[]>(
    (ev?.attendees ?? []).map((a: AttendeeOut) => ({ email: a.email, name: a.name, partstat: a.partstat })));
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const writableCals = calendars.filter((c) => c.writable !== false);

  useEffect(() => {
    kalenderApi.people().then((r) => { setPeople(r.people); setMyAddresses(r.me.addresses.map((a) => a.toLowerCase())); }).catch(() => undefined);
  }, []);

  // Series toggle: take over the times of the instance or of the master
  const switchScope = (sc: "this" | "series") => {
    setScope(sc);
    const src = sc === "this" && inst ? inst : ev;
    if (!src) return;
    setStart(src.all_day ? src.start.slice(0, 10) : isoToLocalInput(src.start));
    setEnd(src.all_day ? src.end.slice(0, 10) : isoToLocalInput(src.end || src.start));
  };

  const toIso = (local: string) => (tzid === "Europe/Berlin" ? new Date(local).toISOString() : wallToIso(local, tzid));
  const attendeeUsernames = attendees
    .map((a) => people.find((p) => p.email.toLowerCase() === a.email.toLowerCase())?.username)
    .filter((u): u is string => !!u);
  const organizerIsMe = !ev?.organizer || myAddresses.includes(ev.organizer.replace(/^mailto:/i, "").toLowerCase());
  const myAttendee = (ev?.attendees ?? []).find((a) => myAddresses.includes(a.email.toLowerCase()));
  const canRespond = init.mode === "edit" && !!ev && !organizerIsMe && !!myAttendee;

  const save = async () => {
    if (!summary.trim() || saving) return;
    setSaving(true);
    try {
      const body: EventWrite & { rrule_keep?: boolean; only_this?: boolean; recurrence_id?: string | null } = {
        summary: summary.trim(),
        start: allDay ? start.slice(0, 10) : toIso(start),
        end: allDay ? end.slice(0, 10) : toIso(end),
        all_day: allDay,
        calendar,
        location: location.trim() || null,
        description: description.trim() || null,
        busy_status: busy,
        alarm_minutes: alarm === "" ? null : Number(alarm),
        attendees: attendees.map((a) => ({ email: a.email, name: a.name ?? undefined })),
        tzid: allDay || tzid === "Europe/Berlin" ? null : tzid,
      };
      if (scope === "this" && inst && ev) {
        body.only_this = true;
        body.recurrence_id = inst.recurrence_id;
        body.rrule_keep = true;
        body.rrule = null;
      } else if (customRRule) {
        body.rrule_keep = true;
        body.rrule = null;
      } else if (freq) {
        body.rrule = { freq: freq as "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY", interval: 1, until: until || null };
      } else {
        body.rrule = null;
      }
      const res = init.mode === "edit" && ev
        ? await plannerApi.updateEvent(ev.uid, ev.calendar, body)
        : await plannerApi.createEvent(body);
      onSaved(res.warning);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e), e instanceof ConflictError);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!ev || saving) return;
    setSaving(true);
    try {
      await plannerApi.deleteEvent(ev.uid, ev.calendar, scope === "this" && inst ? inst.recurrence_id : null);
      onDeleted();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e), e instanceof ConflictError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.dialogOverlay} onClick={onClose}>
      <div className={`${styles.dialog} ${styles.eventDialog}`} onClick={(e) => e.stopPropagation()}>
        <h3>{init.mode === "edit" ? t("event.editTitle") : t("event.newTitle")}
          {ev?.is_recurring && !inst ? <span className={styles.hintInline}> ↻ {t("event.wholeSeriesHint")}</span> : null}
        </h3>
        {inst && (
          <div className={styles.calSwitch}>
            <button className={`${styles.projTab} ${scope === "this" ? styles.projTabActive : ""}`} onClick={() => switchScope("this")}>{t("event.onlyThis")}</button>
            <button className={`${styles.projTab} ${scope === "series" ? styles.projTabActive : ""}`} onClick={() => switchScope("series")}>↻ {t("event.wholeSeries")}</button>
          </div>
        )}
        {canRespond && (
          <EinladungAntwort uid={ev!.uid} calendar={ev!.calendar} myPartstat={myAttendee?.partstat}
                            onDone={(m) => onSaved(m)} onError={(m) => onError(m)} />
        )}
        <input className={styles.input} autoFocus placeholder={t("event.titlePlaceholder")} value={summary}
               onChange={(e) => setSummary(e.target.value)} />
        <div className={styles.fieldRow}>
          <label>{t("event.allDay")}</label>
          <input type="checkbox" className={styles.selectCheck} checked={allDay}
                 onChange={(e) => {
                   const v = e.target.checked;
                   setAllDay(v);
                   if (v) { setStart(start.slice(0, 10)); setEnd(end.slice(0, 10) || start.slice(0, 10)); }
                   else {
                     setStart(`${start.slice(0, 10)}T09:00`);
                     setEnd(`${end.slice(0, 10) || start.slice(0, 10)}T10:00`);
                   }
                 }} />
        </div>
        <div className={styles.fieldRow}>
          <label>{t("event.start")}</label>
          <input type={allDay ? "date" : "datetime-local"} className={styles.input} value={start}
                 onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label>{t("event.end")}</label>
          <input type={allDay ? "date" : "datetime-local"} className={styles.input} value={end}
                 onChange={(e) => setEnd(e.target.value)} />
        </div>
        {!allDay && (
          <div className={styles.fieldRow}>
            <label>{t("event.timezone")}</label>
            <select className={styles.select} value={tzid} onChange={(e) => setTzid(e.target.value)}>
              {TZ_OPTIONS.map((z) => <option key={z} value={z}>{z.replace("_", " ")}</option>)}
            </select>
          </div>
        )}
        <div className={styles.fieldRow}>
          <label>{t("event.calendar")}</label>
          <select className={styles.select} value={calendar} onChange={(e) => setCalendar(e.target.value)}
                  disabled={init.mode === "edit"}>
            {writableCals.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            {init.mode === "edit" && !writableCals.some((c) => c.name === calendar) && (
              <option value={calendar}>{calendar}</option>
            )}
          </select>
        </div>
        <div className={styles.fieldRow}>
          <label>{t("event.showAs")}</label>
          <select className={styles.select} value={busy} onChange={(e) => setBusy(e.target.value as BusyStatus)}>
            {BUSY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.dot} {t(`calendar.busy.${o.value}`)}</option>)}
          </select>
        </div>
        <div className={styles.fieldRow}>
          <label>{t("event.location")}</label>
          <input className={styles.input} value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
        {scope === "this" && inst ? (
          <div className={styles.hint}>{t("event.onlyThisHint")}</div>
        ) : customRRule ? (
          <div className={styles.hint}>{t("event.customRecurrence")}</div>
        ) : (
          <div className={styles.fieldRow}>
            <label>{t("event.recurrence")}</label>
            <select className={styles.select} value={freq} onChange={(e) => setFreq(e.target.value)}>
              {FREQ_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(`event.freq.${o.key}`)}</option>)}
            </select>
            {freq && (
              <input type="date" className={styles.input} title={t("event.recurrenceUntil")}
                     value={until} onChange={(e) => setUntil(e.target.value)} />
            )}
          </div>
        )}
        <div className={styles.fieldRow}>
          <label>{t("event.reminder")}</label>
          <select className={styles.select} value={alarm} onChange={(e) => setAlarm(e.target.value)}>
            {ALARM_MINUTES.map((v) => {
              const [key, count] = alarmLabel(v);
              return <option key={v} value={v}>{t(key, { count })}</option>;
            })}
          </select>
        </div>

        {/* Attendees (Nextcloud contacts) — Nextcloud sends iMIP invitations server-side */}
        <div className={styles.detailSection}>
          <h4>{t("event.attendees")}</h4>
          <div className={styles.labelPicker}>
            {attendees.map((a, i) => (
              <span key={a.email} className={`${styles.labelChip} ${styles.labelChipActive}`}
                    title={a.partstat ?? ""}>
                {PARTSTAT_BADGE[a.partstat ?? ""] ?? ""} {a.name || a.email}
                <button className={styles.savedChipDel}
                        onClick={() => setAttendees(attendees.filter((_, j) => j !== i))}><Icon name="close" size={14} title={t("actions.close")} /></button>
              </span>
            ))}
            <ContactPicker
              exclude={attendees.map((a) => a.email)}
              onPick={(email, name) => setAttendees([...attendees, { email, name }])} />
          </div>
          {people.length > 0 && (
            <div className={styles.labelPicker} style={{ marginTop: 6 }}>
              <span className={styles.hintInline}>{t("event.family")}</span>
              {people.filter((p) => !myAddresses.includes(p.email.toLowerCase()) && !attendees.some((a) => a.email.toLowerCase() === p.email.toLowerCase())).map((p) => (
                <button key={p.username} className={styles.labelChip} title={p.email}
                        onClick={() => setAttendees([...attendees, { email: p.email, name: p.name }])}>+ {p.name}</button>
              ))}
              {!allDay && (
                <button className={`${styles.labelChip} ${showFb ? styles.labelChipActive : ""}`} onClick={() => setShowFb(!showFb)}>
                  {showFb ? t("event.hideFreeBusy") : t("event.checkFreeBusy")}
                </button>
              )}
            </div>
          )}
          {showFb && !allDay && (
            <FreiGebucht people={people} attendeeUsernames={attendeeUsernames}
                         start={new Date(start)} end={new Date(end)}
                         onPick={(s, e) => { setStart(toLocalInput(s)); setEnd(toLocalInput(e)); }} />
          )}
        </div>

        <div className={styles.fieldRow}>
          <label>{t("event.notes")}</label>
          <textarea className={styles.textarea} rows={2} value={description}
                    onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className={styles.dialogActions}>
          {init.mode === "edit" && (
            confirmDelete ? (
              <button className={styles.btnDanger} disabled={saving} onClick={del}>
                {scope === "this" && inst ? t("event.confirmDeleteThis")
                  : ev?.is_recurring ? t("event.confirmDeleteSeries") : t("event.confirmDelete")}
              </button>
            ) : (
              <button className={styles.btnDanger} disabled={saving} onClick={() => setConfirmDelete(true)}>{t("actions.delete")}</button>
            )
          )}
          <span style={{ flex: 1 }} />
          <button className={styles.btn} onClick={onClose}>{t("actions.cancel")}</button>
          <button className={styles.btnPrimary} disabled={saving || !summary.trim()} onClick={save}>
            {saving ? t("event.saving") : t("actions.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Debounced search over Nextcloud contacts (nc_pim /contacts/list). */
function ContactPicker({
  exclude, onPick,
}: {
  exclude: string[];
  onPick: (email: string, name?: string) => void;
}) {
  const { t } = useTranslation("planner");
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ name: string; emails: string[]; org?: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!editing) return;
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setHits([]); return; }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        setHits((await ncApi.contactsList(q.trim())).slice(0, 8));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, editing]);

  if (!editing) {
    return <button className={styles.labelChip} onClick={() => setEditing(true)}>+ {t("event.contact.add")}</button>;
  }
  return (
    <div className={styles.pickerWrap}>
      <input className={styles.input} autoFocus placeholder={t("event.contact.searchPlaceholder")} value={q}
             onChange={(e) => setQ(e.target.value)}
             onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setQ(""))} />
      {(hits.length > 0 || searching) && (
        <div className={styles.pickerPop}>
          {searching && <span className={styles.pickerItem}>{t("event.contact.searching")}</span>}
          {hits.map((c) => {
            const email = c.emails.find((x) => !exclude.includes(x));
            return (
              <button key={`${c.name}-${c.emails[0] ?? ""}`} className={styles.pickerItem}
                      disabled={!email}
                      title={email ?? t("event.contact.noEmailTitle")}
                      onClick={() => {
                        if (!email) return;
                        onPick(email, c.name);
                        setEditing(false); setQ(""); setHits([]);
                      }}>
                {c.name}{c.org ? ` · ${c.org}` : ""} {email ? `<${email}>` : t("event.contact.noEmail")}
              </button>
            );
          })}
        </div>
      )}
      <button className={styles.btn} onClick={() => { setEditing(false); setQ(""); }}><Icon name="close" size={14} title={t("actions.close")} /></button>
    </div>
  );
}
