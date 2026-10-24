/**
 * UI translation (i18next).
 *
 * core owns the instance and re-exports the React hooks, so apps only import
 * from "@claraos/core" — never from i18next directly. The shell hands in a
 * loader for the catalogs (`locales/<lng>/<ns>.json`), each namespace is
 * fetched on first use.
 *
 * Two axes, as in KDE: the UI language lives here, number/date formats stay
 * in `format.ts` and follow the region setting independently.
 */
import i18next, { type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";
import {
  FALLBACK_LANGUAGE,
  LANGUAGES,
  resolveUiLanguage,
  type LanguageCode,
} from "./languages";
import { commandById } from "../shortcuts/registry";
import { brandVariables } from "../brand";
import {
  dndRemaining,
  dndRemainingLabel,
  type NotificationPolicy,
} from "../notifications/policy";

export { useTranslation, Trans } from "react-i18next";
export type { TFunction } from "i18next";
export const i18n = i18next;

export type CatalogLoader = (
  lng: string,
  ns: string,
) => Promise<Record<string, unknown> | undefined>;

/** Last applied language, so a reload starts in it before the settings arrive. */
const STORAGE_KEY = "claraos-ui-language";

function browserLanguages(): readonly string[] {
  return typeof navigator !== "undefined" ? navigator.languages ?? [] : [];
}

function rememberedLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Language to start with: the remembered one, else the browser's. */
export function initialUiLanguage(): LanguageCode {
  return resolveUiLanguage(rememberedLanguage() ?? "system", browserLanguages());
}

/**
 * Initialise i18next. Resolves once the start namespaces are loaded, so the
 * first render already shows translated text instead of raw keys.
 */
export function initI18n(
  loader: CatalogLoader,
  options: { lng?: LanguageCode; ns?: string[] } = {},
): Promise<unknown> {
  const backend: BackendModule = {
    type: "backend",
    init() {},
    read(lng, ns, callback) {
      loader(lng, ns)
        .then((data) => callback(null, data ?? {}))
        .catch((err: Error) => callback(err, false));
    },
  };
  const lng = options.lng ?? initialUiLanguage();
  if (typeof document !== "undefined") document.documentElement.lang = lng;
  return i18next
    .use(backend)
    .use(initReactI18next)
    .init({
      lng,
      fallbackLng: FALLBACK_LANGUAGE,
      supportedLngs: LANGUAGES.map((l) => l.code),
      ns: options.ns ?? ["common"],
      defaultNS: "common",
      // React escapes already; {{product}}/{{assistant}} are the installation's names (brand.ts)
      interpolation: { escapeValue: false, defaultVariables: brandVariables() },
      // No Suspense boundaries in the shell: a namespace that is still loading
      // renders its defaultValue (or the German fallback) instead of suspending.
      react: { useSuspense: false },
      returnNull: false,
    });
}

/** Apply the "uiLanguage" setting: switch, remember, set <html lang>. */
export function applyUiLanguage(setting: unknown): void {
  const lng = resolveUiLanguage(setting, browserLanguages());
  try {
    localStorage.setItem(STORAGE_KEY, setting === "system" ? "system" : lng);
  } catch {
    /* private window — then the next start follows the browser */
  }
  if (typeof document !== "undefined") document.documentElement.lang = lng;
  if (i18next.isInitialized && i18next.language !== lng) void i18next.changeLanguage(lng);
}

// ── Texts that come from the server-side settings schema ──────────────────
// The schema stays the single source and keeps its German labels; another
// language translates them by key and falls back to the server text.

export function settingsModuleName(moduleId: string, fallback: string): string {
  return i18next.t(`settings:modules.${moduleId}.name`, { defaultValue: fallback });
}

export function settingsCategoryName(categoryId: string, fallback: string): string {
  return i18next.t(`settings:categories.${categoryId}`, { defaultValue: fallback });
}

export function settingText(
  moduleId: string,
  key: string,
  field: "label" | "description",
  fallback: string,
): string {
  if (!fallback && field === "description") return "";
  return i18next.t(`settings:modules.${moduleId}.settings.${key}.${field}`, {
    defaultValue: fallback,
  });
}

// ── Do not disturb (shared by the desktop and the phone quick settings) ────

export function dndRemainingText(policy: NotificationPolicy, now = Date.now()): string {
  const r = dndRemaining(policy, now);
  if (!r) return "";
  const { key, ...vars } = r;
  return i18next.t(`common:dnd.remaining.${key}`, { ...vars, defaultValue: dndRemainingLabel(policy, now) });
}

export function dndPresetLabel(preset: { id: string; label: string }): string {
  return i18next.t(`common:dnd.preset.${preset.id}`, { defaultValue: preset.label });
}

// ── Shell commands (shortcut settings and the command search) ─────────────
// The registry keeps German labels; other languages translate by id.

export function commandLabel(id: string): string {
  return i18next.t(`settings:shortcuts.command.${id}`, { defaultValue: commandById(id)?.label ?? id });
}

export function commandCategory(category: string): string {
  return i18next.t(`settings:shortcuts.category.${category}`, { defaultValue: category });
}
