/** Collection — Notion-like database view:
 * named views (table/gallery/board/calendar/list) with filters/sorts stored
 * on the server, a field registry instead of prop_schema, relation and rollup
 * cells. Filters/sorts are NOT evaluated here but compiled to SQL by the
 * backend (services/kb_query.py) — so the row list arrives from the server
 * already sorted/filtered.
 * Deliberately WITHOUT TanStack — a lean home-grown table is enough. */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "../IdeasApp.module.css";
import { Icon } from "../../../components/Icon";
import { ideasApi } from "../api";
import type { KbCollection, KbField, KbObjectSlim, KbPropDef, KbRow, KbType, KbView } from "../types";
import { FieldType } from "../types";
import { PropertyField, propDisplay } from "../PropertyFields";
import { formatZahl, formatZeitpunkt } from "../format";
import { ViewToolbar } from "../ViewToolbar";
import tab from "../../wissen/Wissen.module.css";
import { Plakette, Plaketten } from "../../wissen/Plakette";
import { SpaltenMenue } from "../../wissen/SpaltenMenue";
import { FeldEinrichten } from "../../wissen/FeldEinrichten";
import { FormelEditor } from "../../wissen/FormelEditor";
import { SpaltenPanel } from "../../wissen/SpaltenPanel";
import { PopupMenu } from "../../../components/PopupMenu";
import { TYP_MARKE, AGGREGATE, MIT_RUECKFRAGE, plakettenTon } from "../../wissen/feldTypen";
import { gruppiere } from "../../wissen/gruppieren";
import { Leerzustand } from "../../../components/Leerzustand";
import { SammlungTeilen } from "../../wissen/SammlungTeilen";

interface Props {
  collection: KbCollection;
  types: KbType[];
  currentUser: string;
  /** mobile: gallery as default (the table stays reachable via the view) */
  mobile?: boolean;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
  /** On phones the back link sits IN the title bar, not in a separate
   *  row above it — that row cost 40 px out of 900. */
  onBack?: () => void;
}

