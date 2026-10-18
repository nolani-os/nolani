import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import styles from "./IconContextMenu.module.css";

export interface ContextAction {
  key: string;
  label: string;
  icon: string;
  danger?: boolean;
}

interface Props {
  x: number;
  y: number;
  title: string;
  actions: ContextAction[];
  onAction: (key: string) => void;
  onClose: () => void;
}

const MENU_W = 220;
const MENU_MAX_H = 280;

// Android-style long-press popup, anchored near the pressed icon and clamped
// to stay on screen. Backdrop tap closes it.
export function IconContextMenu({ x, y, title, actions, onAction, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 412;
  const vh = typeof window !== "undefined" ? window.innerHeight : 915;
  const left = Math.min(Math.max(8, x - MENU_W / 2), vw - MENU_W - 8);
  const top = Math.min(Math.max(56, y + 12), vh - MENU_MAX_H - 8);

  return (
    <div className={styles.backdrop} onPointerDown={onClose}>
      <motion.div
        ref={ref}
        className={styles.menu}
        style={{ left, top, width: MENU_W }}
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", damping: 24, stiffness: 380 }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className={styles.title}>{title}</div>
        {actions.map((a) => (
          <button
            key={a.key}
            className={`${styles.item} ${a.danger ? styles.danger : ""}`}
            onClick={() => { onAction(a.key); }}
          >
            <span className={styles.itemIcon}>{a.icon}</span>
            <span>{a.label}</span>
          </button>
        ))}
      </motion.div>
    </div>
  );
}
