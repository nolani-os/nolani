import { useCallback, useEffect, useState } from "react";
import styles from "./RoutinenApp.module.css";

/**
 * Routines — recurring tasks for Clara (API: routers/routinen.py).
 * A routine only READS on its own; anything it would change shows up here as a
 * proposal that the user approves or discards.
 */

type Rhythmus = "taeglich" | "werktags" | "woechentlich" | "stuendlich";

interface Routine {
  id: string; titel: string; auftrag: string; rhythmus: Rhythmus;
  uhrzeit: string; wochentag: number | null; aktiv: boolean; letzter_lauf: string | null;
}
interface Vorschlag { modul: string; werkzeug: string; argumente: Record<string, unknown>; status: string }
interface Lauf {
  id: string; gestartet: string; beendet: string | null; status: string;
  ergebnis: string | null; vorschlaege: Vorschlag[];
}

const TAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const STATUS: Record<string, string> = {
  laeuft: "läuft …", fertig: "fertig", wartet: "wartet auf Freigabe", fehler: "fehlgeschlagen", erledigt: "erledigt",
};
const BEISPIELE: Array<Pick<Routine, "titel" | "auftrag" | "rhythmus" | "uhrzeit">> = [
  { titel: "Guten Morgen", rhythmus: "werktags", uhrzeit: "07:00",
    auftrag: "Fasse meine ungelesenen Mails und meine heute fälligen Aufgaben in fünf Sätzen zusammen." },
  { titel: "Wochenrückblick", rhythmus: "woechentlich", uhrzeit: "17:00",
    auftrag: "Welche Aufgaben habe ich diese Woche erledigt, welche sind überfällig? Kurze Liste." },
  { titel: "Feierabend-Check", rhythmus: "werktags", uhrzeit: "17:30",
    auftrag: "Was steht morgen im Kalender? Schlage eine Aufgabe für Vorbereitungen vor, falls nötig." },
];

function rhythmusText(r: Pick<Routine, "rhythmus" | "uhrzeit" | "wochentag">): string {
  if (r.rhythmus === "stuendlich") return `stündlich zur Minute ${r.uhrzeit.slice(3)}`;
  if (r.rhythmus === "werktags") return `werktags um ${r.uhrzeit}`;
  if (r.rhythmus === "woechentlich") return `jeden ${TAGE[r.wochentag ?? 0]} um ${r.uhrzeit}`;
  return `täglich um ${r.uhrzeit}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/claraos/routinen${path}`, {
    ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(typeof d.detail === "string" ? d.detail : `Fehler ${r.status}`);
  }
  return r.json();
}

const LEER: Omit<Routine, "id" | "letzter_lauf"> = {
  titel: "", auftrag: "", rhythmus: "taeglich", uhrzeit: "07:00", wochentag: 0, aktiv: true,
};

