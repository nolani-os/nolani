# Restoring a ClaraOS cell

Both paths below have been rehearsed end to end;
afterwards all six test suites (`run_tests.sh`) passed on the copy.

## What exists

| Layer | What | When | Where |
|---|---|---|---|
| App backup | `backup.sh`: `pg_dump` of all 8 databases, volumes (Nextcloud, Vikunja, Paperless, Stalwart, Vaultwarden, Open WebUI without `cache/`), `synapse-data`, cell configuration (`.env`, Caddy, Compose, LiteLLM) — every file verified, checksums | daily at **21:30 UTC** (`claraos-backup.timer`) | `/var/backups/claraos/<date>/` (0700, 7 days) |
| Server image | Hetzner backup of the whole server — includes the app backup | daily, window **22–02 UTC** | Hetzner (7 copies) |

`/var/backups/claraos/letzter-lauf.txt` shows time, status (`ok`/`FEHLER`) and size of the last run.
Note: **no alerting path** on failure yet — add one (e.g. a notification service the cell can reach) before relying on it in production.
Note: no copy outside Hetzner (e.g. a Storage Box) — recommended for production cells.

## Path 1: whole server from a Hetzner backup/snapshot

For total loss. In the Hetzner console use "Create from backup", or via the API
(`ZELLE_ADMIN_CIDR=<your-ip>/32 restore_test.py create` builds exactly this as a test: snapshot → server with a firewall allowing only SSH from that network).
The services start on their own (`restart: unless-stopped`); certificates live in the Caddy volume.
Then point DNS at the new IP — or move the old IP over via a Hetzner "Primary IP".

**Testing without disturbing the real cell:** on the copy, point `/etc/hosts` at itself for **both IPv4 AND IPv6**
(`127.0.0.1` + `::1`, all cell host names) — IPv4 alone is not enough: `getent` returned the AAAA address of the
original. Check beforehand where connections actually go (`curl -w %{remote_ip}`), otherwise you are testing the original.
Then run `./run_tests.sh`. Teardown: `restore_test.py destroy`.

## Path 2: a single service from the app backup

- **Database** (example `dump_restore.sh` for `clara_users`): stop the API → empty/recreate the DB →
  `pg_restore --no-owner` → start the API. Verified: table, credential and app counts identical before and after, tests green.
  Important: the credentials in `claraos_app_credentials` are encrypted with `CLARAOS_CREDENTIAL_KEY` from `.env` —
  **a database without the matching `.env` is worthless**. Both are in the same backup (`zelle-konfig.tgz`).
- **Volume:** stop the service → `docker run --rm -v claraos_<vol>:/v -v <backup>:/z alpine sh -c "rm -rf /v/* && tar -xzf /z/vol-<name>.tgz -C /v"` → start it.
- **Synapse:** `synapse-data.tgz` contains the **signing key** — without it the Matrix identity is lost.
- **Immich photos/videos** (`immich-upload` volume) are **only** in the Hetzner server image, not in the app backup
  (7 daily copies of every user's quota would fill the disk). To restore them alone: create a server from the
  Hetzner backup, copy the volume over (`rsync`), restore `db-immich.dump` from the same day — files and
  database must come from the same point in time, otherwise Immich shows missing or orphaned assets.

## Pitfalls found while rehearsing
- `ssh … 'bash -s' < script` combined with `docker compose exec -T` inside the script → exec reads stdin and swallows the rest;
  the script ended **silently** after the first call. Copy scripts over as files and run them.
- A glob on a 0700 directory (`sudo ls …/*/`) is expanded by the **calling** user → empty.
  Use `sudo sh -c "ls …/*/"`.
- Tests were "green" even though the restore had not run at all (the script had aborted earlier).
  Important: **before/after counts belong in every restore test** — otherwise a green test afterwards proves nothing.
