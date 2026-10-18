/**
 * Unit tests for the accent resolver.
 *
 * The most important test is the WCAG property test: EVERY preset colour must
 * yield readable selection and link colours on EVERY skin background. This is
 * exactly where home-grown accent features usually break — a pretty yellow on
 * a light background is unreadable, yet goes unnoticed in a screenshot.
 *
 * Run:  node --experimental-strip-types packages/skins/test/accent.test.mjs
 * (or via run-tests.mjs, which transpiles the TS file via esbuild)
 */
import assert from "node:assert/strict";

export function runAccentTests(mod) {
  const {
    parseColor, toHex, contrastRatio, relativeLuminance, accentForeground,
    ensureContrast, tint, rgbToOklab, oklabToRgb, accentTokens, ACCENT_PRESETS,
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

  t("parseColor: hex kurz/lang und rgb()", () => {
    assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255 });
    assert.deepEqual(parseColor("#3daee9"), { r: 61, g: 174, b: 233 });
    assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30 });
    assert.equal(parseColor("nope"), null);
  });

  t("Kontrast: bekannte Referenzwerte", () => {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    assert.ok(Math.abs(contrastRatio(white, black) - 21) < 0.01);
    assert.ok(Math.abs(contrastRatio(white, white) - 1) < 0.001);
    assert.ok(relativeLuminance(white) > relativeLuminance(black));
  });

  t("accentForeground wählt die lesbarere Seite", () => {
    // Light yellow → black. Medium violet too, by the way (3.8 against white
    // vs. 5.5 against black) — appearances deceive here, which is why we compute.
    assert.equal(toHex(accentForeground(parseColor("#e8cb2d"))), "#000000");
    assert.equal(toHex(accentForeground(parseColor("#926ee4"))), "#000000");
    // dark grey/blue → white
    assert.equal(toHex(accentForeground(parseColor("#686b6f"))), "#ffffff");
    assert.equal(toHex(accentForeground(parseColor("#1a3a8f"))), "#ffffff");
  });

  t("ensureContrast hebt einen zu schwachen Akzent an", () => {
    const bg = parseColor("#0f1626"); // dark skin background
    const weak = parseColor("#101a2c"); // almost the background
    assert.ok(contrastRatio(weak, bg) < 2, "Vorbedingung: Kontrast ist schlecht");
    const fixed = ensureContrast(weak, bg, 5.0);
    assert.ok(contrastRatio(fixed, bg) >= 5.0, "nach Korrektur ≥ 5.0");
  });

  t("ensureContrast lässt einen guten Akzent unverändert", () => {
    const bg = parseColor("#0f1626");
    const good = parseColor("#7dd3fc");
    assert.deepEqual(ensureContrast(good, bg, 5.0), good);
  });

  t("OKLab-Roundtrip ist verlustarm", () => {
    for (const hex of ["#3daee9", "#e8cb2d", "#101a2c", "#ffffff"]) {
      const c = parseColor(hex);
      const back = oklabToRgb(rgbToOklab(c));
      assert.ok(Math.abs(back.r - c.r) < 1.5, `${hex} r`);
      assert.ok(Math.abs(back.g - c.g) < 1.5, `${hex} g`);
      assert.ok(Math.abs(back.b - c.b) < 1.5, `${hex} b`);
    }
  });

  t("tint erhält die Helligkeit (das ist der Sinn von OKLab)", () => {
    const base = parseColor("#8a8a8a");
    const accent = parseColor("#e93a9a");
    const tinted = tint(base, accent, 0.15);
    const lBefore = rgbToOklab(base).L;
    const lAfter = rgbToOklab(tinted).L;
    assert.ok(Math.abs(lBefore - lAfter) < 0.01, "L bleibt");
    assert.notDeepEqual(tinted, base, "aber die Farbe hat sich bewegt");
  });

  t("tint mit Faktor 0 ist ein No-op", () => {
    const base = parseColor("#8a8a8a");
    assert.deepEqual(tint(base, parseColor("#e93a9a"), 0), base);
  });

  // ── The actual property test ────────────────────────────────────────────
  t("WCAG: alle Presets sind auf allen Skin-Hintergründen lesbar", () => {
    const backgrounds = {
      "clara-glass": "#0f1626",
      "windows11-dark": "#202020",
      "windows11-light": "#f3f3f3",
      "aero-glass": "#1b2436",
      underwater: "#04212b",
    };
    for (const [skin, bg] of Object.entries(backgrounds)) {
      for (const preset of ACCENT_PRESETS) {
        const tk = accentTokens(preset, bg);
        assert.ok(tk, `${skin}/${preset}: Tokens erzeugt`);

        const link = parseColor(tk["link-color"]);
        assert.ok(
          contrastRatio(link, parseColor(bg)) >= 4.5,
          `${skin}/${preset}: Linkfarbe zu kontrastarm (${contrastRatio(link, parseColor(bg)).toFixed(2)})`,
        );

        // selection foreground against the effective selection surface
        const accent = parseColor(preset);
        const effSelection = {
          r: parseColor(bg).r + (accent.r - parseColor(bg).r) * 0.7,
          g: parseColor(bg).g + (accent.g - parseColor(bg).g) * 0.7,
          b: parseColor(bg).b + (accent.b - parseColor(bg).b) * 0.7,
        };
        const selFg = parseColor(tk["selection-fg"]);
        assert.ok(
          contrastRatio(selFg, effSelection) >= 4.5,
          `${skin}/${preset}: Auswahl-Text zu kontrastarm (${contrastRatio(selFg, effSelection).toFixed(2)})`,
        );

        // text on a solid accent surface (e.g. primary button)
        const accFg = parseColor(tk["accent-fg"]);
        assert.ok(
          contrastRatio(accFg, accent) >= 4.5,
          `${skin}/${preset}: Button-Text zu kontrastarm (${contrastRatio(accFg, accent).toFixed(2)})`,
        );
      }
    }
  });

  t("accentTokens: ungültige Eingabe ⇒ null (kein halber Zustand)", () => {
    assert.equal(accentTokens("kein-hex", "#0f1626"), null);
  });

  return results;
}
