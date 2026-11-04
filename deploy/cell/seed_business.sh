#!/usr/bin/env bash
# Demo data for the business apps, for the README showcase (./run_tests.sh schaufenster with
# SCHAUFENSTER_TEIL=business). Only on a throwaway cell: it writes invented companies, parts,
# contacts and employees into the apps that are on. Idempotent — a second run adds nothing.
#
#   ./seed_business.sh
set -uo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
APPS=" $(echo "${CLARAOS_OPTIONAL_APPS:-}" | tr ',' ' ') "
an() { case "$APPS" in *" $1 "*) return 0 ;; esac; return 1; }

if an odoo; then
  docker compose exec -T odoo odoo shell -c /etc/odoo/odoo.conf -d odoo --no-http 2>/dev/null <<'PY' | grep ^SEED_
# The README is English: activate English and give new accounts English.
env["res.lang"]._activate_lang("en_US")
env["res.users"].sudo().with_context(active_test=False).search(
    [("login", "=", "vorlage-neue-konten")]).write(
        {"lang": "en_US", "action_id": env.ref("contacts.action_contacts").id})  # opens on Contacts
Partner = env["res.partner"].sudo()
firmen = [
    ("Brightwater Studio", "Hamburg", "hello@brightwater.example", [("Mia Lorenz", "Creative Director"), ("Jonas Weber", "Project Lead")]),
    ("Northfield Bakery", "Leipzig", "orders@northfield.example", [("Clara Böhm", "Owner")]),
    ("Kestrel Engineering", "Stuttgart", "info@kestrel.example", [("Daniel Frey", "CTO"), ("Lea Hoffmann", "Purchasing")]),
    ("Alder & Finch", "Vienna", "office@alderfinch.example", [("Paul Richter", "Partner")]),
    ("Lumen Clinic", "Cologne", "contact@lumen.example", [("Dr. Sara Klein", "Medical Director"), ("Tim Vogel", "IT")]),
    ("Harbour Coffee", "Bremen", "team@harbour.example", [("Nina Schulz", "Store Manager")]),
]
neu = 0
for name, stadt, mail, leute in firmen:
    firma = Partner.search([("name", "=", name), ("is_company", "=", True)], limit=1)
    if not firma:
        firma = Partner.create({"name": name, "is_company": True, "city": stadt, "email": mail})
        neu += 1
    for person, funktion in leute:
        if not Partner.search([("name", "=", person), ("parent_id", "=", firma.id)], limit=1):
            Partner.create({"name": person, "function": funktion, "parent_id": firma.id,
                            "email": person.lower().replace("dr. ", "").replace(" ", ".") + "@" + mail.split("@")[1]})
            neu += 1
env.cr.commit()
print("SEED_ODOO neu", neu)
PY
fi

if an inventree; then
  docker compose exec -T -w /home/inventree/src/backend/InvenTree inventree-server \
    python3 manage.py shell 2>/dev/null <<'PY' | grep ^SEED_
from part.models import Part, PartCategory
from stock.models import StockItem, StockLocation
kat = {}
for k in ("Electronics", "Fasteners", "Packaging"):
    kat[k], _ = PartCategory.objects.get_or_create(name=k, parent=None)
lager, _ = StockLocation.objects.get_or_create(name="Main warehouse", parent=None)
teile = [
    ("Resistor 10k 0603", "Electronics", 4800), ("Capacitor 100nF 0402", "Electronics", 9200),
    ("ESP32 module", "Electronics", 140), ("USB-C connector", "Electronics", 610),
    ("M3 x 8 screw", "Fasteners", 2500), ("M3 nut", "Fasteners", 2300), ("Spacer 10 mm", "Fasteners", 380),
    ("Shipping box S", "Packaging", 75), ("Anti-static bag", "Packaging", 410),
]
neu = 0
for name, k, menge in teile:
    teil = Part.objects.filter(name=name).first()
    if not teil:
        teil = Part.objects.create(name=name, category=kat[k], description=f"{name} — demo part",
                                   component=True, purchaseable=True)
        StockItem.objects.create(part=teil, location=lager, quantity=menge)
        neu += 1
print("SEED_INVENTREE neu", neu)
PY
fi

if an mautic; then
  docker compose exec -T -u www-data mautic php 2>/dev/null <<'PHP' | grep ^SEED_
<?php
require '/var/www/html/vendor/autoload.php';
$kernel = new AppKernel('prod', false);
$kernel->boot();
$c = $kernel->getContainer();
$model = $c->get('mautic.model.factory')->getModel('lead');
$repo = $model->getRepository();
$leute = [["Emma", "Fischer", "Brightwater Studio"], ["Lukas", "Wagner", "Northfield Bakery"],
          ["Hannah", "Becker", "Kestrel Engineering"], ["Felix", "Schaefer", "Alder & Finch"],
          ["Sophie", "Koch", "Lumen Clinic"], ["Leon", "Bauer", "Harbour Coffee"],
          ["Marie", "Neumann", "Brightwater Studio"], ["Elias", "Wolf", "Kestrel Engineering"]];  // ASCII: Mautic strips umlauts from addresses, the duplicate check would miss
$neu = 0;
foreach ($leute as [$vor, $nach, $firma]) {
    $mail = strtolower($vor.'.'.$nach).'@demo.invalid';
    if ($repo->findOneBy(['email' => $mail])) { continue; }
    $lead = new Mautic\LeadBundle\Entity\Lead();
    $model->setFieldValues($lead, ['firstname' => $vor, 'lastname' => $nach, 'email' => $mail, 'company' => $firma], false);
    $lead->setPoints(random_int(5, 80));
    $model->saveEntity($lead);
    $neu++;
}
echo "SEED_MAUTIC neu $neu\n";
PHP
fi

if an orangehrm; then
  docker compose exec -T orangehrm-db sh -c \
    'exec mariadb -N -B -u orangehrm -p"$MARIADB_PASSWORD" orangehrm' 2>/dev/null <<'SQL' | grep ^SEED_
INSERT INTO hs_hr_employee (employee_id, emp_firstname, emp_lastname, emp_work_email)
SELECT * FROM (SELECT 'D001' a, 'Anna' b, 'Krüger' c, 'anna.krueger@demo.invalid' d UNION ALL
               SELECT 'D002', 'Ben', 'Hartmann', 'ben.hartmann@demo.invalid' UNION ALL
               SELECT 'D003', 'Carla', 'Seidel', 'carla.seidel@demo.invalid' UNION ALL
               SELECT 'D004', 'David', 'Lange', 'david.lange@demo.invalid' UNION ALL
               SELECT 'D005', 'Eva', 'Schmitt', 'eva.schmitt@demo.invalid' UNION ALL
               SELECT 'D006', 'Finn', 'Werner', 'finn.werner@demo.invalid') neu
WHERE NOT EXISTS (SELECT 1 FROM hs_hr_employee e WHERE e.employee_id = neu.a);
SELECT CONCAT('SEED_ORANGEHRM ', ROW_COUNT());
SQL
fi

if an superset; then
  # Superset's example dashboards (downloaded from the Superset examples repository).
  if ! docker compose exec -T superset-db psql -U superset -d superset -tAc \
       "SELECT 1 FROM dashboards LIMIT 1" 2>/dev/null | grep -q 1; then
    timeout 1500 docker compose exec -T superset superset load_examples >/dev/null 2>&1
  fi
  echo "SEED_SUPERSET Dashboards $(docker compose exec -T superset-db psql -U superset -d superset -tAc \
    'SELECT count(*) FROM dashboards' 2>/dev/null)"
fi
