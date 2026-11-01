#!/usr/bin/env bash
# Setup of a ClaraOS cell — runs ON the cell, as the admin user `clara`.
#
#   cd /opt/claraos && ./setup.sh demo.example.com [--apps photos,office] [--social] [--mcp]
#
# --apps: optional apps this cell runs, comma-separated (`none` = only the core):
#     photos     Immich                       ~1 GB, peaks to 3 GB while indexing
#     documents  Paperless (OCR)              ~0.7 GB
#     browser    a personal browser per user  ~0.45 GB each, 1–3 GB while in use
#     office     Collabora (edit documents)   ~0.5 GB + ~0.1 GB per open document
#     teams      chat and calls (Matrix)      ~0.3 GB
#     odoo       Odoo ERP/CRM                 ~0.9 GB
#   The core (shell, files, mail, planner, passwords, assistant) needs about 5 GB, so
#   an 8 GB server fits the core plus one or two apps. Remembered in .env
#   (CLARAOS_OPTIONAL_APPS); a later run without --apps keeps the choice, a run with
#   --apps replaces it. Switching an app off stops its containers but keeps its data.
#   A new cell without --apps gets only the core; a cell set up before --apps
#   existed keeps everything it had (all apps except Odoo).
#
# --social: this cell also hosts the shared social cell (Mastodon + PeerTube under
#   social.<base> / video.<base>). Remembered in .env (COMPOSE_PROFILES=social), so
#   later runs keep it without the flag.
# --mcp: switch on the MCP endpoint (https://home.<domain>/mcp) so users can connect
#   their own AI agents. Off by default; remembered in .env (CLARAOS_MCP=on).
#
# Optional, set by hand in .env (never generated):
#   CLARAOS_PRODUCT_NAME    visible product name (login page, SSO buttons, titles);
#                           empty = NolaniOS
#   CLARAOS_ASSISTANT_NAME  visible name of the assistant; empty = Nolani
#   Change them before the first run — Authentik/Immich/PeerTube take the name over
#   on every run, the shell reads them from the API at startup.
#
# Idempotent: existing secrets in .env are kept, missing ones are generated.
# Important: all secrets are created HERE, on the cell, and are never printed.
#    Whoever needs one reads it from /opt/claraos/.env (0600).
set -euo pipefail
cd "$(dirname "$0")"

DOM="${1:-}"
[ -n "$DOM" ] || { echo "Aufruf: $0 <domain>   (z.B. demo.example.org)"; exit 1; }
say() { printf '\n== %s\n' "$*"; }
# --apps a,b  or  --apps=a,b
APPS_ARG=""; APPS_GESETZT=0; prev=""
for a in "$@"; do
  if [ "$prev" = --apps ]; then APPS_ARG="$a"; APPS_GESETZT=1; fi
  case "$a" in --apps=*) APPS_ARG="${a#--apps=}"; APPS_GESETZT=1 ;; esac
  prev="$a"
done
case "$APPS_ARG" in none|keine) APPS_ARG="" ;; esac
ALLE_APPS="photos documents browser office teams odoo"   # = betriebsprofil.OPTIONAL_APPS

# ── 1. .env ──────────────────────────────────────────────────────────────
say "1/12  Secrets (.env)"
umask 077
touch .env
chmod 600 .env
setv() {   # setv NAME VALUE — set only if not present yet
  grep -q "^$1=" .env || printf '%s=%s\n' "$1" "$2" >> .env
}
setz() {   # setz NAME VALUE — set or replace (only for plain values: letters, commas)
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
# Which optional apps run here (see the header)
if [ $APPS_GESETZT = 1 ]; then
  setz CLARAOS_OPTIONAL_APPS "$(echo "$APPS_ARG" | tr -d ' ')"
elif ! grep -q '^CLARAOS_OPTIONAL_APPS=' .env; then
  if grep -q '^ZELLE_DOMAIN=' .env; then setz CLARAOS_OPTIONAL_APPS photos,documents,browser,office,teams
  else setz CLARAOS_OPTIONAL_APPS ""; fi
fi
APPS=" $(sed -n 's/^CLARAOS_OPTIONAL_APPS=//p' .env | tr ',' ' ') "
for a in $APPS; do
  case " $ALLE_APPS " in *" $a "*) ;; *) echo "FEHLER: unbekannte App '$a' (erlaubt: $ALLE_APPS, none)"; exit 1 ;; esac
