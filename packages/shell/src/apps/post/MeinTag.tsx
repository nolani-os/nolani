/** "My Day" as a right-hand sidebar next to the mail.
 *
 * Outlook's "My Day" is a sidebar with calendar and tasks. Here both come
 * from the planner (`/planner/events` returns events **and** tasks in one
 * call) — no second source of truth next to the calendar, just a second
 * view of it.
 *
 * Important: the real value is not displaying but **dragging**: a mail dropped
 * on the sidebar becomes a task or an event. It uses the existing path
 * (`/post/app/mail_to_task|event`) — just without the detour through a menu.
 *
 *
 * Deliberately NOT built: a separate event list with its own state. Changes
 * made here go to the planner; the sidebar only reads and discards.
 */
import { useCallback, useEffect, useState } from "react";
import styles from "./PostApp.module.css";
import { Icon } from "../../components/Icon";
import { postApi, type BrueckenErgebnis } from "./api";

export interface TagTermin {
  uid: string; summary: string; start: string; end: string;
  all_day?: boolean; location?: string; calendar?: string;
  /** STATUS:CANCELLED — cancelled, but still on the calendar. */
  cancelled?: boolean;
}
export interface TagAufgabe {
  id: number; project_id: number; title: string; done: boolean;
  due_date: string; priority?: number;
}

type Ziel = "aufgabe" | "termin" | null;

function tagesgrenzen(tage: number): [string, string] {
  const von = new Date(); von.setHours(0, 0, 0, 0);
  const bis = new Date(von); bis.setDate(bis.getDate() + tage);
  return [von.toISOString(), bis.toISOString()];
}

