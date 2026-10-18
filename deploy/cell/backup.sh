#!/usr/bin/env bash
# Nightly backup of a ClaraOS cell — runs as root (systemd: claraos-backup.timer).
#
# Two layers:
#   1. HERE: app-consistent snapshots to /var/backups/claraos/<date>/ (7 days).
#   2. The Hetzner backup of the whole server (daily, window 22–02 UTC) includes this
#      directory → that is why this runs at 21:30 UTC, BEFORE the window.
# Databases: pg_dump while running (consistent per database).
# RocksDB (Stalwart) and SQLite (Vaultwarden, Open WebUI): stop the service briefly — a
# copy taken while running would not be reliably consistent. Takes seconds, at night.
# Important: the directory contains the cell configuration (.env) → 0700 root; it leaves
#    the server only inside the encrypted Hetzner backup.
set -euo pipefail
cd "$(dirname "$0")"
ZIEL=/var/backups/claraos/$(date +%Y-%m-%d)
mkdir -p "$ZIEL"; chmod 700 /var/backups/claraos "$ZIEL"
LOG="$ZIEL/protokoll.txt"; : > "$LOG"
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$LOG"; }
fehler=0

# 1. Databases
for eintrag in authentik-postgres:authentik:authentik clara-users-postgres:clara:clara_users \
               nextcloud-db:nextcloud:nextcloud litellm-db:litellm:litellm \
               vikunja-db:vikunja:vikunja synapse-db:synapse:synapse \
               immich-db:immich:immich paperless-db:paperless:paperless; do
  IFS=: read -r svc user db <<< "$eintrag"
  if docker compose exec -T "$svc" pg_dump -U "$user" -Fc "$db" > "$ZIEL/db-$db.dump" 2>>"$LOG"; then
    log "db $db: $(du -h "$ZIEL/db-$db.dump" | cut -f1)"
  else
    log "✗ db $db"; fehler=1
  fi
done

# 2. Volumes while running (plain files, no database inside)
volume_tar() {  # volume_tar <volume> <name> [tar options …]
  local vol=$1 name=$2; shift 2
  docker run --rm -v "claraos_$vol:/v:ro" -v "$ZIEL:/z" alpine:3.22 \
    tar -czf "/z/vol-$name.tgz" "$@" -C /v . 2>>"$LOG" && log "vol $name: $(du -h "$ZIEL/vol-$name.tgz" | cut -f1)" \
    || { log "✗ vol $name"; fehler=1; }
}
docker compose exec -T -u www-data nextcloud php occ maintenance:mode --on >/dev/null 2>&1 || true
volume_tar nextcloud-data nextcloud-data
docker compose exec -T -u www-data nextcloud php occ maintenance:mode --off >/dev/null 2>&1 || true
volume_tar vikunja-files vikunja-files
# Paperless: originals + archive (media) and the search index/classifier (data).
volume_tar paperless-media paperless-media
volume_tar paperless-data paperless-data
# Social cell (only where it runs): databases + Mastodon media + PeerTube config.
# PeerTube videos (peertube-data) — like Immich photos — only in the server image.
if [ -n "$(docker compose ps -q mastodon-db 2>/dev/null)" ]; then
  for eintrag in mastodon-db:mastodon:mastodon peertube-db:peertube:peertube; do
    IFS=: read -r svc user db <<< "$eintrag"
    if docker compose exec -T "$svc" pg_dump -U "$user" -Fc "$db" > "$ZIEL/db-$db.dump" 2>>"$LOG"; then
      log "db $db: $(du -h "$ZIEL/db-$db.dump" | cut -f1)"
    else
      log "✗ db $db"; fehler=1
    fi
  done
  volume_tar mastodon-system mastodon-system
  volume_tar peertube-config peertube-config
fi
# Immich photos/videos (immich-upload) are deliberately NOT copied here: 10 users × quota
# would fill the disk with 7 daily copies. They are covered by the Hetzner backup of the
# whole server (the files never change after upload); the database dump above holds
# albums, faces and metadata. Restore: RESTORE.md.

# 3. Services with an embedded database: stop briefly, back up, start
# Open WebUI: `cache/` (~1 GB of embedding models) is re-downloaded — do not back it up
# (otherwise ~1 GB instead of <1 MB of data, and about a minute of downtime).
for eintrag in stalwart:stalwart-data stalwart:stalwart-etc vaultwarden:vaultwarden open-webui:open-webui; do
  IFS=: read -r svc vol <<< "$eintrag"
  docker compose stop "$svc" >/dev/null 2>&1
  if [ "$vol" = open-webui ]; then volume_tar "$vol" "$vol" --exclude=./cache; else volume_tar "$vol" "$vol"; fi
  docker compose start "$svc" >/dev/null 2>&1 || { log "✗ $svc startet nicht wieder"; fehler=1; }
done

# 4. Synapse (signing key, media, configuration) + cell configuration
tar -czf "$ZIEL/synapse-data.tgz" -C . synapse-data 2>>"$LOG" && log "synapse-data: $(du -h "$ZIEL/synapse-data.tgz" | cut -f1)" \
  || { log "✗ synapse-data"; fehler=1; }
tar -czf "$ZIEL/zelle-konfig.tgz" -C . .env caddy compose.yml litellm.yaml 2>>"$LOG" && log "zelle-konfig ok" \
  || { log "✗ zelle-konfig"; fehler=1; }
chmod 600 "$ZIEL"/*

# 5. Verify every backup is readable — a backup that was never verified is not a backup.
for f in "$ZIEL"/db-*.dump; do
  docker compose exec -T clara-users-postgres pg_restore --list < "$f" >/dev/null 2>&1 \
    || { log "✗ unlesbar: $(basename "$f")"; fehler=1; }
done
for f in "$ZIEL"/*.tgz; do
  gzip -t "$f" 2>/dev/null || { log "✗ unlesbar: $(basename "$f")"; fehler=1; }
done
( cd "$ZIEL" && sha256sum db-*.dump *.tgz > pruefsummen.txt )

# 6. Retention: 7 days
find /var/backups/claraos -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +

# State for tests/external checks (run_tests checks its age)
if [ $fehler = 0 ]; then STATUS=ok; else STATUS=FEHLER; fi
printf '%s %s %s\n' "$(date -Is)" "$STATUS" "$(du -sh "$ZIEL" | cut -f1)" > /var/backups/claraos/letzter-lauf.txt
# World-readable copy of the same line for an external monitor (an SSH key whose only
# allowed command prints this file) — status only, no content, no secrets.
install -d -m 755 /var/lib/sicherung-status
cp /var/backups/claraos/letzter-lauf.txt /var/lib/sicherung-status/sicherung.txt
chmod 644 /var/lib/sicherung-status/sicherung.txt
log "Sicherung $STATUS ($(du -sh "$ZIEL" | cut -f1))"
exit $fehler
