"""An API key for one ordinary user, issued by the cell's admin — for the assistant's tools.

Why: the cell's users sign in through OIDC and have no password; Odoo issues API keys only
to the signed-in user themselves. The cell used to set a random password instead — but the
password is part of Odoo's session token (`_get_session_token_fields`), so that ended every
open Odoo session of the user the moment the assistant first worked in Odoo. An API key
leaves the password and the sessions alone.

Callable over RPC by system administrators only (services/zellen_zugaenge._odoo in
claraos-api, with the cell's admin login). Refuses portal users, inactive users and
administrators. One key per user and name: an earlier one of the same name is removed.
"""
from odoo import _, api, models
from odoo.exceptions import AccessError, UserError


class ResUsers(models.Model):
    _inherit = "res.users"

    @api.model
    def claraos_assistent_schluessel(self, user_id, name):
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only administrators may issue assistant keys."))
        konto = self.sudo().with_context(active_test=False).browse(int(user_id)).exists()
        if not konto or not konto.active or konto.share:
            raise UserError(_("No active internal user with this id."))
        if konto.has_group("base.group_system") or konto.has_group("base.group_erp_manager"):
            raise UserError(_("No assistant keys for administrators."))
        name = (str(name) or "Assistant")[:64]
        Schluessel = self.env["res.users.apikeys"].sudo()
        Schluessel.search([("user_id", "=", konto.id), ("name", "=", name)]).unlink()
        # _generate files the key for env.user — so as the user; sudo allows a key without
        # expiry (the cell renews it when Odoo rejects it, zellen_zugaenge).
        return Schluessel.with_user(konto).sudo()._generate(None, name, None)
