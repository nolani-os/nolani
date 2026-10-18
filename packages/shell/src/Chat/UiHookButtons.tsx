// Per-app module-actions sidebar above the Composer.
//
// Reads /api/claraos/tools/ui-hooks (drop-in registry from claraos-api).
// Two-tier layout:
//   1) "For <appId>" — hooks whose location-prefix matches the focused
//      app, prominently shown.
//   2) "All Modules"  — collapsed by default, expands a per-module
//      grouping of every hook in the registry. Lets the user reach a tool
//      even when its module is not the focused app.
//
// Click → onHookSelected with resolved hook.context (parent decides
// whether to prefill the Composer or fire the tool directly).

import { useEffect, useMemo, useState } from "react";
import { fetchUiHooks, hooksForApp, type ClaraUiHook } from "./toolsApi";
import styles from "./UiHookButtons.module.css";

interface Props {
  appId?: string;
  appContext?: Record<string, unknown>;
  onHookSelected: (hook: ClaraUiHook, resolvedContext: Record<string, unknown>) => void;
}

// Resolve hook.context names against the live app-context dict.
// Missing keys are skipped so a partial match still produces a usable
// prompt — Clara can prompt the user for the rest.
export function resolveHookContext(
  hook: ClaraUiHook,
  appContext: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!appContext || !hook.context?.length) return {};
  const out: Record<string, unknown> = {};
  for (const field of hook.context) {
    if (field in appContext && appContext[field] !== undefined) {
      out[field] = appContext[field];
    }
  }
  return out;
}

function HookChip({
  hook,
  isMatched,
  onClick,
}: {
  hook: ClaraUiHook;
  isMatched: boolean;
  onClick: () => void;
}) {
  const title = [
    hook.handler_tool,
    hook.module,
    hook.context?.length ? `needs: ${hook.context.join(", ")}` : "",
    hook.location,
  ].filter(Boolean).join(" · ");
  return (
    <button
      key={`${hook.module}:${hook.location}:${hook.label}`}
      type="button"
      className={`${styles.chip} ${isMatched ? styles.chipMatched : styles.chipDimmed}`}
      title={title}
      onClick={onClick}
    >
      <span>{hook.label}</span>
      <span className={styles.module}>{hook.module}</span>
    </button>
  );
}

export function UiHookButtons({ appId, appContext, onHookSelected }: Props) {
  const [hooks, setHooks] = useState<ClaraUiHook[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchUiHooks(ctrl.signal)
      .then(setHooks)
      .catch((e) => {
        if (e.name !== "AbortError") setError(String(e?.message ?? e));
      });
    return () => ctrl.abort();
  }, []);

  // Matched + remaining split — matched are prominent; everything else
  // (incl. matched modules that have additional hooks) goes to the
  // module-grouped expand panel.
  const { matched, allByModule, otherModuleCount } = useMemo(() => {
    const matchedHooks = appId ? hooksForApp(hooks, appId) : [];
    const matchedKeys = new Set(matchedHooks.map(h => `${h.module}:${h.location}:${h.label}`));
    const byModule: Record<string, ClaraUiHook[]> = {};
    for (const h of hooks) {
      const key = `${h.module}:${h.location}:${h.label}`;
      if (matchedKeys.has(key)) continue;
      (byModule[h.module] ||= []).push(h);
    }
    return {
      matched: matchedHooks,
      allByModule: byModule,
      otherModuleCount: Object.keys(byModule).length,
    };
  }, [hooks, appId]);

  if (error || hooks.length === 0) return null;

  const click = (h: ClaraUiHook) =>
    onHookSelected(h, resolveHookContext(h, appContext));

  return (
    <div className={styles.container} aria-label="Module actions">
      {matched.length > 0 && (
        <div className={styles.row}>
          <span className={styles.label}>
            {appId ? `Für ${appId}` : "Aktionen"}
          </span>
          {matched.map(h => (
            <HookChip key={`${h.module}:${h.location}:${h.label}`}
                      hook={h} isMatched={true} onClick={() => click(h)} />
          ))}
        </div>
      )}

      {otherModuleCount > 0 && (
        <div className={styles.expandRow}>
          <button
            type="button"
            className={styles.expandToggle}
            onClick={() => setExpandAll(v => !v)}
            title="Aktionen aus anderen Modulen anzeigen"
          >
            <span className={styles.expandIcon}>{expandAll ? "▾" : "▸"}</span>
            <span>{expandAll ? "Modul-Aktionen ausblenden" : `🧩 Modul-Aktionen (${otherModuleCount})`}</span>
          </button>
          {expandAll && (
            <div className={styles.modulesGrid}>
              {Object.entries(allByModule).map(([module, list]) => (
                <div key={module} className={styles.moduleGroup}>
                  <div className={styles.moduleHeader}>{module}</div>
                  <div className={styles.moduleChips}>
                    {list.map(h => (
                      <HookChip
                        key={`${h.module}:${h.location}:${h.label}`}
                        hook={h}
                        isMatched={false}
                        onClick={() => click(h)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
