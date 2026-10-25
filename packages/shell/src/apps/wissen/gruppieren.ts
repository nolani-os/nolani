/** Bundle rows into collapsible groups.
 *
 * Why at all: in the board, grouping is not a choice but the layout itself.
 * To see "what is open, what is in progress, what is done" in the table, you
 * would otherwise have to sort and count yourself. The presentation is
 * deliberately modeled on **our Planner**: heading, counter as a chip,
 * collapsible.
 *
 * Why the groups are built HERE and not on the server: `services/kb_query.py`
 * compiles filter and sort to SQL — the row list arrives already sorted.
 * Grouping is purely reordering the same list; a second path via the server
 * would only create a second truth about the order. This holds as long as the
 * table loads all rows — with paginated loading, grouping would have to move
 * along.
 *
 * NOT groupable: number (Notion builds value ranges for that — one group per
 * amount would be useless), relation, rollup, formula, checklist, media.
 * Better not to offer it at all than to produce one group per row.
 */
import { FieldType } from "../ideas/types";
import type { KbField, KbRow } from "../ideas/types";
import { i18n } from "@claraos/core";

export interface Gruppe {
  /** Unique key (React key and collapse state). Do NOT use `label`: if the
   *  column is called "Status" and one of its options "Ohne Status" (no status),
   *  the empty group would carry the same text. */
  schluessel: string;
  /** Heading of the group. */
  label: string;
  /** Raw value for the chip; `null` = the group of empty values. */
  wert: string | null;
  zeilen: KbRow[];
}

/** Field types for which "Group" appears in the column menu. */
const GRUPPIERBAR: number[] = [
  FieldType.Select, FieldType.MultiSelect, FieldType.Checkbox, FieldType.Person,
  FieldType.Text, FieldType.Url, FieldType.Date,
  FieldType.CreatedTime, FieldType.UpdatedTime,
];

export function gruppierbar(f: KbField): boolean {
  return GRUPPIERBAR.includes(f.field_type);
}

/** Date buckets like in the Planner: ordered by urgency, not alphabetically.
 *
 * Note: ONE word deliberately differs from the Planner: there the first bucket
 * is labeled "overdue", because every task has a due date. Here any
 * date column can be grouped — "Bought on" or "Modified" would then all land
 * under "overdue", which is simply wrong. "Vergangen" (past) fits both;
 * otherwise "Done" and "Overdue" can end up side by side in the same row. */
// Internal bucket keys — the label is looked up only for display, so order,
// sorting and the remembered collapse state do not depend on the language.
const DATUM_ORDNUNG = ["vergangen", "heute", "morgen", "woche", "spaeter"];

function tagesSchluessel(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function datumsKorb(iso: unknown): string | null {
  if (!iso) return null;
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return null;
  const heute = new Date();
  const morgen = new Date();
  morgen.setDate(morgen.getDate() + 1);
  if (tagesSchluessel(d) === tagesSchluessel(heute)) return "heute";
  if (tagesSchluessel(d) === tagesSchluessel(morgen)) return "morgen";
  // Compare at day level, not milliseconds — otherwise "this morning" slips
  // into the past as soon as it is afternoon.
  const tagAnfang = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate());
  if (d.getTime() < tagAnfang.getTime()) return "vergangen";
  const inSieben = new Date(tagAnfang);
  inSieben.setDate(inSieben.getDate() + 7);
  return d.getTime() < inSieben.getTime() ? "woche" : "spaeter";
}

/** Value(s) of a row in this column — several only for multi-select. */
function werteVon(row: KbRow, feld: KbField): (string | null)[] {
  if (feld.field_type === FieldType.CreatedTime) return [datumsKorb(row.created_at)];
  if (feld.field_type === FieldType.UpdatedTime) return [datumsKorb(row.updated_at)];
  const roh = row.properties?.[feld.key];
  if (feld.field_type === FieldType.Date) return [datumsKorb(roh)];
  if (feld.field_type === FieldType.Checkbox) return [roh ? "erledigt" : "offen"];
  if (feld.field_type === FieldType.MultiSelect) {
    const arr = Array.isArray(roh) ? roh.map(String).filter(Boolean) : [];
    // Like tags in the Planner: a row with three tags appears in three groups.
    // That is intended — the counter counts occurrences, not rows.
    return arr.length ? arr : [null];
  }
  const s = roh === null || roh === undefined ? "" : String(roh).trim();
  return [s || null];
}

/** Display name of a group: date and checkbox buckets are internal keys,
 *  everything else is the user's own value. */
function gruppenName(w: string | null, feld: KbField): string {
  if (w === null) return i18n.t("wissen:group.without", { name: feld.name });
  const intern = feld.field_type === FieldType.Checkbox || feld.field_type === FieldType.Date
    || feld.field_type === FieldType.CreatedTime || feld.field_type === FieldType.UpdatedTime;
  return intern ? i18n.t(`wissen:group.${w}`) : w;
}

/** Sort key of a group. The empty group always goes last. */
function rang(wert: string | null, feld: KbField, optionen: string[]): number {
  if (wert === null) return 1e6;
  if (feld.field_type === FieldType.Checkbox) return wert === "offen" ? 0 : 1;
  if (feld.field_type === FieldType.Date || feld.field_type === FieldType.CreatedTime
      || feld.field_type === FieldType.UpdatedTime) {
    const i = DATUM_ORDNUNG.indexOf(wert);
    return i >= 0 ? i : DATUM_ORDNUNG.length;
  }
  // Selects follow the option list, NOT the alphabet — just like the chip
  // color (`plakettenTon`). Otherwise "Done" would come before "Idea" before
  // "In progress", and the table would tell a different order than the board.
  const i = optionen.indexOf(wert);
  return i >= 0 ? i : 1e5;
}

export function gruppiere(rows: KbRow[], feld: KbField): Gruppe[] {
  const optionen = (feld.type_option?.options as string[]) ?? [];
  const nachWert = new Map<string, Gruppe>();
  for (const row of rows) {
    for (const w of werteVon(row, feld)) {
      const schluessel = w === null ? " leer" : `w:${w}`;
      let g = nachWert.get(schluessel);
      if (!g) {
        g = { schluessel, label: gruppenName(w, feld), wert: w, zeilen: [] };
        nachWert.set(schluessel, g);
      }
      g.zeilen.push(row);
    }
  }
  return [...nachWert.values()].sort((a, b) => {
    const d = rang(a.wert, feld, optionen) - rang(b.wert, feld, optionen);
    return d !== 0 ? d : a.label.localeCompare(b.label, i18n.resolvedLanguage ?? i18n.language);
  });
}
