#!/usr/bin/env python3
"""Personal browsers of a cell — create, start, stop, measure, remove.

The only component of the cell with the Docker socket besides the operator. It is
therefore deliberately narrow:
  * reachable only on the internal cell network (no published port), own token
    (BROWSER_CTL_TOKEN — NOT the API's service token), constant-time comparison;
  * acts only on names it builds itself from a validated user name:
      ubd-<user> / ubm-<user>    desktop / mobile browser
      ubdc-<user> / ubmc-<user>  CDP forwarders (socat in the browser's netns)
      ubnet-<user>               the user's own network
    Different prefixes instead of a "-m" suffix: otherwise user "bob-m" would get
    the mobile browser of user "bob".
  * every user's browser lives in its OWN network that only Caddy and the API
    join. Browsers cannot see each other (CDP/relay of another user) nor the
    cell's services; firewall.sh additionally blocks private ranges and the
    cloud metadata service for the subnet pool.
  * no service token goes into a browser container — only the user's own narrow
    upload key (routers/browser_ablage.py), which can put files into THAT user's
    download folder and nothing else. The API hands it over with /ensure.

API (JSON, header X-Browser-Ctl-Token):
  GET  /healthz
  POST /ensure  {user, form, upload_key}   create if missing, then start; 429 when busy
  POST /stop    {user, form}
  POST /remove  {user}         containers, profiles and network — for deleted accounts
  GET  /running                running browsers with an activity flag (open connections)
  POST /zugang  {user, app}    Clara's per-user access to an app that has no admin API
                               for it (mastodon, immich): returns {"token"}; see zugang_*()
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import os
import re
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("BROWSER_CTL_TOKEN", "")
PORT = int(os.environ.get("BROWSER_CTL_PORT", "8199"))
IMAGE = os.environ["BROWSER_IMAGE"]
SOCAT = os.environ["BROWSER_SOCAT_IMAGE"]
FILES = os.environ.get("BROWSER_FILES", "/opt/claraos/browser")      # HOST path
API_URL = os.environ.get("BROWSER_API_URL", "")                       # as seen from a browser
JOIN = [c for c in os.environ.get("BROWSER_JOIN", "").split(",") if c]
MAX_RUNNING = int(os.environ.get("BROWSER_MAX_RUNNING", "4"))
SUBNET = os.environ.get("BROWSER_SUBNET_PREFIX", "10.250")             # /16 pool, one /24 per user
TZ = os.environ.get("TZ", "Europe/Berlin")
CDP_PORT = 9223
USER_RE = re.compile(r"^[a-z][a-z0-9._-]{1,31}$")    # = user_admin._USERNAME_RE
LOCK = threading.Lock()   # creation and the slot count must not race

COMMON_ENV = {
    "PUID": "1000", "PGID": "1000", "TZ": TZ,
    "CUSTOM_PORT": "3000", "CUSTOM_HTTPS_PORT": "3001",
    "NO_DECOR": "1", "RESTART_APP": "true", "HARDEN_DESKTOP": "true",
    "SELKIES_COMMAND_ENABLED": "false",           # cmd,<shell> messages = shell in the container
    "SELKIES_UI_SHOW_SIDEBAR": "false", "SELKIES_UI_SHOW_LOGO": "false",
    "SELKIES_UI_SHOW_CORE_BUTTONS": "false",
    "PULSE_SERVER": "unix:/defaults/native",
    "CLARAOS_DOWNLOAD_TARGET": "/Downloads/Clara Browser",
}
FORMS = {
    "desktop": {
        "prefix": "ubd", "cdp": "ubdc", "dir": "desktop", "mem": os.environ.get("BROWSER_MEM_DESKTOP", "2g"),
        "env": {"TITLE": "Browser",
                "CHROME_CLI": "--remote-debugging-port=9222 https://start.duckduckgo.com",
                "SELKIES_USE_BROWSER_CURSORS": "true"},
        "mounts": [
            ("selkies/policies.json", "/etc/chromium/policies/managed/policies.json"),
            ("dashboard-claraos/index.html", "/usr/share/selkies/selkies-dashboard/index.html"),
            ("dashboard-claraos/claraos-bridge.js", "/usr/share/selkies/selkies-dashboard/src/claraos-bridge.js"),
            ("dashboard-claraos/claraos-fixes.js", "/usr/share/selkies/selkies-dashboard/src/claraos-fixes.js"),
            ("dashboard-claraos/claraos-desktop-ui.js", "/usr/share/selkies/selkies-dashboard/src/claraos-desktop-ui.js"),
            ("selkies/pulse-fix-init.sh", "/custom-cont-init.d/10-pulse-fix.sh"),
            ("selkies/chromium-frame-init.sh", "/custom-cont-init.d/20-chromium-frame.sh"),
            ("selkies/labwc-fix-window.sh", "/custom-cont-init.d/21-labwc-fix-window.sh"),
            ("selkies/wlrctl-init.sh", "/custom-cont-init.d/22-wlrctl.sh"),
            ("selkies/autostart-wayland.sh", "/defaults/autostart_wayland"),
            ("relay/claraos-cdp-relay.py", "/claraos/claraos-cdp-relay.py"),
            ("relay/human_input.py", "/claraos/human_input.py"),
            ("relay/svc-claraos-cdp-relay", "/custom-services.d/claraos-cdp-relay"),
        ],
    },
    "mobile": {
        "prefix": "ubm", "cdp": "ubmc", "dir": "mobile", "mem": os.environ.get("BROWSER_MEM_MOBILE", "1536m"),
        "env": {"TITLE": "Browser Mobil",
                # DSF 2.16 = 1080/500: Chromium's 500 CSS px window minimum (see the module).
                "CHROME_CLI": "--kiosk --remote-debugging-port=9222 --force-device-scale-factor=2.16 "
                              "https://start.duckduckgo.com",
                "SELKIES_USE_CSS_SCALING": "false", "CLARAOS_MOBILE_PROFILE": "1"},
        "mounts": [
            ("selkies/policies.json", "/etc/chromium/policies/managed/policies.json"),
            ("dashboard-claraos/index.html", "/usr/share/selkies/selkies-dashboard/index.html"),
            ("dashboard-claraos/claraos-config.js", "/usr/share/selkies/selkies-dashboard/src/claraos-config.js"),
            ("dashboard-claraos/claraos-bridge.js", "/usr/share/selkies/selkies-dashboard/src/claraos-bridge.js"),
            ("dashboard-claraos/claraos-touch-cdp.js", "/usr/share/selkies/selkies-dashboard/src/claraos-touch-cdp.js"),
            ("relay/claraos-cdp-relay.py", "/claraos/claraos-cdp-relay.py"),
            ("relay/svc-claraos-cdp-relay", "/custom-services.d/claraos-cdp-relay"),
            ("selkies/pulse-fix-init.sh", "/custom-cont-init.d/10-pulse-fix.sh"),
            ("selkies/autostart-wayland.sh", "/defaults/autostart_wayland"),
        ],
    },
}


def docker(*args: str, check: bool = True) -> str:
    r = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=120)
    if check and r.returncode != 0:
        raise RuntimeError(f"docker {args[0]}: {r.stderr.strip()[:300]}")
    return r.stdout.strip()


def state(name: str) -> str:
    """'running', 'exited', … or '' if the container does not exist."""
    return docker("inspect", "-f", "{{.State.Status}}", name, check=False)


def running_browsers() -> list[str]:
    out = docker("ps", "--filter", "label=claraos.browser.form", "--format", "{{.Names}}")
    return [n for n in out.splitlines() if n]


def net(user: str) -> str:
    return f"ubnet-{user}"


def ensure_network(user: str) -> None:
    name = net(user)
    if not docker("network", "ls", "-q", "--filter", f"name=^{name}$"):
        used = set()
        for n in docker("network", "ls", "--filter", "label=claraos.browser.net",
                        "--format", "{{.Name}}").splitlines():
            sub = docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", n, check=False)
            if sub.startswith(SUBNET + "."):
                used.add(int(sub.split(".")[2]))
        free = next((i for i in range(1, 255) if i not in used), None)
        if free is None:
            raise RuntimeError("kein freies Browser-Subnetz")
        docker("network", "create", "--driver", "bridge", "--subnet", f"{SUBNET}.{free}.0/24",
               "--label", "claraos.browser.net=1", "--label", f"claraos.browser.user={user}", name)
    join_all()


def join_all() -> None:
    """Caddy and the API must be in every browser network. A recreated Caddy/API
    container (setup.sh, updates) loses these attachments — so reconcile always."""
    nets = [n for n in docker("network", "ls", "--filter", "label=claraos.browser.net",
                              "--format", "{{.Name}}").splitlines() if n]
    for ctr in JOIN:
        have = docker("inspect", "-f", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
                      ctr, check=False).split()
        for n in nets:
            if n not in have:
                # Lowest gateway priority: the container's default route must stay on the
                # cell network. Otherwise Docker may route Caddy's/the API's outbound
                # traffic (e.g. to the brain on the private network) through a browser
                # network — where firewall.sh drops everything private.
                docker("network", "connect", "--gw-priority", "-1", n, ctr)


def create(user: str, form: str, upload_key: str) -> None:
    f = FORMS[form]
    name, cdp = f"{f['prefix']}-{user}", f"{f['cdp']}-{user}"
    args = ["run", "-d", "--name", name, "--hostname", name, "--network", net(user),
            "--label", f"claraos.browser.form={form}", "--label", f"claraos.browser.user={user}",
            "--restart", "no",                       # lifecycle belongs to the reaper
            "--security-opt", "seccomp=unconfined", "--shm-size", "1g", "--memory", f["mem"],
            "--pids-limit", "2048",
            "--health-cmd", "curl -fsS http://localhost:3000/ >/dev/null 2>&1 || exit 1",
            "--health-interval", "30s", "--health-start-period", "40s",
            "-v", f"{f['prefix']}-{user}:/config"]
    extra = {"CLARAOS_API_URL": API_URL, "CLARAOS_UPLOAD_KEY": upload_key} \
        if API_URL and upload_key.startswith(user + ".") else {}
    for k, v in {**COMMON_ENV, **f["env"], **extra}.items():
        args += ["-e", f"{k}={v}"]
    for src, dst in f["mounts"]:
        args += ["-v", f"{FILES}/{f['dir']}/{src}:{dst}:ro"]
    docker(*args, IMAGE)
    # Headful Chromium binds CDP to 127.0.0.1 only; the forwarder shares the netns and
    # exposes it as <name>:9223 — inside the user's network only (Caddy never routes it).
    docker("run", "-d", "--name", cdp, "--network", f"container:{name}", "--restart", "no",
           "--label", f"claraos.browser.user={user}", "--memory", "32m",
           SOCAT, f"tcp-listen:{CDP_PORT},fork,reuseaddr", "tcp:127.0.0.1:9222")


def start(user: str, form: str) -> None:
    f = FORMS[form]
    name, cdp = f"{f['prefix']}-{user}", f"{f['cdp']}-{user}"
    docker("start", name)
    # The forwarder hangs in a dead netns after its browser restarts ("Up" but deaf):
    # restart it every time together with the browser.
    docker("restart", "-t", "1", cdp, check=False) if state(cdp) else None


def ensure(user: str, form: str, upload_key: str = "") -> tuple[int, dict]:
    f = FORMS[form]
    name = f"{f['prefix']}-{user}"
    with LOCK:
        st = state(name)
        if st == "running":
            join_all()
            return 200, {"ok": True, "state": "running"}
        if len(running_browsers()) >= MAX_RUNNING:
            return 429, {"ok": False, "reason": "busy", "max": MAX_RUNNING}
        ensure_network(user)
        if not st:
            create(user, form, upload_key)
            return 200, {"ok": True, "state": "created"}
        start(user, form)
        return 200, {"ok": True, "state": "started"}


def stop(user: str, form: str) -> None:
    f = FORMS[form]
    docker("stop", "-t", "10", f"{f['cdp']}-{user}", check=False)
    docker("stop", "-t", "20", f"{f['prefix']}-{user}", check=False)


def remove(user: str) -> None:
    for f in FORMS.values():
        docker("rm", "-f", f"{f['cdp']}-{user}", f"{f['prefix']}-{user}", check=False)
        docker("volume", "rm", f"{f['prefix']}-{user}", check=False)
    for ctr in JOIN:
        docker("network", "disconnect", "-f", net(user), ctr, check=False)
    docker("network", "rm", net(user), check=False)


def active(name: str) -> bool:
    """Is anybody connected? Established TCP connections on the stream (3000) or the
    relay (9226) — read from the container's own /proc, no tools needed in the image.
    Opening the tile is not enough as a signal: a user may stream for hours without
    touching the API, and must not be cut off after 30 minutes."""
    out = docker("exec", name, "cat", "/proc/net/tcp", "/proc/net/tcp6", check=False)
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) > 3 and parts[3] == "01" and parts[1].rsplit(":", 1)[-1] in ("0BB8", "240A"):
            return True
    return False


# ── Clara's per-user app access ──────────────────────────────────────────────
# Mastodon has no admin API to issue a token for another user — only from inside
# (rails). Never `docker exec` into mastodon-web: a rails boot needs ~400 MB and the
# web container runs close to its limit (an OOM kill takes the instance down). A
# one-shot container from the same image with its own limit instead.
MASTODON_CTR = os.environ.get("ZUGANG_MASTODON_CTR", "")
# The user is passed as an environment variable, never interpolated into the code.
# Only existing local accounts WITHOUT a role (no moderator/admin/owner), found by
# the OIDC identity (uid = ClaraOS user name; Mastodon's own user name is normalised).
# Scopes: read + posting; follows, settings, account changes stay with the user.
# An earlier token of this app for the same user is revoked first.
MASTODON_RUBY = r"""
uid = ENV.fetch("CLARA_USER")
ident = Identity.find_by(provider: "openid_connect", uid: uid)
user = ident&.user
abort("KEIN_KONTO") unless user && user.account&.local? && !user.account.suspended? && user.approved?
abort("PRIVILEGIERT") unless user.role_id.nil?
scopes = "read write:statuses write:favourites write:media"
app = Doorkeeper::Application.find_or_create_by!(name: "ClaraOS Clara") do |a|
  a.redirect_uri = "urn:ietf:wg:oauth:2.0:oob"
  a.scopes = scopes
