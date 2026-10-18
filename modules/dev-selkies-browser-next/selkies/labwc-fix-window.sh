#!/bin/bash
# Pin the browser window in the stream.
#
# `custom_chrome_frame=false` (chromium-frame-init.sh) removes Chromium's own
# window BUTTONS, but the window could still be moved: dragging the tab strip
# makes Chromium send a move request to the compositor, and labwc executes it.
# Moving makes no sense in a stream: the picture matches the window size
# exactly, a moved window leaves black borders and shifts all click coordinates.
#
# labwc (0.9.7 here) can make windows immovable by rule:
#   fixedPosition="yes" → no interactive move/resize.
# Together with the existing maximise rule the window stays full-screen at 0,0.
#
# Idempotent on every container start (rc.xml lives in the /config volume and
# is only created by the image if it is missing).
RC="/config/.config/labwc/rc.xml"
[ -f "$RC" ] || exit 0

python3 - "$RC" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
if 'fixedPosition="yes"' in src:
    sys.exit(0)                                   # already set

# Additionally pin all browser rules (serverDecoration="no").
patched, count = re.subn(
    r'(<windowRule identifier="(?:brave|chrome|chromium-browser|chromium|'
    r'firefox-esr|firefox|google-chrome|librewolf|mullvad-browser|opera-bin|'
    r'opera|vivaldi|wrapped-chromium|zen)" serverDecoration="no")( />)',
    r'\1 fixedPosition="yes"\2', src)
if not count:
    sys.exit(0)
open(path, "w", encoding="utf-8").write(patched)
print(f"[labwc-fix] {count} Browser-Fensterregel(n) auf fixedPosition gesetzt")
PY

chown abc:abc "$RC" 2>/dev/null || true