function uhrzeit(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function tagName(iso: string): string {
  const d = new Date(iso); const heute = new Date();
  if (Number.isNaN(d.getTime())) return "";
  const gleich = d.toDateString() === heute.toDateString();
  const morgen = new Date(heute); morgen.setDate(morgen.getDate() + 1);
  if (gleich) return "Heute";
  if (d.toDateString() === morgen.toDateString()) return "Morgen";
  return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

/** Is this task overdue? (empty date = no due date, so never overdue) */
function ueberfaellig(a: TagAufgabe): boolean {
  if (!a.due_date || a.done) return false;
  const d = new Date(a.due_date);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

export function MeinTag({ tage, melde, onOeffnePlanner }: {
  tage: number;
  melde: (text: string, fehler?: boolean) => void;
  onOeffnePlanner: () => void;
}) {
  const [termine, setTermine] = useState<TagTermin[]>([]);
  const [aufgaben, setAufgaben] = useState<TagAufgabe[]>([]);
  const [laeuft, setLaeuft] = useState(true);
  const [fehlt, setFehlt] = useState<string | null>(null);
  const [ziel, setZiel] = useState<Ziel>(null);
  const [arbeitet, setArbeitet] = useState(false);

  const laden = useCallback(async () => {
    const [von, bis] = tagesgrenzen(tage);
    setLaeuft(true);
    try {
      const r = await fetch(
        `/api/claraos/planner/events?start=${encodeURIComponent(von)}&end=${encodeURIComponent(bis)}`,
        { credentials: "include" });
      if (r.status === 424) { setFehlt("Planner ist für dich nicht verbunden."); setLaeuft(false); return; }
      if (!r.ok) throw new Error(`${r.status}`);
      const d = await r.json();
      setTermine((d.events ?? []).slice(0, 40));
      setAufgaben((d.tasks ?? []).filter((t: TagAufgabe) => !t.done).slice(0, 40));
      setFehlt(null);
    } catch (e) {
      setFehlt(`Tagesübersicht nicht erreichbar (${e instanceof Error ? e.message : e})`);
    } finally {
      setLaeuft(false);
    }
  }, [tage]);

  useEffect(() => { void laden(); }, [laden]);

  /** A dropped mail becomes a task or an event. */
  const ablegen = async (art: "task" | "event", mailId: string) => {
    setZiel(null);
    if (!mailId) return;
    setArbeitet(true);
    try {
      const r: BrueckenErgebnis = await postApi.bruecke(art, { email_id: mailId });
      melde(r.message || (art === "task" ? "Aufgabe aus der Mail angelegt" : "Termin aus der Mail angelegt"));
      await laden();
    } catch (e) {
      melde(e instanceof Error ? e.message : String(e), true);
    } finally {
      setArbeitet(false);
    }
  };

  const zone = (art: "task" | "event", istZiel: boolean) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setZiel(art === "task" ? "aufgabe" : "termin"); },
    onDragLeave: () => setZiel(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      void ablegen(art, e.dataTransfer.getData("application/x-claraos-mail") || e.dataTransfer.getData("text/plain"));
    },
    className: `${styles.tagBlock} ${istZiel ? styles.tagBlockZiel : ""}`,
  });

  const heuteTermine = termine.filter((t) => tagName(t.start) === "Heute");
  const spaeter = termine.filter((t) => tagName(t.start) !== "Heute");
  const offen = aufgaben.filter((a) => !ueberfaellig(a));
  const spaet = aufgaben.filter(ueberfaellig);

  return (
    <aside className={styles.meinTag}>
      <div className={styles.tagKopf}>
        <b>Mein Tag</b>
        <span className={styles.hinweis}>{new Date().toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long" })}</span>
        <span style={{ flex: 1 }} />
        <button className={styles.iconKnopf} title="Aktualisieren" onClick={() => void laden()}>
          <Icon name="reload" size={13} />
        </button>
        <button className={styles.iconKnopf} title="Im Planner öffnen" onClick={onOeffnePlanner}>
          <Icon name="today" size={13} />
        </button>
      </div>

      {fehlt && <div className={styles.warnung}>{fehlt}</div>}
      {laeuft && !fehlt && <div className={styles.hinweis} style={{ padding: "0.5rem 0.75rem" }}>Lade …</div>}

      <div {...zone("event", ziel === "termin")}>
        <div className={styles.tagTitel}><Icon name="calendar" size={13} /> Termine</div>
        {heuteTermine.length === 0 && <div className={styles.hinweis}>Heute nichts eingetragen.</div>}
        {heuteTermine.map((t) => (
          <div key={t.uid} className={`${styles.tagZeile} ${t.cancelled ? styles.tagAbgesagt : ""}`}
               title={t.cancelled ? "Abgesagt" : (t.location || t.summary)}>
            <span className={styles.tagZeit}>{t.all_day ? "ganztags" : uhrzeit(t.start)}</span>
            <span className={styles.tagText}>{t.summary || "(ohne Titel)"}</span>
            {t.cancelled && <span className={styles.hinweis}>abgesagt</span>}
          </div>
        ))}
        {spaeter.length > 0 && (
          <>
            <div className={styles.tagTrenner}>Danach</div>
            {spaeter.slice(0, 6).map((t) => (
              <div key={t.uid} className={`${styles.tagZeile} ${t.cancelled ? styles.tagAbgesagt : ""}`}>
                <span className={styles.tagZeit}>{tagName(t.start)}</span>
                <span className={styles.tagText}>{t.summary || "(ohne Titel)"}</span>
                {t.cancelled && <span className={styles.hinweis}>abgesagt</span>}
              </div>
            ))}
          </>
        )}
        <div className={styles.tagZiehHinweis}>Mail hierher ziehen → Termin</div>
      </div>

      <div {...zone("task", ziel === "aufgabe")}>
        <div className={styles.tagTitel}><Icon name="check" size={13} /> Aufgaben</div>
        {spaet.length > 0 && (
          <>
            <div className={styles.tagTrenner}>Überfällig ({spaet.length})</div>
            {spaet.slice(0, 8).map((a) => (
              <div key={a.id} className={`${styles.tagZeile} ${styles.tagSpaet}`}>
                <span className={styles.tagText}>{a.title}</span>
              </div>
            ))}
          </>
        )}
        {offen.length === 0 && spaet.length === 0 && <div className={styles.hinweis}>Nichts offen.</div>}
        {offen.slice(0, 10).map((a) => (
          <div key={a.id} className={styles.tagZeile}>
            <span className={styles.tagZeit}>{a.due_date ? tagName(a.due_date) : ""}</span>
            <span className={styles.tagText}>{a.title}</span>
          </div>
        ))}
        <div className={styles.tagZiehHinweis}>Mail hierher ziehen → Aufgabe</div>
      </div>

      {arbeitet && <div className={styles.hinweis} style={{ padding: "0.4rem 0.75rem" }}>Lege an …</div>}
    </aside>
  );
}
