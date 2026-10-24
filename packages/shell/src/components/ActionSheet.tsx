/**
 * ActionSheet — renders ContextMenuItem[] definitions (the same as
 * WindowContextMenu/ToolbarMenu) as a mobile BottomSheet. Submenus are
 * shown as drill-in pages with a "‹ Back" header.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "@claraos/core";
import type { ContextMenuItem } from "./WindowContextMenu";
import { BottomSheet } from "./BottomSheet";
import styles from "./ActionSheet.module.css";

export interface ActionSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  items: ContextMenuItem[];
}

export function ActionSheet({ open, onClose, title, items }: ActionSheetProps) {
  // Drill-in stack for submenus
  const [stack, setStack] = useState<{ title: string; items: ContextMenuItem[] }[]>([]);
  const { t } = useTranslation("components");

  useEffect(() => {
    if (!open) setStack([]);
  }, [open]);

  const page = stack.length > 0 ? stack[stack.length - 1] : { title: title ?? "", items };

  return (
    <BottomSheet open={open} onClose={onClose} title={page.title || undefined}>
      {stack.length > 0 && (
        <button className={styles.row} onClick={() => setStack((s) => s.slice(0, -1))}>
          <span className={styles.icon}>‹</span>
          <span className={styles.label}>{t("actionSheet.back")}</span>
        </button>
      )}
      {page.items.map((item) => {
        if (item.label === "---") {
          return <div key={item.id} className={styles.separator} />;
        }
        if (item.submenu && item.submenu.length > 0) {
          return (
            <button
              key={item.id}
              className={styles.row}
              disabled={item.disabled}
              onClick={() => setStack((s) => [...s, { title: item.label, items: item.submenu! }])}
            >
              {item.icon && <span className={styles.icon}>{item.icon}</span>}
              <span className={styles.label}>{item.label}</span>
              <span className={styles.arrow}>›</span>
            </button>
          );
        }
        return (
          <button
            key={item.id}
            className={`${styles.row} ${item.variant === "destructive" ? styles.destructive : ""}`}
            disabled={item.disabled}
            onClick={() => { item.onSelect?.(); onClose(); }}
          >
            {item.checked !== undefined && <span className={styles.icon}>{item.checked ? "✓" : " "}</span>}
            {item.icon && <span className={styles.icon}>{item.icon}</span>}
            <span className={styles.label}>{item.label}</span>
          </button>
        );
      })}
    </BottomSheet>
  );
}
