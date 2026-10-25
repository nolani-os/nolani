/** The collection's columns — inside the opened entry.
 *
 * Why: the table reads the **collection's field registry**, while the detail
 * window used to read the **object type's** `prop_schema`. Two parallel
 * property systems — and the detail view knew the wrong one. Opening a row no
 * longer showed cost, status and due date; they could only be edited in the
 * table row.
 *
 * Placement: directly below the title, like in Notion. Properties are part of
 * the entry, not a side note in a sidebar.
 *
 * If an entry belongs to several collections, the fields are merged (by `key`,
 * first definition wins) and their origin is named above — otherwise nobody
 * would know why twelve rows suddenly appear.
 */
import { useEffect, useState } from "react";
import styles from "./Wissen.module.css";
import geteilt from "../ideas/IdeasApp.module.css";
import { ideasApi } from "../ideas/api";
import { FieldType } from "../ideas/types";
import type { KbField, KbPropDef } from "../ideas/types";
import { PropertyField } from "../ideas/PropertyFields";
import { TYP_MARKE } from "./feldTypen";
import { Icon } from "../../components/Icon";
import { formatZahl, formatZeitpunkt } from "../ideas/format";
import { useTranslation } from "@claraos/core";

/** Field registry → definition for the property editor (as in CollectionView). */
function alsDef(f: KbField): KbPropDef {
  const kind = ({
    [FieldType.Text]: "text", [FieldType.Number]: "number", [FieldType.Date]: "date",
    [FieldType.Select]: "select", [FieldType.MultiSelect]: "multi_select",
    [FieldType.Url]: "url", [FieldType.Checkbox]: "checkbox",
  } as Record<number, KbPropDef["kind"]>)[f.field_type] ?? "text";
  return {
    key: f.key, label: f.name, kind,
    options: (f.type_option?.options as string[]) ?? undefined,
  };
}

/** Types that are computed or related — only DISPLAY here, do not edit. */
const NUR_LESEN = new Set<number>([
  FieldType.Formula, FieldType.Rollup, FieldType.Relation,
  FieldType.CreatedTime, FieldType.UpdatedTime, FieldType.Checklist,
]);

interface Props {
  sammlungen: { id: string; name: string; icon: string | null }[];
  werte: Record<string, unknown>;
  readOnly?: boolean;
  onSpeichern: (key: string, wert: unknown) => void;
}

export function SammlungsFelder({ sammlungen, werte, readOnly, onSpeichern }: Props) {
  const { t } = useTranslation("wissen");
  const [felder, setFelder] = useState<KbField[]>([]);
  const [fehler, setFehler] = useState(false);

  useEffect(() => {
    if (!sammlungen.length) { setFelder([]); return; }
    let weg = false;
    void Promise.all(sammlungen.map((c) =>
      ideasApi.listFields(c.id).catch(() => [] as KbField[])))
      .then((listen) => {
        if (weg) return;
        const gesehen = new Set<string>();
        const zusammen: KbField[] = [];
        for (const liste of listen) {
          for (const f of liste) {
            if (gesehen.has(f.key)) continue;
            gesehen.add(f.key);
            zusammen.push(f);
          }
        }
        setFelder(zusammen);
        setFehler(false);
      })
      .catch(() => { if (!weg) setFehler(true); });
    return () => { weg = true; };
  }, [sammlungen]);

  if (!sammlungen.length) return null;
  if (fehler) {
    return <div className={geteilt.metaHint}>{t("fields.loadFailed")}</div>;
  }
  if (!felder.length) return null;

  return (
    <section className={styles.eintragsFelder}>
      {/* The origin is only named when there are SEVERAL collections —
          then it explains why fields from different sources appear here.
          With a single one, the breadcrumb already shows the name, and it
          would appear twice directly below each other. */}
      {sammlungen.length > 1 && (
        <div className={styles.eintragsHerkunft}>
          {sammlungen.map((c) => (
            <span key={c.id} className={styles.eintragsSammlung}>
              {c.icon ?? "🗂️"} {c.name}
            </span>
          ))}
        </div>
      )}
      {felder.map((f) => {
        const marke = TYP_MARKE[f.field_type];
        const wert = werte?.[f.key];
        return (
          <div key={f.key} className={styles.eintragsFeld}>
            <span className={styles.eintragsName} title={marke?.label}>
              <span className={styles.eintragsMarke}>
                {marke?.icon ? <Icon name={marke.icon} size={13} /> : marke?.glyph}
              </span>
              {f.name}
            </span>
            <span className={styles.eintragsWert}>
              {NUR_LESEN.has(f.field_type) ? (
                // Computed and related values do not belong in an input field —
                // they originate elsewhere and would be a lie here.
                <span className={geteilt.metaHint}>
                  {f.field_type === FieldType.CreatedTime || f.field_type === FieldType.UpdatedTime
                    ? formatZeitpunkt(wert)
                    : typeof wert === "number" ? formatZahl(wert)
                      : wert === null || wert === undefined || wert === "" ? "—" : String(wert)}
                </span>
              ) : (
                <PropertyField def={alsDef(f)} value={wert} readOnly={readOnly}
                               onSave={(v) => onSpeichern(f.key, v)} />
              )}
            </span>
          </div>
        );
      })}
    </section>
  );
}
