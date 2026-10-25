/** Menu of the active view.
 *
 * Why: two stacked toolbars (view chips "All entries · By status · Gallery · ＋"
 * on top, and a second row with a layout select, filter, sort and an × below)
 * made the layout both a **property of the view** and a select next to it —
 * two ways to the same thing, plus a row of height that eats 40 % of a phone
 * screen.
 *
 * Instead: one bar. What belongs to the view hangs **on** the view — clicking
 * the active chip opens this menu.
 *
 * Warning: rendered via a portal on the document, not as a child of the bar.
 * The reason is explained in the column menu: overlays inside a table cannot
 * reliably be brought to the front with `z-index` — and the bar sits directly
 * above one.
 */
import { useEffect, useRef } from "react";
import type React from "react";
import styles from "./Wissen.module.css";
import { Icon } from "../../components/Icon";
import type { ViewLayout } from "../ideas/types";
import { useTranslation, i18n } from "@claraos/core";

const layoutWahl = (key: ViewLayout, icon: string) =>
  ({ key, icon, get label() { return i18n.t(`wissen:layout.${key}`); } });
export const LAYOUT_WAHL: { key: ViewLayout; label: string; icon: string }[] = [
  layoutWahl("table", "▦"), layoutWahl("board", "▥"), layoutWahl("gallery", "▩"),
  layoutWahl("list", "≡"), layoutWahl("calendar", "▤"), layoutWahl("timeline", "▭"),
];

interface Props {
  aktuell: ViewLayout;
  name: string;
  loeschbar: boolean;
  onLayout: (l: ViewLayout) => void;
  onUmbenennen: (name: string) => void;
  onLoeschen: () => void;
  onSchliessen: () => void;
  stil?: React.CSSProperties;
  /** On phones, filter and sort move here — they are properties of THIS
   *  view, and a second toolbar row on a phone-width screen cost a row that the
   *  first entry was missing. */
  onFilter?: () => void;
  onSortierung?: () => void;
  /** The way to the columns that works without a column header — on phones
   *  the only one. */
  onSpalten?: () => void;
  filterAnzahl?: number;
  sortAnzahl?: number;
}

export function AnsichtsMenue({
  aktuell, name, loeschbar, onLayout, onUmbenennen, onLoeschen, onSchliessen, stil,
  onFilter, onSortierung, onSpalten, filterAnzahl = 0, sortAnzahl = 0,
}: Props) {
  const { t } = useTranslation("wissen");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const zu = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onSchliessen();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onSchliessen(); };
    document.addEventListener("mousedown", zu);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", zu);
      document.removeEventListener("keydown", esc);
    };
  }, [onSchliessen]);

  return (
    <div className={styles.spaltenMenue} ref={ref} style={stil}>
      <input
        className={styles.spaltenName}
        defaultValue={name}
        autoFocus
        onBlur={(e) => {
          const n = e.target.value.trim();
          if (n && n !== name) onUmbenennen(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const n = (e.target as HTMLInputElement).value.trim();
            if (n && n !== name) onUmbenennen(n);
            onSchliessen();
          }
        }}
      />

      <div className={styles.menueHinweis} style={{ paddingBottom: 0 }}>{t("viewMenu.showAs")}</div>
      {LAYOUT_WAHL.map((l) => (
        <button key={l.key} className={styles.menueZeile}
                onClick={() => { onLayout(l.key); onSchliessen(); }}>
          <span className={styles.menueSymbol}>{l.icon}</span>
          <span>{l.label}</span>
          {l.key === aktuell && <span className={styles.menueWert}>✓</span>}
        </button>
      ))}

      {(onFilter || onSortierung || onSpalten) && (
        <>
          <div className={styles.menueTrenner} />
          {onSpalten && (
            <button className={styles.menueZeile}
                    onClick={() => { onSchliessen(); onSpalten(); }}>
              <span className={styles.menueSymbol}><Icon name="list" size={14} /></span>
              <span>{t("viewMenu.columns")}</span>
            </button>
          )}
          {onFilter && (
            <button className={styles.menueZeile}
                    onClick={() => { onSchliessen(); onFilter(); }}>
              <span className={styles.menueSymbol}>⚙</span>
              <span>{t("viewMenu.filter")}</span>
              {filterAnzahl > 0 && <span className={styles.menueWert}>{filterAnzahl}</span>}
            </button>
          )}
          {onSortierung && (
            <button className={styles.menueZeile}
                    onClick={() => { onSchliessen(); onSortierung(); }}>
              <span className={styles.menueSymbol}>↕</span>
              <span>{t("viewMenu.sort")}</span>
              {sortAnzahl > 0 && <span className={styles.menueWert}>{sortAnzahl}</span>}
            </button>
          )}
        </>
      )}

      {loeschbar && (
        <>
          <div className={styles.menueTrenner} />
          <button className={`${styles.menueZeile} ${styles.menueGefahr}`}
                  onClick={() => {
                    if (window.confirm(t("viewMenu.confirmDelete", { name })))
                      onLoeschen();
                  }}>
            <span className={styles.menueSymbol}><Icon name="trash" size={14} /></span>
            <span>{t("viewMenu.delete")}</span>
          </button>
        </>
      )}
    </div>
  );
}
