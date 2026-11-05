# Removes the Odoo account(s) of the throwaway test user — runs inside `odoo shell`
# (`env` is given), called by run_tests.sh after every run.
#
# Odoo creates the account on the test user's first login; its login is the email,
# which changes per run (testkonto.py, ZELLE_MAIL). So: every account that came
# through the cell's login with a test address. Odoo refuses to delete users that
# own records (messages, activities) — those are archived instead, which frees
# nothing that a later run needs (the next run brings a new address).
Users = env["res.users"].sudo().with_context(active_test=False)  # noqa: F821
konten = Users.search([("login", "=like", "zelle-test%@invalid.example"), ("oauth_uid", "!=", False)])
weg = archiviert = 0
for u in konten:
    try:
        with env.cr.savepoint():  # noqa: F821
            u.unlink()
        weg += 1
    except Exception:
        u.write({"active": False})
        # …and its contact card: otherwise every run leaves one more "Zelle Test" in the
        # contact list (the showcase pictures showed three).
        u.partner_id.write({"active": False})
        archiviert += 1
# Opportunities Clara created during odoo_clara_test.py (before their contacts)
if "crm.lead" in env:  # noqa: F821
    chancen = env["crm.lead"].sudo().with_context(active_test=False).search(  # noqa: F821
        [("name", "=like", "Nolani-Test %")])
    chancen.unlink()
# Contacts Clara created during odoo_clara_test.py
Partner = env["res.partner"].sudo().with_context(active_test=False)  # noqa: F821
kontakte = Partner.search([("name", "=like", "Nolani-Test %")])
k_weg = len(kontakte)
try:
    with env.cr.savepoint():  # noqa: F821
        kontakte.unlink()
except Exception:
    kontakte.write({"active": False})
env.cr.commit()  # noqa: F821
print(f"ODOO_TEST_GELOESCHT {weg} (archiviert {archiviert}), Testkontakte {k_weg}")
