// Android-style widget picker: a bottom sheet listing the mobile widget
// manifests. Opened via long-press on an empty home cell → "Widgets".
import { motion } from "motion/react";
import { MOBILE_WIDGET_TYPES, MOBILE_WIDGET_EMOJI, widgetManifests } from "../widgets/registry";
import styles from "./WidgetPicker.module.css";

export function WidgetPicker({
  onSelect, onClose,
}: {
  onSelect: (type: string, w: number, h: number) => void;
  onClose: () => void;
}) {
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <motion.div
        className={styles.sheet}
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.handle} />
        <div className={styles.title}>Widgets</div>
        <div className={styles.list}>
          {MOBILE_WIDGET_TYPES.map((type) => {
            const m = widgetManifests[type];
            if (!m) return null;
            return (
              <button
                key={type}
                className={styles.row}
                onClick={() => onSelect(type, m.defaultSize.w, m.defaultSize.h)}
              >
                <span className={styles.preview}>{MOBILE_WIDGET_EMOJI[type] ?? "🧩"}</span>
                <span className={styles.meta}>
                  <span className={styles.name}>{m.name}</span>
                  <span className={styles.desc}>{m.description}</span>
                </span>
                <span className={styles.size}>{m.defaultSize.w}×{m.defaultSize.h}</span>
              </button>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}
