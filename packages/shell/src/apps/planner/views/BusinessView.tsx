/** Calendar page: resources · scheduling polls · booking · meeting room.
 *
 * One view with four tabs instead of four entries in the rail — the four
 * things belong together ("arranging something with others"), and the Planner
 * already has five sections.
 *
 * Important: the occupancy sits ABOVE the booking form, not below it. Anyone
 * booking a car first wants to see whether it is free; only then does the form
 * matter. A conflict shows the other bookings in plain text — "occupied" alone
 * leaves you at a loss.
 */
import { useCallback, useEffect, useState } from "react";
import styles from "../PlannerApp.module.css";
import { Icon } from "../../../components/Icon";
import {
  businessApi, personenApi, BelegtError,
  type Belegung, type Buchungsseite, type Ressource, type Umfrage, type UmfrageDetail,
} from "./businessApi";
import { i18n, regionLocale, useTranslation, Trans } from "@claraos/core";
import { ymdOf } from "./calendar/calLayout";

type Register = "ressourcen" | "umfragen" | "buchung" | "besprechung";

const ART_ICON: Record<string, "home" | "devices" | "cube" | "collections"> = {
  raum: "home", fahrzeug: "devices", geraet: "cube", sonstiges: "collections",
};

function heuteISO(plusTage = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + plusTage);
  return ymdOf(d); // local date; toISOString() would give the UTC day
}

