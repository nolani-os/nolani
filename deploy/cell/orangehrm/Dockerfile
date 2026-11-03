# OrangeHRM for a cell: the official image with its OpenID Connect login made usable for
# a cell. Patched at BUILD time, and every patch fails the build if its anchor is gone —
# an OrangeHRM update that no longer fits shows up here, not as a broken login.
#
#   - OpenIdConnectRedirectController.php: OrangeHRM only links an OIDC login to an
#     EXISTING user. This copy creates employee + user (role ESS) on the first login
#     through the cell. Identical to OrangeHRM 5.9's file plus that addition (5.8.1 and
#     5.9 ship the same original).
#   - SocialMediaAuthenticationService.php: asks for `email profile` instead of `email`
#     (names for the new employee).
#   - Login page: straight to the only OIDC provider (escape: /auth/login?local=1, the
#     password form for the local Admin); after logout back to that form, so the SSO
#     session can be left. No `prompt=consent` (Authentik asked every time).
#   - index.php: trust the cell's Caddy for https detection (Docker networks only).
FROM orangehrm/orangehrm:5.9@sha256:d692780efbb118b1ede754cfb153057baecf4c4c5f84627621ed015cf837ac28

ARG P=/var/www/html/src/plugins
COPY OpenIdConnectRedirectController.php $P/orangehrmOpenidAuthenticationPlugin/Controller/OpenIdConnectRedirectController.php
COPY SocialMediaAuthenticationService.php $P/orangehrmOpenidAuthenticationPlugin/Service/SocialMediaAuthenticationService.php

RUN set -e; \
    L=$P/orangehrmOpenidAuthenticationPlugin/Controller/OpenIdConnectLoginController.php; \
    grep -q "getGeneratedAuthUrl() . '&prompt=consent'" "$L"; \
    sed -i "s|getGeneratedAuthUrl() \. '&prompt=consent'|getGeneratedAuthUrl()|" "$L"; \
    \
    L=$P/orangehrmAuthenticationPlugin/Controller/LoginController.php; \
    grep -q 'return parent::handle($request);' "$L"; \
    perl -0777 -pi -e 's/([ \t]*)return parent::handle\(\$request\);/\1\/\/ Cell: straight to the only OIDC provider (escape: ?local=1).\n\1if (\$request->query->get("local") !== "1" \&\& !\$this->getAuthUser()->hasFlash(AuthUser::FLASH_LOGIN_ERROR)) {\n\1    \$zelleOidc = \$this->getProvidersList();\n\1    if (count(\$zelleOidc) === 1) {\n\1        return \$this->redirect("openidauth\/openIdCredentials\/" . \$zelleOidc[0]->getId());\n\1    }\n\1}\n\1return parent::handle(\$request);/' "$L"; \
    grep -q 'zelleOidc' "$L"; \
    \
    L=$P/orangehrmAuthenticationPlugin/Controller/LogoutController.php; \
    grep -q 'redirect("auth/login")' "$L"; \
    sed -i 's|redirect("auth/login")|redirect("auth/login?local=1")|' "$L"; \
    \
    L=/var/www/html/web/index.php; \
    grep -q '^\$request = Request::createFromGlobals();' "$L"; \
    sed -i 's|^\$request = Request::createFromGlobals();|// Cell: trust the Caddy in front (Docker networks) for https detection\nRequest::setTrustedProxies(["172.16.0.0/12", "10.0.0.0/8", "127.0.0.1"], Request::HEADER_X_FORWARDED_FOR \| Request::HEADER_X_FORWARDED_HOST \| Request::HEADER_X_FORWARDED_PORT \| Request::HEADER_X_FORWARDED_PROTO);\n$request = Request::createFromGlobals();|' "$L"; \
    grep -q 'setTrustedProxies' "$L"; \
    php -l "$L" >/dev/null; \
    for f in $P/orangehrmOpenidAuthenticationPlugin/Controller/*.php $P/orangehrmOpenidAuthenticationPlugin/Service/*.php \
             $P/orangehrmAuthenticationPlugin/Controller/LoginController.php $P/orangehrmAuthenticationPlugin/Controller/LogoutController.php; do \
      php -l "$f" >/dev/null; \
    done; \
    chown -R www-data:www-data $P/orangehrmOpenidAuthenticationPlugin $P/orangehrmAuthenticationPlugin /var/www/html/web/index.php
