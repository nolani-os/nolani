/**
 * toolAppMap — maps a Clara tool call (claraos_event tool.start) to the
 * ClaraOS app whose UI shows the effect, so the mobile overlay can bring that
 * app into the cobrowse split-view automatically ("watch Clara work").
 *
 * Matching is on the FULL tool name, not the event's `server` field — the
 * agent derives `server` as the prefix before the first "_", which is wrong
 * for tools like `execute_<app>_code` (server="execute") or the bridged
 * `claraos_modules_*` tools (server="claraos").
 *
 * Allowlist only: unmapped tools simply never trigger the split (safe
 * default). Meta/UI-dispatch servers (claraos_action, memory, todo,
 * meta_platform, tool_retrieval, …) must NOT appear here.
 */

const PREFIX_MAP: Array<[prefix: string, appId: string]> = [
  // app REST/API tools (server == first token, kept for readability)
  ["immich_", "immich"],
  ["paperless_", "paperless"],
  ["peertube_", "peertube"],
  ["mastodon_", "mastodon"],
];

// Tools of installation-specific apps (optional heim/toolAppMap.ts).
// Checked after the product prefixes.
for (const mod of Object.values(
  import.meta.glob<{ heimToolPrefixes?: Array<[string, string]> }>("../heim/toolAppMap.ts", { eager: true }),
)) PREFIX_MAP.push(...(mod.heimToolPrefixes ?? []));

/** Bridged module tools: claraos_modules_<domain>_<app>__<tool> */
const MODULE_TOOL_RE = /^claraos_modules_[a-z0-9]+_([a-z0-9-]+)__/;

/** Resolve the app id a tool call belongs to, or null when it has no app UI. */
export function appIdForTool(tool: string | undefined): string | null {
  if (!tool) return null;
  for (const [prefix, appId] of PREFIX_MAP) {
    if (tool.startsWith(prefix)) return appId;
  }
  const m = MODULE_TOOL_RE.exec(tool);
  if (m) return m[1];
  return null;
}
