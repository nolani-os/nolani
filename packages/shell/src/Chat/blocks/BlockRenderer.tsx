/**
 * BlockRenderer — cards in the chat. A catalog instead of code.
 *
 * The agent delivers `ui.block {id, kind, props}`; here the card kind is
 * mapped to a fixed component. Unknown kinds or missing required fields are
 * skipped, never rendered "somehow". Rules: height = content, at most two
 * actions, no scrolling inside the card.
 */
import { useEffect, useState } from "react";
import type { ChatBlock } from "../api";
import { ausfuehrenLokal } from "../shellActionHandler";
import { dispatchWhenReady } from "../actionBus";
import { Markdown } from "../Markdown";
import { oeffneShellZiel } from "../../Notifications/notificationActions";
import styles from "./blocks.module.css";
import { regionLocale } from "@claraos/core";

type Props = Record<string, unknown>;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function datumKurz(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const heute = new Date();
  const gleich = d.toDateString() === heute.toDateString();
  const zeit = d.getHours() || d.getMinutes() ? ` ${d.toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" })}` : "";
  return (gleich ? "Heute" : d.toLocaleDateString(regionLocale(), { day: "numeric", month: "short" })) + zeit;
}

/** "Open": replay the same shell action that Clara had triggered. */
function OeffnenKnopf({ oeffnen, label = "Öffnen" }: { oeffnen: unknown; label?: string }) {
  const o = obj(oeffnen);
  const [zustand, setZustand] = useState<"" | "läuft" | "ok" | "fehler">("");
  if (!o || typeof o.action !== "string") return null;
  return (
    <button
      type="button"
      className={`${styles.btn} ${styles.btnPrimaer}`}
      disabled={zustand === "läuft"}
      onClick={async () => {
        setZustand("läuft");
        const erg = await ausfuehrenLokal(o.action as string, (obj(o.args) ?? {}) as Record<string, unknown>);
        setZustand(erg.ok ? "ok" : "fehler");
        window.setTimeout(() => setZustand(""), 1500);
      }}
    >
      {zustand === "fehler" ? "Nicht geöffnet" : zustand === "ok" ? "Geöffnet" : label}
    </button>
  );
}

/** Undo: a described HTTP call (method + URL), never arbitrary code. */
function UndoKnopf({ undo, onDone }: { undo: unknown; onDone: () => void }) {
  const u = obj(undo);
  const [zustand, setZustand] = useState<"" | "läuft" | "ok" | "fehler">("");
  if (!u || typeof u.url !== "string" || !(u.url as string).startsWith("/api/claraos/")) return null;
  return (
    <button
      type="button"
      className={`${styles.btn} ${styles.btnLeise}`}
      disabled={zustand !== ""}
      onClick={async () => {
        setZustand("läuft");
        try {
          const r = await fetch(u.url as string, {
            method: str(u.method, "POST"),
            credentials: "include",
            ...(obj(u.body) ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(u.body) } : {}),
          });
          setZustand(r.ok ? "ok" : "fehler");
          if (r.ok) onDone();
        } catch {
          setZustand("fehler");
        }
      }}
    >
      {zustand === "ok" ? "Rückgängig gemacht" : zustand === "fehler" ? "Nicht möglich" : zustand === "läuft" ? "…" : "Rückgängig"}
    </button>
  );
}

function AufgabeKarte({ p }: { p: Props }) {
  const [weg, setWeg] = useState(false);
  const titel = str(p.titel);
  if (!titel) return null;
  const faellig = datumKurz(str(p.faellig));
  const prio = typeof p.prioritaet === "number" && p.prioritaet >= 4 ? "Dringend" : "";
  return (
    <div className={`${styles.karte} ${weg ? styles.karteWeg : ""}`} data-kind="aufgabe">
      <div className={styles.kopf}>Aufgabe angelegt · Planner</div>
      <div className={styles.titel}>{titel}</div>
      {(faellig || prio) && <div className={styles.meta}>{[faellig, prio].filter(Boolean).join(" · ")}</div>}
      {weg ? (
        <div className={styles.hinweis}>Rückgängig gemacht — die Aufgabe ist gelöscht.</div>
      ) : (
        <div className={styles.aktionen}>
          <OeffnenKnopf oeffnen={p.oeffnen} />
          <UndoKnopf undo={p.undo} onDone={() => setWeg(true)} />
        </div>
      )}
    </div>
  );
}

