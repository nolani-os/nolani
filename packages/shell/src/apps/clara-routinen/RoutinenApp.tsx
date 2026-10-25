import { useCallback, useEffect, useState } from "react";
import styles from "./RoutinenApp.module.css";
import { regionLocale, i18n, useTranslation } from "@claraos/core";

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

/** Weekday name in the UI language; 0 = Monday, as stored by the API. 1 Jan 2024 was a Monday. */
function tagName(i: number): string {
  return new Date(2024, 0, 1 + i).toLocaleDateString(i18n.resolvedLanguage ?? i18n.language, { weekday: "long" });
}
const WOCHENTAGE = [0, 1, 2, 3, 4, 5, 6];
const RUN_STATUS = new Set(["laeuft", "fertig", "wartet", "fehler", "erledigt"]);
/** Schedule of the examples; title and task come from the catalog, in the UI language
 *  — the assistant answers in that language, so the example task should be in it too. */
const BEISPIEL_PLAN: Array<Pick<Routine, "rhythmus" | "uhrzeit">> = [
  { rhythmus: "werktags", uhrzeit: "07:00" },
  { rhythmus: "woechentlich", uhrzeit: "17:00" },
  { rhythmus: "werktags", uhrzeit: "17:30" },
];
function beispiele(): Array<Pick<Routine, "titel" | "auftrag" | "rhythmus" | "uhrzeit">> {
  const texte = i18n.t("claraRoutines:examples", { returnObjects: true }) as unknown as Array<{ titel: string; auftrag: string }>;
  return BEISPIEL_PLAN.map((p, i) => ({ ...p, titel: texte[i]?.titel ?? "", auftrag: texte[i]?.auftrag ?? "" }));
}

