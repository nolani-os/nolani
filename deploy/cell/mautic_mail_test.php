<?php
// Mautic can send to OUTSIDE addresses: the mailer configured in config/local.php
// (mailbox mautic@<domain>, login, port 465) hands one message to Stalwart, addressed to
// the reserved domain invalid.example — accepted means login and relay work; Stalwart's
// later bounce lands in mautic@<domain>, no real third party gets anything.
//   docker compose exec -T -u www-data mautic php < mautic_mail_test.php
require '/var/www/html/vendor/autoload.php';

use Symfony\Component\Mailer\Transport;
use Symfony\Component\Mime\Email;

$parameters = [];
include '/var/www/html/config/local.php';
$dsn = $parameters['mailer_dsn'] ?? '';
$mit_login = str_starts_with($dsn, 'smtps://') && str_contains($dsn, '@stalwart:465');
try {
    Transport::fromDsn($dsn)->send((new Email())
        ->from($parameters['mailer_from_email'] ?? 'mautic@localhost')
        ->to('zelle-test@invalid.example')
        ->subject('Nolani-Test Versand')
        ->text('Ende-zu-Ende-Test: Versand nach außen.'));
    echo ($mit_login ? '✓' : '✗').' versand_nach_aussen — '.($mit_login ? 'angenommen (Postfach mit Anmeldung)' : 'angenommen, aber ohne Anmeldung konfiguriert')."\n";
    exit($mit_login ? 0 : 1);
} catch (Throwable $e) {
    // Without the password in the message (Symfony may quote the DSN)
    $text = preg_replace('#//[^@\s]+@#', '//***@', $e->getMessage());
    echo '✗ versand_nach_aussen — '.substr($text, 0, 200)."\n";
    exit(1);
}
