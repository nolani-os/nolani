<?php
// PSR-4 autoloader for the three libraries the cell adds to Mautic (see Dockerfile):
// symfony/dom-crawler, symfony/css-selector and masterminds/html5. Prepended to every PHP run
// (auto_prepend_file); only answers for these three namespaces.
spl_autoload_register(static function (string $klasse): void {
    static $wurzeln = [
        'Symfony\\Component\\DomCrawler\\' => '/opt/zelle-php/dom-crawler/',
        'Symfony\\Component\\CssSelector\\' => '/opt/zelle-php/css-selector/',
        'Masterminds\\'                    => '/opt/zelle-php/html5/src/',
    ];
    foreach ($wurzeln as $praefix => $ordner) {
        if (str_starts_with($klasse, $praefix)) {
            $datei = $ordner.str_replace('\\', '/', substr($klasse, strlen($praefix))).'.php';
            if (is_file($datei)) {
                require $datei;
            }

            return;
        }
    }
});
