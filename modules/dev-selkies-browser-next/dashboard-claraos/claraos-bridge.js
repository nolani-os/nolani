/* ClaraOS bridge for the chromeless dashboard.
 *
 * Two jobs:
 * 1. Parent bridge: the Selkies core accepts postMessage ONLY from the same
 *    origin. The ClaraOS shell (cross-origin, the iframe parent) sends commands
 *    to this window; we check origin + allowlist and relay them same-origin
 *    to the core.
 * 2. Mobile fallback UI: small floating buttons for the on-screen keyboard and
 *    a touch/trackpad toggle, only shown for coarse pointers (phone/tablet), so
 *    the dashboard stays fully usable even when opened without the shell.
 */
(function () {
  "use strict";

  // The shell lives next to the browser host: browser[-m].<domain> → home.<domain>.
  // Derived at runtime so the same files serve every deployment (home, cells).
  var PARENT_ORIGINS = [
    "https://home." + location.hostname.replace(/^[^.]+\./, ""),  // ClaraOS shell
    location.origin,                                                // direct call (same-origin)
  ];

  // Only harmless UI/input commands; deliberately NO 'command'/'settings'.
  var ALLOWED_TYPES = [
    "showVirtualKeyboard",
    "touchinput:touch",
    "touchinput:trackpad",
    "requestFullscreen",
    "resetResolutionToWindow",
    "setManualResolution",
    "setUseCssScaling",
    "setScaleLocally",
    "setVolume",
    "setMute",
  ];

  function relayToCore(msg) {
    window.postMessage(msg, window.location.origin);
  }

  window.addEventListener("message", function (event) {
    if (PARENT_ORIGINS.indexOf(event.origin) === -1) return;
    if (event.origin === window.location.origin) return; // core-internal messages
    var d = event.data;
    if (!d || d.claraos !== true || typeof d.type !== "string") return;
    if (ALLOWED_TYPES.indexOf(d.type) === -1) return;
    var msg = {};
    for (var k in d) if (k !== "claraos") msg[k] = d[k];
    relayToCore(msg);
  });

  // Let the shell know that the bridge is alive.
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ claraos: true, type: "claraos:bridge-ready" }, "*");
    }
  } catch (e) { /* ignore */ }

  // ── Mobile fallback UI ────────────────────────────────────────────────
  // In mobile-hybrid mode claraos-touch-cdp.js provides the UI (CDP keyboard
  // instead of the Selkies keysym path), so no duplicate buttons here.
  if ((window.CLARAOS_CONFIG || {}).mode === "mobile-hybrid") return;
  var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (!coarse) return;

  var touchMode = "touch"; // mobile default: direct touch

  function makeBtn(label, title, bottom) {
    var b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.style.cssText =
      "position:fixed;right:10px;bottom:" + bottom + "px;z-index:2147483000;" +
      "width:44px;height:44px;border-radius:22px;border:none;" +
      "background:rgba(30,30,30,.55);color:#fff;font-size:20px;" +
      "backdrop-filter:blur(4px);touch-action:manipulation;";
    document.body.appendChild(b);
    return b;
  }

  function init() {
    var kbd = makeBtn("⌨", "Bildschirmtastatur", 10);
    kbd.addEventListener("click", function () {
      relayToCore({ type: "showVirtualKeyboard" });
    });
    var mode = makeBtn("👆", "Touch/Trackpad umschalten", 62);
    mode.addEventListener("click", function () {
      touchMode = touchMode === "touch" ? "trackpad" : "touch";
      mode.textContent = touchMode === "touch" ? "👆" : "🖱";
      relayToCore({ type: "touchinput:" + touchMode });
    });
    // Set the default mode once the core is up.
    setTimeout(function () { relayToCore({ type: "touchinput:touch" }); }, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
