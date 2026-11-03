# @claraos/skins

The look of the desktop: skin manifests (tokens, layout, wallpapers), the
engine that applies them, the accent resolver, the sun model for the animated
scenes, and the icon sets.

## Catalog

| Id | Name | Chrome | Layout |
|---|---|---|---|
| `clara-glass` | Glass | `glass` | bar at the bottom, the product's own design language (default) |
| `bloom-dark`, `bloom-light` | Bloom, Bloom Light | `mica` | bar at the bottom with the app strip centred, Mica surfaces, 8 px corners |
| `orchard-dark`, `orchard-light` | Orchard, Orchard Light | `liquid` | menu bar on top, floating dock below with magnification, traffic lights on the left |
| `corporate-medical` | The Medical Company | `corporate` | bar at the bottom, opaque white, logo and company name in the start button |
| `meadow`, `shore` | Meadow, Shore | `glass` | living photo: a looping video with a WebGL sky that follows the real sun |

`availableSkins` lists them in this order; `resolveSkin(id)` also accepts the
ids of removed skins (`legacySkinIds`, e.g. `windows11-light` → `bloom-light`)
and the installation's own skins from the optional `src/heim/` folder.

## How a skin is applied

`applySkin(skin)` (`engine.ts`) writes every token as a CSS variable on
`:root` (`--bg-window`, `--accent`, `--taskbar-height` …), sets
`color-scheme`, loads the skin's stylesheet through
`<link id="claraos-skin-styles">` and puts the layout on the root dataset:

| Attribute | From | Used by |
|---|---|---|
| `data-skin-id` | `skin.id` | skin-specific rules |
| `data-chrome` | `skin.chrome` | the stylesheet shared by a family of skins |
| `data-menu-bar="1"` | `layout.menuBar` | popovers anchor below the menu bar |
| `data-taskbar-position`, `data-window-buttons`, `data-start-menu-style` | `layout` | shell layout |

The shell reads the layout through `useSkinLayout()` and the corporate
branding through `useSkinBrand()`; `layout.menuBar` makes the shell render
`MenuBar` + `Dock` instead of the `Taskbar`, `layout.searchField` adds the
wide search pill next to the start button (Bloom), and `layout.overviewStyle`
shapes the workspace overview (Win+Tab, the workspaces button): `taskview`
(windows above, desktop strip at the bottom — Bloom), `mission` (spaces bar
on top, labels on hover — Orchard) or `overview` (search field and desktop
bar on top, captions and close buttons — the default). The overview zooms
the real windows (`shell/src/Overview/`); a stylesheet reaches it through
`data-shell-part="overview"`, `overview-desktops`, `overview-search`.

The shell keeps the wallpaper inside the desktop area between the bars. A
skin whose bars should float over it (a translucent bar that blurs the
wallpaper, a dock with the picture reaching the bottom edge) fixes it:
`[data-shell-part="wallpaper"] { position: fixed; }` — Glass, Bloom and
Orchard do.

## Writing a stylesheet

Production class names are hashed CSS modules, so a stylesheet never matches
on class names. It scopes every rule to its chrome and anchors on the stable
hooks the shell provides:

- `data-shell-part`: `taskbar`, `taskbar-tray`, `taskbar-search`,
  `start-button`, `menu-bar`, `menu-bar-app`, `menu-bar-tray`, `dock-area`,
  `dock`, `start-menu`, `start-input`, `start-footer`, `snap-popup`,
  `context-menu`, `toolbar-menu`, `wallpaper`.
- stable class fragments where no hook exists: `[class*="iconLabel"]`,
  `[class*="dotActive"]`, `[class*="pinnedBtn"]`, `[class*="appBtn"]`.

```css
[data-chrome="mica"] [data-shell-part="taskbar"] { justify-content: center; }
[data-chrome="liquid"][data-skin-id="orchard-light"] [data-shell-part="menu-bar"] { color: #1d1d1f; }
```

Never invent a token: a skin sets the tokens the shell already reads
(`packages/core/src/types.ts`, `SkinManifest`). A new role is added to the
type first.

## Corporate template

A company gets a skin from two colours, a name and a logo:

```ts
import { createCorporateSkin } from "@claraos/skins";
import logo from "./logo.svg?url";
import wallpaper from "./wallpaper.jpg";
import stylesheet from "@claraos/skins/src/corporate/stylesheet.css?url";

export const acmeSkin = createCorporateSkin({
  id: "corporate-acme",
  companyName: "ACME",
  tagline: "Workspace",
  logo,
  primary: "#0b4f8a",   // accent, links, focus, selection
  accent: "#0fa3a3",    // running indicator, switches, the brand rule's end
  wallpaper,
  stylesheet,
});
```

Every token is derived from the two colours with the accent resolver
(`accent.ts`: OKLab tint, `ensureContrast`, `accentForeground`), and the
contrast is measured, not assumed: primary text reaches 7:1 on the white
window, secondary text, links and the foreground on the accent surface
4.5:1 — also for a yellow primary (`test/corporate.test.mjs`). The shipped
tenant is `corporate-medical`; register a new one in `src/index.ts`
(`availableSkins`) and add its label to the settings (`AboutTab`,
`locales/*/settings.json` → `personalization.skinHint`).

## Accent resolver

`accentTokens(accent, background)` follows KDE's `colorsapplicator`: the
accent replaces the active/link/focus roles, links are corrected to a 5:1
contrast against the window, the foreground on an accent surface is black or
white, and tinting happens in OKLab so a light theme never tips into dark.

## Sun model

`sun.ts` (`sunPosition`, `sunTimes`, `sunState`, `moonPhase`, `dayPhase`)
implements the NOAA solar equations for the living-photo scenes; the tests
check a central-European reference point on the solstices, the polar day and
known moon phases.

## Tests

```bash
node packages/skins/test/run-tests.mjs      # accent, sun, corporate (no build needed)
node packages/shell/test/dock.smoke.mjs     # dock magnification curve
```

The bars of the two-bar skins and the corporate start button are checked
visually in `packages/shell/test/skin-bars/` (Vite + Playwright, no login):

```bash
cd packages/shell
npx vite build --config test/skin-bars/vite.config.mjs
npx vite preview --config test/skin-bars/vite.config.mjs --port 8798
# http://127.0.0.1:8798/?skin=orchard-dark   ?skin=corporate-medical   ?focus=terminal
```

## Assets and licences

Wallpapers are the project's own renders; the Medical logo is an own design.
Fonts are referenced as stacks with free stand-ins (Selawik, Inter, Manrope —
all OFL), none are bundled. No vendor logos, fonts or wallpapers are copied.
