#!/usr/bin/env python3
"""Wire up a cell's Authentik for ClaraOS — idempotent.

Creates or verifies:
- Proxy provider `claraos-shell` (forward_single, external_host = https://home.<domain>)
- Application `ClaraOS` (slug `claraos`)
- Binding to the embedded outpost (otherwise /outpost.goauthentik.io/auth/caddy returns 404)
- Group `clara-admins` containing the bootstrap admin `akadmin` (the API only opens admin
  paths to this group — without it even the admin would be locked out)
- OAuth2 providers + applications for Vaultwarden, Immich and Paperless (each only if
  its client secret is set)

Runs on the cell (setup.sh) and talks to Authentik on its internal port.
Env: AUTHENTIK_API_TOKEN, ZELLE_DOMAIN, optional AUTHENTIK_API_URL.
Never prints tokens or passwords.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("AUTHENTIK_API_URL", "http://127.0.0.1:9000/api/v3").rstrip("/")
TOKEN = os.environ["AUTHENTIK_API_TOKEN"]
DOM = os.environ["ZELLE_DOMAIN"]
EXT_HOST = f"https://home.{DOM}"
HDR = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=HDR)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            txt = resp.read().decode()
            return json.loads(txt) if txt else {}
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"  HTTP {e.code} {method} {path}: {e.read().decode()[:300]}\n")
        raise


def wait_ready(max_wait=300):
    print("warte auf Authentik-API", end="", flush=True)
    for _ in range(max_wait // 5):
        try:
            req("GET", "/admin/version/")
            print(" ok")
            return
        except Exception:
            print(".", end="", flush=True)
            time.sleep(5)
    sys.exit("FEHLER: Authentik-API nicht erreichbar")


def flow_pk(slug, max_wait=600):
    """On a FRESH install the worker creates the bundled flows (blueprints) only
    minutes after startup — long after the API is already answering. A first run
    would abort right here, so wait instead of giving up."""
    for i in range(max_wait // 10):
        r = req("GET", f"/flows/instances/?slug={slug}")
        if r["results"]:
            return r["results"][0]["pk"]
        if i == 0:
            print(f"warte auf Flow '{slug}' (Blueprints)", end="", flush=True)
        print(".", end="", flush=True)
        time.sleep(10)
    sys.exit(f"\nFEHLER: Flow '{slug}' fehlt auch nach {max_wait}s")


def app_exists(slug):
    """Warning: the `/core/applications/?slug=…` filter is ignored (Authentik 2026.8)
    and returns ALL applications — it reported "exists" where nothing was. So compare
    exactly ourselves."""
    apps = req("GET", "/core/applications/?superuser_full_list=true&page_size=500")["results"]
    return any(a.get("slug") == slug for a in apps)


def main():
    wait_ready()

    # 1+2. Proxy providers (forward auth) + applications: the shell and the two
    # host names of the personal browsers (browser/ctl.py, Caddyfile `user_browser`).
    prov_pks = [
        proxy_app("claraos-shell", "claraos", "ClaraOS", EXT_HOST),
        proxy_app("claraos-browser", "claraos-browser", "Browser", f"https://browser.{DOM}"),
        proxy_app("claraos-browser-m", "claraos-browser-m", "Browser (mobil)", f"https://browser-m.{DOM}"),
    ]

    # 3. Embedded outpost — without the binding /outpost.goauthentik.io/auth/caddy returns 404
    ops = req("GET", "/outposts/instances/?name__startswith=authentik+Embedded+Outpost")["results"]
    if not ops:
        sys.exit("FEHLER: Embedded-Outpost nicht gefunden")
    op = ops[0]
    provs = list(op.get("providers") or [])
    fehlt = [pk for pk in prov_pks if pk not in provs]
    if fehlt:
        req("PATCH", f"/outposts/instances/{op['pk']}/", {"providers": provs + fehlt})
        print(f"outpost-bindung gesetzt (+{len(fehlt)})")
    else:
        print("outpost-bindung vorhanden")
    # The embedded outpost must know Authentik's public address — otherwise it
    # redirects the login to the internal host name.
    cfg = dict(op.get("config") or {})
    want = f"https://auth.{DOM}"
    if cfg.get("authentik_host") != want:
        cfg["authentik_host"] = want
        req("PATCH", f"/outposts/instances/{op['pk']}/", {"config": cfg})
        print(f"outpost authentik_host = {want}")

    # 4. Group clara-admins containing akadmin
    grp = req("GET", "/core/groups/?name=clara-admins")["results"]
    grp_pk = grp[0]["pk"] if grp else req("POST", "/core/groups/", {"name": "clara-admins"})["pk"]
    admin = req("GET", "/core/users/?username=akadmin")["results"]
    if admin:
        u = admin[0]
        if grp_pk not in (u.get("groups") or []):
            req("POST", f"/core/groups/{grp_pk}/add_user/", {"pk": u["pk"]})
            print("akadmin → clara-admins")
        else:
            print("akadmin ist in clara-admins")

    # 5. OAuth2 providers (SSO). Issuer = /application/o/<slug>/
    # Vaultwarden
    oidc_app("vaultwarden", "Bitwarden", os.environ.get("VW_SSO_CLIENT_SECRET"),
             [f"https://vault.{DOM}/identity/connect/oidc-signin"],
             {"openid", "email", "profile", "offline_access"})
    # Immich: web login, account linking in the settings, and the mobile app
    oidc_app("immich", "Fotos", os.environ.get("IMMICH_OIDC_SECRET"),
             [f"https://immich.{DOM}/auth/login", f"https://immich.{DOM}/user-settings",
              "app.immich:///oauth-callback"],
             {"openid", "email", "profile"})
    # Paperless (django-allauth, provider_id `authentik`)
    oidc_app("paperless", "Dokumente", os.environ.get("PAPERLESS_OIDC_SECRET"),
             [f"https://paperless.{DOM}/accounts/oidc/authentik/login/callback/"],
             {"openid", "email", "profile"})
    # Shared social cell (compose layer 8) — own host names, not below the cell domain
    social, video = os.environ.get("SOCIAL_DOMAIN"), os.environ.get("VIDEO_DOMAIN")
    if social:
        oidc_app("mastodon", "Social", os.environ.get("MASTODON_OIDC_SECRET"),
                 [f"https://{social}/auth/auth/openid_connect/callback"],
                 {"openid", "email", "profile"})
    if video:
        oidc_app("peertube", "Videos", os.environ.get("PEERTUBE_OIDC_SECRET"),
                 [f"https://{video}/plugins/auth-openid-connect/router/code-cb"],
                 {"openid", "email", "profile"})

    print("\nAuthentik-Verdrahtung fertig.")


def proxy_app(name, slug, title, ext_host):
    """Create or verify a forward_single proxy provider + its application; returns the pk."""
    hit = [p for p in req("GET", f"/providers/proxy/?name={name}&page_size=500")["results"]
           if p.get("name") == name]
    if hit:
        pk = hit[0]["pk"]
        if hit[0].get("external_host") != ext_host:
            req("PATCH", f"/providers/proxy/{pk}/", {"external_host": ext_host})
            print(f"provider '{name}': external_host korrigiert")
        print(f"provider '{name}' vorhanden (pk={pk})")
    else:
        pk = req("POST", "/providers/proxy/", {
            "name": name,
            "authorization_flow": flow_pk("default-provider-authorization-implicit-consent"),
            "invalidation_flow": flow_pk("default-provider-invalidation-flow"),
            "mode": "forward_single",
            "external_host": ext_host,
        })["pk"]
        print(f"provider '{name}' angelegt (pk={pk})")
    if app_exists(slug):
        print(f"application '{slug}' vorhanden")
    else:
        req("POST", "/core/applications/", {"name": title, "slug": slug, "provider": pk})
        print(f"application '{slug}' angelegt")
    return pk


def oidc_app(slug, title, secret, redirects, want):
    """Create or update a confidential OAuth2 provider + application `slug`.
    Skipped without a secret (the cell then simply has no such app)."""
    if not secret:
        print(f"provider '{slug}': kein Secret — übersprungen")
        return
    redirect = [{"matching_mode": "strict", "url": u} for u in redirects]
    scopes = req("GET", "/propertymappings/provider/scope/?managed__startswith=goauthentik.io/providers/oauth2/scope-")["results"]
    mappings = [m["pk"] for m in scopes if m["managed"].rsplit("scope-", 1)[-1] in want]
    keys = req("GET", "/crypto/certificatekeypairs/?has_key=true")["results"]
    felder = {
        "name": slug,
        "authorization_flow": flow_pk("default-provider-authorization-implicit-consent"),
        "invalidation_flow": flow_pk("default-provider-invalidation-flow"),
        "client_type": "confidential", "client_id": slug, "client_secret": secret,
        "redirect_uris": redirect, "property_mappings": mappings,
        "signing_key": keys[0]["pk"] if keys else None,
        "include_claims_in_id_token": True,
        # Warning: Authentik 2026.8 defaults `grant_types` to an EMPTY list for providers
        # created through the API — every login then fails with "Invalid grant_type for
        # provider" (the app only sees "invalid_request"). Set explicitly.
        "grant_types": ["authorization_code", "refresh_token"],
    }
    # Compare exactly (see app_exists): with more than one provider, a silently ignored
    # filter would make the FIRST result — another app's provider — get overwritten.
    hit = [p for p in req("GET", f"/providers/oauth2/?name={slug}&page_size=500")["results"]
           if p.get("name") == slug]
    if hit:
        pk = hit[0]["pk"]
        req("PATCH", f"/providers/oauth2/{pk}/", felder)
        print(f"provider '{slug}' aktualisiert ({len(mappings)} Scopes)")
    else:
        pk = req("POST", "/providers/oauth2/", felder)["pk"]
        print(f"provider '{slug}' angelegt ({len(mappings)} Scopes)")
    if not app_exists(slug):
        req("POST", "/core/applications/", {"name": title, "slug": slug, "provider": pk})
        print(f"application '{slug}' angelegt")
    else:
        print(f"application '{slug}' vorhanden")


if __name__ == "__main__":
    main()
