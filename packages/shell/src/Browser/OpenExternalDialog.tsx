/**
 * Decision when opening a link from an email.
 *
 * Why this dialog exists: a link in an email is untrusted by definition. If it
 * opened automatically in the Clara Browser — where shopping and shipping
 * accounts stay signed in permanently — ClaraOS would be a phishing amplifier.
 * So the convenient path is also the safe one: **"Open privately" is the
 * default** (a separate session without logins), the signed-in browser is the
 * deliberate exception.
 *
 * So that the dialog does not train users to click it away, ClaraOS remembers
 * the "trusted" decision per sender — the second link from the same shipping
 * company no longer shows it.
 */
import { useCallback, useEffect, useState } from "react";
import { useSettingsStore, useWindowsStore, windowCloseGuards, getBrand } from "@claraos/core";
import styles from "./OpenExternalDialog.module.css";

interface Anfrage {
  url: string;
  from: string;
}

const MODUL = "browser";
const SCHLUESSEL = "trustedSenders";

function vertraute(): string[] {
  const v = useSettingsStore.getState().values[MODUL]?.[SCHLUESSEL];
  return Array.isArray(v) ? (v as string[]).map(String) : [];
}

/** Can also be called from apps (the knowledge app opens links in the signed-in
 *  Clara Browser without asking — they are the user's own notes, not a foreign email). */
export async function oeffneImClaraBrowser(url: string, mode: "private" | "session", from: string) {
  return oeffne(url, mode, from);
}

async function oeffne(url: string, mode: "private" | "session", from: string) {
  const res = await fetch("/api/claraos/apps/selkies/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode, source: from ? (from.includes("@") ? `mail:${from}` : `app:${from}`) : "mail" }),
  });
  const data = await res.json().catch(() => ({}));
  // Show the window in the shell so the stream becomes visible. The private
  // title is the marker — in full screen you otherwise cannot tell from the
  // stream that nothing is stored here.
  // Warning: ONE browser window, not one per link. The stream is the same
  // session — a second window connected to the same stream, showed white and
  // took down the running session. If the window already exists, it is only
  // brought to the front; the new tab is already open there.
  const store = useWindowsStore.getState();
  const vorhanden = Object.values(store.windows).find((w) => w.appId === "selkies-browser");
  let winId: string;
  if (vorhanden) {
    winId = vorhanden.id;
    store.focusWindow(winId);
  } else {
    winId = store.openWindow("selkies-browser", {
      title: mode === "private" ? `${getBrand().assistant} Browser — Privat 🕶️` : `${getBrand().assistant} Browser`,
      width: 1400,
      height: 900,
    });
  }

  // Requirement: the private session is forgotten when the window is CLOSED,
  // not only after a timeout. The existing close guard is exactly the right
  // hook for that.
  if (mode === "private" && data?.contextId && winId) {
    windowCloseGuards.set(winId, async () => {
      try {
        await fetch("/api/claraos/apps/selkies/close-private", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contextId: data.contextId }),
        });
      } catch (err) {
        // Do not block closing — the server-side cleanup kicks in otherwise
        console.warn("[claraos] private Sitzung verwerfen fehlgeschlagen", err);
      }
      windowCloseGuards.delete(winId);
      return true;
    });
  }
  return data;
}

export function OpenExternalDialog() {
  const [anfrage, setAnfrage] = useState<Anfrage | null>(null);
  const [merken, setMerken] = useState(true);
  const [laeuft, setLaeuft] = useState(false);

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as Anfrage | undefined;
      if (!detail?.url) return;
      // Known sender → into the signed-in browser without asking
      if (detail.from && vertraute().includes(detail.from.toLowerCase())) {
        void oeffne(detail.url, "session", detail.from);
        return;
      }
      setAnfrage({ url: detail.url, from: detail.from || "" });
      setMerken(true);
    };
    window.addEventListener("claraos:open-external", handler);
    return () => window.removeEventListener("claraos:open-external", handler);
  }, []);

  const schliessen = useCallback(() => {
    setAnfrage(null);
    setLaeuft(false);
  }, []);

  const waehle = useCallback(
    async (mode: "private" | "session") => {
      if (!anfrage) return;
      setLaeuft(true);
      try {
        if (mode === "session" && merken && anfrage.from) {
          const liste = Array.from(new Set([...vertraute(), anfrage.from.toLowerCase()]));
          const store = useSettingsStore.getState();
          store.setDraft(MODUL, SCHLUESSEL, liste);
          await store.apply(MODUL);   // only apply writes on the server
        }
        await oeffne(anfrage.url, mode, anfrage.from);
      } finally {
        schliessen();
      }
    },
    [anfrage, merken, schliessen],
  );

  if (!anfrage) return null;

  // The dialog can come from emails or from apps such as the knowledge app.
  // An origin name without @ is an app, not a sender address — and is labeled as such.
  const istMail = anfrage.from.includes("@");
  const appName = ({ wissen: "Wissen" } as Record<string, string>)[anfrage.from.toLowerCase()] ?? anfrage.from;
  let host = anfrage.url;
  try {
    host = new URL(anfrage.url).hostname;
  } catch { /* display fallback: full URL */ }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" data-testid="open-external">
      <div className={styles.karte}>
        <h2 className={styles.titel}>Link öffnen</h2>
        <p className={styles.frage}>
          Dieser Link führt zu <strong>{host}</strong>
          {anfrage.from && (istMail
            ? <> — aus einer Mail von <strong>{anfrage.from}</strong></>
            : <> — aus der App <strong>{appName}</strong></>)}.
        </p>
        {/* Full address in plain text: this is exactly where phishing addresses stand out. */}
        <code className={styles.url} title={anfrage.url}>{anfrage.url}</code>

        <div className={styles.aktionen}>
          <button
            className={styles.primaer}
            disabled={laeuft}
            data-testid="open-private"
            onClick={() => void waehle("private")}
          >
            🕶️ Privat öffnen
          </button>
          <button
            className={styles.sekundaer}
            disabled={laeuft}
            data-testid="open-session"
            onClick={() => void waehle("session")}
          >
            In meinem angemeldeten Browser
          </button>
        </div>

        <label className={styles.merken}>
          <input
            type="checkbox"
            checked={merken}
            disabled={!anfrage.from || laeuft}
            onChange={(e) => setMerken(e.target.checked)}
          />
          <span>
            {anfrage.from
              ? (istMail
                  ? <>Absender <strong>{anfrage.from}</strong> künftig vertrauen</>
                  : <>Links aus <strong>{appName}</strong> künftig vertrauen</>)
              : <>Absender nicht erkennbar — keine Ausnahme merkbar</>}
          </span>
        </label>

        <p className={styles.hinweis}>
          Privat heißt: eigene Sitzung ohne deine Anmeldungen und ohne Zugriff auf
          den Passwort-Tresor. Sie wird beim Schließen des Fensters vergessen.
        </p>

        <button className={styles.abbruch} onClick={schliessen} disabled={laeuft}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}
