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
 *
 * The texts live in the `chatWork` catalog (`status.*`) and are looked up when
 * a line is built, never at module load.
 */
import { i18n } from "@claraos/core";

type Zeile = readonly [laeuft: string, fertig: string];

/** Tools with a catalog status line: `status.<module>.<tool>.run` / `.done`. */
const MODULE: Record<string, readonly string[]> = {
  knowledge: [
    "capture_idea", "list_ideas", "get_object", "create_object", "list_collections",
    "create_collection", "create_collection_from_template", "add_to_collection", "define_type",
    "update_object", "add_insight", "link_objects", "promote_idea_to_plan", "get_backlinks",
    "move_object", "clip_url", "comment_on_object", "query_collection", "define_field",
    "create_view", "set_relation", "list_templates", "create_from_template", "duplicate_object",
    "get_backmentions", "get_history", "restore_version", "search_knowledge_db", "search",
    "list_goals", "suggest_ideas", "develop_concept", "rate_contribution", "link_to_goal",
    "promote_to_action_plan", "run_five_why", "pareto_analysis",
  ],
  planner: [
    "list_projects", "list_tasks", "count_tasks", "uebersicht", "get_task", "create_task",
    "update_task", "complete_task", "set_dependency", "move_card", "add_comment", "set_estimate",
    "create_project_from_plan", "start_work", "finish_work", "start_adhoc_work",
  ],
  mail: [
    "list_messages", "count_messages", "create_draft", "get_message", "list_mailboxes", "send_mail",
    "create_mailbox", "get_attachment", "delete_message", "mark_read", "mark_unread",
  ],
  nc_pim: [
    "list_events", "add_event", "update_event", "delete_event", "list_contacts", "add_contact",
    "update_contact",
  ],
  post: [
    "mail_to_task", "mail_to_event", "mail_to_note",
  ],
  lernen: [
    "merke_praeferenz", "gelernter_weg",
  ],
  office: [
    "create_document",
  ],
};

// Status lines for installation-specific tools (optional heim.config.ts).
// Checked before the built-ins below.
const heimConfig = import.meta.glob<{ TOOL_STATUS_EXTRA?: Array<[RegExp, Zeile]> }>("../heim.config.ts", { eager: true });

/**
 * Tools without a module prefix (agent built-ins). A string is a catalog key
 * (`status.builtin.<key>`); the installation's extra lines come as ready texts.
 */
const EINZELN: Array<[RegExp, Zeile | string]> = [
  ...(Object.values(heimConfig)[0]?.TOOL_STATUS_EXTRA ?? []),
  [/web_?search|websuche|tavily/i, "webSearch"],
  [/fetch|seite_abrufen|read_url|web_fetch/i, "webFetch"],
  [/ui_zeigen/i, "showCard"],
  [/ask_user|question/i, "askUser"],
  [/todo/i, "todo"],
  [/memory|mem0|erinner/i, "memory"],
  [/navigate_to|open_window|open_in_viewer/i, "openApp"],
  [/read_screen/i, "readScreen"],
];

/** Resolve a catalog entry at use time, so a language switch takes effect. */
function ausKatalog(key: string): Zeile {
  return [i18n.t(`chatWork:status.${key}.run`), i18n.t(`chatWork:status.${key}.done`)];
}

function zerlege(name: string): { modul: string; werkzeug: string } {
  const i = name.lastIndexOf("__");
  if (i < 0) return { modul: "", werkzeug: name };
  return { modul: name.slice(0, i).replace(/-/g, "_"), werkzeug: name.slice(i + 2) };
}

function finde(name: string): Zeile | null {
  const { modul, werkzeug } = zerlege(name);
  if (modul) {
    for (const [m, tabelle] of Object.entries(MODULE)) {
      if ((modul === m || modul.endsWith(`_${m}`)) && tabelle.includes(werkzeug)) return ausKatalog(`${m}.${werkzeug}`);
    }
  }
  for (const [re, zeile] of EINZELN) {
    if (re.test(name)) return typeof zeile === "string" ? ausKatalog(`builtin.${zeile}`) : zeile;
  }
  if (!modul) {
    // Bare tool names (no module prefix): look them up in every module.
    for (const [m, tabelle] of Object.entries(MODULE)) if (tabelle.includes(werkzeug)) return ausKatalog(`${m}.${werkzeug}`);
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
  if (z) return d ? i18n.t("chatWork:status.runningDetail", { what: z[0], detail: d }) : i18n.t("chatWork:status.running", { what: z[0] });
  // Agent texts for tools outside the table are often fine already.
  if (argsSummary && !/claraos|modules|_/.test(argsSummary)) return argsSummary;
  return i18n.t("chatWork:status.running", { what: rueckfall(name) });
}

/** Status line after a tool: "Aufgabe angelegt ✓" or "Aufgabe anlegen fehlgeschlagen". */
export function statusFertig(name: string, ok: boolean): string {
  const z = finde(name);
  if (ok) return i18n.t("chatWork:status.done", { what: z ? z[1] : rueckfall(name) });
  return i18n.t("chatWork:status.failed", { what: z ? z[0] : rueckfall(name) });
}
