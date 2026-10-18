import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useUIStore } from "@claraos/core";
import type { Notification } from "@claraos/core";
import { runNotificationAction } from "./notificationActions";
import styles from "./ToastContainer.module.css";

const TOAST_DURATION = 5000;
const MAX_VISIBLE = 3;

export function ToastContainer() {
  const notifications = useUIStore((s) => s.notifications);
  const markRead = useUIStore((s) => s.markRead);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // One timer per toast, started when it first appears. Previously the effect
  // re-ran on EVERY store change and reset all timers to 5 s — with incoming
  // notifications a toast could stay up indefinitely.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // The store sets `suppressed` when the rules (do not disturb, per app,
  // urgency) do not allow a popup. The notification then only appears in the
  // history — it must not show up as a toast here.
  const visibleToasts = useMemo(() => {
    const seen = new Set<string>();
    const out: Notification[] = [];
    for (const n of notifications) {
      if (n.read || n.suppressed || dismissed.has(n.id) || seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
      if (out.length >= MAX_VISIBLE) break;
    }
    return out;
  }, [notifications, dismissed]);

  const dismiss = (id: string) => {
    const t = timersRef.current.get(id);
    if (t) { clearTimeout(t); timersRef.current.delete(id); }
    setDismissed((prev) => new Set(prev).add(id));
  };

  useEffect(() => {
    for (const n of visibleToasts) {
      if (timersRef.current.has(n.id)) continue;
      timersRef.current.set(n.id, setTimeout(() => {
        timersRef.current.delete(n.id);
        setDismissed((prev) => new Set(prev).add(n.id));
      }, TOAST_DURATION));
    }
  }, [visibleToasts]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => { timers.forEach(clearTimeout); timers.clear(); };
  }, []);

  const handleDismiss = (id: string) => {
    markRead(id);
    dismiss(id);
  };

  return (
    <div className={styles.container}>
      <AnimatePresence>
        {visibleToasts.map((toast) => (
          <motion.div
            key={toast.id}
            className={styles.toast}
            initial={{ opacity: 0, x: 50, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 50, scale: 0.95 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={() => handleDismiss(toast.id)}
          >
            {toast.icon && <span className={styles.toastIcon}>{toast.icon}</span>}
            <div className={styles.toastContent}>
              <span className={styles.toastTitle}>{toast.title}</span>
              <span className={styles.toastBody}>{toast.body}</span>
              {toast.actions && toast.actions.length > 0 && (
                <div className={styles.toastActions} onClick={(e) => e.stopPropagation()}>
                  {toast.actions.map((a) => (
                    <button
                      key={a.id}
                      className={`${styles.toastActionBtn} ${a.primary ? styles.toastActionPrimary : ""}`}
                      onClick={() => {
                        runNotificationAction(toast, a);
                        dismiss(toast.id);
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className={styles.toastClose} onClick={() => handleDismiss(toast.id)}>
              ✕
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
