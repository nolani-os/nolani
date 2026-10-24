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
import { regionLocale } from "@claraos/core";

type Register = "ressourcen" | "umfragen" | "buchung" | "besprechung";

const ART_ICON: Record<string, "home" | "devices" | "cube" | "collections"> = {
  raum: "home", fahrzeug: "devices", geraet: "cube", sonstiges: "collections",
};

function heuteISO(plusTage = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + plusTage);
  return d.toISOString().slice(0, 10);
}

function zeitKurz(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleString(regionLocale(), { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function BusinessView() {
  const [register, setRegister] = useState<Register>("ressourcen");
  const [meldung, setMeldung] = useState<{ text: string; fehler?: boolean } | null>(null);
  const melde = useCallback((text: string, fehler?: boolean) => {
    setMeldung({ text, fehler });
    window.setTimeout(() => setMeldung(null), 6000);
  }, []);

  return (
    <div className={styles.section}>
      <div className={styles.cardMeta} style={{ marginBottom: 12 }}>
        {([["ressourcen", "Ressourcen"], ["umfragen", "Terminumfragen"],
           ["buchung", "Terminbuchung"], ["besprechung", "Besprechungsraum"]] as [Register, string][])
          .map(([k, label]) => (
            <button key={k} className={`${styles.btn} ${register === k ? styles.btnActive : ""}`}
                    onClick={() => setRegister(k)}>{label}</button>
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
    if (!titel.trim()) { melde("Wofür denn? Ein Titel gehört dazu.", true); return; }
    setLaeuft(true); setKonflikte([]);
    try {
      const r = await businessApi.buchen(gewaehlt, {
        von: `${tag}T${von}:00`, bis: `${tag}T${bis}:00`, titel: titel.trim(),
      });
      melde(`${r.ressource} gebucht: ${zeitKurz(r.von)} – ${zeitKurz(r.bis)}`);
      setTitel("");
      await ladeBelegung();
    } catch (e) {
      if (e instanceof BelegtError) { setKonflikte(e.konflikte); melde(e.message, true); }
      else melde(String((e as Error).message), true);
    } finally { setLaeuft(false); }
  };

  const stornieren = async (uid: string) => {
    setLaeuft(true);
    try { await businessApi.stornieren(gewaehlt, uid); melde("Buchung storniert"); await ladeBelegung(); }
    catch (e) { melde(String((e as Error).message), true); }
    finally { setLaeuft(false); }
  };

  if (liste === null) return <div className={styles.loading}>Lade…</div>;
  if (liste.length === 0) {
    return (
      <div className={styles.section}>
        <p>Noch keine Ressourcen angelegt.</p>
        <p className={styles.cardMeta}>
          Eine Ressource ist etwas, das nur einer gleichzeitig haben kann — das Auto,
          das Gästezimmer, der Anhänger. Ein Administrator legt sie an; jede bekommt
          einen eigenen Kalender, den die Familie sieht.
        </p>
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
        <button className={styles.btn} onClick={() => setTag(heuteISO())}>Heute</button>
        <button className={styles.btn} onClick={() => void ladeBelegung()}>Aktualisieren</button>
      </div>

      <div className={styles.section}>
        <b>
          <Icon name={ART_ICON[liste.find((r) => r.id === gewaehlt)?.art ?? "sonstiges"] ?? "collections"} size={15} />{" "}
          {belegung.length === 0 ? "An diesem Tag frei" : `${belegung.length} Buchung${belegung.length === 1 ? "" : "en"}`}
        </b>
        {belegung.map((b) => (
          <div key={b.uid} className={styles.card}>
            <div className={styles.cardTitle}>{b.titel}</div>
            <div className={styles.cardMeta}>
              <span>{zeitKurz(b.von)} – {zeitKurz(b.bis)}</span>
              {b.wer && <span>· {b.wer}</span>}
              <button className={styles.btnDanger} disabled={laeuft} onClick={() => void stornieren(b.uid)}>
                Stornieren
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Buchen</h3>
        <div className={styles.cardMeta}>
          <input className={styles.input} placeholder="Wofür? z. B. Baumarkt" value={titel}
                 onChange={(e) => setTitel(e.target.value)} />
          <input className={styles.inputSmall} type="time" value={von} onChange={(e) => setVon(e.target.value)} />
          <input className={styles.inputSmall} type="time" value={bis} onChange={(e) => setBis(e.target.value)} />
          <button className={styles.btnPrimary} disabled={laeuft} onClick={() => void buchen()}>Buchen</button>
        </div>
        {konflikte.length > 0 && (
          <div className={styles.errorBox}>
            In dieser Zeit steht schon etwas:
            <ul>
              {konflikte.map((k) => (
                <li key={k.uid}>{k.titel} — {zeitKurz(k.von)} bis {zeitKurz(k.bis)}{k.wer ? ` (${k.wer})` : ""}</li>
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
      try { await businessApi.stimmen(u.id, stimmen); await oeffnen(u.id); melde("Stimme gespeichert"); }
      catch (e) { melde(String((e as Error).message), true); }
      finally { setLaeuft(false); }
    };
    const festlegen = async (idx: number) => {
      setLaeuft(true);
      try {
        const r = await businessApi.festlegen(u.id, idx);
        melde(r.hinweis ?? "Termin steht im Kalender");
        setOffen(null); await laden();
      } catch (e) { melde(String((e as Error).message), true); }
      finally { setLaeuft(false); }
    };
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <button className={styles.btn} onClick={() => setOffen(null)}>‹ Zurück</button>
          <b>{u.titel}</b>
          {u.ort && <span className={styles.cardMeta}>{u.ort}</span>}
          <span className={styles.cardMeta}>{u.dauer_min} Min · {u.status}</span>
        </div>
        {u.optionen.map((o, i) => {
          const z = offen.auszaehlung[i] ?? { ja: 0, vielleicht: 0, nein: 0 };
          const meine = offen.meine_stimmen[i];
          return (
            <div key={o} className={styles.card}>
              <div className={styles.cardTitle}>
                {zeitKurz(o)}
                {offen.empfehlung === i && u.status === "offen" && <span className={styles.cardMeta}> · beste Chance</span>}
                {u.gewaehlt === i && <span className={styles.cardMeta}> · festgelegt</span>}
              </div>
              <div className={styles.cardMeta}>
                <span>{z.ja} ja</span><span>{z.vielleicht} vielleicht</span><span>{z.nein} nein</span>
                {u.status === "offen" && ["ja", "vielleicht", "nein"].map((a) => (
                  <button key={a} disabled={laeuft}
                          className={`${styles.btn} ${meine === a ? styles.btnActive : ""}`}
                          onClick={() => void setzen(i, a)}>{a}</button>
                ))}
                {u.status === "offen" && u.ersteller === offen.ich && (
                  <button className={styles.btnPrimary} disabled={laeuft} onClick={() => void festlegen(i)}>
                    Diesen nehmen
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <div className={styles.cardMeta}>
          {Object.keys(offen.je_person).length === 0
            ? "Noch hat niemand abgestimmt."
            : `Abgestimmt: ${Object.keys(offen.je_person).join(", ")}`}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>
        <button className={styles.btnPrimary} onClick={() => setNeu(true)}>
          <Icon name="plus" size={14} /> Neue Umfrage
        </button>
      </div>
      {liste === null && <div className={styles.loading}>Lade…</div>}
      {liste?.length === 0 && <p>Noch keine Umfrage. Eine Umfrage beantwortet „wann passt es allen?" —
        ohne dass jemand zehn Nachrichten schreibt.</p>}
      {(liste ?? []).map((u) => (
        <div key={u.id} className={styles.card} onClick={() => void oeffnen(u.id)}>
          <div className={styles.cardTitle}>{u.titel}</div>
          <div className={styles.cardMeta}>
            <span>{u.optionen.length} Vorschläge</span>
            <span>· {u.status === "offen" ? "offen" : "entschieden"}</span>
            {u.habe_abgestimmt ? <span>· du hast abgestimmt</span> : <span>· du fehlst noch</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function UmfrageNeu({ melde, onFertig }: { melde: (t: string, f?: boolean) => void; onFertig: () => void }) {
  const [titel, setTitel] = useState("");
  const [ort, setOrt] = useState("");
  const [dauer, setDauer] = useState(60);
  const [optionen, setOptionen] = useState<string[]>([`${heuteISO(1)}T18:00`, `${heuteISO(2)}T18:00`]);
  const [personen, setPersonen] = useState<{ username: string; name?: string }[]>([]);
  const [teilnehmer, setTeilnehmer] = useState<string[]>([]);
  const [laeuft, setLaeuft] = useState(false);

  useEffect(() => { personenApi.liste().then(setPersonen).catch(() => setPersonen([])); }, []);

  const speichern = async () => {
    if (!titel.trim()) { melde("Worum geht es?", true); return; }
    setLaeuft(true);
    try {
      await businessApi.umfrageAnlegen({
        titel: titel.trim(), ort: ort.trim(), dauer_min: dauer,
        optionen: optionen.filter(Boolean).map((o) => `${o}:00`), teilnehmer,
      });
      melde("Umfrage angelegt");
      onFertig();
    } catch (e) { melde(String((e as Error).message), true); }
    finally { setLaeuft(false); }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>
        <button className={styles.btn} onClick={onFertig}>‹ Zurück</button> Neue Terminumfrage
      </div>
      <div className={styles.cardMeta}>
        <input className={styles.input} placeholder="Worum geht es?" value={titel} onChange={(e) => setTitel(e.target.value)} />
        <input className={styles.input} placeholder="Ort (freiwillig)" value={ort} onChange={(e) => setOrt(e.target.value)} />
        <select className={styles.select} value={dauer} onChange={(e) => setDauer(Number(e.target.value))}>
          {[30, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{m} Minuten</option>)}
        </select>
      </div>

      <h3 className={styles.sectionTitle} style={{ marginTop: 18 }}>Vorschläge</h3>
      {optionen.map((o, i) => (
        <div key={i} className={styles.cardMeta}>
          <input className={styles.input} type="datetime-local" value={o}
                 onChange={(e) => setOptionen(optionen.map((x, j) => (j === i ? e.target.value : x)))} />
          {optionen.length > 2 && (
            <button className={styles.btnDanger} onClick={() => setOptionen(optionen.filter((_, j) => j !== i))}>
              Weg
            </button>
          )}
        </div>
      ))}
      <button className={styles.btn} disabled={optionen.length >= 12}
              onClick={() => setOptionen([...optionen, `${heuteISO(optionen.length + 1)}T18:00`])}>
        <Icon name="plus" size={13} /> Vorschlag
      </button>

      <h3 className={styles.sectionTitle} style={{ marginTop: 18 }}>Wer soll abstimmen?</h3>
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
      <button className={styles.btnPrimary} disabled={laeuft} onClick={() => void speichern()}>Umfrage starten</button>
    </div>
  );
}

/* ── Meeting room ─────────────────────────────────────────────────────── */

function Besprechung({ melde }: { melde: (t: string, f?: boolean) => void }) {
  const [titel, setTitel] = useState("");
  const [personen, setPersonen] = useState<{ username: string; name?: string }[]>([]);
  const [teilnehmer, setTeilnehmer] = useState<string[]>([]);
  const [ergebnis, setErgebnis] = useState<{ link: string; eingeladen: string[]; ohne: string[]; hinweis: string } | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  useEffect(() => { personenApi.liste().then(setPersonen).catch(() => setPersonen([])); }, []);

  const anlegen = async () => {
    if (!titel.trim()) { melde("Wie soll die Besprechung heißen?", true); return; }
    setLaeuft(true);
    try {
      const r = await businessApi.besprechung(titel.trim(), teilnehmer);
      setErgebnis({ link: r.link, eingeladen: r.eingeladen, ohne: r.ohne_matrix_konto, hinweis: r.hinweis });
      melde("Besprechungsraum steht");
    } catch (e) { melde(String((e as Error).message), true); }
    finally { setLaeuft(false); }
  };

  return (
    <div className={styles.section}>
      <div className={styles.cardMeta}>
        <input className={styles.input} placeholder="Titel der Besprechung" value={titel}
               onChange={(e) => setTitel(e.target.value)} />
        <button className={styles.btnPrimary} disabled={laeuft} onClick={() => void anlegen()}>Raum anlegen</button>
      </div>
      <h3 className={styles.sectionTitle} style={{ marginTop: 18 }}>Wer wird eingeladen?</h3>
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
          <div className={styles.cardTitle}>Link zur Besprechung</div>
          <div className={styles.cardMeta}>
            <input className={styles.input} readOnly value={ergebnis.link} onFocus={(e) => e.currentTarget.select()} />
            <button className={styles.btn} onClick={() => {
              void navigator.clipboard?.writeText(ergebnis.link).then(() => melde("Link kopiert"));
            }}>Kopieren</button>
          </div>
          <div className={styles.cardMeta}>
            Eingeladen: {ergebnis.eingeladen.join(", ") || "niemand"}
            {ergebnis.ohne.length > 0 && ` · ohne Matrix-Konto: ${ergebnis.ohne.join(", ")}`}
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
      melde(`Gebucht: ${zeitKurz(r.von)}`);
      setThema("");
      await zeitenLaden(gewaehlt);
    } catch (e) { melde(String((e as Error).message), true); await zeitenLaden(gewaehlt); }
    finally { setLaeuft(false); }
  };

  const eigeneSpeichern = async (patch: Partial<Buchungsseite>) => {
    if (!eigene) return;
    const neu = { ...eigene, ...patch };
    setEigene(neu);
    try { await businessApi.buchungsseiteSetzen(neu); melde(neu.aktiv ? "Deine Buchungsseite ist an" : "Deine Buchungsseite ist aus"); await laden(); }
    catch (e) { melde(String((e as Error).message), true); }
  };

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>Termin bei jemandem buchen</h3>
      {gastgeber.length === 0
        ? <p>Niemand bietet gerade Terminbuchung an.</p>
        : (
          <div className={styles.cardMeta}>
            <select className={styles.select} value={gewaehlt} onChange={(e) => void zeitenLaden(e.target.value)}>
              <option value="">Bei wem?</option>
              {gastgeber.map((g) => (
                <option key={g.username} value={g.username}>{g.username} · {g.titel} ({g.dauer_min} Min)</option>
              ))}
            </select>
            <input className={styles.input} placeholder="Worum geht es? (freiwillig)" value={thema}
                   onChange={(e) => setThema(e.target.value)} />
          </div>
        )}
      {zeiten.map((z) => (
        <div key={z.von} className={styles.card}>
          <div className={styles.cardTitle}>{zeitKurz(z.von)}</div>
          <div className={styles.cardMeta}>
            <span>bis {new Date(z.bis).toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" })}</span>
            <button className={styles.btnPrimary} disabled={laeuft} onClick={() => void buchen(z.von)}>Buchen</button>
          </div>
        </div>
      ))}

      <h3 className={styles.sectionTitle} style={{ marginTop: 24 }}>Meine eigene Buchungsseite</h3>
      {eigene && (
        <>
          <div className={styles.cardMeta}>
            <button className={`${styles.btn} ${eigene.aktiv ? styles.btnActive : ""}`}
                    onClick={() => void eigeneSpeichern({ aktiv: !eigene.aktiv })}>
              {eigene.aktiv ? "An — andere dürfen buchen" : "Aus"}
            </button>
            <input className={styles.input} value={eigene.titel} placeholder="Titel der Termine"
                   onChange={(e) => setEigene({ ...eigene, titel: e.target.value })}
                   onBlur={() => void eigeneSpeichern({})} />
            <select className={styles.select} value={eigene.dauer_min}
                    onChange={(e) => void eigeneSpeichern({ dauer_min: Number(e.target.value) })}>
              {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} Minuten</option>)}
            </select>
            <select className={styles.select} value={eigene.von_uhr}
                    onChange={(e) => void eigeneSpeichern({ von_uhr: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>ab {h}:00</option>)}
            </select>
            <select className={styles.select} value={eigene.bis_uhr}
                    onChange={(e) => void eigeneSpeichern({ bis_uhr: Number(e.target.value) })}>
              {Array.from({ length: 25 }, (_, h) => <option key={h} value={h}>bis {h}:00</option>)}
            </select>
            <button className={`${styles.btn} ${eigene.werktags ? styles.btnActive : ""}`}
                    onClick={() => void eigeneSpeichern({ werktags: !eigene.werktags })}>
              {eigene.werktags ? "nur werktags" : "auch am Wochenende"}
            </button>
          </div>
          <div className={styles.cardMeta}>
            Angeboten werden nur Zeiten, in denen dein Kalender frei ist. Wer bucht, sieht
            <b> keine </b>Termindetails — nur frei oder belegt.
          </div>
        </>
      )}
    </div>
  );
}