function rhythmusText(r: Pick<Routine, "rhythmus" | "uhrzeit" | "wochentag">): string {
  if (r.rhythmus === "stuendlich") return i18n.t("claraRoutines:rhythm.stuendlich", { minute: r.uhrzeit.slice(3) });
  if (r.rhythmus === "werktags") return i18n.t("claraRoutines:rhythm.werktags", { time: r.uhrzeit });
  if (r.rhythmus === "woechentlich") return i18n.t("claraRoutines:rhythm.woechentlich", { day: tagName(r.wochentag ?? 0), time: r.uhrzeit });
  return i18n.t("claraRoutines:rhythm.taeglich", { time: r.uhrzeit });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/claraos/routinen${path}`, {
    ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(typeof d.detail === "string" ? d.detail : i18n.t("claraRoutines:error", { status: r.status }));
  }
  return r.json();
}

const LEER: Omit<Routine, "id" | "letzter_lauf"> = {
  titel: "", auftrag: "", rhythmus: "taeglich", uhrzeit: "07:00", wochentag: 0, aktiv: true,
};

export function RoutinenApp() {
  const { t } = useTranslation("claraRoutines");
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
    const timer = setInterval(freigabenLaden, 15_000);
    return () => clearInterval(timer);
  }, [freigabenLaden]);

  const laeufeLaden = useCallback(async (id: string) => {
    try { setLaeufe(await api<Lauf[]>(`/${id}/laeufe`)); } catch (e) { setFehler((e as Error).message); }
  }, []);
  useEffect(() => {
    if (!offen) return;
    laeufeLaden(offen);
    const timer = setInterval(() => laeufeLaden(offen), 10_000);   // a running routine finishes
    return () => clearInterval(timer);
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
    if (!window.confirm(t("confirmDelete", { title: r.titel }))) return;
    await api(`/${r.id}`, { method: "DELETE" }).catch((e) => setFehler((e as Error).message));
    if (offen === r.id) setOffen(null);
    laden();
  }

  async function jetzt(r: Routine) {
    setFehler(null);
    try {
      await api(`/${r.id}/jetzt`, { method: "POST" });
      setHinweis(t("started", { title: r.titel }));
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
        <strong>{t("proposal", { tool: v.werkzeug.replace(/_/g, " ") })}</strong> <span>({v.modul})</span>
        <pre>{JSON.stringify(v.argumente, null, 1).slice(0, 600)}</pre>
      </div>
      {v.status === "offen" ? (
        <div className={styles.knoepfe}>
          <button className={styles.primaer} onClick={() => entscheiden(l, i, true)}>{t("approve")}</button>
          <button onClick={() => entscheiden(l, i, false)}>{t("discard")}</button>
        </div>
      ) : <span className={styles.vstatus}>{t(`proposalStatus.${v.status}`, { defaultValue: v.status })}</span>}
    </div>
  );
  const chatOffen = freigaben.filter((l) => l.vorschlaege.some((v) => v.status === "offen"));

  return (
    <div className={styles.app}>
      <header className={styles.kopf}>
        <h2>{t("title")}</h2>
        <button className={styles.primaer} onClick={() => setForm({ ...LEER })}>{t("new")}</button>
      </header>
      <p className={styles.erklaerung}>
        {t("intro")}
      </p>
      {!gehirn && <p className={styles.warnung}>{t("noBrain")}</p>}
      {fehler && <p className={styles.fehler} role="alert">{fehler}</p>}
      {hinweis && <p className={styles.hinweis} onClick={() => setHinweis(null)}>{hinweis}</p>}

      {chatOffen.length > 0 && (
        <div className={styles.karte}>
          <h3 className={styles.abschnitt}>{t("waiting")}</h3>
          <p className={styles.erklaerung}>{t("waitingIntro")}</p>
          {chatOffen.map((l) => (
            <div key={l.id} className={styles.lauf}>
              <div className={styles.laufkopf}>
                <span>{new Date(l.gestartet).toLocaleString(regionLocale(), { dateStyle: "short", timeStyle: "short" })}</span>
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
              {beispiele().map((b) => (
                <button key={b.titel} className={styles.chip} onClick={() => setForm({ ...form, ...b })}>{b.titel}</button>
              ))}
            </div>
          )}
          <label>{t("fieldTitle")}<input value={form.titel} maxLength={120} onChange={(e) => setForm({ ...form, titel: e.target.value })} /></label>
          <label>{t("fieldTask")}
            <textarea rows={4} value={form.auftrag} maxLength={4000}
              onChange={(e) => setForm({ ...form, auftrag: e.target.value })} />
          </label>
          <div className={styles.zeile}>
            <label>{t("fieldRhythm")}
              <select value={form.rhythmus} onChange={(e) => setForm({ ...form, rhythmus: e.target.value as Rhythmus })}>
                <option value="taeglich">{t("rhythmOption.taeglich")}</option>
                <option value="werktags">{t("rhythmOption.werktags")}</option>
                <option value="woechentlich">{t("rhythmOption.woechentlich")}</option>
                <option value="stuendlich">{t("rhythmOption.stuendlich")}</option>
              </select>
            </label>
            {form.rhythmus === "woechentlich" && (
              <label>{t("fieldDay")}
                <select value={form.wochentag ?? 0} onChange={(e) => setForm({ ...form, wochentag: Number(e.target.value) })}>
                  {WOCHENTAGE.map((i) => <option key={i} value={i}>{tagName(i)}</option>)}
                </select>
              </label>
            )}
            <label>{form.rhythmus === "stuendlich" ? t("fieldMinute") : t("fieldTime")}
              <input type="time" value={form.uhrzeit} onChange={(e) => setForm({ ...form, uhrzeit: e.target.value })} />
            </label>
          </div>
          <div className={styles.knoepfe}>
            <button className={styles.primaer} disabled={!form.titel.trim() || form.auftrag.trim().length < 3} onClick={speichern}>{t("save")}</button>
            <button onClick={() => setForm(null)}>{t("cancel")}</button>
          </div>
        </div>
      )}

      {liste.length === 0 && !form && <p className={styles.leer}>{t("empty")}</p>}

      {liste.map((r) => (
        <div key={r.id} className={`${styles.karte} ${r.aktiv ? "" : styles.pausiert}`}>
          <div className={styles.kopfzeile}>
            <button className={styles.titel} onClick={() => setOffen(offen === r.id ? null : r.id)}>
              <strong>{r.titel}</strong>
              <span>{rhythmusText(r)}{r.aktiv ? "" : t("paused")}</span>
            </button>
            <div className={styles.knoepfe}>
              <button onClick={() => jetzt(r)} disabled={!gehirn}>{t("now")}</button>
              <button onClick={() => umschalten(r)}>{r.aktiv ? t("pause") : t("activate")}</button>
              <button onClick={() => setForm({ ...r })}>{t("edit")}</button>
              <button className={styles.gefahr} onClick={() => loeschen(r)}>{t("delete")}</button>
            </div>
          </div>
          {offen === r.id && (
            <div className={styles.laeufe}>
              <p className={styles.auftrag}>{r.auftrag}</p>
              {laeufe.length === 0 && <p className={styles.leer}>{t("noRuns")}</p>}
              {laeufe.map((l) => (
                <div key={l.id} className={styles.lauf}>
                  <div className={styles.laufkopf}>
                    <span className={`${styles.status} ${styles["s_" + l.status] || ""}`}>{RUN_STATUS.has(l.status) ? t(`status.${l.status}`) : l.status}</span>
                    <span>{new Date(l.gestartet).toLocaleString(regionLocale(), { dateStyle: "short", timeStyle: "short" })}</span>
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
