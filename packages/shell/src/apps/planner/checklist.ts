/** Markdown checkbox checklist in task descriptions (Vikunja convention:
 * `- [ ] item` / `- [x] item`). No Markdown renderer in-house (deliberately)
 * → we only parse the checkbox lines, the rest stays plain text
 * (white-space: pre-wrap).
 * Note: Vikunja sometimes stores descriptions as HTML (<p>…) — we only
 * handle plain-text descriptions with checkbox lines structurally. */

export interface ChecklistItem {
  /** Line index in the description */
  line: number;
  text: string;
  checked: boolean;
}

export interface ParsedDescription {
  items: ChecklistItem[];
  /** true if the description appears to be HTML (then no toggle UI) */
  isHtml: boolean;
}

const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/;

export function parseChecklist(description?: string): ParsedDescription {
  if (!description) return { items: [], isHtml: false };
  if (/^\s*</.test(description)) {
    // HTML description (e.g. from the Vikunja UI editor) — checkboxes there are
    // <ul data-type="taskList"> — we don't support toggling those here.
    return { items: [], isHtml: true };
  }
  const items: ChecklistItem[] = [];
  description.split("\n").forEach((raw, i) => {
    const m = CHECKBOX_RE.exec(raw);
    if (m) items.push({ line: i, text: m[2], checked: m[1].toLowerCase() === "x" });
  });
  return { items, isHtml: false };
}

/** Toggle an item → new description (immutable). */
export function toggleChecklistLine(description: string, line: number): string {
  const lines = description.split("\n");
  const m = CHECKBOX_RE.exec(lines[line] ?? "");
  if (!m) return description;
  const checked = m[1].toLowerCase() === "x";
  lines[line] = lines[line].replace(/\[([ xX])\]/, checked ? "[ ]" : "[x]");
  return lines.join("\n");
}

/** Append a new item. */
export function appendChecklistItem(description: string | undefined, text: string): string {
  const item = `- [ ] ${text}`;
  if (!description || !description.trim()) return item;
  return `${description.replace(/\n+$/, "")}\n${item}`;
}

export function checklistProgress(items: ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter((i) => i.checked).length, total: items.length };
}
