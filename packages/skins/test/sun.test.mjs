/**
 * Unit tests for the sun model, checked against published values
 * (timeanddate.com / NOAA) for Berlin (52.520° N, 13.405° E, CET/CEST).
 */
import assert from "node:assert/strict";

export function runSunTests(mod) {
  const { sunPosition, sunTimes, moonPhase, dayPhase, sunState } = mod;
  const LAT = 52.52, LON = 13.405;
  const results = [];
  const t = (name, fn) => {
    try {
      fn();
      results.push(["ok", name]);
    } catch (e) {
      results.push(["fail", `${name} — ${e.message}`]);
    }
  };
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
  const hhmm = (d) => d.toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });

  t("Sommersonnenwende (Berlin): Mittagshöhe ≈ 60.9°", () => {
    // Solar noon in Berlin on 21 June is about 13:07 CEST = 11:07 UTC
    const p = sunPosition(new Date(Date.UTC(2026, 5, 21, 11, 7)), LAT, LON);
    near(p.altitude, 60.9, 0.5, "altitude");
    near(p.azimuth, 180, 3, "azimuth");
  });

  t("Wintersonnenwende (Berlin): Mittagshöhe ≈ 14.0°", () => {
    const p = sunPosition(new Date(Date.UTC(2026, 11, 21, 11, 10)), LAT, LON);
    near(p.altitude, 14.0, 0.5, "altitude");
  });

  t("Mitternacht ist Nacht, Sonne weit unter dem Horizont", () => {
    const p = sunPosition(new Date(Date.UTC(2026, 11, 21, 0, 0)), LAT, LON);
    assert.ok(p.altitude < -40, `altitude ${p.altitude}`);
    assert.equal(dayPhase(p.altitude, p.azimuth), "night");
  });

  t("Morgens steht die Sonne im Osten, abends im Westen", () => {
    const m = sunPosition(new Date(Date.UTC(2026, 5, 21, 6, 0)), LAT, LON); // 08:00 CEST
    const a = sunPosition(new Date(Date.UTC(2026, 5, 21, 16, 0)), LAT, LON); // 18:00 CEST
    assert.ok(m.azimuth > 60 && m.azimuth < 120, `morning azimuth ${m.azimuth}`);
    assert.ok(a.azimuth > 240 && a.azimuth < 300, `evening azimuth ${a.azimuth}`);
  });

  t("Auf-/Untergang 21.06. (Berlin) ≈ 04:43 / 21:33 MESZ", () => {
    const { rise, set } = sunTimes(new Date(2026, 5, 21, 12), LAT, LON);
    assert.ok(rise && set, "times");
    const toMin = (d) => { const [h, m] = hhmm(d).split(":").map(Number); return h * 60 + m; };
    near(toMin(rise), 4 * 60 + 43, 4, "sunrise");
    near(toMin(set), 21 * 60 + 33, 4, "sunset");
  });

  t("Auf-/Untergang 21.12. (Berlin) ≈ 08:15 / 15:54 MEZ", () => {
    const { rise, set } = sunTimes(new Date(2026, 11, 21, 12), LAT, LON);
    const toMin = (d) => { const [h, m] = hhmm(d).split(":").map(Number); return h * 60 + m; };
    near(toMin(rise), 8 * 60 + 15, 4, "sunrise");
    near(toMin(set), 15 * 60 + 54, 4, "sunset");
  });

  t("Polartag: kein Untergang in Tromsø im Juni", () => {
    const { rise, set } = sunTimes(new Date(2026, 5, 21, 12), 69.65, 18.96);
    assert.equal(rise, null);
    assert.equal(set, null);
  });

  t("Dämmerung: -3° morgens = dawn, abends = dusk", () => {
    assert.equal(dayPhase(-3, 90), "dawn");
    assert.equal(dayPhase(-3, 270), "dusk");
    assert.equal(dayPhase(5, 100), "day");
    assert.equal(dayPhase(-10, 100), "night");
  });

  t("Mondphase: Vollmond 2026-03-03 ≈ 0.5, Neumond 2026-03-19 ≈ 0", () => {
    near(moonPhase(new Date(Date.UTC(2026, 2, 3, 12))), 0.5, 0.03, "full moon");
    const nm = moonPhase(new Date(Date.UTC(2026, 2, 19, 2)));
    assert.ok(nm < 0.03 || nm > 0.97, `new moon ${nm}`);
  });

  t("sunState liefert alle Felder", () => {
    const s = sunState(new Date(Date.UTC(2026, 5, 21, 11, 15)), LAT, LON);
    assert.equal(s.phase, "day");
    assert.ok(s.sunrise instanceof Date && s.sunset instanceof Date);
    assert.ok(s.moonPhase >= 0 && s.moonPhase < 1);
  });

  return results;
}
