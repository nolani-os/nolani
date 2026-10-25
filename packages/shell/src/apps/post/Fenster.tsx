/** "One window": cross-source search and profile card.
 *
 * Important: search shows **four groups** instead of one mixed list. A ranking
 * across mail, contacts, tasks and events would be made up — nobody can say
 * whether yesterday's mail is "more relevant" than tomorrow's event.
 * Groups let the person decide.
 *
 * If a source fails, the API says so (`nicht_erreicht`) and this UI shows it.
 * "Nothing found" and "could not check" are two different statements.
 *
 */
import { useCallback, useEffect, useState } from "react";
import styles from "./PostApp.module.css";
import { Icon } from "../../components/Icon";
import { postFenster, type SucheErgebnis, type Profil } from "./api";
import { regionLocale, useTranslation } from "@claraos/core";

type Melder = (text: string, fehler?: boolean) => void;

function datumKurz(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(regionLocale(), { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/* ── Cross-source search ───────────────────────────────────────────────── */

export function SucheDialog({ start, onClose, onMail, onApp, melde }: {
  start: string;
  onClose: () => void;
  onMail: (id: string) => void;
  onApp: (app: string) => void;
  melde: Melder;
}) {
  const { t } = useTranslation("post");
  const [q, setQ] = useState(start);
  const [erg, setErg] = useState<SucheErgebnis | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  const suchen = useCallback(async (begriff: string) => {
    if (begriff.trim().length < 2) { setErg(null); return; }
    setLaeuft(true);
    try {
      setErg(await postFenster.suche(begriff.trim()));
    } catch (e) {
      melde(e instanceof Error ? e.message : String(e), true);
      setErg(null);
    } finally {
      setLaeuft(false);
    }
  }, [melde]);

  useEffect(() => {
    // Debounce: do not send every keystroke to four sources.
    const timer = setTimeout(() => void suchen(q), q === start ? 0 : 350);
    return () => clearTimeout(timer);
  }, [q, start, suchen]);

  const gruppe = (titel: string, eintraege: { id: string | number; titel: string; zeile?: string; datum?: string | null }[],
                  symbol: Parameters<typeof Icon>[0]["name"], beiKlick: (id: string | number) => void) => (
    eintraege.length > 0 && (
      <div className={styles.sucheGruppe}>
        <div className={styles.tagTitel}><Icon name={symbol} size={13} /> {titel} ({eintraege.length})</div>
        {eintraege.map((e) => (
          <button key={`${titel}-${e.id}`} className={styles.sucheTreffer} onClick={() => beiKlick(e.id)}>
            <span className={styles.tagText}>{e.titel}</span>
            {e.zeile && <span className={styles.hinweis}>{e.zeile}</span>}
            <span className={styles.hinweis}>{datumKurz(e.datum)}</span>
          </button>
        ))}
      </div>
    )
  );

  return (
    <div className={styles.dialogHinter} onClick={onClose}>
      <div className={`${styles.dialog} ${styles.dialogBreit}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogTitel}>
          {t("search.title")} <span className={styles.hinweis}>{t("search.titleHint")}</span>
        </div>
        <div className={styles.regelZeile} style={{ padding: "0 0.6rem" }}>
          <Icon name="search" size={15} />
          <input className={styles.miniInput} style={{ flex: 1 }} autoFocus value={q}
                 placeholder={t("search.placeholder")} onChange={(e) => setQ(e.target.value)} />
        </div>

        <div className={styles.regelEditor}>
          {laeuft && <div className={styles.leer}>{t("search.searching")}</div>}
          {!laeuft && erg && (erg.nicht_erreicht?.length ?? 0) > 0 && (
            <div className={styles.warnung}>
              {t("search.unreached", { sources: erg.nicht_erreicht.join(", ") })}
            </div>
          )}
          {!laeuft && erg && erg.gesamt === 0 && (
            <div className={styles.leer}>{t("search.nothing", { term: erg.suchbegriff })}</div>
          )}
          {!laeuft && erg && (
            <>
              {gruppe(t("search.mails"), erg.mails, "mail", (id) => { onMail(String(id)); onClose(); })}
              {gruppe(t("search.contacts"), erg.kontakte, "person", () => { onApp("kontakte"); onClose(); })}
              {gruppe(t("search.tasks"), erg.aufgaben, "check", () => { onApp("planner"); onClose(); })}
              {gruppe(t("search.events"), erg.termine, "calendar", () => { onApp("planner"); onClose(); })}
            </>
          )}
        </div>

        <div className={styles.composerFuss}>
          <span className={styles.hinweis}>{erg?.hinweis ?? t("search.minChars")}</span>
          <span style={{ flex: 1 }} />
          <button className={styles.chip} onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Profile card ──────────────────────────────────────────────────────── */

export function ProfilKarte({ email, name, onClose, onMail, onSchreiben }: {
  email: string;
  name?: string;
  onClose: () => void;
  onMail: (id: string) => void;
  onSchreiben: (email: string, name: string) => void;
}) {
  const { t } = useTranslation("post");
  const [p, setP] = useState<Profil | null>(null);
  const [laeuft, setLaeuft] = useState(true);

  useEffect(() => {
    let weg = false;
    postFenster.profil(email)
      .then((d) => { if (!weg) { setP(d); setLaeuft(false); } })
      .catch(() => { if (!weg) setLaeuft(false); });
    return () => { weg = true; };
  }, [email]);

  return (
    <div className={styles.dialogHinter} onClick={onClose}>
      <div className={styles.dialog} style={{ minWidth: 380, maxWidth: "92%" }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogTitel}>
          {p?.kontakt?.name || name || email}
          <span className={styles.hinweis}> — {email}</span>
        </div>

        {laeuft && <div className={styles.leer}>{t("common.loading")}</div>}

        {!laeuft && p && (
          <div className={styles.regelEditor}>
            {p.kontakt ? (
              <div className={styles.regelZeile}>
                <Icon name="person" size={14} />
                <span>{p.kontakt.name}</span>
                {p.kontakt.firma && <span className={styles.hinweis}>{p.kontakt.firma}</span>}
                {(p.kontakt.telefone ?? []).map((nr) => <span key={nr} className={styles.hinweis}>{nr}</span>)}
              </div>
            ) : (
              <div className={styles.hinweis} style={{ padding: "0.3rem 0" }}>
                {t("profile.noContact")}
              </div>
            )}

            <div className={styles.tagTitel} style={{ marginTop: "0.7rem" }}>
              <Icon name="mail" size={13} /> {t("profile.recentMails", { count: p.mails.length })}
            </div>
            {p.mails.length === 0 && <div className={styles.hinweis}>{t("profile.noneFound")}</div>}
            {p.mails.map((m) => (
              <button key={m.id} className={styles.sucheTreffer} onClick={() => { onMail(String(m.id)); onClose(); }}>
                <span className={styles.tagText}>{m.titel}</span>
                <span className={styles.hinweis}>{datumKurz(m.datum)}</span>
              </button>
            ))}

            <div className={styles.tagTitel} style={{ marginTop: "0.7rem" }}>
              <Icon name="calendar" size={13} /> {t("profile.sharedEvents", { count: p.termine.length })}
            </div>
            {p.termine.length === 0 && <div className={styles.hinweis}>{t("profile.noneFound")}</div>}
            {p.termine.map((x) => (
              <div key={x.id} className={styles.tagZeile}>
                <span className={styles.tagZeit}>{datumKurz(x.datum)}</span>
                <span className={styles.tagText}>{x.titel}</span>
              </div>
            ))}

            {(p.nicht_erreicht?.length ?? 0) > 0 && (
              <div className={styles.warnung} style={{ marginTop: "0.6rem" }}>
                {t("profile.unreached", { sources: p.nicht_erreicht.join(", ") })}
              </div>
            )}
          </div>
        )}

        <div className={styles.composerFuss}>
          <button className={`${styles.chip} ${styles.chipAktiv}`}
                  onClick={() => { onSchreiben(email, p?.kontakt?.name || name || ""); onClose(); }}>
            <Icon name="pen" size={13} /> {t("common.write")}
          </button>
          <span style={{ flex: 1 }} />
          <button className={styles.chip} onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
