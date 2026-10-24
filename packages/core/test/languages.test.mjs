/** Unit tests for resolving the UI language. */
import assert from "node:assert/strict";

export function runLanguageTests(mod) {
  const { resolveUiLanguage, languageName, LANGUAGES, FALLBACK_LANGUAGE } = mod;

  const results = [];
  const t = (name, fn) => {
    try {
      fn();
      results.push(["ok", name]);
    } catch (e) {
      results.push(["fail", `${name} — ${e.message}`]);
    }
  };

  t("feste Wahl schlägt den Browser", () => {
    assert.equal(resolveUiLanguage("de", ["en-US"]), "de");
    assert.equal(resolveUiLanguage("en", ["de-DE"]), "en");
  });
  t("system folgt der ersten unterstützten Browsersprache", () => {
    assert.equal(resolveUiLanguage("system", ["fr-FR", "en-GB", "de"]), "en");
    assert.equal(resolveUiLanguage("system", ["EN-us"]), "en");
  });
  t("unbekannte Sprache fällt auf die Rückfallsprache", () => {
    assert.equal(resolveUiLanguage("system", ["fr-FR"]), FALLBACK_LANGUAGE);
    assert.equal(resolveUiLanguage("xx", []), FALLBACK_LANGUAGE);
    assert.equal(resolveUiLanguage(undefined), FALLBACK_LANGUAGE);
  });
  t("Sprachnamen stehen in der eigenen Sprache", () => {
    assert.equal(languageName("en"), "English");
    assert.equal(languageName("zz"), "zz");
  });
  t("Rückfallsprache steht in der Liste", () => {
    assert.ok(LANGUAGES.some((l) => l.code === FALLBACK_LANGUAGE));
  });

  return results;
}
