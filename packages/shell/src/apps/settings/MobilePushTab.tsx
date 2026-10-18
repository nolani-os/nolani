import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useUIStore, appUrl } from "@claraos/core";
import { INSTALL_TEXTS } from "../../installTexts";
import styles from "./MobilePushTab.module.css";

// Fixed app endpoint (reverse-proxy passthrough without auth override, per-user token).
// NOT the legacy ntfy.* host — that route overwrites the Authorization header.
const PUSH_SERVER = appUrl("ntfy");

interface TokenResp {
  ntfy_username: string;
  token: string;
  // Login for the ntfy Android app: the app cannot use access tokens and
  // requires a username — user:token returns 401, hence a real password.
  app_password: string;
}

function copy(text: string, label: string) {
  const done = () =>
    useUIStore.getState().addNotification({ title: "Kopiert", body: label, icon: "📋" });
  navigator.clipboard?.writeText(text).then(done).catch(() => {
    // Fallback for contexts without the Clipboard API
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
      useUIStore.getState().addNotification({
        title: "Kopieren nicht möglich",
        body: `${label} bitte von Hand markieren und kopieren.`,
        icon: "⚠️",
      });
    }
    document.body.removeChild(ta);
  });
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.fieldRow}>
        <code className={`${styles.fieldValue} ${mono ? styles.mono : ""}`}>{value}</code>
        <button className={styles.copyBtn} onClick={() => copy(value, label)} title="Kopieren">📋</button>
      </div>
    </div>
  );
}

export function MobilePushTab() {
  const [data, setData] = useState<TokenResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reveal, setReveal] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/claraos/ntfy/token", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as TokenResp;
      })
      .then((d) => setData(d))
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const masked = data ? `${data.app_password.slice(0, 4)}…${data.app_password.slice(-2)}` : "";

  return (
    <div className={styles.wrap} data-tour="settings-push">
      <div className={styles.hero}>
        <span className={styles.heroIcon}>📲</span>
        <h1 className={styles.title}>Benachrichtigungen aufs Handy</h1>
        <p className={styles.tagline}>
          Damit Einladungen (z.&nbsp;B. zu Spielrunden) und Hinweise auch dann ankommen,
          wenn ClaraOS gerade nicht geöffnet ist — als echte Push-Nachricht über die
          <strong> ntfy</strong>-App.
          {INSTALL_TEXTS.pushNetworkHint && <> <em>{INSTALL_TEXTS.pushNetworkHint}</em></>}
        </p>
      </div>

      {loading && <div className={styles.muted}>Lade deinen Zugang …</div>}
      {error && (
        <div className={styles.error}>
          Konnte den Push-Zugang nicht laden ({error}).
          <button className={styles.linkBtn} onClick={load}>Erneut versuchen</button>
        </div>
      )}

      {data && (
        <>
          <div className={styles.cols}>
            <div className={styles.qrCard}>
              <QRCodeSVG value={data.app_password} size={168} level="M" includeMargin
                bgColor="#ffffff" fgColor="#0b1020" />
              <span className={styles.qrHint}>App-Passwort als QR — zum Abscannen &amp; Einfügen</span>
            </div>
            <div className={styles.fields}>
              <Field label="Server" value={PUSH_SERVER} mono />
              <Field label="Thema (Topic) = Benutzername" value={data.ntfy_username} mono />
              <div className={styles.field}>
                <span className={styles.fieldLabel}>App-Passwort</span>
                <div className={styles.fieldRow}>
                  <code className={`${styles.fieldValue} ${styles.mono}`}>
                    {reveal ? data.app_password : masked}
                  </code>
                  <button className={styles.copyBtn} onClick={() => setReveal((v) => !v)}
                    title={reveal ? "Verbergen" : "Anzeigen"}>{reveal ? "🙈" : "👁️"}</button>
                  <button className={styles.copyBtn} onClick={() => copy(data.app_password, "App-Passwort")}
                    title="Kopieren">📋</button>
                </div>
                <span className={styles.tokenNote}>
                  Persönlich &amp; geheim halten. Wird automatisch verwaltet —
                  kein extra ClaraOS-Passwort nötig, nichts zu merken.
                </span>
              </div>
            </div>
          </div>

          <ol className={styles.steps}>
            <li><strong>ntfy</strong>-App aus dem Play Store installieren.</li>
            <li>In der App: <strong>⋮ → Benutzer verwalten → Benutzer hinzufügen</strong> →
              Server <code>{PUSH_SERVER}</code>, Benutzername <code>{data.ntfy_username}</code>,
              als Passwort das <strong>App-Passwort</strong> oben einfügen.</li>
            <li><strong>+ → Thema abonnieren</strong> → Thema <code>{data.ntfy_username}</code>,
              Server <code>{PUSH_SERVER}</code>.</li>
            <li>Fertig — ein Tipp auf eine Nachricht öffnet ClaraOS.</li>
          </ol>

          <button className={styles.linkBtn} onClick={load}>Token neu laden</button>
        </>
      )}
    </div>
  );
}
