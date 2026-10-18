import { useCallback, useEffect, useState } from "react";
import { useClipboardStore, useUIStore } from "@claraos/core";
import styles from "./ClipboardOverlay.module.css";

/**
 * Win+V clipboard-history overlay. Shows the most recent ~20 entries from
 * useClipboardStore. Click an entry to write it back to the system
 * clipboard. The store is fed by:
 *   - the screenshot tool
 *   - the App-Center "Copy" buttons (existing)
 *   - paste events captured globally below
 */
export function ClipboardOverlay() {
  const [open, setOpen] = useState(false);
  const entries = useClipboardStore((s) => s.entries);
  const remove = useClipboardStore((s) => s.remove);
  const clear = useClipboardStore((s) => s.clear);

  // Toggle on global event
  useEffect(() => {
    const handler = () => setOpen((p) => !p);
    window.addEventListener("claraos-toggle-clipboard", handler);
    return () => window.removeEventListener("claraos-toggle-clipboard", handler);
  }, []);

  // Esc closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Auto-capture paste events from anywhere in the document. Browser only
  // delivers the clipboard data on paste, so we tap it opportunistically.
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text) useClipboardStore.getState().add(text, "paste");
    };
    document.addEventListener("paste", handler, { capture: true });
    return () => document.removeEventListener("paste", handler, { capture: true });
  }, []);

  const handleClick = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      // Bump entry to top — done implicitly by add()
      useClipboardStore.getState().add(text, "history");
    } catch {
      useUIStore.getState().addNotification({
        title: "Nicht in die Zwischenablage gelegt",
        body: "Der Browser hat den Zugriff abgelehnt.",
        icon: "⚠️",
      });
    }
    setOpen(false);
  }, []);

  if (!open) return null;

  return (
    <>
      <div className={styles.backdrop} onClick={() => setOpen(false)} />
      <div className={`aeroWidget ${styles.panel}`} role="dialog" aria-label="Clipboard history">
        <div className={styles.header}>
          <span className={styles.title}>Zwischenablage</span>
          <span className={styles.count}>{entries.length}</span>
          {entries.length > 0 && (
            <button className={styles.clearBtn} onClick={clear}>Alle löschen</button>
          )}
        </div>
        <div className={styles.list}>
          {entries.length === 0 && (
            <div className={styles.empty}>
              Noch keine Einträge. Was du kopierst, landet hier.
            </div>
          )}
          {entries.map((e) => (
            <div key={e.id} className={styles.entry}>
              <button
                className={styles.entryBody}
                onClick={() => handleClick(e.text)}
                title="Klick → in Zwischenablage zurücklegen"
              >
                <span className={styles.entryText}>{e.text}</span>
                <span className={styles.entryMeta}>
                  {e.source ? `${e.source} · ` : ""}
                  {new Date(e.timestamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </button>
              <button
                className={styles.entryRemove}
                onClick={() => remove(e.id)}
                title="Entfernen"
                aria-label="Remove entry"
              >×</button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
