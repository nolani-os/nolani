# Removes what orangehrm_test.py left behind — runs in the database container
# (`docker compose exec -T orangehrm-db sh < orangehrm_konto_weg.sh`), called by
# run_tests.sh after every run: the user the test's first login created and its employee
# (with the employee go its emergency contacts). Also reports the role it got.
set -eu
q() { mariadb -N -B -u orangehrm -p"$MARIADB_PASSWORD" orangehrm -e "$1"; }
W="u.user_name LIKE 'zelle-test%@invalid.example' AND u.user_role_id <> 1"
rollen=$(q "SELECT GROUP_CONCAT(r.name) FROM ohrm_user u JOIN ohrm_user_role r ON r.id = u.user_role_id WHERE $W")
emps=$(q "SELECT GROUP_CONCAT(u.emp_number) FROM ohrm_user u WHERE $W")
n=$(q "SELECT COUNT(*) FROM ohrm_user u WHERE $W")
if [ "$n" != 0 ]; then
  q "DELETE i FROM ohrm_openid_user_identity i JOIN ohrm_user u ON u.id = i.user_id WHERE $W"
  q "DELETE u FROM ohrm_user u WHERE $W"
  q "DELETE FROM hs_hr_employee WHERE emp_number IN ($emps)"
fi
echo "ORANGEHRM_TEST_GELOESCHT Konten $n (Rolle ${rollen:--})"
