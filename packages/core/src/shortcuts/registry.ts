/**
 * Keyboard shortcut registry.
 *
 * Modeled on KDE's kcm_keys: shortcuts are data, not an if cascade. Every
 * command has an id, a label and a default key combination; the user may
 * override it, conflicts are detected, and a reset restores the default.
 *
 * Pure functions without DOM/store — the shell hook uses them, so does the
 * settings page, and the tests run in Node.
 */

export interface CommandDef {
  id: string;
  label: string;
  category: string;
  /** Default in normal form, e.g. "Meta+E". Empty = no default shortcut. */
  defaultBinding: string;
  /** Not rebindable (system/browser convention). */
  fixed?: boolean;
}

/**
 * The shell's rebindable commands.
 *
 * Deliberately NOT included: Alt+Tab (hold behavior), Win alone (start menu)
 * and Win+, (peek while held) — these depend on key-press states, not on a
 * combination, and would be misleading as a data row.
 */
export const COMMANDS: CommandDef[] = [
  { id: "open-files", label: "Dateien öffnen", category: "Apps", defaultBinding: "Meta+E" },
  { id: "open-settings", label: "Einstellungen öffnen", category: "Apps", defaultBinding: "Meta+I" },
  { id: "open-search", label: "Suche öffnen", category: "Shell", defaultBinding: "Meta+Q" },
  { id: "quick-settings", label: "Schnelleinstellungen", category: "Shell", defaultBinding: "Meta+A" },
  { id: "open-clipboard", label: "Zwischenablage-Chronik", category: "Shell", defaultBinding: "Meta+V" },
  { id: "screenshot", label: "Bildschirmfoto", category: "Shell", defaultBinding: "Shift+Meta+S" },
  { id: "show-desktop", label: "Desktop anzeigen", category: "Fenster", defaultBinding: "Meta+D" },
  { id: "task-manager", label: "Task-Manager", category: "Shell", defaultBinding: "Ctrl+Shift+Escape" },
  { id: "logout", label: "Abmelden", category: "Sitzung", defaultBinding: "Meta+L" },
  { id: "close-window", label: "Fenster schließen", category: "Fenster", defaultBinding: "Ctrl+W" },
  { id: "snap-left", label: "Fenster links andocken", category: "Fenster", defaultBinding: "Meta+ArrowLeft" },
  { id: "snap-right", label: "Fenster rechts andocken", category: "Fenster", defaultBinding: "Meta+ArrowRight" },
  { id: "maximize", label: "Fenster maximieren", category: "Fenster", defaultBinding: "Meta+ArrowUp" },
  { id: "minimize", label: "Fenster minimieren", category: "Fenster", defaultBinding: "Meta+ArrowDown" },
];

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

/** Normal form of a combination: modifiers in a fixed order, then the key. */
export function normalizeBinding(binding: string): string {
  if (!binding) return "";
  const parts = binding.split("+").map((p) => p.trim()).filter(Boolean);
  const mods = new Set<string>();
  let key = "";
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === "ctrl" || lower === "control") mods.add("Ctrl");
    else if (lower === "alt") mods.add("Alt");
    else if (lower === "shift") mods.add("Shift");
    else if (lower === "meta" || lower === "super" || lower === "win" || lower === "cmd")
      mods.add("Meta");
    else key = p.length === 1 ? p.toUpperCase() : p;
  }
  if (!key) return "";
  const ordered = MODIFIER_ORDER.filter((m) => mods.has(m));
  return [...ordered, key].join("+");
}

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Normal form from a keyboard event (for capturing and for triggering). */
export function bindingFromEvent(e: KeyEventLike): string {
  const key = e.key;
  // Pressing only modifiers does not form a combination yet
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(key)) return "";
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  const norm = key.length === 1 ? key.toUpperCase() : key;
  return [...mods, norm].join("+");
}

export type BindingMap = Record<string, string>;

/** Effective bindings: defaults, overridden by the user's bindings. */
export function effectiveBindings(overrides: BindingMap = {}): BindingMap {
  const out: BindingMap = {};
  for (const cmd of COMMANDS) {
    const custom = overrides[cmd.id];
    out[cmd.id] = cmd.fixed
      ? cmd.defaultBinding
      : normalizeBinding(custom ?? cmd.defaultBinding);
  }
  return out;
}

/** Which command belongs to this key press? */
export function commandForEvent(e: KeyEventLike, overrides: BindingMap = {}): string | null {
  const binding = bindingFromEvent(e);
  if (!binding) return null;
  const map = effectiveBindings(overrides);
  for (const [id, b] of Object.entries(map)) {
    if (b && b === binding) return id;
  }
  return null;
}

export interface Conflict {
  binding: string;
  commandIds: string[];
}

/** Combinations bound more than once — the settings page shows them. */
export function findConflicts(overrides: BindingMap = {}): Conflict[] {
  const map = effectiveBindings(overrides);
  const byBinding: Record<string, string[]> = {};
  for (const [id, b] of Object.entries(map)) {
    if (!b) continue;
    (byBinding[b] ??= []).push(id);
  }
  return Object.entries(byBinding)
    .filter(([, ids]) => ids.length > 1)
    .map(([binding, commandIds]) => ({ binding, commandIds }));
}

/** Display form ("Meta+E" → "Win + E"). */
export function displayBinding(binding: string): string {
  if (!binding) return "—";
  return binding
    .split("+")
    .map((p) => {
      if (p === "Meta") return "Win";
      if (p === "ArrowLeft") return "←";
      if (p === "ArrowRight") return "→";
      if (p === "ArrowUp") return "↑";
      if (p === "ArrowDown") return "↓";
      if (p === "Escape") return "Esc";
      return p;
    })
    .join(" + ");
}

export function commandById(id: string): CommandDef | undefined {
  return COMMANDS.find((c) => c.id === id);
}
