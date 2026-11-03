<?php
// Removes what mautic_test.py left behind — runs inside the mautic container
// (`docker compose exec -T -u www-data mautic php < mautic_konto_weg.php`), called by
// run_tests.sh after every run: the test user's Mautic account(s) and the test contacts.
// Also the check that the account landed in role "Nutzer", not as administrator.
chdir('/var/www/html/docroot');
$_SERVER['MAUTIC_TABLE_PREFIX'] ??= '';
require '/var/www/html/vendor/autoload.php';

use Mautic\LeadBundle\Entity\Lead;
use Mautic\UserBundle\Entity\User;

$kernel = new AppKernel('prod', false);
$kernel->boot();
$em = $kernel->getContainer()->get('doctrine.orm.entity_manager');

$konten = $em->createQueryBuilder()->select('u')->from(User::class, 'u')
    ->where('u.email LIKE :m')->setParameter('m', 'zelle-test%@invalid.example')
    ->getQuery()->getResult();
$rollen = [];
$k = 0;
foreach ($konten as $u) {
    $rollen[] = $u->getRole()->getName().($u->isAdmin() ? '/admin' : '');
    if (!$u->isAdmin()) {
        $em->remove($u);
        ++$k;
    }
}
$kontakte = $em->createQueryBuilder()->select('l')->from(Lead::class, 'l')
    ->where('l.lastname LIKE :n')->setParameter('n', 'Nolani-Test %')
    ->getQuery()->getResult();
foreach ($kontakte as $l) {
    $em->remove($l);
}
$em->flush();
echo 'MAUTIC_TEST_GELOESCHT Konten '.$k.' (Rolle '.(implode(',', $rollen) ?: '-').'), Kontakte '.count($kontakte)."\n";
