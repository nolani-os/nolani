/* ClaraOS dashboard configuration (mobile variant): enables the CDP touch hybrid.
 *
 * Loaded as the FIRST script (before selkies-core), so it also hosts the two
 * instrumentations that must run before the core constructors exist:
 * the stream watchdog (WebSocket) and the audio unlock (AudioContext).
 */
window.CLARAOS_CONFIG = {
  mode: "mobile-hybrid",
  // Must match --force-device-scale-factor in docker-compose.yml.
  // 2.16 instead of a real phone density: Chromium's minimum window width is
  // 500 CSS px, and 1080/2.16 = exactly 500, so window == screen == stream.
  streamDsf: 2.16,
  // Height of the Chrome-Mobile-style top bar in CSS px (see index.html + touch-cdp).
  topBarHeight: 56,
};

/* Set the stream resolution BEFORE the core starts.
 *
 * The Selkies core reads its initial values from localStorage on load
 * (prefix = origin+pathname, see storageAppName in selkies-ws-core.js). The
 * server additionally enforces `true|locked` 1080x2160; the values written here
 * are the client's actual request and act as a fallback if the lock is lifted.
 * In manual mode the core sends the values as-is (no dpr multiplication),
 * hence CSS px × devicePixelRatio; alignResolution rounds to even numbers.
 */
(function () {
  "use strict";
  function apply() {
    try {
      var p = (window.location.origin + window.location.pathname)
        .replace(/[^a-zA-Z0-9._-]/g, "_");
      // Manual mode for ALL clients: in auto mode the core would send its own
      // resize requests derived from the canvas size (feedback loop).
      window.localStorage.setItem(p + "_is_manual_resolution_mode", "true");
      // Fit the canvas into the window: absorbs small mismatches (rounding,
      // browser UI showing up, top bar) instead of letting the image overflow.
      window.localStorage.setItem(p + "_scaleLocallyManual", "true");
      var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      if (coarse) {
        // Only phones/tablets decide the stream size; a desktop tab (e.g. a
        // diagnostic viewer) must not change the resolution of the phone.
        var dpr = window.devicePixelRatio || 1;
        var barH = (window.CLARAOS_CONFIG || {}).topBarHeight || 56;
        var w = Math.floor((window.innerWidth * dpr) / 2) * 2;
        // Usable area = window minus top bar (#app starts at barH).
        var h = Math.floor(((window.innerHeight - barH) * dpr) / 2) * 2;
        if (!(w > 0 && h > 0)) return;
        window.localStorage.setItem(p + "_manual_width", String(w));
        window.localStorage.setItem(p + "_manual_height", String(h));
        window.CLARAOS_CONFIG.streamGeometry = { w: w, h: h, dpr: dpr };
      } else if (!window.localStorage.getItem(p + "_manual_width")) {
        // Desktop viewer without stored values: neutral phone-sized fallback so
        // the core reports something sensible in manual mode.
        window.localStorage.setItem(p + "_manual_width", "1080");
        window.localStorage.setItem(p + "_manual_height", "2160");
      }
    } catch (e) { /* localStorage blocked: core stays in auto mode */ }
  }
  apply();

  // After a rotation the geometry no longer fits: rewrite the values and let
  // the client reconnect (costs ~2 s, but everything matches afterwards).
  var t = null;
  window.addEventListener("orientationchange", function () {
    clearTimeout(t);
    t = setTimeout(function () {
      var before = window.CLARAOS_CONFIG.streamGeometry || {};
      apply();
      var after = window.CLARAOS_CONFIG.streamGeometry || {};
      if (before.w !== after.w || before.h !== after.h) window.location.reload();
    }, 900);
  });
})();

/* ── Stream watchdog ────────────────────────────────────────────────────────
 * The Selkies data WebSocket can drop silently (device locked, app switch,
 * network glitch): the image freezes, touch appears dead, and the core does
 * NOT reconnect by itself. So: observe every WebSocket except the CDP relay;
 * when the data socket goes away, reload the page in a controlled way
 * (rate-limited so a dead server cannot cause a reload loop).
 */
(function () {
  "use strict";
  var dataSockets = [];
  var NativeWS = window.WebSocket;
  function ReconnectingLimiter() {
    try {
      var raw = window.sessionStorage.getItem("claraos_wd") || "[]";
      var hits = JSON.parse(raw).filter(function (ts) {
        return Date.now() - ts < 120000; // window: 2 min
      });
      if (hits.length >= 4) return false; // at most 4 reloads per 2 min
      hits.push(Date.now());
      window.sessionStorage.setItem("claraos_wd", JSON.stringify(hits));
      return true;
    } catch (e) {
      return true;
    }
  }
  function toast(text) {
    var el = document.getElementById("claraos-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "claraos-toast";
      el.setAttribute("data-claraos-ui", "1");
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.className = "visible";
  }
  function reconnect(reason) {
    if (!ReconnectingLimiter()) {
      toast("Verbindung verloren — bitte Seite manuell neu laden");
      return;
    }
    toast("Verbindung wird wiederhergestellt …");
    setTimeout(function () { window.location.reload(); }, 900);
  }
  window.WebSocket = function (url, protocols) {
    var ws = protocols !== undefined
      ? new NativeWS(url, protocols) : new NativeWS(url);
    try {
      if (String(url).indexOf("/claraos-cdp") === -1) {
        dataSockets.push(ws);
        ws.addEventListener("close", function () {
          // Only react when NO other data socket is still open
          // (the core legitimately closes sockets when switching modes).
          setTimeout(function () {
            var alive = dataSockets.some(function (s) {
              return s.readyState === NativeWS.OPEN;
            });
            if (!alive && !document.hidden) reconnect("ws-close");
          }, 1200);
        });
      }
    } catch (e) { /* observation is best-effort */ }
    return ws;
  };
  window.WebSocket.prototype = NativeWS.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
    window.WebSocket[k] = NativeWS[k];
  });

  // Returning to the app (device unlocked, tab in front again): check the state.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    setTimeout(function () {
      var alive = dataSockets.some(function (s) {
        return s.readyState === NativeWS.OPEN;
      });
      if (!alive) reconnect("visibility");
    }, 800);
  });
})();

/* ── Audio unlock ───────────────────────────────────────────────────────────
 * The core starts its AudioContext without a user gesture, so autoplay policy
 * blocks it and the retry floods the console (~15 warnings per second).
 * Collect the instances and resume them on the FIRST real gesture; this stops
 * the flood and enables stream audio.
 */
(function () {
  "use strict";
  var contexts = [];
  ["AudioContext", "webkitAudioContext"].forEach(function (name) {
    var Native = window[name];
    if (!Native) return;
    var Wrapped = function () {
      var ctx = arguments.length
        ? new Native(arguments[0]) : new Native();
      contexts.push(ctx);
      return ctx;
    };
    Wrapped.prototype = Native.prototype;
    window[name] = Wrapped;
  });
  function unlock() {
    contexts.forEach(function (ctx) {
      if (ctx.state === "suspended") {
        ctx.resume().catch(function () { /* the next gesture retries */ });
      }
    });
  }
  ["touchend", "pointerup", "keydown"].forEach(function (ev) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  });
})();
