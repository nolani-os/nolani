# Mautic for a cell: the official image plus the three libraries its email editor needs.
#
# Mautic 7.2's email validation (EmailBundle/Validator/ValidEmailLinksValidator) uses
# symfony/dom-crawler (filtering with symfony/css-selector), but the package does not require
# them and the image does not ship them:
# saving ANY email — in Mautic's own editor as well as through the API — ends in a 500
# ("Class Symfony\Component\DomCrawler\Crawler not found"). Newsletters were impossible.
#
# Not through composer: a composer run inside the image rewrote the autoloading of Mautic's
# core (core-lib paths, `include(/config/paths.php)` failed). Instead the libraries come as
# pinned release archives (checksums below) and get their own PSR-4 autoloader, prepended
# to every PHP run. Mautic's dependency tree stays exactly as built upstream; drop this
# image once Mautic ships the libraries itself.
FROM mautic/mautic:7.2.0-apache@sha256:dea3bb71a5c5bf4c0c7d1764e58a32109898e7b2e6a710f14f50e2a913c03a0f

# symfony/dom-crawler 7.4.22, symfony/css-selector 7.4.22 and masterminds/html5 2.12.0 (all MIT);
# polyfill-ctype, polyfill-mbstring and deprecation-contracts are already in Mautic's vendor.
ADD --checksum=sha256:53c786f96b338f0ecfa9732a22ac238feaca3b4d9cb1c54cbd6a39b6aec8eeb9 \
    https://github.com/symfony/dom-crawler/archive/refs/tags/v7.4.22.tar.gz /tmp/dom-crawler.tar.gz
ADD --checksum=sha256:ef4a049b843a2b34290e772f2a51d05ce42b6b9702e39e7e95afecb3a22a290e \
    https://github.com/Masterminds/html5-php/archive/refs/tags/2.12.0.tar.gz /tmp/html5.tar.gz
ADD --checksum=sha256:a16fe5eb78d8aeb4bc84181bba6c2f8964297e8fedcfddd36cac0febb87e0e19 \
    https://github.com/symfony/css-selector/archive/refs/tags/v7.4.22.tar.gz /tmp/css-selector.tar.gz
COPY zelle-autoload.php /opt/zelle-php/autoload.php

RUN set -eu; \
    mkdir -p /opt/zelle-php/dom-crawler /opt/zelle-php/css-selector /opt/zelle-php/html5; \
    tar -xzf /tmp/dom-crawler.tar.gz -C /opt/zelle-php/dom-crawler --strip-components=1; \
    tar -xzf /tmp/css-selector.tar.gz -C /opt/zelle-php/css-selector --strip-components=1; \
    tar -xzf /tmp/html5.tar.gz -C /opt/zelle-php/html5 --strip-components=1; \
    rm -rf /tmp/*.tar.gz /opt/zelle-php/dom-crawler/Tests /opt/zelle-php/css-selector/Tests /opt/zelle-php/html5/test; \
    test -f /opt/zelle-php/dom-crawler/Crawler.php; \
    test -f /opt/zelle-php/html5/src/HTML5.php; \
    echo "auto_prepend_file=/opt/zelle-php/autoload.php" > /usr/local/etc/php/conf.d/zz-zelle-autoload.ini; \
    php -r 'require "/var/www/html/vendor/autoload.php"; require "/opt/zelle-php/autoload.php"; (new Symfony\Component\DomCrawler\Crawler("<p><a href=\"x\">ok</a></p>"))->filter("a")->count() === 1 || exit(1);' \
      && echo "dom-crawler: ok"