type JobStatus = "laeuft" | "fertig" | "fehler";
const JOB_STATUS: Record<JobStatus, { symbol: string; text: string }> = {
  laeuft: { symbol: "⏳", text: "Läuft im Hintergrund" },
  fertig: { symbol: "✅", text: "Fertig" },
  fehler: { symbol: "⚠️", text: "Fehlgeschlagen" },
};
const jobStatus = (v: unknown): JobStatus | null => (v === "laeuft" || v === "fertig" || v === "fehler" ? v : null);

/** Result link: own shell targets open in the shell, https in a new tab. */
function ergebnisOeffnen(url: string) {
  if (oeffneShellZiel(url)) return;
  if (url.startsWith("https://") || (url.startsWith("/") && !url.startsWith("//"))) {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * A long-running job of the agent (job.started / job.done / job.failed).
 * The card only knows what was true when it was written into the chat; while
 * it says "running" it asks GET /api/claraos/jobs/{id} for the current state —
 * so a job that ended while the chat was closed shows its result on reopening.
 */
function JobKarte({ p }: { p: Props }) {
  const jobId = str(p.job_id);
  const [stand, setStand] = useState<{ status: JobStatus | null; titel: string; url: string; fehler: string }>(() => ({
    status: jobStatus(p.status), titel: str(p.titel), url: str(p.ergebnis_url), fehler: str(p.fehler),
  }));
  // A newer event in the same stream (same card id) wins over the local copy.
  useEffect(() => {
    setStand((s) => ({
      status: jobStatus(p.status) ?? s.status,
      titel: str(p.titel) || s.titel,
      url: str(p.ergebnis_url) || s.url,
      fehler: str(p.fehler) || s.fehler,
    }));
  }, [p.status, p.titel, p.ergebnis_url, p.fehler]);

  const laeuft = stand.status === "laeuft" || stand.status === null;
  useEffect(() => {
    if (!jobId || !laeuft) return;
    let aus = false;
    let timer: number | undefined;
    let runde = 0;
    const holen = async () => {
      runde += 1;
      try {
        const r = await fetch(`/api/claraos/jobs/${encodeURIComponent(jobId)}`, { credentials: "include" });
        // Unknown here (not bound yet, other account): keep what the card says.
        if (r.status === 404) return;
        if (r.ok) {
          const j = (await r.json()) as Record<string, unknown>;
          if (aus) return;
          setStand((s) => ({
            status: jobStatus(j.status) ?? s.status,
            titel: str(j.titel) || s.titel,
            url: str(j.ergebnis_url) || s.url,
            fehler: str(j.fehler) || s.fehler,
          }));
          if (jobStatus(j.status) && j.status !== "laeuft") return;
        }
      } catch {
        /* offline — try again later */
      }
      // Every 15 s at first, after ~10 min once a minute.
      if (!aus) timer = window.setTimeout(holen, runde < 40 ? 15_000 : 60_000);
    };
    void holen();
    return () => { aus = true; if (timer) window.clearTimeout(timer); };
  }, [jobId, laeuft]);

  if (!jobId) return null;
  const s = JOB_STATUS[stand.status ?? "laeuft"];
  return (
    <div className={`${styles.karte} ${stand.status === "fehler" ? styles.karteWarn : ""}`} data-kind="job" data-status={stand.status ?? "laeuft"}>
      <div className={styles.zeile}>
        <span className={styles.symbol} aria-hidden="true">{s.symbol}</span>
        <div className={styles.text}>
          <div className={styles.kopf}>Auftrag · {s.text}</div>
          <div className={styles.titel}>{stand.titel || "Auftrag"}</div>
        </div>
      </div>
      {stand.status === "fehler" && stand.fehler && <div className={styles.meta}>{stand.fehler}</div>}
      {laeuft && <div className={styles.hinweis}>Du bekommst eine Benachrichtigung, sobald er fertig ist.</div>}
      {stand.status === "fertig" && stand.url && (
        <div className={styles.aktionen}>
          <button type="button" className={`${styles.btn} ${styles.btnPrimaer}`} onClick={() => ergebnisOeffnen(stand.url)}>
            Ergebnis öffnen
          </button>
        </div>
      )}
    </div>
  );
}

function ErgebnisKarte({ p }: { p: Props }) {
  const titel = str(p.titel);
  if (!titel) return null;
  const typ = str(p.typ, "datei");
  const symbol = typ === "bild" ? "🖼️" : typ === "pdf" ? "📄" : typ === "artefakt" ? "🧩" : typ === "fenster" ? "🪟" : "📎";
  const label = typ === "bild" ? "Bild" : typ === "pdf" ? "PDF" : typ === "artefakt" ? "Artefakt" : typ === "fenster" ? "Fenster" : "Datei";
  return (
    <div className={styles.karte} data-kind="ergebnis">
      <div className={styles.zeile}>
        <span className={styles.symbol} aria-hidden="true">{symbol}</span>
        <div className={styles.text}>
          <div className={styles.kopf}>{label}{p.app_id ? ` · ${str(p.app_id)}` : ""}</div>
          <div className={styles.titel}>{titel}</div>
        </div>
      </div>
      <div className={styles.aktionen}>
        <OeffnenKnopf oeffnen={p.oeffnen} />
        {typeof p.pfad === "string" && p.pfad && (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnLeise}`}
            onClick={() => { navigator.clipboard?.writeText(p.pfad as string).catch(() => undefined); }}
          >
            Pfad kopieren
          </button>
        )}
      </div>
    </div>
  );
}

function ListeKarte({ p }: { p: Props }) {
  const zeilen = Array.isArray(p.zeilen) ? (p.zeilen as Props[]) : [];
  if (!zeilen.length) return null;
  const gesamt = typeof p.gesamt === "number" ? p.gesamt : zeilen.length;
  return (
    <div className={styles.karte} data-kind="liste">
      <div className={styles.kopf}>{str(p.titel, "Liste")}{gesamt > zeilen.length ? ` · ${gesamt}` : ""}</div>
      <ul className={styles.liste}>
        {zeilen.slice(0, 5).map((z, i) => (
          <li key={i} className={z.erledigt ? styles.erledigt : ""}>
            <span className={styles.punkt} aria-hidden="true">{z.erledigt ? "✓" : "○"}</span>
            <span className={styles.listeText}>{str(z.text)}</span>
            {z.meta ? <span className={styles.listeMeta}>{datumKurz(str(z.meta))}</span> : null}
          </li>
        ))}
      </ul>
      <div className={styles.aktionen}>
        <OeffnenKnopf oeffnen={p.oeffnen} label={gesamt > zeilen.length ? `Alle ${gesamt} anzeigen` : "Öffnen"} />
      </div>
    </div>
  );
}

function SchalterKarte({ p }: { p: Props }) {
  const geraet = str(p.geraet);
  if (!geraet) return null;
  const an = str(p.zustand) === "an";
  return (
    <div className={styles.karte} data-kind="schalter">
      <div className={styles.zeile}>
        <span className={styles.symbol} aria-hidden="true">{an ? "💡" : "○"}</span>
        <div className={styles.text}>
          <div className={styles.kopf}>Gerät · {an ? "eingeschaltet" : str(p.zustand) === "aus" ? "ausgeschaltet" : "geschaltet"}</div>
          <div className={styles.titel}>{geraet}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Confirmation card: Once · Always (for this target) · No. Answers via the
 * same approval record as the push notification (respond endpoint with
 * token); "Always" additionally creates a rule that is visible in the
 * settings. Without an answer the request expires server-side = No.
 */
function BestaetigungKarte({ p }: { p: Props }) {
  const id = str(p.confirm_id);
  const token = str(p.token);
  const [status, setStatus] = useState<string>(str(p.status, "offen"));
  const [fehler, setFehler] = useState("");
  if (!id) return null;
  const antworten = async (action: "allow" | "deny", immer = false) => {
    setStatus("läuft");
    try {
      if (immer) {
        await fetch("/api/claraos/confirm/rules", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          // The server takes tool and argument hash from the request itself,
          // so the rule covers exactly what this card showed.
          body: JSON.stringify({ confirm_id: id, tool: str(p.tool), ziel: str(p.ziel) || null }),
        });
      }
      // Authenticated decision path: the user must be the recipient of the
      // request, no token needed. Older cards with a token use the push-link
      // path.
      const r = token
        ? await fetch(`/api/claraos/confirm/respond/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}&action=${action}`, { method: "POST", credentials: "include" })
        : await fetch(`/api/claraos/confirm/${encodeURIComponent(id)}/decide`, {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          });
      if (r.ok) setStatus(action);
      else { setStatus("abgelaufen"); setFehler("Anfrage nicht mehr offen."); }
    } catch (e) {
      setStatus("offen"); setFehler(String(e));
    }
  };
  const ziel = str(p.ziel);
  const gefaehrlich = /outlet|power|delete|rm|send|mail|call|ssh|pay|transfer/i.test(str(p.tool));
  // Same rule as the server (routers/confirm.py): no "always" for shell,
  // container and secret tools; each run is confirmed on its own.
  const ohneImmer = /(^|[_-])(ssh|docker)_|vault/i.test(str(p.tool));
  return (
    <div className={`${styles.karte} ${gefaehrlich ? styles.karteWarn : ""}`} data-kind="bestaetigung">
      <div className={styles.kopf}>{p.auto ? "Per Regel freigegeben" : "Bestätigung nötig"}{gefaehrlich ? " · kritisch" : ""}</div>
      <div className={styles.titel}>{str(p.text, str(p.tool))}</div>
      <div className={styles.meta}>{str(p.tool)}{ziel ? ` · ${ziel}` : ""}</div>
      {status === "offen" || status === "läuft" ? (
        <>
          <div className={styles.aktionen}>
            <button type="button" className={`${styles.btn} ${styles.btnPrimaer}`} disabled={status === "läuft"} onClick={() => antworten("allow")}>Einmal</button>
            {!ohneImmer && (
              <button type="button" className={styles.btn} disabled={status === "läuft"} onClick={() => antworten("allow", true)} title="Regel: genau diese Aktion künftig ohne Rückfrage">
                Immer{ziel ? ` für ${ziel.length > 18 ? ziel.slice(0, 16) + "…" : ziel}` : ""}
              </button>
            )}
            <button type="button" className={`${styles.btn} ${styles.btnWarn}`} disabled={status === "läuft"} onClick={() => antworten("deny")}>Nicht</button>
          </div>
          <div className={styles.hinweis}>Ohne Antwort in {typeof p.timeout_s === "number" ? p.timeout_s : 120} s: nicht ausführen{fehler ? ` · ${fehler}` : ""}</div>
        </>
      ) : (
        <div className={styles.hinweis}>
          {status === "allow" ? "✓ Freigegeben" : status === "deny" ? "⛔ Abgelehnt" : "Abgelaufen"}
        </div>
      )}
    </div>
  );
}

/**
 * Mail draft card: Clara stored a draft (mail__create_draft), the user sends
 * it. "Senden" needs a second tap within a few seconds (sending cannot be
 * undone); the send route only accepts a signed-in person, never a tool.
 */
function MailEntwurfKarte({ p }: { p: Props }) {
  const id = str(p.draft_id);
  const [status, setStatus] = useState<string>(str(p.status, "offen"));
  const [fehler, setFehler] = useState("");
  const [sicher, setSicher] = useState(false);
  if (!id || !/^\d+$/.test(id)) return null;
  const an = str(p.an);
  const betreff = str(p.betreff, "(ohne Betreff)");
  const vorschau = str(p.vorschau);
  const laenge = typeof p.laenge === "number" ? p.laenge : vorschau.length;
  const aufrufen = async (was: "send" | "discard") => {
    setStatus("läuft"); setFehler("");
    try {
      const r = await fetch(`/api/claraos/mail/drafts/${encodeURIComponent(id)}/${was}`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (r.ok) { setStatus(was === "send" ? "gesendet" : "verworfen"); return; }
      let detail = `Fehler ${r.status}`;
      try { const j = await r.json(); if (typeof j?.detail === "string") detail = j.detail; } catch { /* no body */ }
      setStatus("offen"); setFehler(detail);
    } catch (e) {
      setStatus("offen"); setFehler(String(e));
    }
  };
  const senden = () => {
    if (!sicher) { setSicher(true); window.setTimeout(() => setSicher(false), 5000); return; }
    setSicher(false);
    void aufrufen("send");
  };
  const inPost = async () => {
    await ausfuehrenLokal("open_window", { app_id: "post" });
    dispatchWhenReady("post", "open_draft", { subject: str(p.betreff) });
  };
  const offen = status === "offen" || status === "läuft";
  return (
    <div className={`${styles.karte} ${status === "verworfen" ? styles.karteWeg : ""}`} data-kind="mail_entwurf">
      <div className={styles.kopf}>E-Mail-Entwurf · nicht gesendet</div>
      <div className={styles.titel}>{betreff}</div>
      <div className={styles.meta}>An: {an || "– noch kein Empfänger –"}{str(p.cc) ? ` · Cc: ${str(p.cc)}` : ""}</div>
      {vorschau && (
        <div className={styles.mailVorschau}>
          {vorschau.length > 280 ? `${vorschau.slice(0, 278)}…` : vorschau}
          {laenge > 280 && <span className={styles.hinweis}> ({laenge} Zeichen)</span>}
        </div>
      )}
      {offen ? (
        <>
          <div className={styles.aktionen}>
            <button type="button" className={`${styles.btn} ${styles.btnPrimaer}`} disabled={status === "läuft" || !an}
                    onClick={senden} title={an ? "Entwurf jetzt senden" : "Erst in Post einen Empfänger eintragen"}>
              {status === "läuft" ? "…" : sicher ? `Wirklich an ${an.length > 22 ? an.slice(0, 20) + "…" : an}?` : "Senden"}
            </button>
            <button type="button" className={styles.btn} disabled={status === "läuft"} onClick={() => void inPost()}>In Post öffnen</button>
            <button type="button" className={`${styles.btn} ${styles.btnLeise}`} disabled={status === "läuft"} onClick={() => void aufrufen("discard")}>Verwerfen</button>
          </div>
          {fehler && <div className={styles.hinweis}>{fehler}</div>}
        </>
      ) : (
        <div className={styles.hinweis}>{status === "gesendet" ? "✓ Gesendet" : "Entwurf verworfen"}</div>
      )}
    </div>
  );
}

/* ── Layouts from the catalog ───────────────────────────────────────────────
   Declarative (JSON), validated: every card checks its own required fields
   and returns null if they are missing. A layout skips invalid children,
   never renders them "somehow". Depth ≤ 2. */

function TextKarte({ p }: { p: Props }) {
  const md = str(p.md ?? p.text);
  if (!md) return null;
  return <div className={styles.textBlock}><Markdown text={md} /></div>;
}

/** Small chart, one series, one color (accent): bars or line.
 *  Text in text tokens, values switchable to a table (accessibility). */
function DiagrammKarte({ p }: { p: Props }) {
  const roh = Array.isArray(p.werte) ? (p.werte as Props[]) : [];
  const werte = roh
    .filter((w) => w && typeof w === "object" && typeof (w as Props).wert === "number" && Number.isFinite((w as Props).wert as number))
    .slice(0, 12)
    .map((w) => ({ label: str(w.label), wert: w.wert as number }));
  const [tabelle, setTabelle] = useState(false);
  if (werte.length < 2) return null;
  const typ = str(p.typ) === "linie" ? "linie" : "balken";
  const einheit = str(p.einheit);
  const W = 320, H = 120, padL = 8, padR = 8, padT = 18, padB = 22;
  const max = Math.max(...werte.map((w) => w.wert), 0);
  const min = Math.min(...werte.map((w) => w.wert), 0);
  const span = max - min || 1;
  const innenW = W - padL - padR, innenH = H - padT - padB;
  const x = (i: number) => padL + (innenW / werte.length) * i;
  const y = (v: number) => padT + innenH - ((v - min) / span) * innenH;
  const bw = Math.max(6, (innenW / werte.length) - 6);
  const nullY = y(0);
  const fmt = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}${einheit ? ` ${einheit}` : ""}`;
  const maxIdx = werte.reduce((m, w, i) => (w.wert > werte[m].wert ? i : m), 0);
  return (
    <div className={styles.karte} data-kind="diagramm">
      {str(p.titel) && <div className={styles.kopf}>{str(p.titel)}</div>}
      {tabelle ? (
        <table className={styles.werteTabelle}>
          <tbody>{werte.map((w, i) => <tr key={i}><td>{w.label}</td><td>{fmt(w.wert)}</td></tr>)}</tbody>
        </table>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label={`${str(p.titel, "Diagramm")}: ${werte.map((w) => `${w.label} ${fmt(w.wert)}`).join(", ")}`}>
          <line x1={padL} x2={W - padR} y1={nullY} y2={nullY} className={styles.achse} />
          {typ === "balken" ? werte.map((w, i) => {
            const top = Math.min(y(w.wert), nullY), h = Math.max(2, Math.abs(y(w.wert) - nullY));
            return (
              <g key={i}>
                <rect x={x(i) + 3} y={top} width={bw} height={h} rx={3} className={styles.balken}>
                  <title>{w.label}: {fmt(w.wert)}</title>
                </rect>
                {i === maxIdx && <text x={x(i) + 3 + bw / 2} y={top - 4} textAnchor="middle" className={styles.wertText}>{fmt(w.wert)}</text>}
                <text x={x(i) + 3 + bw / 2} y={H - 6} textAnchor="middle" className={styles.achsenText}>{w.label.slice(0, 6)}</text>
              </g>
            );
          }) : (
            <>
              <polyline
                points={werte.map((w, i) => `${x(i) + bw / 2 + 3},${y(w.wert)}`).join(" ")}
                className={styles.linie}
              />
              {werte.map((w, i) => (
                <g key={i}>
                  <circle cx={x(i) + bw / 2 + 3} cy={y(w.wert)} r={i === werte.length - 1 ? 5 : 3.5} className={styles.punktMark}>
                    <title>{w.label}: {fmt(w.wert)}</title>
                  </circle>
                  <text x={x(i) + bw / 2 + 3} y={H - 6} textAnchor="middle" className={styles.achsenText}>{w.label.slice(0, 6)}</text>
                </g>
              ))}
              <text x={x(werte.length - 1) + bw / 2 + 3} y={y(werte[werte.length - 1].wert) - 9} textAnchor="end" className={styles.wertText}>{fmt(werte[werte.length - 1].wert)}</text>
            </>
          )}
        </svg>
      )}
      <div className={styles.aktionen}>
        <button type="button" className={`${styles.btn} ${styles.btnLeise}`} onClick={() => setTabelle((t) => !t)}>
          {tabelle ? "Diagramm" : "Werte anzeigen"}
        </button>
      </div>
    </div>
  );
}

function GalerieKarte({ p }: { p: Props }) {
  const bilder = (Array.isArray(p.bilder) ? (p.bilder as Props[]) : [])
    .filter((b) => b && typeof b === "object" && (typeof b.pfad === "string" || typeof b.url === "string"))
    .slice(0, 8);
  if (!bilder.length) return null;
  return (
    <div className={styles.karte} data-kind="galerie">
      {str(p.titel) && <div className={styles.kopf}>{str(p.titel)} · {bilder.length}</div>}
      <div className={styles.galerie}>
        {bilder.map((b, i) => {
          const pfad = str(b.pfad); const url = str(b.url);
          const name = str(b.titel) || (pfad ? pfad.split("/").pop() : "Bild");
          return (
            <button
              key={i}
              type="button"
              className={styles.galerieKachel}
              title={name}
              onClick={() => {
                if (pfad) void ausfuehrenLokal("open_in_viewer", { path: pfad, source: str(b.source, "nextcloud") });
                else if (url) window.open(url, "_blank", "noopener");
              }}
            >
              {url && !pfad ? <img src={url} alt={name || ""} /> : <span aria-hidden="true">🖼️</span>}
              <span className={styles.galerieName}>{name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const FELD_TYPEN = new Set(["text", "zahl", "datum", "auswahl", "ja_nein"]);
function FormularKarte({ p }: { p: Props }) {
  const felder = (Array.isArray(p.felder) ? (p.felder as Props[]) : [])
    .filter((f) => f && typeof f === "object" && typeof f.name === "string" && (f.name as string).length && FELD_TYPEN.has(str(f.typ, "text")))
    .slice(0, 6);
  const frageId = str(p.frage_id);
  const [werte, setWerte] = useState<Record<string, string>>(() =>
    Object.fromEntries(felder.map((f) => [f.name as string, str(f.wert)])));
  const [status, setStatus] = useState<"" | "läuft" | "ok" | "fehler">("");
  if (!felder.length || !frageId) return null;
  const absenden = async () => {
    setStatus("läuft");
    try {
      const r = await fetch("/api/claraos/chat/v2/question-response", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_id: frageId, answer: JSON.stringify(werte) }),
      });
      setStatus(r.ok ? "ok" : "fehler");
    } catch { setStatus("fehler"); }
  };
  return (
    <form className={styles.karte} data-kind="formular" onSubmit={(e) => { e.preventDefault(); void absenden(); }}>
      {str(p.titel) && <div className={styles.kopf}>{str(p.titel)}</div>}
      {felder.map((f) => {
        const name = f.name as string; const typ = str(f.typ, "text"); const label = str(f.label, name);
        const wert = werte[name] ?? "";
        const setze = (v: string) => setWerte((w) => ({ ...w, [name]: v }));
        return (
          <label key={name} className={styles.feld}>
            <span className={styles.feldLabel}>{label}</span>
            {typ === "auswahl" ? (
              <select className={styles.eingabe} value={wert} onChange={(e) => setze(e.target.value)} disabled={status === "ok"}>
                <option value="">Bitte wählen</option>
                {(Array.isArray(f.optionen) ? (f.optionen as unknown[]) : []).slice(0, 12).map((o, i) => (
                  <option key={i} value={String(o)}>{String(o)}</option>
                ))}
              </select>
            ) : typ === "ja_nein" ? (
              <span className={styles.jaNein}>
                {["Ja", "Nein"].map((o) => (
                  <button key={o} type="button" className={`${styles.btn} ${wert === o ? styles.btnPrimaer : ""}`} onClick={() => setze(o)} disabled={status === "ok"}>{o}</button>
                ))}
              </span>
            ) : (
              <input
                className={styles.eingabe}
                type={typ === "zahl" ? "number" : typ === "datum" ? "date" : "text"}
                value={wert}
                onChange={(e) => setze(e.target.value)}
                disabled={status === "ok"}
              />
            )}
          </label>
        );
      })}
      <div className={styles.aktionen}>
        {status === "ok" ? (
          <span className={styles.hinweis}>✓ Gesendet</span>
        ) : (
          <button type="submit" className={`${styles.btn} ${styles.btnPrimaer}`} disabled={status === "läuft"}>{str(p.senden, "Absenden")}</button>
        )}
        {status === "fehler" && <span className={styles.hinweis}>Senden fehlgeschlagen.</span>}
      </div>
    </form>
  );
}

function LayoutKarte({ p, tiefe = 0 }: { p: Props; tiefe?: number }) {
  const kinder = (Array.isArray(p.children) ? (p.children as unknown[]) : [])
    .filter((b): b is ChatBlock => !!b && typeof b === "object" && typeof (b as ChatBlock).kind === "string" && !!(b as ChatBlock).props && typeof (b as ChatBlock).props === "object")
    .filter((b) => b.kind !== "layout" || tiefe < 1)
    .filter((b) => KATALOG[b.kind])
    .slice(0, 12);
  if (!kinder.length) return null;
  const spalten = p.spalten === 2 ? 2 : 1;
  return (
    <section className={styles.layout} data-kind="layout" data-spalten={spalten}>
      {str(p.titel) && <h4 className={styles.layoutTitel}>{str(p.titel)}</h4>}
      <div className={spalten === 2 ? styles.layoutRaster : styles.layoutStapel}>
        {kinder.map((b, i) => {
          const K = KATALOG[b.kind];
          return b.kind === "layout"
            ? <LayoutKarte key={b.id || i} p={b.props} tiefe={tiefe + 1} />
            : <K key={b.id || i} p={b.props} />;
        })}
      </div>
    </section>
  );
}

const KATALOG: Record<string, (props: { p: Props }) => JSX.Element | null> = {
  layout: (props) => <LayoutKarte p={props.p} />,
  text: TextKarte,
  diagramm: DiagrammKarte,
  galerie: GalerieKarte,
  formular: FormularKarte,
  aufgabe: AufgabeKarte,
  ergebnis: ErgebnisKarte,
  liste: ListeKarte,
  schalter: SchalterKarte,
  bestaetigung: BestaetigungKarte,
  mail_entwurf: MailEntwurfKarte,
  job: JobKarte,
};

export function BlockRenderer({ blocks }: { blocks: ChatBlock[] }) {
  const sichtbar = blocks.filter((b) => b && typeof b.kind === "string" && KATALOG[b.kind] && b.props && typeof b.props === "object");
  if (!sichtbar.length) return null;
  return (
    <div className={styles.stapel}>
      {sichtbar.map((b) => {
        const K = KATALOG[b.kind];
        return <K key={b.id} p={b.props} />;
      })}
    </div>
  );
}