export function RoutinenApp() {
  const [liste, setListe] = useState<Routine[]>([]);
  const [gehirn, setGehirn] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [form, setForm] = useState<(Omit<Routine, "id" | "letzter_lauf"> & { id?: string }) | null>(null);
  const [offen, setOffen] = useState<string | null>(null);
  const [laeufe, setLaeufe] = useState<Lauf[]>([]);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [freigaben, setFreigaben] = useState<Lauf[]>([]);

  const laden = useCallback(async () => {
    try {
      setListe(await api<Routine[]>(""));
      setGehirn((await api<{ gehirn: boolean }>("/status")).gehirn);
    } catch (e) { setFehler((e as Error).message); }
  }, []);
  useEffect(() => { laden(); }, [laden]);

  // Tool calls from the chat that Clara may only do with the user's approval.
  const freigabenLaden = useCallback(async () => {
    try { setFreigaben(await api<Lauf[]>("/freigaben")); } catch { /* the list stays as it was */ }
  }, []);
  useEffect(() => {
    freigabenLaden();
    const t = setInterval(freigabenLaden, 15_000);
    return () => clearInterval(t);
  }, [freigabenLaden]);

  const laeufeLaden = useCallback(async (id: string) => {
    try { setLaeufe(await api<Lauf[]>(`/${id}/laeufe`)); } catch (e) { setFehler((e as Error).message); }
  }, []);
  useEffect(() => {
    if (!offen) return;
    laeufeLaden(offen);
    const t = setInterval(() => laeufeLaden(offen), 10_000);   // a running routine finishes
    return () => clearInterval(t);
  }, [offen, laeufeLaden]);

  async function speichern() {
    if (!form) return;
    setFehler(null);
    try {
      const body = JSON.stringify({ ...form, wochentag: form.rhythmus === "woechentlich" ? form.wochentag : null });
      if (form.id) await api(`/${form.id}`, { method: "PUT", body });
      else await api("", { method: "POST", body });
      setForm(null);
      laden();
    } catch (e) { setFehler((e as Error).message); }
  }

  async function umschalten(r: Routine) {
    await api(`/${r.id}`, { method: "PUT", body: JSON.stringify({ ...r, aktiv: !r.aktiv }) }).catch(
      (e) => setFehler((e as Error).message));
    laden();
  }

  async function loeschen(r: Routine) {
    if (!window.confirm(`Routine „${r.titel}“ löschen?`)) return;
    await api(`/${r.id}`, { method: "DELETE" }).catch((e) => setFehler((e as Error).message));
    if (offen === r.id) setOffen(null);
    laden();
  }

  async function jetzt(r: Routine) {
    setFehler(null);
    try {
      await api(`/${r.id}/jetzt`, { method: "POST" });
      setHinweis(`„${r.titel}“ läuft — das Ergebnis kommt als Meldung.`);
      setOffen(r.id);
    } catch (e) { setFehler((e as Error).message); }
  }

  async function entscheiden(lauf: Lauf, index: number, freigeben: boolean) {
    try {
      await api(`/laeufe/${lauf.id}/vorschlaege/${index}`, { method: "POST", body: JSON.stringify({ freigeben }) });
      if (offen) laeufeLaden(offen);
      freigabenLaden();
    } catch (e) { setFehler((e as Error).message); }
  }

  const vorschlagZeile = (l: Lauf, v: Vorschlag, i: number) => (
    <div key={i} className={styles.vorschlag}>
      <div>
        <strong>Vorschlag: {v.werkzeug.replace(/_/g, " ")}</strong> <span>({v.modul})</span>
        <pre>{JSON.stringify(v.argumente, null, 1).slice(0, 600)}</pre>
      </div>
      {v.status === "offen" ? (
        <div className={styles.knoepfe}>
          <button className={styles.primaer} onClick={() => entscheiden(l, i, true)}>Freigeben</button>
          <button onClick={() => entscheiden(l, i, false)}>Verwerfen</button>
        </div>
      ) : <span className={styles.vstatus}>{v.status}</span>}
    </div>
  );
  const chatOffen = freigaben.filter((l) => l.vorschlaege.some((v) => v.status === "offen"));

  return (
    <div className={styles.app}>
      <header className={styles.kopf}>
        <h2>Routinen</h2>
        <button className={styles.primaer} onClick={() => setForm({ ...LEER })}>+ Neue Routine</button>
      </header>
      <p className={styles.erklaerung}>
        Wiederkehrende Aufträge an Clara. Sie liest selbstständig — ändern, senden oder anlegen
        tut sie nur, wenn du den Vorschlag hier freigibst.
      </p>
      {!gehirn && <p className={styles.warnung}>Clara ist in dieser Umgebung nicht angebunden — Routinen laufen nicht.</p>}
      {fehler && <p className={styles.fehler} role="alert">{fehler}</p>}
      {hinweis && <p className={styles.hinweis} onClick={() => setHinweis(null)}>{hinweis}</p>}

      {chatOffen.length > 0 && (
        <div className={styles.karte}>
          <h3 className={styles.abschnitt}>Wartet auf deine Freigabe</h3>
          <p className={styles.erklaerung}>Clara hat das im Chat vorbereitet. Es passiert erst, wenn du es freigibst.</p>
          {chatOffen.map((l) => (
            <div key={l.id} className={styles.lauf}>
              <div className={styles.laufkopf}>
                <span>{new Date(l.gestartet).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</span>
              </div>
              {l.vorschlaege.map((v, i) => vorschlagZeile(l, v, i))}
            </div>
          ))}
        </div>
      )}

      {form && (
        <div className={styles.karte}>
          {!form.id && (
            <div className={styles.beispiele}>
              {BEISPIELE.map((b) => (
                <button key={b.titel} className={styles.chip} onClick={() => setForm({ ...form, ...b })}>{b.titel}</button>
              ))}
            </div>
          )}
          <label>Titel<input value={form.titel} maxLength={120} onChange={(e) => setForm({ ...form, titel: e.target.value })} /></label>
          <label>Auftrag an Clara
            <textarea rows={4} value={form.auftrag} maxLength={4000}
              onChange={(e) => setForm({ ...form, auftrag: e.target.value })} />
          </label>
          <div className={styles.zeile}>
            <label>Rhythmus
              <select value={form.rhythmus} onChange={(e) => setForm({ ...form, rhythmus: e.target.value as Rhythmus })}>
                <option value="taeglich">täglich</option>
                <option value="werktags">werktags</option>
                <option value="woechentlich">wöchentlich</option>
                <option value="stuendlich">stündlich</option>
              </select>
            </label>
            {form.rhythmus === "woechentlich" && (
              <label>Tag
                <select value={form.wochentag ?? 0} onChange={(e) => setForm({ ...form, wochentag: Number(e.target.value) })}>
                  {TAGE.map((t, i) => <option key={t} value={i}>{t}</option>)}
                </select>
              </label>
            )}
            <label>{form.rhythmus === "stuendlich" ? "Minute (hh:MM)" : "Uhrzeit"}
              <input type="time" value={form.uhrzeit} onChange={(e) => setForm({ ...form, uhrzeit: e.target.value })} />
            </label>
          </div>
          <div className={styles.knoepfe}>
            <button className={styles.primaer} disabled={!form.titel.trim() || form.auftrag.trim().length < 3} onClick={speichern}>Speichern</button>
            <button onClick={() => setForm(null)}>Abbrechen</button>
          </div>
        </div>
      )}

      {liste.length === 0 && !form && <p className={styles.leer}>Noch keine Routine. Lege eine an — oder nimm ein Beispiel.</p>}

      {liste.map((r) => (
        <div key={r.id} className={`${styles.karte} ${r.aktiv ? "" : styles.pausiert}`}>
          <div className={styles.kopfzeile}>
            <button className={styles.titel} onClick={() => setOffen(offen === r.id ? null : r.id)}>
              <strong>{r.titel}</strong>
              <span>{rhythmusText(r)}{r.aktiv ? "" : " · pausiert"}</span>
            </button>
            <div className={styles.knoepfe}>
              <button onClick={() => jetzt(r)} disabled={!gehirn}>Jetzt</button>
              <button onClick={() => umschalten(r)}>{r.aktiv ? "Pausieren" : "Aktivieren"}</button>
              <button onClick={() => setForm({ ...r })}>Bearbeiten</button>
              <button className={styles.gefahr} onClick={() => loeschen(r)}>Löschen</button>
            </div>
          </div>
          {offen === r.id && (
            <div className={styles.laeufe}>
              <p className={styles.auftrag}>{r.auftrag}</p>
              {laeufe.length === 0 && <p className={styles.leer}>Noch kein Lauf.</p>}
              {laeufe.map((l) => (
                <div key={l.id} className={styles.lauf}>
                  <div className={styles.laufkopf}>
                    <span className={`${styles.status} ${styles["s_" + l.status] || ""}`}>{STATUS[l.status] || l.status}</span>
                    <span>{new Date(l.gestartet).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</span>
                  </div>
                  {l.ergebnis && <p className={styles.ergebnis}>{l.ergebnis}</p>}
                  {l.vorschlaege.map((v, i) => vorschlagZeile(l, v, i))}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default RoutinenApp;
