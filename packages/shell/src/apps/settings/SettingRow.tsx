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
import { useSetting, useTranslation, settingText, languageName, i18n, type TFunction } from "@claraos/core";
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
  const { t } = useTranslation("settings");
  if (!def) return null;

  const label = settingText(moduleId, def.key, "label", def.label);
  const description = settingText(moduleId, def.key, "description", def.description ?? "");

  const showMarker = highlightChanged && !isDefault;

  return (
    <div className={`${styles.row} ${enabled ? "" : styles.rowDisabled}`}>
      <div className={styles.rowLabel}>
        <label htmlFor={`set-${moduleId}-${settingKey}`}>
          {showMarker && (
            <span className={styles.changedMarker} title={t("row.changed")} aria-hidden />
          )}
          {label}
        </label>
        {description && <p className={styles.rowDesc}>{description}</p>}
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
                {enumLabel(t, def.key, c)}
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
                aria-label={t("row.color", { value: preset })}
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
              title={t("row.customColor")}
            />
          </div>
        )}

        {!isDefault && (
          <IconButton
            groesse="s"
            icon="restore"
            label={t("row.reset", { label })}
            onClick={() => void reset()}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Labels for enum values from the "settings" catalog (`enum.<key>.<choice>`);
 * the UI language picker shows each language in its own name. Unknown values
 * stay raw.
 */
function enumLabel(t: TFunction, key: string, choice: string): string {
  if (key === "uiLanguage" && choice !== "system") return languageName(choice);
  // Region and currency names come from Intl in the UI language — no
  // catalog entries to maintain per region ("German (Austria)").
  if ((key === "locale" && choice !== "auto") || key === "currency") {
    const name = displayName(key === "locale" ? "language" : "currency", choice);
    if (name) return key === "currency" ? `${name} (${choice})` : name;
  }
  return t(`enum.${key}.${choice}`, { defaultValue: choice });
}

function displayName(type: "language" | "currency", code: string): string | undefined {
  try {
    return new Intl.DisplayNames([i18n.language], { type }).of(code);
  } catch {
    return undefined;
  }
}
