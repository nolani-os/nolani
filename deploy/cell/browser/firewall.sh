#!/bin/sh
# Egress fence for the personal browsers of a cell — runs as root at boot
# (claraos-browser-firewall.service) and from setup.sh. Idempotent.
#
# Every browser lives in its own network from the pool $POOL (one /24 per user,
# browser/ctl.py). Strangers browse from there, so:
#   * the internet: yes (that is the point of a browser);
#   * private ranges (other containers, the cell network, Hetzner's private
#     network), CGNAT and link-local — in particular the cloud metadata service
#     169.254.169.254, which hands out the server's cloud-init data — : no;
#   * the server itself via its gateway address (sshd, …): no.
# Allowed exception: the cell's OWN public sites (reached via the public IP, DNAT
# to Caddy) — a user may open home.<domain> inside the browser.
# Traffic inside one user's network (browser <-> Caddy/API) stays allowed; Docker
# keeps different user networks apart on its own.
set -eu
POOL=${BROWSER_POOL:-10.250.0.0/16}
CHAIN=CLARAOS-BROWSER
PUB=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')

iptables -N DOCKER-USER 2>/dev/null || true
iptables -N $CHAIN 2>/dev/null || true
iptables -F $CHAIN
iptables -A $CHAIN -d "$POOL" -j RETURN                                   # own network
[ -n "$PUB" ] && iptables -A $CHAIN -m conntrack --ctorigdst "$PUB" -j RETURN   # cell's own sites
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 \
           127.0.0.0/8 224.0.0.0/4 0.0.0.0/8; do
  iptables -A $CHAIN -d "$net" -j DROP
done
iptables -A $CHAIN -j RETURN

# Hook into DOCKER-USER (forwarded traffic) exactly once, at the top.
while iptables -C DOCKER-USER -s "$POOL" -j $CHAIN 2>/dev/null; do
  iptables -D DOCKER-USER -s "$POOL" -j $CHAIN
done
iptables -I DOCKER-USER 1 -s "$POOL" -j $CHAIN

# The host itself (INPUT): browsers reach their gateway address — block everything
# except replies. Published ports (Caddy 80/443) are DNATed and pass through
# FORWARD, not INPUT, so they keep working.
while iptables -C INPUT -s "$POOL" -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP 2>/dev/null; do
  iptables -D INPUT -s "$POOL" -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP
done
iptables -I INPUT 1 -s "$POOL" -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP
echo "Browser-Zaun: $POOL → nur Internet${PUB:+ + eigene Seiten ($PUB)}"
