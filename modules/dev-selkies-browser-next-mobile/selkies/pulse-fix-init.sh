#!/bin/bash
# Browser audio fix, part 1 of 2 (part 2 = selkies/autostart-wayland.sh).
#
# Problem in the lsio image: the PulseAudio daemon runs as `abc` and puts its
# socket under /defaults (the image's PULSE_RUNTIME_PATH), but /defaults is
# drwx------ root:root. **abc clients (Chromium!) can therefore never reach the
# socket.** Chromium's audio service then silently falls back to a dummy device:
# pages appear to play (AudioContext "running", webkitAudioDecodedByteCount
# rises), but no sink-input is ever created and the Selkies capture (pcmflux,
# source output.monitor) transmits silence.
#
# Only the access path is fixed here; autostart-wayland.sh sets the client
# environment. The daemon path deliberately stays the image default: svc-selkies
# waits, hard-wired, for /defaults/pid before it creates the null sinks and
# provides the Wayland socket. Moving it makes the service hang forever (no
# desktop, no Chromium).
chmod 755 /defaults

# Dedicated client runtime path for abc. Ephemeral (/tmp instead of /config): in
# the persistent volume the socket and `pid` survive a restart and an early root
# access flips the permissions; both lead to crash loops.
mkdir -p /tmp/pulse-abc
chown abc:abc /tmp/pulse-abc
chmod 700 /tmp/pulse-abc

echo "[pulse-fix] /defaults traversierbar + /tmp/pulse-abc angelegt (Browser-Audio)"
