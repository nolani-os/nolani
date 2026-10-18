/** Unit tests for the keyboard shortcut registry. */
import assert from "node:assert/strict";

export function runShortcutTests(mod) {
  const {
    COMMANDS, normalizeBinding, bindingFromEvent, effectiveBindings,
    commandForEvent, findConflicts, displayBinding, commandById,
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
  const ev = (key, over = {}) => ({
    key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over,
  });

  t("Registry ist in sich stimmig", () => {
    const ids = new Set();
    for (const c of COMMANDS) {
      assert.ok(c.id && c.label && c.category, `${c.id}: Felder vollständig`);
      assert.ok(!ids.has(c.id), `${c.id}: Id doppelt`);
      ids.add(c.id);
      assert.equal(normalizeBinding(c.defaultBinding), c.defaultBinding,
        `${c.id}: Vorgabe ist bereits Normalform`);
    }
  });

  t("Vorgaben kollidieren nicht miteinander", () => {
    assert.deepEqual(findConflicts(), [], "Auslieferungszustand ist konfliktfrei");
  });

  t("Normalform: Reihenfolge und Schreibweise egal", () => {
    assert.equal(normalizeBinding("meta+e"), "Meta+E");
    assert.equal(normalizeBinding("E+Meta"), "Meta+E");
    assert.equal(normalizeBinding("Win+Shift+s"), "Shift+Meta+S");
    assert.equal(normalizeBinding("ctrl+alt+shift+meta+X"), "Ctrl+Alt+Shift+Meta+X");
    assert.equal(normalizeBinding("Ctrl"), "", "nur Modifier ist keine Kombination");
    assert.equal(normalizeBinding(""), "");
  });

  t("Ereignis → Kombination", () => {
    assert.equal(bindingFromEvent(ev("e", { metaKey: true })), "Meta+E");
    assert.equal(bindingFromEvent(ev("S", { metaKey: true, shiftKey: true })), "Shift+Meta+S");
    assert.equal(bindingFromEvent(ev("ArrowLeft", { metaKey: true })), "Meta+ArrowLeft");
    assert.equal(bindingFromEvent(ev("Meta", { metaKey: true })), "",
      "reiner Modifier-Druck ist noch nichts");
  });

  t("Kommando wird erkannt", () => {
    assert.equal(commandForEvent(ev("e", { metaKey: true })), "open-files");
    assert.equal(commandForEvent(ev("i", { metaKey: true })), "open-settings");
    assert.equal(commandForEvent(ev("x", { metaKey: true })), null);
    assert.equal(commandForEvent(ev("e")), null, "ohne Modifier kein Treffer");
  });

  t("Nutzer-Belegung schlägt die Vorgabe", () => {
    const over = { "open-files": "Ctrl+Alt+F" };
    assert.equal(commandForEvent(ev("f", { ctrlKey: true, altKey: true }), over), "open-files");
    assert.equal(commandForEvent(ev("e", { metaKey: true }), over), null,
      "die alte Kombination ist frei");
  });

  t("Konflikte werden gefunden", () => {
    const over = { "open-settings": "Meta+E" }; // collides with open-files
    const conflicts = findConflicts(over);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].binding, "Meta+E");
    assert.deepEqual(conflicts[0].commandIds.sort(), ["open-files", "open-settings"]);
  });

  t("leere Belegung entfernt das Kürzel, ohne zu kollidieren", () => {
    const over = { "open-files": "", "open-settings": "" };
    const map = effectiveBindings(over);
    assert.equal(map["open-files"], "");
    assert.deepEqual(findConflicts(over), [], "zwei leere Kürzel sind kein Konflikt");
    assert.equal(commandForEvent(ev("e", { metaKey: true }), over), null);
  });

  t("Anzeigeform ist lesbar", () => {
    assert.equal(displayBinding("Meta+E"), "Win + E");
    assert.equal(displayBinding("Meta+ArrowLeft"), "Win + ←");
    assert.equal(displayBinding("Ctrl+Shift+Escape"), "Ctrl + Shift + Esc");
    assert.equal(displayBinding(""), "—");
  });

  t("commandById findet die Beschriftung", () => {
    assert.equal(commandById("open-files").label, "Dateien öffnen");
    assert.equal(commandById("gibts-nicht"), undefined);
  });

  return results;
}
