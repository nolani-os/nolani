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
import { regionLocale, useTranslation, type TFunction } from "@claraos/core";

function tag(t: TFunction, ts?: number): string {
  if (!ts) return t("history.group.earlier");
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  const heute = new Date();
  const gestern = new Date(heute);
  gestern.setDate(heute.getDate() - 1);
  const gleich = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (gleich(d, heute)) return t("history.group.today");
  if (gleich(d, gestern)) return t("history.group.yesterday");
  const tage = Math.floor((heute.getTime() - ms) / 86_400_000);
  if (tage < 7) return t("history.group.thisWeek");
  return d.toLocaleDateString(regionLocale(), { month: "long", year: "numeric" });
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
  const { t } = useTranslation("mobile");
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
      const name = c.pinned ? t("history.group.pinned") : tag(t, c.updated_at ?? c.created_at);
      const g = out[out.length - 1];
      if (g && g.name === name) g.chats.push(c);
      else out.push({ name, chats: [c] });
    }
    return out;
  }, [chats, suche, t]);

  return (
    <div className={styles.sheet} role="dialog" aria-label={t("history.label")}>
      <div className={styles.kopf}>
        <button type="button" className={styles.zurueck} onClick={onSchliessen} aria-label={t("history.back")}>‹</button>
        <input
          className={styles.suche}
          type="search"
          placeholder={t("history.searchPlaceholder")}
          value={suche}
          onChange={(e) => setSuche(e.target.value)}
          aria-label={t("history.searchLabel")}
        />
        <button type="button" className={styles.neu} onClick={() => { onNeu(); onSchliessen(); }}>
          {t("history.new")}
        </button>
      </div>
      <div className={styles.liste}>
        {gruppen.length === 0 && (
          <div className={styles.leer}>{suche ? t("history.noResults") : t("history.empty")}</div>
        )}
        {gruppen.map((g) => (
          <section key={g.name} className={styles.gruppe}>
            <div className={styles.gruppenName}>{g.name}</div>
            {g.chats.map((c) => (
              <div key={c.id} className={`${styles.zeile} ${c.id === aktiv ? styles.zeileAktiv : ""}`}>
                {loescheId === c.id ? (
                  <div className={styles.loeschen}>
                    <span>{t("history.deleteQuestion")}</span>
                    <button type="button" className={styles.loeschenJa} onClick={async () => { await onLoeschen(c.id); setLoescheId(null); }}>{t("history.delete")}</button>
                    <button type="button" className={styles.loeschenNein} onClick={() => setLoescheId(null)}>{t("history.keep")}</button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.titel}
                      onClick={() => { onWaehlen(c.id); onSchliessen(); }}
                    >
                      {c.meta?.app_id && <span className={styles.app}>{String(c.meta.app_id)}</span>}
                      <span className={styles.titelText}>{c.title || t("history.untitled")}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.mehr}
                      aria-label={t("history.deleteLabel")}
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
