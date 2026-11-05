#!/usr/bin/env bash
# Tests for a cell using a throwaway account — run on the cell, in /opt/claraos.
#   ./run_tests.sh              all tests that fit this cell's apps
#   ./run_tests.sh files        just one
# Creates `zelle-test` (Authentik + Nextcloud access), runs the tests and ALWAYS
# cleans up afterwards — even if a test fails (trap).
# Optional apps (setup.sh --apps, CLARAOS_OPTIONAL_APPS in .env): a test of an app
# that does not run here is reported as skipped, not failed; the tests themselves
# skip their parts of switched-off apps (optionale_apps.py). A green run therefore
# means: everything THIS cell is meant to run works.
set -uo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
DOM="$ZELLE_DOMAIN"
# Same rule as betriebsprofil.py: unset/all = everything except Odoo
case "${CLARAOS_OPTIONAL_APPS-all}" in
  all) APPS=" photos documents browser office teams " ;;
  *)   APPS=" $(echo "${CLARAOS_OPTIONAL_APPS}" | tr ',' ' ') " ;;
esac
export CLARAOS_OPTIONAL_APPS="$(echo $APPS | tr ' ' ',')"
an() { case "$APPS" in *" $1 "*) return 0 ;; esac; return 1; }
# Test → the optional app(s) it needs (medien: photos OR documents, it checks each part)
braucht() {
  case "$1" in
    teams|calls) an teams ;;
    browser)     an browser ;;
    medien)      an photos || an documents ;;
    odoo)        an odoo ;;
    inventree)   an inventree ;;
    superset)    an superset ;;
    mautic)      an mautic ;;
    orangehrm)   an orangehrm ;;
    # Only the cell that hosts the shared social cell (setup.sh --social). Elsewhere
    # the test derived social.<parent domain> — on a sslip.io cell a name that does not
    # exist, so it failed instead of skipping.
    social)      case ",${COMPOSE_PROFILES:-}," in *,social,*) return 0 ;; esac; return 1 ;;
    *)           return 0 ;;
  esac
}
# Which parts the media test runs
MEDIEN_TEILE=$(for a in photos documents; do an $a && printf '%s,' $a; done); export MEDIEN_TEILE
ZELLE_PW=$(openssl rand -hex 16); export ZELLE_PW
ZELLE_MAIL="zelle-test+$(date +%s)@invalid.example"; export ZELLE_MAIL   # see testkonto.py