end
Doorkeeper::AccessToken.where(application_id: app.id, resource_owner_id: user.id, revoked_at: nil).find_each(&:revoke)
t = Doorkeeper::AccessToken.create!(application_id: app.id, resource_owner_id: user.id, scopes: scopes)
puts "CLARA_TOKEN=" + (t.respond_to?(:plaintext_token) && t.plaintext_token ? t.plaintext_token : t.token)
"""


def zugang_mastodon(user: str) -> tuple[int, dict]:
    if not MASTODON_CTR or state(MASTODON_CTR) != "running":
        return 404, {"ok": False, "reason": "no_app"}
    image = docker("inspect", "-f", "{{.Image}}", MASTODON_CTR)
    netz = docker("inspect", "-f", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
                  MASTODON_CTR).split()[0]
    env = json.loads(docker("inspect", "-f", "{{json .Config.Env}}", MASTODON_CTR))
    # The web container's configuration (database, keys) goes through a 0600 file
    # that only lives for this call — never on a command line (visible in `ps`).
    with tempfile.NamedTemporaryFile("w", prefix="zugang-", suffix=".env", delete=True) as f:
        os.chmod(f.name, 0o600)
        f.write("\n".join(e for e in env if "\n" not in e) + "\n")
        f.flush()
        r = subprocess.run(["docker", "run", "--rm", "--network", netz, "--memory", "768m",
                            "--env-file", f.name, "-e", f"CLARA_USER={user}",
                            image, "bin/rails", "runner", MASTODON_RUBY],
                           capture_output=True, text=True, timeout=240)
    for line in r.stdout.splitlines():
        if line.startswith("CLARA_TOKEN="):
            return 200, {"ok": True, "token": line.split("=", 1)[1].strip()}
    grund = "KEIN_KONTO" if "KEIN_KONTO" in r.stderr else "PRIVILEGIERT" if "PRIVILEGIERT" in r.stderr else "fehler"
    if grund == "fehler":
        # stderr can quote configuration on a crash — only the last line, cut short
        print(f"zugang mastodon: exit {r.returncode}: {(r.stderr.strip().splitlines() or [''])[-1][:160]}",
              flush=True)
    return (409 if grund != "fehler" else 500), {"ok": False, "reason": grund}


# Immich (3.x) has no admin API to issue a key for another user and password login is
# off in a cell. A key is a row in its own database: SHA-256 of the secret (raw bytes)
# plus a permission list. Read-only for Clara: no upload, delete, share or edit.
# The account is matched by storage label (= ClaraOS user name, set by the OIDC login).
IMMICH_DB_CTR = os.environ.get("ZUGANG_IMMICH_DB_CTR", "")
IMMICH_RECHTE = ["asset.read", "asset.view", "asset.statistics", "album.read",
                 "person.read", "timeline.read"]
_IMMICH_KONTO = """SELECT CASE WHEN count(*) = 0 THEN 'KEIN_KONTO'
                          WHEN bool_or("isAdmin") THEN 'PRIVILEGIERT' ELSE 'OK' END
                   FROM "user" WHERE "storageLabel" = :'u' AND "deletedAt" IS NULL AND status = 'active';"""
_IMMICH_SCHLUESSEL = """BEGIN;
DELETE FROM api_key WHERE name = 'ClaraOS Clara' AND "userId" IN
  (SELECT id FROM "user" WHERE "storageLabel" = :'u');
