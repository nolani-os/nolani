/**
 * Previous versions.
 *
 * Dolphin has no version counterpart (only VCS status overlays); the model is
 * the Nextcloud sidebar "Versions": list, restore, download.
 * Nextcloud sources only; the dialog scaffold shares its look with the
 * share dialog.
 */
import { useCallback, useEffect, useState } from "react";
import { useFileStore } from "@claraos/core";
import styles from "./ShareDialog.module.css";

interface Version {
  id: string;
  modified: string;
  size: number | null;
}

interface Props {
  path: string;
  name: string;
  onClose: () => void;
  confirmDlg: (message: string, confirmLabel?: string) => Promise<boolean>;
}

function fmtSize(size: number | null): string {
  if (size == null) return "";
  if (size > 1e6) return `${(size / 1e6).toFixed(1)} MB`;
  if (size > 1e3) return `${(size / 1e3).toFixed(1)} KB`;
  return `${size} B`;
}

export function VersionsDialog({ path, name, onClose, confirmDlg }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/claraos/files/v2/versions?source=nextcloud&path=${encodeURIComponent(path)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail ?? `HTTP ${r.status}`);
      setVersions(d.versions ?? []);
    } catch (e) {
      setError(String(e));
      setVersions([]);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (v: Version) => {
    const when = v.modified || v.id;
    if (!(await confirmDlg(
      `„${name}“ auf den Stand vom ${when} zurücksetzen? Der aktuelle Inhalt wird selbst zur Version.`,
      "Wiederherstellen",
    ))) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/claraos/files/v2/versions/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, version: v.id }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.detail ?? `HTTP ${r.status}`);
      await load();
      // Refresh the folder view (size/modification date of the file)
      useFileStore.getState().loadTree();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const download = (v: Version) => {
    const a = document.createElement("a");
    a.href = `/api/claraos/files/v2/versions/download?path=${encodeURIComponent(path)}&version=${encodeURIComponent(v.id)}`;
    a.download = `${name}.${v.id}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Frühere Versionen von „${name}“`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span>Frühere Versionen — „{name}“</span>
          <button onClick={onClose} aria-label="Schließen">×</button>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.list}>
          {versions === null && <p className={styles.hint}>Versionen werden geladen…</p>}
          {versions !== null && versions.length === 0 && (
            <p className={styles.hint}>Keine früheren Versionen vorhanden.</p>
          )}
          {(versions ?? []).map((v) => (
            <div key={v.id} className={styles.share}>
              <span>
                {v.modified || v.id}
                {v.size != null && <span className={styles.hint}> · {fmtSize(v.size)}</span>}
              </span>
              <button disabled={busy} onClick={() => download(v)}>Laden</button>
              <button disabled={busy} onClick={() => void restore(v)}>Wiederherstellen</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
