# Changelog

All notable changes to this project are documented here. The project is in early preview and
does not follow semantic versioning yet.

## Unreleased

- **README with the new looks**: screenshots and short videos recorded in the real shell —
  Nolani at work in Meadow, the look changed in the quick settings, one desktop per look and
  the five business apps opened from the start menu with demo data
  (`deploy/cell/browser_schaufenster.py`, `seed_business.sh`, `schaufenster_schnitt.sh`).
- **InvenTree shows names once**: accounts with only a display name became
  "Alex Morgan Morgan" (Authentik sends the whole name as given name, django-allauth filled
  the empty family name from it again). InvenTree now gets the cell's own profile mapping,
  which splits the name once.
- **TLS verification on by default** for the API's outgoing calls: the 69 `verify=False`
  call sites now take one switch (`CLARAOS_TLS_VERIFY`, default on; `CLARAOS_TLS_CA` for an
  internal CA bundle). The mail connection follows it unless `MAIL_TLS_VERIFY` says otherwise
  — a cell sets it to `false` explicitly, because its Stalwart serves an internal certificate.
- **Optional business apps per cell** (`setup.sh --apps …`): **Odoo** (ERP/CRM, with Nolani's
  tools for contacts and business records as the signed-in user), **InvenTree** (parts, stock,
  orders), **Apache Superset** (dashboards), **Mautic** (marketing automation, SAML login,
  newsletters to outside addresses through the cell's own mail) and **OrangeHRM** (employees,
  leave). Each runs as its own tile with single sign-on through the cell's Authentik, is
  provisioned on first login, has a test run (`run_tests.sh <app>`) and a clean account
  removal. The core (shell, files, mail, planner, passwords, assistant) now idles at about
  4 GB, so an 8 GB server fits the core plus one or two apps; `setup.sh` also completes the
  mail server's bootstrap on a fresh cell and no longer dies silently on cells without Mautic.
- **Companion apps** (`packages/desktop`, `packages/android`): a generic build that connects
  to any Nolani server by address (no built-in server), push notifications through the
  cell's ntfy, device control off by default, the tunnel proxy serves only the own app and
  user, the native bridge is bound to the paired shell. CI builds the Windows installer, the
  Linux AppImage and the Android APK; a `companion-v*` tag drafts a release.
- **Workspace overview** (the workspaces button, Win+Tab): the real windows zoom out into an
  exposé layout, desktops appear as wallpaper miniatures, a window can be dragged onto
  another desktop or onto "+"; the shape follows the skin (Bloom: windows above, desktops
  below; Orchard: spaces bar on top; the others: a search field that filters by title).
  Popovers open where each desktop family expects them (Bloom: start menu and chat centred
  above the bar; Orchard: everything drops from the menu bar). Bloom shows a search field
  next to the start button and its wallpaper reaches both screen edges, as does Orchard's.
- **Five new looks** (`packages/skins`): **Bloom** (centred bar, Mica surfaces, light and
  dark), **Orchard** (menu bar on top, floating dock with magnification, traffic lights on
  the left, light and dark), **The Medical Company** (a corporate template:
  `createCorporateSkin({ companyName, logo, primary, accent })` derives every token from
  two colours and measures the contrast; the start button shows the company's logo and
  name), and the living photos **Meadow** and **Shore** (a looping video under a WebGL sky
  that follows the real sun, moon phase included; the location comes from the weather
  setting). Theme cards in the settings are generated from the catalog. Classic Light and
  Crystal are gone; saved ids map to Bloom and Glass. The taskbar is split into shared
  pieces (`useTaskbarApps`, `TrayCluster`) that the taskbar, the menu bar and the dock use.
- **Nolani Knowledge as a standalone app** (`packages/app-knowledge`, release tag
  `knowledge-v0.1.1`; the `knowledge-v0.1.0` tag never produced a release because its Android
  build failed in CI): the knowledge views on a device-local SQLite database for Linux,
  Windows and Android, with collections, views, filters, formulas, relations, history,
  attachments and ZIP import/export, plus an optional loopback API on the desktop.
  Differential tests check the local layer against the server's own code.
- Knowledge: the strategy tools live in their own router; filters on a fixed date no longer
  fail; formula results that cannot be sent no longer fail the whole table, `if(` inside text
  stays text and `1 == 1.0` is true. Phone fixes for the template sheet, the formatting bar
  and checkbox fields.
- File downloads answer `HEAD` with the same headers as `GET`, without streaming
  the file body (#14, thanks @snehaapratap).

## 0.1.0 (2026-10-25): first public preview

- **Interface in English and German**, switchable without reloading; dates and numbers follow
  the region setting. Shell frame, chat, files, planner, mail, contacts, Teams, knowledge,
  viewers, camera and settings are translated.
- **Nolani replies in the interface language**, including its follow-up suggestions, the
  "done" summary under an answer and the dates it names. It opens apps when asked, from every
  chat surface. Sub-tasks get the full context of the turn.
- Calendar deep links to a date ("open next week"); files open in the viewer for their type;
  inserting into an open document works at the cursor or at the end, Markdown arrives
  formatted, and the office viewer confirms the insert.
- Phone dock defaults to the built-in Teams and Post apps; the product folder in each user's
  Nextcloud is configurable (`CLARAOS_NC_FOLDER`, default `NolaniOS`).
- README showcase recorded on a demo cell (`deploy/cell`: `./run_tests.sh schaufenster`).
- Renamed from ClaraOS to **NolaniOS**; product and assistant names are configurable per
  installation (`CLARAOS_PRODUCT_NAME`, `CLARAOS_ASSISTANT_NAME`). Internal identifiers keep
  the old name for now.
- Security hardening before publication: identity headers sent by clients are dropped before
  forward auth; CORS limited to the installation's own host names; the API refuses to start
  in a cell without its trust secrets; the tool proxy accepts machine callers only; planner
  writes check the caller's own access first; resource bookings can only be cancelled by
  whoever made them (or an administrator); the web clipper connects only to the address it
  checked; container images pinned; Valkey instead of Redis.
- Shell origin hardened: mail attachments and cloud files render inline only for safe types
  (everything else downloads, with `nosniff` and a sandboxing CSP); mail HTML is sanitised
  with an allowlist parser (nh3) and again with DOMPurify in the composer; iframe bridge
  messages are bound to the embedding origins; mail archive attachments unpack at most 2 MB;
  Caddy sets HSTS, `nosniff`, a referrer policy, `frame-ancestors` and a body limit on the
  shell host, the full Content-Security-Policy runs report-only for now; no production
  sourcemaps (#11).
- Third-party notices, licence texts, code of conduct and issue templates added.