INSERT INTO api_key (name, key, "userId", permissions)
  SELECT 'ClaraOS Clara', decode(:'h', 'hex'), id, string_to_array(:'r', ',')::varchar[]
  FROM "user" WHERE "storageLabel" = :'u' AND "deletedAt" IS NULL AND status = 'active'
                AND NOT "isAdmin";
COMMIT;"""


def _immich_sql(sql: str, **var: str) -> str:
    # Values only as psql variables (:'name' quotes them) — never put into the SQL text.
    args = ["exec", "-i", IMMICH_DB_CTR, "psql", "-U", "immich", "-d", "immich", "-tA",
            "-v", "ON_ERROR_STOP=1"]
    for k, v in var.items():
        args += ["-v", f"{k}={v}"]
    r = subprocess.run(["docker", *args], input=sql, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"immich-db: {r.stderr.strip()[:200]}")
    return r.stdout.strip()


def zugang_immich(user: str) -> tuple[int, dict]:
    if not IMMICH_DB_CTR or state(IMMICH_DB_CTR) != "running":
        return 404, {"ok": False, "reason": "no_app"}
    grund = _immich_sql(_IMMICH_KONTO, u=user)
    if grund != "OK":
        return 409, {"ok": False, "reason": grund}
    geheim = secrets.token_urlsafe(32)
    _immich_sql(_IMMICH_SCHLUESSEL, u=user, h=hashlib.sha256(geheim.encode()).hexdigest(),
                r=",".join(IMMICH_RECHTE))
    return 200, {"ok": True, "token": geheim}


ZUGAENGE = {"mastodon": zugang_mastodon, "immich": zugang_immich}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _auth(self) -> bool:
        got = self.headers.get("X-Browser-Ctl-Token", "")
        if not TOKEN or not hmac.compare_digest(got, TOKEN):
            self._send(401, {"ok": False})
            return False
        return True

    def _body(self) -> tuple[str, str, str]:
        n = int(self.headers.get("Content-Length") or 0)
        d = json.loads(self.rfile.read(n) or b"{}")
        user, form = str(d.get("user", "")), str(d.get("form", "desktop"))
        if not USER_RE.match(user) or form not in FORMS:
            raise ValueError("ungültiger Nutzer oder Form")
        return user, form, str(d.get("upload_key", ""))

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            return self._send(200, {"ok": True})
        if not self._auth():
            return
        if self.path == "/running":
            join_all()
            out = []
            for name in running_browsers():
                prefix, _, user = name.partition("-")
                form = "mobile" if prefix == "ubm" else "desktop"
                out.append({"user": user, "form": form, "active": active(name)})
            return self._send(200, {"ok": True, "running": out, "max": MAX_RUNNING})
        self._send(404, {"ok": False})

    def do_POST(self) -> None:  # noqa: N802
        if not self._auth():
            return
        try:
            if self.path == "/zugang":
                n = int(self.headers.get("Content-Length") or 0)
                d = json.loads(self.rfile.read(n) or b"{}")
                user, app = str(d.get("user", "")), str(d.get("app", ""))
                if not USER_RE.match(user) or app not in ZUGAENGE:
                    raise ValueError("ungültiger Nutzer oder App")
                return self._send(*ZUGAENGE[app](user))
            user, form, upload_key = self._body()
            if self.path == "/ensure":
                return self._send(*ensure(user, form, upload_key))
            if self.path == "/stop":
                stop(user, form)
                return self._send(200, {"ok": True})
            if self.path == "/remove":
                remove(user)
                return self._send(200, {"ok": True})
            self._send(404, {"ok": False})
        except ValueError as exc:
            self._send(400, {"ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001 — report, never crash the service
            self._send(500, {"ok": False, "error": str(exc)[:300]})

    def log_message(self, fmt: str, *args) -> None:  # one line per request, no bodies
        print(f"{self.command} {self.path} -> {args[1] if len(args) > 1 else ''}", flush=True)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("BROWSER_CTL_TOKEN fehlt")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
