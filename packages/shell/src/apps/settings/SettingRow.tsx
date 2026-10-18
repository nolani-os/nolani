/**
 * Generic field renderer.
 *
 * Renders a setting from its schema definition — the settings app knows NO
 * concrete keys. Patterns adopted from KDE:
 *   - label as a sentence fragment, description below (no prose block)
 *   - marker + reset button right at the field when ≠ default
 *     (KDE only shows the marker; the per-field reset is our improvement)
 *   - dependsOn visibly disables the field instead of hiding it
 */
import { useSetting } from "@claraos/core";
import { ACCENT_PRESETS } from "@claraos/skins";
import styles from "./SettingsApp.module.css";
import { IconButton } from "../../components/Button";

interface Props {
  moduleId: string;
  settingKey: string;
  /** Show the marker only when "highlight changed settings" is enabled */
  highlightChanged: boolean;
}

export function SettingRow({ moduleId, settingKey, highlightChanged }: Props) {
  const { def, value, enabled, isDefault, setValue, reset } = useSetting(moduleId, settingKey);
  if (!def) return null;

  const showMarker = highlightChanged && !isDefault;

  return (
    <div className={`${styles.row} ${enabled ? "" : styles.rowDisabled}`}>
      <div className={styles.rowLabel}>
        <label htmlFor={`set-${moduleId}-${settingKey}`}>
          {showMarker && (
            <span className={styles.changedMarker} title="Weicht vom Standard ab" aria-hidden />
          )}
          {def.label}
        </label>
        {def.description && <p className={styles.rowDesc}>{def.description}</p>}
      </div>

      <div className={styles.rowControl}>
        {def.type === "bool" && (
          <input
            id={`set-${moduleId}-${settingKey}`}
            type="checkbox"
            role="switch"
            disabled={!enabled}
            checked={Boolean(value)}
            onChange={(e) => setValue(e.target.checked)}
          />
        )}

        {def.type === "enum" && (
          <select
            id={`set-${moduleId}-${settingKey}`}
            disabled={!enabled}
            value={String(value ?? "")}
            onChange={(e) => setValue(e.target.value)}
          >
            {def.choices.map((c) => (
              <option key={c} value={c}>
                {enumLabel(def.key, c)}
              </option>
            ))}
          </select>
        )}

        {(def.type === "int" || def.type === "float") && (
          <input
            id={`set-${moduleId}-${settingKey}`}
            type="number"
            disabled={!enabled}
            value={Number(value ?? 0)}
            min={def.min ?? undefined}
            max={def.max ?? undefined}
            step={def.type === "int" ? 1 : 0.1}
            onChange={(e) =>
              setValue(def.type === "int" ? parseInt(e.target.value, 10) : parseFloat(e.target.value))
            }
          />
        )}

        {def.type === "string" && (
          <input
            id={`set-${moduleId}-${settingKey}`}
            type="text"
            disabled={!enabled}
            value={String(value ?? "")}
            maxLength={def.max ?? undefined}
            onChange={(e) => setValue(e.target.value)}
          />
        )}

        {def.type === "color" && (
          <div className={styles.colorPicker}>
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`${styles.swatch} ${
                  String(value).toLowerCase() === preset ? styles.swatchActive : ""
                }`}
                style={{ background: preset }}
                title={preset}
                aria-label={`Farbe ${preset}`}
                disabled={!enabled}
                onClick={() => setValue(preset)}
              />
            ))}
            <input
              id={`set-${moduleId}-${settingKey}`}
              type="color"
              disabled={!enabled}
              value={String(value ?? "#3daee9")}
              onChange={(e) => setValue(e.target.value)}
              title="Eigene Farbe wählen"
            />
          </div>
        )}

        {!isDefault && (
          <IconButton
            groesse="s"
            icon="restore"
            label={`${def.label} auf Standard zurücksetzen`}
            onClick={() => void reset()}
          />
        )}
      </div>
    </div>
  );
}

/** German labels for enum values; unknown values stay raw. */
const ENUM_LABELS: Record<string, Record<string, string>> = {
  clickBehavior: { single: "Öffnet sie", double: "Wählt sie aus (Doppelklick öffnet)" },
  animationSpeed: { instant: "Sofort (aus)", fast: "Schnell", normal: "Normal", slow: "Langsam" },
  viewMode: {
    "icons-large": "Große Symbole", "icons-small": "Kleine Symbole",
    list: "Liste", details: "Details",
  },
  sortKey: { name: "Name", modified: "Geändert", size: "Größe", type: "Typ" },
  sortDir: { asc: "Aufsteigend", desc: "Absteigend" },
  groupBy: { none: "Nicht gruppieren", type: "Nach Typ", date: "Nach Datum" },
  closeSplitViewChoice: {
    active: "Die aktive Seite", inactive: "Die inaktive Seite", right: "Immer die rechte Seite",
  },
};

function enumLabel(key: string, choice: string): string {
  return ENUM_LABELS[key]?.[choice] ?? choice;
}
