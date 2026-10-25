/** Property input fields by type schema (kind: text|number|date|select|
 * multi_select|url|checkbox). Shared by MetaSidebar (detail) and
 * CollectionView (inline cells). Saves on blur/change. */
import { useTranslation } from "@claraos/core";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import styles from "./IdeasApp.module.css";
import plaketten from "../wissen/Wissen.module.css";
import { Plaketten } from "../wissen/Plakette";
import { LEER, formatDatum, formatZahl } from "./format";
import type { KbPropDef } from "./types";
import { oeffneImClaraBrowser } from "../../Browser/OpenExternalDialog";

/** A value as text: the single display formatter. */
export function propDisplay(def: KbPropDef, value: unknown): string {
  if (value === undefined || value === null || value === "") return LEER;
  if (def.kind === "checkbox") return value ? "✓" : LEER;
  if (def.kind === "multi_select" && Array.isArray(value)) return value.join(", ");
  if (def.kind === "date") return formatDatum(value);
  if (def.kind === "number") return formatZahl(value);
  return String(value);
}

interface FieldProps {
  def: KbPropDef;
  value: unknown;
  readOnly?: boolean;
  /** compact = table cell (no label, slimmer) */
  compact?: boolean;
  /** Wrap content instead of truncating with "…" (as in Notion). */
  umbruch?: boolean;
  onSave: (value: unknown) => void;
}

export function PropertyField({ def, value, readOnly, compact, umbruch, onSave }: FieldProps) {
  const { t } = useTranslation("wissen");
  // In the table the cell is text first; only a click opens the field.
  const [bearbeitet, setBearbeitet] = useState(false);
  const feldRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string>(
    def.kind === "multi_select" && Array.isArray(value) ? value.join(", ") : String(value ?? ""));
  useEffect(() => {
    setDraft(def.kind === "multi_select" && Array.isArray(value) ? value.join(", ") : String(value ?? ""));
  }, [value, def.kind]);

  const cls = compact ? styles.cellInput : styles.input;

  const commit = () => {
    if (readOnly) return;
    let out: unknown = draft.trim();
    if (out === "" && def.kind !== "checkbox") out = null;
    else if (def.kind === "number") {
      const n = Number(String(out).replace(",", "."));
      out = Number.isFinite(n) ? n : null;
    } else if (def.kind === "multi_select") {
      out = String(out).split(",").map((s) => s.trim()).filter(Boolean);
    }
    const before = def.kind === "multi_select" && Array.isArray(value) ? value.join(", ") : String(value ?? "");
    const after = def.kind === "multi_select" && Array.isArray(out) ? out.join(", ") : String(out ?? "");
    if (before !== after) onSave(out);
  };

  if (def.kind === "checkbox") {
    return (
      <input type="checkbox" checked={!!value} disabled={readOnly}
             onChange={(e) => onSave(e.target.checked)} />
    );
  }
  // A URL is a LINK first, also in your own entry (not just in read-only
  // ones); clicking it must open the page, not an input field. In the table
  // only "Link" is shown (the address itself means nothing at a glance and
  // blows up the column). A click opens DIRECTLY in the logged-in Clara
  // Browser: these are your own notes, not someone else's mail, so no
  // confirmation dialog. Ctrl/Cmd/middle-click keep the browser tab. Editing
  // goes through the pencil next to it.
  if (def.kind === "url" && !bearbeitet && value) {
    const url = String(value);
    const oeffnen = (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.ctrlKey || e.metaKey || e.button === 1 || !/^https?:\/\//i.test(url)) return;
      e.preventDefault();
      void oeffneImClaraBrowser(url, "session", "wissen");
    };
    return (
      <span className={styles.propLinkZeile}>
        <a href={url} target="_blank" rel="noreferrer" className={styles.propLink}
           title={t("prop.linkTitle", { url })}
           onClick={oeffnen}>
          {compact ? t("prop.linkShort") : url}
        </a>
        {!readOnly && (
          <button type="button" className={styles.propLinkEdit} title={t("prop.editUrl")}
                  onClick={() => setBearbeitet(true)}>✎</button>
        )}
      </span>
    );
  }

  // A value is TEXT first and only becomes an input field after a click.
  // An `<input>` everywhere turns six table rows into two dozen controls
  // instead of readable data, and for dates the BROWSER would decide the
  // format, not the app.
  // This applies everywhere, not just to `compact` (table): otherwise the
  // opened entry would still show `09/30/2026`.
  if (!bearbeitet) {
    // Select and multi-select render as colored pills here too, not as a
    // native `<select>`: the same thing must not have two looks depending on
    // WHERE you view it (table cells in `CollectionView` vs. the opened
    // entry). So the pills live here, where everyone uses them.
    if (def.kind === "select" || def.kind === "multi_select") {
      const werte = def.kind === "multi_select"
        ? (Array.isArray(value) ? value.map(String).filter(Boolean) : [])
        : (value ? [String(value)] : []);
      return (
        <button
          type="button"
          className={styles.cellText}
          style={{ textAlign: "left" }}
          disabled={readOnly}
          title={readOnly ? undefined : t("prop.clickToChange")}
          onClick={() => setBearbeitet(true)}
        >
          {werte.length
            ? <Plaketten werte={werte} optionen={def.options} />
            : <span className={plaketten.leerZeichen}>—</span>}
        </button>
      );
    }
    const text = propDisplay(def, value);
    return (
      <button
        type="button"
        className={`${def.kind === "number"
          ? `${styles.cellText} ${styles.cellZahl}` : styles.cellText}`
          + `${umbruch ? ` ${styles.cellUmbruch}` : ""}`}
        style={compact ? undefined : { textAlign: def.kind === "number" ? "right" : "left" }}
        disabled={readOnly}
        title={readOnly ? undefined : t("prop.clickToEdit")}
        onClick={() => setBearbeitet(true)}
      >
        {text}
      </button>
    );
  }

  if (def.kind === "select") {
    return (
      <select className={cls} value={String(value ?? "")} disabled={readOnly} autoFocus
              onBlur={() => setBearbeitet(false)}
              onChange={(e) => { onSave(e.target.value || null); setBearbeitet(false); }}>
        <option value="">—</option>
        {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }

  return (
    <input
      className={cls}
      ref={feldRef}
      autoFocus={compact}
      type={def.kind === "date" ? "date" : def.kind === "number" ? "number" : "text"}
      value={draft}
      readOnly={readOnly}
      placeholder={compact ? "" : def.label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { commit(); setBearbeitet(false); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { setDraft(String(value ?? "")); setBearbeitet(false); }
      }}
    />
  );
}

interface GroupProps {
  schema: KbPropDef[];
  properties: Record<string, unknown>;
  readOnly?: boolean;
  onSaveProp: (key: string, value: unknown) => void;
}

/** Label + field list for the meta sidebar. */
export function PropertyFields({ schema, properties, readOnly, onSaveProp }: GroupProps) {
  if (!schema.length) return null;
  return (
    <div className={styles.propList}>
      {schema.map((def) => (
        <label key={def.key} className={styles.propRow}>
          <span className={styles.propLabel}>{def.label}</span>
          <PropertyField def={def} value={properties[def.key]} readOnly={readOnly}
                         onSave={(v) => onSaveProp(def.key, v)} />
        </label>
      ))}
    </div>
  );
}
