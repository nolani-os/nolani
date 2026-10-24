#!/bin/bash
# Browser audio, part 2 of 2; see pulse-fix-init.sh for the background.
# Mounted as /defaults/autostart_wayland; init-selkies-config copies the file
# to $HOME/.config/labwc/autostart on first start.
#
# Why the environment is set here and not in docker-compose.yml:
# there PULSE_RUNTIME_PATH would apply container-wide, and a libpulse client
# running as **root** (pcmflux in the Selkies service) would take over the
# directory as root:0700 on first access (root may chown). After that abc can
# no longer reach its own socket: Chromium silently falls back to a dummy device,
# no sink-input is ever created and the stream stays silent. A client path of
# Chromium's own avoids the race; the daemon keeps the image default
# (/defaults) so svc-selkies still finds its start barrier /defaults/pid.
export PULSE_RUNTIME_PATH=/tmp/pulse-abc
export PULSE_SERVER=unix:/defaults/native

# Permanent capture device. Without it PulseAudio only has the two monitor
# sources here, which Chromium does NOT count as microphones: enumerateDevices
# returns an empty list and getUserMedia fails with NotFoundError (sites then
# report the microphone as switched off). The real source `SelkiesVirtualMic` is
# only created by the Selkies server on the FIRST microphone packet and unloaded
# again on disconnect, so a page that asks for the microphone first finds nothing.
# `ClaraMic` hangs off the same master (input.monitor) and therefore carries the
# same voice as soon as the user enables the microphone in the Selkies bar;
# before that it delivers silence instead of an error.
# The name is deliberately NOT `SelkiesVirtualMic`: on disconnect the server
# unloads the module of that name and would take our permanent source with it.
for _ in $(seq 1 30); do
  pactl list short sources 2>/dev/null | grep -q 'input.monitor' && break
  sleep 1
done
if ! pactl list short sources 2>/dev/null | grep -q 'ClaraMic'; then
  pactl load-module module-remap-source \
    source_name=ClaraMic master=input.monitor \
    source_properties=device.description=Mikrofon >/dev/null 2>&1 \
    && echo "[pulse-fix] ClaraMic angelegt"
fi
pactl set-default-source ClaraMic >/dev/null 2>&1

wrapped-chromium --enable-features=UseOzonePlatform --ozone-platform=wayland ${CHROME_CLI}
