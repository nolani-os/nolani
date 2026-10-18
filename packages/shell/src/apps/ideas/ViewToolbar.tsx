/** View toolbar of a collection: named views, filter editor (flat AND/OR
 * group), sorting, grouping.
 * The rules are compiled to SQL server-side (services/kb_query.py); this
 * only assembles the JSON. */
import { useState } from "react";
import { createPortal } from "react-dom";
import styles from "./IdeasApp.module.css";
import { AnsichtsMenue } from "../wissen/AnsichtsMenue";
import { Icon } from "../../components/Icon";
import type { KbField, KbFilterNode, KbView, ViewLayout } from "./types";
import { FieldType } from "./types";

/** Operators per field type: mirror of the whitelist in kb_query.py.
 * Anything added there must also appear here (otherwise it is unusable),
 * but NEVER the other way round: the server remains the authority. */
const OPS: Record<number, { op: string; label: string; noValue?: boolean }[]> = {
  [FieldType.Text]: [
    { op: "contains", label: "enthält" }, { op: "not_contains", label: "enthält nicht" },
    { op: "is", label: "ist" }, { op: "is_not", label: "ist nicht" },
    { op: "starts_with", label: "beginnt mit" }, { op: "ends_with", label: "endet mit" },
    { op: "is_empty", label: "ist leer", noValue: true },
    { op: "is_not_empty", label: "ist nicht leer", noValue: true },
  ],
  [FieldType.Number]: [
    { op: "eq", label: "=" }, { op: "neq", label: "≠" }, { op: "gt", label: ">" },
    { op: "gte", label: "≥" }, { op: "lt", label: "<" }, { op: "lte", label: "≤" },
    { op: "is_empty", label: "ist leer", noValue: true },
    { op: "is_not_empty", label: "ist nicht leer", noValue: true },
  ],
  [FieldType.Date]: [
    { op: "on", label: "am" }, { op: "before", label: "vor" }, { op: "after", label: "nach" },
    { op: "on_or_before", label: "bis einschl." }, { op: "on_or_after", label: "ab" },
    { op: "is_empty", label: "ist leer", noValue: true },
    { op: "is_not_empty", label: "ist nicht leer", noValue: true },
  ],
  [FieldType.Select]: [
    { op: "is", label: "ist" }, { op: "is_not", label: "ist nicht" },
    { op: "is_empty", label: "ist leer", noValue: true },
    { op: "is_not_empty", label: "ist nicht leer", noValue: true },
  ],
  [FieldType.MultiSelect]: [
    { op: "contains_any", label: "enthält eines von" },
    { op: "contains_all", label: "enthält alle" },
    { op: "contains_none", label: "enthält keines von" },
    { op: "is_empty", label: "ist leer", noValue: true },
  ],
  [FieldType.Checkbox]: [
    { op: "is_checked", label: "ist gesetzt", noValue: true },
    { op: "is_unchecked", label: "ist nicht gesetzt", noValue: true },
  ],
  [FieldType.Checklist]: [
    { op: "is_complete", label: "ist vollständig", noValue: true },
    { op: "is_incomplete", label: "ist offen", noValue: true },
  ],
  [FieldType.Relation]: [
    { op: "is_empty", label: "ohne Verknüpfung", noValue: true },
    { op: "is_not_empty", label: "mit Verknüpfung", noValue: true },
  ],
};
OPS[FieldType.Url] = OPS[FieldType.Text];
OPS[FieldType.Rollup] = OPS[FieldType.Number];
OPS[FieldType.CreatedTime] = OPS[FieldType.Date];
OPS[FieldType.UpdatedTime] = OPS[FieldType.Date];
OPS[FieldType.Person] = OPS[FieldType.Select];
OPS[FieldType.Media] = [{ op: "is_empty", label: "ohne Datei", noValue: true },
                        { op: "is_not_empty", label: "mit Datei", noValue: true }];