done
an() { case "$APPS" in *" $1 "*) return 0 ;; esac; return 1; }
rnd()    { openssl rand -hex 32; }
fernet() { openssl rand -base64 32 | tr '+/' '-_'; }
setv ZELLE_DOMAIN "$DOM"
setv AUTHENTIK_SECRET_KEY "$(openssl rand -base64 60 | tr -d '\n')"
setv AUTHENTIK_DB_PASSWORD "$(rnd)"
setv AUTHENTIK_BOOTSTRAP_EMAIL "admin@$DOM"
setv AUTHENTIK_BOOTSTRAP_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=\n')"
setv AUTHENTIK_BOOTSTRAP_TOKEN "$(rnd)"
setv AUTHENTIK_API_TOKEN "$(rnd)"
setv CLARAOS_DB_PASS "$(rnd)"
setv CLARAOS_PROXY_SECRET "$(rnd)"
setv CLARAOS_SERVICE_TOKEN "$(rnd)"
setv CLARAOS_CREDENTIAL_KEY "$(fernet)"
setv NEXTCLOUD_DB_PASSWORD "$(rnd)"
setv NEXTCLOUD_ADMIN_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=\n')"
setv COLLABORA_ADMIN_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=\n')"
setv LITELLM_DB_PASSWORD "$(rnd)"
setv LITELLM_MASTER_KEY "sk-$(rnd)"
setv WEBUI_SECRET_KEY "$(rnd)"
setv OWUI_ADMIN_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=\n')"
setv VIKUNJA_DB_PASSWORD "$(rnd)"
setv VIKUNJA_JWT_SECRET "$(rnd)"
setv VW_SSO_CLIENT_SECRET "$(rnd)"
setv STALWART_ADMIN_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=\n')"
# Secrets of ALL optional apps, also switched-off ones: random values cost nothing, and
# without them Docker Compose warns about every unset variable on every call (the
# whole compose file is interpolated, not only the active profiles).
{ # teams
  setv SYNAPSE_DB_PASSWORD "$(rnd)"
  setv SYNAPSE_REGISTRATION_SECRET "$(rnd)"
  setv SYNAPSE_MACAROON_SECRET "$(rnd)"
  setv SYNAPSE_FORM_SECRET "$(rnd)"
  setv LIVEKIT_API_KEY "API$(openssl rand -hex 6)"
  setv LIVEKIT_API_SECRET "$(rnd)"
}
{ # photos
  setv IMMICH_DB_PASSWORD "$(rnd)"
  setv IMMICH_ADMIN_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=\n')"
  setv IMMICH_OIDC_SECRET "$(rnd)"
  setv IMMICH_DEFAULT_QUOTA_GB 5      # per user; 10 users × 5 GB must fit on the disk
}
{ # documents
  setv PAPERLESS_DB_PASSWORD "$(rnd)"
  setv PAPERLESS_SECRET_KEY "$(rnd)"
  setv PAPERLESS_ADMIN_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=\n')"
  setv PAPERLESS_OIDC_SECRET "$(rnd)"
}
{ # odoo
  setv ODOO_DB_PASSWORD "$(rnd)"
  setv ODOO_MASTER_PASSWORD "$(rnd)"
  setv ODOO_ADMIN_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=\n')"
  setv ODOO_OIDC_SECRET "$(rnd)"
}
setv BROWSER_CTL_TOKEN "$(rnd)"
# Pinned image digests (tested with the browser modules in modules/).
setv BROWSER_IMAGE "lscr.io/linuxserver/chromium@sha256:92933242f71646b24d568cab82c8da1eb0838c067a281ad9dce74fe94e7d0fe1"
setv BROWSER_SOCAT_IMAGE "alpine/socat@sha256:87d88ff79bf42ca723fb360e9585c40e2923a2f4df9b9d148b127568ef6b99e7"
setv BROWSER_MAX_RUNNING 4           # browsers running at the same time (desktop + mobile count separately)
# MCP endpoint for outside agents (packages/api/services/agent_mcp.py)
case " $* " in *" --mcp "*) setv CLARAOS_MCP on ;; esac
# Shared social cell (compose profile `social`): once on, it stays on
SOCIAL=0
case " $* " in *" --social "*) SOCIAL=1 ;; esac
grep -q '^COMPOSE_PROFILES=.*social' .env && SOCIAL=1
# Compose profiles = the optional apps (+ social). Docker Compose reads them from .env.
setz COMPOSE_PROFILES "$(echo $APPS $([ $SOCIAL = 1 ] && echo social) | tr ' ' ',')"
echo "  Apps: Kern$(for a in $APPS; do printf ' + %s' "$a"; done)"
if [ $SOCIAL = 1 ]; then
  BASIS=${DOM#*.}
  setv SOCIAL_DOMAIN "social.$BASIS"
  setv VIDEO_DOMAIN "video.$BASIS"
  setv MASTODON_DB_PASSWORD "$(rnd)"
  setv MASTODON_SECRET_KEY_BASE "$(openssl rand -hex 64)"
  setv MASTODON_OTP_SECRET "$(openssl rand -hex 64)"
  setv MASTODON_AR_DETERMINISTIC_KEY "$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-32)"
  setv MASTODON_AR_KEY_DERIVATION_SALT "$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-32)"
  setv MASTODON_AR_PRIMARY_KEY "$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-32)"
  setv MASTODON_OIDC_SECRET "$(rnd)"
  setv PEERTUBE_DB_PASSWORD "$(rnd)"
  setv PEERTUBE_SECRET "$(rnd)"
  setv PEERTUBE_ROOT_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=\n')"
  setv PEERTUBE_OIDC_SECRET "$(rnd)"
  setv PEERTUBE_VIDEO_QUOTA_GB 2       # per user; transcoded copies count too
  # Web push keys: generated with Mastodon's own library, straight into .env
  if ! grep -q '^MASTODON_VAPID_PRIVATE_KEY=' .env; then
    docker run --rm --entrypoint "" ghcr.io/mastodon/mastodon@sha256:dc4312f5e90e487b5061c8fa38d2f76db5c4e4e6c65dd48b4ee76af5f2e2e526 \
      bundle exec ruby -e 'require "webpush"; k = Webpush.generate_key; puts "MASTODON_VAPID_PRIVATE_KEY=#{k.private_key}"; puts "MASTODON_VAPID_PUBLIC_KEY=#{k.public_key}"' \
      2>/dev/null | grep -E '^MASTODON_VAPID_(PRIVATE|PUBLIC)_KEY=.' >> .env || echo "  ✗ VAPID-Schlüssel nicht erzeugt"
  fi
  echo "  Social-Zelle: an (social.$BASIS, video.$BASIS)"
fi
# ANTHROPIC_API_KEY is NOT generated here — the operator pipes it into .env from their
# own password vault. Without it everything runs except the assistant chat.
grep -q '^ANTHROPIC_API_KEY=.' .env || echo "  ⚠ ANTHROPIC_API_KEY fehlt — der Assistenten-Chat bleibt stumm"
grep -q "^ZELLE_DOMAIN=$DOM$" .env || { echo "FEHLER: .env gehört zu einer anderen Domain"; exit 1; }
echo "  $(grep -c '=' .env) Einträge, Rechte $(stat -c %a .env)"

# ── 2. Services ──────────────────────────────────────────────────────────
say "2/12  Bauen und starten"
# Swap as a safety net: without it a short memory peak (backup, photo indexing, OCR)
# makes the kernel kill a process right away. Low swappiness: only used under pressure.
# Check via /proc/swaps: `swapon` lives in /sbin, not on this user's PATH — the
# check then always came back empty and the step re-ran against the active swap.
if [ "$(wc -l < /proc/swaps)" -le 1 ]; then
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "  Swap: 4 GB angelegt"
fi
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/90-claraos-swap.conf >/dev/null
sudo sysctl -q -p /etc/sysctl.d/90-claraos-swap.conf
# Personal browsers: files the browser containers mount (dashboard, relay, policies)
# from the source, plus the egress fence. Warning: `umask 077` above would make them
# unreadable for the containers — same trap as Element Call's config.json.
if an browser; then
for pair in desktop:dev-selkies-browser-next mobile:dev-selkies-browser-next-mobile; do
  ziel=browser/${pair%%:*}; quelle=src/modules/${pair#*:}
  rm -rf "$ziel" && mkdir -p "$ziel" && cp -r "$quelle/dashboard-claraos" "$quelle/relay" "$quelle/selkies" "$ziel/"
done
chmod -R a+rX browser && chmod 755 browser/firewall.sh
sudo install -m 644 browser/claraos-browser-firewall.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable claraos-browser-firewall.service >/dev/null 2>&1
sudo browser/firewall.sh | sed 's/^/  /'
for img in $(grep -E '^BROWSER_(SOCAT_)?IMAGE=' .env | cut -d= -f2); do docker pull -q "$img" >/dev/null; done
echo "  Browser: Dateien, Zaun und Images bereit"
fi
# Optional Caddy sites (caddy/aktiv/ is imported by the Caddyfile): one file per app
# that runs here — a switched-off app has no host name and asks for no certificate.
install -d -m 755 caddy/aktiv
for n in $ALLE_APPS social; do
  if an "$n" || { [ "$n" = social ] && [ $SOCIAL = 1 ]; }; then
    install -m 644 "caddy-optional/$n.caddy" "caddy/aktiv/$n.caddy"
  else rm -f "caddy/aktiv/$n.caddy"; fi
done
if an teams; then
# Synapse: generate the signing key on first run, render homeserver.yaml from the
# template (secrets from .env), owner 991 (Synapse user), mode 600.
mkdir -p synapse-data
if ! sudo test -f "synapse-data/$DOM.signing.key"; then
  docker run --rm -v "$PWD/synapse-data:/data" -e SYNAPSE_SERVER_NAME="$DOM" -e SYNAPSE_REPORT_STATS=no \
    matrixdotorg/synapse:v1.161.0 generate >/dev/null
fi
python3 - "$DOM" > /tmp/zelle-hs.yaml <<'PY'
import re, sys
env = dict(l.rstrip("\n").split("=", 1) for l in open(".env") if "=" in l and not l.startswith("#"))
env["DOM"] = sys.argv[1]
print(re.sub(r"\{\{(\w+)\}\}", lambda m: env[m.group(1)], open("synapse.yaml.tmpl").read()), end="")
PY
HS_VORHER=$(sudo md5sum synapse-data/homeserver.yaml 2>/dev/null | cut -d' ' -f1 || true)
sudo install -o 991 -g 991 -m 600 /tmp/zelle-hs.yaml synapse-data/homeserver.yaml
rm -f /tmp/zelle-hs.yaml
# Synapse reads its config only at startup — changed file ⇒ restart it after bringing things up
[ "$HS_VORHER" != "$(sudo md5sum synapse-data/homeserver.yaml | cut -d' ' -f1)" ] && SYNAPSE_NEUSTART=1
# Element Call: config.json (no secrets) from the template
# Warning: explicitly 755/644: `umask 077` (for the secrets above) would make the file
# 0600 — nginx in the container then cannot read it and, via the SPA fallback, serves
# index.html with 200 instead of the configuration.
install -d -m 755 element-call
sed "s/{{DOM}}/$DOM/g" element-call.json.tmpl > element-call/config.json
chmod 644 element-call/config.json
sudo chown -R 991:991 synapse-data
fi
docker compose build --pull
# Odoo: render its configuration (database password, master password) from .env, mode
# 600, outside the build context ./odoo. Owner = the odoo user OF THE BUILT IMAGE
# (uid 100, gid 101 in odoo:18 — a guessed 101 left the file unreadable, and Odoo
# silently fell back to its default database host "db"). Hence after the build.
if an odoo; then
  python3 - > /tmp/zelle-odoo.conf <<'PY'
import re
env = dict(l.rstrip("\n").split("=", 1) for l in open(".env") if "=" in l and not l.startswith("#"))
print(re.sub(r"\{\{(\w+)\}\}", lambda m: env[m.group(1)], open("odoo.conf.tmpl").read()), end="")
PY
  ODOO_UID=$(docker run --rm --entrypoint id claraos-odoo:zelle -u)
  ODOO_GID=$(docker run --rm --entrypoint id claraos-odoo:zelle -g)
  install -d -m 755 odoo-conf
  sudo install -o "$ODOO_UID" -g "$ODOO_GID" -m 600 /tmp/zelle-odoo.conf odoo-conf/odoo.conf
  rm -f /tmp/zelle-odoo.conf
fi
docker compose up -d --remove-orphans
# Switched-off apps: `up` leaves their containers running (they are not orphans, just
# outside the active profiles) — stop and remove them. Volumes, i.e. data, stay.
aus=$(comm -23 <(docker compose --profile '*' config --services 2>/dev/null | sort) \
               <(docker compose config --services 2>/dev/null | sort))
laeuft=$(docker compose --profile '*' ps -a --services 2>/dev/null | sort)
weg=$(comm -12 <(echo "$aus") <(echo "$laeuft") | tr '\n' ' ')
if [ -n "${weg// }" ]; then
  docker compose --profile '*' rm -sf $weg >/dev/null 2>&1
  echo "  Abgeschaltet (Daten bleiben): $weg"
fi
# Caddy does not pick up a changed Caddyfile by itself — and a reload of an invalid
# file would keep the running configuration. So validate, then reload, then verify
# that the container really sees the host's file.
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
  || { echo "  ✗ Caddyfile ungültig — nicht geladen"; exit 1; }
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1
[ "$(md5sum < caddy/Caddyfile | cut -d' ' -f1)" = "$(docker compose exec -T caddy md5sum /etc/caddy/Caddyfile | cut -d' ' -f1)" ] \
  || echo "  ✗ Caddy sieht ein anderes Caddyfile als der Host"
echo "  Caddy: Konfiguration geprüft und geladen"
if [ -n "${SYNAPSE_NEUSTART:-}" ]; then docker compose restart synapse >/dev/null 2>&1; echo "  Synapse: neue Konfiguration geladen"; fi
docker compose ps --format '  {{.Service}}: {{.State}} {{.Health}}'

# ── 3. Authentik ─────────────────────────────────────────────────────────
say "3/12  Authentik"
set -a; . ./.env; set +a
echo -n "  warte auf Authentik"
until docker compose exec -T authentik ak healthcheck >/dev/null 2>&1; do echo -n "."; sleep 5; done
echo " ok"
# Create the API token with the pre-generated value (since 2025.x
# AUTHENTIK_BOOTSTRAP_TOKEN no longer does this). The value enters the container
# via the environment and is never printed.
docker compose exec -T -e AUTHENTIK_API_TOKEN authentik ak shell >/dev/null <<'PY'
import os
from authentik.core.models import Token, TokenIntents, User
u = User.objects.get(username="akadmin")
t, _ = Token.objects.update_or_create(
    identifier="claraos-zelle-api",
    defaults={"user": u, "intent": TokenIntents.INTENT_API, "expiring": False,
              "key": os.environ["AUTHENTIK_API_TOKEN"]},
)
PY
# Login providers only for the apps that run here (a provider without a secret is skipped)
an photos || IMMICH_OIDC_SECRET=
an documents || PAPERLESS_OIDC_SECRET=
an odoo || ODOO_OIDC_SECRET=
AUTHENTIK_API_URL=http://127.0.0.1:9000/api/v3 \
  docker compose exec -T -e AUTHENTIK_API_TOKEN -e ZELLE_DOMAIN -e AUTHENTIK_API_URL -e VW_SSO_CLIENT_SECRET \
  -e IMMICH_OIDC_SECRET -e PAPERLESS_OIDC_SECRET -e ODOO_OIDC_SECRET -e CLARAOS_PRODUCT_NAME \
  -e SOCIAL_DOMAIN -e VIDEO_DOMAIN -e MASTODON_OIDC_SECRET -e PEERTUBE_OIDC_SECRET \
  authentik python3 - < bootstrap_authentik.py

# ── 4. Database schema ───────────────────────────────────────────────────
# schema.sql and the migrations are not applied automatically by the API.
# Here: in order, reporting errors per file instead of aborting —
# some migrations depend on tables that routers only create at startup.
say "4/12  Datenbank-Schema"
PSQL="docker compose exec -T clara-users-postgres psql -q -U clara -d clara_users -v ON_ERROR_STOP=1"
# Record what has been applied: not every migration is written to be re-runnable
# (037 creates a policy without IF NOT EXISTS) — otherwise a second run would report
# spurious errors.
echo "CREATE TABLE IF NOT EXISTS zelle_schema_log (datei TEXT PRIMARY KEY, eingespielt TIMESTAMPTZ DEFAULT NOW());" | $PSQL >/dev/null
ok=0; fail=0; skip=0
for f in src/packages/api/schema.sql src/packages/api/migrations/*.sql; do
  b=$(basename "$f")
  # Deliberately skipped in the cell: requires the approval table (confirm router,
  # assistants/clara-agent), which does not exist here.
  case "$b" in 025_assistant_proposals.sql) skip=$((skip+1)); continue;; esac
  if [ "$($PSQL -tAc "SELECT 1 FROM zelle_schema_log WHERE datei='$b'")" = "1" ]; then
    skip=$((skip+1)); continue
  fi
  if $PSQL < "$f" >/dev/null 2>/tmp/zelle-mig.err; then
    ok=$((ok+1)); echo "INSERT INTO zelle_schema_log (datei) VALUES ('$b') ON CONFLICT DO NOTHING;" | $PSQL >/dev/null
  else
    fail=$((fail+1)); echo "  ✗ $b: $(head -c 160 /tmp/zelle-mig.err | tr '\n' ' ')"
  fi
done
rm -f /tmp/zelle-mig.err
echo "  Schema: $ok neu, $skip schon da, $fail mit Fehlern"
docker compose restart claraos-api >/dev/null

# ── 5. Nextcloud ─────────────────────────────────────────────────────────
say "5/12  Nextcloud"
OCC="docker compose exec -T -u www-data nextcloud php occ"
echo -n "  warte auf Installation"
until $OCC status --output=json 2>/dev/null | grep -q '"installed":true'; do echo -n "."; sleep 5; done
echo " ok"
$OCC config:system:set overwriteprotocol --value=https >/dev/null
$OCC config:system:set overwrite.cli.url --value="https://nextcloud.$DOM" >/dev/null
$OCC config:system:set default_phone_region --value=DE >/dev/null
$OCC config:system:set maintenance_window_start --type=integer --value=1 >/dev/null
# The API talks to Nextcloud internally as `nextcloud`; otherwise Nextcloud blocks
# server-side requests to internal names ("violates local access rules").
$OCC config:system:set allow_local_remote_servers --type=boolean --value=true >/dev/null
$OCC background:cron >/dev/null
for app in calendar contacts groupfolders; do
  $OCC app:list --output=json 2>/dev/null | grep -q "\"$app\"" \
    && $OCC app:enable "$app" >/dev/null 2>&1 \
    || $OCC app:install "$app" >/dev/null 2>&1 || echo "  ✗ App $app"
done
echo "  Apps: $($OCC app:list --output=json 2>/dev/null | python3 -c 'import sys,json;e=json.load(sys.stdin)["enabled"];print(", ".join(a for a in ("calendar","contacts","groupfolders") if a in e))')"
# Credentials: clara.bot (Teams administration, NC admin) + all existing Authentik users
# of the group clara-admins. Demo users are set up later by the invitation flow.
docker compose exec -T -e NEXTCLOUD_ADMIN_USER=ncadmin -e NEXTCLOUD_ADMIN_PASSWORD \
  claraos-api python3 - clara.bot:admin ${ZELLE_NUTZER:-${ZELLE_NC_NUTZER:-}} < provision_nc.py

# ── 6. Assistant (Open WebUI + LiteLLM) ────────────────────────────────────
say "6/12  Assistenten-Chat"
# The key goes straight into .env via $(…) — never into any output.
KEY=$(docker compose exec -T -e OWUI_ADMIN_PASSWORD -e ZELLE_DOMAIN claraos-api \
      python3 - < owui_bootstrap.py | sed -n 's/^OWUI_KEY=//p')
if [ -n "$KEY" ]; then
  if grep -q '^OPENWEBUI_API_KEY=' .env; then
    sed -i "s|^OPENWEBUI_API_KEY=.*|OPENWEBUI_API_KEY=$KEY|" .env
  else
    printf 'OPENWEBUI_API_KEY=%s\n' "$KEY" >> .env
  fi
  unset KEY
  docker compose up -d claraos-api >/dev/null   # pick up the new key
  echo "  Open-WebUI-Schlüssel in .env, API neu gestartet"
  NUTZER_OW="${ZELLE_NUTZER:-${ZELLE_NC_NUTZER:-}}"
  if [ -n "$NUTZER_OW" ]; then
    sleep 5
    docker compose exec -T claraos-api python3 - $NUTZER_OW < provision_owui.py
  fi
else
  echo "  ✗ Open-WebUI-Schlüssel nicht erhalten"
fi

# ── 7. Planner (Vikunja) ─────────────────────────────────────────────────
say "7/12  Planner"
echo -n "  warte auf Vikunja"
vk_ok=0
for _ in $(seq 1 60); do   # at most 5 minutes — a broken service must not block forever
  if docker compose exec -T claraos-api python3 -c "import httpx,sys;sys.exit(0 if httpx.get('http://vikunja:3456/health',timeout=5).status_code==200 else 1)" 2>/dev/null; then vk_ok=1; break; fi
  echo -n "."; sleep 5
done
if [ $vk_ok = 1 ]; then echo " ok"; else echo " ✗ Vikunja nicht bereit — docker compose logs vikunja"; fi
NUTZER="${ZELLE_NUTZER:-${ZELLE_NC_NUTZER:-}}"
[ -n "$NUTZER" ] && [ $vk_ok = 1 ] && docker compose exec -T -e ZELLE_DOMAIN -e CLARAOS_PRODUCT_NAME claraos-api python3 - $NUTZER < provision_vikunja.py

# ── 8. Mail (Stalwart) ───────────────────────────────────────────────────
say "8/12  Post"
if [ -n "$NUTZER" ]; then ./provision_mail.sh $NUTZER; fi

# ── 9. Teams (Matrix) ────────────────────────────────────────────────────
say "9/12  Teams"
if ! an teams; then echo "  aus (--apps teams)"; else
mx_ok=0
for _ in $(seq 1 60); do
  if docker compose exec -T claraos-api python3 -c "import httpx,sys;sys.exit(0 if httpx.get('http://synapse:8008/health',timeout=5).status_code==200 else 1)" 2>/dev/null; then mx_ok=1; break; fi
  sleep 5
done
if [ $mx_ok = 1 ]; then
  docker compose exec -T -e SYNAPSE_REGISTRATION_SECRET -e ZELLE_DOMAIN claraos-api \
    python3 - $NUTZER < provision_matrix.py
else
  echo "  ✗ Synapse nicht bereit — docker compose logs synapse"
fi
fi

# ── 10. Photos (Immich) ──────────────────────────────────────────────────
say "10/12  Fotos"
if ! an photos; then echo "  aus (--apps photos)"; else
# Same pattern as Open WebUI: a new key goes straight into .env via $(…), never into output.
KEY=$(docker compose exec -T -e IMMICH_ADMIN_PASSWORD -e IMMICH_API_KEY -e IMMICH_OIDC_SECRET \
      -e IMMICH_DEFAULT_QUOTA_GB -e ZELLE_DOMAIN -e CLARAOS_PRODUCT_NAME claraos-api python3 - < provision_immich.py \
      | sed -n 's/^IMMICH_KEY=//p') || echo "  ✗ Immich nicht eingerichtet — docker compose logs immich-server"
if [ -n "${KEY:-}" ]; then
  if grep -q '^IMMICH_API_KEY=' .env; then
    sed -i "s|^IMMICH_API_KEY=.*|IMMICH_API_KEY=$KEY|" .env
  else
    printf 'IMMICH_API_KEY=%s\n' "$KEY" >> .env
  fi
  echo "  Immich-Schlüssel in .env"
fi
unset KEY
fi

# ── 11. Documents (Paperless) ────────────────────────────────────────────
say "11/12  Dokumente"
if ! an documents; then echo "  aus (--apps documents)"; else
pl_ok=0
for _ in $(seq 1 60); do   # first start runs migrations — takes a minute or two
  if docker compose exec -T -u paperless paperless python3 manage.py check >/dev/null 2>&1; then pl_ok=1; break; fi
  sleep 5
done
if [ $pl_ok = 1 ]; then
  docker compose exec -T -u paperless paperless python3 manage.py shell < provision_paperless.py 2>/dev/null \
    | grep ^PAPERLESS_ || echo "  ✗ Paperless-Gruppe nicht angelegt"
else
  echo "  ✗ Paperless nicht bereit — docker compose logs paperless"
fi
fi

# ── Odoo (only with --apps odoo) ─────────────────────────────────────────
if an odoo; then
  say "Odoo"
  # First run: create the database with the modules the login needs. The server is
  # stopped meanwhile so it does not load a half-built database.
  stand=$(docker compose exec -T odoo-db psql -U odoo -d odoo -tAc \
          "SELECT state FROM ir_module_module WHERE name='auth_oidc'" 2>/dev/null || true)
  if [ "$stand" != installed ]; then
    echo "  Datenbank anlegen (einige Minuten) …"
    docker compose stop odoo >/dev/null 2>&1
    if docker compose run --rm -T odoo odoo -c /etc/odoo/odoo.conf -d odoo \
         -i base,auth_oidc,contacts --load-language=de_DE --stop-after-init --no-http \
         >/dev/null 2>/tmp/zelle-odoo.err; then
      echo "  Odoo: Datenbank angelegt (Kontakte + Anmeldung über ${CLARAOS_PRODUCT_NAME:-NolaniOS})"
    else
      echo "  ✗ Odoo-Datenbank: $(tail -c 300 /tmp/zelle-odoo.err | tr '\n' ' ')"
    fi
    rm -f /tmp/zelle-odoo.err
    docker compose up -d odoo >/dev/null 2>&1
  fi
  docker compose exec -T -e ZELLE_DOMAIN -e ODOO_OIDC_SECRET -e ODOO_ADMIN_PASSWORD -e CLARAOS_PRODUCT_NAME \
    odoo odoo shell -c /etc/odoo/odoo.conf -d odoo --no-http < provision_odoo.py 2>/dev/null \
    | sed -n 's/^ODOO /  /p' | grep . || echo "  ✗ Odoo nicht eingerichtet — docker compose logs odoo"
fi

# ── Social cell (only with --social) ─────────────────────────────────────
if [ $SOCIAL = 1 ]; then
  say "Social-Zelle"
  # Mastodon: schema (idempotent), then the instance settings
  docker compose run --rm -T mastodon-web bundle exec rails db:prepare >/dev/null 2>&1 \
    && echo "  Mastodon: Datenbank bereit" || echo "  ✗ Mastodon db:prepare — docker compose logs mastodon-web"
  docker compose up -d mastodon-web mastodon-sidekiq mastodon-streaming >/dev/null 2>&1
  # tootctl needs a running web container — right after (re)creation it is still booting
  for _ in $(seq 1 60); do
    docker compose exec -T claraos-api python3 -c "import httpx,sys;sys.exit(0 if httpx.get('http://mastodon-web:3000/health',timeout=5).status_code==200 else 1)" 2>/dev/null && break
    sleep 5
  done
  docker compose exec -T mastodon-web bin/tootctl settings registrations close >/dev/null 2>&1 \
    && echo "  Mastodon: Selbstregistrierung zu (Konten nur über ${CLARAOS_PRODUCT_NAME:-NolaniOS}-Anmeldung)"
  [ -n "${SOCIAL_OWNER:-}" ] && docker compose exec -T mastodon-web bin/tootctl accounts modify "$SOCIAL_OWNER" --role Owner >/dev/null 2>&1 \
    && echo "  Mastodon: $SOCIAL_OWNER ist Eigentümer"
  # PeerTube: OIDC plugin + instance settings (signup off, federation by approval, quota)
  pt_ok=0
  for _ in $(seq 1 60); do
    if docker compose exec -T claraos-api python3 -c "import httpx,sys;sys.exit(0 if httpx.get('http://peertube:9000/api/v1/ping',timeout=5).status_code==200 else 1)" 2>/dev/null; then pt_ok=1; break; fi
    sleep 5
  done
  if [ $pt_ok = 1 ]; then
    if ! docker compose exec -T peertube test -d /data/plugins/node_modules/peertube-plugin-auth-openid-connect; then
      docker compose exec -T peertube npm run plugin:install -- --npm-name peertube-plugin-auth-openid-connect >/dev/null 2>&1 \
        && echo "  PeerTube: OIDC-Plugin installiert"
      # Installed via CLI, the running server only loads the plugin after a restart —
      # without it the settings go nowhere ("Cannot find plugin … on settings changed").
      docker compose restart peertube >/dev/null 2>&1
      for _ in $(seq 1 60); do
        docker compose exec -T claraos-api python3 -c "import httpx,sys;sys.exit(0 if httpx.get('http://peertube:9000/api/v1/ping',timeout=5).status_code==200 else 1)" 2>/dev/null && break
        sleep 5
      done
    fi
    docker compose exec -T -e PEERTUBE_ROOT_PASSWORD -e PEERTUBE_OIDC_SECRET -e PEERTUBE_VIDEO_QUOTA_GB \
      -e ZELLE_DOMAIN -e VIDEO_DOMAIN -e CLARAOS_PRODUCT_NAME claraos-api python3 - < provision_peertube.py
  else
    echo "  ✗ PeerTube nicht bereit — docker compose logs peertube"
  fi
fi

# ── 12. Backup ───────────────────────────────────────────────────────────
say "12/12  Sicherung"
sudo install -m 644 claraos-backup.service claraos-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claraos-backup.timer >/dev/null 2>&1
echo "  Timer: $(systemctl list-timers claraos-backup.timer --no-legend | awk '{print $1, $2, $3}')"

say "Fertig"
echo "  Shell:     https://home.$DOM"
echo "  Anmeldung: https://auth.$DOM  (Admin akadmin — Passwort: AUTHENTIK_BOOTSTRAP_PASSWORD in .env)"
an odoo && echo "  Odoo:      https://odoo.$DOM  (Verwaltung: admin — Passwort: ODOO_ADMIN_PASSWORD in .env)"
echo "  Apps:      Kern$(for a in $APPS; do printf ' + %s' "$a"; done)"
aus_apps=$(for a in $ALLE_APPS; do an "$a" || printf '%s ' "$a"; done)
[ -n "$aus_apps" ] && echo "  Nicht an:  $aus_apps— zuschalten mit ./setup.sh $DOM --apps <liste>"
true
