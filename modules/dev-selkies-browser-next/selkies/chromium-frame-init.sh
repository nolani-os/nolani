#!/bin/bash
# Remove the window buttons from the stream.
#
# Problem: labwc deliberately draws NO decoration for Chromium
# (`serverDecoration="no"`). Chromium then paints ITS OWN window buttons
# (minimise/maximise/close) at the right of the tab strip and turns the strip
# into a drag area, so in the streamed picture the browser window could be
# moved or closed. Neither makes sense in a stream: moving breaks the fit with
# the video frame, closing ends the only browser (the watchdog restarts it, but
# the session is gone).
#
# Fix: switch Chromium to the SYSTEM title bar (`custom_chrome_frame = false`).
# Then it draws no buttons itself, and since labwc draws none either, there are
# none at all. The setting lives in the profile Preferences, so it is set
# idempotently on every container start (Chromium is not running yet at this
# point and therefore does not overwrite the file).
PREFS="/config/.config/chromium/Default/Preferences"
[ -f "$PREFS" ] || exit 0

python3 - "$PREFS" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)                      # broken/empty file: leave it alone
browser = data.setdefault("browser", {})
if browser.get("custom_chrome_frame") is False:
    sys.exit(0)                      # already set
browser["custom_chrome_frame"] = False
with open(path, "w") as fh:
    json.dump(data, fh, separators=(",", ":"))
print("[chromium-frame] Systemtitelleiste aktiviert (keine Fenster-Knoepfe im Stream)")
PY

chown abc:abc "$PREFS" 2>/dev/null || true
