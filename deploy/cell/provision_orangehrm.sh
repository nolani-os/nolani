# OrangeHRM of a cell: the cell's Authentik as the one OpenID Connect provider.
#
#   docker compose exec -T -e ZELLE_DOMAIN -e ORANGEHRM_OIDC_SECRET -e CLARAOS_PRODUCT_NAME \
#     orangehrm-db sh < provision_orangehrm.sh
#
# Runs in the database container (OrangeHRM keeps its providers in two tables; its admin
# UI would be a click path). Idempotent. Prints no secrets. The database password comes
# from the container's own environment.
set -eu
q() { mariadb -N -B -u orangehrm -p"$MARIADB_PASSWORD" orangehrm -e "$1"; }

URL="https://auth.$ZELLE_DOMAIN/application/o/orangehrm/"
NAME="${CLARAOS_PRODUCT_NAME:-NolaniOS}"
case "$NAME$ORANGEHRM_OIDC_SECRET" in *\'*|*\\*) echo "ORANGEHRM FEHLER: unerwartete Zeichen" >&2; exit 1 ;; esac

# The patched controller gives new accounts role id 2 — that must be ESS.
[ "$(q "SELECT name FROM ohrm_user_role WHERE id = 2")" = "ESS" ] \
  || { echo "ORANGEHRM FEHLER: Rolle 2 ist nicht ESS" >&2; exit 1; }

id=$(q "SELECT id FROM ohrm_openid_provider WHERE provider_url = '$URL' ORDER BY id LIMIT 1")
if [ -z "$id" ]; then
  q "INSERT INTO ohrm_openid_provider (provider_name, provider_url, status) VALUES ('$NAME', '$URL', 1)"
  id=$(q "SELECT id FROM ohrm_openid_provider WHERE provider_url = '$URL' ORDER BY id LIMIT 1")
  neu=angelegt
else
  q "UPDATE ohrm_openid_provider SET provider_name = '$NAME', status = 1 WHERE id = $id"
  neu=aktuell
fi
# Exactly one active provider: only then does the login page go straight to it.
q "UPDATE ohrm_openid_provider SET status = 0 WHERE id <> $id"
if [ -n "$(q "SELECT id FROM ohrm_auth_provider_extra_details WHERE provider_id = $id")" ]; then
  q "UPDATE ohrm_auth_provider_extra_details SET client_id = 'orangehrm', client_secret = '$ORANGEHRM_OIDC_SECRET' WHERE provider_id = $id"
else
  q "INSERT INTO ohrm_auth_provider_extra_details (provider_id, client_id, client_secret) VALUES ($id, 'orangehrm', '$ORANGEHRM_OIDC_SECRET')"
fi
echo "ORANGEHRM Anmeldung über die Zelle $neu (Provider $id); neue Konten: ESS (Self-Service)"
