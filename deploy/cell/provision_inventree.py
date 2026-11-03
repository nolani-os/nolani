# InvenTree of a cell: the group new accounts land in.
#
#   docker compose exec -T -w /home/inventree/src/backend/InvenTree inventree-server \
#     python3 manage.py shell < provision_inventree.py
#
# Runs inside `manage.py shell`. Idempotent. Prints no secrets.
#
# Accounts are created on the first login through the cell (OIDC) and put into the
# group "nutzer" (SIGNUP_GROUP, set below). Without
# roles that group sees an empty UI — so: view, add and change in every working area
# (parts, stock, builds, orders), no deleting, no administration.
from django.contrib.auth.models import Group

import users.tasks
from common.settings import get_global_setting, set_global_setting
from users.models import RuleSet
from users.ruleset import RULESET_NAMES

ARBEIT = {"part_category", "part", "stock_location", "stock", "build",
          "purchase_order", "sales_order", "return_order"}

# InvenTree builds a group's rule sets and permissions in users.tasks.update_group_roles
# (post_save signal on Group) — but that function returns early under `manage.py shell`
# (canAppAccessDatabase excludes the shell command). This script runs exactly there,
# so lift the gate for this process only.
users.tasks.canAppAccessDatabase = lambda *a, **k: True

gruppe, neu = Group.objects.get_or_create(name="nutzer")
for name in RULESET_NAMES:
    RuleSet.objects.get_or_create(group=gruppe, name=name)
for rs in RuleSet.objects.filter(group=gruppe):
    darf = rs.name in ARBEIT
    rs.can_view = darf
    rs.can_add = darf
    rs.can_change = darf
    rs.can_delete = False
    rs.save()
gruppe.save()  # recompute the group's permissions from its rule sets
rollen = sorted(rs.name for rs in RuleSet.objects.filter(group=gruppe, can_change=True))
rechte = gruppe.permissions.count()
# New SSO accounts land in this group. SIGNUP_GROUP holds the group's id, not its name
# (a name breaks every first login with a 500) — that is why it is set here and not in
# INVENTREE_GLOBAL_SETTINGS: the id exists only once the group does.
set_global_setting("SIGNUP_GROUP", gruppe.pk)
if str(get_global_setting("SIGNUP_GROUP")) != str(gruppe.pk):
    raise SystemExit("INVENTREE FEHLER: SIGNUP_GROUP nicht gesetzt")
print(f"INVENTREE Gruppe nutzer {'angelegt' if neu else 'aktuell'}: {len(rollen)} Bereiche "
      f"(ansehen/anlegen/ändern, {rechte} Rechte), kein Löschen, keine Verwaltung")
if not rollen or not rechte:
    raise SystemExit("INVENTREE FEHLER: Gruppe nutzer ohne Rechte")
