// Thin client for /api/claraos/tools/* — module-loader registry.
//
// Drives the per-app UI-hook buttons rendered above the Composer. Each
// installed module ships a clara-tools.yaml whose ui_hooks entries
// become quick-action chips (Summarize results, Add to Paperless, ...).
//
// Backend: see routers/clara_tools.py and services/clara_tools_registry.py
// Manifest: see claraos/modules/*/clara-tools.yaml

const BASE = "/api/claraos/tools";

// One UI-hook entry from a module clara-tools.yaml.
//
// location:     Dot-separated app context. The first segment is matched
//               against the focused ClaraOS app appId (paperless.documents
//               only shows when paperless is the focused app).
// label:        Button label shown to the user.
// icon:         Optional icon name (Lucide / shell-internal icon set).
// handler_tool: Tool the hook invokes when clicked. Resolved by
//               claraos-api against the same module tools list, or via
//               the agent's tool gateway if it is an agent-level tool.
// context:      Names of context fields the handler expects (query,
//               top5_urls, ...). The shell collects these from the
//               focused app store and ships them with the tool call.
// module:       Auto-injected by the registry — which installed module
//               the hook belongs to.
export interface ClaraUiHook {
  location: string;
  label: string;
  icon?: string;
  handler_tool: string;
  context?: string[];
  module: string;
}

export interface UiHooksResponse {
  summary: {
    modules: string[];
    tools_total: number;
    ui_hooks_total: number;
    errors: string[];
  };
  ui_hooks: ClaraUiHook[];
}

// Fetch all registered UI-hooks across installed modules.
export async function fetchUiHooks(signal?: AbortSignal): Promise<ClaraUiHook[]> {
  const resp = await fetch(`${BASE}/ui-hooks`, { signal });
  if (!resp.ok) {
    throw new Error(`fetchUiHooks: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as UiHooksResponse;
  return data.ui_hooks ?? [];
}

// Direct tool-call proxy. The shell only uses it when the user clicks a
// hook that should run without going through Clara-Agent. When Clara
// should reason about the call, prefill the Composer instead.
//
// Auth headers (oidc_token / api_key / basic / none) are handled by
// the backend per-tool. The browser only sends the payload.
export async function callTool(
  module: string,
  tool: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const resp = await fetch(
    `${BASE}/call/${encodeURIComponent(module)}/${encodeURIComponent(tool)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`callTool ${module}/${tool}: HTTP ${resp.status} ${text}`);
  }
  return resp.json();
}

// Filter hooks for a focused app. Matches the first segment of location
// against appId. Returns all hooks when appId is undefined (used by the
// global Module-actions overview).
export function hooksForApp(hooks: ClaraUiHook[], appId: string | undefined): ClaraUiHook[] {
  if (!appId) return hooks;
  const prefix = appId.split(".")[0];
  return hooks.filter((h) => h.location.split(".")[0] === prefix);
}
