/**
 * The single list of UI languages.
 *
 * Adding a language = one entry here + a folder `locales/<code>/` in the shell.
 * The settings schema (`settings_schema.py`, key `uiLanguage`) must list the
 * same codes — `test_settings_schema.py` reads this file and fails on drift.
 *
 * Pure data and functions, no i18next import — testable in Node.
 */

export const LANGUAGES = [
  { code: "de", name: "Deutsch" },
  { code: "en", name: "English" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

/** Missing keys in any language fall back to this one. */
export const FALLBACK_LANGUAGE: LanguageCode = "de";

/** Setting value: a language code, or "system" = follow the browser. */
export type UiLanguageSetting = LanguageCode | "system";

export function isLanguageCode(value: unknown): value is LanguageCode {
  return LANGUAGES.some((l) => l.code === value);
}

/**
 * Resolve the setting to a concrete language.
 *
 * "system" takes the first browser language we support ("en-US" → "en");
 * if none matches, the fallback language applies.
 */
export function resolveUiLanguage(
  setting: unknown,
  browserLanguages: readonly string[] = [],
): LanguageCode {
  if (isLanguageCode(setting)) return setting;
  for (const tag of browserLanguages) {
    const base = tag.toLowerCase().split("-")[0];
    if (isLanguageCode(base)) return base;
  }
  return FALLBACK_LANGUAGE;
}

/** Native name for the language picker ("English", not "Englisch"). */
export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}
