import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  useWindowsStore,
  useUIStore,
  useAppRegistryStore,
  useSettingsStore,
  useAuthStore,
  COMMANDS,
  commandLabel,
  commandCategory,
  effectiveBindings,
  displayBinding,
  i18n,
  useTranslation,
  settingsModuleName,
} from "@claraos/core";
import styles from "./SearchOverlay.module.css";

interface SearchResult {
  id: string;
  type: "app" | "file" | "setting" | "command" | "calc";
  icon: string;
  title: string;
  subtitle: string;
  action: () => void;
}

/** The handful of commands that make sense from search. */
function runShellCommand(
  id: string,
  openWindow: (appId: string, opts?: Record<string, unknown>) => void,
): void {
  switch (id) {
    case "open-files":
      openWindow("files", { title: i18n.t("shell:search.window.files"), width: 900, height: 600 });
      break;
    case "open-settings":
      openWindow("settings", { title: i18n.t("shell:search.window.settings"), width: 900, height: 640 });
      break;
    case "task-manager":
      openWindow("task-manager", { title: i18n.t("shell:search.window.taskManager"), width: 720, height: 480 });
      break;
    case "screenshot":
      window.dispatchEvent(new CustomEvent("claraos-screenshot"));
      break;
    case "open-clipboard":
      window.dispatchEvent(new CustomEvent("claraos-toggle-clipboard"));
      break;
    case "show-desktop":
      useWindowsStore.getState().toggleShowDesktop();
      break;
    case "logout":
      useAuthStore.getState().logout();
      break;
    default:
      break;
  }
}

interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function SearchOverlay({ open, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fileResults, setFileResults] = useState<SearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const openWindow = useWindowsStore((s) => s.openWindow);
  const { t } = useTranslation("shell");

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setFileResults([]);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  // Search apps
  const appResults = useMemo((): SearchResult[] => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return useAppRegistryStore.getState().getAllApps()
      .filter((app) => app.name.toLowerCase().includes(q) || app.id.includes(q))
      .map((app) => ({
        id: `app-${app.id}`,
        type: "app" as const,
        icon: app.icon,
        title: app.name,
        subtitle: app.type === "iframe" ? t("search.subtitle.webApp") : t("search.subtitle.systemApp"),
        action: () => {
          openWindow(app.id, {
            title: app.name,
            width: app.window.defaultWidth,
            height: app.window.defaultHeight,
          });
          onClose();
        },
      }));
  }, [query, openWindow, onClose, t]);

  // Settings come from the schema, not from a list in code — otherwise search
  // only finds what someone thought of while typing, and every new module is
  // missing. Selecting one jumps directly into the module.
  const settingsModules = useSettingsStore((s) => s.modules);
  const loadSchema = useSettingsStore((s) => s.loadSchema);
  useEffect(() => {
    if (open && settingsModules.length === 0) void loadSchema();
  }, [open, settingsModules.length, loadSchema]);

  // Quick commands live in the terminal settings module — load them for search,
  // even if the terminal was never open in this session.
  useEffect(() => {
    if (open && !useSettingsStore.getState().values["terminal"]) {
      void useSettingsStore.getState().loadModule("terminal");
    }
  }, [open]);

  const settingResults = useMemo((): SearchResult[] => {
    if (!query.trim()) return [];
    return useSettingsStore
      .getState()
      .search(query)
      .slice(0, 5)
      .map((m) => ({
        id: `setting-${m.id}`,
        type: "setting" as const,
        icon: "⚙️",
        title: settingsModuleName(m.id, m.name),
        subtitle: t("search.subtitle.settings"),
        action: () => {
          openWindow("settings", { title: t("search.window.settings"), width: 900, height: 640 });
          // The settings app listens for this event and jumps into the module.
          setTimeout(
            () => window.dispatchEvent(
              new CustomEvent("claraos-settings-tab", { detail: { module: m.id } }),
            ),
            400,
          );
          onClose();
        },
      }));
  }, [query, openWindow, onClose, settingsModules, t]);

  // Shell commands (KRunner idea): whatever a keyboard shortcut can do should
  // also be typeable — including the currently active binding as a hint.
  const commandResults = useMemo((): SearchResult[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const overrides =
      (useSettingsStore.getState().values["shortcuts"]?.bindings as Record<string, string>) ?? {};
    const bindings = effectiveBindings(overrides);
    // Match the translated AND the registry label, so both languages find a command.
    return COMMANDS.filter((c) =>
      [commandLabel(c.id), commandCategory(c.category), c.label, c.category]
        .some((s) => s.toLowerCase().includes(q)),
    )
      .slice(0, 5)
      .map((c) => ({
        id: `cmd-${c.id}`,
        type: "command" as const,
        icon: "⌘",
        title: commandLabel(c.id),
        subtitle: `${commandCategory(c.category)} · ${displayBinding(bindings[c.id])}`,
        action: () => {
          runShellCommand(c.id, openWindow);
          onClose();
        },
      }));
  }, [query, openWindow, onClose]);

  // The terminal's quick commands (Konsole also puts them in the command
  // palette). Running one opens the terminal; the pasteGuard gate stays in the
  // terminal app — here we only deliver.
  const quickCmdResults = useMemo((): SearchResult[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const raw = useSettingsStore.getState().values["terminal"]?.quickCommands;
    if (!Array.isArray(raw)) return [];
    return (raw as { group?: string; name?: string; command?: string }[])
      .filter((c) => typeof c?.name === "string" && typeof c?.command === "string")
      .filter(
        (c) =>
          (c.name as string).toLowerCase().includes(q)
          || (c.group ?? "").toLowerCase().includes(q)
          || (c.command as string).toLowerCase().includes(q),
      )
      .slice(0, 5)
      .map((c) => ({
        id: `qc-${c.group ?? ""}-${c.name}`,
        type: "command" as const,
        icon: ">_",
        title: c.name as string,
        subtitle: t("search.subtitle.quickCommand", { group: c.group || t("search.terminal") }),
        action: () => {
          // FOCUS an existing terminal instead of opening a new one: a second
          // window would grab the same tmux session with -D, and the first
          // one's sender would write into a dead WebSocket.
          const W = useWindowsStore.getState();
          const existing = Object.values(W.windows).find((w) => w.appId === "terminal");
          if (existing) {
            W.restoreWindow(existing.id);
            W.focusWindow(existing.id);
          } else {
            openWindow("terminal", { title: t("search.terminal"), width: 1100, height: 640 });
          }
          window.dispatchEvent(
            new CustomEvent("claraos-terminal-quickcmd", { detail: { ...c } }),
          );
          onClose();
        },
      }));
  }, [query, openWindow, onClose, t]);

  // Calculate without detouring through an app — the KRunner classic.
  const calcResult = useMemo((): SearchResult[] => {
    const expr = query.trim();
    if (!/^[\d\s+\-*/().,%^]+$/.test(expr) || !/[+\-*/^%]/.test(expr)) return [];
    try {
      const normalized = expr.replace(/,/g, ".").replace(/\^/g, "**");
      // eslint-disable-next-line no-new-func
      const value = Function(`"use strict"; return (${normalized});`)();
      if (typeof value !== "number" || !Number.isFinite(value)) return [];
      const text = String(Number(value.toFixed(10)));
      return [{
        id: "calc",
        type: "calc" as const,
        icon: "=",
        title: text,
        subtitle: t("search.subtitle.calc"),
        action: () => {
          void navigator.clipboard?.writeText(text).catch(() => undefined);
          onClose();
        },
      }];
    } catch {
      return [];
    }
  }, [query, onClose, t]);

  // Search files (debounced API call)
  useEffect(() => {
    if (!query.trim() || query.length < 2) {
      setFileResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        // Real search instead of a tree dump down to depth 3: the old approach
        // found nothing deeper and loaded half the folder tree on every
        // keystroke.
        const res = await fetch(
          `/api/claraos/files/v2/search?q=${encodeURIComponent(query)}&limit=5`,
        );
        if (!res.ok) return;
        const data = await res.json();
        setFileResults(
          (data.results ?? data.items ?? []).slice(0, 5).map(
            (n: { name: string; path: string; isDir?: boolean }) => ({
              id: `file-${n.path}`,
              type: "file" as const,
              icon: n.isDir ? "📁" : "📄",
              title: n.name,
              subtitle: n.path,
              action: () => {
                openWindow("files", { title: t("search.window.files"), width: 900, height: 600 });
                onClose();
              },
            }),
          ),
        );
      } catch {
        // API not available
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, openWindow, onClose, t]);

  const allResults = useMemo(
    () => [
      ...calcResult, ...appResults, ...settingResults, ...commandResults,
      ...quickCmdResults, ...fileResults,
    ],
    [calcResult, appResults, settingResults, commandResults, quickCmdResults, fileResults],
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, allResults.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && allResults[selectedIndex]) {
        allResults[selectedIndex].action();
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [allResults, selectedIndex, onClose],
  );

  return (
    <>
      {open && <div className={styles.backdrop} onClick={onClose} />}
      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.overlay}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.15 }}
          >
            <div className={styles.searchBox}>
              <span className={styles.searchIcon}>🔍</span>
              <input
                ref={inputRef}
                className={styles.searchInput}
                placeholder={t("search.placeholder")}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
                onKeyDown={handleKeyDown}
              />
            </div>

            {query.trim() && (
              <div className={styles.results}>
                {allResults.length === 0 && (
                  <div className={styles.noResults}>{t("search.noResults", { query })}</div>
                )}

                {/* Order and offsets must match allResults —
                    otherwise Enter selects something other than what is highlighted. */}
                {calcResult.length > 0 && (
                  <ResultGroup label={t("search.group.calc")} results={calcResult} selectedIndex={selectedIndex} offset={0} />
                )}
                {appResults.length > 0 && (
                  <ResultGroup label={t("search.group.apps")} results={appResults} selectedIndex={selectedIndex} offset={calcResult.length} />
                )}
                {settingResults.length > 0 && (
                  <ResultGroup label={t("search.group.settings")} results={settingResults} selectedIndex={selectedIndex} offset={calcResult.length + appResults.length} />
                )}
                {commandResults.length > 0 && (
                  <ResultGroup label={t("search.group.commands")} results={commandResults} selectedIndex={selectedIndex} offset={calcResult.length + appResults.length + settingResults.length} />
                )}
                {quickCmdResults.length > 0 && (
                  <ResultGroup label={t("search.group.quickCommands")} results={quickCmdResults} selectedIndex={selectedIndex} offset={calcResult.length + appResults.length + settingResults.length + commandResults.length} />
                )}
                {fileResults.length > 0 && (
                  <ResultGroup label={t("search.group.files")} results={fileResults} selectedIndex={selectedIndex} offset={calcResult.length + appResults.length + settingResults.length + commandResults.length + quickCmdResults.length} />
                )}
              </div>
            )}

            {!query.trim() && (
              <div className={styles.quickActions}>
                <span className={styles.hint}>{t("search.hint")}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function ResultGroup({
  label,
  results,
  selectedIndex,
  offset,
}: {
  label: string;
  results: SearchResult[];
  selectedIndex: number;
  offset: number;
}) {
  return (
    <div className={styles.group}>
      <div className={styles.groupLabel}>{label}</div>
      {results.map((r, i) => (
        <div
          key={r.id}
          className={`${styles.resultItem} ${selectedIndex === offset + i ? styles.selected : ""}`}
          onClick={r.action}
        >
          <span className={styles.resultIcon}>{r.icon}</span>
          <div className={styles.resultText}>
            <span className={styles.resultTitle}>{r.title}</span>
            <span className={styles.resultSub}>{r.subtitle}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
