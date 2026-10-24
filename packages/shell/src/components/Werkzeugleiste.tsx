/** Werkzeugleiste (toolbar) — the floating bar at the bottom of a phone app.
 *  Material 3 "docked toolbar" pattern: a pill with icons only, active = tonal
 *  pill, optionally next to it the ONE primary action as a FAB.
 *
 *  Why a shared building block: Planner, Knowledge and Teams each had their
 *  own tab bar (three CSS versions of the same idea, one with 68 px right
 *  padding for a button that no longer exists).
 *  The bar floats OVER the content — the app gives its scroller ~96 px of
 *  bottom padding (`.content { padding-bottom }`) so the last card does not
 *  disappear underneath.
 */
import type { ReactNode } from "react";
import { useTranslation } from "@claraos/core";
import { Icon, type IconName } from "./Icon";
import { Fab } from "./Button";
import styles from "./Werkzeugleiste.module.css";

export interface WerkzeugEintrag {
  key: string;
  label: string;
  icon: IconName | ReactNode;
  active?: boolean;
  /** small number top right (unread) */
  badge?: number;
  onClick: () => void;
}

interface Props {
  eintraege: WerkzeugEintrag[];
  fab?: { label: string; icon?: IconName; onClick: () => void };
  className?: string;
}

export function Werkzeugleiste({ eintraege, fab, className = "" }: Props) {
  const { t } = useTranslation("components");
  return (
    <div className={`${styles.rand} ${className}`}>
      <nav className={styles.leiste} aria-label={t("toolbar.areas")}>
        {eintraege.map((e) => (
          <button
            key={e.key}
            type="button"
            className={`${styles.knopf} ${e.active ? styles.aktiv : ""}`}
            aria-label={e.label}
            title={e.label}
            aria-current={e.active ? "page" : undefined}
            onClick={e.onClick}
          >
            {typeof e.icon === "string" ? <Icon name={e.icon as IconName} size={24} /> : e.icon}
            {e.badge != null && e.badge > 0 && (
              <span className={styles.badge}>{e.badge > 99 ? "99+" : e.badge}</span>
            )}
          </button>
        ))}
      </nav>
      {fab && <Fab label={fab.label} icon={fab.icon ?? "plus"} onClick={fab.onClick} />}
    </div>
  );
}
