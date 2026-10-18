#!/usr/bin/with-contenv bash
# Install wlrctl on top: a prerequisite for human_input.
#
# WHY: `wtype` delivers keystrokes only to the surface the compositor has focused.
# Without a way to set that focus, input silently goes nowhere after every tab
# switch. `wlrctl` can do it (wlroots-native, labwc is wlroots-based). `xdotool`
# is out (does not reach Wayland windows), so is `ydotool` (needs /dev/uinput,
# which the container lacks).
#
# Why here and not in the image: the base image is pulled by digest (no build of
# our own). An init script keeps the change visible and reversible instead of
# maintaining a derived image plus registry.
set -euo pipefail

if command -v wlrctl >/dev/null 2>&1; then
  echo "[wlrctl-init] bereits vorhanden — nichts zu tun"
  exit 0
fi

echo "[wlrctl-init] installiere wlrctl …"
export DEBIAN_FRONTEND=noninteractive
if apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq wlrctl >/dev/null 2>&1; then
  echo "[wlrctl-init] ok: $(wlrctl --version 2>&1 | head -1)"
else
  # No `exit 1`: without wlrctl only the keyboard remote control is missing,
  # the browser itself keeps working. A hard failure would stop the container
  # from starting because of a side feature.
  echo "[wlrctl-init] FEHLGESCHLAGEN (kein Netz/Repo?) — human_input bleibt inaktiv" >&2
fi
