/**
 * Form cards of ask_user_question (`fields`): parsing the event payload and
 * building the answer. Pure, no React — the card and tests share it.
 *
 * Contract with clara-agent (agents/todo_tool.py): the event carries
 * `fields: [{name, label, type: text|choice|date|number, options?, placeholder?}]`;
 * the answer goes through POST /question-response as `answer` = JSON string of
 * an object {name: value}. Empty fields are sent as "" — the agent then makes
 * (and names) an assumption for them.
 */
import type { ClaraQuestionField } from "./api";

const TYPES = ["text", "choice", "date", "number"] as const;

/** Same limits as the agent: max 6 fields, max 8 choices. */
export function parseQuestionFields(raw: unknown): ClaraQuestionField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ClaraQuestionField[] = [];
  const seen = new Set<string>();
  for (const f of raw.slice(0, 6)) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    const label = String(o.label ?? "").trim();
    if (!name || !label || seen.has(name)) continue;
    seen.add(name);
    const type = (TYPES as readonly string[]).includes(String(o.type))
      ? (o.type as ClaraQuestionField["type"])
      : "text";
    const field: ClaraQuestionField = { name, label, type };
    if (type === "choice") {
      const opts = Array.isArray(o.options)
        ? o.options.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
        : [];
      // A choice without choices is a free-text field.
      if (opts.length) field.options = opts;
      else field.type = "text";
    }
    if (typeof o.placeholder === "string" && o.placeholder.trim()) field.placeholder = o.placeholder;
    if (o.required === true) field.required = true;
    out.push(field);
  }
  return out.length ? out : undefined;
}

export type FormValues = Record<string, string>;

/** The API cuts answers at 2000 characters — keep every field well below. */
export const FIELD_MAX_LEN = 300;

/**
 * Build the answer string. `missing` lists the labels of empty required
 * fields; then nothing may be sent.
 */
export function buildFormAnswer(
  fields: ClaraQuestionField[],
  values: FormValues,
): { answer: string; missing: string[] } {
  const data: Record<string, string | number> = {};
  const missing: string[] = [];
  for (const f of fields) {
    const v = (values[f.name] ?? "").trim().slice(0, FIELD_MAX_LEN);
    if (!v && f.required) missing.push(f.label);
    if (f.type === "number" && v !== "") {
      const n = Number(v.replace(",", "."));
      data[f.name] = Number.isFinite(n) ? n : v;
    } else {
      data[f.name] = v;
    }
  }
  return { answer: JSON.stringify(data), missing };
}
