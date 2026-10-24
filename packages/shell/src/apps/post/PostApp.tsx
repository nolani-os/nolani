/** Post — the shell's native mail client.
 *
 * Layout as in Outlook: folders | list | reading pane.
 * Data comes from the ClaraOS API's JMAP proxy (`/api/claraos/post/*`),
 * not directly from Stalwart — one login, one data path for humans and Clara.
 *
 * Important: external HTML mails run in a sandboxed iframe without scripts;
 * images from external servers load only after a click (CSP in srcdoc).
 *
 * Important: the four ClaraOS buttons (→ task / event / contact / note) need
 * no token here — the shell session is the anchor (unlike the older
 * Bulwark bridge).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";
import styles from "./PostApp.module.css";
import { useIsMobile } from "../../Mobile/useIsMobile";
import { Icon, type IconName } from "../../components/Icon";
import { ausfuehrenLokal } from "../../Chat/shellActionHandler";
import { registerActionHandler } from "../../Chat/actionBus";
import {
  postApi, postSchreiben, anzeigeName, adressListe, datumKurz, datumLang, groesse,
  type Mail, type MailZeile, type Ordner, type Identitaet, type PostPrefs, type AusgangEintrag, type GespeicherteSuche,
  type WischAktion, type SortFeld,
  postRegeln, postSchlummern, postBusiness, type Konto,
} from "./api";
import Composer, { type ComposerStart } from "./Composer";
import { sanitizeMailHtml } from "./mailHtml";
import { RegelnDialog, AbwesenheitDialog, AufraeumenDialog } from "./Regeln";
import { FreigabenDialog, VerzeichnisDialog, VerteilerDialog } from "./Business";
import { MeinTag } from "./MeinTag";
import { SucheDialog, ProfilKarte } from "./Fenster";
import { regionLocale, getBrand } from "@claraos/core";

const SEITE = 50;
const POLL_MS = 300_000;   // fallback — normally push arrives via /post/events

type Filter = "alle" | "ungelesen" | "markiert" | "dateien";

/** Day headers in the list, as in Outlook: today · yesterday · weekday · date. */
function tagesGruppe(iso: string | null): string {
  if (!iso) return "Ohne Datum";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Ohne Datum";
  const heute = new Date(); heute.setHours(0, 0, 0, 0);
  const tag = new Date(d); tag.setHours(0, 0, 0, 0);
  const diff = Math.round((heute.getTime() - tag.getTime()) / 86_400_000);
  if (diff <= 0) return "Heute";
  if (diff === 1) return "Gestern";
  if (diff < 7) return d.toLocaleDateString(regionLocale(), { weekday: "long" });
  if (d.getFullYear() === heute.getFullYear()) return d.toLocaleDateString(regionLocale(), { day: "numeric", month: "long" });
  return d.toLocaleDateString(regionLocale(), { day: "numeric", month: "long", year: "numeric" });
}

/** Swipe gestures: colour, icon and label per action. */
const WISCH_FARBE: Record<WischAktion, string> = {
  archiv: "var(--akzent)",
  loeschen: "var(--danger, #e05555)",
  gelesen: "color-mix(in srgb, var(--akzent) 55%, var(--surface-3))",
  markieren: "var(--warning, #e0a020)",
  aufgabe: "var(--success, #3f9d54)",
  keine: "transparent",
};
const WISCH_ICON: Record<WischAktion, IconName> = {
  archiv: "archive", loeschen: "trash", gelesen: "mail", markieren: "flag",
  aufgabe: "check", keine: "close",
};
const WISCH_WAHL: [WischAktion, string][] = [
  ["archiv", "Archivieren"], ["loeschen", "Löschen"],
  ["gelesen", "Gelesen/Ungelesen"], ["markieren", "Kennzeichnen"],
  ["aufgabe", "Kennzeichnen + Aufgabe"], ["keine", "(nichts)"],
];
function wischText(a: WischAktion, z: MailZeile): string {
  switch (a) {
    case "archiv": return "Archivieren";
    case "loeschen": return "Löschen";
    case "gelesen": return z.unread ? "Gelesen" : "Ungelesen";
    case "markieren": return z.flagged ? "Kennzeichen weg" : "Kennzeichnen";
    case "aufgabe": return "Aufgabe";
    default: return "";
  }
}

const FILTER_NAMEN: Record<Filter, string> = {
  alle: "Alle", ungelesen: "Ungelesen", markiert: "Markiert", dateien: "Mit Dateien",
};
/** Only the fields JMAP can actually sort by — rationale in post.py. */
const SORT_NAMEN: [SortFeld, string][] = [
  ["datum", "Datum"], ["von", "Von"], ["betreff", "Betreff"],
  ["groesse", "Größe"], ["kennzeichen", "Kennzeichnung"],
];

/** Important: "descending" is not always what users expect: for date and size
 *  yes (newest/largest first), but for names and subject people want A→Z. Picking
 *  a field therefore sets the direction that suits it — otherwise switching to
 *  "From" would suddenly show Z→A. */
const SORT_STANDARD_AB: Record<SortFeld, boolean> = {
  datum: true, groesse: true, kennzeichen: true, von: false, betreff: false,
};

/** Labels for the two directions, per field — [descending, ascending]. */
function richtungNamen(f: SortFeld): [string, string] {
  switch (f) {
    case "von": case "betreff": return ["Z → A", "A → Z"];
    case "groesse": return ["Größte zuerst", "Kleinste zuerst"];
    case "kennzeichen": return ["Gekennzeichnete zuerst", "Übrige zuerst"];
    default: return ["Neueste zuerst", "Älteste zuerst"];
  }
}

/** Threshold at which a swipe triggers the action (a thumb's width, not arbitrary). */
const WISCH_SCHWELLE = 92;

function initialen(a: { name?: string; email: string } | undefined): string {
  const n = anzeigeName(a);
  const teile = n.replace(/<.*>/, "").trim().split(/[\s.@_-]+/).filter(Boolean);
  if (!teile.length) return "?";
  return (teile.length === 1 ? teile[0].slice(0, 2) : teile[0][0] + teile[1][0]).toUpperCase();
}

function farbe(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 45%)`;
}

function ordnerIcon(role: string | null): Parameters<typeof Icon>[0]["name"] {
  switch (role) {
    case "inbox": return "mail";
    case "sent": return "export";
    case "drafts": return "pen";
    case "junk": return "blocked";
    case "trash": return "trash";
    case "archive": return "archive";
    default: return "folder";
  }
}

/** srcdoc for the reading pane: own base styles, no scripts, external images
 *  only with `bilder`. cid: images are rewritten to the blob proxy. */
function htmlDokument(m: Mail, bilder: boolean, dunkel: boolean, kontoId?: string): string {
  let html = m.html;
  for (const a of m.attachments) {
    if (a.cid) {
      const cid = a.cid.replace(/^<|>$/g, "");
      html = html.split(`cid:${cid}`).join(postApi.blobUrl(a, kontoId));
    }
  }
  const csp = bilder
    ? "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; font-src *;"
    : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';";
  const fg = dunkel ? "#e8e8ef" : "#1a1a1f";
  const bg = dunkel ? "#16161d" : "#ffffff";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:${bg};color:${fg};font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;word-wrap:break-word;overflow-wrap:anywhere}
  body{padding:4px 2px}
  img{max-width:100%;height:auto}
  a{color:#4c8dff}
  blockquote{border-left:3px solid #8884;margin:0.5em 0;padding-left:0.8em;color:${dunkel ? "#b8b8c4" : "#444"}}
  pre{white-space:pre-wrap}
  table{max-width:100%}
</style></head><body>${html}</body></html>`;
}

