// Widget gallery: card grid over all widget manifests. Opened from the
// desktop context menu ("Widgets…"). A card click adds the widget at the
// first free desktop spot (Desktop.tsx computes that) and closes the dialog.
import { useTranslation } from "@claraos/core";
import { widgetManifests, widgetName, widgetDescription } from "../widgets/registry";
import styles from "./WidgetGallery.module.css";

export interface WidgetGalleryProps {
  open: boolean;
  onAdd: (type: string) => void;
  onClose: () => void;
}

export function WidgetGallery({ open, onAdd, onClose }: WidgetGalleryProps) {
  const { t } = useTranslation("desktop");
  if (!open) return null;
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={`aeroWidget ${styles.panel}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("gallery.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{t("gallery.title")}</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label={t("gallery.close")}>
            ×
          </button>
        </div>
        <div className={styles.grid}>
          {Object.values(widgetManifests).map((m) => (
            <button
              key={m.id}
              className={styles.card}
              onClick={() => {
                onAdd(m.id);
                onClose();
              }}
            >
              <span className={styles.cardIcon} aria-hidden>
                {m.icon ?? "🧩"}
              </span>
              <span className={styles.cardName}>{widgetName(m)}</span>
              <span className={styles.cardDesc}>{widgetDescription(m)}</span>
              <span className={styles.cardAdd}>＋ {t("gallery.add")}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
