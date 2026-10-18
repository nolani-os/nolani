/** Templates for new collections.
 *
 * **Why this matters most.** Notion's most cited weakness is not a missing
 * feature but the blank page: newcomers spend more time setting up than
 * using. A plain "New collection" form with name, icon, type, visibility and
 * a schema editor for fields with key and data type is doable for power users
 * but a wall for everyone else.
 *
 * A template instead delivers something that **works immediately**: columns,
 * views and two example rows that show how it is meant.
 *
 * Warning: **templates do NOT create object types.** The ID in
 * `claraos_kb_types` is the primary key and therefore **global across all
 * users**. If one user creates the type `rezept`, another user gets a
 * `409 Typ 'rezept' existiert schon` for the same name — the classic dialog
 * falls into exactly this trap. Templates therefore write into the
 * **collection's field registry** (`/collections/{id}/fields`), which belongs
 * to the collection and thus to its owner.
 *
 * Deliberately few templates, and none that duplicates an existing app:
 * shopping has the shopping app, tasks and projects have the Planner,
 * receipts have Paperless. This is for things you **look up**, not things
 * you work through.
 */
import { FieldType } from "../ideas/types";
import type { ViewLayout, Visibility } from "../ideas/types";
import { ideasApi } from "../ideas/api";

interface VorlagenFeld {
  key: string;
  name: string;
  typ: number;
  optionen?: string[];
}

interface VorlagenAnsicht {
  name: string;
  layout: ViewLayout;
  /** Column to group by (board only). */
  gruppe?: string;
  /** Date column (calendar only). */
  datum?: string;
}

export interface Vorlage {
  id: string;
  icon: string;
  name: string;
  /** One sentence: what is it good for? Shown on the card. */
  wofuer: string;
  felder: VorlagenFeld[];
  ansichten?: VorlagenAnsicht[];
  /** Two examples — they explain the structure better than any help text. */
  beispiele: { titel: string; werte: Record<string, unknown> }[];
}

const STATUS = ["Idee", "Läuft", "Erledigt"];

export const VORLAGEN: Vorlage[] = [
  {
    id: "haus",
    icon: "🏡",
    name: "Haus & Wohnung",
    wofuer: "Was ansteht, was es kostet und wer sich darum kümmert.",
    felder: [
      { key: "kosten", name: "Kosten", typ: FieldType.Number },
      { key: "status", name: "Status", typ: FieldType.Select, optionen: STATUS },
      { key: "faellig", name: "Bis wann", typ: FieldType.Date },
      { key: "wer", name: "Wer", typ: FieldType.Text },
    ],
    ansichten: [{ name: "Nach Status", layout: "board", gruppe: "status" }],
    beispiele: [
      { titel: "Beispiel: Heizung warten lassen",
        werte: { kosten: 180, status: "Läuft", wer: "Firma Muster" } },
      { titel: "Beispiel: Gartenhaus streichen",
        werte: { kosten: 300, status: "Idee" } },
    ],
  },
  {
    id: "rezepte",
    icon: "🍲",
    name: "Rezepte",
    wofuer: "Was bei euch gut ankommt — mit Dauer, Aufwand und Quelle.",
    felder: [
      { key: "dauer", name: "Dauer (Min.)", typ: FieldType.Number },
      { key: "aufwand", name: "Aufwand", typ: FieldType.Select,
        optionen: ["Schnell", "Mittel", "Aufwendig"] },
      { key: "wer_mag", name: "Mag besonders", typ: FieldType.Text },
      { key: "quelle", name: "Quelle", typ: FieldType.Url },
      { key: "liebling", name: "Lieblingsrezept", typ: FieldType.Checkbox },
    ],
    ansichten: [{ name: "Nach Aufwand", layout: "board", gruppe: "aufwand" }],
    beispiele: [
      { titel: "Beispiel: Ofengemüse mit Feta",
        werte: { dauer: 40, aufwand: "Schnell", liebling: true } },
      { titel: "Beispiel: Sonntagsbraten",
        werte: { dauer: 180, aufwand: "Aufwendig" } },
    ],
  },
  {
    id: "reisen",
    icon: "🧳",
    name: "Urlaub & Ausflüge",
    wofuer: "Ideen sammeln, vergleichen und später wiederfinden.",
    felder: [
      { key: "wann", name: "Wann", typ: FieldType.Date },
      { key: "kosten", name: "Kosten ca.", typ: FieldType.Number },
      { key: "status", name: "Status", typ: FieldType.Select,
        optionen: ["Idee", "Geplant", "Gebucht", "War schön"] },
      { key: "mit_wem", name: "Mit wem", typ: FieldType.Text },
    ],
    ansichten: [
      { name: "Nach Status", layout: "board", gruppe: "status" },
      { name: "Kalender", layout: "calendar", datum: "wann" },
    ],
    beispiele: [
      { titel: "Beispiel: Wochenende an der Ostsee",
        werte: { kosten: 450, status: "Idee" } },
      { titel: "Beispiel: Wandertag in den Bergen",
        werte: { kosten: 60, status: "Geplant" } },
    ],
  },
  {
    id: "vertraege",
    icon: "📑",
    name: "Verträge & Versicherungen",
    wofuer: "Wer, wie viel im Jahr — und bis wann man kündigen könnte.",
    felder: [
      { key: "anbieter", name: "Anbieter", typ: FieldType.Text },
      { key: "nummer", name: "Vertragsnummer", typ: FieldType.Text },
      { key: "jahreskosten", name: "Kosten/Jahr", typ: FieldType.Number },
      { key: "kuendigen_bis", name: "Kündbar bis", typ: FieldType.Date },
      { key: "pruefen", name: "Mal prüfen", typ: FieldType.Checkbox },
    ],
    beispiele: [
      { titel: "Beispiel: Hausratversicherung",
        werte: { anbieter: "Musterversicherung", jahreskosten: 180, pruefen: true } },
      { titel: "Beispiel: Handytarif",
        werte: { anbieter: "Musterfunk", jahreskosten: 240 } },
    ],
  },
  {
    id: "geschenke",
    icon: "🎁",
    name: "Geschenkideen",
    wofuer: "Einfälle festhalten, bevor sie kurz vor dem Fest wieder weg sind.",
    felder: [
      { key: "fuer", name: "Für wen", typ: FieldType.Text },
      { key: "anlass", name: "Anlass", typ: FieldType.Select,
        optionen: ["Geburtstag", "Weihnachten", "Einfach so"] },
      { key: "preis", name: "Preis ca.", typ: FieldType.Number },
      { key: "besorgt", name: "Besorgt", typ: FieldType.Checkbox },
    ],
    ansichten: [{ name: "Nach Anlass", layout: "board", gruppe: "anlass" }],
    beispiele: [
      { titel: "Beispiel: Kochkurs zu zweit",
        werte: { anlass: "Geburtstag", preis: 120 } },
      { titel: "Beispiel: Fotobuch vom letzten Jahr",
        werte: { anlass: "Weihnachten", preis: 40 } },
    ],
  },
  {
    id: "handwerker",
    icon: "🔧",
    name: "Handwerker & Dienste",
    wofuer: "Wen man schon hatte, wofür — und ob man ihn nochmal nimmt.",
    felder: [
      { key: "gewerk", name: "Gewerk", typ: FieldType.Text },
      { key: "telefon", name: "Telefon", typ: FieldType.Text },
      { key: "zuletzt", name: "Zuletzt beauftragt", typ: FieldType.Date },
      { key: "wieder", name: "Wieder nehmen", typ: FieldType.Checkbox },
    ],
    beispiele: [
      { titel: "Beispiel: Elektro Muster",
        werte: { gewerk: "Elektrik", telefon: "0123 456789", wieder: true } },
      { titel: "Beispiel: Heizung Muster",
        werte: { gewerk: "Heizung/Sanitär" } },
    ],
  },
];

