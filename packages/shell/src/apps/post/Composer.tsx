/** Composer — write, reply, forward.
 *
 * Lives in the reading pane (Outlook pattern "compose inline").
 * Rich text via contenteditable with a small toolbar (bold, italic, list,
 * link) — no editor library; the mail gets an HTML part plus a plain-text part.
 *
 * Important: "Send" holds the mail back on the server (Stalwart FUTURERELEASE),
 * so the toast can offer "Undo" meanwhile. "Send later" uses the same path with
 * a fixed time. Drafts live in the Drafts folder on Stalwart.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./PostApp.module.css";
import { sanitizeMailHtml } from "./mailHtml";
import { useTranslation } from "@claraos/core";
import { Icon } from "../../components/Icon";
import {
  postApi, postSchreiben, postBusiness,
  type Adresse, type AnhangNeu, type EntwurfDaten, type Identitaet, type Vorschlag, type PostPrefs, type Verteiler,
} from "./api";

export interface ComposerStart {
  draftId?: string | null;
  to?: Adresse[]; cc?: Adresse[]; bcc?: Adresse[];
  subject?: string;
  html?: string;                 // quoted text / draft body
  attachments?: AnhangNeu[];
  inReplyTo?: string | null; forwardOf?: string | null;
}

interface Props {
  start: ComposerStart;
  identitaeten: Identitaet[];
  prefs: PostPrefs;
  onClose: (grund: "gesendet" | "entwurf" | "verworfen") => void;
  melde: (text: string, fehler?: boolean) => void;
  onGesendet: (submissionId: string, undoS: number, text: string) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function AdressFeld({ label, werte, onChange, autoFocus }: {
  label: string; werte: Adresse[]; onChange: (v: Adresse[]) => void; autoFocus?: boolean;
}) {
  const { t } = useTranslation("post");
  const [eingabe, setEingabe] = useState("");
  const [vorschlaege, setVorschlaege] = useState<Vorschlag[]>([]);
  const [verteiler, setVerteiler] = useState<Verteiler[]>([]);
  const [aktiv, setAktiv] = useState(-1);
  const timer = useRef<number | null>(null);

  // Personal distribution lists appear in the same suggestion box as people.
  useEffect(() => {
    postBusiness.verteiler().then((r) => setVerteiler(r.verteiler)).catch(() => setVerteiler([]));
  }, []);

  /** Distribution lists matching the input — shown ABOVE people, because
   *  a list name would otherwise get lost among contacts with similar names. */
  const verteilerTreffer = eingabe.trim().length >= 2
    ? verteiler.filter((v) => v.name.toLowerCase().includes(eingabe.trim().toLowerCase()))
    : [];

  /** Selecting a distribution list expands it into its members IMMEDIATELY.
   *  Deliberately not at send time: whoever picks a list should see who will
   *  receive the mail before it is gone. */
  const verteilerUebernehmen = async (v: Verteiler) => {
    try {
      const r = await postBusiness.aufloesen([v.name, ...werte.map((w) => w.email)]);
      onChange(r.empfaenger.map((email) => {
        const alt = werte.find((w) => w.email.toLowerCase() === email.toLowerCase());
        return alt ?? { email };
      }));
    } catch {
      onChange([...werte, ...v.mitglieder.filter((m) => !werte.some((w) => w.email.toLowerCase() === m.toLowerCase()))
        .map((email) => ({ email }))]);
    }
    setEingabe(""); setVorschlaege([]);
  };

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (eingabe.trim().length < 2) { setVorschlaege([]); return; }
    timer.current = window.setTimeout(async () => {
      try {
        const r = await postSchreiben.vorschlaege(eingabe.trim());
        setVorschlaege(r.suggestions.filter((s) => !werte.some((w) => w.email.toLowerCase() === s.email)));
        setAktiv(-1);
      } catch { setVorschlaege([]); }
    }, 180);
  }, [eingabe, werte]);

  const uebernehmen = (a: Adresse) => {
    if (!werte.some((w) => w.email.toLowerCase() === a.email.toLowerCase())) onChange([...werte, a]);
    setEingabe(""); setVorschlaege([]);
  };
  const ausEingabe = () => {
    const raw = eingabe.trim().replace(/[,;]$/, "");
    if (!raw) return true;
    const m = raw.match(/^(.*?)\s*<([^>]+)>$/);
    const email = (m ? m[2] : raw).trim();
    if (!EMAIL_RE.test(email)) return false;
    uebernehmen({ name: m ? m[1].replace(/^"|"$/g, "") : undefined, email });
    return true;
  };

  return (
    <div className={styles.adressZeile}>
      <span className={styles.adressLabel}>{label}</span>
      <div className={styles.adressChips}>
        {werte.map((w) => (
          <span key={w.email} className={styles.adressChip} title={w.email}>
            {w.name ? w.name : w.email}
            <button type="button" onClick={() => onChange(werte.filter((x) => x.email !== w.email))} title={t("common.remove")}>×</button>
          </span>
        ))}
        <input className={styles.adressInput} value={eingabe} autoFocus={autoFocus}
               placeholder={werte.length ? "" : t("composer.addressPlaceholder")}
               onChange={(e) => setEingabe(e.target.value)}
               onKeyDown={(e) => {
                 if (e.key === "ArrowDown") { e.preventDefault(); setAktiv((a) => Math.min(a + 1, verteilerTreffer.length + vorschlaege.length - 1)); }
                 else if (e.key === "ArrowUp") { e.preventDefault(); setAktiv((a) => Math.max(a - 1, 0)); }
                 else if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === "Tab") {
                   if (aktiv >= 0 && aktiv < verteilerTreffer.length) { e.preventDefault(); void verteilerUebernehmen(verteilerTreffer[aktiv]); }
                   else if (aktiv >= 0 && vorschlaege[aktiv - verteilerTreffer.length]) { e.preventDefault(); uebernehmen(vorschlaege[aktiv - verteilerTreffer.length]); }
                   else if (eingabe.trim()) { if (e.key !== "Tab") e.preventDefault(); if (!ausEingabe() && e.key !== "Tab") e.preventDefault(); }
                 } else if (e.key === "Backspace" && !eingabe && werte.length) { onChange(werte.slice(0, -1)); }
                 else if (e.key === "Escape") { setVorschlaege([]); }
               }}
               onBlur={() => { window.setTimeout(() => { ausEingabe(); setVorschlaege([]); }, 150); }} />
        {(vorschlaege.length > 0 || verteilerTreffer.length > 0) && (
          <div className={styles.vorschlagListe}>
            {verteilerTreffer.map((v, i) => (
              <button type="button" key={`vt-${v.name}`} className={`${styles.vorschlag} ${i === aktiv ? styles.vorschlagAktiv : ""}`}
                      onMouseDown={(e) => { e.preventDefault(); void verteilerUebernehmen(v); }}>
                <span>{v.name}</span>
                <span className={styles.hinweis}>{t("composer.recipients", { count: v.mitglieder.length })}</span>
                <span className={styles.hinweis}>{t("composer.distributionList")}</span>
              </button>
            ))}
            {vorschlaege.map((v, i0) => { const i = i0 + verteilerTreffer.length; return (
              <button type="button" key={v.email} className={`${styles.vorschlag} ${i === aktiv ? styles.vorschlagAktiv : ""}`}
                      onMouseDown={(e) => { e.preventDefault(); uebernehmen(v); }}>
                <span>{v.name || v.email}</span>
                {v.name && <span className={styles.hinweis}>{v.email}</span>}
                <span className={styles.hinweis}>{v.source === "kontakte" ? t("composer.sourceContact") : t("composer.sourceRecent")}</span>
              </button>
            ); })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Composer({ start, identitaeten, prefs, onClose, melde, onGesendet }: Props) {
  const { t } = useTranslation("post");
  const [identityId, setIdentityId] = useState<string>(() =>
    (identitaeten.find((i) => i.id === prefs.default_identity) ?? identitaeten[0])?.id ?? "");
  const [to, setTo] = useState<Adresse[]>(start.to ?? []);
  const [cc, setCc] = useState<Adresse[]>(start.cc ?? []);
  const [bcc, setBcc] = useState<Adresse[]>(start.bcc ?? []);
  const [ccSichtbar, setCcSichtbar] = useState((start.cc?.length ?? 0) > 0 || (start.bcc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(start.subject ?? "");
  const [anhaenge, setAnhaenge] = useState<AnhangNeu[]>(start.attachments ?? []);
  const [mdn, setMdn] = useState(!!prefs.request_mdn);
  const [spaeter, setSpaeter] = useState<string>("");
  const [spaeterOffen, setSpaeterOffen] = useState(false);
  const [laeuft, setLaeuft] = useState<string>("");
  const [draftId, setDraftId] = useState<string | null>(start.draftId ?? null);
  const [geaendert, setGeaendert] = useState(false);
  const [bausteine, setBausteine] = useState<{ id: string; title: string; html: string }[] | null>(null);
  const [bausteinOffen, setBausteinOffen] = useState(false);
  const [erwaehnung, setErwaehnung] = useState<{ q: string; liste: Vorschlag[]; aktiv: number } | null>(null);
  const autosaveTimer = useRef<number | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const dateiRef = useRef<HTMLInputElement>(null);
  const identity = useMemo(() => identitaeten.find((i) => i.id === identityId), [identitaeten, identityId]);

  // Initial body: signature on top (before the quote when replying), quote below.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const sig = prefs.signature_on !== false && identity?.html_signature
      ? `<div><br></div><div class="claraos-signatur">${identity.html_signature}</div>`
      : (prefs.signature_on !== false && identity?.text_signature
        ? `<div><br></div><div class="claraos-signatur">${identity.text_signature.split("\n").map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>")}</div>` : "");
    ed.innerHTML = sanitizeMailHtml(start.draftId ? (start.html ?? "") : `<div><br></div>${sig}${start.html ?? ""}`);
    ed.focus();
    const sel = window.getSelection();
    if (sel && ed.firstChild) { const r = document.createRange(); r.setStart(ed.firstChild, 0); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const daten = useCallback((): EntwurfDaten => ({
    draft_id: draftId, identity_id: identityId, to, cc, bcc, subject,
    html: editorRef.current?.innerHTML ?? "", attachments: anhaenge,
    in_reply_to: start.inReplyTo ?? null, forward_of: start.forwardOf ?? null, request_mdn: mdn,
  }), [draftId, identityId, to, cc, bcc, subject, anhaenge, start.inReplyTo, start.forwardOf, mdn]);

  // Draft autosave: after 20 s without changes, save quietly.
  useEffect(() => {
    if (!geaendert) return;
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      const text = (editorRef.current?.innerText ?? "").trim();
      if (!laeuft && (to.length || subject.trim() || text)) void entwurfSpeichern(true);
    }, 20_000);
    return () => { if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geaendert, to, cc, bcc, subject, anhaenge]);

  const einfuegenHtml = (h: string) => {
    editorRef.current?.focus();
    document.execCommand("insertHTML", false, h);
    setGeaendert(true);
  };

  const bausteineLaden = async () => {
    if (bausteine) { setBausteinOffen((v) => !v); return; }
    try { const r = await postSchreiben.bausteine(); setBausteine(r.snippets); setBausteinOffen(true); }
    catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
  };

  // @mention: show suggestions after "@" + ≥2 characters; picking one inserts a link and adds the recipient.
  const erwaehnungPruefen = () => {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || sel.anchorNode.nodeType !== Node.TEXT_NODE) { setErwaehnung(null); return; }
    const davor = (sel.anchorNode.textContent ?? "").slice(0, sel.anchorOffset);
    const m = davor.match(/(?:^|\s)@([^\s@]{2,40})$/);
    if (!m) { setErwaehnung(null); return; }
    const q = m[1];
    void postSchreiben.vorschlaege(q).then((r) => setErwaehnung({ q, liste: r.suggestions.slice(0, 6), aktiv: 0 })).catch(() => setErwaehnung(null));
  };
  const erwaehnungUebernehmen = (v: Vorschlag) => {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !erwaehnung) return;
    const node = sel.anchorNode;
    const start = sel.anchorOffset - erwaehnung.q.length - 1;
    if (node.nodeType === Node.TEXT_NODE && start >= 0) {
      const r = document.createRange(); r.setStart(node, start); r.setEnd(node, sel.anchorOffset);
      sel.removeAllRanges(); sel.addRange(r);
      const name = (v.name || v.email.split("@")[0]).trim();
      document.execCommand("insertHTML", false, `<a href="mailto:${v.email}">@${name.replace(/</g, "")}</a>&nbsp;`);
    }
    if (!to.some((t) => t.email.toLowerCase() === v.email) && !cc.some((t) => t.email.toLowerCase() === v.email)) setTo([...to, { name: v.name || undefined, email: v.email }]);
    setErwaehnung(null); setGeaendert(true);
  };

  const cmd = (name: string, arg?: string) => { document.execCommand(name, false, arg); editorRef.current?.focus(); setGeaendert(true); };

  const hochladen = async (files: FileList | null) => {
    if (!files?.length) return;
    setLaeuft("upload");
    try {
      const neu: AnhangNeu[] = [];
      for (const f of Array.from(files)) neu.push(await postSchreiben.hochladen(f));
      setAnhaenge((a) => [...a, ...neu]); setGeaendert(true);
    } catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
    finally { setLaeuft(""); }
  };

  const entwurfSpeichern = async (leise = false) => {
    setLaeuft("entwurf");
    try {
      const r = await postSchreiben.entwurf(daten());
      setDraftId(r.draft_id); setGeaendert(false);
      if (!leise) melde(t("composer.draftSaved"));
      return r.draft_id;
    } catch (e) { melde(e instanceof Error ? e.message : String(e), true); return null; }
    finally { setLaeuft(""); }
  };

  const senden = async (sendAt?: string) => {
    if (!to.length && !cc.length && !bcc.length) { melde(t("composer.noRecipient"), true); return; }
    if (!subject.trim() && !window.confirm(t("composer.confirmNoSubject"))) return;
    const eigenerText = (editorRef.current?.innerText ?? "").replace(/(?:Am .* schrieb .*:|On .* wrote:)[\s\S]*$/, "");
    if (!anhaenge.length && /\b(anhang|anh[äa]ng|anbei|angeh[äa]ngt|beigef[üu]gt|attached|attachment)/i.test(eigenerText)
        && !window.confirm(t("composer.confirmNoAttachment"))) return;
    setLaeuft("senden");
    try {
      const undoS = sendAt ? 0 : Math.max(0, Math.min(prefs.undo_s ?? 10, 600));
      const r = await postSchreiben.senden({ ...daten(), delay_s: undoS, send_at: sendAt ?? null });
      onGesendet(r.submission_id, sendAt ? 0 : r.undo_until_s, r.message);
      onClose("gesendet");
    } catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
    finally { setLaeuft(""); }
  };

  // Discard: a draft created by autosave during THIS compose session is deleted too —
  // otherwise what the user explicitly threw away would stay in Drafts.
  const verwerfen = async () => {
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    if (draftId && !start.draftId) {
      try { await postApi.setzen({ ids: [draftId], destroy: true }); } catch { /* then the draft simply stays */ }
    }
    onClose("verworfen");
  };

  const schliessen = async () => {
    if (geaendert || (!draftId && (to.length || subject || (editorRef.current?.innerText ?? "").trim()))) {
      const wahl = window.confirm(t("composer.confirmSaveDraft"));
      if (wahl) { await entwurfSpeichern(); onClose("entwurf"); return; }
      await verwerfen(); return;
    }
    if (draftId && !start.draftId && !geaendert) { onClose("entwurf"); return; }
    onClose("verworfen");
  };

  // Ctrl+Enter sends, Esc closes
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") { ev.preventDefault(); void senden(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const titel = start.forwardOf ? t("composer.forward") : start.inReplyTo ? t("composer.reply") : start.draftId ? t("composer.draft") : t("composer.new");

  return (
    <div className={styles.composer} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); void schliessen(); } }}>
      <div className={styles.composerKopf}>
        <strong>{titel}</strong>
        <span className={styles.hinweis}>{draftId ? t("composer.draft") : ""}{laeuft === "upload" ? t("composer.uploading") : ""}</span>
        <span style={{ flex: 1 }} />
        <button className={styles.iconKnopf} title={t("composer.closeTitle")} onClick={() => void schliessen()}><Icon name="close" size={16} /></button>
      </div>

      <div className={styles.adressZeile}>
        <span className={styles.adressLabel}>{t("composer.from")}</span>
        <select className={styles.vonSelect} value={identityId} onChange={(e) => { setIdentityId(e.target.value); setGeaendert(true); }}>
          {identitaeten.map((i) => <option key={i.id} value={i.id}>{i.name ? `${i.name} <${i.email}>` : i.email}</option>)}
        </select>
        {!ccSichtbar && <button className={styles.link} type="button" onClick={() => setCcSichtbar(true)}>{t("composer.ccBcc")}</button>}
      </div>
      <AdressFeld label={t("composer.to")} werte={to} onChange={(v) => { setTo(v); setGeaendert(true); }} autoFocus={!start.to?.length} />
      {ccSichtbar && <AdressFeld label="Cc" werte={cc} onChange={(v) => { setCc(v); setGeaendert(true); }} />}
      {ccSichtbar && <AdressFeld label="Bcc" werte={bcc} onChange={(v) => { setBcc(v); setGeaendert(true); }} />}
      <div className={styles.adressZeile}>
        <span className={styles.adressLabel}>{t("composer.subject")}</span>
        <input className={styles.betreffInput} value={subject} placeholder={t("composer.subjectPlaceholder")}
               onChange={(e) => { setSubject(e.target.value); setGeaendert(true); }} />
      </div>

      <div className={styles.editorLeiste}>
        <button type="button" title={t("composer.bold")} onMouseDown={(e) => { e.preventDefault(); cmd("bold"); }}><b>{t("composer.boldLetter")}</b></button>
        <button type="button" title={t("composer.italic")} onMouseDown={(e) => { e.preventDefault(); cmd("italic"); }}><i>{t("composer.italicLetter")}</i></button>
        <button type="button" title={t("composer.underline")} onMouseDown={(e) => { e.preventDefault(); cmd("underline"); }}><u>{t("composer.underlineLetter")}</u></button>
        <button type="button" title={t("composer.bullets")} onMouseDown={(e) => { e.preventDefault(); cmd("insertUnorderedList"); }}>{t("composer.bulletsLabel")}</button>
        <button type="button" title={t("composer.numbering")} onMouseDown={(e) => { e.preventDefault(); cmd("insertOrderedList"); }}>{t("composer.numberingLabel")}</button>
        <button type="button" title={t("composer.link")} onMouseDown={(e) => { e.preventDefault(); const u = window.prompt(t("composer.linkPrompt"), "https://"); if (u) cmd("createLink", u); }}>{t("composer.link")}</button>
        <button type="button" title={t("composer.clearFormat")} onMouseDown={(e) => { e.preventDefault(); cmd("removeFormat"); }}>T̶</button>
        <span className={styles.trenner} />
        <button type="button" title={t("composer.attachment")} onClick={() => dateiRef.current?.click()}><Icon name="attachment" size={14} /> {t("composer.attachment")}</button>
        <span className={styles.bausteinAnker}>
          <button type="button" title={t("composer.snippetTitle")} onClick={() => void bausteineLaden()}><Icon name="note" size={14} /> {t("composer.snippet")}</button>
          {bausteinOffen && bausteine && (
            <div className={styles.vorschlagListe} style={{ minWidth: 220 }}>
              {bausteine.length === 0 && <div className={styles.vorschlag} style={{ cursor: "default" }}><span className={styles.hinweis}>{t("composer.noSnippets")}</span></div>}
              {bausteine.map((b) => (
                <button type="button" key={b.id} className={styles.vorschlag} onMouseDown={(e) => { e.preventDefault(); einfuegenHtml(b.html); setBausteinOffen(false); }}>{b.title}</button>
              ))}
            </div>
          )}
        </span>
        <input ref={dateiRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { void hochladen(e.target.files); e.target.value = ""; }} />
        <label className={styles.mdnLabel} title={t("composer.mdnTitle")}>
          <input type="checkbox" checked={mdn} onChange={(e) => { setMdn(e.target.checked); setGeaendert(true); }} /> {t("composer.mdn")}
        </label>
      </div>

      {erwaehnung && erwaehnung.liste.length > 0 && (
        <div className={styles.erwaehnungBox}>
          {erwaehnung.liste.map((v, i) => (
            <button type="button" key={v.email} className={`${styles.vorschlag} ${i === erwaehnung.aktiv ? styles.vorschlagAktiv : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); erwaehnungUebernehmen(v); }}>
              <span>@{v.name || v.email}</span>{v.name && <span className={styles.hinweis}>{v.email}</span>}
            </button>
          ))}
        </div>
      )}
      <div ref={editorRef} className={styles.editor} contentEditable suppressContentEditableWarning
           onInput={() => { setGeaendert(true); erwaehnungPruefen(); }}
           onKeyDown={(e) => {
             if (!erwaehnung) return;
             if (e.key === "ArrowDown") { e.preventDefault(); setErwaehnung({ ...erwaehnung, aktiv: Math.min(erwaehnung.aktiv + 1, erwaehnung.liste.length - 1) }); }
             else if (e.key === "ArrowUp") { e.preventDefault(); setErwaehnung({ ...erwaehnung, aktiv: Math.max(erwaehnung.aktiv - 1, 0) }); }
             else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const v = erwaehnung.liste[erwaehnung.aktiv]; if (v) erwaehnungUebernehmen(v); }
             else if (e.key === "Escape") { e.stopPropagation(); setErwaehnung(null); }
           }}
           onPaste={(e) => {
             // Paste plain text only — foreign HTML (Word, web pages) brings styles that break mails.
             const t = e.clipboardData.getData("text/plain");
             if (t) { e.preventDefault(); document.execCommand("insertText", false, t); }
           }} />

      {anhaenge.length > 0 && (
        <div className={styles.anhaenge} style={{ padding: "0 0.75rem 0.5rem" }}>
          {anhaenge.map((a) => (
            <span key={a.blob_id + a.name} className={styles.anhang}>
              <Icon name="attachment" size={13} /> {a.name}
              <button type="button" className={styles.link} onClick={() => { setAnhaenge((l) => l.filter((x) => x.blob_id !== a.blob_id)); setGeaendert(true); }} title={t("common.remove")}>×</button>
            </span>
          ))}
        </div>
      )}

      <div className={styles.composerFuss}>
        <button className={`${styles.chip} ${styles.chipAktiv}`} disabled={!!laeuft} onClick={() => void senden()} title={t("composer.sendShortcut")}>
          <Icon name="export" size={14} /> {laeuft === "senden" ? t("composer.sending") : t("composer.send")}
        </button>
        <button className={styles.chip} disabled={!!laeuft} onClick={() => setSpaeterOffen((v) => !v)}>{t("composer.sendLater")}</button>
        {spaeterOffen && (
          <span className={styles.spaeterBox}>
            <input type="datetime-local" value={spaeter} onChange={(e) => setSpaeter(e.target.value)} className={styles.spaeterInput} />
            <button className={styles.chip} disabled={!spaeter || !!laeuft} onClick={() => void senden(spaeter)}>{t("composer.schedule")}</button>
          </span>
        )}
        <button className={styles.chip} disabled={!!laeuft} onClick={() => void entwurfSpeichern()}>{t("composer.saveDraft")}</button>
        <span style={{ flex: 1 }} />
        <button className={styles.chip} disabled={!!laeuft} onClick={() => void verwerfen()} title={t("composer.discardTitle")}><Icon name="trash" size={14} /> {t("composer.discard")}</button>
      </div>
    </div>
  );
}
