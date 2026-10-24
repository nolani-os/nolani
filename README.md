# NolaniOS

**A self-hosted, browser-based workspace for small teams and families — files, office, mail,
calendar and tasks, chat and calls, knowledge, passwords — with an AI assistant built in.**

NolaniOS runs as a desktop-like web shell on top of proven open-source services. One
installation — a *cell* — is one server and one trust boundary. The assistant is called
*Nolani* by default; each installation can give it (and the product) its own name.

> **Status: early preview.** Interfaces, configuration and layout still change. Run it for
> yourself and your family or team, not yet for customers.

> **Formerly ClaraOS.** Many internal identifiers still carry the old name — the package
> scope `@claraos/*`, the API prefix `/api/claraos`, environment variables `CLARAOS_*`,
> database tables `claraos_*`. They are not user-visible and will be renamed step by step.

## What's inside

| Area | Built on |
|---|---|
| Shell (desktop + mobile UI) | React, TypeScript, Vite — `packages/shell`, `packages/core`, `packages/skins` |
| API / backend-for-frontend | Python, FastAPI — `packages/api` |
| Sign-in (SSO) | Authentik (OIDC) |
| Files & office | Nextcloud, Collabora Online (CODE) |
| Mail | Stalwart (JMAP) |
| Tasks & planner | Vikunja |
| Chat & calls | Matrix / Synapse, LiveKit, Element Call |
| Passwords | Vaultwarden |
| Photos | Immich |
| Documents (scans, OCR) | Paperless-ngx |
| Social (optional) | Mastodon, PeerTube |
| Personal web browser | Selkies (Chromium streamed into the shell) |
| AI assistant | LiteLLM gateway (any OpenAI-compatible or Anthropic model), Open WebUI |
| Reverse proxy & TLS | Caddy |

## Repository layout

```
packages/
  core/        shared types, stores, domain helpers
  shell/       the web shell and its built-in apps
  skins/       themes, icons, app symbols
  api/         FastAPI backend (routers, services, migrations)
docker/        Dockerfiles for the API and the frontend image
deploy/
  cell/        Docker Compose stack + setup/test/backup scripts for one cell
  terraform/   OpenTofu module for a cell on Hetzner Cloud
```

## Running a cell

A cell needs one Linux server (tested: 8 vCPU / 16 GB RAM / 160 GB disk, Debian 13) with
Docker, and a domain whose `<domain>` and `*.<domain>` records point to it.

```bash
# 1. Server (optional — any VPS works): see deploy/terraform/hetzner-cell/README.md
# 2. Copy deploy/cell/ to /opt/claraos and the source to /opt/claraos/src
# 3. On the server:
cd /opt/claraos
./setup.sh <your-domain>      # idempotent; generates all secrets locally in .env (0600)
./run_tests.sh                # end-to-end checks with a throw-away test account
```

`setup.sh` builds the images, starts the stack, bootstraps SSO and provisions every service.
Backups run nightly via a systemd timer (`backup.sh`); restore steps are in `deploy/cell/RESTORE.md`.

The API only enables the routes and apps a cell is meant to offer (`CLARAOS_PROFILE=cell`, see
`packages/api/betriebsprofil.py`) and refuses to start if its configuration still points at
another network or lacks its trust secrets.

**Names.** Set `CLARAOS_PRODUCT_NAME` and `CLARAOS_ASSISTANT_NAME` in the cell's `.env` to
rename the product and the assistant (defaults: `NolaniOS`, `Nolani`).

### Services with their own terms

The cell pulls these images unchanged; their licences apply to them, not to this repository:

- **Collabora Online CODE** is the development edition (MPL-2.0, with Collabora's trademarks
  and an unsupported-version notice). For production or commercial use, consider a Collabora
  Online subscription.
- **Open WebUI** uses a BSD-3-Clause licence with a branding clause: installations with more
  than 50 users in 30 days must keep the "Open WebUI" branding or obtain an enterprise
  licence. NolaniOS talks to its API from its own chat UI; check whether this applies to you.
- **Stalwart, Authentik and LiteLLM** ship optional enterprise features under separate
  licences. A cell uses none of them and sets no licence keys.
- **Redis-compatible cache:** the cell uses Valkey (BSD-3-Clause).

## Documentation language

Code comments and documentation are written in English. The user interface is German; the
shell frame is also available in English and the apps are being translated. More languages
are welcome.

## How this code was written

Most of the code was written with the help of AI coding assistants, directed, reviewed and
tested by the maintainer. Design decisions, architecture and every change are the
maintainer's responsibility.

## Security

Please do not open public issues for security problems — see [SECURITY.md](SECURITY.md).

## Trademarks

"Nolani" and "NolaniOS" are names of this project. Names and logos of other products
(Nextcloud, Immich, Mastodon, Element, Vaultwarden, Paperless-ngx, PeerTube, Authentik,
Open WebUI and others) are trademarks of their respective owners and are used only to
identify those products; no endorsement is implied. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Copyright © 2025–2026 the NolaniOS authors (see the Git history).

NolaniOS is licensed under the **GNU Affero General Public License v3.0 or later** — see
[LICENSE](LICENSE). If you run a modified version as a network service, the AGPL requires you
to offer its source code to the users of that service; set `CLARAOS_SOURCE_URL` so the
shell's "About" page links to your source. Bundled third-party components keep their own
licences — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
