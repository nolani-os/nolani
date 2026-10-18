/**
 * Access to the region formats from the settings.
 *
 * Two ways, on purpose:
 *   useFormatPrefs()   — for components (re-renders on change)
 *   getFormatPrefs()   — for non-React code (helpers, formatters)
 *
 * Falls back to the schema defaults while the module is not loaded — so the
 * UI never formats "empty", but with the default (German) locale.
 */
import { useSettingsStore } from "./settings";
import { DEFAULT_FORMAT_PREFS, type FormatPrefs } from "../format";

const MODULE = "region-formats";

function fromValues(values: Record<string, unknown> | undefined): FormatPrefs {
  if (!values) return DEFAULT_FORMAT_PREFS;
  return {
    locale: (values.locale as string) || DEFAULT_FORMAT_PREFS.locale,
    timeFormat: (values.timeFormat as FormatPrefs["timeFormat"]) || "region",
    firstDayOfWeek:
      (values.firstDayOfWeek as FormatPrefs["firstDayOfWeek"]) || "region",
    currency: (values.currency as string) || DEFAULT_FORMAT_PREFS.currency,
    binaryDialect:
      (values.binaryDialect as FormatPrefs["binaryDialect"]) || "iec",
  };
}

export function useFormatPrefs(): FormatPrefs {
  const values = useSettingsStore((s) => s.values[MODULE]);
  return fromValues(values);
}

export function getFormatPrefs(): FormatPrefs {
  return fromValues(useSettingsStore.getState().values[MODULE]);
}

/** Load once at startup — the AppearanceManager calls this too. */
export async function loadFormatPrefs(): Promise<void> {
  await useSettingsStore.getState().loadModule(MODULE);
}
