# Roadmap

Where NolaniOS is heading. Priorities change with what users need — open a
[discussion](https://github.com/nolani-os/nolani/discussions) if something matters to you.

**Legend:** ✅ done · 🚧 in progress · 🔜 next · 💭 exploring

## The assistant
- ✅ Operates the apps: opens and closes windows, jumps to records, opens files in the right
  viewer, writes into the open office document, reads what is on screen to check its own work
- ✅ Tools per app, one catalogue (`clara-tools.d/`) — tasks, calendar, contacts, mail, files,
  documents, knowledge, photos, videos, routines
- ✅ Approval for anything public or irreversible (e.g. posting): a button, not a chat "yes"
- ✅ Image attachments (described by a vision model)
- ✅ Bring your own agent: MCP endpoint with per-user keys and read/write scopes
- 🔜 Web search with sources
- 🔜 Video attachments
- 🔜 Guided tours inside the shell, started by the assistant
- 💭 Learning from structure across installations — never from content

## Workspace
- ✅ Desktop and mobile shell, files, office (Collabora), mail, planner with calendar and
  Gantt, chat and calls (Matrix, LiveKit), photos, documents, passwords, knowledge base
- ✅ German and English shell frame
- 🚧 English for every app (translation catalogs)
- 🔜 More languages — contributions welcome

## Running it
- ✅ One server per installation (a *cell*), all secrets generated on the server
- ✅ OpenTofu module for Hetzner Cloud, nightly backups, restore guide, end-to-end tests
- 🔜 One-line installer for a fresh Debian server
- 🔜 Public demo
- 🔜 Rename the remaining internal `claraos` identifiers
- 💭 Smaller footprint for a single person (fewer services)