aufraeumen() {
  # A connected brain forgets the test account too (memories, chat sessions).
  docker compose exec -T claraos-api python3 -c "import asyncio; from services import brain_turns; print('BRAIN_VERGESSEN', asyncio.run(brain_turns.forget_user('zelle-test')))" 2>/dev/null | grep ^BRAIN_
  docker compose exec -T -e ZELLE_LOESCHEN=1 authentik ak shell < testkonto.py 2>/dev/null | grep ^TEST_
  # Photos/documents: both create the account on first login — remove it with its data.
  an photos && docker compose exec -T -e IMMICH_API_KEY claraos-api python3 - zelle-test < medien_konto_weg.py 2>/dev/null | grep ^IMMICH_
  an documents && docker compose exec -T -u paperless -e KONTO=zelle-test paperless python3 manage.py shell \
    < paperless_konto_weg.py 2>/dev/null | grep ^PAPERLESS_
  an inventree && docker compose exec -T -w /home/inventree/src/backend/InvenTree inventree-server \
    python3 manage.py shell < inventree_konto_weg.py 2>/dev/null | grep ^INVENTREE_
  an superset && docker compose exec -T superset python - < superset_konto_weg.py 2>/dev/null | grep ^SUPERSET_
  an mautic && docker compose exec -T -u www-data mautic php < mautic_konto_weg.php 2>/dev/null | grep ^MAUTIC_
  an orangehrm && docker compose exec -T orangehrm-db sh < orangehrm_konto_weg.sh 2>/dev/null | grep ^ORANGEHRM_
  # Odoo: likewise created on first login (odoo_test.py)
  an odoo && docker compose exec -T odoo odoo shell -c /etc/odoo/odoo.conf -d odoo --no-http \
    < odoo_konto_weg.py 2>/dev/null | grep ^ODOO_
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
  an browser && docker compose exec -T claraos-api python3 -c "import asyncio; from services import zellen_browser as z; print('BROWSER_GELOESCHT', asyncio.run(z.remove('zelle-test')))" 2>/dev/null | grep ^BROWSER_
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
an teams && docker compose exec -T -e SYNAPSE_REGISTRATION_SECRET -e ZELLE_DOMAIN claraos-api python3 - zelle-test < provision_matrix.py

# Playwright container for the browser-driven tests (sicht, oberflaeche, bedien, odoo)
im_browser() {   # im_browser <script> <output dir> [-e VAR …]
  local skript=$1 aus=$2; shift 2
  rm -rf "$aus" && mkdir -p "$aus"
  docker run --rm -e ZELLE_TEST_PW="$ZELLE_PW" -e CLARAOS_OPTIONAL_APPS "$@" -v "$PWD:/w" -w /w \
    mcr.microsoft.com/playwright/python:v1.52.0-noble \
    sh -c "pip install -q playwright==1.52.0 >/dev/null 2>&1; playwright install --with-deps chrome >/dev/null 2>&1; python3 $skript $DOM zelle-test /w/$aus"
}

rc=0
echo "Apps dieser Zelle: Kern$(for a in $APPS; do printf ' + %s' "$a"; done)"
for t in ${1:-login files planner post teams chat medien browser routinen social clara_apps odoo inventree superset mautic orangehrm}; do
  echo; echo "── ${t}_test ──"
  if ! braucht "$t"; then
    echo "  übersprungen — die App läuft in dieser Zelle nicht (setup.sh --apps)"
    continue
  fi
  if [ "$t" = calls ]; then
    # Part 1 of the call test; part 2 (joining from OUTSIDE) uses sicht/lk.json
    mkdir -p sicht
    ZELLE_TEST_PW=$ZELLE_PW python3 anruf_test.py "$DOM" zelle-test sicht/lk.json || rc=1
  elif [ "$t" = sicht ]; then
    # Visual check in a real browser — screenshots to ./sicht/
    im_browser sicht_test.py sicht || rc=1
  elif [ "$t" = oberflaeche ]; then
    # The assistant opens and drives apps on request (needs the brain) — screenshots to ./oberflaeche/
    im_browser oberflaeche_test.py oberflaeche || rc=1
  elif [ "$t" = bedien ]; then
    # Operation check: click through every app like a user — screenshots to ./bedien/
    im_browser bedien_test.py bedien -e ZELLE_MAIL || rc=1
  elif [ "$t" = odoo ]; then
    # Odoo tile → login via the cell → backend as internal user — screenshots to ./odoo-test/
    # (NOT ./odoo: that is the image build context, im_browser empties its output dir)
    im_browser odoo_test.py odoo-test || rc=1
    # Clara's Odoo tools through the gateway, as the brain calls them (needs the Odoo
    # account the browser test just created)
    docker compose exec -T claraos-api python3 - zelle-test < odoo_clara_test.py || rc=1
  elif [ "$t" = inventree ]; then
    # InvenTree tile → login via the cell → normal account of group nutzer → create a part
    im_browser inventree_test.py inventree-test -e CLARAOS_PRODUCT_NAME || rc=1
    # Clara's InvenTree tools through the gateway (needs the account the browser test created)
    docker compose exec -T claraos-api python3 - zelle-test < inventree_clara_test.py || rc=1
  elif [ "$t" = superset ]; then
    # Superset tile → login via the cell → account with role Alpha, not Admin → create a
    # dashboard. Output NOT into ./superset: that is the image build context.
    im_browser superset_test.py superset-test || rc=1
  elif [ "$t" = mautic ]; then
    # Mautic tile → SAML login via the cell → no user administration → create a contact
    im_browser mautic_test.py mautic-test || rc=1
    # …and it can send to outside addresses (own mailbox with login)
    docker compose exec -T -u www-data mautic php < mautic_mail_test.php || rc=1
    # Clara's Mautic tools through the gateway (contacts, segment, drafts, unpublished campaign)
    docker compose exec -T claraos-api python3 - zelle-test < mautic_clara_test.py || rc=1
  elif [ "$t" = orangehrm ]; then
    # OrangeHRM tile → OIDC via the cell → new employee, role ESS → self-service works.
    # Output NOT into ./orangehrm: that is the image build context.
    im_browser orangehrm_test.py orangehrm-test || rc=1
  else
    ZELLE_TEST_PW=$ZELLE_PW python3 "${t}_test.py" "$DOM" zelle-test || rc=1
  fi
done
exit $rc
