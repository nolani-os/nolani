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
import { regionLocale, Trans, useTranslation, type TFunction } from "@claraos/core";

type Ansicht = "detail" | "bearbeiten" | "verlauf" | "quellen" | "vorschlaege";

/** Inline markup allowed in catalog texts (rendered through <Trans>). */
const TAGS = { b: <strong />, i: <em />, br: <br />, code: <code /> };

/** "3 new, 1 changed, …" — zero counts of the optional parts are left out. */
function teileText(t: TFunction, r: Partial<Record<"neu" | "geaendert" | "unveraendert" | "uebersprungen" | "konflikt", number>>): string {
  const teile = [t("parts.new", { count: r.neu ?? 0 }), t("parts.changed", { count: r.geaendert ?? 0 }),
                 t("parts.unchanged", { count: r.unveraendert ?? 0 })];
  if (r.uebersprungen) teile.push(t("parts.skipped", { count: r.uebersprungen }));
  if (r.konflikt) teile.push(t("parts.conflict", { count: r.konflikt }));
  return teile.join(", ");
}

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
  const { t } = useTranslation("kontakte");
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
        ? { text: text ? t("msg.googleConnectedDetail", { detail: text }) : t("msg.googleConnected") }
        : g === "abgebrochen"
          ? { text: text ? t("msg.googleCancelledDetail", { detail: text }) : t("msg.googleCancelled") }
          : { text: text || t("msg.googleFailed"), fehler: true },
    );
    p.delete("google"); p.delete("meldung");
    const qs = p.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    void kontakteApi.googleStatus().then(setGoogle).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        setMeldung({ text: r.geaendert ? t("msg.saved") : t("msg.unchanged") });
        await oeffnen(gewaehlt.id);
      } else {
        const r = await kontakteApi.anlegen(daten);
        setMeldung({ text: t("msg.created") });
        await oeffnen(r.id);
      }
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    } finally {
      setLaeuft(false);
    }
  }, [entwurf, gewaehlt, laden, oeffnen, t]);

  const entfernen = useCallback(async () => {
    if (!gewaehlt) return;
    try {
      await kontakteApi.entfernen(gewaehlt.id);
      setMeldung({ text: t("msg.removed") });
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
    if (!window.confirm(t("msg.confirmPurge", { name }))) return;
    try {
      const r = await kontakteApi.endgueltigLoeschen(gewaehlt.id);
      setMeldung({ text: t("msg.purged", { name, count: r.fassungen }) });
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
      setMeldung({ text: t("msg.restored") });
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
      setMeldung({ text: t("msg.versionRestored", { seq }) });
      await oeffnen(gewaehlt.id);
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, laden, oeffnen]);

  const importieren = useCallback(async (datei: File) => {
    setLaeuft(true);
    setMeldung({ text: t("msg.importReading", { file: datei.name }) });
    try {
      const r = await kontakteApi.importVcf(datei);
      setMeldung({ text: t("msg.importDone", { count: r.gesehen, parts: teileText(t, r) }) });
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    } finally {
      setLaeuft(false);
      if (dateiRef.current) dateiRef.current.value = "";
    }
  }, [laden, t]);

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
    setMeldung({ text: voll ? t("msg.googleFullSyncing") : t("msg.googleSyncing") });
    try {
      const r = await kontakteApi.googleSync(voll);
      const werte = { account: r.konto || "Google", count: r.gesehen, parts: teileText(t, r) };
      setMeldung({
        text: (r.vollabgleich ? t("msg.googleFullSyncDone", werte) : t("msg.googleSyncDone", werte))
            + (r.konflikt ? t("msg.googleConflictNote") : ""),
      });
      await laden();
      setGoogle(await kontakteApi.googleStatus());
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    } finally {
      setLaeuft(false);
    }
  }, [laden, t]);

  const googleTrennen = useCallback(async () => {
    if (!window.confirm(t("msg.confirmGoogleDisconnect"))) return;
    try {
      const r = await kontakteApi.googleTrennen();
      setMeldung({ text: r.hinweis });
      setGoogle(await kontakteApi.googleStatus());
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [t]);

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
          ? t("msg.linked", { name: v.anzeigename, user: v.username })
          : t("msg.rejected"),
      });
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [laden, t]);

  const linkLoesen = useCallback(async (username: string) => {
    if (!gewaehlt) return;
    try {
      await kontakteApi.linkLoesen(gewaehlt.id, username);
      setMeldung({ text: t("msg.unlinked", { user: username }) });
      await oeffnen(gewaehlt.id);
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, oeffnen, t]);

  const handleSetzen = useCallback(async (service: string, handle: string) => {
    if (!gewaehlt) return;
    try {
      const r = await kontakteApi.handleSetzen(gewaehlt.id, service, handle);
      setMeldung({
        text: r.klasse === "foederiert"
          ? t("msg.handleFederated", { service })
          : r.klasse === "bridge"
            ? t("msg.handleBridge", { service })
            : t("msg.handleReference", { service }),
      });
      await oeffnen(gewaehlt.id);
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, oeffnen, t]);

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
      setMeldung({ text: t("msg.shared", { name: gewaehlt.anzeigename, user: r.name }) });
      setFreigaben(await kontakteApi.freigaben(gewaehlt.id));
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [gewaehlt, t]);

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
      setMeldung({ text: t("msg.reachChanged") });
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    }
  }, [t]);

  const aufsHandy = useCallback(async () => {
    setLaeuft(true);
    setMeldung({ text: t("msg.phoneSyncing") });
    try {
      const r = await kontakteApi.projektionSync();
      const teile = [t("parts.written", { count: r.geschrieben }), t("parts.unchanged", { count: r.unveraendert })];
      if (r.geloescht) teile.push(t("parts.deleted", { count: r.geloescht }));
      if (r.fehler) teile.push(t("parts.failed", { count: r.fehler }));
      setMeldung({
        text: (r.neu_angelegt ? t("msg.bookCreated", { book: r.adressbuch }) : "")
            + t("msg.phoneDone", { count: r.geprueft, parts: teile.join(", ") })
            + (r.fehler_texte.length ? ` (${r.fehler_texte[0]})` : ""),
        fehler: r.fehler > 0,
      });
      setProjektion(await kontakteApi.projektionStatus());
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    } finally {
      setLaeuft(false);
    }
  }, [t]);

  const carddavHolen = useCallback(async () => {
    setLaeuft(true);
    setMeldung({ text: t("msg.carddavReading") });
    try {
      const r = await kontakteApi.importCarddav();
      setMeldung({
        text: r.adressbuecher.length
          ? t("msg.carddavDone", { books: r.adressbuecher.join(", "), count: r.gesehen, parts: teileText(t, r) })
            + (r.bilder ? t("msg.carddavImages", { count: r.bilder }) : "")
          : t("msg.carddavNone"),
      });
      await laden();
    } catch (e) {
      setMeldung({ text: e instanceof Error ? e.message : String(e), fehler: true });
    } finally {
      setLaeuft(false);
    }
  }, [laden, t]);

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
            <IconButton label={t("head.backToList")} icon="back" onClick={zurListe} />
            <span className={styles.kopfTitel}>
              {ansicht === "quellen" ? t("head.titleSources") : ansicht === "vorschlaege" ? t("head.titleMatching") : entwurf ? t("head.titleEdit") : t("head.titleContact")}
            </span>
          </div>
        ) : (
          <>
            {mobil && <h2 className={styles.kopfTitel}>{papierkorb ? t("head.trash") : t("head.contacts")}</h2>}
            <input className={styles.suche} placeholder={mobil ? t("head.searchMobile") : t("head.search")}
                   value={suche} onChange={(e) => setSuche(e.target.value)} />
            {!mobil && (
            <button className={`${styles.knopf} ${styles.knopfHaupt}`}
                    onClick={() => bearbeitenStarten(true)}>{t("head.new")}</button>
            )}
            {!mobil && (
            <button className={`${styles.knopf} ${styles.mehrKnopf}`}
                    aria-expanded={mehr}
                    onClick={() => setMehr(!mehr)}>{mehr ? t("head.less") : t("head.more")}</button>
            )}
            {!mobil && (
            <div className={`${styles.zweitReihe} ${mehr ? styles.zweitReiheOffen : ""}`}>
              <button className={styles.knopf} disabled={laeuft}
                      onClick={() => dateiRef.current?.click()}>{t("head.importVcf")}</button>
              <a className={styles.knopf} href={kontakteApi.exportUrl()}
                 title={t("head.exportTitle")}>{t("head.export")}</a>
              <button className={styles.knopf} onClick={() => { setPapierkorb(!papierkorb); setGewaehlt(null); }}>
                {papierkorb ? t("head.addressBook") : t("head.trash")}
              </button>
              <button className={styles.knopf} onClick={vorschlaegeHolen}>{t("head.matching")}</button>
              <button className={styles.knopf}
                      onClick={() => setAnsicht(ansicht === "quellen" ? "detail" : "quellen")}>
                {t("head.sources")}
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
          {kontakte === null && <div className={styles.leer}>{t("common.loading")}</div>}
          {kontakte?.length === 0 && (
            <div className={styles.leer}>
              {papierkorb
                ? t("list.trashEmpty")
                : suche
                  ? t("list.nothingFound")
                  : t("list.noContacts")}
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
                  {k.fremd ? t("list.sharedSuffix") : ""}
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
            <div className={styles.leer}>{t("list.pick")}</div>
          )}
        </div>
      </div>
      {mobil && !mobilDetailOffen && (
        <Werkzeugleiste
          eintraege={[
            { key: "adressbuch", label: t("head.addressBook"), icon: "people", active: !papierkorb,
              onClick: () => { setPapierkorb(false); setGewaehlt(null); } },
            { key: "papierkorb", label: t("head.trash"), icon: "trash", active: papierkorb,
              onClick: () => { setPapierkorb(true); setGewaehlt(null); } },
            { key: "abgleich", label: t("head.matching"), icon: "repeat", active: false, onClick: vorschlaegeHolen },
            { key: "quellen", label: t("head.sources"), icon: "link", active: false, onClick: () => setAnsicht("quellen") },
            { key: "mehr", label: t("head.importExport"), icon: "more", active: false, onClick: () => setMehrBlatt(true) },
          ]}
          fab={{ label: t("head.newContact"), onClick: () => bearbeitenStarten(true) }}
        />
      )}
      <ActionSheet
        open={mehrBlatt}
        onClose={() => setMehrBlatt(false)}
        title={t("head.importExport")}
        items={[
          { id: "import", label: t("head.importFromVcf"), onSelect: () => dateiRef.current?.click() },
          { id: "export", label: t("head.exportTitle"), onSelect: () => window.location.assign(kontakteApi.exportUrl()) },
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
  const { t } = useTranslation("kontakte");
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
          <button className={styles.knopf} onClick={onBearbeiten}>{t("detail.edit")}</button>
        )}
        <button className={styles.knopf} onClick={onVerlauf}>{t("detail.history")}</button>
        {entfernt
          ? <button className={`${styles.knopf} ${styles.knopfHaupt}`} onClick={onWiederherstellen}>{t("detail.restore")}</button>
          : !kontakt.fremd && <button className={styles.knopf} onClick={onEntfernen}>{t("common.remove")}</button>}
      </div>

      {kontakt.fremd && (
        <div className={styles.fussnote}>
          <Trans t={t} i18nKey="detail.ownedBy" values={{ owner: kontakt.owner }} components={TAGS} />
        </div>
      )}

      {!!d.organisation?.firma && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>{t("detail.organisation")}</div>
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
          <div className={styles.blockTitel}>{t("detail.email")}</div>
          {d.mails.map((m, i) => (
            <div className={styles.zeile} key={i}>
              <span className={styles.zeileLabel}>{m.label || t("detail.email")}</span>
              <span className={styles.zeileWert}><a href={`mailto:${m.wert}`}>{m.wert}</a></span>
            </div>
          ))}
        </div>
      )}

      {!!d.telefone?.length && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>{t("detail.phone")}</div>
          {d.telefone.map((tel, i) => (
            <div className={styles.zeile} key={i}>
              <span className={styles.zeileLabel}>{tel.label || t("detail.phone")}</span>
              <span className={styles.zeileWert}><a href={`tel:${tel.wert.replace(/\s/g, "")}`}>{tel.wert}</a></span>
            </div>
          ))}
        </div>
      )}

      {!!d.adressen?.length && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>{t("detail.address")}</div>
          {d.adressen.map((a, i) => (
            <div className={styles.zeile} key={i}>
              <span className={styles.zeileLabel}>{a.label || t("detail.address")}</span>
              <span className={styles.zeileWert}>
                {[a.strasse, [a.plz, a.ort].filter(Boolean).join(" "), a.land].filter(Boolean).join(", ")}
              </span>
            </div>
          ))}
        </div>
      )}

      {!!d.daten?.geburtstag && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>{t("detail.birthday")}</div>
          <div className={styles.zeile}><span className={styles.zeileWert}>{d.daten.geburtstag}</span></div>
        </div>
      )}

      {!!kontakt.links?.length && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>{t("detail.users")}</div>
          {kontakt.links.map((l, i) => (
            <div className={styles.handle} key={i}>
              <span className={`${styles.marke} ${l.confidence === "bestaetigt" ? styles.markeEcht : ""}`}>
                {l.confidence === "bestaetigt" ? t("detail.linked") : t("detail.rejected")}
              </span>
              <span className={styles.zeileWert}>{l.username}</span>
              <button className={styles.knopf} onClick={() => onLinkLoesen(l.username)}>
                {t("common.lift")}
              </button>
            </div>
          ))}
          {kontakt.links.some((l) => l.confidence === "bestaetigt") && teams && (
            <div className={styles.fussnote}>
              {teams.darf_einladen
                ? t("detail.teamsHint")
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
          <div className={styles.blockTitel}>{t("detail.note")}</div>
          <div className={styles.zeile}>
            <span className={styles.zeileWert} style={{ whiteSpace: "pre-wrap" }}>{d.notizen}</span>
          </div>
        </div>
      )}

      {!!kontakt.quellen?.length && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>{t("detail.origin")}</div>
          {kontakt.quellen.map((q, i) => (
            <div className={styles.zeile} key={i}>
              <span className={styles.zeileLabel}>{q.source}</span>
              <span className={styles.zeileWert}>
                {q.account || "—"}
                {q.state === "source_deleted" && t("detail.deletedThere")}
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
            {t("detail.purge")}
          </button>
          <div className={styles.fussnote}>
            {t("detail.purgeNote")}
          </div>
        </div>
      )}

      {!!d.frei && Object.keys(d.frei).length > 0 && (
        <div className={styles.block}>
          <div className={styles.blockTitel}>{t("detail.fromSource")}</div>
          {Object.entries(d.frei).map(([k, v]) => (
            <div className={styles.zeile} key={k}>
              <span className={styles.zeileLabel}>{k}</span>
              <span className={styles.zeileWert}>{(v as string[]).join(", ")}</span>
            </div>
          ))}
          <div className={styles.fussnote}>
            {t("detail.fromSourceNote")}
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
  const { t } = useTranslation("kontakte");
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
      <div className={styles.blockTitel}>{t("handles.title")}</div>

      {handles.length === 0 && !offen && (
        <div className={styles.zeile}>
          <span className={styles.zeileWert} style={{ opacity: 0.7 }}>{t("handles.none")}</span>
        </div>
      )}

      {handles.map((h, i) => {
        const url = profilUrl(h);
        const echt = h.klasse === "foederiert";
        return (
          <div className={styles.handle} key={i}>
            <span className={`${styles.marke} ${echt ? styles.markeEcht : ""}`}>
              {t(`handles.class.${h.klasse}`)}
            </span>
            <span className={styles.zeileLabel}>{h.service}</span>
            <span className={styles.zeileWert}>
              {url ? <a href={url} target="_blank" rel="noopener noreferrer">{h.handle}</a> : h.handle}
            </span>
            {onWeg && (
              <button className={styles.knopf} title={t("handles.removeTitle")}
                      onClick={() => onWeg(h.service, h.handle)}>{t("common.remove")}</button>
            )}
          </div>
        );
      })}

      {onSetzen && !offen && (
        <button className={styles.knopf} onClick={() => setOffen(true)}>{t("handles.add")}</button>
      )}

      {onSetzen && offen && (
        <>
          <div className={styles.feldReihe}>
            <select className={`${styles.feld} ${styles.feldSchmal}`} value={service}
                    onChange={(e) => setService(e.target.value)}>
              <option value="">{t("handles.pick")}</option>
              {dienste.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}{d.klasse === "foederiert" ? " ✓" : ""}
                </option>
              ))}
            </select>
            <input className={styles.feld} style={{ flex: 1 }} autoFocus
                   placeholder={gewaehlt?.platzhalter || t("handles.idPlaceholder")}
                   value={wert} onChange={(e) => setWert(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") speichern(); }} />
          </div>
          {/* Important: the hint appears BEFORE saving, not after: whoever picks
              LinkedIn should see right away that it won't turn into "write". */}
          {gewaehlt && (
            <div className={styles.fussnote}>
              <span className={`${styles.marke} ${gewaehlt.klasse === "foederiert" ? styles.markeEcht : ""}`}>
                {t(`handles.class.${gewaehlt.klasse}`)}
              </span>{" "}
              {gewaehlt.hinweis || t("handles.storesId")}
            </div>
          )}
          <div className={styles.feldReihe}>
            <button className={`${styles.knopf} ${styles.knopfHaupt}`}
                    disabled={!service || !wert.trim()} onClick={speichern}>{t("handles.addButton")}</button>
            <button className={styles.knopf}
                    onClick={() => { setOffen(false); setWert(""); }}>{t("common.cancel")}</button>
          </div>
        </>
      )}

      {handles.length > 0 && (
        <div className={styles.fussnote}>
          <Trans t={t} i18nKey="handles.explain" components={TAGS} />
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
  const { t } = useTranslation("kontakte");
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
        <div className={styles.detailName}>{t("edit.title")}</div>
        <button className={`${styles.knopf} ${styles.knopfHaupt}`} disabled={laeuft} onClick={onSpeichern}>
          {t("common.save")}
        </button>
        <button className={styles.knopf} onClick={onAbbrechen}>{t("common.cancel")}</button>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>{t("edit.name")}</div>
        <div className={styles.feldReihe}>
          <input className={`${styles.feld} ${styles.feldSchmal}`} placeholder={t("edit.firstName")}
                 value={n.vorname ?? ""} onChange={(e) => setzen("namen.vorname", e.target.value)} />
          <input className={`${styles.feld} ${styles.feldSchmal}`} placeholder={t("edit.lastName")}
                 value={n.nachname ?? ""} onChange={(e) => setzen("namen.nachname", e.target.value)} />
        </div>
        <input className={styles.feld} placeholder={t("edit.displayName")}
               value={n.anzeigename ?? ""} onChange={(e) => setzen("namen.anzeigename", e.target.value)} />
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>{t("edit.organisation")}</div>
        <div className={styles.feldReihe}>
          <input className={styles.feld} placeholder={t("edit.company")}
                 value={entwurf.organisation?.firma ?? ""}
                 onChange={(e) => setzen("organisation.firma", e.target.value)} />
        </div>
        <input className={styles.feld} placeholder={t("edit.position")}
               value={entwurf.organisation?.position ?? ""}
               onChange={(e) => setzen("organisation.position", e.target.value)} />
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>{t("edit.email")}</div>
        {(entwurf.mails ?? []).map((m, i) => (
          <div className={styles.feldReihe} key={i}>
            <input className={`${styles.feld} ${styles.feldSchmal}`} placeholder={t("edit.kind")}
                   value={m.label ?? ""} onChange={(e) => listeSetzen("mails", i, { label: e.target.value })} />
            <input className={styles.feld} placeholder={t("edit.emailPlaceholder")} style={{ flex: 1 }}
                   value={m.wert} onChange={(e) => listeSetzen("mails", i, { wert: e.target.value })} />
          </div>
        ))}
        <button className={styles.knopf} onClick={() => listeDazu("mails")}>{t("edit.addEmail")}</button>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>{t("edit.phone")}</div>
        {(entwurf.telefone ?? []).map((tel, i) => (
          <div className={styles.feldReihe} key={i}>
            <input className={`${styles.feld} ${styles.feldSchmal}`} placeholder={t("edit.kind")}
                   value={tel.label ?? ""} onChange={(e) => listeSetzen("telefone", i, { label: e.target.value })} />
            <input className={styles.feld} placeholder={t("edit.phonePlaceholder")} style={{ flex: 1 }}
                   value={tel.wert} onChange={(e) => listeSetzen("telefone", i, { wert: e.target.value })} />
          </div>
        ))}
        <button className={styles.knopf} onClick={() => listeDazu("telefone")}>{t("edit.addPhone")}</button>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>{t("edit.note")}</div>
        <textarea className={styles.feld} rows={3} value={entwurf.notizen ?? ""}
                  onChange={(e) => setzen("notizen", e.target.value)} />
      </div>

      <div className={styles.fussnote}>
        {t("edit.footer")}
      </div>
    </>
  );
}

/* ── History ──────────────────────────────────────────────────────────────── */

/** Reasons the server records; unknown ones are shown as they come. */
const GRUENDE = new Set(["bearbeitet", "import", "entfernt", "wiederhergestellt", "zusammengefuehrt"]);

function Verlauf({ kontakt, fassungen, onZurueck, onHolen }: {
  kontakt: Kontakt;
  fassungen: Fassung[] | null;
  onZurueck: () => void;
  onHolen: (seq: number) => void;
}) {
  const { t } = useTranslation("kontakte");
  return (
    <>
      <div className={styles.detailKopf}>
        <div className={styles.detailName}>{t("history.title", { name: kontakt.anzeigename })}</div>
        <button className={styles.knopf} onClick={onZurueck}>{t("common.back")}</button>
      </div>

      {fassungen === null && <div className={styles.leer}>{t("common.loading")}</div>}
      {fassungen?.length === 0 && (
        <div className={styles.leer}>
          {t("history.empty")}
        </div>
      )}
      {fassungen?.map((f) => (
        <div className={styles.fassung} key={f.id}>
          <span className={styles.fassungZeit}>
            {new Date(f.changed_at).toLocaleString(regionLocale())}
          </span>
          <span className={styles.zeileWert}>
            {f.anzeigename}
            {f.data.telefone?.[0]?.wert ? ` · ${f.data.telefone[0].wert}` : ""}
            {f.data.mails?.[0]?.wert ? ` · ${f.data.mails[0].wert}` : ""}
          </span>
          <span className={styles.fassungGrund}>
            {GRUENDE.has(f.reason) ? t(`history.reason.${f.reason}`) : f.reason}
            {f.changed_by.startsWith("import:") ? ` (${f.changed_by})` : ""}
          </span>
          <button className={styles.knopf} onClick={() => onHolen(f.seq)}>{t("history.restoreThis")}</button>
        </div>
      ))}

      <div className={styles.fussnote}>
        {t("history.footer")}
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
  const { t } = useTranslation("kontakte");
  return (
    <>
      <div className={styles.detailKopf}>
        <div className={styles.detailName}>{t("sources.title")}</div>
        <button className={styles.knopf} onClick={onZurueck}>{t("common.back")}</button>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>{t("sources.google")}</div>

        {google === null && <div className={styles.zeile}>{t("common.checking")}</div>}

        {google && !google.moeglich && (
          <>
            <div className={styles.zeile}>
              <span className={styles.zeileWert}>{google.hinweis}</span>
            </div>
            <div className={styles.fussnote}>
              <Trans t={t} i18nKey="sources.notSetUp" components={TAGS} />
            </div>
          </>
        )}

        {google?.moeglich && !google.verbunden && (
          <>
            <div className={styles.zeile}>
              <span className={styles.zeileWert}>{t("sources.notConnected")}</span>
            </div>
            <button className={`${styles.knopf} ${styles.knopfHaupt}`} onClick={onVerbinden}>
              {t("sources.connect")}
            </button>
            <div className={styles.fussnote}>
              <Trans t={t} i18nKey="sources.readOnlyAsk" components={TAGS} />
            </div>
          </>
        )}

        {google?.verbunden && (
          <>
            <div className={styles.zeile}>
              <span className={styles.zeileLabel}>{t("sources.account")}</span>
              <span className={styles.zeileWert}>{google.konto || t("common.unknown")}</span>
            </div>
            {google.zeiger?.filter((z) => z.source === "google").map((z, i) => (
              <div className={styles.zeile} key={i}>
                <span className={styles.zeileLabel}>{t("sources.lastRun")}</span>
                <span className={styles.zeileWert}>
                  {z.last_run ? new Date(z.last_run).toLocaleString(regionLocale()) : t("sources.never")}
                  {z.inkrementell ? t("sources.incremental") : t("sources.fullNext")}
                </span>
              </div>
            ))}
            <div className={styles.feldReihe}>
              <button className={`${styles.knopf} ${styles.knopfHaupt}`} disabled={laeuft}
                      onClick={() => onHolen(false)}>{t("sources.fetch")}</button>
              <button className={styles.knopf} disabled={laeuft}
                      onClick={() => onHolen(true)}>{t("sources.fetchAll")}</button>
              <button className={styles.knopf} onClick={onTrennen}>{t("sources.disconnect")}</button>
            </div>
            <div className={styles.fussnote}>
              <Trans t={t} i18nKey="sources.readOnlyNote" components={TAGS} />
            </div>
          </>
        )}
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>{t("sources.reachTitle")}</div>
        {regel && (
          <>
            {(["alle", "team", "team_und_kontakte"] as const).map((wert) => (
              <div className={styles.zeile} key={wert}>
                <input type="radio" name="erreichbar" checked={regel.erreichbar === wert}
                       onChange={() => onRegel(wert)} id={`er-${wert}`} />
                <label htmlFor={`er-${wert}`} className={styles.zeileWert}>
                  <strong>{t(`sources.reach.${wert}.title`)}</strong> — {t(`sources.reach.${wert}.text`)}
                </label>
              </div>
            ))}
            {/* Warning: the most important thing about this setting is what it CANNOT do.
                Keeping quiet about that builds reassurance instead of protection. */}
            <div className={styles.fussnote}>
              <Trans t={t} i18nKey="sources.reachScope" components={TAGS}
                     values={{ inList: regel.greift_in.join(", "), notList: regel.greift_nicht_in.join(", ") }} />
            </div>
          </>
        )}
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>{t("sources.phoneTitle")}</div>

        {projektion === null && <div className={styles.zeile}>{t("common.checking")}</div>}

        {projektion && !projektion.moeglich && (
          <div className={styles.zeile}>
            <span className={styles.zeileWert}>{projektion.hinweis}</span>
          </div>
        )}

        {projektion?.moeglich && (
          <>
            <div className={styles.zeile}>
              <span className={styles.zeileLabel}>{t("sources.book")}</span>
              <span className={styles.zeileWert}>„{projektion.adressbuch}"</span>
            </div>
            <div className={styles.zeile}>
              <span className={styles.zeileLabel}>{t("sources.state")}</span>
              <span className={styles.zeileWert}>
                {t("sources.transferred", { done: projektion.draussen, total: projektion.kontakte })}
                {projektion.mit_fehler ? t("sources.withErrors", { count: projektion.mit_fehler }) : ""}
                {projektion.zuletzt
                  ? t("sources.lastAt", { when: new Date(projektion.zuletzt).toLocaleString(regionLocale()) })
                  : t("sources.neverSuffix")}
              </span>
            </div>
            <button className={`${styles.knopf} ${styles.knopfHaupt}`} disabled={laeuft}
                    onClick={onAufsHandy}>
              {t("sources.transfer")}
            </button>
          </>
        )}

        <div className={styles.fussnote}>
          <Trans t={t} i18nKey="sources.phoneNote" components={TAGS} />
        </div>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>{t("sources.nextcloudTitle")}</div>
        <button className={styles.knopf} disabled={laeuft} onClick={onCarddav}>
          {t("sources.nextcloudFetch")}
        </button>
        <div className={styles.fussnote}>
          <Trans t={t} i18nKey="sources.nextcloudNote" components={TAGS} />
        </div>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitel}>{t("sources.vcardTitle")}</div>
        <div className={styles.fussnote}>
          <Trans t={t} i18nKey="sources.vcardNote" components={TAGS} />
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
  const { t } = useTranslation("kontakte");
  return (
    <>
      <div className={styles.detailKopf}>
        <div className={styles.detailName}>{t("matching.title")}</div>
        <button className={styles.knopf} onClick={onZurueck}>{t("common.back")}</button>
      </div>

      {liste === null && <div className={styles.leer}>{t("common.checking")}</div>}

      {liste?.length === 0 && (
        <div className={styles.leer}>
          {t("matching.none")}
          {teams?.teams.length
            ? t("matching.comparedWith", { teams: teams.teams.join(", ") })
            : t("matching.noTeam")}
        </div>
      )}

      {liste?.map((v) => (
        <div className={styles.fassung} key={v.contact_id}>
          <span className={`${styles.marke} ${v.schwach ? "" : styles.markeEcht}`}>
            {v.schwach ? t("matching.hint") : t("matching.match")}
          </span>
          <span className={styles.zeileWert}>
            <Trans t={t} i18nKey="matching.probably" components={TAGS}
                   values={{ contact: v.anzeigename, user: v.nutzer_name, username: v.username }} />
            <br />
            <span className={styles.fassungGrund}>
              {v.begruendung}
              {v.teams.length ? t("matching.together", { teams: v.teams.join(", ") }) : ""}
            </span>
          </span>
          <button className={`${styles.knopf} ${styles.knopfHaupt}`}
                  onClick={() => onEntscheiden(v, true)}>{t("matching.same")}</button>
          <button className={styles.knopf}
                  onClick={() => onEntscheiden(v, false)}>{t("matching.no")}</button>
        </div>
      ))}

      <div className={styles.fussnote}>
        <Trans t={t} i18nKey="matching.note" components={TAGS} />
      </div>
    </>
  );
}

/* ── Sharing and blocking ─────────────────────────────────────────────────── */

const ZUSTAENDE = new Set(["durchgesetzt", "ausgeblendet", "fehlgeschlagen"]);

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
  const { t } = useTranslation("kontakte");
  const [wer, setWer] = useState("");
  const [blockDienst, setBlockDienst] = useState("claraos");

  // Anything attached to the contact can be blocked — plus ClaraOS itself.
  const blockbar = [
    { id: "claraos", label: t("share.productLabel") },
    ...(kontakt.handles ?? []).map((h) => ({
      id: h.service,
      label: dienste.find((d) => d.id === h.service)?.label ?? h.service,
    })),
  ].filter((d, i, arr) => arr.findIndex((x) => x.id === d.id) === i);

  const schonGeblockt = new Set((daten?.blocks ?? []).map((b) => b.service));

  return (
    <div className={styles.block}>
      <div className={styles.blockTitel}>{t("share.title")}</div>

      {(daten?.freigaben ?? []).map((f) => (
        <div className={styles.handle} key={f.shared_with}>
          <span className={styles.marke}>{t("share.sharedBadge")}</span>
          <span className={styles.zeileWert}>{t("share.readOnly", { user: f.shared_with })}</span>
          <button className={styles.knopf} onClick={() => onTeilenZurueck(f.shared_with)}>
            {t("share.revoke")}
          </button>
        </div>
      ))}

      <div className={styles.feldReihe}>
        <input className={styles.feld} style={{ flex: 1 }}
               placeholder={t("share.placeholder")}
               value={wer} onChange={(e) => setWer(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && wer.trim()) { onTeilen(wer.trim()); setWer(""); } }} />
        <button className={styles.knopf} disabled={!wer.trim()}
                onClick={() => { onTeilen(wer.trim()); setWer(""); }}>{t("share.share")}</button>
      </div>
      <div className={styles.fussnote}>
        <Trans t={t} i18nKey="share.note" components={TAGS}
               values={{ teams: teams?.teams.length ? ` (${teams.teams.join(", ")})` : "" }} />
      </div>

      {(daten?.blocks ?? []).map((b) => (
        <div className={styles.handle} key={b.service}>
          <span className={`${styles.marke} ${b.zustand === "durchgesetzt" ? styles.markeEcht : ""}`}>
            {ZUSTAENDE.has(b.zustand) ? t(`share.state.${b.zustand}`) : b.zustand}
          </span>
          <span className={styles.zeileWert}>{t("share.blocked", { service: b.service })}</span>
          <button className={styles.knopf} onClick={() => onBlockAufheben(b.service)}>
            {t("common.lift")}
          </button>
        </div>
      ))}

      <div className={styles.feldReihe}>
        <select className={`${styles.feld} ${styles.feldSchmal}`} value={blockDienst}
                onChange={(e) => setBlockDienst(e.target.value)} style={{ flex: 1 }}>
          {blockbar.map((d) => (
            <option key={d.id} value={d.id} disabled={schonGeblockt.has(d.id)}>
              {d.label}{schonGeblockt.has(d.id) ? t("share.alreadyBlocked") : ""}
            </option>
          ))}
        </select>
        <button className={`${styles.knopf} ${styles.knopfGefahr}`}
                disabled={schonGeblockt.has(blockDienst)}
                onClick={() => onBlocken(blockDienst)}>{t("share.block")}</button>
      </div>
      {/* Warning: the most honest sentence in the whole app: what a block CANNOT do. */}
      <div className={styles.fussnote}>
        <Trans t={t} i18nKey="share.blockNote" components={TAGS} />
      </div>
    </div>
  );
}
