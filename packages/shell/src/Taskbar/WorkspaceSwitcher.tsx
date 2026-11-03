import { useTranslation } from "@claraos/core";
import { useOverviewStore, toggleOverview } from "../Overview/overviewStore";
import { useSkinLayout } from "../useSkinLayout";
import styles from "./WorkspaceSwitcher.module.css";

/** The workspaces button in the taskbar / menu bar: opens the overview
 *  (Overview.tsx) — the zoomed-out view of windows and desktops. */
export function WorkspaceSwitcher() {
  const { t } = useTranslation("shell");
  const open = useOverviewStore((s) => s.open);
  const layout = useSkinLayout();

  return (
    <button
      className={`${styles.triggerBtn} ${open ? styles.triggerActive : ""}`}
      onClick={() => toggleOverview(layout.overviewStyle !== "mission")}
      title={t("taskbar.workspaces.title")}
      aria-pressed={open}
      data-shell-part="workspaces-button"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="1" y="1" width="6" height="6" rx="1" />
        <rect x="9" y="1" width="6" height="6" rx="1" />
        <rect x="1" y="9" width="6" height="6" rx="1" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
      </svg>
    </button>
  );
}
