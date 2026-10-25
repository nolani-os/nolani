/**
 * Catalog loader for the UI translation.
 *
 * Every `locales/<lng>/<ns>.json` becomes its own chunk and is fetched only
 * when the namespace is first used — an app's texts load with the app, a
 * language nobody picked costs nothing.
 */
import { initI18n, initialUiLanguage, resolveUiLanguage, setBrand, type Brand } from "@claraos/core";

const catalogs = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*/*.json");

// The installation's names from its own config, so the first paint already uses
// them (the server's /me can still override them later).
const heimConfig = import.meta.glob<{ BRAND?: Partial<Brand> }>("./heim.config.ts", { eager: true });
setBrand(Object.values(heimConfig)[0]?.BRAND);

/**
 * @param uiLanguage the "uiLanguage" setting if it is already loaded —
 *   otherwise the remembered/browser language applies until it arrives.
 */
export function startI18n(uiLanguage?: unknown): Promise<unknown> {
  const lng =
    uiLanguage === undefined ? initialUiLanguage() : resolveUiLanguage(uiLanguage, navigator.languages);
  return initI18n(
    async (code, ns) => {
      const load = catalogs[`./locales/${code}/${ns}.json`];
      // A namespace that does not exist (yet) in a language is not an error:
      // its keys fall back to the fallback language.
      return load ? (await load()).default : {};
    },
    // Loaded before the first render: everything the shell frame shows.
    // App namespaces load on demand.
    { lng, ns: ["common", "settings", "shell", "mobile", "desktop", "components", "tour", "apps", "settingsTabs", "chat", "chatWork"] },
  );
}
