import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useWorkspaceStore, useWindowsStore, useTranslation } from "@claraos/core";
import styles from "./WorkspaceSwitcher.module.css";

export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation("shell");
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const windows = useWindowsStore((s) => s.windows);

  const windowsByWorkspace = (wsId: string) =>
    Object.values(windows).filter(
      (w) => !w.closing && (w.workspaceId === wsId || (!w.workspaceId && wsId === activeId)),
    );

  const handleSelect = (id: string) => {
    setActive(id);
    setOpen(false);
  };

  return (
    <>
      <button
        className={styles.triggerBtn}
        onClick={() => setOpen((o) => !o)}
        title={t("taskbar.workspaces.title")}
        aria-expanded={open}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="1" width="6" height="6" rx="1" />
          <rect x="9" y="1" width="6" height="6" rx="1" />
          <rect x="1" y="9" width="6" height="6" rx="1" />
          <rect x="9" y="9" width="6" height="6" rx="1" />
        </svg>
      </button>

      {open && <div className={styles.backdrop} onClick={() => setOpen(false)} />}

      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.panel}
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ duration: 0.14 }}
          >
            <div className={styles.header}>{t("taskbar.workspaces.title")}</div>
            <div className={styles.grid}>
              {workspaces.map((ws) => {
                const wsWindows = windowsByWorkspace(ws.id);
                const isActive = ws.id === activeId;
                return (
                  <div
                    key={ws.id}
                    className={`${styles.card} ${isActive ? styles.cardActive : ""}`}
                    onClick={() => handleSelect(ws.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && handleSelect(ws.id)}
                  >
                    <div className={styles.cardPreview}>
                      {wsWindows.length === 0 ? (
                        <span className={styles.cardEmpty}>{t("taskbar.workspaces.empty")}</span>
                      ) : (
                        <div className={styles.cardIcons}>
                          {wsWindows.slice(0, 6).map((w) => (
                            <span key={w.id} className={styles.cardIcon} title={w.title}>
                              {w.icon || "⬜"}
                            </span>
                          ))}
                          {wsWindows.length > 6 && (
                            <span className={styles.cardMore}>+{wsWindows.length - 6}</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className={styles.cardFooter}>
                      <span className={styles.cardName}>{ws.name}</span>
                      {isActive && <span className={styles.cardActiveDot} />}
                      {workspaces.length > 1 && (
                        <button
                          className={styles.deleteBtn}
                          onClick={(e) => { e.stopPropagation(); deleteWorkspace(ws.id); }}
                          title={t("taskbar.workspaces.delete")}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              <button
                className={styles.addCard}
                onClick={() => { createWorkspace(t("taskbar.workspaces.defaultName", { n: workspaces.length + 1 })); }}
              >
                <span className={styles.addIcon}>+</span>
                <span className={styles.addLabel}>{t("taskbar.workspaces.new")}</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
