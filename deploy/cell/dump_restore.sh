#!/usr/bin/env bash
# Restore clara_users from the latest dump — ONLY on the restore test server.
# Warning: run it as a FILE, not via 'ssh … bash -s < file': docker compose exec -T also
#    reads stdin and swallows the rest of the script (it silently ends after the first call).
set -euo pipefail
cd /opt/claraos
[ "$(hostname)" = claraos-restore-test ] || { echo "NICHT der Testserver — Abbruch"; exit 1; }
DUMP=$(sudo sh -c "ls -1d /var/backups/claraos/*/" | tail -1)db-clara_users.dump
echo "Dump: $DUMP ($(sudo du -h "$DUMP" | cut -f1))"
PSQL="docker compose exec -T clara-users-postgres psql -U clara -d clara_users -tA"
zaehle() { $PSQL -c "SELECT 'tabellen='||count(*) FROM pg_tables WHERE schemaname='public'" ; \
           $PSQL -c "SELECT 'zugaenge='||count(*) FROM claraos_app_credentials"; \
           $PSQL -c "SELECT 'apps='||count(*) FROM claraos_apps"; }
echo "vorher:  $(zaehle | tr '\n' ' ')"
docker compose stop claraos-api
docker compose exec -T clara-users-postgres psql -q -U clara -d postgres \
  -c "DROP DATABASE clara_users WITH (FORCE)" -c "CREATE DATABASE clara_users OWNER clara"
echo "leer:    $(docker compose exec -T clara-users-postgres psql -U clara -d clara_users -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'") Tabellen"
sudo cat "$DUMP" | docker compose exec -T clara-users-postgres pg_restore -U clara -d clara_users --no-owner 2>&1 | grep -v -E '^$' | head -5 || true
echo "nachher: $(zaehle | tr '\n' ' ')"
docker compose start claraos-api >/dev/null 2>&1
sleep 15
