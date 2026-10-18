/**
 * Unit tests for the terminal paste protection.
 *
 * These tests are the security gate: they describe exactly the attacks an
 * unfiltered web terminal swallows — hidden line breaks in copied text and a
 * breakout from the bracketed-paste bracket.
 */
import assert from "node:assert/strict";

export function runPasteGuardTests(mod) {
  const { analyzePaste, pasteWarningSummary, HUGE_PASTE_THRESHOLD } = mod;
  const results = [];
  const t = (name, fn) => {
    try {
      fn();
      results.push(["ok", name]);
    } catch (e) {
      results.push(["fail", `${name} — ${e.message}`]);
    }
  };

  t("harmloser Text geht unverändert durch", () => {
    const a = analyzePaste("ls -la /tmp");
    assert.equal(a.safe, true);
    assert.equal(a.sanitized, "ls -la /tmp");
    assert.equal(a.findings.length, 0);
    assert.equal(a.multiline, false);
  });

  t("Zeilenenden werden auf \\r normalisiert", () => {
    assert.equal(analyzePaste("a\r\nb\nc").raw, "a\rb\rc");
    assert.equal(analyzePaste("a\nb").multiline, true);
  });

  t("Zeilenumbruch allein ist kein Steuerzeichen-Fund, aber mehrzeilig", () => {
    const a = analyzePaste("echo eins\necho zwei");
    assert.equal(a.findings.length, 0);
    assert.equal(a.multiline, true);
    // safe stays true — Konsole deliberately does NOT warn on multi-line in
    // general; the UI decides whether to ask anyway for multiline.
    assert.equal(a.safe, true);
  });

  // ── The actual attack ──────────────────────────────────────────────────
  t("versteckter Interrupt/Escape wird gefunden und benannt", () => {
    const a = analyzePaste("harmlos\x03\x1b[2Jrm -rf /");
    assert.equal(a.safe, false);
    const codes = a.findings.map((f) => f.code);
    assert.ok(codes.includes(0x03), "Ctrl+C gefunden");
    assert.ok(codes.includes(0x1b), "ESC gefunden");
    assert.ok(!a.sanitized.includes("\x03"));
    assert.ok(!a.sanitized.includes("\x1b"));
    const esc = a.findings.find((f) => f.code === 0x1b);
    assert.equal(esc.unicode, "U+001B");
    assert.equal(esc.caret, "^[");
    assert.ok(esc.meaning.length > 0);
  });

  t("Ausbruch aus Bracketed Paste wird verhindert", () => {
    // The classic: the pasted text itself contains the end marker.
    const attack = "harmlos\x1b[201~rm -rf ~\r";
    const a = analyzePaste(attack, true);
    assert.ok(!a.raw.includes("\x1b"), "auch der Roh-Pfad ist ESC-frei");
    assert.ok(!a.sanitized.includes("\x1b"), "der bereinigte Pfad sowieso");
    // Without bracketed paste the raw text stays untouched (nothing is
    // bracketed there, so ESC is not a breakout risk)
    assert.ok(analyzePaste(attack, false).raw.includes("\x1b"));
  });

  t("C1-Steuerzeichen (0x80–0x9F) gelten ebenfalls als unsicher", () => {
    const a = analyzePaste("xAB"); // CSI as a single character
    assert.equal(a.safe, false);
    assert.ok(a.findings.some((f) => f.code === 0x9b));
  });

  t("Tab bleibt erlaubt", () => {
    const a = analyzePaste("spalte1\tspalte2");
    assert.equal(a.safe, true);
    assert.ok(a.sanitized.includes("\t"));
  });

  t("Funde werden pro Code nur einmal gemeldet", () => {
    const a = analyzePaste("\x03\x03\x03");
    assert.equal(a.findings.length, 1);
  });

  t("große Einfügung wird gemeldet", () => {
    const a = analyzePaste("x".repeat(HUGE_PASTE_THRESHOLD + 1));
    assert.equal(a.huge, true);
    assert.equal(a.safe, false);
    assert.equal(analyzePaste("x".repeat(10)).huge, false);
  });

  t("Zusammenfassung nennt Ross und Reiter", () => {
    const s = pasteWarningSummary(analyzePaste("a\x03b"));
    assert.ok(s.includes("^C"), "Caret-Notation");
    assert.ok(s.length > 5);
  });

  t("leerer Text ist unkritisch", () => {
    const a = analyzePaste("");
    assert.equal(a.safe, true);
    assert.equal(a.sanitized, "");
  });

  return results;
}
