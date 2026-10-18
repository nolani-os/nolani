/**
 * toolStatus — short, human status lines for Clara's tool calls.
 *
 * The agent's tool.start/tool.end events carry the raw tool name
 * (`claraos_modules_planner__create_task`) and a generic summary. The live
 * status should read like a sentence instead: "Lege Aufgabe an …" while it
 * runs, "Aufgabe angelegt ✓" when it is done.
 *
 * Covers the tools of the core modules (knowledge, planner, mail, calendar and
 * contacts, post, learning, office) plus web search. Anything else falls back
 * to a readable form of the tool name — never to the raw identifier.
 */

type Zeile = readonly [laeuft: string, fertig: string];

const MODULE: Record<string, Record<string, Zeile>> = {
  knowledge: {
    capture_idea: ["Halte Idee fest", "Idee festgehalten"],
    list_ideas: ["Sehe Ideen durch", "Ideen gelesen"],
    get_object: ["Öffne Notiz", "Notiz gelesen"],
    create_object: ["Lege Notiz an", "Notiz angelegt"],
    list_collections: ["Sehe Sammlungen durch", "Sammlungen gelesen"],
    create_collection: ["Lege Sammlung an", "Sammlung angelegt"],
    create_collection_from_template: ["Baue Sammlung aus Vorlage", "Sammlung mit Vorlage angelegt"],
    add_to_collection: ["Füge zur Sammlung hinzu", "Zur Sammlung hinzugefügt"],
    define_type: ["Lege Notiztyp an", "Notiztyp angelegt"],
    update_object: ["Aktualisiere Notiz", "Notiz aktualisiert"],
    add_insight: ["Ergänze Erkenntnis", "Erkenntnis ergänzt"],
    link_objects: ["Verknüpfe Notizen", "Notizen verknüpft"],
    promote_idea_to_plan: ["Mache aus der Idee einen Plan", "Plan angelegt"],
    get_backlinks: ["Suche Verweise", "Verweise gefunden"],
    move_object: ["Verschiebe Notiz", "Notiz verschoben"],
    clip_url: ["Speichere Webseite", "Webseite gespeichert"],
    comment_on_object: ["Schreibe Kommentar", "Kommentar geschrieben"],
    query_collection: ["Durchsuche Sammlung", "Sammlung durchsucht"],
    define_field: ["Lege Spalte an", "Spalte angelegt"],
    create_view: ["Lege Ansicht an", "Ansicht angelegt"],
    set_relation: ["Verknüpfe Einträge", "Einträge verknüpft"],
    list_templates: ["Sehe Vorlagen durch", "Vorlagen gelesen"],
    create_from_template: ["Lege Notiz aus Vorlage an", "Notiz aus Vorlage angelegt"],
    duplicate_object: ["Kopiere Notiz", "Notiz kopiert"],
    get_backmentions: ["Suche Erwähnungen", "Erwähnungen gefunden"],
    get_history: ["Lese Versionen", "Versionen gelesen"],
    restore_version: ["Stelle alte Version her", "Alte Version hergestellt"],
    search_knowledge_db: ["Suche im Wissen", "Wissen durchsucht"],
    search: ["Suche im Wissen", "Wissen durchsucht"],
    list_goals: ["Sehe Ziele durch", "Ziele gelesen"],
    suggest_ideas: ["Sammle Ideen zum Ziel", "Ideen vorgeschlagen"],
    develop_concept: ["Arbeite Konzept aus", "Konzept ausgearbeitet"],
    rate_contribution: ["Bewerte Beitrag", "Beitrag bewertet"],
    link_to_goal: ["Verknüpfe mit Ziel", "Mit Ziel verknüpft"],
    promote_to_action_plan: ["Lege Maßnahmenplan an", "Maßnahmenplan angelegt"],
    run_five_why: ["Frage fünfmal warum", "5-Why fertig"],
    pareto_analysis: ["Rechne Pareto-Analyse", "Pareto-Analyse fertig"],
  },
  planner: {
    list_projects: ["Sehe Projekte im Planner durch", "Projekte gelesen"],
    list_tasks: ["Suche im Planner", "Aufgaben gelesen"],
    count_tasks: ["Zähle Aufgaben", "Aufgaben gezählt"],
    uebersicht: ["Hole Planner-Übersicht", "Übersicht gelesen"],
    get_task: ["Öffne Aufgabe", "Aufgabe gelesen"],
    create_task: ["Lege Aufgabe an", "Aufgabe angelegt"],
    update_task: ["Ändere Aufgabe", "Aufgabe geändert"],
    complete_task: ["Hake Aufgabe ab", "Aufgabe erledigt"],
    set_dependency: ["Setze Abhängigkeit", "Abhängigkeit gesetzt"],
    move_card: ["Verschiebe Karte", "Karte verschoben"],
    add_comment: ["Schreibe Kommentar", "Kommentar geschrieben"],
    set_estimate: ["Trage Schätzung ein", "Schätzung eingetragen"],
    create_project_from_plan: ["Lege Projekt aus Plan an", "Projekt angelegt"],
    start_work: ["Starte Arbeit an Aufgabe", "Arbeit gestartet"],
    finish_work: ["Schließe Arbeit ab", "Arbeit abgeschlossen"],
    start_adhoc_work: ["Lege Arbeitsauftrag an", "Arbeitsauftrag angelegt"],
  },
  mail: {
    list_messages: ["Sehe Mails durch", "Mails gelesen"],
    count_messages: ["Zähle Mails", "Mails gezählt"],
    create_draft: ["Schreibe Entwurf", "Entwurf gespeichert"],
    get_message: ["Lese Mail", "Mail gelesen"],
    list_mailboxes: ["Sehe Mailordner durch", "Mailordner gelesen"],
    send_mail: ["Sende Mail", "Mail gesendet"],
    create_mailbox: ["Lege Mailordner an", "Mailordner angelegt"],
    get_attachment: ["Lese Anhang", "Anhang gelesen"],
    delete_message: ["Lösche Mail", "Mail gelöscht"],
    mark_read: ["Markiere als gelesen", "Als gelesen markiert"],
    mark_unread: ["Markiere als ungelesen", "Als ungelesen markiert"],
  },
  nc_pim: {
    list_events: ["Sehe in den Kalender", "Termine gelesen"],
    add_event: ["Trage Termin ein", "Termin angelegt"],
    update_event: ["Verschiebe Termin", "Termin geändert"],
    delete_event: ["Lösche Termin", "Termin gelöscht"],
    list_contacts: ["Suche Kontakte", "Kontakte gelesen"],
    add_contact: ["Lege Kontakt an", "Kontakt angelegt"],
    update_contact: ["Ändere Kontakt", "Kontakt geändert"],
  },
  post: {
    mail_to_task: ["Mache Aufgabe aus der Mail", "Aufgabe aus Mail angelegt"],
    mail_to_event: ["Mache Termin aus der Mail", "Termin aus Mail angelegt"],
    mail_to_note: ["Mache Notiz aus der Mail", "Notiz aus Mail angelegt"],
  },
  lernen: {
    merke_praeferenz: ["Merke mir das", "Gemerkt"],
    gelernter_weg: ["Schaue nach bewährtem Weg", "Weg nachgeschaut"],
  },
  office: {
    create_document: ["Erstelle Dokument", "Dokument erstellt"],
  },
};

