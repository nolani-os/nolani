/* ClaraOS fixes for the desktop chromeless dashboard.
 *
 * Must run BEFORE the Selkies core (plain script = immediately, the core is a
 * deferred module): it patches constructors the core uses.
 *
 * 1. CLIPBOARD PRIMER: Ctrl+V would otherwise never work. The core reads the
 *    local clipboard on window focus ONLY if the clipboard-read permission is
 *    already 'granted' (navigator.permissions.query + onchange); it never
 *    requests it, and without a user gesture it may not. Result: a silent
 *    permanent failure. Here: call readText() on the first real gesture, so the
 *    browser shows the permission prompt; after the grant fire a focus event
 *    right away so the core syncs immediately (its onchange only sets state).
 * 2. STREAM WATCHDOG: the data WebSocket can drop silently (laptop standby,
 *    network hiccup), the picture freezes and there is no auto-reconnect.
 * 3. AUDIO UNLOCK: the AudioContext autoplay block floods the console
 *    (~15 warnings/s); resuming on the first gesture ends that and enables sound.
 */
(function () {
  "use strict";

  // ── 1. Clipboard-Primer ───────────────────────────────────────────────
  var primed = false;
  function primeClipboard() {
    if (primed || !navigator.clipboard || !window.isSecureContext) return;
    primed = true;
    var afterGrant = function () {
      // Trigger the core's focus path right away (it listens for window focus).
      window.dispatchEvent(new Event("focus"));
    };
    navigator.clipboard.readText().then(afterGrant, function (err) {
      // 'denied' stays silent (the user has decided); for 'prompt' the call
      // itself makes the browser show its dialog.
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: "clipboard-read" }).then(function (st) {
          st.onchange = function () {
            if (st.state === "granted") afterGrant();
          };
        }).catch(function () { /* browser without a clipboard-read query */ });
      }
    });
  }
  ["pointerdown", "keydown"].forEach(function (ev) {
    window.addEventListener(ev, primeClipboard, { capture: true, passive: true });
  });

  // ── 2. Stream watchdog (same pattern as the mobile dashboard) ─────────
  var dataSockets = [];
  var NativeWS = window.WebSocket;
  function reloadAllowed() {
    try {
      var hits = JSON.parse(window.sessionStorage.getItem("claraos_wd") || "[]")
        .filter(function (ts) { return Date.now() - ts < 120000; });
      if (hits.length >= 4) return false;
      hits.push(Date.now());
      window.sessionStorage.setItem("claraos_wd", JSON.stringify(hits));
      return true;
    } catch (e) { return true; }
  }
  function reconnect() {
    if (!reloadAllowed()) return;
    setTimeout(function () { window.location.reload(); }, 900);
  }
  window.WebSocket = function (url, protocols) {
    var ws = protocols !== undefined
      ? new NativeWS(url, protocols) : new NativeWS(url);
    try {
      dataSockets.push(ws);
      ws.addEventListener("close", function () {
        setTimeout(function () {
          var alive = dataSockets.some(function (s) {
            return s.readyState === NativeWS.OPEN;
          });
          if (!alive && !document.hidden) reconnect();
        }, 1200);
      });
    } catch (e) { /* observing is optional */ }
    return ws;
  };
  window.WebSocket.prototype = NativeWS.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
    window.WebSocket[k] = NativeWS[k];
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    setTimeout(function () {
      var alive = dataSockets.some(function (s) {
        return s.readyState === NativeWS.OPEN;
      });
      if (!alive) reconnect();
    }, 800);
  });

  // ── 2b. Stream geometry ────────────────────────────────────
  // Manual mode with the real window size (the overlay is only a floating
  // button dock and takes NO height; chromeHeight remains as a hook for bars
  // that do). The preset in localStorage MUST be in place before the core
  // loads (it reads its start values from there).
  (function () {
    var chromeH = (window.CLARAOS_CONFIG || {}).chromeHeight || 0;
    function apply() {
      try {
        var dpr = window.devicePixelRatio || 1;
        var w = Math.floor((window.innerWidth * dpr) / 2) * 2;
        var h = Math.floor(((window.innerHeight - chromeH) * dpr) / 2) * 2;
        if (!(w > 0 && h > 0)) return null;
        var p = (window.location.origin + window.location.pathname)
          .replace(/[^a-zA-Z0-9._-]/g, "_");
        window.localStorage.setItem(p + "_is_manual_resolution_mode", "true");
        window.localStorage.setItem(p + "_manual_width", String(w));
        window.localStorage.setItem(p + "_manual_height", String(h));
        window.localStorage.setItem(p + "_scaleLocallyManual", "true");
        return { w: w, h: h };
      } catch (e) { return null; }
    }
    apply();
    var t = null;
    window.addEventListener("resize", function () {
      clearTimeout(t);
      t = setTimeout(function () {
        var g = apply();
        if (!g) return;
        var o = window.location.origin;
        window.postMessage({ type: "setScaleLocally", value: true }, o);
        window.postMessage({ type: "setManualResolution", width: g.w, height: g.h }, o);
      }, 500);
    });
  })();

  // ── 2c. Double mouse pointer ──────────────────
  // Selkies paints the pointer into the stream. When the real pointer leaves
  // the window, the painted one stays behind → two pointers. The server
  // setting `use_browser_cursors` fixes that (pointer as CSS/DIV, hidden on
  // leave), BUT the client prefers its localStorage value, which may still
  // hold `false` from an earlier visit. Hence force it here before the core loads.
  (function () {
    try {
      var p = (window.location.origin + window.location.pathname)
        .replace(/[^a-zA-Z0-9._-]/g, "_");
      window.localStorage.setItem(p + "_use_browser_cursors", "true");
    } catch (e) { /* localStorage blocked: the server default applies */ }
  })();

  // ── 3. Audio unlock ───────────────────────────────────────────────────
  var contexts = [];
  ["AudioContext", "webkitAudioContext"].forEach(function (name) {
    var Native = window[name];
    if (!Native) return;
    var Wrapped = function () {
      var ctx = arguments.length ? new Native(arguments[0]) : new Native();
      contexts.push(ctx);
      return ctx;
    };
    Wrapped.prototype = Native.prototype;
    window[name] = Wrapped;
  });
  function unlockAudio() {
    contexts.forEach(function (ctx) {
      if (ctx.state === "suspended") {
        ctx.resume().catch(function () { /* the next gesture tries again */ });
      }
    });
  }
  ["pointerup", "keydown", "touchend"].forEach(function (ev) {
    window.addEventListener(ev, unlockAudio, { capture: true, passive: true });
  });
})();
