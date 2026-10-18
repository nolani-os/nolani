# Via `manage.py shell` in the Paperless container — idempotent:
#     docker compose exec -T -u paperless paperless python3 manage.py shell < provision_paperless.py
#
# Group `nutzer` = what every cell user may do in Paperless. New accounts join it on
# their first SSO login (PAPERLESS_SOCIAL_ACCOUNT_DEFAULT_GROUPS). Object permissions
# still apply: a user only sees documents they own or that were shared with them.
#
# Deliberately NOT granted:
# - workflows: their actions can send webhooks/e-mails from the server, i.e. requests
#   into the cell's internal network on behalf of any user;
# - mail accounts/rules (paperless_mail): the server would log into outside mailboxes;
# - audit log: global view across all users' changes;
# - application configuration (admin only).
from django.contrib.auth.models import Group, Permission

g, _ = Group.objects.get_or_create(name="nutzer")
erlaubt = Permission.objects.filter(content_type__app_label="documents").exclude(
    codename__icontains="workflow")
# The sharing dialog lists users and groups.
erlaubt = list(erlaubt) + list(Permission.objects.filter(
    content_type__app_label="auth", codename__in=["view_user", "view_group"]))
g.permissions.set(erlaubt)
print(f"PAPERLESS_GRUPPE nutzer: {len(erlaubt)} Rechte")