// Status lines for installation-specific tools (optional heim.config.ts).
// Checked before the built-ins below.
const heimConfig = import.meta.glob<{ TOOL_STATUS_EXTRA?: Array<[RegExp, Zeile]> }>("../heim.config.ts", { eager: true });

/** Tools without a module prefix (agent built-ins). */
const EINZELN: Array<[RegExp, Zeile]> = [
  ...(Object.values(heimConfig)[0]?.TOOL_STATUS_EXTRA ?? []),
  [/web_?search|websuche|tavily/i, ["Suche im Web", "Websuche fertig"]],
  [/fetch|seite_abrufen|read_url|web_fetch/i, ["Lese Webseite", "Webseite gelesen"]],
  [/ui_zeigen/i, ["Bereite Karte vor", "Karte angezeigt"]],
  [/ask_user|question/i, ["Frage nach", "Antwort erhalten"]],
  [/todo/i, ["Plane Schritte", "Plan aktualisiert"]],
  [/memory|mem0|erinner/i, ["Schaue in meine Notizen", "Erinnerung gelesen"]],
  [/navigate_to|open_window|open_in_viewer/i, ["Öffne die App", "App geöffnet"]],
  [/read_screen/i, ["Schaue auf den Bildschirm", "Bildschirm gelesen"]],
];

function zerlege(name: string): { modul: string; werkzeug: string } {
  const i = name.lastIndexOf("__");
  if (i < 0) return { modul: "", werkzeug: name };
  return { modul: name.slice(0, i).replace(/-/g, "_"), werkzeug: name.slice(i + 2) };
}

function finde(name: string): Zeile | null {
  const { modul, werkzeug } = zerlege(name);
  if (modul) {
    for (const [m, tabelle] of Object.entries(MODULE)) {
      if ((modul === m || modul.endsWith(`_${m}`)) && tabelle[werkzeug]) return tabelle[werkzeug];
    }
  }
  for (const [re, zeile] of EINZELN) if (re.test(name)) return zeile;
  if (!modul) {
    // Bare tool names (no module prefix): look them up in every module.
    for (const tabelle of Object.values(MODULE)) if (tabelle[werkzeug]) return tabelle[werkzeug];
  }
  return null;
}

/** "planner create task" from the raw name: readable, never the identifier. */
function rueckfall(name: string): string {
  const { modul, werkzeug } = zerlege(name);
  const kurz = (werkzeug || name).replace(/^(claraos_(modules|action)_|tool_retrieval_)/, "").replace(/_/g, " ").trim();
  const app = modul.replace(/^claraos_modules_/, "").split("_").pop() ?? "";
  const text = app && !kurz.includes(app) ? `${kurz} (${app})` : kurz;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The detail the agent put behind the colon ("…: Einkaufen..."), if useful. */
function detail(argsSummary: string | undefined): string {
  if (!argsSummary) return "";
  const i = argsSummary.indexOf(": ");
  if (i < 0) return "";
  const d = argsSummary.slice(i + 2).replace(/\.{3}$|…$/, "").trim();
  if (!d || /^[0-9a-f-]{8,}$/i.test(d) || /^\d+$/.test(d) || d.length < 2) return "";
  return d.length > 40 ? `${d.slice(0, 38)}…` : d;
}

/** Status line while a tool runs: "Lege Aufgabe an „Einkaufen“ …". */
export function statusLaeuft(name: string, argsSummary?: string): string {
  const z = finde(name);
  const d = detail(argsSummary);
  if (z) return `${z[0]}${d ? ` „${d}“` : ""} …`;
  // Agent texts for tools outside the table are often fine already.
  if (argsSummary && !/claraos|modules|_/.test(argsSummary)) return argsSummary;
  return `${rueckfall(name)} …`;
}

/** Status line after a tool: "Aufgabe angelegt ✓" or "Aufgabe anlegen fehlgeschlagen". */
export function statusFertig(name: string, ok: boolean): string {
  const z = finde(name);
  if (ok) return `${z ? z[1] : rueckfall(name)} ✓`;
  return `${z ? z[0] : rueckfall(name)} – fehlgeschlagen`;
}