/**
 * Creates the collection including columns, views and examples.
 *
 * Order matters: first the collection, then the **fields** — otherwise the
 * server materializes the fields from the default type's `prop_schema` on
 * first access and the registry is already populated.
 * Failures of individual steps are collected, not swallowed: a half-created
 * collection is worse than an honest error message.
 */
export async function vorlageAnwenden(
  v: Vorlage, visibility: Visibility,
): Promise<{ id: string; warnungen: string[] }> {
  const warnungen: string[] = [];
  const coll = await ideasApi.createCollection({
    name: v.name,
    icon: v.icon,
    description: v.wofuer,
    visibility,
    default_type: "note",
  });

  for (const f of v.felder) {
    try {
      await ideasApi.createField(coll.id, {
        key: f.key,
        name: f.name,
        field_type: f.typ,
        type_option: f.optionen ? { options: f.optionen } : undefined,
      });
    } catch (e) {
      warnungen.push(`Spalte „${f.name}" konnte nicht angelegt werden`);
      console.warn("vorlage/feld", f.key, e);
    }
  }

  for (const a of v.ansichten ?? []) {
    try {
      await ideasApi.createView(coll.id, {
        name: a.name,
        layout: a.layout,
        ...(a.gruppe ? { group_setting: { key: a.gruppe } } : {}),
        ...(a.datum ? { layout_setting: { date_field: a.datum } } : {}),
      });
    } catch (e) {
      warnungen.push(`Ansicht „${a.name}" konnte nicht angelegt werden`);
      console.warn("vorlage/ansicht", a.name, e);
    }
  }

  for (const [i, b] of (v.beispiele ?? []).entries()) {
    try {
      const obj = await ideasApi.createObject({
        type: "note",
        title: b.titel,
        body: "Beispielzeile aus der Vorlage — überschreib sie einfach oder wirf sie weg.\n",
        properties: b.werte,
        visibility,
      });
      await ideasApi.addToCollection(coll.id, obj.id, i + 1);
    } catch (e) {
      warnungen.push("Ein Beispiel konnte nicht angelegt werden");
      console.warn("vorlage/beispiel", b.titel, e);
    }
  }

  return { id: coll.id, warnungen };
}
