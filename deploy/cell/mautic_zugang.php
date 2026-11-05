<?php
// Cell-internal: sets a new password for ONE ordinary Mautic account, so the assistant's
// tools can act as that user (services/zellen_zugaenge._mautic in claraos-api).
//
// Why this file exists: Mautic's user API refuses to change the password of an existing
// account ("Changing passwords via API is forbidden" — it drops the field and still answers
// 200), and the accounts of a cell come through SAML with a password nobody knows. Odoo and
// InvenTree let their admin do this through their API; Mautic needs this small door.
//
// Runs as its own small service `mautic-zugang`: PHP's built-in server on the cell's
// internal network, same image as Mautic — Mautic's Apache only executes index.php, and
// this door must not be reachable through Caddy at all (it has no route there).
// Guards — all must hold:
//   * a key only claraos-api and this container know (MAUTIC_ZUGANG_KEY, setup.sh),
//   * the caller is inside a private network (the cell's Docker bridge — a port published
//     by mistake would not help an outside caller),
//   * POST with JSON {username, password}; the account exists, is active and NOT an admin,
//   * no Caddy route leads here.
// Answers only {ok, …}; never echoes the password.
header('Content-Type: application/json');
header('Cache-Control: no-store');

function antwort(int $status, array $daten): never
{
    http_response_code($status);
    echo json_encode($daten);
    exit;
}

$schluessel = (string) getenv('MAUTIC_ZUGANG_KEY');
$gegeben = (string) ($_SERVER['HTTP_X_ZELLE_SCHLUESSEL'] ?? '');
if (strlen($schluessel) < 24 || !hash_equals($schluessel, $gegeben)) {
    antwort(403, ['ok' => false]);
}
$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
if (!filter_var($ip, FILTER_VALIDATE_IP) ||
    filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
    antwort(403, ['ok' => false]);  // only private/reserved addresses (Docker bridge)
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    antwort(405, ['ok' => false]);
}
$daten = json_decode((string) file_get_contents('php://input'), true);
$name = is_array($daten) ? (string) ($daten['username'] ?? '') : '';
$pw = is_array($daten) ? (string) ($daten['password'] ?? '') : '';
if ($name === '' || strlen($pw) < 24 || strlen($pw) > 200) {
    antwort(400, ['ok' => false, 'fehler' => 'username/password']);
}

chdir('/var/www/html/docroot');
$_SERVER['MAUTIC_TABLE_PREFIX'] ??= '';
require '/var/www/html/vendor/autoload.php';

$kernel = new AppKernel('prod', false);
$kernel->boot();
$em = $kernel->getContainer()->get('doctrine.orm.entity_manager');
$konto = $em->getRepository(Mautic\UserBundle\Entity\User::class)->findOneBy(['username' => $name]);
if (!$konto || !$konto->isPublished()) {
    antwort(404, ['ok' => false, 'fehler' => 'kein Konto']);
}
if ($konto->isAdmin()) {
    antwort(403, ['ok' => false, 'fehler' => 'Administrator']);
}
$konto->setPassword(password_hash($pw, PASSWORD_BCRYPT));
$em->persist($konto);  // Mautic's entities need it — without, flush() saves nothing
$em->flush();
antwort(200, ['ok' => true, 'id' => $konto->getId()]);
