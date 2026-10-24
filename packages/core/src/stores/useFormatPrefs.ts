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
import { DEFAULT_FORMAT_PREFS, localeTag, resolveRegion, type FormatPrefs } from "../format";

const MODULE = "region-formats";

function browserLanguages(): readonly string[] {
  return typeof navigator !== "undefined" ? navigator.languages ?? [] : [];
}

function fromValues(values: Record<string, unknown> | undefined): FormatPrefs {
  // Not loaded yet (or a public page without settings): the default "auto".
  if (!values) return { ...DEFAULT_FORMAT_PREFS, locale: resolveRegion("auto", browserLanguages()) };
  return {
    locale: resolveRegion((values.locale as string) || "auto", browserLanguages()),
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

/**
 * Locale tag for `toLocaleDateString(regionLocale(), {...})` and friends —
 * instead of a hard-coded "de-DE". Read at call time, not reactive: a changed
 * region shows on the next render of that component.
 */
export function regionLocale(): string {
  return localeTag(getFormatPrefs());
}

/** Load once at startup — the AppearanceManager calls this too. */
export async function loadFormatPrefs(): Promise<void> {
  await useSettingsStore.getState().loadModule(MODULE);
}
