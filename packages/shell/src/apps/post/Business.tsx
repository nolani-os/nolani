/** Sharing, directory and distribution lists — Outlook-style features at household scale.
 *
 * Three dialogs that together cover what Outlook calls "sharing", "address book"
 * and "contact group":
 *
 *  • **Sharing** — open one of your own folders to someone else. No
 *    administrator needed: JMAP lets everyone share their own folders.
 *  • **Directory** — people search across the mail server and the contacts app.
 *  • **Distribution lists** — personal recipient groups that the composer
 *    expands when sending.
 *
 * Deliberately three levels instead of nine individual rights: "may read",
 * "may read and file", "may do everything except re-share". Someone setting up
 * a share wants to make one decision, not fill in a permission matrix.
 */
import { useCallback, useEffect, useState } from "react";
import styles from "./PostApp.module.css";
import { Icon } from "../../components/Icon";
import { postBusiness, type FreigabeOrdner, type VerzeichnisEintrag, type Verteiler } from "./api";

type Melder = (text: string, fehler?: boolean) => void;

/* ── Sharing ───────────────────────────────────────────────────────────── */

export function FreigabenDialog({ onClose, melde }: { onClose: () => void; melde: Melder }) {
  const [ordner, setOrdner] = useState<FreigabeOrdner[] | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [stufen, setStufen] = useState<{ id: string; name: string }[]>([]);
  const [personen, setPersonen] = useState<VerzeichnisEintrag[]>([]);
  const [offen, setOffen] = useState<string | null>(null);
  const [wen, setWen] = useState("");
  const [stufe, setStufe] = useState("lesen");
  const [laeuft, setLaeuft] = useState(false);

  const laden = useCallback(async () => {
    try {
      const r = await postBusiness.freigaben();
      setOrdner(r.ordner);
      setStufen(r.stufen);
      setHinweis(r.hinweis ?? null);
    } catch (e) {
      melde(e instanceof Error ? e.message : String(e), true);
      setOrdner([]);
    }
  }, [melde]);

  useEffect(() => {
    void laden();
    postBusiness.verzeichnis().then((r) => setPersonen(r.eintraege.filter((p) => p.quelle === "verzeichnis")))
      .catch(() => setPersonen([]));
  }, [laden]);

  const setzen = async (mailboxId: string, person: string, neueStufe: string) => {
    if (!person) { melde("Wen denn?", true); return; }
    setLaeuft(true);
    try {
      const r = await postBusiness.freigabeSetzen(mailboxId, person, neueStufe);
      melde(neueStufe === "keine"
        ? `Freigabe von „${r.ordner}" zurückgenommen`
        : `„${r.ordner}" ist jetzt freigegeben (${r.anzahl_freigaben} ${r.anzahl_freigaben === 1 ? "Person" : "Personen"})`);
      setWen("");
      setOffen(null);
      await laden();
    } catch (e) {
      melde(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <div className={styles.dialogHinter} onClick={onClose}>
      <div className={`${styles.dialog} ${styles.dialogBreit}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogTitel}>
          Freigaben <span className={styles.hinweis}>— wer darf in meine Ordner schauen?</span>
        </div>
        {ordner === null && <div className={styles.leer}>Lade …</div>}
        {ordner?.length === 0 && <div className={styles.leer}>{hinweis ?? "Keine Ordner gefunden."}</div>}
        <div className={styles.regelEditor}>
          {(ordner ?? []).map((o) => (
            <div key={o.id} className={styles.freigabeOrdner}>
              <div className={styles.regelZeile}>
                <Icon name="folder" size={15} />
                <b>{o.name}</b>
                {o.geteilt_mit.length === 0
                  ? <span className={styles.hinweis}>nur für dich</span>
                  : <span className={styles.hinweis}>
                      freigegeben für {o.geteilt_mit.map((g) => g.name).join(", ")}
                    </span>}
                <span style={{ flex: 1 }} />
                {o.darf_freigeben
                  ? <button className={styles.chip} onClick={() => { setOffen(offen === o.id ? null : o.id); setWen(""); }}>
                      <Icon name="plus" size={13} /> Freigeben
                    </button>
                  : <span className={styles.hinweis}>nicht freigebbar</span>}
              </div>

              {o.geteilt_mit.map((g) => (
                <div key={g.id} className={styles.regelZeile} style={{ paddingLeft: "1.6rem" }}>
                  <Icon name="person" size={13} />
                  <span>{g.name}</span>
                  <span className={styles.hinweis}>{g.email}</span>
                  <select className={styles.miniSelect} value={g.stufe} disabled={laeuft}
                          onChange={(e) => void setzen(o.id, g.email || g.id, e.target.value)}>
                    {stufen.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    {g.stufe === "eigene" && <option value="eigene">Eigene Rechte</option>}
                  </select>
                  <button className={styles.iconKnopf} title="Freigabe zurücknehmen" disabled={laeuft}
                          onClick={() => void setzen(o.id, g.email || g.id, "keine")}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}

              {offen === o.id && (
                <div className={styles.regelZeile} style={{ paddingLeft: "1.6rem" }}>
                  <select className={styles.miniSelect} value={wen} onChange={(e) => setWen(e.target.value)}>
                    <option value="">Person wählen …</option>
                    {personen.map((p) => <option key={p.id} value={p.email}>{p.name} ({p.email})</option>)}
                  </select>
                  <select className={styles.miniSelect} value={stufe} onChange={(e) => setStufe(e.target.value)}>
                    {stufen.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button className={`${styles.chip} ${styles.chipAktiv}`} disabled={laeuft || !wen}
                          onClick={() => void setzen(o.id, wen, stufe)}>Freigeben</button>
                  <button className={styles.chip} onClick={() => setOffen(null)}>Abbrechen</button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className={styles.composerFuss}>
          <span className={styles.hinweis}>
            Freigegebene Ordner erscheinen beim anderen als zusätzliches Postfach in der Ordnerspalte.
          </span>
          <span style={{ flex: 1 }} />
          <button className={styles.chip} onClick={onClose}>Schließen</button>
        </div>
      </div>
    </div>
  );
}

/* ── Directory (GAL) ───────────────────────────────────────────────────── */

export function VerzeichnisDialog({ onClose, onSchreiben }:
  { onClose: () => void; onSchreiben: (adresse: string, name: string) => void }) {
  const [q, setQ] = useState("");
  const [eintraege, setEintraege] = useState<VerzeichnisEintrag[]>([]);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(true);

  useEffect(() => {
    let abbruch = false;
    setLaeuft(true);
    const t = setTimeout(() => {
      postBusiness.verzeichnis(q).then((r) => { if (!abbruch) { setEintraege(r.eintraege); setHinweis(r.hinweis ?? null); setLaeuft(false); } })
        .catch(() => { if (!abbruch) setLaeuft(false); });
    }, q ? 220 : 0);   // debounce: do not send every keystroke to the server
    return () => { abbruch = true; clearTimeout(t); };
  }, [q]);

  return (
    <div className={styles.dialogHinter} onClick={onClose}>
      <div className={`${styles.dialog} ${styles.dialogBreit}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogTitel}>
          Verzeichnis <span className={styles.hinweis}>— alle Postfächer und Kontakte</span>
        </div>
        <div className={styles.regelZeile} style={{ padding: "0 0.6rem" }}>
          <Icon name="search" size={15} />
          <input className={styles.miniInput} style={{ flex: 1 }} autoFocus placeholder="Name oder Adresse …"
                 value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className={styles.regelEditor}>
          {laeuft && <div className={styles.leer}>Suche …</div>}
          {!laeuft && hinweis && <div className={styles.warnung}>{hinweis}</div>}
          {!laeuft && eintraege.length === 0 && (
            <div className={styles.leer}>{hinweis ? "Aus der Kontakte-App kam niemand." : "Niemand gefunden."}</div>
          )}
          {eintraege.map((e) => (
            <div key={`${e.quelle}-${e.id}`} className={styles.regelZeile}>
              <Icon name={e.typ === "group" ? "people" : "person"} size={15} />
              <span style={{ minWidth: "12rem" }}>{e.name}</span>
              <span className={styles.hinweis} style={{ flex: 1 }}>{e.email}</span>
              <span className={styles.hinweis}>{e.quelle === "verzeichnis" ? "Postfach" : "Kontakt"}</span>
              <button className={styles.chip} onClick={() => { onSchreiben(e.email, e.name); onClose(); }}>
                <Icon name="mail" size={13} /> Schreiben
              </button>
            </div>
          ))}
        </div>
        <div className={styles.composerFuss}>
          <span className={styles.hinweis}>{eintraege.length} Einträge</span>
          <span style={{ flex: 1 }} />
          <button className={styles.chip} onClick={onClose}>Schließen</button>
        </div>
      </div>
    </div>
  );
}

/* ── Distribution lists ────────────────────────────────────────────────── */

export function VerteilerDialog({ onClose, melde }: { onClose: () => void; melde: Melder }) {
  const [liste, setListe] = useState<Verteiler[] | null>(null);
  const [personen, setPersonen] = useState<VerzeichnisEintrag[]>([]);
  const [name, setName] = useState("");
  const [mitglieder, setMitglieder] = useState<string[]>([]);
  const [neu, setNeu] = useState("");
  const [laeuft, setLaeuft] = useState(false);

  const laden = useCallback(async () => {
    try { setListe((await postBusiness.verteiler()).verteiler); }
    catch (e) { melde(e instanceof Error ? e.message : String(e), true); setListe([]); }
  }, [melde]);

  useEffect(() => {
    void laden();
    postBusiness.verzeichnis().then((r) => setPersonen(r.eintraege)).catch(() => setPersonen([]));
  }, [laden]);

  const bearbeiten = (v: Verteiler) => { setName(v.name); setMitglieder(v.mitglieder); };

  const speichern = async () => {
    if (!name.trim() || mitglieder.length === 0) { melde("Name und mindestens ein Mitglied", true); return; }
    setLaeuft(true);
    try {
      await postBusiness.verteilerSetzen(name.trim(), mitglieder);
      melde(`Verteiler „${name.trim()}" gespeichert (${mitglieder.length})`);
      setName(""); setMitglieder([]);
      await laden();
    } catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
    finally { setLaeuft(false); }
  };

  const loeschen = async (v: string) => {
    setLaeuft(true);
    try { await postBusiness.verteilerLoeschen(v); melde(`„${v}" gelöscht`); await laden(); }
    catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
    finally { setLaeuft(false); }
  };

  return (
    <div className={styles.dialogHinter} onClick={onClose}>
      <div className={`${styles.dialog} ${styles.dialogBreit}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogTitel}>
          Verteiler <span className={styles.hinweis}>— eigene Empfängergruppen</span>
        </div>
        <div className={styles.regelnKoerper}>
          <div className={styles.regelListe}>
            {liste === null && <div className={styles.leer}>Lade …</div>}
            {liste?.length === 0 && <div className={styles.leer}>Noch keiner.</div>}
            {(liste ?? []).map((v) => (
              <div key={v.name} className={styles.regelZeile}>
                <button className={styles.link} style={{ flex: 1, textAlign: "left" }} onClick={() => bearbeiten(v)}>
                  <Icon name="people" size={13} /> {v.name}
                </button>
                <span className={styles.hinweis}>{v.mitglieder.length}</span>
                <button className={styles.iconKnopf} title="Löschen" disabled={laeuft}
                        onClick={() => void loeschen(v.name)}><Icon name="close" size={12} /></button>
              </div>
            ))}
          </div>
          <div className={styles.regelEditor}>
            <div className={styles.regelAbschnitt}>Name</div>
            <input className={styles.miniInput} value={name} placeholder="z. B. Familie"
                   onChange={(e) => setName(e.target.value)} />
            <div className={styles.regelAbschnitt}>Mitglieder ({mitglieder.length})</div>
            {mitglieder.map((m) => (
              <div key={m} className={styles.regelZeile}>
                <Icon name="person" size={13} /><span style={{ flex: 1 }}>{m}</span>
                <button className={styles.iconKnopf} onClick={() => setMitglieder(mitglieder.filter((x) => x !== m))}>
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
            <div className={styles.regelZeile}>
              <select className={styles.miniSelect} value="" onChange={(e) => {
                if (e.target.value && !mitglieder.includes(e.target.value)) setMitglieder([...mitglieder, e.target.value]);
              }}>
                <option value="">Aus dem Verzeichnis …</option>
                {personen.map((p) => <option key={`${p.quelle}-${p.id}`} value={p.email}>{p.name} ({p.email})</option>)}
              </select>
              <input className={styles.miniInput} value={neu} placeholder="oder Adresse tippen"
                     onChange={(e) => setNeu(e.target.value)}
                     onKeyDown={(e) => {
                       if (e.key === "Enter" && neu.includes("@")) {
                         if (!mitglieder.includes(neu.trim())) setMitglieder([...mitglieder, neu.trim()]);
                         setNeu("");
                       }
                     }} />
            </div>
            <div className={styles.composerFuss}>
              <button className={`${styles.chip} ${styles.chipAktiv}`} disabled={laeuft} onClick={() => void speichern()}>
                Speichern
              </button>
              <button className={styles.chip} onClick={() => { setName(""); setMitglieder([]); }}>Leeren</button>
              <span style={{ flex: 1 }} />
              <button className={styles.chip} onClick={onClose}>Schließen</button>
            </div>
            <div className={styles.hinweis} style={{ padding: "0.4rem 0" }}>
              Im Composer genügt der Verteilername als Empfänger — beim Senden wird er durch die
              Mitglieder ersetzt. Adressen, die doppelt vorkämen, fallen dabei weg.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
