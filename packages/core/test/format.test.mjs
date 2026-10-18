/** Unit tests for the region formats. */
import assert from "node:assert/strict";

export function runFormatTests(mod) {
  const {
    formatNumber, formatCurrency, formatDate, formatTime, formatBytes,
    firstDayOfWeek, formatRelative, DEFAULT_FORMAT_PREFS,
  } = mod;

  const results = [];
  const t = (name, fn) => {
    try {
      fn();
      results.push(["ok", name]);
    } catch (e) {
      results.push(["fail", `${name} — ${e.message}`]);
    }
  };
  const P = (over = {}) => ({ ...DEFAULT_FORMAT_PREFS, ...over });

  t("Zahlen folgen der Region", () => {
    assert.equal(formatNumber(1234.5, P(), 2), "1.234,50");
    assert.equal(formatNumber(1234.5, P({ locale: "en-US" }), 2), "1,234.50");
    assert.equal(formatNumber(1234.5, P({ locale: "fr-FR" }), 2).replace(/ | /g, " "),
      "1 234,50");
  });

  t("Währung nutzt Region UND gewählte Währung", () => {
    assert.ok(formatCurrency(9.9, P()).includes("€"));
    assert.ok(formatCurrency(9.9, P({ currency: "CHF" })).includes("CHF"));
    // The region determines the position of the symbol
    assert.ok(formatCurrency(9.9, P({ locale: "en-US", currency: "USD" })).startsWith("$"));
  });

  t("Datum folgt der Region", () => {
    const d = new Date(Date.UTC(2026, 6, 25, 12, 0, 0));
    assert.match(formatDate(d, P(), "short"), /25\.0?7\.(20)?26/);
    assert.match(formatDate(d, P({ locale: "en-US" }), "short"), /7\/25\/(20)?26/);
  });

  t("Uhrzeit: 12h/24h erzwingbar, sonst Region", () => {
    const d = new Date(2026, 6, 25, 15, 30);
    assert.match(formatTime(d, P({ timeFormat: "24h" })), /15:30/);
    const twelve = formatTime(d, P({ timeFormat: "12h" }));
    assert.match(twelve, /03:30|3:30/);
    assert.match(twelve.toLowerCase(), /pm|nachm/);
    assert.match(formatTime(d, P()), /15:30/); // de-DE is 24h
  });

  t("Dateigrößen: IEC vs. metrisch vs. JEDEC", () => {
    assert.equal(formatBytes(1024, P({ binaryDialect: "iec" })), "1 KiB");
    assert.equal(formatBytes(1000, P({ binaryDialect: "metric" })), "1 kB");
    assert.equal(formatBytes(1024, P({ binaryDialect: "jedec" })), "1 KB");
    assert.equal(formatBytes(0, P()), "0 B");
    assert.equal(formatBytes(999, P({ binaryDialect: "metric" })), "999 B");
    assert.ok(formatBytes(1536, P()).startsWith("1,5"), "1536 B = 1,5 KiB in de-DE");
    assert.ok(formatBytes(-2048, P()).startsWith("-"), "negative Größen behalten das Vorzeichen");
  });

  t("Wochenbeginn: erzwungen schlägt Region", () => {
    assert.equal(firstDayOfWeek(P({ firstDayOfWeek: "monday" })), 1);
    assert.equal(firstDayOfWeek(P({ firstDayOfWeek: "sunday" })), 0);
    const auto = firstDayOfWeek(P({ locale: "en-US" }));
    assert.ok(auto === 0 || auto === 1, "Region liefert einen gültigen Tag");
  });

  t("relative Zeit bleibt in der Region", () => {
    const now = new Date(2026, 6, 25, 12, 0, 0);
    const s = formatRelative(new Date(2026, 6, 25, 11, 58, 0), P(), now);
    assert.match(s, /Minute/i);
    // Far in the past => date instead of relative time
    const old = formatRelative(new Date(2026, 0, 1), P(), now);
    assert.match(old, /2026/);
  });

  return results;
}
