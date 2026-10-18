# Remove a Paperless account together with its documents — via `manage.py shell`:
#     docker compose exec -T -u paperless -e KONTO=<username> paperless python3 manage.py shell < paperless_konto_weg.py
#
# Warning: delete the documents FIRST. Document.owner is SET_NULL — deleting only the
# user leaves the documents without an owner, and unowned documents are visible to
# EVERY user with view rights.
import os

from django.contrib.auth.models import User
from documents.models import Document

name = os.environ["KONTO"]
for u in User.objects.filter(username=name, is_superuser=False):
    # global_objects also contains documents in the trash (soft delete)
    alle = getattr(Document, "global_objects", Document.objects).filter(owner=u)
    n = alle.count()
    for d in alle:
        d.hard_delete() if hasattr(d, "hard_delete") else d.delete()
    u.delete()
    print("PAPERLESS_GELOESCHT", name, f"{n} Dokumente")
