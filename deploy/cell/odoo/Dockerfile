# Odoo 18 Community for a cell, with OCA auth_oidc (login via the cell's Authentik).
#
# Why auth_oidc and not Odoo's own auth_oauth: auth_oauth only knows the implicit
# flow with `response_type=token`, which Authentik (OIDC only) does not offer.
# auth_oidc adds the authorization code flow with PKCE.
#
# Everything is pinned: the Odoo image (same digest as the tested home module) and
# the OCA source by commit + checksum. Nothing is installed at container start.
FROM odoo@sha256:b79d87a4ec1a3806d133e12a07dc06402fc37397eb285663b1acfea2001ae52c

ARG OCA_ADDONS_COMMIT=7c976b75476d297f8b3eb75f36c093a1a9131f27
ARG OCA_ADDONS_SHA256=4a41e519cb70f4a78d25d963e82daa233f42ee9d93d37e4fd89846f48b2c0e24

USER root
RUN set -eu; \
    pip3 install --no-cache-dir --break-system-packages "python-jose[cryptography]==3.5.0"; \
    curl -fsSL -o /tmp/sa.tgz "https://github.com/OCA/server-auth/archive/${OCA_ADDONS_COMMIT}.tar.gz"; \
    echo "${OCA_ADDONS_SHA256}  /tmp/sa.tgz" | sha256sum -c -; \
    mkdir -p /mnt/oca-addons; \
    tar -xzf /tmp/sa.tgz -C /mnt/oca-addons --strip-components=1 "server-auth-${OCA_ADDONS_COMMIT}/auth_oidc"; \
    rm /tmp/sa.tgz; \
    chown -R odoo:odoo /mnt/oca-addons
# The cell's own module: an API key for one user, issued by the admin (claraos_zugang/)
COPY --chown=odoo:odoo claraos_zugang /mnt/oca-addons/claraos_zugang
USER odoo
