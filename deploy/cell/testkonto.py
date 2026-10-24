# Via `ak shell` in the Authentik container: create the throwaway test account
# `zelle-test` (password from ZELLE_PW) or delete it (ZELLE_LOESCHEN=1). Prints nothing secret.
# Email per run (ZELLE_MAIL): Vaultwarden keeps its accounts (no admin API in a cell,
# no cascading delete) and rightly refuses a NEW identity with an email it already
# bound to a previous run's account — a fixed address made every later run fail.
import os
from authentik.core.models import User

name = "zelle-test"
if os.environ.get("ZELLE_LOESCHEN"):
    n, _ = User.objects.filter(username=name).delete()
    print("TEST_GELOESCHT", n)
else:
    u, _ = User.objects.get_or_create(username=name, defaults={
        "name": "Zelle Test", "email": os.environ.get("ZELLE_MAIL", "zelle-test@invalid.example"), "is_active": True})
    u.set_password(os.environ["ZELLE_PW"])
    u.save()
    print("TEST_OK")
