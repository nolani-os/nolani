<?php
// Mautic of a cell: the role new accounts get, and login via the cell's Authentik (SAML).
//
//   docker compose exec -T -u www-data -e ZELLE_DOMAIN -e CLARAOS_PRODUCT_NAME \
//     -e MAUTIC_IDP_METADATA_B64 -e MAUTIC_MAIL_PASSWORD mautic php < provision_mautic.php
//
// Runs after `mautic:install`. Idempotent. Prints no secrets.
//
// Accounts are created on the first login through the cell (SAML, Mautic's own
// UserCreator) and get role "Nutzer": every marketing area (contacts, segments,
// campaigns, e-mails, forms, pages, reports …) in full — but no users and roles, API,
// plugins, marketplace, themes or webhooks (a webhook sends data to any address).
// The local `admin` from the installation stays the administrator.

chdir('/var/www/html/docroot');
$_SERVER['MAUTIC_TABLE_PREFIX'] ??= '';
require '/var/www/html/vendor/autoload.php';

use Mautic\UserBundle\Entity\Role;

$kernel = new AppKernel('prod', false);
$kernel->boot();
$c = $kernel->getContainer();
$em = $c->get('doctrine.orm.entity_manager');
$rollen = $c->get('mautic.model.factory')->getModel('user.role');

// 1. Role "Nutzer"
$gesperrt = ['marketplace', 'core', 'api', 'plugin', 'user', 'webhook'];
$rechte = [];
foreach ($c->get('mautic.security')->getPermissionObjects() as $bundle => $obj) {
    if (in_array($bundle, $gesperrt, true)) {
        continue;
    }
    foreach ($obj->getPermissions() as $name => $stufen) {
        $rechte["$bundle:$name"] = isset($stufen['full']) ? ['full'] : array_keys($stufen);
    }
}
$rechte['user:profile'] = ['editname', 'editposition'];  // not username or e-mail
$rolle = $em->getRepository(Role::class)->findOneBy(['name' => 'Nutzer']) ?? new Role();
$neu = !$rolle->getId();
$rolle->setName('Nutzer');
$rolle->setDescription('Accounts that sign in through the cell');
$rolle->setIsAdmin(false);
$rollen->setRolePermissions($rolle, $rechte);
$rollen->saveEntity($rolle);
if (!$rolle->getId()) {
    fwrite(STDERR, "MAUTIC FEHLER: Rolle Nutzer nicht gespeichert\n");
    exit(1);
}

// 2. Login via Authentik, mail via the cell's Stalwart — Mautic's config/local.php
$datei = '/var/www/html/config/local.php';
$parameters = [];
include $datei;
$dom = getenv('ZELLE_DOMAIN');
$meta = getenv('MAUTIC_IDP_METADATA_B64');
if (!$meta || !str_contains((string) base64_decode($meta), 'EntityDescriptor')) {
    fwrite(STDERR, "MAUTIC FEHLER: keine IdP-Metadaten von Authentik\n");
    exit(1);
}
$parameters = array_merge($parameters, [
    'saml_idp_metadata'            => $meta,                 // base64, as Mautic stores it
    'saml_idp_username_attribute'  => 'username',            // names of the Authentik
    'saml_idp_email_attribute'     => 'email',               // property mappings
    'saml_idp_firstname_attribute' => 'firstname',           // (bootstrap_authentik.py)
    'saml_idp_lastname_attribute'  => 'lastname',
    'saml_idp_default_role'        => $rolle->getId(),
    // Behind the cell's Caddy (TLS ends there). Mautic has no host port, so every request
    // comes through Caddy — without this its SAML routes, which require https, redirect
    // to themselves forever. (Mautic reads this only from local.php, not from the env.)
    'trusted_proxies'              => ['0.0.0.0/0'],
    // Own mailbox mautic@<domain> with login (provision_mail.sh) — without login Stalwart
    // only delivers to the cell's own mailboxes, a newsletter needs to go out. Implicit TLS
    // on 465; Stalwart's internal certificate is self-signed for "localhost", so no peer
    // check — the connection never leaves the Docker bridge on this server.
    'mailer_dsn'                   => getenv('MAUTIC_MAIL_PASSWORD')
        ? 'smtps://'.rawurlencode("mautic@$dom").':'.rawurlencode(getenv('MAUTIC_MAIL_PASSWORD')).'@stalwart:465?verify_peer=0'
        : 'smtp://stalwart:25',
    'mailer_from_email'            => "mautic@$dom",
    'mailer_from_name'             => getenv('CLARAOS_PRODUCT_NAME') ?: 'NolaniOS',
]);
file_put_contents($datei, "<?php\n\$parameters = ".var_export($parameters, true).";\n");

echo 'MAUTIC Rolle Nutzer '.($neu ? 'angelegt' : 'aktuell').' ('.count($rechte)." Bereiche, ohne Verwaltung)\n";
echo "MAUTIC Anmeldung über die Zelle (SAML) eingerichtet\n";
