# ClaraOS

**A self-hosted, browser-based workspace for small teams and families — files, office, mail,
calendar and tasks, chat and calls, knowledge, passwords — with an AI assistant built in.**

ClaraOS runs as a desktop-like web shell on top of proven
open-source services. One installation — a *cell* — is one server and one trust boundary.

> **Status: early preview.** This repository is private while the code is being prepared for
> publication. Interfaces, configuration and layout will change.

## What's inside

| Area | Built on |
|---|---|
| Shell (desktop + mobile UI) | React, TypeScript, Vite — `packages/shell`, `packages/core`, `packages/skins` |
| API / backend-for-frontend | Python, FastAPI — `packages/api` |
| Sign-in (SSO) | Authentik (OIDC) |
| Files & office | Nextcloud, Collabora Online |
| Mail | Stalwart (JMAP) |
| Tasks & planner | Vikunja |
| Chat & calls ("Teams") | Matrix / Synapse, LiveKit, Element Call |
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
another network.

## Documentation language

Code comments and documentation are written in English. Some user-facing texts of the shell
are German; translations are welcome.

## Security

Please do not open public issues for security problems — see [SECURITY.md](SECURITY.md).

## License

ClaraOS is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).
If you run a modified version as a network service, the AGPL requires you to offer its source
code to the users of that service.

Bundled and integrated third-party services keep their own licenses.
