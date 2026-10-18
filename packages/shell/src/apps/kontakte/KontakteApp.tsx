/** Contacts — ClaraOS holds the data itself.
 *
 * Important: two things this UI does differently from a typical address book:
 *
 *  1. **Nothing simply disappears.** "Remove" is a tombstone with a trash bin,
 *     every change lands in the history and can be restored. Permanent
 *     deletion exists too — but as a separate, inconvenient path, because it
 *     is irreversible.
 *
 *  2. **A service handle only promises what it can keep.** "Federated"
 *     (Matrix, Nextcloud, Mastodon) gets a coloured badge; LinkedIn, X and
 *     Facebook are references and only get "open profile". If both looked
 *     the same, the app would be lying.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./KontakteApp.module.css";
import { useIsMobile } from "../../Mobile/useIsMobile";
import { Werkzeugleiste } from "../../components/Werkzeugleiste";
import { IconButton } from "../../components/Button";
import { ActionSheet } from "../../components/ActionSheet";
import {
  kontakteApi, profilUrl,
  type Fassung, type GoogleStatus, type Handle, type Kontakt, type KontaktDaten,
  type Block, type Dienst, type Freigabe, type MeineTeams, type ProjektionStatus,
  type RegelStatus, type Vorschlag,
} from "./api";

type Ansicht = "detail" | "bearbeiten" | "verlauf" | "quellen" | "vorschlaege";

const LEERE_DATEN: KontaktDaten = { namen: {}, mails: [], telefone: [] };

function nurGefuellt<T extends Record<string, unknown>>(liste: T[], schluessel: keyof T): T[] {
  return liste.filter((e) => String(e[schluessel] ?? "").trim() !== "");
}

/** Two letters for the avatar circle: "Anna Beispiel" → "AB". */
function initialen(name: string): string {
  const teile = name.trim().split(/\s+/).filter(Boolean);
  if (teile.length === 0) return "?";
  return (teile.length === 1 ? teile[0].slice(0, 2) : teile[0][0] + teile[teile.length - 1][0]).toUpperCase();
}

