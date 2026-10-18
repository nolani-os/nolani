# Via `ak shell` in the Authentik container: create the throwaway test account
# `zelle-test` (password from ZELLE_PW) or delete it (ZELLE_LOESCHEN=1). Prints nothing secret.
import os
from authentik.core.models import User

name = "zelle-test"
if os.environ.get("ZELLE_LOESCHEN"):
    n, _ = User.objects.filter(username=name).delete()
    print("TEST_GELOESCHT", n)
else:
    u, _ = User.objects.get_or_create(username=name, defaults={
        "name": "Zelle Test", "email": "zelle-test@invalid.example", "is_active": True})
    u.set_password(os.environ["ZELLE_PW"])
    u.save()
    print("TEST_OK")
