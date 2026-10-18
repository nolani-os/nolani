/** Version history of an object.
 * Full snapshots are stored; the diff is computed when viewed
 * (services/kb_diff.py), so the presentation can change at any time without
 * touching old data. */
import { useCallback, useEffect, useState } from "react";
import styles from "./IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { ideasApi } from "./api";
import type { KbDiffOp, KbHistoryEntry } from "./types";

interface Props {
  objectId: string;
  isOwner: boolean;
  onRestored: () => void;
  onClose: () => void;
}

export function HistoryPanel({ objectId, isOwner, onRestored, onClose }: Props) {
  const [entries, setEntries] = useState<KbHistoryEntry[]>([]);
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [ops, setOps] = useState<KbDiffOp[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    ideasApi.listHistory(objectId).then(setEntries).catch(() => setEntries([]));
  }, [objectId]);

  useEffect(() => { load(); }, [load]);

  const showDiff = async (version: number) => {
    setOpenVersion(version);
    setOps([]);
    try {
      const d = await ideasApi.diffHistory(objectId, version);
      setOps(d.ops);
    } catch {
      setOps([]);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.modal} ${styles.historyModal}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3>🕓 Versionen</h3>
          <button className={styles.iconBtn} onClick={onClose} title="Schließen"><Icon name="close" size={14} title="Schließen" /></button>
        </div>

        <div className={styles.historyBody}>
          <ul className={styles.historyList}>
            {entries.map((h) => (
              <li key={h.version}
                  className={openVersion === h.version ? styles.historyItemActive : ""}>
                <button className={styles.historyItem} onClick={() => void showDiff(h.version)}>
                  <b>v{h.version}</b>
                  {h.name && <span className={styles.versionName}>{h.name}</span>}
                  <span className={styles.metaHint}>
                    {h.actor === "clara" ? "🤖 Clara" : h.actor} ·{" "}
                    {new Date(h.created_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </button>
                {isOwner && (
                  <div className={styles.historyActions}>
                    <button className={styles.linkBtn}
                            onClick={async () => {
                              const name = window.prompt("Name für diese Version?", h.name ?? "");
                              if (name === null) return;
                              await ideasApi.renameHistory(objectId, h.version, name);
                              load();
                            }}>Benennen</button>
                    <button className={styles.linkBtn}
                            disabled={busy}
                            onClick={async () => {
                              if (!window.confirm(`Version ${h.version} wiederherstellen? Der aktuelle Stand wird vorher als neue Version gesichert.`)) return;
                              setBusy(true);
                              try {
                                await ideasApi.restoreHistory(objectId, h.version);
                                onRestored();
                                load();
                              } finally {
                                setBusy(false);
                              }
                            }}>Wiederherstellen</button>
                  </div>
                )}
              </li>
            ))}
            {entries.length === 0 && <li className={styles.metaHint}>Noch keine Versionen.</li>}
          </ul>

          <div className={styles.diffPane}>
            {openVersion === null ? (
              <div className={styles.metaHint}>Version links wählen, um die Änderungen zum aktuellen Stand zu sehen.</div>
            ) : ops.length === 0 ? (
              <div className={styles.metaHint}>Keine Unterschiede zum aktuellen Stand.</div>
            ) : (
              <pre className={styles.diffText}>
                {ops.map((op, i) => (
                  <span key={i}
                        className={op.type === "insert" ? styles.diffIns
                          : op.type === "delete" ? styles.diffDel : undefined}>
                    {op.text}
                  </span>
                ))}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