export default function PostApp({ windowId }: { windowId: string }) {
  void windowId;
  const mobil = useIsMobile();
  const [ordner, setOrdner] = useState<Ordner[]>([]);
  const [adresse, setAdresse] = useState("");
  const [aktuellerOrdner, setAktuellerOrdner] = useState<Ordner | null>(null);
  const [zeilen, setZeilen] = useState<MailZeile[]>([]);
  const [gesamt, setGesamt] = useState<number | null>(null);
  const [laedtListe, setLaedtListe] = useState(false);
  const [suche, setSuche] = useState("");
  const [sucheAktiv, setSucheAktiv] = useState("");
  const [filter, setFilter] = useState<Filter>("alle");
  const [gewaehltId, setGewaehltId] = useState<string | null>(null);
  const [mail, setMail] = useState<Mail | null>(null);
  const [laedtMail, setLaedtMail] = useState(false);
  const [bilder, setBilder] = useState(false);
  const [meldung, setMeldung] = useState<{ text: string; fehler?: boolean } | null>(null);
  const [auswahl, setAuswahl] = useState<Set<string>>(new Set());
  const [verschiebeOffen, setVerschiebeOffen] = useState(false);
  const [beschaeftigt, setBeschaeftigt] = useState<string>("");
  const [ordnerOffen, setOrdnerOffen] = useState(!mobil);
  const [kontoFehlt, setKontoFehlt] = useState<string | null>(null);
  // Multiple mailboxes (own + group mailboxes + shares)
  const [konten, setKonten] = useState<Konto[]>([]);
  const [kontoId, setKontoId] = useState<string>("");      // "" = own mailbox
  const [meinTagOffen, setMeinTagOffen] = useState(false);
  const [ueberallOffen, setUeberallOffen] = useState<string | null>(null);   // search term or null
  const [profilFuer, setProfilFuer] = useState<{ email: string; name?: string } | null>(null);
  const [freigabenOffen, setFreigabenOffen] = useState(false);
  const [verzeichnisOffen, setVerzeichnisOffen] = useState(false);
  const [verteilerOffen, setVerteilerOffen] = useState(false);
  // Composing
  const [composer, setComposer] = useState<ComposerStart | null>(null);
  const [identitaeten, setIdentitaeten] = useState<Identitaet[]>([]);
  const [prefs, setPrefs] = useState<PostPrefs>({});
  const [ausgang, setAusgang] = useState<AusgangEintrag[]>([]);
  const [undo, setUndo] = useState<{ id: string; bis: number; text: string } | null>(null);
  const [einstellungenOffen, setEinstellungenOffen] = useState(false);
  // Rules, out-of-office, cleanup
  const [regelnOffen, setRegelnOffen] = useState(false);
  const [abwesenheitOffen, setAbwesenheitOffen] = useState(false);
  const [aufraeumen, setAufraeumen] = useState<string | null>(null);
  // Snooze
  const [schlummerOffen, setSchlummerOffen] = useState(false);
  const [labelOffen, setLabelOffen] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [geplantAnsicht, setGeplantAnsicht] = useState(false);
  const [weckzeiten, setWeckzeiten] = useState<Record<string, string>>({});
  const [pushStatus, setPushStatus] = useState<"aus" | "an" | "fehler">("aus");
  // Outlook-style handling on mobile
  const [sucheOffen, setSucheOffen] = useState(false);
  const [mehrOffen, setMehrOffen] = useState(false);
  const [kontext, setKontext] = useState<{ id: string; x: number; y: number } | null>(null);
  const [kontextUnter, setKontextUnter] = useState<null | "verschieben" | "schlummern" | "label">(null);
  const [verschiebeFuer, setVerschiebeFuer] = useState<string | null>(null);
  const [wisch, setWisch] = useState<{ id: string; dx: number } | null>(null);
  const wischStart = useRef<{ id: string; x: number; y: number; achse: "" | "x" | "y" } | null>(null);
  const wischGesperrt = useRef(false);
  const kontextAufMs = useRef(0);
  const [sortFeld, setSortFeld] = useState<SortFeld>("datum");
  const [sortAb, setSortAb] = useState(true);   // descending = newest first
  const [sortOffen, setSortOffen] = useState(false);
  const [empfaengerOffen, setEmpfaengerOffen] = useState(false);
  const [unterhaltungOffen, setUnterhaltungOffen] = useState(false);
  const druckTimer = useRef<number | undefined>(undefined);
  const listeRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const sucheRef = useRef<HTMLInputElement>(null);
  const dunkel = useMemo(() => {
    try { return getComputedStyle(document.documentElement).colorScheme !== "light"; } catch { return true; }
  }, []);

  const melde = useCallback((text: string, fehler = false) => {
    setMeldung({ text, fehler });
    window.setTimeout(() => setMeldung((m) => (m && m.text === text ? null : m)), fehler ? 6000 : 3500);
  }, []);

  // ── Folders ─────────────────────────────────────────────────────────────
  const ladeOrdner = useCallback(async () => {
    try {
      const r = await postApi.ordner(kontoId || undefined);
      setKontoFehlt(null);
      setOrdner(r.mailboxes);
      setAdresse(r.address);
      setAktuellerOrdner((cur) => cur ? (r.mailboxes.find((o) => o.id === cur.id) ?? cur)
        : (r.mailboxes.find((o) => o.role === "inbox") ?? r.mailboxes[0] ?? null));
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (/Mail-Konto|Mail-Zugang/.test(text)) setKontoFehlt(text);
      else melde(text, true);
    }
  }, [melde, kontoId]);

  useEffect(() => { void ladeOrdner(); }, [ladeOrdner]);

  // Which mailboxes are open to this user? Failure is harmless — the user
  // then just keeps their own mailbox.
  const ladeKonten = useCallback((neu = false) => {
    postBusiness.konten(neu).then((r) => {
      setKonten(r.konten);
      if (neu) melde(r.konten.length > 1
        ? `${r.konten.length} Postfächer gefunden`
        : "Nur dein eigenes Postfach — niemand hat dir etwas freigegeben.");
    }).catch(() => setKonten([]));
  }, [melde]);

  useEffect(() => { ladeKonten(); }, [ladeKonten]);

  /** Switch mailbox: folders, list and the open mail belong to the old account. */
  const kontoWechseln = useCallback((id: string) => {
    setKontoId(id);
    setAktuellerOrdner(null);
    setZeilen([]);
    setMail(null);
    setGewaehltId(null);
    setAuswahl(new Set());
    setSuche(""); setSucheAktiv(""); setLabelFilter(null); setGeplantAnsicht(false);
  }, []);

  // ── List ────────────────────────────────────────────────────────────────
  const ladeListe = useCallback(async (anhaengen = false) => {
    if (!aktuellerOrdner && !sucheAktiv) return;
    setLaedtListe(true);
    try {
      const r = await postApi.liste({
        accountId: kontoId || undefined,
        mailbox: sucheAktiv || geplantAnsicht ? undefined : aktuellerOrdner?.id,
        q: sucheAktiv || undefined,
        unread: filter === "ungelesen",
        flagged: filter === "markiert",
        label: labelFilter ?? undefined,
        snoozed: geplantAnsicht,
        hasAttachment: filter === "dateien",
        sort: sortFeld,
        order: sortAb ? "desc" : "asc",
        position: anhaengen ? zeilen.length : 0,
        limit: SEITE,
      });
      setZeilen((alt) => (anhaengen ? [...alt, ...r.messages] : r.messages));
      setGesamt(r.total);
      // Warning: do not silently fall back to date: if the mailbox cannot sort
      //    this way, the UI must say so — otherwise it would display an order
      //    it does not actually deliver.
      if (r.sort_unsupported) {
        setSortFeld("datum"); setSortAb(true);
        melde("Diese Sortierung unterstützt das Postfach nicht — zurück auf Datum.", true);
      }
    } catch (e) {
      melde(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLaedtListe(false);
    }
  }, [aktuellerOrdner, sucheAktiv, filter, labelFilter, geplantAnsicht, sortFeld, sortAb, zeilen.length, melde, kontoId]);

  useEffect(() => {
    setAuswahl(new Set());
    void ladeListe(false);
    if (geplantAnsicht) postSchlummern.liste().then((r) => setWeckzeiten(r.snoozed)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktuellerOrdner?.id, sucheAktiv, filter, labelFilter, geplantAnsicht, sortFeld, sortAb]);

  // Push: Stalwart reports changes via the SSE proxy → reload quietly (debounced).
  useEffect(() => {
    if (kontoFehlt) return;
    let es: EventSource | null = null;
    let timer: number | null = null;
    const nachladen = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void ladeOrdner(); if (!laedtListe && zeilen.length <= SEITE) void ladeListe(false); void ladeAusgang(); }, 800);
    };
    try {
      es = new EventSource("/api/claraos/post/events", { withCredentials: true });
      es.addEventListener("ready", () => setPushStatus("an"));
      es.addEventListener("state", nachladen);
      es.addEventListener("reconnect", () => setPushStatus("fehler"));
      es.onerror = () => setPushStatus("fehler");
    } catch { setPushStatus("fehler"); }
    return () => { es?.close(); if (timer) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kontoFehlt, aktuellerOrdner?.id]);

  // Quiet reload (new mails, counters) — fallback alongside push.
  useEffect(() => {
    const t = window.setInterval(() => {
      void ladeOrdner();
      if (!laedtListe && zeilen.length <= SEITE) void ladeListe(false);
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [ladeOrdner, ladeListe, laedtListe, zeilen.length]);

  const ladeAusgang = useCallback(async () => {
    try { setAusgang((await postSchreiben.ausgang()).outbox); } catch { /* no mailbox: ignore */ }
  }, []);
  useEffect(() => {
    (async () => {
      try {
        const [i, p] = await Promise.all([postSchreiben.identitaeten(), postSchreiben.prefs()]);
        setIdentitaeten(i.identities); setPrefs(p); setMeinTagOffen(!!p.mein_tag);
      } catch { /* no mailbox: kontoFehlt handles it */ }
      void ladeAusgang();
    })();
  }, [ladeAusgang]);

  // Count down the undo window
  useEffect(() => {
    if (!undo) return;
    const t = window.setInterval(() => { if (Date.now() > undo.bis) setUndo(null); }, 1000);
    return () => window.clearInterval(t);
  }, [undo]);

  const oeffneComposer = useCallback(async (art: "neu" | "reply" | "all" | "forward", quelle?: Mail | null) => {
    if (art === "neu") { setComposer({}); return; }
    if (!quelle) return;
    try {
      const v = await postSchreiben.vorlage(quelle.id, art);
      setComposer({ to: v.to, cc: v.cc, subject: v.subject, html: v.quote_html, attachments: v.attachments,
                    inReplyTo: v.in_reply_to, forwardOf: v.forward_of });
    } catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
  }, [melde]);

  const oeffneEntwurf = useCallback((m: Mail) => {
    setComposer({ draftId: m.id, to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject,
                  html: m.html || `<div>${(m.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>`,
                  attachments: m.attachments.filter((a) => !a.inline).map((a) => ({ blob_id: a.blob_id, name: a.name, type: a.type, size: a.size })) });
  }, []);

  const suchordnerAnwenden = useCallback((g: GespeicherteSuche) => {
    if (g.mailbox) { const o = ordner.find((x) => x.id === g.mailbox); if (o) setAktuellerOrdner(o); }
    setSuche(g.q ?? ""); setSucheAktiv(g.q ?? "");
    setFilter(g.unread ? "ungelesen" : g.flagged ? "markiert" : g.has_attachment ? "dateien" : "alle");
    if (mobil) setOrdnerOffen(false);
  }, [ordner, mobil]);

  const sucheSpeichern = useCallback(async () => {
    const name = window.prompt("Name für den Suchordner:", sucheAktiv || FILTER_NAMEN[filter]);
    if (!name) return;
    const neu: GespeicherteSuche = { id: Math.random().toString(36).slice(2, 10), name: name.trim(), q: sucheAktiv || undefined,
      unread: filter === "ungelesen" || undefined, flagged: filter === "markiert" || undefined,
      has_attachment: filter === "dateien" || undefined, mailbox: sucheAktiv ? null : aktuellerOrdner?.id ?? null };
    const p = { ...prefs, saved_searches: [...(prefs.saved_searches ?? []), neu] };
    try { await postSchreiben.prefsSpeichern(p); setPrefs(p); melde(`Suchordner „${neu.name}“ gespeichert`); }
    catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
  }, [sucheAktiv, filter, aktuellerOrdner, prefs, melde]);

  const sucheLoeschen = useCallback(async (id: string) => {
    const p = { ...prefs, saved_searches: (prefs.saved_searches ?? []).filter((x) => x.id !== id) };
    try { await postSchreiben.prefsSpeichern(p); setPrefs(p); } catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
  }, [prefs, melde]);

  const rueckgaengig = useCallback(async () => {
    if (!undo) return;
    try {
      const r = await postSchreiben.rueckgaengig(undo.id);
      setUndo(null); melde(r.message); void ladeOrdner(); void ladeAusgang();
      if (aktuellerOrdner?.role === "drafts" || aktuellerOrdner?.role === "sent") void ladeListe(false);
    } catch (e) { melde(e instanceof Error ? e.message : String(e), true); setUndo(null); }
  }, [undo, melde, ladeOrdner, ladeAusgang, aktuellerOrdner, ladeListe]);

  // ── Reading ─────────────────────────────────────────────────────────────
  const oeffne = useCallback(async (id: string) => {
    setGewaehltId(id);
    setLaedtMail(true);
    setBilder(false);
    setEmpfaengerOffen(false);
    setUnterhaltungOffen(false);
    try {
      const r = await postApi.mail(id, true, kontoId || undefined);
      setMail(r.message);
      setZeilen((alt) => alt.map((z) => (z.id === id ? { ...z, unread: false } : z)));
      setOrdner((alt) => alt.map((o) => {
        const war = alt.find((x) => x.id === o.id);
        const zeile = zeilen.find((z) => z.id === id);
        return zeile?.unread && zeile.mailbox_ids.includes(o.id) && war ? { ...o, unread: Math.max(0, o.unread - 1) } : o;
      }));
    } catch (e) {
      melde(e instanceof Error ? e.message : String(e), true);
      setMail(null);
    } finally {
      setLaedtMail(false);
    }
  }, [melde, zeilen, kontoId]);

  // "Open in Post" from the draft card in the chat: go to the drafts folder
  // and open the draft with that subject once the list is there. The card
  // only knows the IMAP UID, the app works with JMAP ids, so the subject links
  // both; without a match the drafts folder stays open, which is still right.
  const [zielEntwurf, setZielEntwurf] = useState<string | null>(null);
  const zielSahLaden = useRef(false);
  const zielAngestossen = useRef(false);
  useEffect(() => registerActionHandler("post", (action, args) => {
    if (action !== "open_draft") return;
    zielSahLaden.current = false;
    zielAngestossen.current = false;
    setKontoId("");
    setSuche(""); setSucheAktiv(""); setLabelFilter(null); setGeplantAnsicht(false);
    setZielEntwurf(typeof args?.subject === "string" ? args.subject : "");
  }), []);
  useEffect(() => {
    if (zielEntwurf === null) return;
    const entwuerfe = ordner.find((o) => o.role === "drafts");
    if (!entwuerfe) return;
    if (aktuellerOrdner?.id !== entwuerfe.id) { setAktuellerOrdner(entwuerfe); return; }
    // Only rows loaded for the drafts folder count, never the previous folder's.
    if (laedtListe) { zielSahLaden.current = true; return; }
    if (!zielSahLaden.current) {
      if (!zielAngestossen.current) { zielAngestossen.current = true; void ladeListe(false); }
      return;
    }
    const treffer = zielEntwurf ? zeilen.find((z) => z.subject === zielEntwurf) : undefined;
    if (treffer) void oeffne(treffer.id);
    setZielEntwurf(null);
  }, [zielEntwurf, ordner, aktuellerOrdner, zeilen, laedtListe, oeffne, ladeListe]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const zielIds = useCallback((id?: string): string[] => {
    if (auswahl.size) return [...auswahl];
    if (id) return [id];
    return gewaehltId ? [gewaehltId] : [];
  }, [auswahl, gewaehltId]);

  const nachAktion = useCallback((ids: string[], entfernen: boolean) => {
    if (entfernen) {
      setZeilen((alt) => alt.filter((z) => !ids.includes(z.id)));
      if (gewaehltId && ids.includes(gewaehltId)) { setGewaehltId(null); setMail(null); }
      setGesamt((g) => (g == null ? g : Math.max(0, g - ids.length)));
    }
    setAuswahl(new Set());
    void ladeOrdner();
  }, [gewaehltId, ladeOrdner]);

  const aktion = useCallback(async (was: "archiv" | "loeschen" | "spam" | "gelesen" | "ungelesen" | "markieren" | "entmarkieren" | "posteingang", id?: string) => {
    const ids = zielIds(id);
    if (!ids.length) return;
    setBeschaeftigt(was);
    try {
      const imPapierkorb = aktuellerOrdner?.role === "trash";
      switch (was) {
        case "archiv": await postApi.setzen({ account_id: kontoId || undefined, ids, move_to_role: "archive" }); nachAktion(ids, true); melde(`${ids.length === 1 ? "Mail" : ids.length + " Mails"} archiviert`); break;
        case "loeschen":
          if (imPapierkorb) {
            if (!window.confirm(`${ids.length === 1 ? "Diese Mail" : ids.length + " Mails"} endgültig löschen?`)) break;
            await postApi.setzen({ account_id: kontoId || undefined, ids, destroy: true });
          } else {
            await postApi.setzen({ account_id: kontoId || undefined, ids, move_to_role: "trash" });
          }
          nachAktion(ids, true); melde(imPapierkorb ? "Endgültig gelöscht" : "In den Papierkorb verschoben"); break;
        case "spam": await postApi.setzen({ account_id: kontoId || undefined, ids, move_to_role: "junk", add_keywords: ["$junk"] }); nachAktion(ids, true); melde("Als Spam abgelegt"); break;
        case "posteingang": await postApi.setzen({ account_id: kontoId || undefined, ids, move_to_role: "inbox", remove_keywords: ["$junk"] }); nachAktion(ids, true); melde("In den Posteingang verschoben"); break;
        case "gelesen": await postApi.setzen({ account_id: kontoId || undefined, ids, add_keywords: ["$seen"] }); setZeilen((alt) => alt.map((z) => (ids.includes(z.id) ? { ...z, unread: false } : z))); nachAktion(ids, false); break;
        case "ungelesen": await postApi.setzen({ account_id: kontoId || undefined, ids, remove_keywords: ["$seen"] }); setZeilen((alt) => alt.map((z) => (ids.includes(z.id) ? { ...z, unread: true } : z))); nachAktion(ids, false); break;
        case "markieren": await postApi.setzen({ account_id: kontoId || undefined, ids, add_keywords: ["$flagged"] }); setZeilen((alt) => alt.map((z) => (ids.includes(z.id) ? { ...z, flagged: true } : z))); if (mail && ids.includes(mail.id)) setMail({ ...mail, flagged: true }); setAuswahl(new Set()); break;
        case "entmarkieren": await postApi.setzen({ account_id: kontoId || undefined, ids, remove_keywords: ["$flagged"] }); setZeilen((alt) => alt.map((z) => (ids.includes(z.id) ? { ...z, flagged: false } : z))); if (mail && ids.includes(mail.id)) setMail({ ...mail, flagged: false }); setAuswahl(new Set()); break;
      }
    } catch (e) {
      melde(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBeschaeftigt("");
    }
  }, [zielIds, aktuellerOrdner, nachAktion, melde, mail]);

  const schlummern = useCallback(async (until: string, id?: string) => {
    const ids = zielIds(id);
    setSchlummerOffen(false);
    if (!ids.length) return;
    try { const r = await postSchlummern.schlummern(ids, until); nachAktion(ids, !geplantAnsicht); melde(r.message); }
    catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
  }, [zielIds, nachAktion, melde, geplantAnsicht]);

  const wecken = useCallback(async (id?: string) => {
    const ids = zielIds(id);
    if (!ids.length) return;
    try { const r = await postSchlummern.wecken(ids); nachAktion(ids, true); melde(r.message); }
    catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
  }, [zielIds, nachAktion, melde]);

  const anheften = useCallback(async (an: boolean, id?: string) => {
    const ids = zielIds(id);
    if (!ids.length) return;
    try {
      await postApi.setzen(an ? { account_id: kontoId || undefined, ids, add_keywords: ["$pinned"] } : { account_id: kontoId || undefined, ids, remove_keywords: ["$pinned"] });
      setZeilen((alt) => alt.map((z) => (ids.includes(z.id) ? { ...z, pinned: an } : z)));
      if (mail && ids.includes(mail.id)) setMail({ ...mail, pinned: an });
      setAuswahl(new Set());
    } catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
  }, [zielIds, melde, mail]);

  const labelSetzen = useCallback(async (label: string, an: boolean, id?: string) => {
    const ids = zielIds(id);
    if (!ids.length || !label.trim()) return;
    const kw = `$label:${label.trim()}`;
    try {
      await postApi.setzen(an ? { account_id: kontoId || undefined, ids, add_keywords: [kw] } : { account_id: kontoId || undefined, ids, remove_keywords: [kw] });
      setZeilen((alt) => alt.map((z) => (ids.includes(z.id) ? { ...z, labels: an ? Array.from(new Set([...z.labels, label.trim()])) : z.labels.filter((l) => l !== label.trim()) } : z)));
      if (mail && ids.includes(mail.id)) setMail({ ...mail, labels: an ? Array.from(new Set([...mail.labels, label.trim()])) : mail.labels.filter((l) => l !== label.trim()) });
      if (an && !(prefs.labels ?? []).includes(label.trim())) { const p = { ...prefs, labels: [...(prefs.labels ?? []), label.trim()].sort() }; setPrefs(p); void postSchreiben.prefsSpeichern(p); }
    } catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
  }, [zielIds, melde, mail, prefs]);

  const verschiebe = useCallback(async (ziel: Ordner) => {
    // Important: from the context menu, "Move" targets EXACTLY the tapped mail;
    //    without a context it uses the selection or the open mail.
    const ids = zielIds(verschiebeFuer ?? undefined);
    setVerschiebeOffen(false);
    setVerschiebeFuer(null);
    if (!ids.length) return;
    try {
      await postApi.setzen({ account_id: kontoId || undefined, ids, move_to: ziel.id });
      nachAktion(ids, ziel.id !== aktuellerOrdner?.id);
      melde(`Nach „${ziel.name}“ verschoben`);
    } catch (e) {
      melde(e instanceof Error ? e.message : String(e), true);
    }
  }, [zielIds, nachAktion, aktuellerOrdner, melde, verschiebeFuer]);

  const brueckeAus = useCallback(async (art: "task" | "event" | "contact" | "note", id: string) => {
    let when: string | undefined;
    if (art === "event") {
      const w = window.prompt("Wann? („morgen 09:00“, „heute 15:30“, „2026-09-12 14:00“; leer = nächste volle Stunde)", "morgen 09:00");
      if (w === null) return;
      when = w.trim();
    }
    setBeschaeftigt(art);
    try {
      const r = await postApi.bruecke(art, { email_id: id, when });
      melde(r.message || "Erledigt");
    } catch (e) {
      melde(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBeschaeftigt("");
    }
  }, [melde]);

  const bruecke = useCallback(async (art: "task" | "event" | "contact" | "note") => {
    if (!mail) return;
    await brueckeAus(art, mail.id);
  }, [mail, brueckeAus]);

  // ── Selection, context menu, swipe gestures ─────────────────────────────
  const auswahlUm = useCallback((id: string) => {
    setAuswahl((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);

  const oeffneKontext = useCallback((id: string, x: number, y: number) => {
    // On desktop the menu sticks to the pointer — but the coordinates are
    // window-relative and the frame is `position: relative`. So convert and
    // clamp at the edges so nothing sticks out of the app.
    const r = appRef.current?.getBoundingClientRect();
    const bx = r ? x - r.left : x;
    const by = r ? y - r.top : y;
    setKontextUnter(null);
    kontextAufMs.current = Date.now();
    setKontext({
      id,
      x: Math.max(4, Math.min(bx, (r?.width ?? 900) - 250)),
      y: Math.max(4, Math.min(by, Math.max(4, (r?.height ?? 700) - 330))),
    });
  }, []);

  const kontextZu = useCallback(() => { setKontext(null); setKontextUnter(null); }, []);

  const antwortenAus = useCallback(async (art: "reply" | "all" | "forward", id: string) => {
    kontextZu();
    try {
      const r = await postApi.mail(id, false, kontoId || undefined);
      await oeffneComposer(art, r.message);
    } catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
  }, [kontextZu, oeffneComposer, melde]);

  const wischAktionen = useMemo(() => ({
    links: prefs.swipe_links ?? "archiv" as WischAktion,
    rechts: prefs.swipe_rechts ?? "aufgabe" as WischAktion,
  }), [prefs.swipe_links, prefs.swipe_rechts]);

  const wischAusfuehren = useCallback(async (a: WischAktion, z: MailZeile) => {
    switch (a) {
      case "archiv": await aktion("archiv", z.id); break;
      case "loeschen": await aktion("loeschen", z.id); break;
      case "gelesen": await aktion(z.unread ? "gelesen" : "ungelesen", z.id); break;
      case "markieren": await aktion(z.flagged ? "entmarkieren" : "markieren", z.id); break;
      // Important: two things in one gesture, and the order is intentional: first
      //    the flag (visible immediately), then the task (takes longer).
      //    If creating the task fails, the mail is at least flagged —
      //    so it can be found again.
      case "aufgabe":
        if (!z.flagged) await aktion("markieren", z.id);
        try {
          const r = await postApi.bruecke("task", { email_id: z.id });
          melde(r.message || "Aufgabe aus der Mail angelegt");
        } catch (e) {
          melde(e instanceof Error ? e.message : String(e), true);
        }
        break;
      case "keine": break;
    }
  }, [aktion, melde]);

  const beiTouchStart = useCallback((e: ReactTouchEvent, z: MailZeile) => {
    const t = e.touches[0];
    if (!t) return;
    wischStart.current = { id: z.id, x: t.clientX, y: t.clientY, achse: "" };
    window.clearTimeout(druckTimer.current);
    // Important: long press = context menu (Outlook gesture). As soon as the finger
    //    moves, it is a swipe or scroll — then cancel the timer.
    druckTimer.current = window.setTimeout(() => {
      if (wischStart.current?.id !== z.id || wischStart.current.achse !== "") return;
      wischStart.current = null;
      wischGesperrt.current = true;
      window.setTimeout(() => { wischGesperrt.current = false; }, 400);
      setWisch(null);
      try { navigator.vibrate?.(12); } catch { /* device without vibration */ }
      oeffneKontext(z.id, t.clientX, t.clientY);
    }, 500);
  }, [oeffneKontext]);

  const beiTouchMove = useCallback((e: ReactTouchEvent, z: MailZeile) => {
    const st = wischStart.current;
    const t = e.touches[0];
    if (!st || st.id !== z.id || !t) return;
    const dx = t.clientX - st.x;
    const dy = t.clientY - st.y;
    if (st.achse === "") {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) { st.achse = "x"; window.clearTimeout(druckTimer.current); }
      else if (Math.abs(dy) > 12) { st.achse = "y"; window.clearTimeout(druckTimer.current); }
    }
    if (st.achse === "x") setWisch({ id: z.id, dx: Math.max(-170, Math.min(170, dx)) });
  }, []);

  const beiTouchEnde = useCallback((z: MailZeile) => {
    window.clearTimeout(druckTimer.current);
    const st = wischStart.current;
    wischStart.current = null;
    const w = wisch;
    setWisch(null);
    if (!st || st.achse !== "x" || !w || w.id !== z.id) return;
    // After a swipe, the following click must NOT open the mail.
    wischGesperrt.current = true;
    window.setTimeout(() => { wischGesperrt.current = false; }, 400);
    if (Math.abs(w.dx) < WISCH_SCHWELLE) return;
    void wischAusfuehren(w.dx < 0 ? wischAktionen.links : wischAktionen.rechts, z);
  }, [wisch, wischAktionen, wischAusfuehren]);

  useEffect(() => { if (sucheOffen) sucheRef.current?.focus(); }, [sucheOffen]);

  // ── Keyboard (Outlook-like: j/k, Enter, e, #, u, s, /) ──────────────────
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        if (ev.key === "Escape") (t as HTMLInputElement).blur();
        return;
      }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const idx = zeilen.findIndex((z) => z.id === gewaehltId);
      switch (ev.key) {
        case "j": case "ArrowDown": if (zeilen[idx + 1]) { ev.preventDefault(); void oeffne(zeilen[idx + 1].id); } break;
        case "k": case "ArrowUp": if (idx > 0) { ev.preventDefault(); void oeffne(zeilen[idx - 1].id); } break;
        case "n": void oeffneComposer("neu"); break;
        case "r": if (mail && !composer) void oeffneComposer("reply", mail); break;
        case "a": if (mail && !composer) void oeffneComposer("all", mail); break;
        case "f": if (mail && !composer) void oeffneComposer("forward", mail); break;
        case "e": void aktion("archiv"); break;
        case "#": case "Delete": void aktion("loeschen"); break;
        case "u": void aktion(mail?.unread ? "gelesen" : "ungelesen"); break;
        case "s": void aktion(mail?.flagged ? "entmarkieren" : "markieren"); break;
        case "/": ev.preventDefault(); (listeRef.current?.parentElement?.querySelector("input[type=search]") as HTMLInputElement | null)?.focus(); break;
        case "Escape": setGewaehltId(null); setMail(null); break;
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [zeilen, gewaehltId, oeffne, aktion, mail, composer, oeffneComposer]);

  // ── Rendering ───────────────────────────────────────────────────────────
  const unreadInbox = ordner.find((o) => o.role === "inbox")?.unread ?? 0;
  const mobilLesen = mobil && !!gewaehltId;

  const kopf = (
    <div className={styles.kopf}>
      {mobil && !mobilLesen && (
        <button className={styles.iconKnopf} title="Ordner" onClick={() => setOrdnerOffen((v) => !v)}><Icon name="list" size={20} /></button>
      )}
      {mobilLesen && (
        <button className={styles.iconKnopf} title="Zurück" onClick={() => { setGewaehltId(null); setMail(null); }}><Icon name="back" size={20} /></button>
      )}
      {/* Mobile reading pane: like Outlook Mobile, three icons at the top plus an
          overflow menu. The desktop button wall (19 buttons over five rows) left
          too little height for the mail text on a phone. */}
      {mobilLesen && mail && !composer && (
        <div className={styles.leseLeisteOben}>
          <button className={styles.iconKnopf} title="Archivieren" disabled={!!beschaeftigt}
                  onClick={() => void aktion("archiv", mail.id)}><Icon name="archive" size={19} /></button>
          <button className={styles.iconKnopf} title="Löschen" disabled={!!beschaeftigt}
                  onClick={() => void aktion("loeschen", mail.id)}><Icon name="trash" size={19} /></button>
          <button className={styles.iconKnopf} title={mail.flagged ? "Kennzeichen entfernen" : "Kennzeichnen"} disabled={!!beschaeftigt}
                  onClick={() => void aktion(mail.flagged ? "entmarkieren" : "markieren", mail.id)}><Icon name="star" size={19} /></button>
          <button className={styles.iconKnopf} title="Mehr"
                  onClick={(e) => oeffneKontext(mail.id, e.clientX, e.clientY)}><Icon name="more" size={19} /></button>
        </div>
      )}
      <h2 className={styles.titel}>{mobilLesen ? "" : (sucheAktiv ? `Suche: ${sucheAktiv}` : geplantAnsicht ? "Geplant" : labelFilter ? `Label: ${labelFilter}` : aktuellerOrdner?.name ?? "Post")}</h2>
      {mobil && !mobilLesen && filter !== "alle" && (
        <button className={`${styles.chip} ${styles.chipAktiv}`} onClick={() => setFilter("alle")} title="Filter aufheben">
          {FILTER_NAMEN[filter]} ✕
        </button>
      )}
      {/* A non-default sort order must be VISIBLE — otherwise one later searches
          in vain for the missing newest mail. */}
      {mobil && !mobilLesen && (sortFeld !== "datum" || !sortAb) && (
        <button className={styles.chip} onClick={() => { setSortFeld("datum"); setSortAb(true); }}
                title="Sortierung zurücksetzen">
          {SORT_NAMEN.find(([k]) => k === sortFeld)?.[1]} {sortAb ? "↓" : "↑"} ✕
        </button>
      )}
      {!mobilLesen && pushStatus === "fehler" && <span className={styles.hinweis} title="Live-Aktualisierung läuft nicht — Abfrage alle 5 Minuten">kein Push</span>}

      {/* Desktop: search, compose and filters stay in the header as before. */}
      {!mobil && (
        <>
          <form className={styles.sucheForm} onSubmit={(e) => { e.preventDefault(); setSucheAktiv(suche.trim()); }}>
            <input type="search" className={styles.suche} placeholder="Suchen (Betreff, Absender, Text)…" value={suche}
                   onChange={(e) => setSuche(e.target.value)} />
            {sucheAktiv && <button type="button" className={styles.iconKnopf} title="Suche schließen" onClick={() => { setSuche(""); setSucheAktiv(""); }}><Icon name="close" size={16} /></button>}
            <button type="button" className={styles.chip}
                    title="Überall suchen — auch in Kontakten, Aufgaben und Terminen"
                    onClick={() => setUeberallOffen(suche.trim() || sucheAktiv || "")}>
              Überall
            </button>
          </form>
          {!kontoFehlt && (
            <button className={`${styles.chip} ${styles.chipAktiv}`} onClick={() => void oeffneComposer("neu")} title="Neue E-Mail (n)"><Icon name="pen" size={14} /> Neue E-Mail</button>
          )}
          <div className={styles.filterLeiste}>
            {(["alle", "ungelesen", "markiert", "dateien"] as Filter[]).map((f) => (
              <button key={f} className={`${styles.chip} ${filter === f ? styles.chipAktiv : ""}`} onClick={() => setFilter(f)}>
                {FILTER_NAMEN[f]}
              </button>
            ))}
            {/* Sorting — two menus above the list, as in Outlook. */}
            <span className={styles.bausteinAnker}>
              <button className={styles.iconKnopf} title="Sortieren" onClick={() => setSortOffen((v) => !v)}>
                <Icon name="list" size={16} />
              </button>
              {sortOffen && (
                <div className={styles.vorschlagListe} style={{ minWidth: 210 }}>
                  {SORT_NAMEN.map(([k, l]) => (
                    <button type="button" key={k} className={styles.vorschlag}
                            onMouseDown={(e) => { e.preventDefault(); setSortFeld(k); setSortAb(SORT_STANDARD_AB[k]); setSortOffen(false); }}>
                      {sortFeld === k ? "✓ " : ""}{l}
                    </button>
                  ))}
                  <div className={styles.sheetTrenner} />
                  <button type="button" className={styles.vorschlag}
                          onMouseDown={(e) => { e.preventDefault(); setSortAb(true); setSortOffen(false); }}>
                    {sortAb ? "✓ " : ""}{richtungNamen(sortFeld)[0]}
                  </button>
                  <button type="button" className={styles.vorschlag}
                          onMouseDown={(e) => { e.preventDefault(); setSortAb(false); setSortOffen(false); }}>
                    {!sortAb ? "✓ " : ""}{richtungNamen(sortFeld)[1]}
                  </button>
                </div>
              )}
            </span>
            {(sucheAktiv || filter !== "alle") && !kontoFehlt && (
              <button className={styles.iconKnopf} title="Diese Suche als Suchordner speichern" onClick={() => void sucheSpeichern()}><Icon name="star" size={16} /></button>
            )}
            <button className={styles.iconKnopf} title="Aktualisieren" onClick={() => { void ladeOrdner(); void ladeListe(false); void ladeAusgang(); }}>
              <Icon name="reload" size={16} />
            </button>
            <button className={`${styles.iconKnopf} ${meinTagOffen ? styles.iconKnopfAktiv : ""}`}
                    title="Mein Tag — Termine und Aufgaben neben der Mail (Mails lassen sich hineinziehen)"
                    onClick={() => {
                      const an = !meinTagOffen;
                      setMeinTagOffen(an);
                      const p = { ...prefs, mein_tag: an };
                      setPrefs(p); void postSchreiben.prefsSpeichern(p);
                    }}>
              <Icon name="today" size={16} />
            </button>
            <button className={styles.iconKnopf} title="Einstellungen (Signatur, Absender, Rückgängig-Frist)" onClick={() => setEinstellungenOffen(true)}>
              <Icon name="gear" size={16} />
            </button>
          </div>
        </>
      )}

      {/* Mobile: slim bar like Outlook Mobile — title, search icon, overflow
          menu. Search field, "New mail" pill and filter row together took up
          about half the screen before the first mail. Search now expands on tap,
          compose is a floating button at the bottom, the rest lives in the
          "More" sheet. */}
      {mobil && !mobilLesen && (
        <>
          <button className={styles.iconKnopf} title="Suchen" onClick={() => setSucheOffen((v) => !v)}>
            <Icon name="search" size={20} />
          </button>
          <button className={styles.iconKnopf} title="Mehr" onClick={() => setMehrOffen(true)}>
            <Icon name="more" size={20} />
          </button>
        </>
      )}
    </div>
  );

  const sucheZeile = mobil && sucheOffen && !mobilLesen ? (
    <form className={styles.sucheZeile} onSubmit={(e) => { e.preventDefault(); setSucheAktiv(suche.trim()); }}>
      <input ref={sucheRef} type="search" className={styles.suche} placeholder="Suchen (Betreff, Absender, Text)…"
             value={suche} onChange={(e) => setSuche(e.target.value)} />
      <button type="button" className={styles.iconKnopf} title="Suche schließen"
              onClick={() => { setSuche(""); setSucheAktiv(""); setSucheOffen(false); }}><Icon name="close" size={18} /></button>
    </form>
  ) : null;

  const ordnerSpalte = (
    <nav className={`${styles.ordner} ${mobil ? styles.ordnerMobil : ""} ${ordnerOffen ? "" : styles.ordnerZu}`}>
      <div className={styles.kontoZeile}>
        {konten.length > 1 ? (
          <select className={styles.kontoWahl} value={kontoId} title="Postfach wechseln"
                  onChange={(e) => kontoWechseln(e.target.value)}>
            {konten.map((k) => (
              <option key={k.id} value={k.eigenes ? "" : k.id}>
                {k.eigenes ? k.name : `${k.name}${k.nur_lesen ? " (nur lesen)" : ""}`}
              </option>
            ))}
          </select>
        ) : (
          <div className={styles.konto} title={adresse}>{adresse || "…"}</div>
        )}
        <button className={styles.iconKnopf} title="Nach freigegebenen Postfächern suchen"
                onClick={() => ladeKonten(true)}><Icon name="reload" size={13} /></button>
      </div>
      {kontoId && (
        <div className={styles.fremdesKonto}>
          <Icon name="people" size={13} /> Gemeinsames Postfach
        </div>
      )}
      {ordner.map((o) => (
        <button key={o.id}
                className={`${styles.ordnerEintrag} ${aktuellerOrdner?.id === o.id && !sucheAktiv ? styles.ordnerAktiv : ""}`}
                onClick={() => { setSucheAktiv(""); setSuche(""); setGeplantAnsicht(false); setLabelFilter(null); setAktuellerOrdner(o); if (mobil) setOrdnerOffen(false); }}>
          <Icon name={ordnerIcon(o.role)} size={16} />
          <span className={styles.ordnerName}>{o.name}</span>
          {o.unread > 0 && <span className={styles.badge}>{o.unread}</span>}
        </button>
      ))}
      {!kontoId && <button className={`${styles.ordnerEintrag} ${geplantAnsicht ? styles.ordnerAktiv : ""}`} title="Geschlummerte Mails — kommen zur Weckzeit zurück"
              onClick={() => { setSucheAktiv(""); setSuche(""); setLabelFilter(null); setGeplantAnsicht(true); if (mobil) setOrdnerOffen(false); }}>
        <Icon name="moon" size={16} /><span className={styles.ordnerName}>Geplant</span>
      </button>}
      {(prefs.labels ?? []).length > 0 && (
        <div className={styles.ausgang}>
          <div className={styles.unterhaltungTitel}>Labels</div>
          {(prefs.labels ?? []).map((l) => (
            <button key={l} className={`${styles.ordnerEintrag} ${labelFilter === l ? styles.ordnerAktiv : ""}`}
                    onClick={() => { setSucheAktiv(""); setSuche(""); setGeplantAnsicht(false); setLabelFilter(labelFilter === l ? null : l); if (mobil) setOrdnerOffen(false); }}>
              <span className={styles.labelPunkt} style={{ background: farbe(l) }} /><span className={styles.ordnerName}>{l}</span>
            </button>
          ))}
        </div>
      )}
      {ausgang.length > 0 && (
        <div className={styles.ausgang}>
          <div className={styles.unterhaltungTitel}>Ausgang ({ausgang.length})</div>
          {ausgang.map((a) => (
            <div key={a.submission_id} className={styles.ausgangEintrag} title={a.subject}>
              <span className={styles.ordnerName}>{a.subject || "(ohne Betreff)"}</span>
              <span className={styles.hinweis}>{a.send_at ? datumKurz(a.send_at) : ""}</span>
              <button className={styles.link} onClick={async () => { try { const r = await postSchreiben.rueckgaengig(a.submission_id); melde(r.message); void ladeAusgang(); void ladeOrdner(); } catch (e) { melde(e instanceof Error ? e.message : String(e), true); } }}>Zurückholen</button>
            </div>
          ))}
        </div>
      )}
      {(prefs.saved_searches ?? []).length > 0 && (
        <div className={styles.ausgang}>
          <div className={styles.unterhaltungTitel}>Suchordner</div>
          {(prefs.saved_searches ?? []).map((g) => (
            <div key={g.id} className={styles.ausgangEintrag}>
              <button className={styles.link} style={{ textDecoration: "none", flex: 1, textAlign: "left" }} onClick={() => suchordnerAnwenden(g)}><Icon name="search" size={13} /> {g.name}</button>
              <button className={styles.iconKnopf} title="Suchordner entfernen" onClick={() => void sucheLoeschen(g.id)}><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div className={styles.ausgang}>
        {!kontoId && <button className={styles.ordnerEintrag} onClick={() => setRegelnOffen(true)} title="Regeln laufen auf dem Mailserver"><Icon name="matrix" size={16} /><span className={styles.ordnerName}>Regeln</span></button>}
        {!kontoId && <button className={styles.ordnerEintrag} onClick={() => setAbwesenheitOffen(true)}><Icon name="moon" size={16} /><span className={styles.ordnerName}>Abwesenheit</span></button>}
        <button className={styles.ordnerEintrag} onClick={() => setUeberallOffen("")} title="Mail, Kontakte, Aufgaben und Termine in einem Feld"><Icon name="search" size={16} /><span className={styles.ordnerName}>Überall suchen</span></button>
        <button className={styles.ordnerEintrag} onClick={() => setFreigabenOffen(true)} title="Eigene Ordner für andere öffnen"><Icon name="share" size={16} /><span className={styles.ordnerName}>Freigaben</span></button>
        <button className={styles.ordnerEintrag} onClick={() => setVerzeichnisOffen(true)} title="Alle Postfächer und Kontakte durchsuchen"><Icon name="people" size={16} /><span className={styles.ordnerName}>Verzeichnis</span></button>
        <button className={styles.ordnerEintrag} onClick={() => setVerteilerOffen(true)} title="Eigene Empfängergruppen"><Icon name="collections" size={16} /><span className={styles.ordnerName}>Verteiler</span></button>
        {/* The "Mail-App (alt)" entry has been removed: the legacy Bulwark tile
            can be hidden (`claraos_apps.enabled = FALSE`) while the module keeps
            running. An entry that opens a hidden app is a dead end. To restore it,
            re-enable the tile. */}
      </div>
    </nav>
  );

  /** A list row — with the swipe background underneath, selection via the avatar and
   *  a context menu on long press or right-click. */
  const zeileEintrag = (z: MailZeile) => {
    const von = aktuellerOrdner?.role === "sent" || aktuellerOrdner?.role === "drafts" ? z.to[0] : z.from[0];
    const dx = wisch?.id === z.id ? wisch.dx : 0;
    const nachLinks = dx < 0;
    const wischZiel = nachLinks ? wischAktionen.links : wischAktionen.rechts;
    const gewaehlt = auswahl.has(z.id);
    const reif = Math.abs(dx) >= WISCH_SCHWELLE;
    return (
      <div key={z.id} className={styles.zeileHuelle}>
        {dx !== 0 && wischZiel !== "keine" && (
          <div className={`${styles.wischGrund} ${nachLinks ? styles.wischLinks : styles.wischRechts} ${reif ? styles.wischReif : ""}`}
               style={{ background: WISCH_FARBE[wischZiel] }}>
            <Icon name={WISCH_ICON[wischZiel]} size={18} />
            <span>{wischText(wischZiel, z)}</span>
          </div>
        )}
        <div className={`${styles.zeile} ${z.unread ? styles.ungelesen : ""} ${gewaehltId === z.id ? styles.zeileAktiv : ""} ${gewaehlt ? styles.zeileGewaehlt : ""}`}
             draggable={!mobil}
             onDragStart={(e) => {
               // Important: two formats: our own for "My Day", `text/plain` as a
               //    fallback so that dragging outside at least drops the
               //    subject instead of nothing.
               e.dataTransfer.setData("application/x-claraos-mail", z.id);
               e.dataTransfer.setData("text/plain", z.subject || "(ohne Betreff)");
               e.dataTransfer.effectAllowed = "copy";
             }}
             style={dx ? { transform: `translateX(${dx}px)`, transition: "none" } : undefined}
             onClick={() => {
               if (wischGesperrt.current) return;
               if (auswahl.size) auswahlUm(z.id); else void oeffne(z.id);
             }}
             onContextMenu={(e) => { e.preventDefault(); oeffneKontext(z.id, e.clientX, e.clientY); }}
             onTouchStart={(e) => beiTouchStart(e, z)}
             onTouchMove={(e) => beiTouchMove(e, z)}
             onTouchEnd={() => beiTouchEnde(z)}
             onTouchCancel={() => beiTouchEnde(z)}>
          {/* The permanent checkbox is desktop-only; on mobile, tapping the
              avatar selects (see PostApp.module.css). */}
          <label className={styles.checkbox} onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={gewaehlt} onChange={() => auswahlUm(z.id)} />
          </label>
          <span className={`${styles.avatar} ${gewaehlt ? styles.avatarGewaehlt : ""}`}
                style={{ background: gewaehlt ? "var(--akzent)" : farbe(von?.email || "?") }}
                onClick={(e) => { if (!mobil) return; e.stopPropagation(); auswahlUm(z.id); }}>
            {gewaehlt ? <Icon name="check" size={16} /> : initialen(von)}
          </span>
          <div className={styles.zeileText}>
            <div className={styles.zeileKopf}>
              <span className={styles.absender}>{anzeigeName(von) || "(unbekannt)"}</span>
              <span className={styles.zeileRechts}>
                {z.pinned && <span title="Angeheftet">📌</span>}
                {z.has_attachment && <Icon name="attachment" size={13} />}
                {z.flagged && <span className={styles.flagge}>⚑</span>}
                {geplantAnsicht && weckzeiten[z.id] && <span className={styles.hinweis} title="Weckzeit">⏰ {datumKurz(weckzeiten[z.id])}</span>}
                <span className={styles.datum}>{datumKurz(z.received_at)}</span>
              </span>
            </div>
            <div className={styles.betreff}>{z.subject || "(ohne Betreff)"}</div>
            <div className={styles.vorschau}>{z.preview}</div>
            {z.labels.length > 0 && <div className={styles.labels}>{z.labels.map((l) => <span key={l} className={styles.label} style={{ borderLeft: `3px solid ${farbe(l)}` }}>{l}</span>)}</div>}
          </div>
          <div className={styles.schnell} onClick={(e) => e.stopPropagation()}>
            <button title={z.unread ? "Als gelesen markieren" : "Als ungelesen markieren"} onClick={() => void aktion(z.unread ? "gelesen" : "ungelesen", z.id)}><Icon name="mail" size={14} /></button>
            <button title={z.flagged ? "Markierung entfernen" : "Markieren"} onClick={() => void aktion(z.flagged ? "entmarkieren" : "markieren", z.id)}><Icon name="flag" size={14} /></button>
            <button title="Archivieren" onClick={() => void aktion("archiv", z.id)}><Icon name="archive" size={14} /></button>
            <button title="Löschen" onClick={() => void aktion("loeschen", z.id)}><Icon name="trash" size={14} /></button>
          </div>
        </div>
      </div>
    );
  };

  const listeSpalte = (
    <div className={`${styles.liste} ${mobilLesen ? styles.versteckt : ""}`} ref={listeRef}>
      {auswahl.size > 0 && (
        <div className={styles.auswahlLeiste}>
          <span>{auswahl.size} ausgewählt</span>
          <button className={styles.chip} onClick={() => void aktion("archiv")}>Archivieren</button>
          <button className={styles.chip} onClick={() => void aktion("loeschen")}>Löschen</button>
          <button className={styles.chip} onClick={() => void aktion("gelesen")}>Gelesen</button>
          <button className={styles.chip} onClick={() => setVerschiebeOffen(true)}>Verschieben…</button>
          <button className={styles.chip} onClick={() => setAuswahl(new Set())}>Aufheben</button>
        </div>
      )}
      {kontoFehlt && (
        <div className={styles.leer}>
          <div><strong>Kein Postfach verbunden.</strong></div>
          <div className={styles.hinweis}>{kontoFehlt}</div>
          <button className={styles.chip} style={{ marginTop: "0.6rem" }} onClick={() => void ausfuehrenLokal("open_window", { app_id: "services-hub" })}>
            Postfach in „Dienste“ verbinden
          </button>
        </div>
      )}
      {!kontoFehlt && zeilen.length === 0 && !laedtListe && (
        <div className={styles.leer}>{sucheAktiv ? "Nichts gefunden." : "Keine Mails hier."}</div>
      )}
      {(() => {
        const sortiert = [...zeilen].sort((a, b) => Number(b.pinned) - Number(a.pinned));
        const stuecke: ReactNode[] = [];
        let letzteGruppe = "";
        // Warning: show day headers ONLY when the list is actually ordered by day.
        //    Otherwise (e.g. sorted by "From") the days jump from row to row and
        //    almost every mail would get its own date header.
        //    Important: a header asserts an order. If the order does not hold, the
        //    header is not decoration but a false statement.
        const nachTagen = sortFeld === "datum";
        // Sorted by "From", the list is grouped by sender (as in Outlook).
        // Warning: NOT in Sent/Drafts: there the list shows the recipient, but
        //    sorting is by sender (yourself). A group per recipient would again
        //    assert an order that does not exist — and a group per sender would
        //    be a single bucket.
        const zeigtEmpfaenger = aktuellerOrdner?.role === "sent" || aktuellerOrdner?.role === "drafts";
        const nachAbsender = sortFeld === "von" && !zeigtEmpfaenger;
        for (const [i, z] of sortiert.entries()) {
          const gruppe = z.pinned ? "Angeheftet"
            : nachTagen ? tagesGruppe(z.received_at)
            : nachAbsender ? (anzeigeName(z.from[0]) || "(ohne Absender)")
            : "";
          if (gruppe && gruppe !== letzteGruppe) {
            // Key includes the position: the same weekday can occur twice, and
            // duplicate keys in a list are exactly the kind of bug that later
            // shows up as "empty" sections.
            stuecke.push(<div key={`gruppe-${i}-${gruppe}`} className={styles.gruppe}>{gruppe}</div>);
            letzteGruppe = gruppe;
          }
          stuecke.push(zeileEintrag(z));
        }
        return stuecke;
      })()}
      {gesamt != null && zeilen.length < gesamt && (
        <button className={styles.mehr} disabled={laedtListe} onClick={() => void ladeListe(true)}>
          {laedtListe ? "Lädt…" : `Mehr laden (${zeilen.length} von ${gesamt})`}
        </button>
      )}
      {laedtListe && zeilen.length === 0 && <div className={styles.leer}>Lädt…</div>}
    </div>
  );

  const leseSpalte = (
    <div className={`${styles.lesen} ${mobil && !mobilLesen && !composer ? styles.versteckt : ""}`}>
      {composer && (
        <Composer key={composer.draftId ?? composer.inReplyTo ?? composer.forwardOf ?? "neu"} start={composer} identitaeten={identitaeten} prefs={prefs} melde={melde}
                  onGesendet={(id, undoS, text) => { if (undoS > 0) setUndo({ id, bis: Date.now() + undoS * 1000, text }); else melde(text); void ladeAusgang(); void ladeOrdner(); }}
                  onClose={(grund) => { setComposer(null); if (grund !== "verworfen" && aktuellerOrdner?.role === "drafts") void ladeListe(false); }} />
      )}
      {!composer && !mail && !laedtMail && (
        <div className={styles.leerLesen}>
          <Icon name="mail" size={40} />
          <div>Zu lesende E-Mail auswählen</div>
          <div className={styles.hinweis}>{kontoFehlt ? "" : unreadInbox > 0 ? `${unreadInbox} ungelesen im Posteingang` : "Alles gelesen."}</div>
        </div>
      )}
      {!composer && laedtMail && <div className={styles.leerLesen}>Lädt…</div>}
      {!composer && mail && !laedtMail && (
        <>
          {/* On mobile, the header toolbar plus the "More" sheet replace
              these two bars — see the rationale in the header. */}
          {!mobil && (<>
          <div className={styles.aktionen}>
            {mail.draft ? (
              <button className={`${styles.chip} ${styles.chipAktiv}`} onClick={() => oeffneEntwurf(mail)}><Icon name="pen" size={14} /> Entwurf bearbeiten</button>
            ) : (
              <>
                <button className={styles.chip} onClick={() => void oeffneComposer("reply", mail)} title="Antworten (r)"><Icon name="back" size={14} /> Antworten</button>
                <button className={styles.chip} onClick={() => void oeffneComposer("all", mail)} title="Allen antworten (a)">Allen antworten</button>
                <button className={styles.chip} onClick={() => void oeffneComposer("forward", mail)} title="Weiterleiten (f)"><Icon name="export" size={14} /> Weiterleiten</button>
              </>
            )}
            <span className={styles.trenner} />
            <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void aktion("archiv")}><Icon name="archive" size={14} /> Archivieren</button>
            <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void aktion("loeschen")}><Icon name="trash" size={14} /> Löschen</button>
            <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => setVerschiebeOffen(true)}><Icon name="folder" size={14} /> Verschieben</button>
            <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void aktion(mail.flagged ? "entmarkieren" : "markieren")}><Icon name="flag" size={14} /> {mail.flagged ? "Markierung weg" : "Markieren"}</button>
            <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void aktion("ungelesen")}><Icon name="mail" size={14} /> Ungelesen</button>
            {mail.snoozed
              ? <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void wecken()} title="Zurück in den Posteingang"><Icon name="bell" size={14} /> Jetzt wecken</button>
              : <span className={styles.bausteinAnker}>
                  <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => setSchlummerOffen((v) => !v)} title="Erneut erinnern: Mail verschwindet bis zur Weckzeit"><Icon name="moon" size={14} /> Schlummern</button>
                  {schlummerOffen && (
                    <div className={styles.vorschlagListe} style={{ minWidth: 200 }}>
                      {([["later", "In 3 Stunden"], ["evening", "Heute Abend 18:00"], ["tomorrow", "Morgen 09:00"], ["weekend", "Samstag 09:00"], ["nextweek", "Montag 09:00"]] as [string, string][]).map(([k, l]) => (
                        <button type="button" key={k} className={styles.vorschlag} onMouseDown={(e) => { e.preventDefault(); void schlummern(k); }}>{l}</button>
                      ))}
                      <button type="button" className={styles.vorschlag} onMouseDown={(e) => { e.preventDefault(); const w = window.prompt("Weckzeit (JJJJ-MM-TT HH:MM):"); if (w) void schlummern(w.replace(" ", "T")); }}>Eigene Zeit…</button>
                    </div>
                  )}
                </span>}
            <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void anheften(!mail.pinned)} title="Oben in der Liste halten">📌 {mail.pinned ? "Lösen" : "Anheften"}</button>
            <span className={styles.bausteinAnker}>
              <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => setLabelOffen((v) => !v)} title="Kategorie/Label setzen"><Icon name="flag" size={14} /> Label</button>
              {labelOffen && (
                <div className={styles.vorschlagListe} style={{ minWidth: 200 }}>
                  {Array.from(new Set([...(prefs.labels ?? []), ...mail.labels])).sort().map((l) => (
                    <button type="button" key={l} className={styles.vorschlag} onMouseDown={(e) => { e.preventDefault(); void labelSetzen(l, !mail.labels.includes(l)); }}>
                      <span className={styles.labelPunkt} style={{ background: farbe(l) }} /> {l} {mail.labels.includes(l) ? "✓" : ""}
                    </button>
                  ))}
                  <button type="button" className={styles.vorschlag} onMouseDown={(e) => { e.preventDefault(); const n = window.prompt("Neues Label:"); if (n?.trim()) void labelSetzen(n.trim(), true); setLabelOffen(false); }}>+ Neues Label…</button>
                </div>
              )}
            </span>
            {aktuellerOrdner?.role === "junk"
              ? <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void aktion("posteingang")}>Kein Spam</button>
              : <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void aktion("spam")}><Icon name="blocked" size={14} /> Spam</button>}
            {mail.from[0]?.email && (
              <>
                <button className={styles.chip} disabled={!!beschaeftigt} title="Alle Mails dieses Absenders in diesem Ordner löschen oder archivieren" onClick={() => setAufraeumen(mail.from[0].email)}><Icon name="scissors" size={14} /> Aufräumen</button>
                <button className={styles.chip} disabled={!!beschaeftigt} title="Absender blockieren: künftige Mails werden verworfen" onClick={async () => {
                  const adr = mail.from[0].email;
                  if (!window.confirm(`${adr} blockieren? Künftige Mails werden verworfen, vorhandene landen im Papierkorb.`)) return;
                  try { const r = await postRegeln.blockieren(adr); melde(r.message); void ladeOrdner(); void ladeListe(false); setMail(null); setGewaehltId(null); }
                  catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
                }}><Icon name="blocked" size={14} /> Blockieren</button>
              </>
            )}
          </div>
          <div className={styles.claraLeiste}>
            <span className={styles.claraMarke}>{getBrand().product}</span>
            <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void bruecke("task")} title="Aufgabe im Planner (Projekt Inbox)">→ Aufgabe</button>
            <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void bruecke("event")} title="Termin im Kalender">→ Termin</button>
            <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void bruecke("contact")} title="Absender in die Kontakte">→ Kontakt</button>
            <button className={styles.chip} disabled={!!beschaeftigt} onClick={() => void bruecke("note")} title="Als Notiz in Wissen">→ Notiz</button>
          </div>
          </>)}
          <div className={styles.mailKopf}>
            <h1 className={styles.mailBetreff}>{mail.subject || "(ohne Betreff)"}</h1>
            <div className={styles.mailMeta}>
              <span className={styles.avatarGross} style={{ background: farbe(mail.from[0]?.email || "?") }}>{initialen(mail.from[0])}</span>
              <div className={styles.mailMetaText}>
                <div className={styles.mailVon}>
                  <button className={styles.profilKnopf}
                          title="Wer ist das? Kontakt, letzte Mails, gemeinsame Termine"
                          onClick={() => mail.from[0]?.email && setProfilFuer({ email: mail.from[0].email, name: anzeigeName(mail.from[0]) })}>
                    <strong>{anzeigeName(mail.from[0])}</strong>
                  </button>
                  <span className={styles.adresse}>&lt;{mail.from[0]?.email}&gt;</span>
                </div>
                {/* Like Outlook, mobile collapses the recipients behind an arrow —
                    three lines of addresses would otherwise cost a sixth of the screen. */}
                {mobil && !empfaengerOffen ? (
                  <button className={styles.mailAnKurz} onClick={() => setEmpfaengerOffen(true)}>
                    An: {anzeigeName(mail.to[0]) || "—"}
                    {mail.to.length + mail.cc.length > 1 && ` +${mail.to.length + mail.cc.length - 1}`}
                    <Icon name="chevronDown" size={14} />
                  </button>
                ) : (
                  <div className={styles.mailAn}
                       onClick={() => { if (mobil) setEmpfaengerOffen(false); }}>
                    An: {adressListe(mail.to) || "—"}{mail.cc.length > 0 && <> · Cc: {adressListe(mail.cc)}</>}
                  </div>
                )}
              </div>
              <div className={styles.mailDatum}>{datumLang(mail.received_at)}{mail.size != null && <div className={styles.hinweis}>{groesse(mail.size)}</div>}</div>
            </div>
            {mail.attachments.filter((a) => !a.inline || !a.cid).length > 0 && (
              <div className={styles.anhaenge}>
                {mail.attachments.filter((a) => !a.inline || !a.cid).map((a) => (
                  <a key={a.blob_id + a.name} className={styles.anhang} href={postApi.blobUrl(a, kontoId || undefined)} target="_blank" rel="noopener">
                    <Icon name="attachment" size={13} /> {a.name} <span className={styles.hinweis}>{groesse(a.size)}</span>
                  </a>
                ))}
              </div>
            )}
            {mail.html && !bilder && /<img\b/i.test(mail.html) && (
              <div className={styles.bilderHinweis}>
                Fremde Bilder sind blockiert. <button className={styles.link} onClick={() => setBilder(true)}>Bilder laden</button>
              </div>
            )}
          </div>
          <div className={styles.mailKoerper}>
            {mail.html
              ? <iframe className={styles.htmlRahmen} title="Nachricht" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={htmlDokument(mail, bilder, dunkel, kontoId || undefined)} />
              : <pre className={styles.textKoerper}>{mail.text || "(kein Inhalt)"}</pre>}
          </div>
          {mail.thread.length > 1 && (
            <div className={`${styles.unterhaltung} ${mobil && !unterhaltungOffen ? styles.unterhaltungZu : ""}`}>
              {/* On mobile the conversation list permanently took about a third
                  of the height — now it opens on tap. */}
              {mobil ? (
                <button className={styles.unterhaltungTitel} onClick={() => setUnterhaltungOffen((v) => !v)}>
                  Unterhaltung ({mail.thread.length})
                  <Icon name={unterhaltungOffen ? "chevronDown" : "chevronRight"} size={14} />
                </button>
              ) : (
                <div className={styles.unterhaltungTitel}>Unterhaltung ({mail.thread.length})</div>
              )}
              {(!mobil || unterhaltungOffen) && mail.thread.map((t) => (
                <button key={t.id} className={`${styles.unterhaltungEintrag} ${t.id === mail.id ? styles.unterhaltungAktiv : ""}`} onClick={() => void oeffne(t.id)}>
                  <span className={styles.absender}>{anzeigeName(t.from[0])}</span>
                  <span className={styles.vorschau}>{t.preview}</span>
                  <span className={styles.datum}>{datumKurz(t.received_at)}</span>
                </button>
              ))}
            </div>
          )}
          {/* Important: on mobile, reply belongs at the thumb, not at the top edge
              of the screen (Outlook Mobile does the same). */}
          {mobil && !composer && (
            <div className={styles.leseLeisteUnten}>
              {mail.draft ? (
                <button className={`${styles.chip} ${styles.chipAktiv}`} onClick={() => oeffneEntwurf(mail)}>
                  <Icon name="pen" size={16} /> Entwurf bearbeiten
                </button>
              ) : (
                <>
                  <button className={styles.leseKnopf} onClick={() => void oeffneComposer("reply", mail)}>
                    <Icon name="back" size={18} /> Antworten
                  </button>
                  <button className={styles.leseKnopf} onClick={() => void oeffneComposer("all", mail)}>
                    <Icon name="people" size={18} /> Allen
                  </button>
                  <button className={styles.leseKnopf} onClick={() => void oeffneComposer("forward", mail)}>
                    <Icon name="export" size={18} /> Weiterleiten
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  // ── Context menu: the 17 Outlook actions in five groups.
  //    On mobile a bottom sheet, on desktop a menu at the pointer.
  // The reading pane's "More" menu refers to the same mail — which is not
  // necessarily in the loaded list (e.g. after jumping within the conversation).
  const kontextZeile = kontext
    ? zeilen.find((z) => z.id === kontext.id) ?? (mail && mail.id === kontext.id ? mail : null)
    : null;
  const kontextMenue = kontext && kontextZeile ? (() => {
    const z = kontextZeile;
    const abs = z.from[0];
    const E = ({ icon, text, tun, aus }: { icon?: IconName; text: string; tun: () => void; aus?: boolean }) => (
      <button className={styles.sheetEintrag} disabled={aus} onClick={() => { kontextZu(); tun(); }}>
        {icon ? <Icon name={icon} size={18} /> : <span className={styles.sheetPlatz} />}{text}
      </button>
    );
    return (
      <div className={styles.dialogHinter}
           /* Warning: after a long press, the browser sends a ghost click about
              4 ms after `touchend`. Without this guard it closed the sheet
              immediately — and, if the finger was low on the screen, would have
              triggered an entry right away. Hence swallow it in the capture
              phase, not only at the backdrop. */
           onClickCapture={(e) => {
             if (Date.now() - kontextAufMs.current < 700) { e.stopPropagation(); e.preventDefault(); }
           }}
           onClick={kontextZu}>
        <div className={mobil ? styles.sheet : styles.kontextPopup}
             style={mobil ? undefined : { left: kontext.x, top: kontext.y }}
             onClick={(e) => e.stopPropagation()}>
          {mobil && <div className={styles.sheetGriff} />}
          {mobil && (
            <div className={styles.sheetKopf}>
              <span className={styles.avatar} style={{ background: farbe(abs?.email || "?") }}>{initialen(abs)}</span>
              <div className={styles.zeileText}>
                <div className={styles.absender}>{anzeigeName(abs) || "(unbekannt)"}</div>
                <div className={styles.vorschau}>{z.subject || "(ohne Betreff)"}</div>
              </div>
            </div>
          )}

          {kontextUnter === "verschieben" && (
            <>
              <div className={styles.sheetTitel}>Verschieben nach …</div>
              {ordner.filter((o) => o.id !== aktuellerOrdner?.id).map((o) => (
                <button key={o.id} className={styles.sheetEintrag}
                        onClick={() => { setVerschiebeFuer(z.id); kontextZu(); void verschiebe(o); }}>
                  <Icon name={ordnerIcon(o.role)} size={18} />{o.name}
                </button>
              ))}
            </>
          )}

          {kontextUnter === "schlummern" && (
            <>
              <div className={styles.sheetTitel}>Erneut erinnern …</div>
              {([["later", "In 3 Stunden"], ["evening", "Heute Abend 18:00"], ["tomorrow", "Morgen 09:00"], ["weekend", "Samstag 09:00"], ["nextweek", "Montag 09:00"]] as [string, string][]).map(([k, l]) => (
                <button key={k} className={styles.sheetEintrag} onClick={() => { kontextZu(); void schlummern(k, z.id); }}>
                  <Icon name="moon" size={18} />{l}
                </button>
              ))}
              <button className={styles.sheetEintrag} onClick={() => { kontextZu(); const w = window.prompt("Weckzeit (JJJJ-MM-TT HH:MM):"); if (w) void schlummern(w.replace(" ", "T"), z.id); }}>
                <span className={styles.sheetPlatz} />Eigene Zeit…
              </button>
            </>
          )}

          {kontextUnter === "label" && (
            <>
              <div className={styles.sheetTitel}>Kategorisieren</div>
              {Array.from(new Set([...(prefs.labels ?? []), ...z.labels])).sort().map((l) => (
                <button key={l} className={styles.sheetEintrag} onClick={() => { kontextZu(); void labelSetzen(l, !z.labels.includes(l), z.id); }}>
                  <span className={styles.labelPunkt} style={{ background: farbe(l) }} />{l} {z.labels.includes(l) ? "✓" : ""}
                </button>
              ))}
              <button className={styles.sheetEintrag} onClick={() => { kontextZu(); const n = window.prompt("Neues Label:"); if (n?.trim()) void labelSetzen(n.trim(), true, z.id); }}>
                <span className={styles.sheetPlatz} />+ Neues Label…
              </button>
            </>
          )}

          {kontextUnter === null && (
            <>
              <E icon="back" text="Antworten" tun={() => void antwortenAus("reply", z.id)} />
              <E text="Allen antworten" tun={() => void antwortenAus("all", z.id)} />
              <E icon="export" text="Weiterleiten" tun={() => void antwortenAus("forward", z.id)} />
              <div className={styles.sheetTrenner} />
              <E icon="trash" text={aktuellerOrdner?.role === "trash" ? "Endgültig löschen" : "Löschen"} tun={() => void aktion("loeschen", z.id)} />
              <E icon="archive" text="Archivieren" tun={() => void aktion("archiv", z.id)} />
              <button className={styles.sheetEintrag} onClick={() => setKontextUnter("verschieben")}>
                <Icon name="folder" size={18} />Verschieben<span className={styles.sheetPfeil}><Icon name="chevronRight" size={16} /></span>
              </button>
              <div className={styles.sheetTrenner} />
              <E icon="mail" text={z.unread ? "Als gelesen markieren" : "Als ungelesen markieren"} tun={() => void aktion(z.unread ? "gelesen" : "ungelesen", z.id)} />
              <E text={z.pinned ? "📌 Lösen" : "📌 Anheften"} tun={() => void anheften(!z.pinned, z.id)} />
              <button className={styles.sheetEintrag} onClick={() => setKontextUnter("label")}>
                <Icon name="flag" size={18} />Kategorisieren<span className={styles.sheetPfeil}><Icon name="chevronRight" size={16} /></span>
              </button>
              <E icon="star" text={z.flagged ? "Kennzeichen entfernen" : "Kennzeichnen"} tun={() => void aktion(z.flagged ? "entmarkieren" : "markieren", z.id)} />
              {geplantAnsicht
                ? <E icon="bell" text="Jetzt wecken" tun={() => void wecken(z.id)} />
                : <button className={styles.sheetEintrag} onClick={() => setKontextUnter("schlummern")}>
                    <Icon name="moon" size={18} />Erneut erinnern<span className={styles.sheetPfeil}><Icon name="chevronRight" size={16} /></span>
                  </button>}
              <div className={styles.sheetTrenner} />
              <E icon="blocked" text="Als Spam melden" tun={() => void aktion("spam", z.id)} />
              <E icon="scissors" text={`Alle von ${anzeigeName(abs) || "diesem Absender"} aufräumen…`}
                 tun={() => setAufraeumen(abs?.email ?? "")} aus={!abs?.email} />
              <div className={styles.sheetTrenner} />
              <E icon="check" text="→ Aufgabe" tun={() => void brueckeAus("task", z.id)} />
              <E icon="calendar" text="→ Termin" tun={() => void brueckeAus("event", z.id)} />
              <E icon="person" text="→ Kontakt" tun={() => void brueckeAus("contact", z.id)} />
              <E icon="note" text="→ Notiz" tun={() => void brueckeAus("note", z.id)} />
            </>
          )}
        </div>
      </div>
    );
  })() : null;

  return (
    <div ref={appRef} className={`${styles.app} ${mobil ? styles.mobil : ""}`}>
      {kopf}
      {sucheZeile}
      <div className={styles.koerper}>
        {(!mobil || ordnerOffen) && ordnerSpalte}
        {listeSpalte}
        {leseSpalte}
        {!mobil && meinTagOffen && (
          <MeinTag tage={7} melde={melde}
                   onOeffnePlanner={() => void ausfuehrenLokal("open_window", { app_id: "planner" })} />
        )}
      </div>
      {verschiebeOffen && (
        <div className={styles.dialogHinter} onClick={() => { setVerschiebeOffen(false); setVerschiebeFuer(null); }}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <div className={styles.dialogTitel}>Verschieben nach …</div>
            {ordner.filter((o) => o.id !== aktuellerOrdner?.id).map((o) => (
              <button key={o.id} className={styles.ordnerEintrag} onClick={() => void verschiebe(o)}>
                <Icon name={ordnerIcon(o.role)} size={16} /><span className={styles.ordnerName}>{o.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {undo && (
        <div className={styles.toast}>
          {undo.text} · <button className={styles.link} onClick={() => void rueckgaengig()}>Rückgängig ({Math.max(0, Math.ceil((undo.bis - Date.now()) / 1000))} s)</button>
        </div>
      )}
      {ueberallOffen !== null && (
        <SucheDialog start={ueberallOffen} melde={melde}
                     onClose={() => setUeberallOffen(null)}
                     onMail={(id) => void oeffne(id)}
                     onApp={(app) => void ausfuehrenLokal("open_window", { app_id: app })} />
      )}
      {profilFuer && (
        <ProfilKarte email={profilFuer.email} name={profilFuer.name}
                     onClose={() => setProfilFuer(null)}
                     onMail={(id) => void oeffne(id)}
                     onSchreiben={(adresse, name) => setComposer({ to: [{ email: adresse, name }] })} />
      )}
      {freigabenOffen && <FreigabenDialog melde={melde} onClose={() => setFreigabenOffen(false)} />}
      {verzeichnisOffen && <VerzeichnisDialog onClose={() => setVerzeichnisOffen(false)}
        onSchreiben={(adresse, name) => setComposer({ to: [{ email: adresse, name }] })} />}
      {verteilerOffen && <VerteilerDialog melde={melde} onClose={() => setVerteilerOffen(false)} />}
      {regelnOffen && <RegelnDialog ordner={ordner} melde={melde} onClose={() => setRegelnOffen(false)} />}
      {abwesenheitOffen && <AbwesenheitDialog melde={melde} onClose={() => setAbwesenheitOffen(false)} />}
      {aufraeumen && <AufraeumenDialog sender={aufraeumen} mailbox={aktuellerOrdner} melde={melde} onClose={() => setAufraeumen(null)} onDone={() => { void ladeOrdner(); void ladeListe(false); setMail(null); setGewaehltId(null); }} />}
      {einstellungenOffen && (
        <Einstellungen identitaeten={identitaeten} prefs={prefs} onClose={() => setEinstellungenOffen(false)}
                       onSave={async (p, sig) => {
                         try {
                           await postSchreiben.prefsSpeichern(p); setPrefs(p);
                           for (const [id, s] of Object.entries(sig)) await postSchreiben.identitaetAendern(id, { html_signature: s, text_signature: s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/div>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() });
                           const i = await postSchreiben.identitaeten(); setIdentitaeten(i.identities);
                           melde("Einstellungen gespeichert"); setEinstellungenOffen(false);
                         } catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
                       }} />
      )}
      {mobil && !mobilLesen && !composer && !kontoFehlt && !auswahl.size && (
        <button className={styles.fab} onClick={() => void oeffneComposer("neu")}
                title="Neue E-Mail" aria-label="Neue E-Mail"><Icon name="pen" size={22} /></button>
      )}
      {mehrOffen && (
        <div className={styles.dialogHinter} onClick={() => setMehrOffen(false)}>
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.sheetGriff} />
            <div className={styles.sheetTitel}>Filter</div>
            <div className={styles.sheetChips}>
              {(["alle", "ungelesen", "markiert", "dateien"] as Filter[]).map((f) => (
                <button key={f} className={`${styles.chip} ${filter === f ? styles.chipAktiv : ""}`}
                        onClick={() => { setFilter(f); setMehrOffen(false); }}>
                  {FILTER_NAMEN[f]}
                </button>
              ))}
            </div>
            <div className={styles.sheetTitel}>Sortieren nach</div>
            <div className={styles.sheetChips}>
              {SORT_NAMEN.map(([k, l]) => (
                <button key={k} className={`${styles.chip} ${sortFeld === k ? styles.chipAktiv : ""}`}
                        onClick={() => { setSortFeld(k); setSortAb(SORT_STANDARD_AB[k]); setMehrOffen(false); }}>{l}</button>
              ))}
            </div>
            <div className={styles.sheetChips}>
              <button className={`${styles.chip} ${sortAb ? styles.chipAktiv : ""}`}
                      onClick={() => { setSortAb(true); setMehrOffen(false); }}>{richtungNamen(sortFeld)[0]}</button>
              <button className={`${styles.chip} ${!sortAb ? styles.chipAktiv : ""}`}
                      onClick={() => { setSortAb(false); setMehrOffen(false); }}>{richtungNamen(sortFeld)[1]}</button>
            </div>
            <div className={styles.sheetTrenner} />
            <button className={styles.sheetEintrag} onClick={() => { setMehrOffen(false); void ladeOrdner(); void ladeListe(false); void ladeAusgang(); }}><Icon name="reload" size={18} /> Aktualisieren</button>
            {(sucheAktiv || filter !== "alle") && !kontoFehlt && (
              <button className={styles.sheetEintrag} onClick={() => { setMehrOffen(false); void sucheSpeichern(); }}><Icon name="star" size={18} /> Als Suchordner speichern</button>
            )}
            <button className={styles.sheetEintrag} onClick={() => { setMehrOffen(false); setRegelnOffen(true); }}><Icon name="list" size={18} /> Regeln</button>
            <button className={styles.sheetEintrag} onClick={() => { setMehrOffen(false); setAbwesenheitOffen(true); }}><Icon name="moon" size={18} /> Abwesenheit</button>
            <button className={styles.sheetEintrag} onClick={() => { setMehrOffen(false); setEinstellungenOffen(true); }}><Icon name="gear" size={18} /> Einstellungen</button>
          </div>
        </div>
      )}
      {kontextMenue}
      {meldung && !undo && <div className={`${styles.toast} ${meldung.fehler ? styles.toastFehler : ""}`}>{meldung.text}</div>}
    </div>
  );
}


/** Settings: default sender, undo window, read receipt, signature per sender. */
function Einstellungen({ identitaeten, prefs, onClose, onSave }: {
  identitaeten: Identitaet[]; prefs: PostPrefs; onClose: () => void;
  onSave: (p: PostPrefs, signaturen: Record<string, string>) => Promise<void>;
}) {
  const [p, setP] = useState<PostPrefs>({ undo_s: 10, signature_on: true, ...prefs });
  const [sig, setSig] = useState<Record<string, string>>(() => Object.fromEntries(identitaeten.map((i) => [i.id, i.html_signature || i.text_signature.replace(/\n/g, "<br>")])));
  const [aktiv, setAktiv] = useState<string>(prefs.default_identity ?? identitaeten[0]?.id ?? "");
  return (
    <div className={styles.dialogHinter} onClick={onClose}>
      <div className={styles.dialog} style={{ minWidth: 420, maxWidth: "90%" }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogTitel}>Post-Einstellungen</div>
        <label className={styles.einstZeile}>Standard-Absender
          <select className={styles.vonSelect} value={p.default_identity ?? ""} onChange={(e) => setP({ ...p, default_identity: e.target.value })}>
            <option value="">(erste Identität)</option>
            {identitaeten.map((i) => <option key={i.id} value={i.id}>{i.email}</option>)}
          </select>
        </label>
        <label className={styles.einstZeile}>Senden rückgängig für
          <select className={styles.vonSelect} value={String(p.undo_s ?? 10)} onChange={(e) => setP({ ...p, undo_s: Number(e.target.value) })}>
            {[0, 5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n === 0 ? "aus (sofort senden)" : `${n} Sekunden`}</option>)}
          </select>
        </label>
        <label className={styles.einstZeile}><input type="checkbox" checked={!!p.request_mdn} onChange={(e) => setP({ ...p, request_mdn: e.target.checked })} /> Lesebestätigung standardmäßig anfordern</label>
        <label className={styles.einstZeile}><input type="checkbox" checked={p.signature_on !== false} onChange={(e) => setP({ ...p, signature_on: e.target.checked })} /> Signatur automatisch einfügen</label>
        {/* Like Outlook's "customize actions": the list's two swipe gestures. */}
        <label className={styles.einstZeile}>Wischen nach links
          <select className={styles.vonSelect} value={p.swipe_links ?? "archiv"} onChange={(e) => setP({ ...p, swipe_links: e.target.value as WischAktion })}>
            {WISCH_WAHL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className={styles.einstZeile}>Wischen nach rechts
          <select className={styles.vonSelect} value={p.swipe_rechts ?? "aufgabe"} onChange={(e) => setP({ ...p, swipe_rechts: e.target.value as WischAktion })}>
            {WISCH_WAHL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <div className={styles.einstZeile}>Signatur für
          <select className={styles.vonSelect} value={aktiv} onChange={(e) => setAktiv(e.target.value)}>
            {identitaeten.map((i) => <option key={i.id} value={i.id}>{i.email}</option>)}
          </select>
        </div>
        {aktiv && (
          <SignaturEditor key={aktiv} html={sig[aktiv] ?? ""} onChange={(h) => setSig({ ...sig, [aktiv]: h })} />
        )}
        <div className={styles.composerFuss} style={{ borderTop: "none" }}>
          <button className={`${styles.chip} ${styles.chipAktiv}`} onClick={() => void onSave(p, sig)}>Speichern</button>
          <button className={styles.chip} onClick={onClose}>Abbrechen</button>
        </div>
      </div>
    </div>
  );
}


/** Small HTML editor for the signature (bold, italic, link, line break). */
function SignaturEditor({ html, onChange }: { html: string; onChange: (h: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = sanitizeMailHtml(html); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);
  const cmd = (n: string, a?: string) => { ref.current?.focus(); document.execCommand(n, false, a); onChange(ref.current?.innerHTML ?? ""); };
  return (
    <div className={styles.sigBox}>
      <div className={styles.editorLeiste} style={{ borderBottom: "none", padding: "0.2rem 0.3rem" }}>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); cmd("bold"); }}><b>F</b></button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); cmd("italic"); }}><i>K</i></button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); const u = window.prompt("Link-Adresse:", "https://"); if (u) cmd("createLink", u); }}>Link</button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); cmd("removeFormat"); }}>T̶</button>
        <span className={styles.hinweis} style={{ marginLeft: "auto" }}>Enter = neue Zeile</span>
      </div>
      <div ref={ref} className={styles.sigEditor} contentEditable suppressContentEditableWarning
           onInput={() => onChange(ref.current?.innerHTML ?? "")}
           onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); document.execCommand("insertLineBreak"); onChange(ref.current?.innerHTML ?? ""); } }}
           onPaste={(e) => { const t = e.clipboardData.getData("text/plain"); if (t) { e.preventDefault(); document.execCommand("insertText", false, t); } }} />
    </div>
  );
}
