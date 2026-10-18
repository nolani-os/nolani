"""Shared test client for a cell: logs in like a browser.

shell → forward_auth → Authentik flow (identifier, password) → back to the shell.
Afterwards the opener carries the session cookies; `get_json`/`send_json` talk to the
ClaraOS API like the frontend. No third-party libraries. Never prints passwords.
"""
import http.cookiejar
import json
import urllib.error
import urllib.parse
import urllib.request


class Zelle:
    def __init__(self, domain: str):
        self.shell = f"https://home.{domain}"
        self.auth = f"https://auth.{domain}"
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.op.addheaders = [("User-Agent", "claraos-zelle-test/1")]

    # ── raw calls ───────────────────────────────────────────────────────
    def get(self, url, **kw):
        return self.op.open(urllib.request.Request(url, **kw), timeout=60)

    def _auth_api(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        csrf = next((c.value for c in self.jar if c.name == "authentik_csrf"), "")
        r = urllib.request.Request(f"{self.auth}{path}", data=data, method=method, headers={
            "Content-Type": "application/json", "Accept": "application/json",
            "X-authentik-CSRF": csrf, "Referer": self.auth + "/"})
        with self.op.open(r, timeout=30) as resp:
            return json.loads(resp.read().decode() or "{}")

    # ── login ───────────────────────────────────────────────────────────
    def anmelden(self, user: str, pw: str) -> None:
        r = self.get(self.shell + "/")
        landed = r.geturl()
        assert landed.startswith(self.auth), f"keine Weiterleitung zur Anmeldung: {landed}"
        q = urllib.parse.urlparse(landed).query
        nxt = urllib.parse.parse_qs(q).get("next", [""])[0]
        path = "/api/v3/flows/executor/default-authentication-flow/?query=" + urllib.parse.quote(q)
        ch = self._auth_api("GET", path)
        for _ in range(6):
            comp = ch.get("component")
            if comp == "ak-stage-identification":
                body = {"component": comp, "uid_field": user}
                if ch.get("password_fields"):
                    body["password"] = pw
                ch = self._auth_api("POST", path, body)
            elif comp == "ak-stage-password":
                ch = self._auth_api("POST", path, {"component": comp, "password": pw})
            elif comp == "xak-flow-redirect":
                break
            else:
                raise AssertionError(f"unerwartete Stage: {comp}")
        assert ch.get("component") == "xak-flow-redirect", "Anmeldung nicht abgeschlossen"
        ziel = ch.get("to") or nxt or self.shell + "/"
        if ziel.startswith("/"):
            ziel = self.auth + ziel
        r = self.get(ziel)
        assert r.geturl().startswith(self.shell), f"nicht zurück in der Shell: {r.geturl()}"

    def oidc_rueckweg(self, start) -> str:
        """Follow an OIDC login of another app with the existing Authentik session.

        `start` (URL or Request) leads to Authentik's authorize endpoint. Authentik sends
        the browser to its flow UI; like `anmelden`, the flow is driven through the
        executor API. Returns the redirect back to the app (with code + state) WITHOUT
        opening it — the caller decides how the app consumes it."""
        r = self.op.open(start if isinstance(start, urllib.request.Request)
                         else urllib.request.Request(start), timeout=60)
        landed = r.geturl()
        if not landed.startswith(self.auth):
            return landed   # no flow needed (already went back to the app)
        u = urllib.parse.urlparse(landed)
        teile = u.path.strip("/").split("/")   # if/flow/<slug>
        assert teile[:2] == ["if", "flow"], f"unerwartete Anmeldeseite: {u.path}"
        path = f"/api/v3/flows/executor/{teile[2]}/?query=" + urllib.parse.quote(u.query)
        ch = self._auth_api("GET", path)
        for _ in range(4):
            if ch.get("component") == "xak-flow-redirect":
                return ch["to"]
            if ch.get("component") == "ak-stage-autosubmit":
                # response_mode=form_post (e.g. PeerTube's OIDC plugin): the browser posts a
                # form to the app's callback — do the same and return where it lands.
                form = urllib.parse.urlencode(ch.get("attrs") or {}).encode()
                r = self.op.open(urllib.request.Request(
                    ch["url"], data=form, method="POST",
                    headers={"Content-Type": "application/x-www-form-urlencoded"}), timeout=60)
                return r.geturl()
            if ch.get("component") == "ak-stage-consent":
                ch = self._auth_api("POST", path, {"component": "ak-stage-consent", "token": ch.get("token", "")})
                continue
            raise AssertionError(f"unerwartete Stage: {ch.get('component')}")
        raise AssertionError("OIDC-Fluss endet nicht")

    # ── ClaraOS API ─────────────────────────────────────────────────────
    # `api`/`body` are positional-only: API parameters are often named `path` themselves.
    def get_json(self, api, /, **params):
        q = ("?" + urllib.parse.urlencode(params)) if params else ""
        return json.loads(self.get(self.shell + api + q).read().decode())

    def send_json(self, method, api, body, /, **params):
        q = ("?" + urllib.parse.urlencode(params)) if params else ""
        r = urllib.request.Request(self.shell + api + q, data=json.dumps(body).encode(),
                                   method=method, headers={"Content-Type": "application/json"})
        return json.loads(self.op.open(r, timeout=120).read().decode() or "{}")

    def status(self, url) -> int:
        try:
            return self.get(url).status
        except urllib.error.HTTPError as e:
            return e.code
