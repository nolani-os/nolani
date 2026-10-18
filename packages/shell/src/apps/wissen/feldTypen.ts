/** Make column types visible.
 *
 * Why: in Notion **every** column header carries a symbol for its type. You
 * understand the table without reading it — "this is a date, that a select,
 * that a number". With only the name in the header, you can only tell from
 * the values whether a column holds numbers or text.
 *
 * Why partly drawn icons, partly characters: the icon set
 * (`components/Icon.tsx`) cleanly covers date, checkbox, link, person, list,
 * graph and attachment — for "text", "number", "formula" and "rollup" there is
 * nothing fitting. A wrong icon is worse than a character: everyone reads
 * `Aa`, `#`, `ƒ`, `Σ` instantly. Invented icon names would not work anyway
 * (they do not exist).
 */
import { FieldType } from "../ideas/types";
import type { IconName } from "../../components/Icon";

export interface TypMarke {
  /** Drawn icon, if there is one that really fits. */
  icon?: IconName;
  /** Otherwise a short character. */
  glyph?: string;
  /** Plain text for the tooltip and type picker. */
  label: string;
}

export const TYP_MARKE: Record<number, TypMarke> = {
  [FieldType.Text]: { glyph: "Aa", label: "Text" },
  [FieldType.Number]: { glyph: "#", label: "Zahl" },
  [FieldType.Date]: { icon: "calendar", label: "Datum" },
  [FieldType.Select]: { icon: "chevronDown", label: "Auswahl" },
  [FieldType.MultiSelect]: { icon: "list", label: "Mehrfachauswahl" },
  [FieldType.Url]: { icon: "link", label: "Link" },
  [FieldType.Checkbox]: { icon: "check", label: "Häkchen" },
  [FieldType.Checklist]: { icon: "done", label: "Checkliste" },
  [FieldType.Media]: { icon: "attachment", label: "Medien" },
  [FieldType.Person]: { icon: "person", label: "Person" },
  [FieldType.Relation]: { icon: "graph", label: "Verknüpfung" },
  [FieldType.Rollup]: { glyph: "Σ", label: "Rollup" },
  [FieldType.CreatedTime]: { icon: "today", label: "Erstellt am" },
  [FieldType.UpdatedTime]: { icon: "today", label: "Geändert am" },
  [FieldType.Formula]: { glyph: "ƒ", label: "Formel" },
};

/** Types that can be switched directly in the column menu — one click is enough. */
export const UMSCHALTBAR: number[] = [
  FieldType.Text, FieldType.Number, FieldType.Date, FieldType.Select,
  FieldType.MultiSelect, FieldType.Url, FieldType.Checkbox, FieldType.Person,
];

/** Types that need a follow-up question before switching.
 *
 * Relation, rollup and formula need configuration and would be a trap as a
 * one-click switch — but leaving them out entirely makes a whole capability
 * unreachable: a **related table could not be created in the UI at all**,
 * although the backend supports it.
 * **Notion does it differently**: "Change type" lists ALL types, and choosing
 * "Relation" asks for the target database. Needing configuration is not a
 * reason to leave something out but a reason to ask. */
export const MIT_RUECKFRAGE: number[] = [
  FieldType.Relation, FieldType.Rollup, FieldType.Formula,
];

/** "Half a formula editor is worse than none." True — which is why
 *  `FormelEditor.tsx` has what separates half an editor from a whole one:
 *  clickable columns, the function list with examples and a **preview on
 *  real rows**. Validation happens server-side (`services/kb_formula.py`
 *  remains the authority). */

/** Aggregates the server knows (`services/kb_query.py`). */
export const AGGREGATE: { key: string; label: string; nurZahl?: boolean }[] = [
  { key: "", label: "Nichts" },
  { key: "count", label: "Anzahl" },
  { key: "count_not_empty", label: "Ausgefüllt" },
  { key: "count_empty", label: "Leer" },
  { key: "count_unique", label: "Verschiedene" },
  { key: "sum", label: "Summe", nurZahl: true },
  { key: "avg", label: "Mittelwert", nurZahl: true },
  { key: "min", label: "Kleinster", nurZahl: true },
  { key: "max", label: "Größter", nurZahl: true },
];

/** Color tone of a chip.
 *
 * Why not just a hash of the word: with six tones and three values a collision
 * is not unlikely (e.g. "Done" and "Idea" got almost the same tone), and a
 * chip you cannot tell apart is not worth its space.
 * So: if the column's option list is available, the **position** in it
 * decides — then neighboring values are guaranteed to differ. Only when there
 * is no list (free values) the hash remains; at least it is stable, so the
 * same value does not change color on every load.
 */
export function plakettenTon(wert: string, optionen?: string[]): number {
  if (optionen?.length) {
    const i = optionen.indexOf(wert);
    if (i >= 0) return (i % 6) + 1;
  }
  let h = 0;
  for (let i = 0; i < wert.length; i++) h = (h * 31 + wert.charCodeAt(i)) >>> 0;
  return (h % 6) + 1;
}
