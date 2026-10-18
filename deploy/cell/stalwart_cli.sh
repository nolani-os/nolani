#!/usr/bin/env bash
# The cell's stalwart-cli (run as a container).
#   ./stalwart_cli.sh describe Account
#   ./stalwart_cli.sh apply --stdin < plan.ndjson
# Reads the recovery admin password from .env without printing it.
# Warning: NEVER run `destroy` on an account — in 0.16.11 it deletes ALL accounts.
# Warning: `update Bootstrap` echoes the server-generated admin password in its
#    response. That is why EVERY output goes through a filter that redacts
#    secret/password/token values — for write calls too.
set -euo pipefail
cd "$(dirname "$0")"
STALWART_PASSWORD=$(sed -n 's/^STALWART_ADMIN_PASSWORD=//p' .env)
export STALWART_PASSWORD
case " $* " in *" destroy "*|*'"destroy"'*) echo "destroy ist hier gesperrt (Footgun 0.16.11)"; exit 2;; esac
docker run --rm -i --network claraos_zelle \
  -e STALWART_URL=http://stalwart:8080 -e STALWART_USER=admin -e STALWART_PASSWORD \
  ghcr.io/stalwartlabs/cli:latest --no-color "$@" 2>&1 \
  | sed -E 's/((secret|password|token|apikey|api_key)"?[[:space:]]*[:=][[:space:]]*"?)[^",[:space:]]+/\1***/Ig'
exit "${PIPESTATUS[0]}"
