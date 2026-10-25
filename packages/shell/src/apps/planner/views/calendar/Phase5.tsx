/** Calendar extras: scheduling assistant (free/busy), calendar sharing,
 * invitation responses, calendar settings. */
import { useCallback, useEffect, useState } from "react";
import styles from "../../PlannerApp.module.css";
import { Icon } from "../../../../components/Icon";
import { kalenderApi, plannerApi, type FreeBusyResult, type KalenderFreigabe, type Person } from "../../api";
import { regionLocale, useTranslation } from "@claraos/core";

const H0 = 7;   // grid 07:00–21:00
const H1 = 21;

function fmtT(iso: string): string {
  return new Date(iso).toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" });
}
function fmtD(iso: string): string {
  return new Date(iso).toLocaleDateString(regionLocale(), { weekday: "short", day: "2-digit", month: "2-digit" });
}

/** Free/busy grid for the event's day plus suggestions for free slots. */
export function FreiGebucht({
  people, attendeeUsernames, start, end, onPick,
}: {
  people: Person[];
  attendeeUsernames: string[];
  start: Date;
  end: Date;
  onPick: (start: Date, end: Date) => void;
}) {
  const { t } = useTranslation("planner");
  const [res, setRes] = useState<FreeBusyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [day, setDay] = useState(() => new Date(start.getFullYear(), start.getMonth(), start.getDate()));
  const durMin = Math.max(15, Math.round((end.getTime() - start.getTime()) / 60000) || 60);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const s = new Date(day); s.setHours(0, 0, 0, 0);
      const e = new Date(s.getTime() + 7 * 86400_000);
      setRes(await kalenderApi.freebusy({ people: attendeeUsernames, start: s.toISOString(), end: e.toISOString(), duration_minutes: durMin }));
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }, [attendeeUsernames, day, durMin]);

  useEffect(() => { load(); }, [load]);

  const nameOf = (u: string) => people.find((p) => p.username === u)?.name ?? u;
  const dayStart = new Date(day); dayStart.setHours(H0, 0, 0, 0);
  const span = (H1 - H0) * 60;
  const pct = (d: Date) => Math.max(0, Math.min(100, ((d.getTime() - dayStart.getTime()) / 60000 / span) * 100));
  const evL = pct(start), evR = pct(end);
  const sameDay = start.toDateString() === day.toDateString();

  return (
    <div className={styles.fbWrap}>
      <div className={styles.fbHead}>
        <button className={styles.btn} onClick={() => setDay(new Date(day.getTime() - 86400_000))}>‹</button>
        <span className={styles.calMonthLabel}>{day.toLocaleDateString(regionLocale(), { weekday: "long", day: "numeric", month: "long" })}</span>
        <button className={styles.btn} onClick={() => setDay(new Date(day.getTime() + 86400_000))}>›</button>
        <span style={{ flex: 1 }} />
        <button className={styles.btn} onClick={load} disabled={loading} title={t("calendar.freeBusy.reload")}><Icon name="reload" size={14} /></button>
      </div>
      {err && <div className={styles.errorBox}>{err}</div>}
      <div className={styles.fbGrid}>
        <div className={styles.fbRow}>
          <span className={styles.fbName} />
          <div className={styles.fbTrack}>
            {Array.from({ length: H1 - H0 }, (_, i) => (
              <span key={i} className={styles.fbHour} style={{ left: `${(i / (H1 - H0)) * 100}%` }}>{H0 + i}</span>
            ))}
          </div>
        </div>
        {(res?.people ?? attendeeUsernames.map((u) => ({ username: u, busy: [], available: true }))).map((p) => (
          <div key={p.username} className={styles.fbRow}>
            <span className={styles.fbName} title={p.username}>{nameOf(p.username)}{!p.available ? ` ${t("calendar.freeBusy.noCalendar")}` : ""}</span>
            <div className={styles.fbTrack}>
              {p.busy.filter((b) => new Date(b.end) > dayStart && new Date(b.start) < new Date(dayStart.getTime() + span * 60000)).map((b, i) => {
                const l = pct(new Date(b.start)), r = pct(new Date(b.end));
                return <span key={i} className={`${styles.fbBusy} ${b.status === "tentative" ? styles.fbTentative : ""}`}
                             style={{ left: `${l}%`, width: `${Math.max(1, r - l)}%` }}
                             title={`${fmtT(b.start)}–${fmtT(b.end)}`} />;
              })}
              {sameDay && <span className={styles.fbEvent} style={{ left: `${evL}%`, width: `${Math.max(1, evR - evL)}%` }} title={t("calendar.freeBusy.thisEvent")} />}
            </div>
          </div>
        ))}
      </div>
      {loading && <div className={styles.hint}>{t("calendar.freeBusy.loading")}</div>}
      {res && (
        <div className={styles.fbSuggest}>
          <span className={styles.hint}>{res.suggestions.length ? t("calendar.freeBusy.allFree", { minutes: durMin }) : t("calendar.freeBusy.noSlot")}</span>
          {res.suggestions.map((s) => (
            <button key={s.start} className={styles.labelChip}
                    onClick={() => onPick(new Date(s.start), new Date(s.end))}>
              {fmtD(s.start)} {fmtT(s.start)}–{fmtT(s.end)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Accept / tentative / decline an invitation (plus counter-proposal). */
export function EinladungAntwort({
  uid, calendar, myPartstat, onDone, onError,
}: {
  uid: string; calendar?: string; myPartstat?: string;
  onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const { t } = useTranslation("planner");
  const [comment, setComment] = useState("");
  const [proposal, setProposal] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (partstat: "ACCEPTED" | "TENTATIVE" | "DECLINED") => {
    setBusy(true);
    try {
      const body: Parameters<typeof kalenderApi.antworten>[1] = { partstat, calendar };
      if (comment.trim()) body.comment = comment.trim();
      if (proposal) {
        const s = new Date(proposal);
        body.proposed_start = s.toISOString();
        body.proposed_end = new Date(s.getTime() + 3600_000).toISOString();
      }
      const r = await kalenderApi.antworten(uid, body);
      onDone(r.organizer_notified ? t("event.invitation.savedNotified") : t("event.invitation.saved"));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const cur = myPartstat ?? "NEEDS-ACTION";
  return (
    <div className={styles.detailSection}>
      <h4>{t("event.invitation.title")} {cur !== "NEEDS-ACTION" ? (
        <span className={styles.hintInline}>
          {t("event.invitation.current", {
            status: t(cur === "ACCEPTED" ? "event.invitation.status.accepted"
              : cur === "DECLINED" ? "event.invitation.status.declined" : "event.invitation.status.tentative"),
          })}
        </span>
      ) : null}</h4>
      <div className={styles.labelPicker}>
        <button className={`${styles.btn}`} disabled={busy} onClick={() => send("ACCEPTED")}>✓ {t("event.invitation.accept")}</button>
        <button className={`${styles.btn}`} disabled={busy} onClick={() => send("TENTATIVE")}>~ {t("event.invitation.tentative")}</button>
        <button className={`${styles.btnDanger}`} disabled={busy} onClick={() => send("DECLINED")}>✗ {t("event.invitation.decline")}</button>
      </div>
      <div className={styles.fieldRow}>
        <label>{t("event.invitation.comment")}</label>
        <input className={styles.input} placeholder={t("event.invitation.commentPlaceholder")} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      <div className={styles.fieldRow}>
        <label>{t("event.invitation.proposal")}</label>
        <input type="datetime-local" className={styles.input} title={t("event.invitation.proposalTitle")} value={proposal} onChange={(e) => setProposal(e.target.value)} />
      </div>
    </div>
  );
}

/** Share a calendar with other users (oc:share). */
export function KalenderTeilenDialog({
  calendars, onClose, onNotice,
}: {
  calendars: { name: string; writable?: boolean }[];
  onClose: () => void;
  onNotice: (msg: string) => void;
}) {
  const { t } = useTranslation("planner");
  const own = calendars.filter((c) => c.writable !== false);
  const [cal, setCal] = useState(own[0]?.name ?? "");
  const [people, setPeople] = useState<Person[]>([]);
  const [shares, setShares] = useState<KalenderFreigabe[]>([]);
  const [who, setWho] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { kalenderApi.people().then((r) => setPeople(r.people)).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    if (!cal) return;
    setErr(null);
    try { setShares((await kalenderApi.freigaben(cal)).shares); } catch (e) { setShares([]); setErr(e instanceof Error ? e.message : String(e)); }
  }, [cal]);
  useEffect(() => { load(); }, [load]);

  const apply = async (username: string, remove: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = await kalenderApi.freigeben({ calendar: cal, username, access, remove });
      onNotice(r.message);
      setWho("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const candidates = people.filter((p) => !shares.some((s) => s.username === p.username));

  return (
    <div className={styles.dialogOverlay} onClick={onClose}>
      <div className={`${styles.dialog} ${styles.eventDialog}`} onClick={(e) => e.stopPropagation()}>
        <h3><Icon name="share" size={16} /> {t("calendar.share.title")}</h3>
        <div className={styles.fieldRow}>
          <label>{t("calendar.share.calendar")}</label>
          <select className={styles.select} value={cal} onChange={(e) => setCal(e.target.value)}>
            {own.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </div>
        {err && <div className={styles.errorBox}>{err}</div>}
        <div className={styles.detailSection}>
          <h4>{t("calendar.share.sharedWith")}</h4>
          {shares.length === 0 && <div className={styles.hint}>{t("calendar.share.nobody")}</div>}
          {shares.map((s) => (
            <div key={s.principal} className={styles.attachRow}>
              <Icon name="person" size={14} /> <span style={{ flex: 1 }}>{s.name}</span>
              <span className={styles.hintInline}>{s.access === "write" ? t("calendar.share.canEdit") : t("calendar.share.readOnly")}</span>
              <button className={styles.btn} disabled={busy} title={t("calendar.share.remove")} onClick={() => apply(s.username, true)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className={styles.fieldRow}>
          <label>{t("calendar.share.add")}</label>
          <select className={styles.select} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">{t("calendar.share.choosePerson")}</option>
            {candidates.map((p) => <option key={p.username} value={p.username}>{p.name}</option>)}
          </select>
          <select className={styles.select} value={access} onChange={(e) => setAccess(e.target.value as "read" | "write")}>
            <option value="read">{t("calendar.share.accessRead")}</option>
            <option value="write">{t("calendar.share.accessWrite")}</option>
          </select>
          <button className={styles.btnPrimary} disabled={!who || busy} onClick={() => apply(who, false)}>{t("calendar.share.submit")}</button>
        </div>
        <div className={styles.hint}>{t("calendar.share.hint")}</div>
        <div className={styles.dialogActions}>
          <button className={styles.btn} onClick={onClose}>{t("actions.close")}</button>
        </div>
      </div>
    </div>
  );
}

export interface KalenderPrefs {
  holiday_state?: string;
  reminders_push?: boolean;
  show_holidays?: boolean;
}

/** Small settings: state/region for public holidays, push reminders. */
export function KalenderEinstellungen({
  prefs, states, onChange, onClose,
}: {
  prefs: KalenderPrefs;
  states: { code: string; name: string }[];
  onChange: (p: KalenderPrefs) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("planner");
  const [local, setLocal] = useState<KalenderPrefs>(prefs);
  const save = async () => {
    const all = await plannerApi.getPlannerPrefs();
    await plannerApi.savePlannerPrefs({ ...all, ...local });
    onChange(local);
    onClose();
  };
  return (
    <div className={styles.dialogOverlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3><Icon name="gear" size={16} /> {t("calendar.settings.title")}</h3>
        <div className={styles.fieldRow}>
          <label>{t("calendar.settings.holidays")}</label>
          <input type="checkbox" className={styles.selectCheck} checked={local.show_holidays !== false}
                 onChange={(e) => setLocal({ ...local, show_holidays: e.target.checked })} />
          <select className={styles.select} value={local.holiday_state ?? ""} disabled={local.show_holidays === false}
                  onChange={(e) => setLocal({ ...local, holiday_state: e.target.value })}>
            <option value="">{t("calendar.settings.nationalOnly")}</option>
            {states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </div>
        <div className={styles.fieldRow}>
          <label>{t("calendar.settings.reminders")}</label>
          <input type="checkbox" className={styles.selectCheck} checked={local.reminders_push !== false}
                 onChange={(e) => setLocal({ ...local, reminders_push: e.target.checked })} />
          <span className={styles.hint}>{t("calendar.settings.remindersHint")}</span>
        </div>
        <div className={styles.dialogActions}>
          <button className={styles.btn} onClick={onClose}>{t("actions.cancel")}</button>
          <button className={styles.btnPrimary} onClick={save}>{t("actions.save")}</button>
        </div>
      </div>
    </div>
  );
}
