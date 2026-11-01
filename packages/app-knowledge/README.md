# Nolani Knowledge — standalone app

Notes, pages and databases that live entirely on your device: no server, no
account. Linux, Windows and Android (Tauri 2); the same code also runs in a
browser for development.

The app reuses the Knowledge views of the Nolani shell
(`packages/shell/src/apps/wissen`) and answers their requests with a local
SQLite database (`src/local/`) instead of a server. The local layer follows
the server's `/api/claraos/knowledge` contract; differential tests check it
against the server's own code (see *Tests*).

## Build

```sh
# web part (from this directory)
node ../shell/node_modules/vite/bin/vite.js build
# native packages: Tauri 2 CLI with the web part in ../dist
cargo tauri build --bundles deb appimage            # Linux
cargo tauri build --runner cargo-xwin \
  --target x86_64-pc-windows-msvc --bundles nsis    # Windows (cross)
```

Bundle id: `de.nolanios.knowledge`. The database file is `knowledge.db` in the
app's data directory (Linux `~/.config/de.nolanios.knowledge/`, Windows
`%APPDATA%\de.nolanios.knowledge\`).

## Local API

Other programs on the same computer — scripts, AI agents — can use the app over
HTTP with the same paths and JSON as a Nolani server's knowledge API.

Turn it on under **Settings → Local API**. It then listens on
`http://127.0.0.1:7311/api/claraos/knowledge` (port configurable) while the app
is running. Every request needs the key shown there:

```sh
KEY=…   # Settings → Local API → Copy
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:7311/api/claraos/knowledge/objects
curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"title": "From a script", "body": "Hello"}' \
     http://127.0.0.1:7311/api/claraos/knowledge/objects
```

Guards: loopback address only; wrong or missing key → 401; a `Host` other than
`127.0.0.1:<port>` / `localhost:<port>` → 421 (DNS rebinding); any request with
an `Origin` header → 403 (web pages in a browser must not drive the app).
Requests are answered by the same local data layer the app's own views use.
Desktop only: phones stop background apps, so the API is not offered there.

## Tests

From `projects/claraos`:

| Test | What it compares | Needs |
|---|---|---|
| `node packages/app-knowledge/test/query.diff.mjs` | filters, sorts, aggregates vs. `kb_query.py` on PostgreSQL | docker, python3 + asyncpg |
| `node packages/app-knowledge/test/formula.diff.mjs` | formulas vs. `kb_formula.py` | a Python 3.14 oracle (`FORMULA_ORACLE`) |
| `node packages/app-knowledge/test/history_archive.diff.mjs` | version diff, ZIP import/export vs. `kb_diff.py` / `kb_import.py` | python3 |
| `python3 -I packages/app-knowledge/test/e2e.py <dist> <shots>` | the whole app in a headless browser (or a native app via `cdp:<url>`) | playwright |
| `test/api.native.sh` | the local API of the built Linux binary under Xvfb | the desktop build image |
