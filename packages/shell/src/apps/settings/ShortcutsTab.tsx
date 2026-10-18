/**
 * Keyboard shortcut editor.
 *
 * Modeled on KDE's kcm_keys: list of all commands by category, clicking a
 * binding starts recording, conflicts are named instead of silently
 * overwritten, and each row can be reset individually.
 */
import { useEffect, useMemo, useState } from "react";
import {
  useSettingsStore,
  COMMANDS,
  effectiveBindings,
  bindingFromEvent,
  displayBinding,
  findConflicts,
  commandById,
  type BindingMap,
} from "@claraos/core";
import styles from "./SettingsApp.module.css";

const MODULE = "shortcuts";

export function ShortcutsTab() {
  const values = useSettingsStore((s) => s.values[MODULE]);
  const loadModule = useSettingsStore((s) => s.loadModule);
  const setDraft = useSettingsStore((s) => s.setDraft);
  const apply = useSettingsStore((s) => s.apply);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadModule(MODULE);
  }, [loadModule]);

  const overrides = useMemo<BindingMap>(
    () => ((values?.bindings as BindingMap) ?? {}),
    [values],
  );
  const bindings = useMemo(() => effectiveBindings(overrides), [overrides]);
  const conflicts = useMemo(() => findConflicts(overrides), [overrides]);

  const conflictFor = (id: string) =>
    conflicts.find((c) => c.commandIds.includes(id));

  const save = async (next: BindingMap) => {
    setDraft(MODULE, "bindings", next);
    await apply(MODULE);
    await loadModule(MODULE);
  };

  // Recording: the next key press becomes the binding.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      const binding = bindingFromEvent(e);
      if (!binding) return; // modifier only — keep waiting
      const next = { ...overrides, [capturing]: binding };
      const clash = findConflicts(next).find((c) => c.commandIds.includes(capturing));
      if (clash) {
        const other = clash.commandIds.find((i) => i !== capturing);
        setError(
          `„${displayBinding(binding)}“ ist schon mit „${commandById(other ?? "")?.label ?? other}“ belegt.`,
        );
        setCapturing(null);
        return;
      }
      setError("");
      setCapturing(null);
      void save(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, overrides]); // eslint-disable-line react-hooks/exhaustive-deps

  const categories = useMemo(() => {
    const map = new Map<string, typeof COMMANDS>();
    for (const c of COMMANDS) {
      const list = map.get(c.category) ?? [];
      list.push(c);
      map.set(c.category, list);
    }
    return [...map.entries()];
  }, []);

  return (
    <div className={styles.form}>
      {error && <div className={styles.inlineError}>{error}</div>}

      {categories.map(([category, cmds]) => (
        <div key={category}>
          <div className={styles.navGroupTitle}>{category}</div>
          {cmds.map((cmd) => {
            const clash = conflictFor(cmd.id);
            const isCustom = overrides[cmd.id] !== undefined;
            return (
              <div key={cmd.id} className={styles.row}>
                <div className={styles.rowLabel}>
                  <label>{cmd.label}</label>
                  {clash && (
                    <p className={styles.rowDesc} style={{ color: "var(--accent)" }}>
                      Doppelt belegt mit „
                      {commandById(clash.commandIds.find((i) => i !== cmd.id) ?? "")?.label}“
                    </p>
                  )}
                </div>
                <div className={styles.rowControl}>
                  <button
                    type="button"
                    className={styles.bindingBtn}
                    onClick={() => {
                      setError("");
                      setCapturing(cmd.id);
                    }}
                    aria-label={`Kürzel für ${cmd.label} ändern`}
                  >
                    {capturing === cmd.id
                      ? "Taste drücken… (Esc bricht ab)"
                      : displayBinding(bindings[cmd.id])}
                  </button>
                  {isCustom && (
                    <button
                      type="button"
                      className={styles.resetBtn}
                      title="Auf Standard zurücksetzen"
                      onClick={() => {
                        const next = { ...overrides };
                        delete next[cmd.id];
                        void save(next);
                      }}
                    >
                      ↺
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      <p className={styles.rowDesc} style={{ marginTop: 12 }}>
        Alt+Tab, die Windows-Taste allein und Win+, lassen sich nicht umbelegen —
        sie reagieren auf Halten und Loslassen, nicht auf eine Kombination.
      </p>
    </div>
  );
}