// The layout list lives in the view menu (`apps/wissen/AnsichtsMenue.tsx`),
// not here. An unused copy would be a second source of truth that drifts
// apart with the next layout.

function opsFor(field?: KbField) {
  return (field && OPS[field.field_type]) || OPS[FieldType.Text];
}

interface Props {
  /** On phones, filter/sort move into the view menu. */
  mobile?: boolean;
  views: KbView[];
  activeView: KbView | null;
  fields: KbField[];
  isOwner: boolean;
  onSelect: (viewId: string) => void;
  onCreate: (name: string, layout: ViewLayout) => void;
  onPatch: (patch: Partial<KbView>) => void;
  onDelete: () => void;
  /** Opens the column list (as in Notion). */
  onSpalten?: () => void;
}

export function ViewToolbar({ mobile, views, activeView, fields, isOwner, onSelect, onCreate, onPatch, onDelete, onSpalten }: Props) {
  const [panel, setPanel] = useState<"none" | "filter" | "sort">("none");
  // Menu of the active view (layout, rename, delete); replaces a second
  // toolbar.
  const [ansichtsMenue, setAnsichtsMenue] = useState<{ x: number; y: number } | null>(null);

  const conditions: KbFilterNode[] =
    (activeView?.filters && "children" in activeView.filters
      ? (activeView.filters.children as KbFilterNode[])
      : []) ?? [];
  const groupOp = (activeView?.filters as KbFilterNode)?.op === "or" ? "or" : "and";
  const sorts = activeView?.sorts ?? [];

  const writeFilters = (children: KbFilterNode[], op = groupOp) =>
    onPatch({ filters: children.length ? { op, children } : ({} as never) });

  const selectFields = fields.filter((f) => f.field_type === FieldType.Select);

  return (
    <div className={styles.viewBar}>
      <div className={styles.viewTabs}>
        {views.map((v) => (
          <button
            key={v.id}
            className={`${styles.viewTab} ${activeView?.id === v.id ? styles.viewTabActive : ""}`}
            onClick={(e) => {
              // A click on the ACTIVE view opens its menu, which holds what
              // would otherwise need a second toolbar.
              if (activeView?.id === v.id && isOwner) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setAnsichtsMenue(ansichtsMenue ? null : { x: r.left, y: r.bottom + 4 });
              } else {
                setAnsichtsMenue(null);
                onSelect(v.id);
              }
            }}
            title={activeView?.id === v.id ? `${v.name} — Menü öffnen` : v.name}
          >
            {v.name}{activeView?.id === v.id && isOwner ? " ⌄" : ""}
          </button>
        ))}
        {isOwner && (
          <button className={styles.viewTab} title="Neue Ansicht"
                  onClick={() => {
                    const name = window.prompt("Name der Ansicht?", "Neue Ansicht");
                    if (name) onCreate(name, "table");
                  }}>＋</button>
        )}

        {/* Filter and sort sit in the SAME row as the views. Layout, rename and
            delete live in the view's menu; otherwise the layout would be both
            a property of the view AND a separate picker next to it, two paths
            to the same thing taking two rows of height. */}
        {activeView && isOwner && !mobile && (
          <span className={styles.viewBarRechts}>
            <button className={`${styles.btnSecondary} ${conditions.length ? styles.badgeOn : ""}`}
                    title="Filter"
                    onClick={() => setPanel(panel === "filter" ? "none" : "filter")}>
              ⚙ Filter{conditions.length ? ` (${conditions.length})` : ""}
            </button>
            <button className={`${styles.btnSecondary} ${sorts.length ? styles.badgeOn : ""}`}
                    title="Sortierung"
                    onClick={() => setPanel(panel === "sort" ? "none" : "sort")}>
              ↕ Sortierung{sorts.length ? ` (${sorts.length})` : ""}
            </button>
          </span>
        )}
      </div>

      {ansichtsMenue && activeView && isOwner && createPortal((
        <AnsichtsMenue
          aktuell={activeView.layout}
          name={activeView.name}
          loeschbar={views.length > 1}
          stil={{ position: "fixed", left: ansichtsMenue.x, top: ansichtsMenue.y }}
          onSchliessen={() => setAnsichtsMenue(null)}
          onSpalten={onSpalten}
          onFilter={mobile ? () => setPanel("filter") : undefined}
          onSortierung={mobile ? () => setPanel("sort") : undefined}
          filterAnzahl={conditions.length}
          sortAnzahl={sorts.length}
          onUmbenennen={(name) => onPatch({ name })}
          onLoeschen={() => { setAnsichtsMenue(null); onDelete(); }}
          onLayout={(layout) => {
            const patch: Partial<KbView> = { layout };
            // Calendar needs a date field, board needs a select column
            if (layout === "calendar" && !activeView.layout_setting?.date_field) {
              const d = fields.find((f) => f.field_type === FieldType.Date);
              if (d) patch.layout_setting = { ...activeView.layout_setting, date_field: d.key };
            }
            // Timeline needs a start (and optionally an end); prefill both
            if (layout === "timeline" && !activeView.layout_setting?.start_field) {
              const ds = fields.filter((f) => f.field_type === FieldType.Date);
              if (ds[0]) {
                patch.layout_setting = {
                  ...activeView.layout_setting,
                  start_field: ds[0].key, end_field: ds[1]?.key ?? ds[0].key,
                };
              }
            }
            // Important: the board can ONLY group by a select column; its
            // columns ARE the options. The table may also group by date,
            // checkbox or multi-select; if the view holds such a grouping, the
            // board would silently fall back to the gallery. So check not just
            // "is empty" but "fits".
            if (layout === "board") {
              const jetzt = String(activeView.group_setting?.key ?? "");
              const passt = selectFields.some((f) => f.key === jetzt);
              if (!passt && selectFields[0]) patch.group_setting = { key: selectFields[0].key };
            }
            onPatch(patch);
          }}
        />
      ), document.body)}

      {panel === "filter" && activeView && (
        <div className={styles.viewPanel}>
          <div className={styles.viewPanelHead}>
            <span>Zeige Einträge, für die</span>
            <select className={styles.input} value={groupOp}
                    onChange={(e) => writeFilters(conditions, e.target.value)}>
              <option value="and">alle</option>
              <option value="or">mindestens eine</option>
            </select>
            <span>Regel(n) zutreffen:</span>
          </div>
          {conditions.map((c, i) => {
            const field = fields.find((f) => f.key === c.key);
            const ops = opsFor(field);
            const opDef = ops.find((o) => o.op === c.op);
            return (
              <div key={i} className={styles.filterRow}>
                <select className={styles.input} value={c.key ?? ""}
                        onChange={(e) => {
                          const nf = fields.find((f) => f.key === e.target.value);
                          const next = [...conditions];
                          next[i] = { key: e.target.value, op: opsFor(nf)[0].op, value: "" };
                          writeFilters(next);
                        }}>
                  {fields.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
                </select>
                <select className={styles.input} value={c.op}
                        onChange={(e) => {
                          const next = [...conditions];
                          next[i] = { ...c, op: e.target.value };
                          writeFilters(next);
                        }}>
                  {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                </select>
                {!opDef?.noValue && (
                  field?.field_type === FieldType.Select
                    ? (
                      <select className={styles.input} value={String(c.value ?? "")}
                              onChange={(e) => {
                                const next = [...conditions];
                                next[i] = { ...c, value: e.target.value };
                                writeFilters(next);
                              }}>
                        <option value="">—</option>
                        {((field.type_option?.options as string[]) ?? []).map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={styles.input}
                        type={field?.field_type === FieldType.Number ? "number"
                          : field?.field_type === FieldType.Date ? "date" : "text"}
                        defaultValue={String(c.value ?? "")}
                        placeholder="Wert"
                        onBlur={(e) => {
                          const next = [...conditions];
                          const raw = e.target.value;
                          next[i] = {
                            ...c,
                            value: field?.field_type === FieldType.Number ? Number(raw) : raw,
                          };
                          writeFilters(next);
                        }}
                      />
                    )
                )}
                <button className={styles.linkRemove} title="Regel entfernen"
                        onClick={() => writeFilters(conditions.filter((_, j) => j !== i))}><Icon name="close" size={14} title="Schließen" /></button>
              </div>
            );
          })}
          <button className={styles.btnSecondary}
                  disabled={!fields.length}
                  onClick={() => {
                    const f = fields[0];
                    writeFilters([...conditions, { key: f.key, op: opsFor(f)[0].op, value: "" }]);
                  }}>＋ Regel</button>
        </div>
      )}

      {panel === "sort" && activeView && (
        <div className={styles.viewPanel}>
          {sorts.map((s, i) => (
            <div key={i} className={styles.filterRow}>
              <select className={styles.input} value={s.key}
                      onChange={(e) => {
                        const next = [...sorts];
                        next[i] = { ...s, key: e.target.value };
                        onPatch({ sorts: next });
                      }}>
                {fields.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
              </select>
              <select className={styles.input} value={s.dir}
                      onChange={(e) => {
                        const next = [...sorts];
                        next[i] = { ...s, dir: e.target.value as "asc" | "desc" };
                        onPatch({ sorts: next });
                      }}>
                <option value="asc">aufsteigend</option>
                <option value="desc">absteigend</option>
              </select>
              <button className={styles.linkRemove} title="Sortierung entfernen"
                      onClick={() => onPatch({ sorts: sorts.filter((_, j) => j !== i) })}><Icon name="close" size={14} title="Schließen" /></button>
            </div>
          ))}
          <button className={styles.btnSecondary} disabled={!fields.length}
                  onClick={() => onPatch({ sorts: [...sorts, { key: fields[0].key, dir: "asc" }] })}>
            ＋ Sortierung
          </button>
          {activeView.layout === "board" && (
            <div className={styles.filterRow}>
              <span className={styles.metaHint}>Gruppieren nach</span>
              <select className={styles.input}
                      value={String(activeView.group_setting?.key ?? "")}
                      onChange={(e) => onPatch({ group_setting: { key: e.target.value } })}>
                {selectFields.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
              </select>
            </div>
          )}
          {activeView.layout === "timeline" && (
            <>
              <div className={styles.filterRow}>
                <span className={styles.metaHint}>Beginn</span>
                <select className={styles.input}
                        value={String(activeView.layout_setting?.start_field ?? "")}
                        onChange={(e) => onPatch({ layout_setting: { ...activeView.layout_setting, start_field: e.target.value } })}>
                  {fields.filter((f) => f.field_type === FieldType.Date)
                    .map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
                </select>
              </div>
              <div className={styles.filterRow}>
                <span className={styles.metaHint}>Ende</span>
                <select className={styles.input}
                        value={String(activeView.layout_setting?.end_field ?? "")}
                        onChange={(e) => onPatch({ layout_setting: { ...activeView.layout_setting, end_field: e.target.value } })}>
                  {fields.filter((f) => f.field_type === FieldType.Date)
                    .map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
                </select>
              </div>
            </>
          )}
          {activeView.layout === "calendar" && (
            <div className={styles.filterRow}>
              <span className={styles.metaHint}>Datumsfeld</span>
              <select className={styles.input}
                      value={String(activeView.layout_setting?.date_field ?? "")}
                      onChange={(e) => onPatch({ layout_setting: { ...activeView.layout_setting, date_field: e.target.value } })}>
                {fields.filter((f) => f.field_type === FieldType.Date)
                  .map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
