/** Column menu on the table header.
 *
 * Modeled on Notion's column menu: everything concerning a column hangs ON the
 * column — rename, change type, sort, calculate, hide, insert, delete. Note
 * that hiding columns was already supported by the system — `field_settings`
 * was read by the table but written by **no** place in the frontend. The
 * capability existed; the control was missing.
 *
 * Changing the type to relation, rollup or formula is offered too, even though
 * those need configuration: leaving them out would make it impossible to
 * **create a related table in the UI at all**, although the backend supports
 * it. Notion lists ALL types under "Change type" and then asks for the target
 * database. Needing configuration is not a reason to leave something out but
 * a reason to ask — the follow-up dialog lives in `FeldEinrichten.tsx`, the
 * formula in `FormelEditor.tsx`.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import styles from "./Wissen.module.css";
import geteilt from "../ideas/IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { FieldType } from "../ideas/types";
import type { KbField, KbView } from "../ideas/types";
import { AGGREGATE, MIT_RUECKFRAGE, TYP_MARKE, UMSCHALTBAR } from "./feldTypen";
import { gruppierbar } from "./gruppieren";
import { useTranslation } from "@claraos/core";

interface Props {
  feld: KbField;
  ansicht: KbView | null;
  /** Position in the visible order — for "insert left/right". */
  onUmbenennen: (name: string) => void;
  onTypWechsel: (typ: number) => void;
  onSortieren: (richtung: "asc" | "desc" | null) => void;
  onAggregat: (agg: string) => void;
  /** Group by this column (or remove the grouping). */
  onGruppieren: (an: boolean) => void;
  onAusblenden: () => void;
  onEinfuegen: (seite: "links" | "rechts") => void;
  /** Duplicate the column including its values. */
  onDuplizieren: () => void;
  /** Keep this column (and everything left of it) fixed while scrolling. */
  onFixieren: (an: boolean) => void;
  /** Wrap text in the cell instead of truncating with "…". */
  onUmbruch: (an: boolean) => void;
  /** Color rows by this select column. */
  onFaerben?: (an: boolean) => void;
  /** Relation: show names or just the count. */
  onAnzeige?: (wie: "namen" | "anzahl") => void;
  onLoeschen: () => void;
  onSchliessen: () => void;
  /** Screen position — the menu is rendered via a portal. */
  stil?: React.CSSProperties;
}

