/** Quick capture modal in series mode: Enter saves as a spark and stays open
 * for the next idea (Esc or ✕ closes). Shortcut `N` in the app. */
import { useEffect, useRef, useState } from "react";
import styles from "./IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { useTranslation, i18n } from "@claraos/core";

interface Props {
  onCapture: (title: string, note: string) => Promise<void>;
  onClose: () => void;
  // Also used by the knowledge suite (note instead of idea); the capture
  // semantics (type/stage) live entirely in the caller's onCapture.
  heading?: string;
  submitLabel?: string;
}

export function QuickCapture({
  onCapture, onClose, heading = i18n.t("wissen:app.ideaHeading"), submitLabel = i18n.t("wissen:app.saveSpark"),
}: Props) {
  const { t } = useTranslation("wissen");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [captured, setCaptured] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, [captured]);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await onCapture(title.trim(), note.trim());
      setTitle("");
      setNote("");
      setCaptured((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}
           onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div className={styles.modalHead}>
          <h3>{heading}</h3>
          <button className={styles.iconBtn} onClick={onClose} title={t("app.close")}><Icon name="close" size={14} title={t("app.close")} /></button>
        </div>
        <input
          ref={titleRef}
          className={styles.input}
          placeholder={t("capture.placeholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        />
        <textarea
          className={styles.input}
          placeholder={t("capture.notePlaceholder")}
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className={styles.modalFoot}>
          {captured > 0 && <span className={styles.metaHint}>{captured} erfasst ✓</span>}
          <button className={styles.btnPrimary} disabled={!title.trim() || busy} onClick={() => void submit()}>
            {busy ? "…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
