/**
 * VerlaufSheet — chat history on mobile.
 *
 * Previously there was no history on mobile: the sheet chat was an in-memory
 * singleton, gone on reload. The server had all chats, the phone could not
 * reach them. Here: search, list by day, tap to load, delete with
 * confirmation. Deliberately simple — no folders (those are a desktop tool).
 */
import { useMemo, useState } from "react";
import type { WebUIChatSummary } from "../Chat/api";
import styles from "./VerlaufSheet.module.css";

function tag(ts?: number): string {
  if (!ts) return "Früher";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  const heute = new Date();
  const gestern = new Date(heute);
  gestern.setDate(heute.getDate() - 1);
  const gleich = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (gleich(d, heute)) return "Heute";
  if (gleich(d, gestern)) return "Gestern";
  const tage = Math.floor((heute.getTime() - ms) / 86_400_000);
  if (tage < 7) return "Diese Woche";
  return d.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
}

export function VerlaufSheet({
  chats,
  aktiv,
  onWaehlen,
  onLoeschen,
  onNeu,
  onSchliessen,
}: {
  chats: WebUIChatSummary[];
  aktiv: string | null;
  onWaehlen: (id: string) => void;
  onLoeschen: (id: string) => Promise<void>;
  onNeu: () => void;
  onSchliessen: () => void;
}) {
  const [suche, setSuche] = useState("");
  const [loescheId, setLoescheId] = useState<string | null>(null);

  const gruppen = useMemo(() => {
    const q = suche.trim().toLowerCase();
    const liste = chats
      .filter((c) => !c.archived)
      .filter((c) => !q || (c.title || "").toLowerCase().includes(q))
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || ((b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0)));
    const out: { name: string; chats: WebUIChatSummary[] }[] = [];
    for (const c of liste) {
      const name = c.pinned ? "Angeheftet" : tag(c.updated_at ?? c.created_at);
      const g = out[out.length - 1];
      if (g && g.name === name) g.chats.push(c);
      else out.push({ name, chats: [c] });
    }
    return out;
  }, [chats, suche]);

  return (
    <div className={styles.sheet} role="dialog" aria-label="Chat-Verlauf">
      <div className={styles.kopf}>
        <button type="button" className={styles.zurueck} onClick={onSchliessen} aria-label="Zurück zum Chat">‹</button>
        <input
          className={styles.suche}
          type="search"
          placeholder="Chats durchsuchen …"
          value={suche}
          onChange={(e) => setSuche(e.target.value)}
          aria-label="Chats durchsuchen"
        />
        <button type="button" className={styles.neu} onClick={() => { onNeu(); onSchliessen(); }}>
          + Neu
        </button>
      </div>
      <div className={styles.liste}>
        {gruppen.length === 0 && (
          <div className={styles.leer}>{suche ? "Nichts gefunden." : "Noch keine Chats."}</div>
        )}
        {gruppen.map((g) => (
          <section key={g.name} className={styles.gruppe}>
            <div className={styles.gruppenName}>{g.name}</div>
            {g.chats.map((c) => (
              <div key={c.id} className={`${styles.zeile} ${c.id === aktiv ? styles.zeileAktiv : ""}`}>
                {loescheId === c.id ? (
                  <div className={styles.loeschen}>
                    <span>Chat löschen?</span>
                    <button type="button" className={styles.loeschenJa} onClick={async () => { await onLoeschen(c.id); setLoescheId(null); }}>Löschen</button>
                    <button type="button" className={styles.loeschenNein} onClick={() => setLoescheId(null)}>Behalten</button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.titel}
                      onClick={() => { onWaehlen(c.id); onSchliessen(); }}
                    >
                      {c.meta?.app_id && <span className={styles.app}>{String(c.meta.app_id)}</span>}
                      <span className={styles.titelText}>{c.title || "(ohne Titel)"}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.mehr}
                      aria-label="Chat löschen"
                      onClick={() => setLoescheId(c.id)}
                    >
                      🗑
                    </button>
                  </>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
