/**
 * Share dialog.
 *
 * The recipient side already existed; links just could not be created
 * anywhere. Dolphin cannot do this at all; here a web file manager plays its
 * home advantage.
 *
 * Deliberately simple: one link, optionally with a password and expiry date,
 * plus the list of existing links to revoke. Everything else the Nextcloud
 * UI does better.
 */
import { useCallback, useEffect, useState } from "react";
import { useIstZelle } from "@claraos/core";
import { INSTALL_TEXTS } from "../../installTexts";
import styles from "./ShareDialog.module.css";

interface Share {
  id: string;
  url: string;
  hasPassword: boolean;
  expiration: string;
  permissions?: number;
}

interface Props {
  path: string;
  name: string;
  onClose: () => void;
}

export function ShareDialog({ path, name, onClose }: Props) {
  const istZelle = useIstZelle();
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [password, setPassword] = useState("");
  const [expires, setExpires] = useState("");
  const [writable, setWritable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/claraos/files/v2/shares?path=${encodeURIComponent(path)}`);
      const d = await r.json();
      setShares(r.ok ? (d.shares ?? []) : []);
      if (!r.ok) setError(d.detail ?? "Freigaben konnten nicht geladen werden.");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/claraos/files/v2/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "nextcloud",
          path,
          password,
          expires,
          // 1 = read only, 15 = also upload/modify
          permissions: writable ? 15 : 1,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.detail || "Link konnte nicht erstellt werden.");
        return;
      }
      setPassword("");
      setExpires("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/claraos/files/v2/share/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("Kopieren ging nicht — Link bitte von Hand markieren.");
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`„${name}“ teilen`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span>„{name}“ teilen</span>
          <button onClick={onClose} aria-label="Schließen">×</button>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.form}>
          <label>
            Passwort (optional)
            <input
              type="text"
              value={password}
              placeholder="ohne Passwort"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            Läuft ab am (optional)
            <input
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={writable}
              onChange={(e) => setWritable(e.target.checked)}
            />
            Hochladen und Ändern erlauben
          </label>
          <button className={styles.primary} disabled={busy} onClick={() => void create()}>
            Link erstellen
          </button>
        </div>

        <div className={styles.notice}>
          Der Empfänger braucht kein Konto — der Link fragt höchstens das hier
          gesetzte Passwort ab.{" "}
          {istZelle
            ? "Der Link ist aus dem Internet erreichbar — ein Passwort ist deshalb sinnvoll."
            : INSTALL_TEXTS.shareLinkReach}
        </div>

        <div className={styles.list}>
          {loading && <p className={styles.hint}>Freigaben werden geladen…</p>}
          {!loading && shares.length === 0 && (
            <p className={styles.hint}>Noch kein Link vorhanden.</p>
          )}
          {shares.map((s) => (
            <div key={s.id} className={styles.share}>
              <input readOnly value={s.url} onFocus={(e) => e.currentTarget.select()} />
              <button onClick={() => void copy(s.url)}>
                {copied === s.url ? "Kopiert ✓" : "Kopieren"}
              </button>
              <button
                className={styles.danger}
                disabled={busy}
                onClick={() => void remove(s.id)}
                title="Link zurückziehen"
              >
                Entfernen
              </button>
              <div className={styles.meta}>
                {s.hasPassword ? "🔒 mit Passwort" : "ohne Passwort"}
                {s.expiration ? ` · bis ${s.expiration}` : ""}
                {s.permissions && s.permissions > 1 ? " · Hochladen erlaubt" : ""}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
