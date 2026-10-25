#!/usr/bin/env bash
# Tests for a cell using a throwaway account — run on the cell, in /opt/claraos.
#   ./run_tests.sh              all tests
#   ./run_tests.sh files        just one
# Creates `zelle-test` (Authentik + Nextcloud access), runs the tests and ALWAYS
# cleans up afterwards — even if a test fails (trap).
set -uo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
DOM="$ZELLE_DOMAIN"
ZELLE_PW=$(openssl rand -hex 16); export ZELLE_PW
ZELLE_MAIL="zelle-test+$(date +%s)@invalid.example"; export ZELLE_MAIL   # see testkonto.py

aufraeumen() {
  # A connected brain forgets the test account too (memories, chat sessions).
  docker compose exec -T claraos-api python3 -c "import asyncio; from services import brain_turns; print('BRAIN_VERGESSEN', asyncio.run(brain_turns.forget_user('zelle-test')))" 2>/dev/null | grep ^BRAIN_
  docker compose exec -T -e ZELLE_LOESCHEN=1 authentik ak shell < testkonto.py 2>/dev/null | grep ^TEST_
  # Photos/documents: both create the account on first login — remove it with its data.
  docker compose exec -T -e IMMICH_API_KEY claraos-api python3 - zelle-test < medien_konto_weg.py 2>/dev/null | grep ^IMMICH_
  docker compose exec -T -u paperless -e KONTO=zelle-test paperless python3 manage.py shell \
    < paperless_konto_weg.py 2>/dev/null | grep ^PAPERLESS_
  # Social cell (only where it runs): Mastodon + PeerTube accounts of the test user.
  if [ -n "$(docker compose ps -q mastodon-web 2>/dev/null)" ]; then
    docker compose exec -T mastodon-web bin/rails runner "$(cat mastodon_konto_weg.rb)" zelle-test 2>/dev/null \
      | grep ^MASTODON_
    docker compose exec -T -e PEERTUBE_ROOT_PASSWORD -e VIDEO_DOMAIN claraos-api \
      python3 - zelle-test < social_konto_weg.py 2>/dev/null | grep ^PEERTUBE_
  fi
  # Clara's app accesses the cell created for the test account (services/zellen_zugaenge.py)
  docker compose exec -T clara-users-postgres psql -q -U clara -d clara_users \
    -c "DELETE FROM claraos_app_credentials WHERE username='zelle-test' AND account_name='Clara'" >/dev/null 2>&1
  # Routines and notifications of the test account (routines delete their runs).
  docker compose exec -T clara-users-postgres psql -q -U clara -d clara_users \
    -c "DELETE FROM claraos_routinen WHERE username='zelle-test'" \
    -c "DELETE FROM claraos_meldungen WHERE username='zelle-test'" >/dev/null 2>&1
  # Personal browser: containers, profile and network of the test account.
  docker compose exec -T claraos-api python3 -c "import asyncio; from services import zellen_browser as z; print('BROWSER_GELOESCHT', asyncio.run(z.remove('zelle-test')))" 2>/dev/null | grep ^BROWSER_
  docker compose exec -T -u www-data nextcloud php occ user:delete zelle-test >/dev/null 2>&1
  # A data folder left behind by an interrupted delete blocks re-creating the account
  # ("Login is invalid because files already exist for this user").
  docker compose exec -T -u www-data nextcloud rm -rf /var/www/html/data/zelle-test >/dev/null 2>&1
  # Vikunja draws its table with "│" (not "|") — extract the ID from the row.
  VID=$(docker compose exec -T vikunja /app/vikunja/vikunja user list 2>/dev/null \
        | grep -E '[│|] *zelle-test *[│|]' | grep -oE '[0-9]+' | head -1)
  if [ -n "$VID" ]; then
    docker compose exec -T vikunja /app/vikunja/vikunja user delete "$VID" --now --confirm >/dev/null 2>&1 \
      && echo "VIKUNJA_TEST_GELOESCHT $VID" || echo "  ✗ Vikunja-Testkonto nicht gelöscht"
  fi
  docker compose exec -T clara-users-postgres psql -q -U clara -d clara_users \
    -c "DELETE FROM claraos_app_credentials WHERE username='zelle-test'" >/dev/null
  unset ZELLE_PW
}
trap aufraeumen EXIT

docker compose exec -T -e ZELLE_PW -e ZELLE_MAIL authentik ak shell < testkonto.py 2>/dev/null | grep ^TEST_
docker compose exec -T -e NEXTCLOUD_ADMIN_USER=ncadmin -e NEXTCLOUD_ADMIN_PASSWORD \
  claraos-api python3 - zelle-test < provision_nc.py
docker compose exec -T -e ZELLE_DOMAIN claraos-api python3 - zelle-test < provision_vikunja.py
./provision_mail.sh zelle-test
docker compose exec -T claraos-api python3 - zelle-test < provision_owui.py
docker compose exec -T -e SYNAPSE_REGISTRATION_SECRET -e ZELLE_DOMAIN claraos-api python3 - zelle-test < provision_matrix.py

rc=0
for t in ${1:-login files planner post teams chat medien browser routinen social clara_apps}; do
  echo; echo "── ${t}_test ──"
  if [ "$t" = calls ]; then
    # Part 1 of the call test; part 2 (joining from OUTSIDE) uses sicht/lk.json
    mkdir -p sicht
    ZELLE_TEST_PW=$ZELLE_PW python3 anruf_test.py "$DOM" zelle-test sicht/lk.json || rc=1
  elif [ "$t" = sicht ]; then
    # Visual check in a real browser (Playwright container) — screenshots to ./sicht/
    rm -rf sicht && mkdir -p sicht
    docker run --rm -e ZELLE_TEST_PW="$ZELLE_PW" -v "$PWD:/w" -w /w \
      mcr.microsoft.com/playwright/python:v1.52.0-noble \
      sh -c "pip install -q playwright==1.52.0 >/dev/null 2>&1; playwright install --with-deps chrome >/dev/null 2>&1; python3 sicht_test.py $DOM zelle-test /w/sicht" || rc=1
  elif [ "$t" = oberflaeche ]; then
    # The assistant opens and drives apps on request (needs the brain) — screenshots to ./oberflaeche/
    rm -rf oberflaeche && mkdir -p oberflaeche
    docker run --rm -e ZELLE_TEST_PW="$ZELLE_PW" -v "$PWD:/w" -w /w \
      mcr.microsoft.com/playwright/python:v1.52.0-noble \
      sh -c "pip install -q playwright==1.52.0 >/dev/null 2>&1; playwright install --with-deps chrome >/dev/null 2>&1; python3 oberflaeche_test.py $DOM zelle-test /w/oberflaeche" || rc=1
  elif [ "$t" = bedien ]; then
    # Operation check: click through every app like a user — screenshots to ./bedien/
    rm -rf bedien && mkdir -p bedien
    docker run --rm -e ZELLE_TEST_PW="$ZELLE_PW" -e ZELLE_MAIL -v "$PWD:/w" -w /w \
      mcr.microsoft.com/playwright/python:v1.52.0-noble \
      sh -c "pip install -q playwright==1.52.0 >/dev/null 2>&1; playwright install --with-deps chrome >/dev/null 2>&1; python3 bedien_test.py $DOM zelle-test /w/bedien" || rc=1
  else
    ZELLE_TEST_PW=$ZELLE_PW python3 "${t}_test.py" "$DOM" zelle-test || rc=1
  fi
done
exit $rc