export default function KontakteApp({ windowId }: { windowId: string }) {
  const mobil = useIsMobile();
  const [kontakte, setKontakte] = useState<Kontakt[] | null>(null);
  const [gewaehlt, setGewaehlt] = useState<Kontakt | null>(null);
  const [ansicht, setAnsicht] = useState<Ansicht>("detail");
  const [suche, setSuche] = useState("");
  const [papierkorb, setPapierkorb] = useState(false);
  const [entwurf, setEntwurf] = useState<KontaktDaten | null>(null);
  const [fassungen, setFassungen] = useState<Fassung[] | null>(null);
  const [meldung, setMeldung] = useState<{ text: string; fehler?: boolean } | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [projektion, setProjektion] = useState<ProjektionStatus | null>(null);
  const [vorschlaege, setVorschlaege] = useState<Vorschlag[] | null>(null);
  const [teams, setTeams] = useState<MeineTeams | null>(null);
  // On phones the less frequent paths are collapsed (see .zweitReihe in the CSS).
  const [mehr, setMehr] = useState(false);
  const [dienste, setDienste] = useState<Dienst[]>([]);
  const [regel, setRegel] = useState<RegelStatus | null>(null);
  const [freigaben, setFreigaben] = useState<{ freigaben: Freigabe[]; blocks: Block[] } | null>(null);
  const dateiRef = useRef<HTMLInputElement>(null);

  const laden = useCallback(async (behalteId?: string) => {
    try {
      const r = await kontakteApi.liste(suche.trim() || undefined, papierkorb);
      setKontakte(r.contacts);
      if (behalteId) {
        const noch = r.contacts.find((c) => c.id === behalteId);
        if (!noch) setGewaehlt(null);
      }
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
      setKontakte([]);
    }
  }, [suche, papierkorb]);

  useEffect(() => { void laden(); }, [laden]);

  useEffect(() => {
    void kontakteApi.googleStatus().then(setGoogle).catch(() => {});
    void kontakteApi.projektionStatus().then(setProjektion).catch(() => {});
    void kontakteApi.meineTeams().then(setTeams).catch(() => {});
    void kontakteApi.dienste().then((r) => setDienste(r.dienste)).catch(() => {});
    void kontakteApi.regelLesen().then(setRegel).catch(() => {});
  }, []);

  // Important: Google's redirect lands on `/?app=kontakte&google=…`. The shell
  // removes `?app=` itself, we pick up the rest here — otherwise the user would
  // return from the consent screen and see no word about whether it worked.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const g = p.get("google");
    if (!g) return;
    const text = p.get("meldung") || "";
    setMeldung(
      g === "verbunden"
        ? { text: `Google verbunden${text ? ` (${text})` : ""}. Jetzt „Von Google holen" drücken.` }
        : g === "abgebrochen"
          ? { text: `Freigabe abgebrochen${text ? `: ${text}` : "."}` }
          : { text: text || "Die Google-Freigabe hat nicht geklappt.", fehler: true },
    );
    p.delete("google"); p.delete("meldung");
    const qs = p.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    void kontakteApi.googleStatus().then(setGoogle).catch(() => {});
  }, []);

  const oeffnen = useCallback(async (id: string) => {
    try {
      const voll = await kontakteApi.einer(id);
      setGewaehlt(voll);
      kontakteApi.freigaben(id).then(setFreigaben).catch(() => setFreigaben(null));
      setAnsicht("detail");
      setEntwurf(null);
      setFassungen(null);
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, []);

  // ── Saving ───────────────────────────────────────────────────────────────
  const speichern = useCallback(async () => {
    if (!entwurf) return;
    setLaeuft(true);
    try {
      // Important: `frei` and everything unknown are sent back UNCHANGED. Sending
      // back only the fields the form knows would lose, on every save, what
      // ClaraOS deliberately keeps as a superset.
      const daten: KontaktDaten = {
        ...(gewaehlt?.data ?? {}),
        ...entwurf,
        mails: nurGefuellt(entwurf.mails ?? [], "wert"),
        telefone: nurGefuellt(entwurf.telefone ?? [], "wert"),
      };
      if (gewaehlt) {
        const r = await kontakteApi.aendern(gewaehlt.id, daten);
        setMeldung({ text: r.geaendert ? "Gespeichert." : "Unverändert — nichts zu speichern." });
        await oeffnen(gewaehlt.id);
      } else {
        const r = await kontakteApi.anlegen(daten);
        setMeldung({ text: "Angelegt." });
        await oeffnen(r.id);
      }
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    } finally {
      setLaeuft(false);
    }
  }, [entwurf, gewaehlt, laden, oeffnen]);

  const entfernen = useCallback(async () => {
    if (!gewaehlt) return;
    try {
      await kontakteApi.entfernen(gewaehlt.id);
      setMeldung({ text: "Entfernt — liegt im Papierkorb und ist wiederherstellbar." });
      setGewaehlt(null);
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, laden]);

  const endgueltig = useCallback(async () => {
    if (!gewaehlt) return;
    const name = gewaehlt.anzeigename;
    // Warning: two sentences, no "Are you sure?". The second says what is lost —
    // otherwise you click away something you can't oversee.
    if (!window.confirm(
      `„${name}" ENDGÜLTIG löschen?\n\n` +
      "Kontakt, alle früheren Fassungen und die Herkunftsdaten werden " +
      "unwiderruflich gelöscht. Das ist NICHT der Papierkorb.")) return;
    try {
      const r = await kontakteApi.endgueltigLoeschen(gewaehlt.id);
      setMeldung({ text: `„${name}" endgültig gelöscht (mit ${r.fassungen} Fassungen).` });
      setGewaehlt(null);
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, laden]);

  const wiederherstellen = useCallback(async () => {
    if (!gewaehlt) return;
    try {
      await kontakteApi.wiederherstellen(gewaehlt.id);
      setMeldung({ text: "Wiederhergestellt." });
      await oeffnen(gewaehlt.id);
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, laden, oeffnen]);

  const verlaufZeigen = useCallback(async () => {
    if (!gewaehlt) return;
    try {
      const r = await kontakteApi.fassungen(gewaehlt.id);
      setFassungen(r.versions);
      setAnsicht("verlauf");
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt]);

  const fassungZurueck = useCallback(async (seq: number) => {
    if (!gewaehlt) return;
    try {
      await kontakteApi.fassungZurueck(gewaehlt.id, seq);
      setMeldung({ text: `Stand ${seq} ist wieder aktuell. Der bisherige Stand steht jetzt im Verlauf.` });
      await oeffnen(gewaehlt.id);
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, laden, oeffnen]);

  const importieren = useCallback(async (datei: File) => {
    setLaeuft(true);
    setMeldung({ text: `„${datei.name}" wird eingelesen…` });
    try {
      const r = await kontakteApi.importVcf(datei);
      const teile = [`${r.neu} neu`, `${r.geaendert} geändert`, `${r.unveraendert} unverändert`];
      if (r.uebersprungen) teile.push(`${r.uebersprungen} übersprungen`);
      setMeldung({ text: `${r.gesehen} Karten gelesen: ${teile.join(", ")}.` });
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    } finally {
      setLaeuft(false);
      if (dateiRef.current) dateiRef.current.value = "";
    }
  }, [laden]);

  const googleVerbinden = useCallback(async () => {
    try {
      const r = await kontakteApi.googleStart();
      // Full window, not a popup: Google blocks consent in embedded contexts,
      // and a blocked tab looks like a broken button.
      window.location.href = r.url;
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, []);

  const googleHolen = useCallback(async (voll = false) => {
    setLaeuft(true);
    setMeldung({ text: voll ? "Vollabgleich mit Google läuft…" : "Google wird abgeglichen…" });
    try {
      const r = await kontakteApi.googleSync(voll);
      const teile = [`${r.neu} neu`, `${r.geaendert} geändert`, `${r.unveraendert} unverändert`];
      if (r.uebersprungen) teile.push(`${r.uebersprungen} übersprungen`);
      if (r.konflikt) teile.push(`${r.konflikt} mit Konflikt`);
      setMeldung({
        text: `${r.vollabgleich ? "Vollabgleich" : "Abgleich"} mit ${r.konto || "Google"}: `
            + `${r.gesehen} gesehen — ${teile.join(", ")}.`
            + (r.konflikt ? " Bei Konflikten gilt dein Stand; der Google-Stand liegt als Vorschlag am Kontakt." : ""),
      });
      await laden();
      setGoogle(await kontakteApi.googleStatus());
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    } finally {
      setLaeuft(false);
    }
  }, [laden]);

  const googleTrennen = useCallback(async () => {
    if (!window.confirm(
      "Google-Zugang lösen?\n\nDeine Kontakte bleiben vollständig in ClaraOS — "
      + "gelöst wird nur die Verbindung.")) return;
    try {
      const r = await kontakteApi.googleTrennen();
      setMeldung({ text: r.hinweis });
      setGoogle(await kontakteApi.googleStatus());
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, []);

  const vorschlaegeHolen = useCallback(async () => {
    setAnsicht("vorschlaege");
    setVorschlaege(null);
    try {
      const r = await kontakteApi.vorschlaege();
      setVorschlaege(r.vorschlaege);
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
      setVorschlaege([]);
    }
  }, []);

  const entscheiden = useCallback(async (v: Vorschlag, bestaetigt: boolean) => {
    try {
      await kontakteApi.linkSetzen(v.contact_id, v.username, v.matched_on, bestaetigt);
      setVorschlaege((alt) => (alt ?? []).filter((x) => x.contact_id !== v.contact_id));
      setMeldung({
        text: bestaetigt
          ? `„${v.anzeigename}" ist jetzt mit ${v.username} verknüpft.`
          : `Abgelehnt — dieser Vorschlag kommt nicht wieder.`,
      });
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [laden]);

  const linkLoesen = useCallback(async (username: string) => {
    if (!gewaehlt) return;
    try {
      await kontakteApi.linkLoesen(gewaehlt.id, username);
      setMeldung({ text: `Verknüpfung mit ${username} aufgehoben.` });
      await oeffnen(gewaehlt.id);
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, oeffnen]);

  const handleSetzen = useCallback(async (service: string, handle: string) => {
    if (!gewaehlt) return;
    try {
      const r = await kontakteApi.handleSetzen(gewaehlt.id, service, handle);
      setMeldung({
        text: r.klasse === "foederiert"
          ? `${service} hinzugefügt — dort kann ClaraOS wirklich etwas tun.`
          : r.klasse === "bridge"
            ? `${service} hinzugefügt — erreichbar erst, wenn die Brücke läuft.`
            : `${service} hinzugefügt — ClaraOS kann dort nur das Profil öffnen.`,
      });
      await oeffnen(gewaehlt.id);
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, oeffnen]);

  const handleWeg = useCallback(async (service: string, handle: string) => {
    if (!gewaehlt) return;
    try {
      await kontakteApi.handleWeg(gewaehlt.id, service, handle);
      await oeffnen(gewaehlt.id);
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, oeffnen]);

  const teilen = useCallback(async (mit: string) => {
    if (!gewaehlt) return;
    try {
      const r = await kontakteApi.teilen(gewaehlt.id, mit);
      setMeldung({ text: `„${gewaehlt.anzeigename}" ist jetzt für ${r.name} sichtbar — nur lesend.` });
      setFreigaben(await kontakteApi.freigaben(gewaehlt.id));
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt]);

  const teilenZurueck = useCallback(async (mit: string) => {
    if (!gewaehlt) return;
    try {
      await kontakteApi.teilenZurueck(gewaehlt.id, mit);
      setFreigaben(await kontakteApi.freigaben(gewaehlt.id));
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt]);

  const blocken = useCallback(async (service: string) => {
    if (!gewaehlt) return;
    try {
      const r = await kontakteApi.blocken(gewaehlt.id, service);
      // Important: the server's notice says what REALLY happened — not what
      // we would like. It is passed through unchanged.
      setMeldung({ text: r.hinweis, fehler: r.zustand === "fehlgeschlagen" });
      setFreigaben(await kontakteApi.freigaben(gewaehlt.id));
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt]);

  const blockAufheben = useCallback(async (service: string) => {
    if (!gewaehlt) return;
    try {
      await kontakteApi.blockAufheben(gewaehlt.id, service);
      setFreigaben(await kontakteApi.freigaben(gewaehlt.id));
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt]);

  const regelSetzen = useCallback(async (wert: string) => {
    try {
      await kontakteApi.regelSetzen(wert);
      setRegel(await kontakteApi.regelLesen());
      setMeldung({ text: "Erreichbarkeit geändert." });
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, []);

  const aufsHandy = useCallback(async () => {
    setLaeuft(true);
    setMeldung({ text: "Adressbuch wird abgeglichen…" });
    try {
      const r = await kontakteApi.projektionSync();
      const teile = [`${r.geschrieben} geschrieben`, `${r.unveraendert} unverändert`];
      if (r.geloescht) teile.push(`${r.geloescht} entfernt`);
      if (r.fehler) teile.push(`${r.fehler} fehlgeschlagen`);
      setMeldung({
        text: (r.neu_angelegt ? `Adressbuch „${r.adressbuch}" angelegt. ` : "")
            + `${r.geprueft} Kontakte geprüft: ${teile.join(", ")}.`
            + (r.fehler_texte.length ? ` (${r.fehler_texte[0]})` : ""),
        fehler: r.fehler > 0,
      });
      setProjektion(await kontakteApi.projektionStatus());
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    } finally {
      setLaeuft(false);
    }
  }, []);

  const carddavHolen = useCallback(async () => {
    setLaeuft(true);
    setMeldung({ text: "Nextcloud-Adressbücher werden gelesen…" });
    try {
      const r = await kontakteApi.importCarddav();
      const teile = [`${r.neu} neu`, `${r.geaendert} geändert`, `${r.unveraendert} unverändert`];
      if (r.uebersprungen) teile.push(`${r.uebersprungen} übersprungen`);
      setMeldung({
        text: r.adressbuecher.length
          ? `${r.adressbuecher.join(", ")}: ${r.gesehen} Karten — ${teile.join(", ")}`
            + (r.bilder ? `, ${r.bilder} Bilder` : "")
          : "Keine eigenen Adressbücher in Nextcloud gefunden.",
      });
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    } finally {
      setLaeuft(false);
    }
  }, [laden]);

  const bearbeitenStarten = useCallback((neu: boolean) => {
    setEntwurf(neu ? { ...LEERE_DATEN } : JSON.parse(JSON.stringify(gewaehlt?.data ?? LEERE_DATEN)));
    if (neu) setGewaehlt(null);
    setAnsicht("bearbeiten");
  }, [gewaehlt]);

  // On phones the detail column also shows sources/matching — otherwise both
  // views would be unreachable there (toolbar).
  const mobilDetailOffen = !!(gewaehlt || entwurf) || ansicht === "quellen" || ansicht === "vorschlaege";
  const mobilKlasse = useMemo(() => {
    if (!mobil) return "";
    return mobilDetailOffen ? styles.mobilDetail : styles.mobilListe;
  }, [mobil, mobilDetailOffen]);
  const [mehrBlatt, setMehrBlatt] = useState(false);
  const zurListe = () => { setGewaehlt(null); setEntwurf(null); setAnsicht("detail"); };

  return (
    <div className={styles.app} data-window={windowId}>
      <div className={`${styles.kopf} ${mobil ? styles.kopfMobil : ""}`}>
        {mobil && mobilDetailOffen ? (
          <div className={styles.kopfZeile}>
            <IconButton label="Zurück zur Liste" icon="back" onClick={zurListe} />
            <span className={styles.kopfTitel}>
              {ansicht === "quellen" ? "Quellen" : ansicht === "vorschlaege" ? "Abgleich" : entwurf ? "Kontakt bearbeiten" : "Kontakt"}
            </span>
          </div>
        ) : (
          <>
            {mobil && <h2 className={styles.kopfTitel}>{papierkorb ? "Papierkorb" : "Kontakte"}</h2>}
            <input className={styles.suche} placeholder={mobil ? "Suchen…" : "Suchen — Name, Firma, Nummer, Handle…"}
                   value={suche} onChange={(e) => setSuche(e.target.value)} />
            {!mobil && (
            <button className={`${styles.knopf} ${styles.knopfHaupt}`}
                    onClick={() => bearbeitenStarten(true)}>+ Neu</button>
            )}
            {!mobil && (
            <button className={`${styles.knopf} ${styles.mehrKnopf}`}
                    aria-expanded={mehr}
                    onClick={() => setMehr(!mehr)}>{mehr ? "Weniger" : "Mehr"}</button>
            )}
            {!mobil && (
            <div className={`${styles.zweitReihe} ${mehr ? styles.zweitReiheOffen : ""}`}>
              <button className={styles.knopf} disabled={laeuft}
                      onClick={() => dateiRef.current?.click()}>Import .vcf</button>
              <a className={styles.knopf} href={kontakteApi.exportUrl()}
                 title="Alle Kontakte als .vcf sichern">Export</a>
              <button className={styles.knopf} onClick={() => { setPapierkorb(!papierkorb); setGewaehlt(null); }}>
                {papierkorb ? "Adressbuch" : "Papierkorb"}
              </button>
              <button className={styles.knopf} onClick={vorschlaegeHolen}>Abgleich</button>
              <button className={styles.knopf}
                      onClick={() => setAnsicht(ansicht === "quellen" ? "detail" : "quellen")}>
                Quellen
              </button>
            </div>
            )}
          </>
        )}
        <input ref={dateiRef} type="file" accept=".vcf,text/vcard" style={{ display: "none" }}
               onChange={(e) => { const f = e.target.files?.[0]; if (f) void importieren(f); }} />
      </div>

      {meldung && (
        <div className={`${styles.hinweis} ${meldung.fehler ? styles.fehler : ""}`}
             role={meldung.fehler ? "alert" : "status"} onClick={() => setMeldung(null)}>
          {meldung.text}
        </div>
      )}

      <div className={`${styles.koerper} ${mobilKlasse}`}>
        <div className={styles.liste}>
          {kontakte === null && <div className={styles.leer}>Lade…</div>}
          {kontakte?.length === 0 && (
            <div className={styles.leer}>
              {papierkorb
                ? "Der Papierkorb ist leer."
                : suche
                  ? "Nichts gefunden."
                  : "Noch keine Kontakte.\nLade eine .vcf-Datei hoch — aus Google Kontakte oder vom Handy exportiert."}
            </div>
          )}
          {kontakte?.map((k) => (
            <div key={k.id}
                 className={`${styles.eintrag} ${gewaehlt?.id === k.id ? styles.eintragAktiv : ""}`}
                 onClick={() => void oeffnen(k.id)}>
              {/* Avatar circle with initials as fallback — previously there was
                  nothing without a photo, and the list was a wall of text. */}
              <span className={styles.avatar} aria-hidden="true">
                {k.photo_id ? (
                  <img className={styles.bildKlein} src={kontakteApi.fotoUrl(k.id)} alt=""
                       loading="lazy"
                       onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                ) : initialen(k.anzeigename)}
              </span>
              <div className={styles.eintragText}>
                <div className={styles.eintragName}>{k.anzeigename}</div>
                <div className={styles.eintragUnten}>
                  {k.data.organisation?.firma
                    || k.data.mails?.[0]?.wert
                    || k.data.telefone?.[0]?.wert
                    || "—"}
                  {k.fremd ? " · geteilt" : ""}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className={styles.detail}>
          {ansicht === "bearbeiten" && entwurf && (
            <Bearbeiten entwurf={entwurf} setEntwurf={setEntwurf} laeuft={laeuft}
                        onSpeichern={speichern}
                        onAbbrechen={() => {
                          setEntwurf(null);
                          setAnsicht("detail");
                        }} />
          )}

          {ansicht === "vorschlaege" && (
            <Vorschlaege liste={vorschlaege} teams={teams}
                         onEntscheiden={entscheiden}
                         onZurueck={() => setAnsicht("detail")} />
          )}

          {ansicht === "quellen" && (
            <Quellen google={google} projektion={projektion} laeuft={laeuft}
                     regel={regel} onRegel={regelSetzen} onCarddav={carddavHolen}
                     onVerbinden={googleVerbinden}
                     onHolen={googleHolen}
                     onTrennen={googleTrennen}
                     onAufsHandy={aufsHandy}
                     onZurueck={() => setAnsicht("detail")} />
          )}

          {ansicht === "verlauf" && gewaehlt && (
            <Verlauf kontakt={gewaehlt} fassungen={fassungen}
                     onZurueck={() => setAnsicht("detail")}
                     onHolen={fassungZurueck} />
          )}

          {ansicht === "detail" && !entwurf && gewaehlt && (
            <Anzeigen kontakt={gewaehlt} teams={teams} onLinkLoesen={linkLoesen}
                      dienste={dienste} onHandleSetzen={handleSetzen} onHandleWeg={handleWeg}
                      freigaben={freigaben} onTeilen={teilen} onTeilenZurueck={teilenZurueck}
                      onBlocken={blocken} onBlockAufheben={blockAufheben}
                      onBearbeiten={() => bearbeitenStarten(false)}
                      onEntfernen={entfernen}
                      onWiederherstellen={wiederherstellen}
                      onEndgueltig={endgueltig}
                      onVerlauf={verlaufZeigen} />
          )}

          {ansicht === "detail" && !entwurf && !gewaehlt && !mobil && (
            <div className={styles.leer}>Einen Kontakt auswählen.</div>
          )}
        </div>
      </div>
      {mobil && !mobilDetailOffen && (
        <Werkzeugleiste
          eintraege={[
            { key: "adressbuch", label: "Adressbuch", icon: "people", active: !papierkorb,
              onClick: () => { setPapierkorb(false); setGewaehlt(null); } },
            { key: "papierkorb", label: "Papierkorb", icon: "trash", active: papierkorb,
              onClick: () => { setPapierkorb(true); setGewaehlt(null); } },
            { key: "abgleich", label: "Abgleich", icon: "repeat", active: false, onClick: vorschlaegeHolen },
            { key: "quellen", label: "Quellen", icon: "link", active: false, onClick: () => setAnsicht("quellen") },
            { key: "mehr", label: "Import und Export", icon: "more", active: false, onClick: () => setMehrBlatt(true) },
          ]}
          fab={{ label: "Neuer Kontakt", onClick: () => bearbeitenStarten(true) }}
        />
      )}
      <ActionSheet
        open={mehrBlatt}
        onClose={() => setMehrBlatt(false)}
        title="Import und Export"
        items={[
          { id: "import", label: "Import aus .vcf-Datei", onSelect: () => dateiRef.current?.click() },
          { id: "export", label: "Alle Kontakte als .vcf sichern", onSelect: () => window.location.assign(kontakteApi.exportUrl()) },
        ]}
      />
    </div>
  );
}

/* ── Display ──────────────────────────────────────────────────────────────── */

function Anzeigen({ kontakt, teams, onLinkLoesen, dienste, onHandleSetzen, onHandleWeg,
                    freigaben, onTeilen, onTeilenZurueck, onBlocken, onBlockAufheben,
                    onBearbeiten, onEntfernen,
                    onWiederherstellen, onEndgueltig, onVerlauf }: {
  kontakt: Kontakt;
  teams: MeineTeams | null;
  onLinkLoesen: (username: string) => void;
  dienste: Dienst[];
  onHandleSetzen: (service: string, handle: string) => void;
  onHandleWeg: (service: string, handle: string) => void;
  freigaben: { freigaben: Freigabe[]; blocks: Block[] } | null;
  onTeilen: (mit: string) => void;
  onTeilenZurueck: (mit: string) => void;
  onBlocken: (service: string) => void;
  onBlockAufheben: (service: string) => void;
  onBearbeiten: () => void; onEntfernen: () => void; onWiederherstellen: () => void;
  onEndgueltig: () => void; onVerlauf: () => void;
}) {
  const d = kontakt.data;
  const entfernt = kontakt.state === "removed";
  return (
    <>
      <div className={styles.detailKopf}>
        {kontakt.photo_id && (
          <img className={styles.bild} src={kontakteApi.fotoUrl(kontakt.id)} alt=""
               onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
        )}
        <div className={styles.detailName}>{kontakt.anzeigename}</div>
        {!entfernt && !kontakt.fremd && (
          <button className={styles.knopf} onClick={onBearbeiten}>Bearbeiten</button>
        )}
        <button className={styles.knopf} onClick={onVerlauf}>Verlauf</button>
        {entfernt
          ? <button className={`${styles.knopf} ${styles.knopfHaupt}`} onClick={onWiederherstellen}>Wiederherstellen</button>
          : !kontakt.fremd && <button className={styles.knopf} onClick={onEntfernen}>Entfernen</button>}
      </div>

      {kontakt.fremd && (
        <div className={styles.fussnote}>
          Dieser Kontakt gehört <strong>{kontakt.owner}</strong> und wurde mit dir geteilt.
        </div>
      )}

      {!!d.organisation?.firma && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>Organisation</div>
          <div className={styles.zeile}>
            <span className={styles.zeileWert}>
              {[d.organisation.position, d.organisation.abteilung, d.organisation.firma]
                .filter(Boolean).join(" · ")}
            </span>
          </div>
        </div>
      )}

      {!!d.mails?.length && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>E-Mail</div>
          {d.mails.map((m, i) => (
            <div className={styles.zeile} key={i}>
              <span className={styles.zeileLabel}>{m.label || "E-Mail"}</span>
              <span className={styles.zeileWert}><a href={`mailto:${m.wert}`}>{m.wert}</a></span>
            </div>
          ))}
        </div>
      )}

      {!!d.telefone?.length && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>Telefon</div>
          {d.telefone.map((t, i) => (
            <div className={styles.zeile} key={i}>
              <span className={styles.zeileLabel}>{t.label || "Telefon"}</span>
              <span className={styles.zeileWert}><a href={`tel:${t.wert.replace(/\s/g, "")}`}>{t.wert}</a></span>
            </div>
          ))}
        </div>
      )}

      {!!d.adressen?.length && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>Adresse</div>
          {d.adressen.map((a, i) => (
            <div className={styles.zeile} key={i}>
              <span className={styles.zeileLabel}>{a.label || "Adresse"}</span>
              <span className={styles.zeileWert}>
                {[a.strasse, [a.plz, a.ort].filter(Boolean).join(" "), a.land].filter(Boolean).join(", ")}
              </span>
            </div>
          ))}
        </div>
      )}

      {!!d.daten?.geburtstag && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>Geburtstag</div>
          <div className={styles.zeile}><span className={styles.zeileWert}>{d.daten.geburtstag}</span></div>
        </div>
      )}

      {!!kontakt.links?.length && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>ClaraOS-Nutzer</div>
          {kontakt.links.map((l, i) => (
            <div className={styles.handle} key={i}>
              <span className={`${styles.marke} ${l.confidence === "bestaetigt" ? styles.markeEcht : ""}`}>
                {l.confidence === "bestaetigt" ? "verknüpft" : "abgelehnt"}
              </span>
              <span className={styles.zeileWert}>{l.username}</span>
              <button className={styles.knopf} onClick={() => onLinkLoesen(l.username)}>
                Aufheben
              </button>
            </div>
          ))}
          {kontakt.links.some((l) => l.confidence === "bestaetigt") && teams && (
            <div className={styles.fussnote}>
              {teams.darf_einladen
                ? "In ein Team aufnehmen geht in der Teams-App."
                : teams.hinweis}
            </div>
          )}
        </div>
      )}

      {!kontakt.fremd && (
        <Handles handles={kontakt.handles ?? []} dienste={dienste}
                 onSetzen={onHandleSetzen} onWeg={onHandleWeg} />
      )}
      {kontakt.fremd && !!kontakt.handles?.length && (
        <Handles handles={kontakt.handles} dienste={[]} />
      )}

      {!!d.notizen && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>Notiz</div>
          <div className={styles.zeile}>
            <span className={styles.zeileWert} style={{ whiteSpace: "pre-wrap" }}>{d.notizen}</span>
          </div>
        </div>
      )}

      {!!kontakt.quellen?.length && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>Herkunft</div>
          {kontakt.quellen.map((q, i) => (
            <div className={styles.zeile} key={i}>
              <span className={styles.zeileLabel}>{q.source}</span>
              <span className={styles.zeileWert}>
                {q.account || "—"}
                {q.state === "source_deleted" && " · dort inzwischen gelöscht"}
              </span>
            </div>
          ))}
        </div>
      )}

      {!kontakt.fremd && (
        <TeilenUndBlocken kontakt={kontakt} teams={teams} dienste={dienste}
                          daten={freigaben}
                          onTeilen={onTeilen} onTeilenZurueck={onTeilenZurueck}
                          onBlocken={onBlocken} onBlockAufheben={onBlockAufheben} />
      )}

      {!kontakt.fremd && (
        <div className={styles.gefahrZone}>
          <button className={`${styles.knopf} ${styles.knopfGefahr}`} onClick={onEndgueltig}>
            Endgültig löschen
          </button>
          <div className={styles.fussnote}>
            Löscht den Kontakt, alle früheren Fassungen und die Herkunftsdaten
            unwiderruflich. Zum normalen Wegräumen gibt es „Entfernen" — das
            landet im Papierkorb.
          </div>
        </div>
      )}

      {!!d.frei && Object.keys(d.frei).length > 0 && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>Aus der Quelle übernommen</div>
          {Object.entries(d.frei).map(([k, v]) => (
            <div className={styles.zeile} key={k}>
              <span className={styles.zeileLabel}>{k}</span>
              <span className={styles.zeileWert}>{(v as string[]).join(", ")}</span>
            </div>
          ))}
          <div className={styles.fussnote}>
            Felder, die ClaraOS aufhebt, obwohl vCard sie nicht kennt. Beim Export
            fehlen sie — dort passt nur, was das Format vorsieht.
          </div>
        </div>
      )}
    </>
  );
}

/* ── Services on the contact ─────────────────────────────────────────────── */

function Handles({ handles, dienste, onSetzen, onWeg }: {
  handles: Handle[];
  dienste: Dienst[];
  onSetzen?: (service: string, handle: string) => void;
  onWeg?: (service: string, handle: string) => void;
}) {
  const [offen, setOffen] = useState(false);
  const [service, setService] = useState("");
  const [wert, setWert] = useState("");
  const gewaehlt = dienste.find((d) => d.id === service);

  const speichern = () => {
    if (!service || !wert.trim() || !onSetzen) return;
    onSetzen(service, wert.trim());
    setWert("");
    setOffen(false);
  };

  return (
    <div className={styles.block}>
      <div className={styles.blockTitel}>Dienste</div>

      {handles.length === 0 && !offen && (
        <div className={styles.zeile}>
          <span className={styles.zeileWert} style={{ opacity: 0.7 }}>Noch keine.</span>
        </div>
      )}

      {handles.map((h, i) => {
        const url = profilUrl(h);
        const echt = h.klasse === "foederiert";
        return (
          <div className={styles.handle} key={i}>
            <span className={`${styles.marke} ${echt ? styles.markeEcht : ""}`}>
              {echt ? "föderiert" : h.klasse === "bridge" ? "Brücke" : "Verweis"}
            </span>
            <span className={styles.zeileLabel}>{h.service}</span>
            <span className={styles.zeileWert}>
              {url ? <a href={url} target="_blank" rel="noopener noreferrer">{h.handle}</a> : h.handle}
            </span>
            {onWeg && (
              <button className={styles.knopf} title="Diesen Dienst entfernen"
                      onClick={() => onWeg(h.service, h.handle)}>Entfernen</button>
            )}
          </div>
        );
      })}

      {onSetzen && !offen && (
        <button className={styles.knopf} onClick={() => setOffen(true)}>+ Dienst</button>
      )}

      {onSetzen && offen && (
        <>
          <div className={styles.feldReihe}>
            <select className={`${styles.feld} ${styles.feldSchmal}`} value={service}
                    onChange={(e) => setService(e.target.value)}>
              <option value="">Dienst wählen…</option>
              {dienste.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}{d.klasse === "foederiert" ? " ✓" : ""}
                </option>
              ))}
            </select>
            <input className={styles.feld} style={{ flex: 1 }} autoFocus
                   placeholder={gewaehlt?.platzhalter || "Kennung"}
                   value={wert} onChange={(e) => setWert(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") speichern(); }} />
          </div>
          {/* Important: the hint appears BEFORE saving, not after: whoever picks
              LinkedIn should see right away that it won't turn into "write". */}
          {gewaehlt && (
            <div className={styles.fussnote}>
              <span className={`${styles.marke} ${gewaehlt.klasse === "foederiert" ? styles.markeEcht : ""}`}>
                {gewaehlt.klasse === "foederiert" ? "föderiert"
                  : gewaehlt.klasse === "bridge" ? "Brücke" : "Verweis"}
              </span>{" "}
              {gewaehlt.hinweis || "ClaraOS speichert die Kennung."}
            </div>
          )}
          <div className={styles.feldReihe}>
            <button className={`${styles.knopf} ${styles.knopfHaupt}`}
                    disabled={!service || !wert.trim()} onClick={speichern}>Hinzufügen</button>
            <button className={styles.knopf}
                    onClick={() => { setOffen(false); setWert(""); }}>Abbrechen</button>
          </div>
        </>
      )}

      {handles.length > 0 && (
        <div className={styles.fussnote}>
          <strong>Föderiert</strong> heißt: ClaraOS kann dort wirklich etwas tun
          (schreiben, teilen, folgen). <strong>Verweis</strong> heißt: wir speichern
          die Kennung und öffnen das Profil — mehr lassen diese Dienste nicht zu.
          <strong> Brücke</strong> heißt: erreichbar erst, wenn die Matrix-Brücke läuft.
          <br />
          Die Einstufung wählt nicht du, sondern sie folgt dem Dienst — sonst
          verspräche die Karte etwas, das es nicht gibt.
        </div>
      )}
    </div>
  );
}

/* ── Editing ──────────────────────────────────────────────────────────────── */

function Bearbeiten({ entwurf, setEntwurf, laeuft, onSpeichern, onAbbrechen }: {
  entwurf: KontaktDaten;
  setEntwurf: (d: KontaktDaten) => void;
  laeuft: boolean;
  onSpeichern: () => void;
  onAbbrechen: () => void;
}) {
  const setzen = (pfad: string, wert: string) => {
    const kopie = JSON.parse(JSON.stringify(entwurf)) as KontaktDaten;
    const [a, b] = pfad.split(".");
    if (b) {
      (kopie as Record<string, Record<string, string>>)[a] =
        { ...((kopie as Record<string, Record<string, string>>)[a] ?? {}), [b]: wert };
    } else {
      (kopie as Record<string, unknown>)[a] = wert;
    }
    setEntwurf(kopie);
  };

  const listeSetzen = (feld: "mails" | "telefone", i: number, teil: Record<string, string>) => {
    const kopie = JSON.parse(JSON.stringify(entwurf)) as KontaktDaten;
    const arr = [...((kopie[feld] as Record<string, string>[]) ?? [])];
    arr[i] = { ...arr[i], ...teil };
    (kopie as Record<string, unknown>)[feld] = arr;
    setEntwurf(kopie);
  };

  const listeDazu = (feld: "mails" | "telefone") => {
    const kopie = JSON.parse(JSON.stringify(entwurf)) as KontaktDaten;
    (kopie as Record<string, unknown>)[feld] =
      [...((kopie[feld] as unknown[]) ?? []), { wert: "", label: "" }];
    setEntwurf(kopie);
  };

  const n = entwurf.namen ?? {};
  return (
    <>
      <div className={styles.detailKopf}>
        <div className={styles.detailName}>Kontakt bearbeiten</div>
        <button className={`${styles.knopf} ${styles.knopfHaupt}`} disabled={laeuft} onClick={onSpeichern}>
          Speichern
        </button>
        <button className={styles.knopf} onClick={onAbbrechen}>Abbrechen</button>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>Name</div>
        <div className={styles.feldReihe}>
          <input className={`${styles.feld} ${styles.feldSchmal}`} placeholder="Vorname"
                 value={n.vorname ?? ""} onChange={(e) => setzen("namen.vorname", e.target.value)} />
          <input className={`${styles.feld} ${styles.feldSchmal}`} placeholder="Nachname"
                 value={n.nachname ?? ""} onChange={(e) => setzen("namen.nachname", e.target.value)} />
        </div>
        <input className={styles.feld} placeholder="Anzeigename (leer = aus Vor- und Nachname)"
               value={n.anzeigename ?? ""} onChange={(e) => setzen("namen.anzeigename", e.target.value)} />
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>Organisation</div>
        <div className={styles.feldReihe}>
          <input className={styles.feld} placeholder="Firma"
                 value={entwurf.organisation?.firma ?? ""}
                 onChange={(e) => setzen("organisation.firma", e.target.value)} />
        </div>
        <input className={styles.feld} placeholder="Position"
               value={entwurf.organisation?.position ?? ""}
               onChange={(e) => setzen("organisation.position", e.target.value)} />
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>E-Mail</div>
        {(entwurf.mails ?? []).map((m, i) => (
          <div className={styles.feldReihe} key={i}>
            <input className={`${styles.feld} ${styles.feldSchmal}`} placeholder="Art"
                   value={m.label ?? ""} onChange={(e) => listeSetzen("mails", i, { label: e.target.value })} />
            <input className={styles.feld} placeholder="name@example.org" style={{ flex: 1 }}
                   value={m.wert} onChange={(e) => listeSetzen("mails", i, { wert: e.target.value })} />
          </div>
        ))}
        <button className={styles.knopf} onClick={() => listeDazu("mails")}>+ E-Mail</button>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>Telefon</div>
        {(entwurf.telefone ?? []).map((t, i) => (
          <div className={styles.feldReihe} key={i}>
            <input className={`${styles.feld} ${styles.feldSchmal}`} placeholder="Art"
                   value={t.label ?? ""} onChange={(e) => listeSetzen("telefone", i, { label: e.target.value })} />
            <input className={styles.feld} placeholder="+49 …" style={{ flex: 1 }}
                   value={t.wert} onChange={(e) => listeSetzen("telefone", i, { wert: e.target.value })} />
          </div>
        ))}
        <button className={styles.knopf} onClick={() => listeDazu("telefone")}>+ Telefon</button>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>Notiz</div>
        <textarea className={styles.feld} rows={3} value={entwurf.notizen ?? ""}
                  onChange={(e) => setzen("notizen", e.target.value)} />
      </div>

      <div className={styles.fussnote}>
        Leere Zeilen werden beim Speichern verworfen. Felder aus einer Quelle, die
        dieses Formular nicht kennt, bleiben unverändert erhalten.
      </div>
    </>
  );
}

/* ── History ──────────────────────────────────────────────────────────────── */

const GRUND_TEXT: Record<string, string> = {
  bearbeitet: "von Hand geändert",
  import: "durch Import geändert",
  entfernt: "entfernt",
  wiederhergestellt: "zurückgeholt",
  zusammengefuehrt: "zusammengeführt",
};

function Verlauf({ kontakt, fassungen, onZurueck, onHolen }: {
  kontakt: Kontakt;
  fassungen: Fassung[] | null;
  onZurueck: () => void;
  onHolen: (seq: number) => void;
}) {
  return (
    <>
      <div className={styles.detailKopf}>
        <div className={styles.detailName}>Verlauf — {kontakt.anzeigename}</div>
        <button className={styles.knopf} onClick={onZurueck}>Zurück</button>
      </div>

      {fassungen === null && <div className={styles.leer}>Lade…</div>}
      {fassungen?.length === 0 && (
        <div className={styles.leer}>
          Noch keine früheren Stände — dieser Kontakt wurde seit dem Anlegen nicht geändert.
        </div>
      )}
      {fassungen?.map((f) => (
        <div className={styles.fassung} key={f.id}>
          <span className={styles.fassungZeit}>
            {new Date(f.changed_at).toLocaleString("de-DE")}
          </span>
          <span className={styles.zeileWert}>
            {f.anzeigename}
            {f.data.telefone?.[0]?.wert ? ` · ${f.data.telefone[0].wert}` : ""}
            {f.data.mails?.[0]?.wert ? ` · ${f.data.mails[0].wert}` : ""}
          </span>
          <span className={styles.fassungGrund}>
            {GRUND_TEXT[f.reason] ?? f.reason}
            {f.changed_by.startsWith("import:") ? ` (${f.changed_by})` : ""}
          </span>
          <button className={styles.knopf} onClick={() => onHolen(f.seq)}>Diesen Stand holen</button>
        </div>
      ))}

      <div className={styles.fussnote}>
        Jede Zeile ist ein vollständiger früherer Stand. Einen davon zu holen löscht
        nichts — der bisherige Stand wandert dabei selbst in den Verlauf.
      </div>
    </>
  );
}

/* ── Sources ──────────────────────────────────────────────────────────────── */

function Quellen({ google, projektion, laeuft, regel, onRegel, onCarddav, onVerbinden,
                   onHolen, onTrennen, onAufsHandy, onZurueck }: {
  google: GoogleStatus | null;
  projektion: ProjektionStatus | null;
  regel: RegelStatus | null;
  onRegel: (wert: string) => void;
  onCarddav: () => void;
  laeuft: boolean;
  onVerbinden: () => void;
  onHolen: (voll?: boolean) => void;
  onTrennen: () => void;
  onAufsHandy: () => void;
  onZurueck: () => void;
}) {
  return (
    <>
      <div className={styles.detailKopf}>
        <div className={styles.detailName}>Quellen</div>
        <button className={styles.knopf} onClick={onZurueck}>Zurück</button>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>Google Kontakte</div>

        {google === null && <div className={styles.zeile}>Wird geprüft…</div>}

        {google && !google.moeglich && (
          <>
            <div className={styles.zeile}>
              <span className={styles.zeileWert}>{google.hinweis}</span>
            </div>
            <div className={styles.fussnote}>
              Solange Google hier nicht eingerichtet ist, geht der Weg über einen
              Export: In Google Kontakte alles als <strong>vCard</strong> exportieren
              und oben über „Import .vcf" hochladen. Das funktioniert sofort und
              braucht keine Freigabe.
            </div>
          </>
        )}

        {google?.moeglich && !google.verbunden && (
          <>
            <div className={styles.zeile}>
              <span className={styles.zeileWert}>Noch nicht verbunden.</span>
            </div>
            <button className={`${styles.knopf} ${styles.knopfHaupt}`} onClick={onVerbinden}>
              Mit Google verbinden
            </button>
            <div className={styles.fussnote}>
              🔒 ClaraOS fragt <strong>nur Lesezugriff</strong> auf deine Kontakte an
              (<code>contacts.readonly</code>). Es <strong>kann</strong> bei Google
              nichts ändern oder löschen — nicht weil wir es lassen, sondern weil
              Google uns die Berechtigung dafür gar nicht gibt.
            </div>
          </>
        )}

        {google?.verbunden && (
          <>
            <div className={styles.zeile}>
              <span className={styles.zeileLabel}>Konto</span>
              <span className={styles.zeileWert}>{google.konto || "(unbekannt)"}</span>
            </div>
            {google.zeiger?.filter((z) => z.source === "google").map((z, i) => (
              <div className={styles.zeile} key={i}>
                <span className={styles.zeileLabel}>Zuletzt</span>
                <span className={styles.zeileWert}>
                  {z.last_run ? new Date(z.last_run).toLocaleString("de-DE") : "noch nie"}
                  {z.inkrementell ? " · holt nur noch Änderungen" : " · beim nächsten Mal alles"}
                </span>
              </div>
            ))}
            <div className={styles.feldReihe}>
              <button className={`${styles.knopf} ${styles.knopfHaupt}`} disabled={laeuft}
                      onClick={() => onHolen(false)}>Von Google holen</button>
              <button className={styles.knopf} disabled={laeuft}
                      onClick={() => onHolen(true)}>Alles neu holen</button>
              <button className={styles.knopf} onClick={onTrennen}>Zugang lösen</button>
            </div>
            <div className={styles.fussnote}>
              🔒 Nur Lesezugriff. Änderungen, die du <em>hier</em> machst, gehen
              <strong> nicht</strong> zurück zu Google — das ist so gewollt.
              Ändert sich ein Kontakt an beiden Stellen, gilt dein Stand, und
              Googles Stand liegt als Vorschlag an der Karte.
              <br />
              „Zugang lösen" löscht keine Kontakte.
            </div>
          </>
        )}
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>Wer darf dich in ClaraOS erreichen</div>
        {regel && (
          <>
            {([
              ["alle", "Alle", "Jeder in ClaraOS darf dir etwas zustellen."],
              ["team", "Nur mein Team", "Nur Leute aus einem Team, in dem du auch bist."],
              ["team_und_kontakte", "Team und Kontakte",
               "Zusätzlich alle, die du selbst als Kontakt führst und verknüpft hast."],
            ] as const).map(([wert, titel, erklaerung]) => (
              <div className={styles.zeile} key={wert}>
                <input type="radio" name="erreichbar" checked={regel.erreichbar === wert}
                       onChange={() => onRegel(wert)} id={`er-${wert}`} />
                <label htmlFor={`er-${wert}`} className={styles.zeileWert}>
                  <strong>{titel}</strong> — {erklaerung}
                </label>
              </div>
            ))}
            {/* Warning: the most important thing about this setting is what it CANNOT do.
                Keeping quiet about that builds reassurance instead of protection. */}
            <div className={styles.fussnote}>
              Greift in: <strong>{regel.greift_in.join(", ")}</strong>.
              <br />
              🔴 Greift <strong>nicht</strong> in: {regel.greift_nicht_in.join(", ")}.
              Diese Einstellung schaltet weder dein Telefon noch WhatsApp ab — sie
              gilt nur dort, wo ClaraOS beide Enden kontrolliert.
            </div>
          </>
        )}
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>Aufs Handy — ClaraOS-Adressbuch in Nextcloud</div>

        {projektion === null && <div className={styles.zeile}>Wird geprüft…</div>}

        {projektion && !projektion.moeglich && (
          <div className={styles.zeile}>
            <span className={styles.zeileWert}>{projektion.hinweis}</span>
          </div>
        )}

        {projektion?.moeglich && (
          <>
            <div className={styles.zeile}>
              <span className={styles.zeileLabel}>Adressbuch</span>
              <span className={styles.zeileWert}>„{projektion.adressbuch}"</span>
            </div>
            <div className={styles.zeile}>
              <span className={styles.zeileLabel}>Stand</span>
              <span className={styles.zeileWert}>
                {projektion.draussen} von {projektion.kontakte} übertragen
                {projektion.mit_fehler ? ` · ${projektion.mit_fehler} mit Fehler` : ""}
                {projektion.zuletzt
                  ? ` · zuletzt ${new Date(projektion.zuletzt).toLocaleString("de-DE")}`
                  : " · noch nie"}
              </span>
            </div>
            <button className={`${styles.knopf} ${styles.knopfHaupt}`} disabled={laeuft}
                    onClick={onAufsHandy}>
              Jetzt übertragen
            </button>
          </>
        )}

        <div className={styles.fussnote}>
          ClaraOS legt in Nextcloud ein <strong>eigenes</strong> Adressbuch an und ist
          dessen einziger Schreiber. Dein bestehendes Adressbuch wird
          <strong> nicht angefasst</strong>.
          <br />
          Damit die Kontakte auf dem Handy landen, musst du dieses Adressbuch dort
          einmal abonnieren (DAVx5). 🔴 Solange <em>beide</em> Adressbücher am Gerät
          hängen, steht jeder Kontakt doppelt — das Umschalten ist ein eigener,
          bewusster Schritt und braucht vorher eine Sicherung.
        </div>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>Nextcloud-Adressbücher</div>
        <button className={styles.knopf} disabled={laeuft} onClick={onCarddav}>
          Aus Nextcloud holen
        </button>
        <div className={styles.fussnote}>
          Liest deine <em>eigenen</em> Adressbücher in Nextcloud — nützlich, wenn dein
          Handy per DAVx5 dorthin synchronisiert. Das von ClaraOS geschriebene
          Adressbuch und Nextclouds Nutzerverzeichnis werden dabei
          <strong> übersprungen</strong>: Sonst läse ClaraOS seine eigene Ausgabe
          wieder ein, und die Wahrheit wäre ihr eigenes Abbild.
        </div>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>vCard-Datei</div>
        <div className={styles.fussnote}>
          Über „Import .vcf" oben. Dieselbe Datei mehrfach hochzuladen ist
          folgenlos — ClaraOS merkt sich je Quelle, was sie zuletzt gezeigt hat,
          und legt nichts doppelt an. Ein Kontakt, den du entfernt hast, kommt
          durch einen erneuten Import <strong>nicht</strong> zurück.
        </div>
      </div>
    </>
  );
}

/* ── Suggestions ──────────────────────────────────────────────────────────── */

function Vorschlaege({ liste, teams, onEntscheiden, onZurueck }: {
  liste: Vorschlag[] | null;
  teams: MeineTeams | null;
  onEntscheiden: (v: Vorschlag, bestaetigt: boolean) => void;
  onZurueck: () => void;
}) {
  return (
    <>
      <div className={styles.detailKopf}>
        <div className={styles.detailName}>Abgleich mit ClaraOS-Nutzern</div>
        <button className={styles.knopf} onClick={onZurueck}>Zurück</button>
      </div>

      {liste === null && <div className={styles.leer}>Wird geprüft…</div>}

      {liste?.length === 0 && (
        <div className={styles.leer}>
          Keine offenen Vorschläge.
          {teams?.teams.length
            ? ` Verglichen wurde mit den Mitgliedern von: ${teams.teams.join(", ")}.`
            : " Du teilst mit niemandem ein Team — dann gibt es auch nichts zu vergleichen."}
        </div>
      )}

      {liste?.map((v) => (
        <div className={styles.fassung} key={v.contact_id}>
          <span className={`${styles.marke} ${v.schwach ? "" : styles.markeEcht}`}>
            {v.schwach ? "Hinweis" : "Treffer"}
          </span>
          <span className={styles.zeileWert}>
            <strong>{v.anzeigename}</strong> ist vermutlich <strong>{v.nutzer_name}</strong>
            {" "}({v.username})
            <br />
            <span className={styles.fassungGrund}>
              {v.begruendung}
              {v.teams.length ? ` · gemeinsam in: ${v.teams.join(", ")}` : ""}
            </span>
          </span>
          <button className={`${styles.knopf} ${styles.knopfHaupt}`}
                  onClick={() => onEntscheiden(v, true)}>Ist dieselbe Person</button>
          <button className={styles.knopf}
                  onClick={() => onEntscheiden(v, false)}>Nein</button>
        </div>
      ))}

      <div className={styles.fussnote}>
        🔒 Verglichen wird <strong>nur</strong> mit Leuten, mit denen du ein Team
        teilst — sonst würde diese Liste verraten, wer hier überhaupt ein Konto hat.
        <br />
        <strong>ClaraOS verknüpft nie von selbst.</strong> Eine falsche Verknüpfung
        hiesse nicht „falscher Name", sondern: jemand bekommt Sichtbarkeit auf
        Teaminhalte. Deshalb entscheidest du.
        <br />
        „Nein" wird gespeichert — derselbe Vorschlag kommt nicht wieder.
      </div>
    </>
  );
}

/* ── Sharing and blocking ─────────────────────────────────────────────────── */

const ZUSTAND_TEXT: Record<string, string> = {
  durchgesetzt: "durchgesetzt",
  ausgeblendet: "nur ausgeblendet",
  fehlgeschlagen: "fehlgeschlagen",
};

function TeilenUndBlocken({ kontakt, teams, dienste, daten,
                            onTeilen, onTeilenZurueck, onBlocken, onBlockAufheben }: {
  kontakt: Kontakt;
  teams: MeineTeams | null;
  dienste: Dienst[];
  daten: { freigaben: Freigabe[]; blocks: Block[] } | null;
  onTeilen: (mit: string) => void;
  onTeilenZurueck: (mit: string) => void;
  onBlocken: (service: string) => void;
  onBlockAufheben: (service: string) => void;
}) {
  const [wer, setWer] = useState("");
  const [blockDienst, setBlockDienst] = useState("claraos");

  // Anything attached to the contact can be blocked — plus ClaraOS itself.
  const blockbar = [
    { id: "claraos", label: "ClaraOS (Kontakte, Wissen)" },
    ...(kontakt.handles ?? []).map((h) => ({
      id: h.service,
      label: dienste.find((d) => d.id === h.service)?.label ?? h.service,
    })),
  ].filter((d, i, arr) => arr.findIndex((x) => x.id === d.id) === i);

  const schonGeblockt = new Set((daten?.blocks ?? []).map((b) => b.service));

  return (
    <div className={styles.block}>
      <div className={styles.blockTitel}>Teilen und Blocken</div>

      {(daten?.freigaben ?? []).map((f) => (
        <div className={styles.handle} key={f.shared_with}>
          <span className={styles.marke}>geteilt</span>
          <span className={styles.zeileWert}>{f.shared_with} · nur lesend</span>
          <button className={styles.knopf} onClick={() => onTeilenZurueck(f.shared_with)}>
            Zurücknehmen
          </button>
        </div>
      ))}

      <div className={styles.feldReihe}>
        <input className={styles.feld} style={{ flex: 1 }}
               placeholder="Mit wem teilen? (Nutzername aus deinem Team)"
               value={wer} onChange={(e) => setWer(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && wer.trim()) { onTeilen(wer.trim()); setWer(""); } }} />
        <button className={styles.knopf} disabled={!wer.trim()}
                onClick={() => { onTeilen(wer.trim()); setWer(""); }}>Teilen</button>
      </div>
      <div className={styles.fussnote}>
        Teilen geht nur mit Leuten, mit denen du ein Team teilst
        {teams?.teams.length ? ` (${teams.teams.join(", ")})` : ""} — und nur, wenn
        die Person dich nicht blockiert hat. Eine Freigabe ist <strong>nur lesend</strong>{" "}
        und zeigt <strong>nicht</strong> deinen Bearbeitungsverlauf.
      </div>

      {(daten?.blocks ?? []).map((b) => (
        <div className={styles.handle} key={b.service}>
          <span className={`${styles.marke} ${b.zustand === "durchgesetzt" ? styles.markeEcht : ""}`}>
            {ZUSTAND_TEXT[b.zustand] ?? b.zustand}
          </span>
          <span className={styles.zeileWert}>{b.service} blockiert</span>
          <button className={styles.knopf} onClick={() => onBlockAufheben(b.service)}>
            Aufheben
          </button>
        </div>
      ))}

      <div className={styles.feldReihe}>
        <select className={`${styles.feld} ${styles.feldSchmal}`} value={blockDienst}
                onChange={(e) => setBlockDienst(e.target.value)} style={{ flex: 1 }}>
          {blockbar.map((d) => (
            <option key={d.id} value={d.id} disabled={schonGeblockt.has(d.id)}>
              {d.label}{schonGeblockt.has(d.id) ? " (schon blockiert)" : ""}
            </option>
          ))}
        </select>
        <button className={`${styles.knopf} ${styles.knopfGefahr}`}
                disabled={schonGeblockt.has(blockDienst)}
                onClick={() => onBlocken(blockDienst)}>Blockieren</button>
      </div>
      {/* Warning: the most honest sentence in the whole app: what a block CANNOT do. */}
      <div className={styles.fussnote}>
        <strong>Durchgesetzt</strong> heißt: ClaraOS hat dort wirklich etwas getan
        (ClaraOS-Kanäle, Matrix-Ignorierliste). <strong>Nur ausgeblendet</strong> heißt:
        der Dienst kennt keinen Block, den wir setzen könnten — LinkedIn, X, Facebook.
        Dort verschwindet der Kontakt bei uns aus der Liste, und mehr ist ehrlicherweise
        nicht drin. Ein Block hier hindert niemanden daran, dich anzurufen.
      </div>
    </div>
  );
}
