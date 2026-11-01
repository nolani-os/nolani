# Odoo of a cell: login via Authentik, accounts created on first login.
#
#   docker compose exec -T -e ZELLE_DOMAIN -e ODOO_OIDC_SECRET -e ODOO_ADMIN_PASSWORD \
#     -e CLARAOS_PRODUCT_NAME odoo odoo shell -c /etc/odoo/odoo.conf -d odoo --no-http \
#     < provision_odoo.py
#
# Runs inside `odoo shell` (`env` is given). Idempotent. Prints no secrets.
#
# How accounts come about: a user clicks "Sign in with <product>" on Odoo's login
# page, Authentik confirms who they are, and auth_oauth creates the Odoo account from
# a template — that needs sign-up scope `b2c`. The template is an INTERNAL user (Odoo
# would otherwise create portal users, who see nothing of the backend). Password
# sign-up and reset stay closed: Caddy blocks /web/signup and /web/reset_password,
# and OIDC accounts have no password.
import os

DOM = os.environ["ZELLE_DOMAIN"]
PRODUCT = os.environ.get("CLARAOS_PRODUCT_NAME") or "NolaniOS"
SECRET = os.environ.get("ODOO_OIDC_SECRET")
ADMIN_PW = os.environ.get("ODOO_ADMIN_PASSWORD")
AUTH = f"https://auth.{DOM}/application/o"

ICP = env["ir.config_parameter"].sudo()  # noqa: F821 — given by odoo shell
Users = env["res.users"].sudo().with_context(active_test=False)  # noqa: F821

# 1. Public address — fixed, so a request with another Host cannot change links
ICP.set_param("web.base.url", f"https://odoo.{DOM}")
ICP.set_param("web.base.url.freeze", "True")

# 2. Administrator: password from .env, the cell's admin address
admin = env.ref("base.user_admin")  # noqa: F821
if ADMIN_PW:
    admin.sudo().write({"password": ADMIN_PW})
admin.sudo().partner_id.write({"email": f"admin@{DOM}"})
print("ODOO admin: Passwort gesetzt" if ADMIN_PW else "ODOO admin: ✗ kein ODOO_ADMIN_PASSWORD")

# 3. Template for accounts created on first login: internal user, no extra rights
vorlage = Users.search([("login", "=", "vorlage-neue-konten")], limit=1)
if not vorlage:
    # Created active, archived afterwards: Odoo 18 refuses to create an archived user
    # (it would archive the contact first, which is still linked to an active user).
    vorlage = Users.create({
        "name": "Vorlage für neue Konten", "login": "vorlage-neue-konten",
        "groups_id": [(6, 0, [env.ref("base.group_user").id])],  # noqa: F821
    })
    vorlage.write({"active": False})
    print("ODOO Vorlage für neue Konten angelegt")
# No stored picture on the template: Odoo copies it into every new account, so all of
# them showed the template's initial ("V") instead of their own.
if vorlage.partner_id.image_1920:
    vorlage.partner_id.write({"image_1920": False})
ICP.set_param("base.template_portal_user_id", str(vorlage.id))
ICP.set_param("auth_signup.invitation_scope", "b2c")
ICP.set_param("auth_signup.reset_password", "False")

# 4. The cell's Authentik as the only login provider
Provider = env["auth.oauth.provider"].sudo().with_context(active_test=False)  # noqa: F821
werte = {
    "name": PRODUCT,
    "body": f"Mit {PRODUCT} anmelden",
    "flow": "id_token_code",
    "client_id": "odoo",
    "client_secret": SECRET,
    "enabled": bool(SECRET),
    "auth_endpoint": f"{AUTH}/authorize/",
    "token_endpoint": f"{AUTH}/token/",
    "jwks_uri": f"{AUTH}/odoo/jwks/",
    "validation_endpoint": f"{AUTH}/userinfo/",
    "end_session_endpoint": f"{AUTH}/odoo/end-session/",
    "scope": "openid email profile",
    "token_map": "sub:user_id email:email",
    "css_class": "fa fa-fw fa-sign-in text-primary",
}
eigener = Provider.search([("client_id", "=", "odoo")], limit=1)
if eigener:
    eigener.write(werte)
else:
    eigener = Provider.create(werte)
# The providers Odoo ships (odoo.com, Google, Facebook) and auth_oidc's samples stay off
andere = Provider.search([("id", "!=", eigener.id), ("enabled", "=", True)])
andere.write({"enabled": False})
print(f"ODOO Anmeldung über {AUTH}: {'an' if SECRET else '✗ kein ODOO_OIDC_SECRET'}"
      + (f" ({len(andere)} andere abgeschaltet)" if andere else ""))

env.cr.commit()  # noqa: F821
