# Removes what superset_test.py left behind — runs inside the superset container
# (`docker compose exec -T superset python - < superset_konto_weg.py`), called by
# run_tests.sh after every run: the test user's Superset account and its dashboards.
from superset.app import create_app

app = create_app()
with app.app_context():
    from superset import db, security_manager
    from superset.models.dashboard import Dashboard

    tafeln = db.session.query(Dashboard).filter(Dashboard.dashboard_title.like("Nolani-Test %")).all()
    for d in tafeln:
        db.session.delete(d)
    konto = security_manager.find_user(username="zelle-test")
    k = 0
    if konto is not None and not any(r.name == "Admin" for r in konto.roles):
        db.session.delete(konto)
        k = 1
    db.session.commit()
    print(f"SUPERSET_TEST_GELOESCHT Konten {k}, Dashboards {len(tafeln)}")
