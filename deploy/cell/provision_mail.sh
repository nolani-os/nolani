#!/usr/bin/env bash
# Set up a mailbox per ClaraOS user in the cell's Stalwart — idempotent.
#   ./provision_mail.sh alice zelle-test …
#   ZELLE_MAIL_DRYRUN=1 ./provision_mail.sh probe      # only validate the plan
#
# Per user: random password (created HERE, never printed) → Stalwart account
# `<user>@<domain>` in the internal directory (passwords can be set there — with an
# EXTERNAL directory such as Authentik, Stalwart would need AppPasswords instead) → credentials encrypted in claraos_app_credentials (app_id=mail,
# username = full address), as routers/post.py and mail.py read them.
# Warning: the CLI output of write calls is discarded (it may echo server-set fields).
# Warning: no `destroy` (footgun in 0.16.11) — existing accounts get a new password via update.
set -euo pipefail
cd "$(dirname "$0")"
DOM=$(sed -n 's/^ZELLE_DOMAIN=//p' .env)
DOMAIN_ID=$(./stalwart_cli.sh query Domain 2>/dev/null | awk -v d="$DOM" '$2==d {print $1; exit}')
[ -n "$DOMAIN_ID" ] || { echo "  ✗ Stalwart-Domain $DOM nicht gefunden"; exit 1; }

for U in "$@"; do
  PW=$(openssl rand -base64 30 | tr -d '/+=\n')
  PLAN=$(python3 - "$U" "$DOMAIN_ID" "$PW" <<'PY'
import json, sys
u, dom_id, pw = sys.argv[1:]
print(json.dumps({"@type": "create", "object": "Account", "value": {f"acct-{u}": {
    "@type": "User", "name": u, "domainId": dom_id,
    "credentials": {"0": {"@type": "Password", "secret": pw}}}}}))
PY
)
  if [ -n "${ZELLE_MAIL_DRYRUN:-}" ]; then
    printf '%s\n' "$PLAN" | ./stalwart_cli.sh apply --stdin --dry-run 2>&1 | tail -3
    continue
  fi
  VORHANDEN=$(./stalwart_cli.sh query Account 2>/dev/null | awk -v u="$U" '$2==u || $2==u"@'"$DOM"'" {print $1; exit}')
  if [ -n "$VORHANDEN" ]; then
    PATCH=$(python3 -c 'import json,sys;print(json.dumps({"credentials":{"0":{"@type":"Password","secret":sys.argv[1]}}}))' "$PW")
    printf '%s' "$PATCH" | ./stalwart_cli.sh update Account "$VORHANDEN" --stdin >/dev/null 2>&1 \
      || { echo "  ✗ $U: Passwort nicht gesetzt"; continue; }
  else
    printf '%s\n' "$PLAN" | ./stalwart_cli.sh apply --stdin --quiet >/dev/null 2>&1 \
      || { echo "  ✗ $U: Postfach nicht angelegt"; continue; }
  fi
  MAIL_ADDR="$U@$DOM" MAIL_PW="$PW" docker compose exec -T -e MAIL_ADDR -e MAIL_PW -e MAIL_USER="$U" \
    claraos-api python3 - <<'PY'
import asyncio, os, sys
sys.path.insert(0, "/app")
from database import get_pool
from encryption import encrypt_credentials
async def main():
    blob = encrypt_credentials({"username": os.environ["MAIL_ADDR"], "password": os.environ["MAIL_PW"]})
    pool = await get_pool()
    async with pool.acquire() as c:
        await c.execute("""INSERT INTO claraos_app_credentials (username, app_id, account_name, credentials, is_active)
            VALUES ($1,'mail','Default',$2,TRUE) ON CONFLICT (username, app_id, account_name)
            DO UPDATE SET credentials=EXCLUDED.credentials, is_active=TRUE, updated_at=NOW()""",
            os.environ["MAIL_USER"], blob)
asyncio.run(main())
PY
  unset PW PLAN
  echo "  $U: Postfach $U@$DOM eingerichtet"
done