/** Field registry → property editor definition (PropertyFields knows "kind"). */
function fieldToDef(f: KbField): KbPropDef {
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

/** Cells that PropertyFields does not cover (newer field types). */
function isSpecial(f: KbField) {
  return f.field_type === FieldType.Relation || f.field_type === FieldType.Rollup
    || f.field_type === FieldType.Formula
    || f.field_type === FieldType.Checklist || f.field_type === FieldType.CreatedTime
    || f.field_type === FieldType.UpdatedTime;
}

export function CollectionView({ collection, types, currentUser, mobile, onOpen, onChanged, onDeleted, onBack }: Props) {
  const [rows, setRows] = useState<KbRow[]>([]);
  const [fields, setFields] = useState<KbField[]>([]);
  const [views, setViews] = useState<KbView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [relEdit, setRelEdit] = useState<{ rowId: string; key: string } | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  /** The empty state offers "create first entry" — and for that it has
   *  to reach the field that accepts the entry. */
  const neuFeld = useRef<HTMLInputElement>(null);
  // Which column menu is open? Plus the computed footer values.
  const [menueKey, setMenueKey] = useState<string | null>(null);
  // Screen position of the header button — the menu does NOT hang inside the <th>
  // but is attached to the document via a portal (see below).
  const [menuePos, setMenuePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [fuss, setFuss] = useState<Record<string, number | null>>({});
  // Relation/rollup need a confirmation before the type changes.
  const [einrichten, setEinrichten] = useState<{ feld: KbField; typ: number } | null>(null);
  const [spaltenPanel, setSpaltenPanel] = useState(false);
  const [vorlagenMenue, setVorlagenMenue] = useState<{ x: number; y: number } | null>(null);
  /** id → title of linked entries. Important: Notion shows the NAMES of
   *  the linked pages in a relation column; we used to show "🔗 3" — a number
   *  that says nothing about the content. Fetched once per target collection,
   *  not per cell. */
  const [relTitel, setRelTitel] = useState<Record<string, string>>({});
  // Which select cell is currently expanded? ("<row>:<column>")
  const [bearbeitet, setBearbeitet] = useState<string | null>(null);
  // Collapsed groups. Important: deliberately kept ONLY in the window and not
  // stored in the view: otherwise every expand/collapse would be a PATCH on the
  // view — i.e. reloading all rows for a purely visual matter, and with two
  // people in the same shared collection one would collapse the table for the
  // other.
  const [zugeklappt, setZugeklappt] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const isOwner = collection.owner === currentUser;
  /** Whoever the server allows may write — the owner or a member with
   *  write permission (collection sharing). Deleting, locking and sharing
   *  remain with the owner (isOwner). */
  const darfSchreiben = collection.can_edit ?? isOwner;
  /** Notion: "lock database". Protects the STRUCTURE, not the content —
   *  keep writing yes, restructuring no. */
  const gesperrt = collection.settings?.gesperrt === true;
  const darfUmbauen = darfSchreiben && !gesperrt;
  const [teilenOffen, setTeilenOffen] = useState(false);
  const zeilenVorlagen = collection.settings?.zeilen_vorlagen ?? [];
  const type = types.find((t) => t.id === (collection.default_type ?? "note"));

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  // Load views (the server creates a default table if needed)
  useEffect(() => {
    let cancelled = false;
    ideasApi.listViews(collection.id).then((vs) => {
      if (cancelled) return;
      setViews(vs);
      setActiveViewId((cur) => (cur && vs.some((v) => v.id === cur) ? cur : vs[0]?.id ?? null));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [collection.id]);

  // Rows + fields according to the active view's rules (filtered server-side)
  useEffect(() => {
    let cancelled = false;
    ideasApi.queryRows(collection.id, activeViewId ?? undefined)
      .then((r) => {
        if (cancelled) return;
        setRows(r.rows);
        setFields(r.fields);
        setError(null);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [collection.id, activeViewId, reloadTick]);

  const activeView = views.find((v) => v.id === activeViewId) ?? null;
  const layout = activeView?.layout ?? (mobile ? "gallery" : "table");
  const visibleFields = useMemo(
    () => fields.filter((f) => activeView?.field_settings?.[f.key]?.visible !== false),
    [fields, activeView],
  );
  const groupKey = String(activeView?.group_setting?.key ?? "");
  const groupField = fields.find((f) => f.key === groupKey && f.field_type === FieldType.Select);
  // Grouping in the TABLE. Unlike the board, the table accepts any groupable
  // column (including checkbox, date, multi-select) — the board needs select
  // columns, because its columns ARE the options.
  const tabellenGruppenFeld = fields.find((f) => f.key === groupKey);
  const gruppen = useMemo(
    () => (layout === "table" && tabellenGruppenFeld ? gruppiere(rows, tabellenGruppenFeld) : null),
    [layout, rows, tabellenGruppenFeld],
  );
  // Notion parity: pinning, row colour.
  const fixiertBis = String(activeView?.layout_setting?.fixiert_bis ?? "");
  /** Visible columns up to and including the pinned one — those stay in place. */
  const fixierteKeys = useMemo(() => {
    if (!fixiertBis) return new Set<string>();
    const raus = new Set<string>();
    for (const f of visibleFields) { raus.add(f.key); if (f.key === fixiertBis) break; }
    return raus;
  }, [visibleFields, fixiertBis]);
  const faerbenNach = String(activeView?.layout_setting?.faerben_nach ?? "");
  const faerbeFeld = fields.find((f) => f.key === faerbenNach && f.field_type === FieldType.Select);

  const dateKey = String(activeView?.layout_setting?.date_field ?? "");
  const startKey = String(activeView?.layout_setting?.start_field ?? "");
  const endKey = String(activeView?.layout_setting?.end_field ?? "");

  /** Group heading as a coloured badge — only where the value really is an
   *  option. A date bucket or "open/done" has no option colour. */
  const gruppenPlakette = (wert: string | null) =>
    !!tabellenGruppenFeld && wert !== null
    && (tabellenGruppenFeld.field_type === FieldType.Select
        || tabellenGruppenFeld.field_type === FieldType.MultiSelect);

  // View or group column changed ⇒ old collapse state is meaningless
  // (the groups have different names) and might accidentally match new names.
  useEffect(() => { setZugeklappt(new Set()); }, [activeViewId, groupKey]);

  const patchView = async (patch: Partial<KbView>) => {
    if (!activeView) return;
    try {
      const v = await ideasApi.patchView(collection.id, activeView.id, patch);
      setViews((prev) => prev.map((x) => (x.id === v.id ? v : x)));
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ── Editing columns ──────────────────────────────────────────────────────
  const feldPatch = async (f: KbField,
                           patch: { name?: string; field_type?: number;
                                    type_option?: Record<string, unknown> }) => {
    try {
      await ideasApi.patchField(collection.id, f.id, patch);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const feldLoeschen = async (f: KbField) => {
    try {
      await ideasApi.deleteField(collection.id, f.id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Duplicate a column including its values (Notion: "duplicate property").
   *  Important: the values are copied here in the browser because the table has
   *  loaded all rows anyway. For a collection with thousands of rows this would
   *  belong on the server — for a household it is just right. */
  const spalteDuplizieren = async (f: KbField) => {
    try {
      const neu = `${f.key}_kopie_${Date.now().toString(36).slice(-4)}`;
      await ideasApi.createField(collection.id, {
        key: neu, name: `${f.name} (Kopie)`,
        field_type: f.field_type, type_option: f.type_option ?? undefined,
      });
      const mitWert = rows.filter((r) => r.properties?.[f.key] !== undefined
                                      && r.properties?.[f.key] !== null);
      await Promise.all(mitWert.map((r) => ideasApi.patchObject(r.id, {
        properties: { ...(r.properties ?? {}), [neu]: r.properties![f.key] },
      })));
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const spalteEinfuegen = async (_nachbar: KbField, _seite: "links" | "rechts") => {
    // Deliberately simple: a new column as text with a numbered name. The registry
    // allows a `position` — fine-grained ordering comes with drag-to-reorder,
    // which is still missing here.
    const n = fields.length + 1;
    try {
      await ideasApi.createField(collection.id, {
        key: `feld_${Date.now().toString(36)}`,
        name: `Spalte ${n}`,
        field_type: FieldType.Text,
      });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Hidden columns — they must stay reachable, otherwise they are lost.
  const versteckte = useMemo(
    () => fields.filter((f) => activeView?.field_settings?.[f.key]?.visible === false),
    [fields, activeView]);

  // ── Footer values ────────────────────────────────────────────────────────
  // Important: computed server-side, under the view's filters — not summed over
  // the loaded rows. Otherwise a filtered or paginated collection would show a
  // wrong total.
  useEffect(() => {
    const gefragt = visibleFields
      .map((f) => [f.key, activeView?.field_settings?.[f.key]?.agg] as const)
      .filter(([, agg]) => !!agg);
    if (!gefragt.length) { setFuss({}); return; }
    let abgebrochen = false;
    void Promise.all(gefragt.map(async ([key, agg]) => {
      try {
        const r = await ideasApi.aggregate(collection.id, key, String(agg), activeView?.id);
        return [key, r.value] as const;
      } catch {
        return [key, null] as const;
      }
    })).then((paare) => {
      if (!abgebrochen) setFuss(Object.fromEntries(paare));
    });
    return () => { abgebrochen = true; };
  }, [collection.id, activeView, visibleFields, rows.length]);

  // Load target collection titles as soon as there are relation columns.
  useEffect(() => {
    const ziele = [...new Set(fields
      .filter((f) => f.field_type === FieldType.Relation)
      .map((f) => String(f.type_option?.target_collection ?? ""))
      .filter(Boolean))];
    if (!ziele.length) return;
    let weg = false;
    void Promise.all(ziele.map((z) => ideasApi.queryRows(z).catch(() => ({ rows: [] }))))
      .then((antworten) => {
        if (weg) return;
        const karte: Record<string, string> = {};
        for (const a of antworten) for (const r of a.rows) karte[r.id] = r.title;
        setRelTitel((alt) => ({ ...alt, ...karte }));
      });
    return () => { weg = true; };
  }, [fields]);

  /** Create a new entry — optionally from a row template.
   *  Important: Notion has the split button "New ⌄" for this: the same action,
   *  but pre-filled. The gain is not the typing but not having to go through
   *  the columns one by one. */
  const addEntry = async (vorlage?: { name: string; properties: Record<string, unknown> }) => {
    const t = newTitle.trim() || (vorlage ? vorlage.name : "");
    if (!t) return;
    const obj = await ideasApi.createObject({
      type: collection.default_type ?? "note", title: t, visibility: collection.visibility,
    });
    if (vorlage && Object.keys(vorlage.properties).length) {
      await ideasApi.patchObject(obj.id, { properties: vorlage.properties });
    }
    await ideasApi.addToCollection(collection.id, obj.id, rows.length + 1);
    setNewTitle("");
    reload();
    onChanged();
  };

  /** Turn an existing row into a template — the only authoring UI we need
   *  for this: what you want already exists somewhere. */
  const alsVorlageSichern = async (row: KbRow) => {
    const name = window.prompt("Name der Vorlage?", row.title);
    if (!name) return;
    const props = { ...(row.properties ?? {}) };
    const neu = [...zeilenVorlagen, { name: name.trim(), properties: props }].slice(-8);
    await ideasApi.patchCollection(collection.id, {
      settings: { ...(collection.settings ?? {}), zeilen_vorlagen: neu },
    });
    onChanged();
  };

  const saveProp = async (row: KbRow, key: string, value: unknown) => {
    const props = { ...(row.properties ?? {}) };
    if (value === null) delete props[key];
    else props[key] = value;
    setRows((prev) => prev.map((o) => (o.id === row.id ? { ...o, properties: props } : o)));
    try {
      await ideasApi.patchObject(row.id, { properties: props });
    } catch {
      reload();
    }
  };

  const cell = (row: KbRow, f: KbField) => {
    if (f.field_type === FieldType.Formula) {
      const v = row.formulas?.[f.key];
      const bad = typeof v === "string" && v.startsWith("⚠");
      return (
        <span className={bad ? styles.formulaError : styles.cellMuted}
              title={bad ? String(v) : "Formel-Ergebnis (berechnet)"}>
          {v === null || v === undefined || v === "" ? "—" : String(v)}
        </span>
      );
    }
    if (f.field_type === FieldType.Rollup) {
      const v = row.rollups?.[f.key];
      return <span className={styles.cellMuted}>{v === null || v === undefined ? "—" : v}</span>;
    }
    if (f.field_type === FieldType.CreatedTime || f.field_type === FieldType.UpdatedTime) {
      const iso = f.field_type === FieldType.CreatedTime ? row.created_at : row.updated_at;
      return <span className={styles.cellMuted}>{formatZeitpunkt(iso)}</span>;
    }
    if (f.field_type === FieldType.Checklist) {
      const cl = (row.properties?.[f.key] ?? {}) as { percentage?: number };
      return <span className={styles.cellMuted}>{cl.percentage ? `${cl.percentage} %` : "—"}</span>;
    }
    if (f.field_type === FieldType.Relation) {
      const ids = (row.properties?.[f.key] as string[]) ?? [];
      const namen = ids.map((id) => relTitel[id]).filter(Boolean);
      return (
        <button className={styles.relCell} title="Verknüpfungen bearbeiten"
                disabled={!darfSchreiben}
                onClick={() => setRelEdit({ rowId: row.id, key: f.key })}>
          {ids.length === 0 ? "＋"
            : activeView?.field_settings?.[f.key]?.anzeige === "anzahl"
              ? `🔗 ${ids.length}`
              : namen.length ? <Plaketten werte={namen} optionen={undefined} />
              : `🔗 ${ids.length}`}
        </button>
      );
    }
    // Important: select values are BADGES, not select inputs.
    // Previously every such cell contained a `<select>` with an arrow — six rows
    // produced two dozen controls, and the eye saw a form instead of data.
    // Clicking still works: the click opens the field.
    const schreibbar = row.can_edit ?? row.owner === currentUser;
    if (f.field_type === FieldType.Select && bearbeitet !== `${row.id}:${f.key}`) {
      const v = String(row.properties?.[f.key] ?? "");
      return (
        <button className={styles.cellTitle} style={{ fontWeight: 400 }}
                disabled={!schreibbar}
                title={schreibbar ? "Zum Ändern klicken" : undefined}
                onClick={() => setBearbeitet(`${row.id}:${f.key}`)}>
          {v ? <Plakette wert={v} optionen={(f.type_option?.options as string[]) ?? undefined} />
             : <span className={tab.leerZeichen}>—</span>}
        </button>
      );
    }
    if (f.field_type === FieldType.MultiSelect && bearbeitet !== `${row.id}:${f.key}`) {
      const werte = (row.properties?.[f.key] as string[]) ?? [];
      return (
        <button className={styles.cellTitle} style={{ fontWeight: 400 }}
                disabled={!schreibbar}
                title={schreibbar ? "Zum Ändern klicken" : undefined}
                onClick={() => setBearbeitet(`${row.id}:${f.key}`)}>
          <Plaketten werte={Array.isArray(werte) ? werte : []}
                     optionen={(f.type_option?.options as string[]) ?? undefined} />
        </button>
      );
    }
    return (
      <PropertyField def={fieldToDef(f)} value={row.properties?.[f.key]} compact
                     umbruch={activeView?.field_settings?.[f.key]?.umbruch === true}
                     readOnly={!schreibbar}
                     onSave={(v) => { void saveProp(row, f.key, v); setBearbeitet(null); }} />
    );
  };

  /** ONE empty state for all layouts of this collection. Previously four
   *  places showed the same grey sentence "Empty so far." — four sentences, no
   *  offer. Filtered is also something other than empty: then it is not the
   *  content that is missing, the rule just does not match, and the next action
   *  is "reset filters". */
  const gefiltert = !!activeView && Object.keys(activeView.filters ?? {}).length > 0;
  const leerAnzeige = () => (gefiltert ? (
    <Leerzustand
      symbol="⚙"
      titel="Kein Eintrag passt zu dieser Ansicht"
      hinweis={`„${activeView?.name}" filtert die Sammlung. Die Einträge sind da — sie erfüllen nur die Regeln nicht.`}
      aktionen={darfSchreiben ? [{
        label: "Filter zurücksetzen", zweitrangig: true,
        onClick: () => void patchView({ filters: {} as never }),
      }] : []}
    />
  ) : (
    <Leerzustand
      symbol={collection.icon ?? "🗂️"}
      titel="Noch kein Eintrag"
      hinweis={collection.description || "Hier sammelt sich, was zu dieser Sammlung gehört."}
      aktionen={darfSchreiben ? [{
        label: "＋ Ersten Eintrag anlegen",
        onClick: () => neuFeld.current?.focus(),
      }] : []}
    />
  ));

  /** The same row as a card (mobile) — also flat or inside a group. */
  const karte = (o: KbRow) => (
    <button key={o.id} className={styles.rowCard} onClick={() => onOpen(o.id)}>
      <div className={styles.rowCardTitle}>{o.icon ? `${o.icon} ` : ""}{o.title}</div>
      <div className={styles.rowCardProps}>
        {visibleFields.slice(0, 4).map((f) => {
          const val = f.field_type === FieldType.Rollup
            ? o.rollups?.[f.key]
            : f.field_type === FieldType.Formula
              ? o.formulas?.[f.key]
              : f.field_type === FieldType.Relation
                ? `${((o.properties?.[f.key] as string[]) ?? []).length} verknüpft`
                : propDisplay(fieldToDef(f), o.properties?.[f.key]);
          if (val === undefined || val === null || val === "" || val === "—") return null;
          return (
            <span key={f.key} className={styles.rowCardProp}>
              <b>{f.name}:</b> {String(val)}
            </span>
          );
        })}
      </div>
    </button>
  );

  /** One data row — used both flat and inside a group. */
  const zeile = (o: KbRow) => {
    // Row colour from a select column (Notion: "conditional colour"; here
    // deliberately the simple form: ONE column sets the tone).
    const ton = faerbeFeld
      ? plakettenTon(String(o.properties?.[faerbeFeld.key] ?? ""),
                     (faerbeFeld.type_option?.options as string[]) ?? undefined)
      : 0;
    return (
    <tr key={o.id} className={ton && o.properties?.[faerbeFeld!.key] ? tab[`zeilenTon${ton}`] : ""}>
      <td className={fixiertBis ? tab.fixiert : ""}>
        <button className={styles.cellTitle} onClick={() => onOpen(o.id)}>
          {o.icon ? `${o.icon} ` : ""}{o.title}
        </button>
      </td>
      {visibleFields.map((f) => (
        <td key={f.key} className={fixierteKeys.has(f.key) ? tab.fixiert : ""}>{cell(o, f)}</td>
      ))}
      <td className={styles.cellMuted}>{formatZeitpunkt(o.updated_at)}</td>
      {darfSchreiben && (
        <td>
          {/* Only on hover — a permanently visible remove button in
              every row is visual noise and invites misclicks. */}
          <button className={`${styles.linkRemove} ${tab.zeilenAktion}`}
                  title="Diese Zeile als Vorlage sichern"
                  onClick={() => void alsVorlageSichern(o)}>⧉</button>
          <button className={`${styles.linkRemove} ${tab.zeilenAktion}`}
                  title="Aus Sammlung entfernen"
                  onClick={async () => {
                    await ideasApi.removeFromCollection(collection.id, o.id);
                    reload();
                  }}>×</button>
        </td>
      )}
    </tr>
    );
  };

  return (
    <div className={`${styles.collView}${layout === "table" && !mobile ? ` ${styles.collViewTabelle}` : ""}`}>
      <div className={styles.collHead}>
        {mobile && onBack && (
          <button className={tab.zurueckKnopf} title="Zurück zu den Sammlungen"
                  onClick={onBack}>‹</button>
        )}
        <h3>{collection.icon ?? "🗂️"} {collection.name}
          {collection.visibility === "family" && <span title="Mit Familie geteilt"> 👪</span>}
        </h3>
        <div className={styles.collHeadRight}>
          {!isOwner && collection.permission && (
            <span className={styles.metaHint} title={`Geteilt von ${collection.owner}`}>
              von {collection.owner}{collection.permission === "read" ? " · nur lesen" : ""}
            </span>
          )}
          <span className={styles.metaHint}>{type ? `${type.icon ?? ""} ${type.name}` : ""}</span>
          <button className={tab.schloss}
                  title={isOwner ? "Teilen — wer hat Zugriff?" : "Wer hat Zugriff?"}
                  onClick={() => setTeilenOffen(true)}><Icon name="people" size={15} /></button>
          {isOwner && (
            <button className={tab.schloss}
                    title={gesperrt
                      ? "Aufbau entsperren — Spalten und Ansichten wieder änderbar"
                      : "Aufbau sperren — Einträge bleiben schreibbar, nur Spalten und Ansichten sind geschützt"}
                    onClick={() => {
                      void ideasApi.patchCollection(collection.id, {
                        settings: { ...(collection.settings ?? {}), gesperrt: !gesperrt },
                      }).then(onChanged);
                    }}><Icon name={gesperrt ? "lock" : "lockOpen"} size={15} /></button>
          )}
          {isOwner && !gesperrt && (
            <button className={styles.collDelete} title="Sammlung löschen (Einträge bleiben erhalten)"
                    onClick={async () => {
                      if (!window.confirm(
                        `Sammlung „${collection.name}“ wirklich löschen?\n\n` +
                        "Die Einträge selbst bleiben erhalten — nur die Sammlung verschwindet.")) return;
                      await ideasApi.deleteCollection(collection.id);
                      onDeleted();
                    }}><Icon name="trash" size={14} /></button>
          )}
        </div>
      </div>
      {/* On phones only ONE line — the description is secondary, the
          first entry is the content. Dropping it entirely would lose
          information, hence truncated rather than hidden. */}
      {collection.description && (
        <p className={`${styles.metaHint} ${mobile ? tab.einzeilig : ""}`}
           title={collection.description}>{collection.description}</p>
      )}
      {teilenOffen && (
        <SammlungTeilen collection={collection} currentUser={currentUser}
                        onClose={() => setTeilenOffen(false)}
                        onChanged={() => { onChanged(); reload(); }} />
      )}

      <ViewToolbar
        mobile={mobile}
        onSpalten={darfUmbauen ? () => setSpaltenPanel(true) : undefined}
        views={views}
        activeView={activeView}
        fields={fields}
        isOwner={darfSchreiben}
        onSelect={setActiveViewId}
        onCreate={async (name, lay) => {
          const v = await ideasApi.createView(collection.id, { name, layout: lay });
          setViews((prev) => [...prev, v]);
          setActiveViewId(v.id);
        }}
        onPatch={patchView}
        onDelete={async () => {
          if (!activeView) return;
          await ideasApi.deleteView(collection.id, activeView.id);
          const rest = views.filter((v) => v.id !== activeView.id);
          setViews(rest);
          setActiveViewId(rest[0]?.id ?? null);
        }}
      />

      {error && <div className={styles.error}>{error}</div>}

      {/* Important: the quick entry used to sit ABOVE the table and looked
          like a search field. It now sits as the last row IN the table —
          where the next entry is created. In the other layouts (board,
          gallery, list) it stays at the top because there is no last row. */}
      {/* Warning: this condition used to be `layout !== "table"`. On
          phones, however, the table shows CARDS — the last table row
          "＋ New entry" is not rendered at all. So in a table view no entry
          could be created on a phone. It only surfaced when the empty state
          got a button pointing at this field: an offer that reaches into
          nothing reveals the missing piece. */}
      {darfSchreiben && (layout !== "table" || mobile) && (
        <div className={styles.collAdd}>
          <input className={styles.input} ref={mobile ? neuFeld : undefined}
                 placeholder={`Neu in „${collection.name}“ (Enter)`}
                 value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") void addEntry(); }} />
        </div>
      )}

      {layout === "table" && mobile ? (
        /* Important: on a typical phone (~400 px) the table was ~730 px wide — sideways scrolling
         * only. So on mobile each row is shown as a card with its most important
         * fields; editing happens in the detail view (as in Notion). */
        <div className={styles.rowCards}>
          {/* Grouping applies on mobile too — a long card list without
              subheadings is unreadable, especially on a phone. */}
          {gruppen ? gruppen.map((g) => {
            const zu = zugeklappt.has(g.schluessel);
            return (
              <Fragment key={g.schluessel}>
                <button className={tab.gruppenKopf} aria-expanded={!zu}
                        onClick={() => setZugeklappt((s) => {
                          const n = new Set(s);
                          if (n.has(g.schluessel)) n.delete(g.schluessel); else n.add(g.schluessel);
                          return n;
                        })}>
                  <span className={tab.gruppenPfeil}>{zu ? "▸" : "▾"}</span>
                  {/* On phones the same badge as on desktop — colour is the quickest
                      cue precisely on a small screen, and two renderings of the
                      same group would be one too many. */}
                  {gruppenPlakette(g.wert)
                    ? <Plakette wert={g.wert!}
                                optionen={(tabellenGruppenFeld!.type_option?.options as string[]) ?? undefined} />
                    : <span className={tab.gruppenName}>{g.label}</span>}
                  <span className={tab.gruppenZahl}>{g.zeilen.length}</span>
                </button>
                {!zu && g.zeilen.map(karte)}
              </Fragment>
            );
          }) : rows.map(karte)}
          {rows.length === 0 && leerAnzeige()}
        </div>
      ) : layout === "table" ? (
        <div className={styles.tableWrap}>
          <table className={styles.collTable}>
            <thead>
              <tr>
                <th className={fixiertBis ? tab.fixiert : ""}>Titel</th>
                {visibleFields.map((f) => {
                  const marke = TYP_MARKE[f.field_type];
                  const sort = (activeView?.sorts ?? []).find((x) => x.key === f.key);
                  return (
                    <th key={f.key}
                        className={`${tab.kopfZelle} ${fixierteKeys.has(f.key) ? tab.fixiert : ""}`}>
                      {/* Type marker + menu ON the column header — everything
                          that concerns the column hangs on the column. */}
                      <button className={tab.kopfKnopf} disabled={!darfUmbauen}
                              title={`${f.name} · ${marke?.label ?? ""}`}
                              onClick={(e) => {
                                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setMenuePos({ x: r.left, y: r.bottom + 4 });
                                setMenueKey(menueKey === f.key ? null : f.key);
                              }}>
                        <span className={tab.kopfMarke}>
                          {marke?.icon ? <Icon name={marke.icon} size={13} /> : marke?.glyph}
                        </span>
                        <span className={tab.kopfName}>{f.name}</span>
                        {sort && <span className={tab.kopfSort}>{sort.dir === "desc" ? "↓" : "↑"}</span>}
                      </button>
                      {/* Warning: the menu initially lived INSIDE the <th>. It
                          opened correctly, but the table rows painted over it —
                          and a `z-index` on the header cell did NOT help: table
                          cells are unreliable for stacking. So it is now
                          attached to the document via a portal and drawn
                          `fixed` at the header button's screen position. The
                          table is then no longer involved as a stacking context. */}
                      {menueKey === f.key && activeView && createPortal((
                        <SpaltenMenue
                          feld={f}
                          ansicht={activeView}
                          onSchliessen={() => setMenueKey(null)}
                          onUmbenennen={(name) => void feldPatch(f, { name })}
                          onTypWechsel={(typ) => {
                            if (MIT_RUECKFRAGE.includes(typ)) {
                              // Important: turning a column with values into a
                              // formula no longer displays the values. They are
                              // not lost (switching back restores them), but
                              // anyone who doesn't know that gets a fright.
                              const mitWerten = rows.filter(
                                (r) => r.properties?.[f.key] !== undefined
                                    && r.properties?.[f.key] !== null
                                    && r.properties?.[f.key] !== "").length;
                              if (typ === FieldType.Formula && mitWerten > 0
                                  && !window.confirm(
                                    `„${f.name}" hat in ${mitWerten} Zeile(n) Werte.\n\n`
                                    + "Als Formel zeigt die Spalte stattdessen das Rechenergebnis. "
                                    + "Die Werte bleiben gespeichert und sind wieder da, sobald du "
                                    + "den Typ zurückstellst.")) return;
                              setMenueKey(null);
                              setEinrichten({ feld: f, typ });
                            } else {
                              void feldPatch(f, { field_type: typ });
                            }
                          }}
                          onSortieren={(dir) => {
                            const rest = (activeView.sorts ?? []).filter((x) => x.key !== f.key);
                            void patchView({ sorts: dir ? [...rest, { key: f.key, dir }] : rest });
                            setMenueKey(null);
                          }}
                          onAggregat={(agg) => {
                            void patchView({ field_settings: {
                              ...(activeView.field_settings ?? {}),
                              [f.key]: { ...(activeView.field_settings?.[f.key] ?? {}), agg },
                            } });
                            setMenueKey(null);
                          }}
                          onGruppieren={(an) => {
                            void patchView({ group_setting: an ? { key: f.key } : {} });
                            setMenueKey(null);
                          }}
                          onAusblenden={() => {
                            void patchView({ field_settings: {
                              ...(activeView.field_settings ?? {}),
                              [f.key]: { ...(activeView.field_settings?.[f.key] ?? {}), visible: false },
                            } });
                            setMenueKey(null);
                          }}
                          onEinfuegen={(seite) => { void spalteEinfuegen(f, seite); setMenueKey(null); }}
                          onDuplizieren={() => void spalteDuplizieren(f)}
                          onFixieren={(an) => void patchView({ layout_setting: {
                            ...(activeView.layout_setting ?? {}),
                            fixiert_bis: an ? f.key : "",
                          } })}
                          onUmbruch={(an) => void patchView({ field_settings: {
                            ...(activeView.field_settings ?? {}),
                            [f.key]: { ...(activeView.field_settings?.[f.key] ?? {}), umbruch: an },
                          } })}
                          onFaerben={(an) => void patchView({ layout_setting: {
                            ...(activeView.layout_setting ?? {}),
                            faerben_nach: an ? f.key : "",
                          } })}
                          onAnzeige={(wie) => void patchView({ field_settings: {
                            ...(activeView.field_settings ?? {}),
                            [f.key]: { ...(activeView.field_settings?.[f.key] ?? {}), anzeige: wie },
                          } })}
                          onLoeschen={() => { void feldLoeschen(f); setMenueKey(null); }}
                          stil={{ position: "fixed", left: menuePos.x, top: menuePos.y }}
                        />
                      ), document.body)}
                    </th>
                  );
                })}
                <th>Geändert</th>
                {darfSchreiben && <th />}
              </tr>
            </thead>
            <tbody>
              {/* Collapsible groups with a counter — rendered like in the Planner. */}
              {gruppen ? gruppen.map((g) => {
                const zu = zugeklappt.has(g.schluessel);
                return (
                  <Fragment key={g.schluessel}>
                    <tr className={tab.gruppenZeile}>
                      <td colSpan={visibleFields.length + 3}>
                        <button className={tab.gruppenKopf} aria-expanded={!zu}
                                title={zu ? "Gruppe aufklappen" : "Gruppe zuklappen"}
                                onClick={() => setZugeklappt((s) => {
                                  const n = new Set(s);
                                  if (n.has(g.schluessel)) n.delete(g.schluessel); else n.add(g.schluessel);
                                  return n;
                                })}>
                          <span className={tab.gruppenPfeil}>{zu ? "▸" : "▾"}</span>
                          {gruppenPlakette(g.wert)
                            ? <Plakette wert={g.wert!}
                                        optionen={(tabellenGruppenFeld!.type_option?.options as string[]) ?? undefined} />
                            : <span className={tab.gruppenName}>{g.label}</span>}
                          <span className={tab.gruppenZahl}>{g.zeilen.length}</span>
                        </button>
                      </td>
                    </tr>
                    {!zu && g.zeilen.map(zeile)}
                  </Fragment>
                );
              }) : rows.map(zeile)}
              {rows.length === 0 && (
                <tr><td colSpan={visibleFields.length + 3}>{leerAnzeige()}</td></tr>
              )}
              {/* Creating a new entry belongs at the END of the table, not in a
                  separate field above — there it gets in the way and looks
                  like a search. */}
              {darfSchreiben && (
                <tr>
                  <td colSpan={visibleFields.length + 3}>
                    <span className={tab.neueZeile}>
                      <input className={tab.neueZeileFeld}
                             ref={neuFeld}
                             placeholder="＋ Neuer Eintrag"
                             value={newTitle}
                             onChange={(e) => setNewTitle(e.target.value)}
                             onKeyDown={(e) => { if (e.key === "Enter") void addEntry(); }} />
                      {zeilenVorlagen.length > 0 && (
                        <button className={tab.neueZeileMehr} title="Aus einer Vorlage anlegen"
                                onClick={(e) => {
                                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                  setVorlagenMenue(vorlagenMenue ? null : { x: r.left - 180, y: r.bottom + 4 });
                                }}>⌄</button>
                      )}
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
            {/* Footer row with calculations. The /aggregate endpoint had
                existed for a while — nobody ever displayed it. */}
            {visibleFields.some((f) => activeView?.field_settings?.[f.key]?.agg) && (
              <tfoot>
                <tr>
                  <td className={tab.fussLabel}>{rows.length} Einträge</td>
                  {visibleFields.map((f) => {
                    const agg = activeView?.field_settings?.[f.key]?.agg;
                    const wert = fuss[f.key];
                    return (
                      <td key={f.key} className={tab.fussWert}>
                        {agg ? (
                          <>
                            <div className={tab.fussLabel}>
                              {AGGREGATE.find((a) => a.key === agg)?.label}
                            </div>
                            <div className={tab.fussZahl}>
                              {wert === null || wert === undefined
                                ? "…"
                                : formatZahl(wert)}
                            </div>
                          </>
                        ) : null}
                      </td>
                    );
                  })}
                  <td />
                  {darfSchreiben && <td />}
                </tr>
              </tfoot>
            )}
          </table>
          {/* Hidden columns stay reachable — otherwise they are lost. */}
          {darfSchreiben && versteckte.length > 0 && (
            <div className={tab.versteckteSpalten}>
              <span>Ausgeblendet:</span>
              {versteckte.map((f) => (
                <button key={f.key} className={tab.versteckteSpalte}
                        title="Wieder einblenden"
                        onClick={() => void patchView({ field_settings: {
                          ...(activeView?.field_settings ?? {}),
                          [f.key]: { ...(activeView?.field_settings?.[f.key] ?? {}), visible: true },
                        } })}>
                  {f.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : layout === "board" && groupField ? (
        <div className={styles.board}>
          {[...((groupField.type_option?.options as string[]) ?? []), null].map((opt) => {
            const colKey = opt ?? "__none__";
            const options = (groupField.type_option?.options as string[]) ?? [];
            const cards = rows.filter((o) =>
              opt === null
                ? !options.includes(String(o.properties?.[groupField.key] ?? ""))
                : String(o.properties?.[groupField.key] ?? "") === opt);
            return (
              <div key={colKey}
                   className={`${styles.boardCol} ${dropCol === colKey ? styles.boardColDrop : ""}`}
                   onDragOver={(e) => { e.preventDefault(); setDropCol(colKey); }}
                   onDragLeave={() => setDropCol((c) => (c === colKey ? null : c))}
                   onDrop={(e) => {
                     e.preventDefault();
                     setDropCol(null);
                     const id = e.dataTransfer.getData("text/kb-object-id");
                     const obj = rows.find((o) => o.id === id);
                     if (obj) void saveProp(obj, groupField.key, opt);
                   }}>
                <div className={styles.boardColHead}>
                  <span>{opt ?? "—"}</span>
                  <span className={styles.boardCount}>{cards.length}</span>
                </div>
                <div className={styles.boardCards}>
                  {cards.map((o) => (
                    <div key={o.id} className={styles.card}
                         draggable={o.owner === currentUser}
                         onDragStart={(e) => {
                           e.dataTransfer.setData("text/kb-object-id", o.id);
                           e.dataTransfer.effectAllowed = "move";
                         }}
                         onClick={() => onOpen(o.id)}>
                      <div className={styles.cardTitle}>{o.title}</div>
                      <div className={styles.galleryProps}>
                        {visibleFields.filter((f) => f.key !== groupField.key && !isSpecial(f))
                          .slice(0, 3).map((f) => (
                          <span key={f.key}>
                            <b>{f.name}:</b> {propDisplay(fieldToDef(f), o.properties?.[f.key])}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                  {cards.length === 0 && <div className={styles.colEmpty}>—</div>}
                </div>
              </div>
            );
          })}
        </div>
      ) : layout === "calendar" && dateKey ? (
        <CalendarGrid rows={rows} dateKey={dateKey} onOpen={onOpen} />
      ) : layout === "timeline" && startKey ? (
        <TimelineView rows={rows} startKey={startKey} endKey={endKey || startKey} onOpen={onOpen} />
      ) : layout === "list" ? (
        <div className={styles.listRows}>
          {rows.map((o) => (
            <button key={o.id} className={styles.listRow} onClick={() => onOpen(o.id)}>
              <span className={styles.listTitle}>{o.icon ? `${o.icon} ` : ""}{o.title}</span>
              <span className={styles.listMeta}>
                {formatZeitpunkt(o.updated_at)}
              </span>
            </button>
          ))}
          {rows.length === 0 && leerAnzeige()}
        </div>
      ) : (
        <div className={styles.gallery}>
          {rows.map((o) => (
            <div key={o.id} className={styles.card} onClick={() => onOpen(o.id)}>
              <div className={styles.cardTitle}>{o.icon ? `${o.icon} ` : ""}{o.title}</div>
              {o.body_preview && <div className={styles.cardPreview}>{o.body_preview}</div>}
              <div className={styles.galleryProps}>
                {visibleFields.filter((f) => !isSpecial(f)).slice(0, 4).map((f) => (
                  <span key={f.key}>
                    <b>{f.name}:</b> {propDisplay(fieldToDef(f), o.properties?.[f.key])}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {rows.length === 0 && leerAnzeige()}
        </div>
      )}

      {vorlagenMenue && (
        <PopupMenu
          x={vorlagenMenue.x} y={vorlagenMenue.y}
          onClose={() => setVorlagenMenue(null)}
          items={zeilenVorlagen.map((v, i) => ({
            id: `v${i}`, label: v.name, icon: "⧉",
            onSelect: () => void addEntry(v),
          }))}
        />
      )}

      {spaltenPanel && (
        <SpaltenPanel
          felder={fields}
          ansicht={activeView}
          onSchliessen={() => setSpaltenPanel(false)}
          onUmbenennen={(f, name) => void feldPatch(f, { name })}
          onTypWechsel={(f, typ) => {
            if (MIT_RUECKFRAGE.includes(typ)) {
              setSpaltenPanel(false);
              setEinrichten({ feld: f, typ });
            } else {
              void feldPatch(f, { field_type: typ });
            }
          }}
          onSichtbar={(f, sichtbar) => void patchView({ field_settings: {
            ...(activeView?.field_settings ?? {}),
            [f.key]: { ...(activeView?.field_settings?.[f.key] ?? {}), visible: sichtbar },
          } })}
          onLoeschen={(f) => void feldLoeschen(f)}
          onNeu={() => void spalteEinfuegen(fields[fields.length - 1], "rechts")}
        />
      )}

      {einrichten && einrichten.typ === FieldType.Formula && (
        <FormelEditor
          feld={einrichten.feld}
          sammlungId={collection.id}
          felder={fields}
          onAbbrechen={() => setEinrichten(null)}
          onFertig={(ausdruck) => {
            void feldPatch(einrichten.feld, {
              field_type: FieldType.Formula, type_option: { expression: ausdruck },
            });
            setEinrichten(null);
          }}
        />
      )}

      {einrichten && einrichten.typ !== FieldType.Formula && (
        <FeldEinrichten
          feld={einrichten.feld}
          zielTyp={einrichten.typ}
          sammlungId={collection.id}
          felder={fields}
          onAbbrechen={() => setEinrichten(null)}
          onFertig={(typ, option) => {
            void feldPatch(einrichten.feld, { field_type: typ, type_option: option });
            setEinrichten(null);
          }}
        />
      )}

      {relEdit && (
        <RelationPicker
          rowId={relEdit.rowId}
          fieldKey={relEdit.key}
          current={(rows.find((r) => r.id === relEdit.rowId)?.properties?.[relEdit.key] as string[]) ?? []}
          onClose={() => setRelEdit(null)}
          onSaved={() => { setRelEdit(null); reload(); }}
        />
      )}
    </div>
  );
}

/** Month grid for the calendar view (date field from layout_setting). */
function CalendarGrid({ rows, dateKey, onOpen }: {
  rows: KbRow[]; dateKey: string; onOpen: (id: string) => void;
}) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Week starts on Monday
  const byDay = useMemo(() => {
    const map: Record<string, KbRow[]> = {};
    for (const r of rows) {
      const raw = String(r.properties?.[dateKey] ?? "");
      if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) continue;
      (map[raw.slice(0, 10)] ??= []).push(r);
    }
    return map;
  }, [rows, dateKey]);

  const iso = (day: number) =>
    `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return (
    <div className={styles.calWrap}>
      <div className={styles.calHead}>
        <button className={styles.btnSecondary}
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
        <span>{month.toLocaleDateString("de-DE", { month: "long", year: "numeric" })}</span>
        <button className={styles.btnSecondary}
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
      </div>
      <div className={styles.calGrid}>
        {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((d) => (
          <div key={d} className={styles.calDow}>{d}</div>
        ))}
        {Array.from({ length: lead }).map((_, i) => <div key={`x${i}`} className={styles.calCell} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const entries = byDay[iso(day)] ?? [];
          return (
            <div key={day} className={styles.calCell}>
              <div className={styles.calDay}>{day}</div>
              {entries.map((e) => (
                <button key={e.id} className={styles.calEntry} title={e.title}
                        onClick={() => onOpen(e.id)}>
                  {e.icon ? `${e.icon} ` : ""}{e.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Relation editor: searches visible objects; the server silently drops
 * anything the user may not see (no existence leak). */
function RelationPicker({ rowId, fieldKey, current, onClose, onSaved }: {
  rowId: string; fieldKey: string; current: string[];
  onClose: () => void; onSaved: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<KbObjectSlim[]>([]);
  const [picked, setPicked] = useState<string[]>(current);
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = q.trim().length >= 2
        ? await ideasApi.search(q).catch(() => [])
        : await ideasApi.listObjects({ limit: 20 }).catch(() => []);
      if (cancelled) return;
      setHits(res);
      setTitles((prev) => ({ ...prev, ...Object.fromEntries(res.map((o) => [o.id, o.title])) }));
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3>🔗 Verknüpfungen</h3>
          <button className={styles.iconBtn} onClick={onClose} title="Schließen"><Icon name="close" size={14} title="Schließen" /></button>
        </div>
        <div className={styles.chipRow}>
          {picked.map((id) => (
            <button key={id} className={styles.chip} title="Entfernen"
                    onClick={() => setPicked((p) => p.filter((x) => x !== id))}>
              {titles[id] ?? id.slice(0, 8)} ✕
            </button>
          ))}
          {picked.length === 0 && <span className={styles.metaHint}>Noch nichts verknüpft.</span>}
        </div>
        <input className={styles.input} placeholder="Objekt suchen…" autoFocus
               value={q} onChange={(e) => setQ(e.target.value)} />
        <div className={styles.listRows} style={{ maxHeight: 220, overflowY: "auto" }}>
          {hits.filter((o) => o.id !== rowId && !picked.includes(o.id)).slice(0, 12).map((o) => (
            <button key={o.id} className={styles.listRow}
                    onClick={() => setPicked((p) => [...p, o.id])}>
              <span className={styles.listTitle}>{o.title}</span>
              <span className={styles.listMeta}>{o.type}</span>
            </button>
          ))}
        </div>
        <div className={styles.modalFoot}>
          <button className={styles.btnPrimary}
                  onClick={async () => {
                    await ideasApi.setRelation(rowId, fieldKey, picked);
                    onSaved();
                  }}>Speichern</button>
        </div>
      </div>
    </div>
  );
}


/** Timeline: one bar per row between start and end date.
 * Deliberately simple — not a Gantt chart with dependencies (the Planner does
 * that), but an overview of "what runs when". */
function TimelineView({ rows, startKey, endKey, onOpen }: {
  rows: KbRow[]; startKey: string; endKey: string; onOpen: (id: string) => void;
}) {
  const parsed = rows
    .map((r) => {
      const s = String(r.properties?.[startKey] ?? "").slice(0, 10);
      const e = String(r.properties?.[endKey] ?? "").slice(0, 10) || s;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
      const start = new Date(s).getTime();
      const end = Math.max(start, /^\d{4}-\d{2}-\d{2}$/.test(e) ? new Date(e).getTime() : start);
      return { row: r, start, end };
    })
    .filter(Boolean) as { row: KbRow; start: number; end: number }[];

  if (parsed.length === 0) {
    return <div className={styles.empty}>Keine Einträge mit gültigem Datum in dieser Ansicht.</div>;
  }

  const min = Math.min(...parsed.map((p) => p.start));
  const max = Math.max(...parsed.map((p) => p.end));
  const span = Math.max(max - min, 86400000);
  const fmt = (t: number) => new Date(t).toLocaleDateString("de-DE", { day: "2-digit", month: "short" });

  return (
    <div className={styles.timeline}>
      <div className={styles.timelineScale}>
        <span>{fmt(min)}</span><span>{fmt(min + span / 2)}</span><span>{fmt(max)}</span>
      </div>
      {parsed.sort((a, b) => a.start - b.start).map(({ row, start, end }) => (
        <div key={row.id} className={styles.timelineRow}>
          <button className={styles.timelineLabel} onClick={() => onOpen(row.id)} title={row.title}>
            {row.icon ? `${row.icon} ` : ""}{row.title}
          </button>
          <div className={styles.timelineTrack}>
            <button
              className={styles.timelineBar}
              style={{
                left: `${((start - min) / span) * 100}%`,
                width: `${Math.max(((end - start) / span) * 100, 1.5)}%`,
              }}
              title={`${fmt(start)} – ${fmt(end)}`}
              onClick={() => onOpen(row.id)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
