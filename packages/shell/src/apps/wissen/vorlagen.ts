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
import { i18n } from "@claraos/core";

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

/** Template texts in the UI language — a collection is created in the language
 *  of the person creating it, and from then on its names are ordinary data. */
const tx = (key: string): string => i18n.t(`wissen:templates.${key}`);

/** Select options are listed by key; the label comes from the catalog. Example
 *  values point at the same key, so they always match one of the options. */
const optionen = (vorlage: string, feld: string, keys: string[]) =>
  keys.map((k) => tx(`${vorlage}.opt.${feld}.${k}`));
const option = (vorlage: string, feld: string, k: string) => tx(`${vorlage}.opt.${feld}.${k}`);

export function vorlagen(): Vorlage[] {
  return [
    {
      id: "haus",
      icon: "🏡",
      name: tx("haus.name"),
      wofuer: tx("haus.purpose"),
      felder: [
        { key: "kosten", name: tx("haus.f.kosten"), typ: FieldType.Number },
        { key: "status", name: tx("haus.f.status"), typ: FieldType.Select,
          optionen: optionen("haus", "status", ["idee", "laeuft", "erledigt"]) },
        { key: "faellig", name: tx("haus.f.faellig"), typ: FieldType.Date },
        { key: "wer", name: tx("haus.f.wer"), typ: FieldType.Text },
      ],
      ansichten: [{ name: tx("haus.v.status"), layout: "board", gruppe: "status" }],
      beispiele: [
        { titel: tx("haus.ex1"),
          werte: { kosten: 180, status: option("haus", "status", "laeuft"), wer: tx("haus.ex1Wer") } },
        { titel: tx("haus.ex2"),
          werte: { kosten: 300, status: option("haus", "status", "idee") } },
      ],
    },
    {
      id: "rezepte",
      icon: "🍲",
      name: tx("rezepte.name"),
      wofuer: tx("rezepte.purpose"),
      felder: [
        { key: "dauer", name: tx("rezepte.f.dauer"), typ: FieldType.Number },
        { key: "aufwand", name: tx("rezepte.f.aufwand"), typ: FieldType.Select,
          optionen: optionen("rezepte", "aufwand", ["schnell", "mittel", "aufwendig"]) },
        { key: "wer_mag", name: tx("rezepte.f.wer_mag"), typ: FieldType.Text },
        { key: "quelle", name: tx("rezepte.f.quelle"), typ: FieldType.Url },
        { key: "liebling", name: tx("rezepte.f.liebling"), typ: FieldType.Checkbox },
      ],
      ansichten: [{ name: tx("rezepte.v.aufwand"), layout: "board", gruppe: "aufwand" }],
      beispiele: [
        { titel: tx("rezepte.ex1"),
          werte: { dauer: 40, aufwand: option("rezepte", "aufwand", "schnell"), liebling: true } },
        { titel: tx("rezepte.ex2"),
          werte: { dauer: 180, aufwand: option("rezepte", "aufwand", "aufwendig") } },
      ],
    },
    {
      id: "reisen",
      icon: "🧳",
      name: tx("reisen.name"),
      wofuer: tx("reisen.purpose"),
      felder: [
        { key: "wann", name: tx("reisen.f.wann"), typ: FieldType.Date },
        { key: "kosten", name: tx("reisen.f.kosten"), typ: FieldType.Number },
        { key: "status", name: tx("reisen.f.status"), typ: FieldType.Select,
          optionen: optionen("reisen", "status", ["idee", "geplant", "gebucht", "warSchoen"]) },
        { key: "mit_wem", name: tx("reisen.f.mit_wem"), typ: FieldType.Text },
      ],
      ansichten: [
        { name: tx("reisen.v.status"), layout: "board", gruppe: "status" },
        { name: tx("reisen.v.kalender"), layout: "calendar", datum: "wann" },
      ],
      beispiele: [
        { titel: tx("reisen.ex1"),
          werte: { kosten: 450, status: option("reisen", "status", "idee") } },
        { titel: tx("reisen.ex2"),
          werte: { kosten: 60, status: option("reisen", "status", "geplant") } },
      ],
    },
    {
      id: "vertraege",
      icon: "📑",
      name: tx("vertraege.name"),
      wofuer: tx("vertraege.purpose"),
      felder: [
        { key: "anbieter", name: tx("vertraege.f.anbieter"), typ: FieldType.Text },
        { key: "nummer", name: tx("vertraege.f.nummer"), typ: FieldType.Text },
        { key: "jahreskosten", name: tx("vertraege.f.jahreskosten"), typ: FieldType.Number },
        { key: "kuendigen_bis", name: tx("vertraege.f.kuendigen_bis"), typ: FieldType.Date },
        { key: "pruefen", name: tx("vertraege.f.pruefen"), typ: FieldType.Checkbox },
      ],
      beispiele: [
        { titel: tx("vertraege.ex1"),
          werte: { anbieter: tx("vertraege.ex1Anbieter"), jahreskosten: 180, pruefen: true } },
        { titel: tx("vertraege.ex2"),
          werte: { anbieter: tx("vertraege.ex2Anbieter"), jahreskosten: 240 } },
      ],
    },
    {
      id: "geschenke",
      icon: "🎁",
      name: tx("geschenke.name"),
      wofuer: tx("geschenke.purpose"),
      felder: [
        { key: "fuer", name: tx("geschenke.f.fuer"), typ: FieldType.Text },
        { key: "anlass", name: tx("geschenke.f.anlass"), typ: FieldType.Select,
          optionen: optionen("geschenke", "anlass", ["geburtstag", "weihnachten", "einfachSo"]) },
        { key: "preis", name: tx("geschenke.f.preis"), typ: FieldType.Number },
        { key: "besorgt", name: tx("geschenke.f.besorgt"), typ: FieldType.Checkbox },
      ],
      ansichten: [{ name: tx("geschenke.v.anlass"), layout: "board", gruppe: "anlass" }],
      beispiele: [
        { titel: tx("geschenke.ex1"),
          werte: { anlass: option("geschenke", "anlass", "geburtstag"), preis: 120 } },
        { titel: tx("geschenke.ex2"),
          werte: { anlass: option("geschenke", "anlass", "weihnachten"), preis: 40 } },
      ],
    },
    {
      id: "handwerker",
      icon: "🔧",
      name: tx("handwerker.name"),
      wofuer: tx("handwerker.purpose"),
      felder: [
        { key: "gewerk", name: tx("handwerker.f.gewerk"), typ: FieldType.Text },
        { key: "telefon", name: tx("handwerker.f.telefon"), typ: FieldType.Text },
        { key: "zuletzt", name: tx("handwerker.f.zuletzt"), typ: FieldType.Date },
        { key: "wieder", name: tx("handwerker.f.wieder"), typ: FieldType.Checkbox },
      ],
      beispiele: [
        { titel: tx("handwerker.ex1"),
          werte: { gewerk: tx("handwerker.ex1Gewerk"), telefon: "0123 456789", wieder: true } },
        { titel: tx("handwerker.ex2"),
          werte: { gewerk: tx("handwerker.ex2Gewerk") } },
      ],
    },
  ];
}

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
      warnungen.push(i18n.t("wissen:templates.apply.fieldFailed", { name: f.name }));
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
      warnungen.push(i18n.t("wissen:templates.apply.viewFailed", { name: a.name }));
      console.warn("vorlage/ansicht", a.name, e);
    }
  }

  for (const [i, b] of (v.beispiele ?? []).entries()) {
    try {
      const obj = await ideasApi.createObject({
        type: "note",
        title: b.titel,
        body: i18n.t("wissen:templates.apply.exampleBody"),
        properties: b.werte,
        visibility,
      });
      await ideasApi.addToCollection(coll.id, obj.id, i + 1);
    } catch (e) {
      warnungen.push(i18n.t("wissen:templates.apply.exampleFailed"));
      console.warn("vorlage/beispiel", b.titel, e);
    }
  }

  return { id: coll.id, warnungen };
}
