import { type ReactNode } from "react";
import {
  getFormatPrefs,
  formatBytesLocale,
  formatDateTimeLocale,
  useTranslation,
} from "@claraos/core";
import styles from "./PropertiesDialog.module.css";

export interface PropertyRow {
  label: string;
  value: ReactNode;
}

export interface PropertiesDialogProps {
  open: boolean;
  title: string;
  rows: PropertyRow[];
  onClose: () => void;
}

/**
  * Generic Properties modal — used for desktop icon properties
 * and Files-app right-click "Properties". Stays modal-on-top via a
 * fixed-position overlay. Aero-Glass receives a richer backdrop via the
 * skin stylesheet (see `[data-skin-id="aero-glass"] .panel`).
 */
export function PropertiesDialog({ open, title, rows, onClose }: PropertiesDialogProps) {
  const { t } = useTranslation("components");
  if (!open) return null;
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label={t("propertiesDialog.close")}>
            ×
          </button>
        </div>
        <dl className={styles.rows}>
          {rows.map((row, idx) => (
            <div key={`${row.label}-${idx}`} className={styles.row}>
              <dt className={styles.rowLabel}>{row.label}</dt>
              <dd className={styles.rowValue}>{row.value}</dd>
            </div>
          ))}
        </dl>
        <div className={styles.footer}>
          <button className={styles.okBtn} onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

/** File size in the user's chosen format (Settings → Language & formats). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  return formatBytesLocale(bytes, getFormatPrefs());
}

/** Timestamp in the chosen regional format. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDateTimeLocale(new Date(iso), getFormatPrefs());
  } catch {
    return iso;
  }
}
