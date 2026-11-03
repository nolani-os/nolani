/**
 * Tests for the corporate skin template — the contrast is measured, not
 * assumed. Runs on the bundled `corporate/createCorporateSkin.ts`
 * (see run-tests.mjs); expects `corporateColors`, `corporateContrast`,
 * `createCorporateSkin`.
 */

function check(name, cond, results) {
  results.push([cond ? "ok" : "fail", name]);
}

export function runCorporateTests(mod) {
  const { corporateColors, corporateContrast, createCorporateSkin } = mod;
  const results = [];

  // --- The shipped tenant: clinic blue + teal on white -------------------
  const medical = corporateColors("#0b4f8a", "#0fa3a3");
  const m = corporateContrast(medical);
  check(`Medical: text on window ≥ 7 (AAA) — ${m.textOnWindow.toFixed(2)}`, m.textOnWindow >= 7, results);
  check(`Medical: secondary text on window ≥ 4.5 — ${m.secondaryOnWindow.toFixed(2)}`, m.secondaryOnWindow >= 4.5, results);
  check(`Medical: link on window ≥ 4.5 — ${m.linkOnWindow.toFixed(2)}`, m.linkOnWindow >= 4.5, results);
  check(`Medical: foreground on accent ≥ 4.5 — ${m.fgOnAccent.toFixed(2)}`, m.fgOnAccent >= 4.5, results);
  check(`Medical: text on hover plate ≥ 7 — ${m.textOnHover.toFixed(2)}`, m.textOnHover >= 7, results);
  check("Medical: accent is the primary unchanged", medical["accent"] === "#0b4f8a", results);
  check("Medical: secondary accent is the teal", medical["accent-secondary"] === "#0fa3a3", results);
  check("Medical: brand rule runs primary → accent", medical["brand-rule"] === "linear-gradient(90deg, #0b4f8a, #0fa3a3)", results);
  check("Medical: surfaces are opaque white (no glass)", medical["bg-window"] === "#ffffff" && medical["bg-surface"] === "#ffffff", results);

  // --- A hostile tenant: yellow primary, lime accent --------------------
  // The accent itself may stay yellow (it is the brand), but every TEXT role
  // the template derives must still read on white.
  const yellow = corporateColors("#ffd500", "#9be300");
  const y = corporateContrast(yellow);
  check(`Yellow: text on window ≥ 7 — ${y.textOnWindow.toFixed(2)}`, y.textOnWindow >= 7, results);
  check(`Yellow: secondary text on window ≥ 4.5 — ${y.secondaryOnWindow.toFixed(2)}`, y.secondaryOnWindow >= 4.5, results);
  check(`Yellow: link on window ≥ 4.5 (corrected towards black) — ${y.linkOnWindow.toFixed(2)}`, y.linkOnWindow >= 4.5, results);
  check(`Yellow: foreground on accent ≥ 4.5 (black on yellow) — ${y.fgOnAccent.toFixed(2)}`, y.fgOnAccent >= 4.5 && yellow["accent-fg"] === "#000000", results);
  check(`Yellow: foreground on brand accent ≥ 4.5 — ${y.fgOnBrandAccent.toFixed(2)}`, y.fgOnBrandAccent >= 4.5, results);

  // --- Invalid input falls back instead of throwing -----------------------
  const bad = corporateColors("not a colour", "");
  check("Invalid colours: fallback palette, still readable", corporateContrast(bad).textOnWindow >= 7, results);

  // --- Manifest shape ----------------------------------------------------
  const skin = createCorporateSkin({
    id: "corporate-test",
    companyName: "Test GmbH",
    logo: "/logo.svg",
    primary: "#0b4f8a",
    accent: "#0fa3a3",
    tagline: "Workspace",
  });
  check("Manifest: chrome corporate, light, brand set", skin.chrome === "corporate" && skin.colorScheme === "light" && skin.brand?.name === "Test GmbH" && skin.brand?.logo === "/logo.svg" && skin.brand?.tagline === "Workspace", results);
  check("Manifest: name is the company name", skin.name === "Test GmbH", results);
  check("Manifest: without wallpaper the preview is a gradient", typeof skin.preview === "string" && skin.preview.startsWith("linear-gradient") && skin.wallpapers.length === 0, results);
  const withWp = createCorporateSkin({ id: "x", companyName: "X", logo: "/l.svg", primary: "#000", accent: "#fff", wallpaper: "/wp.jpg" });
  check("Manifest: wallpaper lands in tokens, preview and wallpapers", withWp.tokens.colors["wallpaper"].includes("/wp.jpg") && withWp.preview.includes("/wp.jpg") && withWp.defaultWallpaper === "/wp.jpg", results);

  return results;
}