export function SpaltenMenue({
  feld, ansicht, onUmbenennen, onTypWechsel, onSortieren, onAggregat,
  onGruppieren, onAusblenden, onEinfuegen, onDuplizieren, onFixieren, onUmbruch,
  onFaerben, onAnzeige, onLoeschen, onSchliessen, stil,
}: Props) {
  const { t } = useTranslation("wissen");
  const [name, setName] = useState(feld.name);
  const [typOffen, setTypOffen] = useState(false);
  const [aggOffen, setAggOffen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  /** Warning: with 16 entries the menu can run off the bottom of the screen.
   *  "Duplicate column" was then present but not clickable (a test timed out
   *  even though the button was found). A menu you cannot reach is not a menu.
   *  So: measure after rendering and shift it into view — the same thing
   *  `components/PopupMenu` has always done. */
  const [versatz, setVersatz] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const zuViel = r.bottom - (window.innerHeight - 8);
    setVersatz(zuViel > 0 ? -Math.min(zuViel, Math.max(0, r.top - 8)) : 0);
  }, [typOffen, aggOffen]);

  // Clicking outside closes it — otherwise the menu stays open and covers the
  // table you are trying to read.
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

  const sorts = (ansicht?.sorts ?? []) as { key: string; dir?: string }[];
  const meine = sorts.find((s) => s.key === feld.key);
  const agg = String(ansicht?.field_settings?.[feld.key]?.agg ?? "");
  const istZahl = feld.field_type === FieldType.Number
    || feld.field_type === FieldType.Rollup
    || feld.field_type === FieldType.Formula;
  const berechenbar = AGGREGATE.filter((a) => !a.nurZahl || istZahl);
  // "Group" only appears where groups can form — for a number column every
  // row would be its own group.
  const darfGruppieren = gruppierbar(feld);
  const gruppiertHier = String(ansicht?.group_setting?.key ?? "") === feld.key;
  // Converting is ALWAYS allowed (Notion pattern). Only the formula is
  // excluded, as long as there is no expression editor.
  const typListe = [...UMSCHALTBAR, ...MIT_RUECKFRAGE];
  const einst = ansicht?.field_settings?.[feld.key] ?? {};
  const fixiert = String(ansicht?.layout_setting?.fixiert_bis ?? "") === feld.key;
  const faerbt = String(ansicht?.layout_setting?.faerben_nach ?? "") === feld.key;
  const umbricht = einst.umbruch === true;
  const zeigtAnzahl = einst.anzeige === "anzahl";

  const speichern = () => {
    const n = name.trim();
    if (n && n !== feld.name) onUmbenennen(n);
  };

  return (
    <div className={styles.spaltenMenue} ref={ref}
         style={versatz ? { ...stil, top: `calc(${String(stil?.top ?? "0px")} + ${versatz}px)` } : stil}>
      <input
        className={styles.spaltenName}
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onBlur={speichern}
        onKeyDown={(e) => {
          if (e.key === "Enter") { speichern(); onSchliessen(); }
        }}
      />

      {/* With the formula editor there is no type left that may not be changed. */}
      <>
          <button className={styles.menueZeile} onClick={() => setTypOffen((v) => !v)}>
            <span className={styles.menueSymbol}>
              {TYP_MARKE[feld.field_type]?.icon
                ? <Icon name={TYP_MARKE[feld.field_type].icon!} size={14} />
                : TYP_MARKE[feld.field_type]?.glyph}
            </span>
            <span>{t("colMenu.changeType")}</span>
            <span className={styles.menueWert}>{TYP_MARKE[feld.field_type]?.label}</span>
          </button>
          {typOffen && (
            <div className={styles.menueUnter}>
              {typListe.map((t) => (
                <button key={t} className={styles.menueZeile}
                        onClick={() => { onTypWechsel(t); setTypOffen(false); }}>
                  <span className={styles.menueSymbol}>
                    {TYP_MARKE[t].icon
                      ? <Icon name={TYP_MARKE[t].icon!} size={14} />
                      : TYP_MARKE[t].glyph}
                  </span>
                  <span>{TYP_MARKE[t].label}</span>
                  {t === feld.field_type
                    ? <span className={styles.menueWert}>✓</span>
                    : MIT_RUECKFRAGE.includes(t)
                      ? <span className={styles.menueWert}>…</span> : null}
                </button>
              ))}
            </div>
          )}
      </>

      <div className={styles.menueTrenner} />

      <button className={styles.menueZeile} onClick={() => onSortieren("asc")}>
        <span className={styles.menueSymbol}><Icon name="arrowUp" size={14} /></span>
        <span>{t("colMenu.asc")}</span>
        {meine?.dir !== "desc" && meine && <span className={styles.menueWert}>✓</span>}
      </button>
      <button className={styles.menueZeile} onClick={() => onSortieren("desc")}>
        <span className={styles.menueSymbol} style={{ transform: "rotate(180deg)" }}>
          <Icon name="arrowUp" size={14} />
        </span>
        <span>{t("colMenu.desc")}</span>
        {meine?.dir === "desc" && <span className={styles.menueWert}>✓</span>}
      </button>
      {meine && (
        <button className={styles.menueZeile} onClick={() => onSortieren(null)}>
          <span className={styles.menueSymbol}><Icon name="close" size={13} /></span>
          <span>{t("colMenu.clearSort")}</span>
        </button>
      )}

      {darfGruppieren && (
        <button className={styles.menueZeile}
                onClick={() => { onGruppieren(!gruppiertHier); onSchliessen(); }}>
          <span className={styles.menueSymbol}><Icon name="list" size={14} /></span>
          <span>{gruppiertHier ? t("colMenu.ungroup") : t("colMenu.group")}</span>
          {gruppiertHier && <span className={styles.menueWert}>✓</span>}
        </button>
      )}

      <button className={styles.menueZeile} onClick={() => setAggOffen((v) => !v)}>
        <span className={styles.menueSymbol}>Σ</span>
        <span>{t("colMenu.calculate")}</span>
        <span className={styles.menueWert}>
          {AGGREGATE.find((a) => a.key === agg)?.label ?? t("aggregate.none")}
        </span>
      </button>
      {aggOffen && (
        <div className={styles.menueUnter}>
          {berechenbar.map((a) => (
            <button key={a.key || "keins"} className={styles.menueZeile}
                    onClick={() => { onAggregat(a.key); setAggOffen(false); }}>
              <span className={styles.menueSymbol} />
              <span>{a.label}</span>
              {a.key === agg && <span className={styles.menueWert}>✓</span>}
            </button>
          ))}
        </div>
      )}

      <div className={styles.menueTrenner} />

      {/* ── Display ──────────────────────────────────────────────────── */}
      <button className={styles.menueZeile} onClick={() => { onFixieren(!fixiert); onSchliessen(); }}>
        <span className={styles.menueSymbol}>⇥</span>
        <span>{fixiert ? t("colMenu.unfreeze") : t("colMenu.freeze")}</span>
        {fixiert && <span className={styles.menueWert}>✓</span>}
      </button>
      <button className={styles.menueZeile} onClick={() => { onUmbruch(!umbricht); onSchliessen(); }}>
        <span className={styles.menueSymbol}>↵</span>
        <span>{umbricht ? t("colMenu.nowrap") : t("colMenu.wrap")}</span>
        {umbricht && <span className={styles.menueWert}>✓</span>}
      </button>
      {feld.field_type === FieldType.Select && onFaerben && (
        <button className={styles.menueZeile} onClick={() => { onFaerben(!faerbt); onSchliessen(); }}>
          <span className={styles.menueSymbol}>◐</span>
          <span>{faerbt ? t("colMenu.uncolor") : t("colMenu.color")}</span>
          {faerbt && <span className={styles.menueWert}>✓</span>}
        </button>
      )}
      {feld.field_type === FieldType.Relation && onAnzeige && (
        <button className={styles.menueZeile}
                onClick={() => { onAnzeige(zeigtAnzahl ? "namen" : "anzahl"); onSchliessen(); }}>
          <span className={styles.menueSymbol}><Icon name="graph" size={14} /></span>
          <span>{t("colMenu.showAs")}</span>
          <span className={styles.menueWert}>{zeigtAnzahl ? t("colMenu.count") : t("colMenu.names")}</span>
        </button>
      )}

      <div className={styles.menueTrenner} />

      <button className={styles.menueZeile} onClick={onAusblenden}>
        <span className={styles.menueSymbol}><Icon name="blind" size={14} /></span>
        <span>{t("colMenu.hide")}</span>
      </button>
      <button className={styles.menueZeile} onClick={() => onEinfuegen("links")}>
        <span className={styles.menueSymbol}><Icon name="plus" size={14} /></span>
        <span>{t("colMenu.insertLeft")}</span>
      </button>
      <button className={styles.menueZeile} onClick={() => onEinfuegen("rechts")}>
        <span className={styles.menueSymbol}><Icon name="plus" size={14} /></span>
        <span>{t("colMenu.insertRight")}</span>
      </button>
      <button className={styles.menueZeile} onClick={() => { onDuplizieren(); onSchliessen(); }}>
        <span className={styles.menueSymbol}>⧉</span>
        <span>{t("colMenu.duplicate")}</span>
      </button>
      <button className={`${styles.menueZeile} ${styles.menueGefahr}`}
              onClick={() => {
                if (window.confirm(
                  t("columns.confirmDelete", { name: feld.name }))) onLoeschen();
              }}>
        <span className={styles.menueSymbol}><Icon name="trash" size={14} /></span>
        <span>{t("colMenu.delete")}</span>
      </button>

      <div className={geteilt.metaHint} style={{ padding: "6px 10px 2px" }}>
        {t("colMenu.onlyThisView")}
      </div>
    </div>
  );
}
