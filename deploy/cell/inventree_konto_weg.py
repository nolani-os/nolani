# Removes what inventree_test.py left behind — runs inside `manage.py shell`, called
# by run_tests.sh after every run: the account(s) the test user's first login created
# (the address changes per run, testkonto.py) and the test parts.
from django.contrib.auth import get_user_model

from part.models import Part

teile = Part.objects.filter(name__startswith="Nolani-Test ")
t = teile.count()
for teil in teile:
    teil.active = False        # InvenTree only deletes inactive parts
    teil.save()
    teil.delete()
konten = get_user_model().objects.filter(email__startswith="zelle-test", email__endswith="@invalid.example",
                                         is_superuser=False)
k = konten.count()
konten.delete()                # social accounts go with them (cascade)
print(f"INVENTREE_TEST_GELOESCHT Konten {k}, Testteile {t}")
