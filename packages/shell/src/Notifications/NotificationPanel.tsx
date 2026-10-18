import { AnimatePresence, motion } from "motion/react";
import { useUIStore } from "@claraos/core";
import { primaryAction, runNotificationAction } from "./notificationActions";
import styles from "./NotificationPanel.module.css";

interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationPanel({ open, onClose }: NotificationPanelProps) {
  const notifications = useUIStore((s) => s.notifications);
  const markRead = useUIStore((s) => s.markRead);
  const clearNotifications = useUIStore((s) => s.clearNotifications);

  const unreadCount = notifications.filter(
    (n) => !n.read && n.countInBadge !== false,
  ).length;

  return (
    <>
      {open && <div className={styles.backdrop} onClick={onClose} />}
      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.panel}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.2, ease: "easeOut" }}
          >
            <div className={styles.header}>
              <h3 className={styles.title}>
                Notifications
                {unreadCount > 0 && <span className={styles.badge}>{unreadCount}</span>}
              </h3>
              {notifications.length > 0 && (
                <button className={styles.clearBtn} onClick={clearNotifications}>
                  Clear all
                </button>
              )}
            </div>

            <div className={styles.list}>
              {notifications.length === 0 && (
                <div className={styles.empty}>No notifications</div>
              )}
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className={`${styles.item} ${n.read ? styles.read : ""} ${primaryAction(n) ? styles.itemClickable : ""}`}
                  role={primaryAction(n) ? "button" : undefined}
                  tabIndex={primaryAction(n) ? 0 : undefined}
                  title={primaryAction(n) ? primaryAction(n)!.label : undefined}
                  onClick={() => {
                    // Clicking the notification leads to its target instead of
                    // just marking it read. Without a target the old behavior
                    // remains — nothing gets worse.
                    const a = primaryAction(n);
                    if (a) runNotificationAction(n, a);
                    else markRead(n.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    const a = primaryAction(n);
                    if (a) runNotificationAction(n, a);
                    else markRead(n.id);
                  }}
                >
                  {n.icon && <span className={styles.itemIcon}>{n.icon}</span>}
                  <div className={styles.itemContent}>
                    <span className={styles.itemTitle}>{n.title}</span>
                    <span className={styles.itemBody}>{n.body}</span>
                    <span className={styles.itemTime}>
                      {new Date(n.timestamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    {n.actions && n.actions.length > 0 && (
                      <div className={styles.itemActions} onClick={(e) => e.stopPropagation()}>
                        {n.actions.map((a) => (
                          <button
                            key={a.id}
                            className={`${styles.actionBtn} ${a.primary ? styles.actionPrimary : ""}`}
                            onClick={() => runNotificationAction(n, a)}
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
