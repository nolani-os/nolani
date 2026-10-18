/** Unit tests for the notification rules. */
import assert from "node:assert/strict";

export function runPolicyTests(mod) {
  const {
    decide, isDndActive, ruleFor, dndUntilFor, dndRemainingLabel,
    DEFAULT_POLICY, DEFAULT_APP_RULE,
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

  const NOW = 1_800_000_000_000;
  const P = (over = {}) => ({ ...DEFAULT_POLICY, ...over });

  t("ohne DND geht alles durch", () => {
    const d = decide({}, P(), NOW);
    assert.equal(d.popup, true);
    assert.equal(d.history, true);
    assert.equal(d.badge, true);
  });

  t("DND ist ein Zeitstempel, kein Schalter", () => {
    assert.equal(isDndActive(P({ dndUntil: NOW + 1000 }), NOW), true);
    assert.equal(isDndActive(P({ dndUntil: NOW - 1000 }), NOW), false);
    // The key point: an expired timestamp switches itself off
    const d = decide({}, P({ dndUntil: NOW - 1 }), NOW);
    assert.equal(d.popup, true);
  });

  t("DND unterdrückt Popups, nicht die Chronik", () => {
    const d = decide({}, P({ dndUntil: NOW + 60000 }), NOW);
    assert.equal(d.popup, false);
    assert.equal(d.history, true, "in der Chronik steht es trotzdem");
    assert.match(d.reason, /Nicht stören/);
  });

  t("kritische Meldungen durchbrechen DND", () => {
    const p = P({ dndUntil: NOW + 60000 });
    assert.equal(decide({ urgency: "critical" }, p, NOW).popup, true);
    // ...unless that is turned off
    assert.equal(
      decide({ urgency: "critical" }, { ...p, criticalInDnd: false }, NOW).popup,
      false,
    );
  });

  t("App darf ausnahmsweise trotz DND", () => {
    const p = P({
      dndUntil: NOW + 60000,
      apps: { "clara-chat": { showPopupsInDnd: true } },
    });
    assert.equal(decide({ source: "clara-chat" }, p, NOW).popup, true);
    assert.equal(decide({ source: "andere-app" }, p, NOW).popup, false);
  });

  t("niedrige Dringlichkeit: Popup und Chronik getrennt steuerbar", () => {
    const noPopup = decide({ urgency: "low" }, P({ lowPriorityPopups: false }), NOW);
    assert.equal(noPopup.popup, false);
    assert.equal(noPopup.history, false, "Standard: low nicht in der Chronik");

    const withHistory = decide(
      { urgency: "low" },
      P({ lowPriorityPopups: false, lowPriorityHistory: true }),
      NOW,
    );
    assert.equal(withHistory.popup, false);
    assert.equal(withHistory.history, true);
  });

  t("Pro-App-Regel schaltet Popups ab, Chronik bleibt", () => {
    const p = P({ apps: { laut: { showPopups: false } } });
    const d = decide({ source: "laut" }, p, NOW);
    assert.equal(d.popup, false);
    assert.equal(d.history, true);
  });

  t("Zähler folgen der Chronik, nicht dem Popup", () => {
    const p = P({ apps: { still: { showPopups: false, showBadges: true } } });
    assert.equal(decide({ source: "still" }, p, NOW).badge, true);
    const p2 = P({ apps: { unsichtbar: { showInHistory: false } } });
    assert.equal(decide({ source: "unsichtbar" }, p2, NOW).badge, false,
      "was nicht in der Chronik steht, wird auch nicht gezählt");
  });

  t("ruleFor mischt App-Regel über den Standard", () => {
    assert.deepEqual(ruleFor(P(), "unbekannt"), DEFAULT_APP_RULE);
    const r = ruleFor(P({ apps: { x: { showBadges: false } } }), "x");
    assert.equal(r.showBadges, false);
    assert.equal(r.showPopups, true, "nicht gesetzte Felder bleiben Standard");
  });

  t("Schnellwahl rechnet Zeitpunkte korrekt", () => {
    assert.equal(dndUntilFor(30, NOW), NOW + 30 * 60000);
    assert.ok(dndUntilFor(0, NOW) > NOW + 300 * 24 * 3600_000, "'unbegrenzt' ist sehr lang");
    const morgen = new Date(dndUntilFor(-1, NOW));
    assert.equal(morgen.getHours(), 7);
    assert.ok(dndUntilFor(-1, NOW) > NOW);
  });

  t("Restlaufzeit wird lesbar beschriftet", () => {
    assert.equal(dndRemainingLabel(P({ dndUntil: NOW + 25 * 60000 }), NOW), "noch 25 Min.");
    assert.match(dndRemainingLabel(P({ dndUntil: NOW + 90 * 60000 }), NOW), /1 Std\. 30 Min\./);
    assert.equal(dndRemainingLabel(P(), NOW), "", "ohne DND kein Text");
    assert.equal(dndRemainingLabel(P({ dndUntil: dndUntilFor(0, NOW) }), NOW), "unbegrenzt");
  });

  return results;
}
