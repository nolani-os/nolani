/** Dialogs: rules (Sieve builder), out-of-office, cleanup.
 *
 * Rules follow the Outlook pattern "condition → action → exception (here: further
 * conditions with all/any)". ClaraOS stores JSON; the API turns it into a Sieve
 * script and activates it on Stalwart. "Show script" displays what the server
 * actually runs — no black box.
 */
import { i18n, useTranslation } from "@claraos/core";
import { useEffect, useState } from "react";
import styles from "./PostApp.module.css";
import { Icon } from "../../components/Icon";
import { postRegeln, type Regel, type Ordner, type Abwesenheit } from "./api";

const FELDER = ["from", "to", "subject", "body", "any", "list_id", "size_over_kb", "has_attachment"];
const OPS = ["contains", "is", "starts", "ends"];
const AKTIONEN = ["move", "flag", "read", "label", "junk", "delete", "redirect", "stop"];

function neueRegel(): Regel {
  return { id: Math.random().toString(36).slice(2, 10), name: i18n.t("post:rules.newRule"), enabled: true, match: "all",
           conditions: [{ field: "from", op: "contains", value: "" }], actions: [{ type: "move", mailbox_id: null, mailbox_name: null }] };
}

export function RegelnDialog({ ordner, onClose, melde }: { ordner: Ordner[]; onClose: () => void; melde: (t: string, f?: boolean) => void }) {
  const { t } = useTranslation("post");
  const [regeln, setRegeln] = useState<Regel[] | null>(null);
  const [aktiv, setAktiv] = useState<number>(-1);
  const [script, setScript] = useState("");
  const [scriptOffen, setScriptOffen] = useState(false);
  const [fremd, setFremd] = useState<string[]>([]);
  const [laeuft, setLaeuft] = useState(false);
  const [geaendert, setGeaendert] = useState(false);

  useEffect(() => {
    postRegeln.laden().then((r) => { setRegeln(r.rules); setScript(r.script); setFremd(r.foreign_active); if (r.rules.length) setAktiv(0); })
      .catch((e) => { melde(e instanceof Error ? e.message : String(e), true); setRegeln([]); });
  }, [melde]);

  const r = regeln && aktiv >= 0 ? regeln[aktiv] : null;
  const patch = (p: Partial<Regel>) => { if (!regeln || aktiv < 0) return; setRegeln(regeln.map((x, i) => (i === aktiv ? { ...x, ...p } : x))); setGeaendert(true); };

  const speichern = async () => {
    if (!regeln) return;
    for (const x of regeln) {
      if (x.enabled && !x.conditions.some((c) => c.value.trim() || c.field === "has_attachment")) { melde(t("rules.noCondition", { name: x.name }), true); return; }
      if (x.enabled && x.actions.some((a) => a.type === "move" && !a.mailbox_id)) { melde(t("rules.noTarget", { name: x.name }), true); return; }
    }
    setLaeuft(true);
    try { const res = await postRegeln.speichern(regeln); setScript(res.script); setGeaendert(false); melde(t("rules.saved")); }
    catch (e) { melde(e instanceof Error ? e.message : String(e), true); }
    finally { setLaeuft(false); }
  };

  return (
    <div className={styles.dialogHinter} onClick={onClose}>
      <div className={`${styles.dialog} ${styles.dialogBreit}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogTitel}>{t("rules.title")} <span className={styles.hinweis}>{t("rules.titleHint")}</span></div>
        {fremd.length > 0 && <div className={styles.warnung}>{t("rules.foreignActive", { scripts: fremd.join(", ") })}</div>}
        {!regeln ? <div className={styles.leer}>{t("common.loading")}</div> : (
          <div className={styles.regelnKoerper}>
            <div className={styles.regelListe}>
              {regeln.map((x, i) => (
                <button key={x.id} className={`${styles.ordnerEintrag} ${i === aktiv ? styles.ordnerAktiv : ""}`} onClick={() => setAktiv(i)}>
                  <input type="checkbox" checked={x.enabled} onClick={(e) => e.stopPropagation()} onChange={(e) => { setRegeln(regeln.map((y, j) => (j === i ? { ...y, enabled: e.target.checked } : y))); setGeaendert(true); }} />
                  <span className={styles.ordnerName}>{x.name}</span>
                </button>
              ))}
              <button className={styles.ordnerEintrag} onClick={() => { setRegeln([...regeln, neueRegel()]); setAktiv(regeln.length); setGeaendert(true); }}><Icon name="plus" size={14} /> {t("rules.newRule")}</button>
            </div>
            <div className={styles.regelEditor}>
              {!r ? <div className={styles.leer}>{t("rules.pickOrCreate")}</div> : (
                <>
                  <input className={styles.betreffInput} value={r.name} onChange={(e) => patch({ name: e.target.value })} placeholder={t("rules.namePlaceholder")} />
                  <div className={styles.regelAbschnitt}>
                    {t("rules.when")} <select className={styles.miniSelect} value={r.match} onChange={(e) => patch({ match: e.target.value as "all" | "any" })}><option value="all">{t("rules.matchAll")}</option><option value="any">{t("rules.matchAny")}</option></select> {t("rules.whenSuffix")}
                  </div>
                  {r.conditions.map((c, i) => (
                    <div key={i} className={styles.regelZeile}>
                      <select className={styles.miniSelect} value={c.field} onChange={(e) => patch({ conditions: r.conditions.map((y, j) => (j === i ? { ...y, field: e.target.value } : y)) })}>
                        {FELDER.map((v) => <option key={v} value={v}>{t(`rules.field.${v}`)}</option>)}
                      </select>
                      {!["size_over_kb", "has_attachment"].includes(c.field) && (
                        <select className={styles.miniSelect} value={c.op} onChange={(e) => patch({ conditions: r.conditions.map((y, j) => (j === i ? { ...y, op: e.target.value } : y)) })}>
                          {OPS.map((v) => <option key={v} value={v}>{t(`rules.op.${v}`)}</option>)}
                        </select>
                      )}
                      {c.field !== "has_attachment" && (
                        <input className={styles.miniInput} value={c.value} placeholder={c.field === "size_over_kb" ? t("rules.sizePlaceholder") : t("rules.textPlaceholder")}
                               onChange={(e) => patch({ conditions: r.conditions.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)) })} />
                      )}
                      <button className={styles.iconKnopf} title={t("rules.removeCondition")} onClick={() => patch({ conditions: r.conditions.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
                    </div>
                  ))}
                  <button className={styles.link} onClick={() => patch({ conditions: [...r.conditions, { field: "subject", op: "contains", value: "" }] })}>{t("rules.addCondition")}</button>
                  <div className={styles.regelAbschnitt}>{t("rules.then")}</div>
                  {r.actions.map((a, i) => (
                    <div key={i} className={styles.regelZeile}>
                      <select className={styles.miniSelect} value={a.type} onChange={(e) => patch({ actions: r.actions.map((y, j) => (j === i ? { type: e.target.value } : y)) })}>
                        {AKTIONEN.map((v) => <option key={v} value={v}>{t(`rules.action.${v}`)}</option>)}
                      </select>
                      {a.type === "move" && (
                        <select className={styles.miniSelect} value={a.mailbox_id ?? ""} onChange={(e) => { const o = ordner.find((x) => x.id === e.target.value); patch({ actions: r.actions.map((y, j) => (j === i ? { ...y, mailbox_id: o?.id ?? null, mailbox_name: o?.raw_name ?? null } : y)) }); }}>
                          <option value="">{t("rules.pickFolder")}</option>
                          {ordner.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                      )}
                      {a.type === "redirect" && <input className={styles.miniInput} value={a.address ?? ""} placeholder={t("rules.addressPlaceholder")} onChange={(e) => patch({ actions: r.actions.map((y, j) => (j === i ? { ...y, address: e.target.value } : y)) })} />}
                      {a.type === "label" && <input className={styles.miniInput} value={a.label ?? ""} placeholder={t("rules.labelPlaceholder")} onChange={(e) => patch({ actions: r.actions.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) })} />}
                      <button className={styles.iconKnopf} title={t("rules.removeAction")} onClick={() => patch({ actions: r.actions.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
                    </div>
                  ))}
                  <button className={styles.link} onClick={() => patch({ actions: [...r.actions, { type: "flag" }] })}>{t("rules.addAction")}</button>
                  <div style={{ marginTop: "0.8rem" }}>
                    <button className={styles.chip} onClick={() => { if (window.confirm(t("rules.confirmDelete", { name: r.name }))) { setRegeln(regeln.filter((_, j) => j !== aktiv)); setAktiv(-1); setGeaendert(true); } }}><Icon name="trash" size={14} /> {t("rules.delete")}</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {scriptOffen && <pre className={styles.scriptBox}>{script || t("rules.noScript")}</pre>}
        <div className={styles.composerFuss} style={{ borderTop: "1px solid var(--border-1)" }}>
          <button className={`${styles.chip} ${styles.chipAktiv}`} disabled={laeuft || !regeln} onClick={() => void speichern()}>{laeuft ? t("common.saving") : t("rules.saveActivate")}</button>
          <button className={styles.chip} onClick={() => setScriptOffen((v) => !v)}>{scriptOffen ? t("rules.hideScript") : t("rules.showScript")}</button>
          <span className={styles.hinweis}>{geaendert ? t("common.unsaved") : ""}</span>
          <span style={{ flex: 1 }} />
          <button className={styles.chip} onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}

export function AbwesenheitDialog({ onClose, melde }: { onClose: () => void; melde: (t: string, f?: boolean) => void }) {
  const { t } = useTranslation("post");
  const [v, setV] = useState<Abwesenheit | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  useEffect(() => { postRegeln.abwesenheit().then((r) => setV(r.vacation)).catch((e) => { melde(e instanceof Error ? e.message : String(e), true); onClose(); }); }, [melde, onClose]);
  const tag = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
  return (
    <div className={styles.dialogHinter} onClick={onClose}>
      <div className={styles.dialog} style={{ minWidth: 460, maxWidth: "92%" }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogTitel}>{t("vacation.title")} <span className={styles.hinweis}>{t("vacation.titleHint")}</span></div>
        {!v ? <div className={styles.leer}>{t("common.loading")}</div> : (
          <>
            <label className={styles.einstZeile}><input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> {t("vacation.enable")}</label>
            <div className={styles.einstZeile}>{t("vacation.from")} <input type="date" className={styles.spaeterInput} value={tag(v.from_date)} onChange={(e) => setV({ ...v, from_date: e.target.value || null })} />
              {t("vacation.to")} <input type="date" className={styles.spaeterInput} value={tag(v.to_date)} onChange={(e) => setV({ ...v, to_date: e.target.value || null })} />
              <span className={styles.hinweis}>{t("vacation.emptyHint")}</span></div>
            <div className={styles.einstZeile}>{t("vacation.subject")} <input className={styles.miniInput} style={{ flex: 1 }} value={v.subject} placeholder={t("vacation.subjectPlaceholder")} onChange={(e) => setV({ ...v, subject: e.target.value })} /></div>
            <textarea className={styles.sigText} rows={6} value={v.text} placeholder={t("vacation.textPlaceholder")} onChange={(e) => setV({ ...v, text: e.target.value })} />
            <div className={styles.composerFuss} style={{ borderTop: "none" }}>
              <button className={`${styles.chip} ${styles.chipAktiv}`} disabled={laeuft} onClick={async () => {
                setLaeuft(true);
                try { const r = await postRegeln.abwesenheitSpeichern(v); setV(r.vacation); melde(r.vacation.enabled ? t("vacation.on") : t("vacation.off")); onClose(); }
                catch (e) { melde(e instanceof Error ? e.message : String(e), true); } finally { setLaeuft(false); }
              }}>{t("common.save")}</button>
              <button className={styles.chip} onClick={onClose}>{t("common.cancel")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function AufraeumenDialog({ sender, mailbox, onClose, melde, onDone }: {
  sender: string; mailbox: Ordner | null; onClose: () => void; melde: (t: string, f?: boolean) => void; onDone: () => void;
}) {
  const { t } = useTranslation("post");
  const [aktion, setAktion] = useState<"delete" | "archive">("delete");
  const [zukunft, setZukunft] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  return (
    <div className={styles.dialogHinter} onClick={onClose}>
      <div className={styles.dialog} style={{ minWidth: 380, maxWidth: "92%" }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogTitel}>{t("sweep.title")} <span className={styles.adresse}>{sender}</span></div>
        <div className={styles.hinweis} style={{ padding: "0 0.6rem 0.4rem" }}>{t("sweep.folder", { name: mailbox?.name ?? t("sweep.inbox") })}</div>
        <label className={styles.einstZeile}><input type="radio" checked={aktion === "delete"} onChange={() => setAktion("delete")} /> {t("sweep.toTrash")}</label>
        <label className={styles.einstZeile}><input type="radio" checked={aktion === "archive"} onChange={() => setAktion("archive")} /> {t("sweep.archive")}</label>
        <label className={styles.einstZeile}><input type="checkbox" checked={zukunft} onChange={(e) => setZukunft(e.target.checked)} /> {t("sweep.future")}</label>
        <div className={styles.composerFuss} style={{ borderTop: "none" }}>
          <button className={`${styles.chip} ${styles.chipAktiv}`} disabled={laeuft} onClick={async () => {
            setLaeuft(true);
            try { const r = await postRegeln.aufraeumen({ sender, mailbox: mailbox?.id ?? null, action: aktion, future: zukunft }); melde(r.message); onDone(); onClose(); }
            catch (e) { melde(e instanceof Error ? e.message : String(e), true); } finally { setLaeuft(false); }
          }}>{laeuft ? t("common.running") : t("sweep.action")}</button>
          <button className={styles.chip} onClick={onClose}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