function zeitKurz(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleString(regionLocale(), { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Poll status label; unknown server states are shown as they come. */
function pollStatus(status: string): string {
  return status === "offen" || status === "entschieden"
    ? i18n.t(`planner:business.polls.status.${status}`) : status;
}

export default function BusinessView() {
  const { t } = useTranslation("planner");
  const [register, setRegister] = useState<Register>("ressourcen");
  const [meldung, setMeldung] = useState<{ text: string; fehler?: boolean } | null>(null);
  const melde = useCallback((text: string, fehler?: boolean) => {
    setMeldung({ text, fehler });
    window.setTimeout(() => setMeldung(null), 6000);
  }, []);

  return (
    <div className={styles.section}>
      <div className={styles.cardMeta} style={{ marginBottom: 12 }}>
        {([["ressourcen", "resources"], ["umfragen", "polls"],
           ["buchung", "booking"], ["besprechung", "meeting"]] as [Register, string][])
          .map(([k, labelKey]) => (
            <button key={k} className={`${styles.btn} ${register === k ? styles.btnActive : ""}`}
                    onClick={() => setRegister(k)}>{t(`business.tabs.${labelKey}`)}</button>
          ))}
      </div>
      {meldung && (
        <div className={meldung.fehler ? styles.errorBox : styles.section} role="status">{meldung.text}</div>
      )}
      {register === "ressourcen" && <Ressourcen melde={melde} />}
      {register === "umfragen" && <Umfragen melde={melde} />}
      {register === "buchung" && <Terminbuchung melde={melde} />}
      {register === "besprechung" && <Besprechung melde={melde} />}
    </div>
  );
}

/* ── Resources ────────────────────────────────────────────────────────── */

function Ressourcen({ melde }: { melde: (t: string, f?: boolean) => void }) {
  const { t } = useTranslation("planner");
  const [liste, setListe] = useState<Ressource[] | null>(null);
  const [gewaehlt, setGewaehlt] = useState<string>("");
  const [tag, setTag] = useState(heuteISO());
  const [belegung, setBelegung] = useState<Belegung[]>([]);
  const [konflikte, setKonflikte] = useState<Belegung[]>([]);
  const [von, setVon] = useState("09:00");
  const [bis, setBis] = useState("12:00");
  const [titel, setTitel] = useState("");
  const [laeuft, setLaeuft] = useState(false);

  useEffect(() => {
    businessApi.ressourcen().then((r) => {
      setListe(r.ressourcen);
      if (r.ressourcen[0]) setGewaehlt(r.ressourcen[0].id);
    }).catch((e) => { melde(String(e.message ?? e), true); setListe([]); });
  }, [melde]);

  const ladeBelegung = useCallback(async () => {
    if (!gewaehlt) return;
    try {
      const r = await businessApi.belegung(gewaehlt, `${tag}T00:00:00`, `${tag}T23:59:59`);
      setBelegung(r.belegung);
    } catch (e) { melde(String((e as Error).message), true); }
  }, [gewaehlt, tag, melde]);

  useEffect(() => { void ladeBelegung(); }, [ladeBelegung]);

  const buchen = async () => {
    if (!titel.trim()) { melde(t("business.resources.titleRequired"), true); return; }
    setLaeuft(true); setKonflikte([]);
    try {
      const r = await businessApi.buchen(gewaehlt, {
        von: `${tag}T${von}:00`, bis: `${tag}T${bis}:00`, titel: titel.trim(),
      });
      melde(t("business.resources.booked", { resource: r.ressource, from: zeitKurz(r.von), to: zeitKurz(r.bis) }));
      setTitel("");
      await ladeBelegung();
    } catch (e) {
      if (e instanceof BelegtError) { setKonflikte(e.konflikte); melde(e.message, true); }
      else melde(String((e as Error).message), true);
    } finally { setLaeuft(false); }
  };

  const stornieren = async (uid: string) => {
    setLaeuft(true);
    try { await businessApi.stornieren(gewaehlt, uid); melde(t("business.resources.cancelled")); await ladeBelegung(); }
    catch (e) { melde(String((e as Error).message), true); }
    finally { setLaeuft(false); }
  };

  if (liste === null) return <div className={styles.loading}>{t("business.loading")}</div>;
  if (liste.length === 0) {
    return (
      <div className={styles.section}>
        <p>{t("business.resources.empty")}</p>
        <p className={styles.cardMeta}>{t("business.resources.emptyHint")}</p>
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>
        <select className={styles.select} value={gewaehlt} onChange={(e) => setGewaehlt(e.target.value)}>
          {liste.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <input className={styles.input} type="date" value={tag} onChange={(e) => setTag(e.target.value)} />
        <button className={styles.btn} onClick={() => setTag(heuteISO())}>{t("business.resources.today")}</button>
        <button className={styles.btn} onClick={() => void ladeBelegung()}>{t("business.resources.refresh")}</button>
      </div>

      <div className={styles.section}>
        <b>
          <Icon name={ART_ICON[liste.find((r) => r.id === gewaehlt)?.art ?? "sonstiges"] ?? "collections"} size={15} />{" "}
          {belegung.length === 0 ? t("business.resources.freeThatDay") : t("business.resources.bookings", { count: belegung.length })}
        </b>
        {belegung.map((b) => (
          <div key={b.uid} className={styles.card}>
            <div className={styles.cardTitle}>{b.titel}</div>
            <div className={styles.cardMeta}>
              <span>{zeitKurz(b.von)} – {zeitKurz(b.bis)}</span>
              {b.wer && <span>· {b.wer}</span>}
              <button className={styles.btnDanger} disabled={laeuft} onClick={() => void stornieren(b.uid)}>
                {t("business.resources.cancelBooking")}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>{t("business.resources.book")}</h3>
        <div className={styles.cardMeta}>
          <input className={styles.input} placeholder={t("business.resources.titlePlaceholder")} value={titel}
                 onChange={(e) => setTitel(e.target.value)} />
          <input className={styles.inputSmall} type="time" value={von} onChange={(e) => setVon(e.target.value)} />
          <input className={styles.inputSmall} type="time" value={bis} onChange={(e) => setBis(e.target.value)} />
          <button className={styles.btnPrimary} disabled={laeuft} onClick={() => void buchen()}>{t("business.resources.book")}</button>
        </div>
        {konflikte.length > 0 && (
          <div className={styles.errorBox}>
            {t("business.resources.conflict")}
            <ul>
              {konflikte.map((k) => (
                <li key={k.uid}>{t("business.resources.conflictRange", { title: k.titel, from: zeitKurz(k.von), to: zeitKurz(k.bis) })}{k.wer ? ` (${k.wer})` : ""}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Scheduling polls ───────────────────────────────────────────────── */

function Umfragen({ melde }: { melde: (t: string, f?: boolean) => void }) {
  const { t } = useTranslation("planner");
  const [liste, setListe] = useState<Umfrage[] | null>(null);
  const [offen, setOffen] = useState<UmfrageDetail | null>(null);
  const [neu, setNeu] = useState(false);
  const [laeuft, setLaeuft] = useState(false);

  const laden = useCallback(async () => {
    try { setListe((await businessApi.umfragen()).umfragen); }
    catch (e) { melde(String((e as Error).message), true); setListe([]); }
  }, [melde]);

  useEffect(() => { void laden(); }, [laden]);

  const oeffnen = async (id: string) => {
    try { setOffen(await businessApi.umfrage(id)); }
    catch (e) { melde(String((e as Error).message), true); }
  };

  if (neu) return <UmfrageNeu melde={melde} onFertig={() => { setNeu(false); void laden(); }} />;

  if (offen) {
    const u = offen.umfrage;
    const stimmen = { ...offen.meine_stimmen };
    const setzen = async (idx: number, antwort: string) => {
      stimmen[idx] = antwort;
      setLaeuft(true);
      try { await businessApi.stimmen(u.id, stimmen); await oeffnen(u.id); melde(t("business.polls.voteSaved")); }
      catch (e) { melde(String((e as Error).message), true); }
      finally { setLaeuft(false); }
    };
    const festlegen = async (idx: number) => {
      setLaeuft(true);
      try {
        const r = await businessApi.festlegen(u.id, idx);
        melde(r.hinweis ?? t("business.polls.scheduled"));
        setOffen(null); await laden();
      } catch (e) { melde(String((e as Error).message), true); }
      finally { setLaeuft(false); }
    };
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <button className={styles.btn} onClick={() => setOffen(null)}>‹ {t("business.back")}</button>
          <b>{u.titel}</b>
          {u.ort && <span className={styles.cardMeta}>{u.ort}</span>}
          <span className={styles.cardMeta}>{t("business.minutesShort", { count: u.dauer_min })} · {pollStatus(u.status)}</span>
        </div>
        {u.optionen.map((o, i) => {
          const z = offen.auszaehlung[i] ?? { ja: 0, vielleicht: 0, nein: 0 };
          const meine = offen.meine_stimmen[i];
          return (
            <div key={o} className={styles.card}>
              <div className={styles.cardTitle}>
                {zeitKurz(o)}
                {offen.empfehlung === i && u.status === "offen" && <span className={styles.cardMeta}> · {t("business.polls.bestChance")}</span>}
                {u.gewaehlt === i && <span className={styles.cardMeta}> · {t("business.polls.chosen")}</span>}
              </div>
              <div className={styles.cardMeta}>
                <span>{z.ja} {t("business.polls.answer.ja")}</span><span>{z.vielleicht} {t("business.polls.answer.vielleicht")}</span><span>{z.nein} {t("business.polls.answer.nein")}</span>
                {u.status === "offen" && ["ja", "vielleicht", "nein"].map((a) => (
                  <button key={a} disabled={laeuft}
                          className={`${styles.btn} ${meine === a ? styles.btnActive : ""}`}
                          onClick={() => void setzen(i, a)}>{t(`business.polls.answer.${a}`)}</button>
                ))}
                {u.status === "offen" && u.ersteller === offen.ich && (
                  <button className={styles.btnPrimary} disabled={laeuft} onClick={() => void festlegen(i)}>
                    {t("business.polls.pick")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <div className={styles.cardMeta}>
          {Object.keys(offen.je_person).length === 0
            ? t("business.polls.nobodyVoted")
            : t("business.polls.voted", { names: Object.keys(offen.je_person).join(", ") })}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>
        <button className={styles.btnPrimary} onClick={() => setNeu(true)}>
          <Icon name="plus" size={14} /> {t("business.polls.new")}
        </button>
      </div>
      {liste === null && <div className={styles.loading}>{t("business.loading")}</div>}
      {liste?.length === 0 && <p>{t("business.polls.empty")}</p>}
      {(liste ?? []).map((u) => (
        <div key={u.id} className={styles.card} onClick={() => void oeffnen(u.id)}>
          <div className={styles.cardTitle}>{u.titel}</div>
          <div className={styles.cardMeta}>
            <span>{t("business.polls.proposals", { count: u.optionen.length })}</span>
            <span>· {t(u.status === "offen" ? "business.polls.status.offen" : "business.polls.status.entschieden")}</span>
            {u.habe_abgestimmt ? <span>· {t("business.polls.youVoted")}</span> : <span>· {t("business.polls.youMissing")}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function UmfrageNeu({ melde, onFertig }: { melde: (t: string, f?: boolean) => void; onFertig: () => void }) {
  const { t } = useTranslation("planner");
  const [titel, setTitel] = useState("");
  const [ort, setOrt] = useState("");
  const [dauer, setDauer] = useState(60);
  const [optionen, setOptionen] = useState<string[]>([`${heuteISO(1)}T18:00`, `${heuteISO(2)}T18:00`]);
  const [personen, setPersonen] = useState<{ username: string; name?: string }[]>([]);
  const [teilnehmer, setTeilnehmer] = useState<string[]>([]);
  const [laeuft, setLaeuft] = useState(false);

  useEffect(() => { personenApi.liste().then(setPersonen).catch(() => setPersonen([])); }, []);

  const speichern = async () => {
    if (!titel.trim()) { melde(t("business.pollNew.whatAbout"), true); return; }
    setLaeuft(true);
    try {
      await businessApi.umfrageAnlegen({
        titel: titel.trim(), ort: ort.trim(), dauer_min: dauer,
        optionen: optionen.filter(Boolean).map((o) => `${o}:00`), teilnehmer,
      });
      melde(t("business.pollNew.created"));
      onFertig();
    } catch (e) { melde(String((e as Error).message), true); }
    finally { setLaeuft(false); }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>
        <button className={styles.btn} onClick={onFertig}>‹ {t("business.back")}</button> {t("business.pollNew.heading")}
      </div>
      <div className={styles.cardMeta}>
        <input className={styles.input} placeholder={t("business.pollNew.whatAbout")} value={titel} onChange={(e) => setTitel(e.target.value)} />
        <input className={styles.input} placeholder={t("business.pollNew.locationPlaceholder")} value={ort} onChange={(e) => setOrt(e.target.value)} />
        <select className={styles.select} value={dauer} onChange={(e) => setDauer(Number(e.target.value))}>
          {[30, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{t("business.minutesOption", { count: m })}</option>)}
        </select>
      </div>

      <h3 className={styles.sectionTitle} style={{ marginTop: 18 }}>{t("business.pollNew.proposals")}</h3>
      {optionen.map((o, i) => (
        <div key={i} className={styles.cardMeta}>
          <input className={styles.input} type="datetime-local" value={o}
                 onChange={(e) => setOptionen(optionen.map((x, j) => (j === i ? e.target.value : x)))} />
          {optionen.length > 2 && (
            <button className={styles.btnDanger} onClick={() => setOptionen(optionen.filter((_, j) => j !== i))}>
              {t("business.pollNew.remove")}
            </button>
          )}
        </div>
      ))}
      <button className={styles.btn} disabled={optionen.length >= 12}
              onClick={() => setOptionen([...optionen, `${heuteISO(optionen.length + 1)}T18:00`])}>
        <Icon name="plus" size={13} /> {t("business.pollNew.addProposal")}
      </button>

      <h3 className={styles.sectionTitle} style={{ marginTop: 18 }}>{t("business.pollNew.whoVotes")}</h3>
      <div className={styles.cardMeta}>
        {personen.map((p) => (
          <button key={p.username}
                  className={`${styles.btn} ${teilnehmer.includes(p.username) ? styles.btnActive : ""}`}
                  onClick={() => setTeilnehmer(teilnehmer.includes(p.username)
                    ? teilnehmer.filter((x) => x !== p.username) : [...teilnehmer, p.username])}>
            {p.name || p.username}
          </button>
        ))}
      </div>
      <button className={styles.btnPrimary} disabled={laeuft} onClick={() => void speichern()}>{t("business.pollNew.start")}</button>
    </div>
  );
}

/* ── Meeting room ─────────────────────────────────────────────────────── */

function Besprechung({ melde }: { melde: (t: string, f?: boolean) => void }) {
  const { t } = useTranslation("planner");
  const [titel, setTitel] = useState("");
  const [personen, setPersonen] = useState<{ username: string; name?: string }[]>([]);
  const [teilnehmer, setTeilnehmer] = useState<string[]>([]);
  const [ergebnis, setErgebnis] = useState<{ link: string; eingeladen: string[]; ohne: string[]; hinweis: string } | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  useEffect(() => { personenApi.liste().then(setPersonen).catch(() => setPersonen([])); }, []);

  const anlegen = async () => {
    if (!titel.trim()) { melde(t("business.meeting.nameRequired"), true); return; }
    setLaeuft(true);
    try {
      const r = await businessApi.besprechung(titel.trim(), teilnehmer);
      setErgebnis({ link: r.link, eingeladen: r.eingeladen, ohne: r.ohne_matrix_konto, hinweis: r.hinweis });
      melde(t("business.meeting.ready"));
    } catch (e) { melde(String((e as Error).message), true); }
    finally { setLaeuft(false); }
  };

  return (
    <div className={styles.section}>
      <div className={styles.cardMeta}>
        <input className={styles.input} placeholder={t("business.meeting.titlePlaceholder")} value={titel}
               onChange={(e) => setTitel(e.target.value)} />
        <button className={styles.btnPrimary} disabled={laeuft} onClick={() => void anlegen()}>{t("business.meeting.create")}</button>
      </div>
      <h3 className={styles.sectionTitle} style={{ marginTop: 18 }}>{t("business.meeting.whoInvited")}</h3>
      <div className={styles.cardMeta}>
        {personen.map((p) => (
          <button key={p.username}
                  className={`${styles.btn} ${teilnehmer.includes(p.username) ? styles.btnActive : ""}`}
                  onClick={() => setTeilnehmer(teilnehmer.includes(p.username)
                    ? teilnehmer.filter((x) => x !== p.username) : [...teilnehmer, p.username])}>
            {p.name || p.username}
          </button>
        ))}
      </div>
      {ergebnis && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>{t("business.meeting.link")}</div>
          <div className={styles.cardMeta}>
            <input className={styles.input} readOnly value={ergebnis.link} onFocus={(e) => e.currentTarget.select()} />
            <button className={styles.btn} onClick={() => {
              void navigator.clipboard?.writeText(ergebnis.link).then(() => melde(t("business.meeting.copied")));
            }}>{t("business.meeting.copy")}</button>
          </div>
          <div className={styles.cardMeta}>
            {t("business.meeting.invited", { names: ergebnis.eingeladen.join(", ") || t("business.meeting.nobody") })}
            {ergebnis.ohne.length > 0 && ` · ${t("business.meeting.withoutMatrix", { names: ergebnis.ohne.join(", ") })}`}
          </div>
          <div className={styles.cardMeta}>{ergebnis.hinweis}</div>
        </div>
      )}
    </div>
  );
}

/* ── Booking ──────────────────────────────────────────────────────────── */

/** Two sides of the same thing: "with whom can I book" and "what do I offer".
 *  Important: your own side sits at the BOTTOM and is off by default — it lets
 *  others write into your calendar, which you switch on deliberately. */
function Terminbuchung({ melde }: { melde: (t: string, f?: boolean) => void }) {
  const { t } = useTranslation("planner");
  const [gastgeber, setGastgeber] = useState<{ username: string; dauer_min: number; titel: string; hinweis: string }[]>([]);
  const [gewaehlt, setGewaehlt] = useState<string>("");
  const [zeiten, setZeiten] = useState<{ von: string; bis: string }[]>([]);
  const [thema, setThema] = useState("");
  const [eigene, setEigene] = useState<Buchungsseite | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  const laden = useCallback(async () => {
    try {
      const [g, e] = await Promise.all([businessApi.gastgeber(), businessApi.buchungsseite()]);
      setGastgeber(g.gastgeber);
      setEigene(e.einstellung);
    } catch (err) { melde(String((err as Error).message), true); }
  }, [melde]);

  useEffect(() => { void laden(); }, [laden]);

  const zeitenLaden = async (wer: string) => {
    setGewaehlt(wer); setZeiten([]);
    if (!wer) return;
    try { setZeiten((await businessApi.zeiten(wer)).zeiten); }
    catch (e) { melde(String((e as Error).message), true); }
  };

  const buchen = async (von: string) => {
    setLaeuft(true);
    try {
      const r = await businessApi.terminBuchen(gewaehlt, von, thema);
      melde(t("business.booking.booked", { time: zeitKurz(r.von) }));
      setThema("");
      await zeitenLaden(gewaehlt);
    } catch (e) { melde(String((e as Error).message), true); await zeitenLaden(gewaehlt); }
    finally { setLaeuft(false); }
  };

  const eigeneSpeichern = async (patch: Partial<Buchungsseite>) => {
    if (!eigene) return;
    const neu = { ...eigene, ...patch };
    setEigene(neu);
    try { await businessApi.buchungsseiteSetzen(neu); melde(neu.aktiv ? t("business.booking.pageOn") : t("business.booking.pageOff")); await laden(); }
    catch (e) { melde(String((e as Error).message), true); }
  };

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{t("business.booking.heading")}</h3>
      {gastgeber.length === 0
        ? <p>{t("business.booking.noHosts")}</p>
        : (
          <div className={styles.cardMeta}>
            <select className={styles.select} value={gewaehlt} onChange={(e) => void zeitenLaden(e.target.value)}>
              <option value="">{t("business.booking.withWhom")}</option>
              {gastgeber.map((g) => (
                <option key={g.username} value={g.username}>{t("business.booking.hostOption", { user: g.username, title: g.titel, minutes: g.dauer_min })}</option>
              ))}
            </select>
            <input className={styles.input} placeholder={t("business.booking.topicPlaceholder")} value={thema}
                   onChange={(e) => setThema(e.target.value)} />
          </div>
        )}
      {zeiten.map((z) => (
        <div key={z.von} className={styles.card}>
          <div className={styles.cardTitle}>{zeitKurz(z.von)}</div>
          <div className={styles.cardMeta}>
            <span>{t("business.booking.until", { time: new Date(z.bis).toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" }) })}</span>
            <button className={styles.btnPrimary} disabled={laeuft} onClick={() => void buchen(z.von)}>{t("business.booking.book")}</button>
          </div>
        </div>
      ))}

      <h3 className={styles.sectionTitle} style={{ marginTop: 24 }}>{t("business.booking.ownHeading")}</h3>
      {eigene && (
        <>
          <div className={styles.cardMeta}>
            <button className={`${styles.btn} ${eigene.aktiv ? styles.btnActive : ""}`}
                    onClick={() => void eigeneSpeichern({ aktiv: !eigene.aktiv })}>
              {eigene.aktiv ? t("business.booking.on") : t("business.booking.off")}
            </button>
            <input className={styles.input} value={eigene.titel} placeholder={t("business.booking.titlePlaceholder")}
                   onChange={(e) => setEigene({ ...eigene, titel: e.target.value })}
                   onBlur={() => void eigeneSpeichern({})} />
            <select className={styles.select} value={eigene.dauer_min}
                    onChange={(e) => void eigeneSpeichern({ dauer_min: Number(e.target.value) })}>
              {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{t("business.minutesOption", { count: m })}</option>)}
            </select>
            <select className={styles.select} value={eigene.von_uhr}
                    onChange={(e) => void eigeneSpeichern({ von_uhr: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{t("business.booking.fromHour", { hour: h })}</option>)}
            </select>
            <select className={styles.select} value={eigene.bis_uhr}
                    onChange={(e) => void eigeneSpeichern({ bis_uhr: Number(e.target.value) })}>
              {Array.from({ length: 25 }, (_, h) => <option key={h} value={h}>{t("business.booking.toHour", { hour: h })}</option>)}
            </select>
            <button className={`${styles.btn} ${eigene.werktags ? styles.btnActive : ""}`}
                    onClick={() => void eigeneSpeichern({ werktags: !eigene.werktags })}>
              {eigene.werktags ? t("business.booking.weekdaysOnly") : t("business.booking.weekendsToo")}
            </button>
          </div>
          <div className={styles.cardMeta}>
            <Trans t={t} i18nKey="business.booking.privacy" components={{ b: <b /> }} />
          </div>
        </>
      )}
    </div>
  );
}
