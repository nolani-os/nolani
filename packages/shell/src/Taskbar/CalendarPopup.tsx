import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import styles from "./CalendarPopup.module.css";
import { regionLocale, useTranslation } from "@claraos/core";

// Monday first — the grid below starts the week on Monday.
const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

interface CalendarPopupProps {
  open: boolean;
  onClose: () => void;
}

export function CalendarPopup({ open, onClose }: CalendarPopupProps) {
  const { t } = useTranslation("shell");
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  const { monthName, days, startDay } = useMemo(() => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const monthName = firstDay.toLocaleDateString(regionLocale(), { month: "long", year: "numeric" });
    const days = lastDay.getDate();
    const startDay = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1; // Monday = 0
    return { monthName, days, startDay };
  }, [year, month]);

  const dayNames = WEEKDAY_KEYS.map((k) => t(`taskbar.calendar.weekday.${k}`));

  return (
    <>
      {open && <div className={styles.backdrop} onClick={onClose} />}
      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.popup}
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ duration: 0.15 }}
          >
            <div className={styles.header}>{monthName}</div>
            <div className={styles.grid}>
              {dayNames.map((d) => (
                <span key={d} className={styles.dayName}>{d}</span>
              ))}
              {Array.from({ length: startDay }).map((_, i) => (
                <span key={`pad-${i}`} />
              ))}
              {Array.from({ length: days }).map((_, i) => {
                const day = i + 1;
                const isToday = day === today.getDate();
                return (
                  <span
                    key={day}
                    className={`${styles.day} ${isToday ? styles.today : ""}`}
                  >
                    {day}
                  </span>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
