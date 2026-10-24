/* ClaraOS CDP touch hybrid (feature parity with the desktop variant).
 *
 * Selkies delivers video+audio; this script intercepts touch input BEFORE the
 * Selkies core interprets it as mouse input and sends it as REAL touch events
 * through the CDP relay to the streamed Chromium. In addition:
 * - Long press → context menu in Chrome-Mobile style (link/image/text/input).
 *   Chromium never synthesises a long press from CDP touches, so detection
 *   lives HERE (timer + movement threshold); actions run via relay probes.
 * - Tabs: counter button + card grid (ClaraOS.tabs.* in the relay).
 * - Menu: new tab, share, history, desktop site, clear browsing data,
 *   settings (search engine/home page).
 * Styles: index.html. Proxy keyboard: IME model via Input.insertText.
 */
(function () {
  "use strict";
  var cfg = window.CLARAOS_CONFIG || {};
  if (cfg.mode !== "mobile-hybrid") return;

  var DEFAULT_HOME = "https://start.duckduckgo.com";
  var SEARCH_ENGINES = {
    ddg: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
    google: { name: "Google", url: "https://www.google.com/search?q=%s" },
    ecosia: { name: "Ecosia", url: "https://www.ecosia.org/search?q=%s" },
    startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query=%s" },
  };
  function pref(key, fallback) {
    try { return window.localStorage.getItem("claraos_" + key) || fallback; }
    catch (e) { return fallback; }
  }
  function setPref(key, value) {
    try { window.localStorage.setItem("claraos_" + key, value); } catch (e) { /* ignore */ }
  }

  // ── Relay connection ─────────────────────────────────────────────────
  var ws = null;
  var msgId = 0;
  var pending = {};
  var wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host + "/claraos-cdp";

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = function () {
      applyDeviceMetrics();
      syncUrlPill();
      syncTabCount();
    };
    ws.onclose = function () { setTimeout(connect, 1500); };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* ignore */ } };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
    };
  }
  function send(method, params) { // fire-and-forget (lets events pipeline)
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ id: ++msgId, method: method, params: params || {} }));
    return true;
  }
  function call(method, params, timeoutMs) { // waits for the reply
    return new Promise(function (resolve) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve(null);
      var id = ++msgId;
      pending[id] = resolve;
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(function () { delete pending[id]; resolve(null); }, timeoutMs || 8000);
    });
  }

  // ── Geometry (window == screen == stream, DSF see compose file) ──
  var desktopMode = false;
  function applyDeviceMetrics() {
    send("Emulation.setDeviceMetricsOverride", {
      width: 0, height: 0, deviceScaleFactor: 0, mobile: !desktopMode,
    });
  }
  var lastGeom = { w: 0, h: 0 };
  function applyStreamResolution(force) {
    if (!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches)) return;
    if (document.activeElement === proxy || document.activeElement === urlInput) return;
    var dpr = window.devicePixelRatio || 1;
    var barH = cfg.topBarHeight || 56;
    var w = Math.round(window.innerWidth * dpr);
    var h = Math.round((window.innerHeight - barH) * dpr);
    if (!w || !h) return;
    if (!force && Math.abs(w - lastGeom.w) < 8 && Math.abs(h - lastGeom.h) < 8) return;
    lastGeom = { w: w, h: h };
    var o = window.location.origin;
    window.postMessage({ type: "setScaleLocally", value: true }, o);
    window.postMessage({ type: "setManualResolution", width: w, height: h }, o);
  }
  var geomTimer = null;
  function scheduleGeometry(delay) {
    clearTimeout(geomTimer);
    geomTimer = setTimeout(function () {
      applyDeviceMetrics();
      applyStreamResolution(false);
    }, delay);
  }
  setTimeout(function () { applyDeviceMetrics(); }, 3000);
  setTimeout(function () { applyDeviceMetrics(); }, 7000);
  window.addEventListener("resize", function () { scheduleGeometry(600); });
  window.addEventListener("orientationchange", function () { scheduleGeometry(900); });
  setInterval(function () {
    if (!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches)) return;
    if (document.activeElement === proxy || document.activeElement === urlInput) return;
    var el = streamCanvas();
    if (!el || !el.width) return;
    var dpr = window.devicePixelRatio || 1;
    var barH = cfg.topBarHeight || 56;
    var wantW = Math.round(window.innerWidth * dpr);
    var wantH = Math.round((window.innerHeight - barH) * dpr);
    if (Math.abs(el.width - wantW) > 8 || Math.abs((el.height || 0) - wantH) > 8) {
      lastGeom = { w: 0, h: 0 };
      applyStreamResolution(true);
    }
  }, 20000);
  connect();

  // ── Coordinates finger → stream CSS ──────────────────────────────────
  var DSF = cfg.streamDsf || 2.16; // must match --force-device-scale-factor
  function streamCanvas() {
    return document.querySelector("#app canvas, #app video, canvas, video");
  }
  /* Account for letterboxing: the canvas uses `object-fit: contain`. When the
   * stream's aspect ratio does not exactly match the element box, the browser
   * draws the image SMALLER and centres it while the element stays large.
   * Computing with the element size is therefore systematically off (visible
   * as selection handles one line too low and slightly shifted taps). */
  function streamBox() {
    var el = streamCanvas();
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    var natW = el.width || el.videoWidth || r.width;
    var natH = el.height || el.videoHeight || r.height;
    var scale = Math.min(r.width / natW, r.height / natH); // contain
    return {
      left: r.left + (r.width - natW * scale) / 2,
      top: r.top + (r.height - natH * scale) / 2,
      scale: scale,
    };
  }
  function toStream(clientX, clientY) {
    var b = streamBox();
    if (!b) return { x: Math.round(clientX), y: Math.round(clientY) };
    var x = (clientX - b.left) / b.scale / DSF;
    var y = (clientY - b.top) / b.scale / DSF;
    return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
  }
  function points(ev) {
    var arr = [];
    for (var i = 0; i < ev.touches.length; i++) {
      var t = ev.touches[i];
      var p = toStream(t.clientX, t.clientY);
      arr.push({ x: p.x, y: p.y, id: t.identifier % 10, force: t.force || 1 });
    }
    return arr;
  }

  // ── Touch capture including long press ───────────────────────────────
  function isOwnUi(t) {
    return t && t.closest && t.closest("[data-claraos-ui]") !== null;
  }
  var tapStart = null;   // tap detection (keyboard focus probe)
  var lpTimer = null;    // long-press timer
  var lpFired = false;   // long press fired → swallow the rest of the sequence
  function cancelLongPress() {
    clearTimeout(lpTimer);
    lpTimer = null;
  }
  function touchHandler(type) {
    return function (ev) {
      if (isOwnUi(ev.target)) return; // own UI handles its events normally
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (lpFired) {
        // After a long press fired: swallow the rest of the sequence, including
        // the long press's own touchEnd (otherwise closeAllOverlays would close
        // the freshly opened context sheet right away).
        if (type === "touchEnd" && ev.touches.length === 0) lpFired = false;
        return;
      }
      closeAllOverlays();
      if (type === "touchStart" && selActive) {
        // Hide handles/toolbar during scroll/tap; after touchEnd the selection
        // is queried again (scrolling keeps it, a tap collapses it).
        hideSelUi();
      }
      if (type === "touchStart") {
        if (ev.touches.length === 1) {
          var t0 = ev.touches[0];
          tapStart = { t: Date.now(), x: t0.clientX, y: t0.clientY };
          cancelLongPress();
          lpTimer = setTimeout(function () {
            lpTimer = null;
            onLongPress(tapStart.x, tapStart.y);
          }, 500);
        } else {
          cancelLongPress();
          tapStart = null;
        }
      } else if (type === "touchMove" && tapStart) {
        var m0 = ev.touches[0];
        if (m0 && (Math.abs(m0.clientX - tapStart.x) > 12 ||
                   Math.abs(m0.clientY - tapStart.y) > 12)) {
          tapStart = null;
          cancelLongPress();
        }
      }
      if (type === "touchEnd" || type === "touchCancel") cancelLongPress();
      send("Input.dispatchTouchEvent", { type: type, touchPoints: points(ev) });
      if (type === "touchEnd") {
        scheduleUrlSync(700);
        if (selActive) setTimeout(refreshSelection, 800);
        if (tapStart && Date.now() - tapStart.t < 600) {
          tapStart = null;
          syncKeyboardToFocus();
        }
      }
    };
  }
  function onLongPress(clientX, clientY) {
    lpFired = true;
    tapStart = null;
    // Cancel the touch sequence in the stream, otherwise the tap still clicks at the end.
    send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* ignore */ } }
    var p = toStream(clientX, clientY);
    call("ClaraOS.probeElementAt", { x: p.x, y: p.y }).then(function (r) {
      var el = (r && r.result) || { kind: "none" };
      showContextSheet(el, p);
    });
  }
  var opts = { capture: true, passive: false };
  window.addEventListener("touchstart", touchHandler("touchStart"), opts);
  window.addEventListener("touchmove", touchHandler("touchMove"), opts);
  window.addEventListener("touchend", touchHandler("touchEnd"), opts);
  window.addEventListener("touchcancel", function (ev) {
    if (isOwnUi(ev.target)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    cancelLongPress();
    lpFired = false;
    send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  }, opts);

  // ── Keyboard focus probe + proxy keyboard ────────────────────────────
  function syncKeyboardToFocus() {
    call("ClaraOS.probeFocus").then(function (r) {
      var focused = r && r.result && r.result.focused;
      if (focused) {
        if (document.activeElement !== proxy) proxy.focus();
      } else if (document.activeElement === proxy) {
        proxy.blur();
      }
    });
  }
  var KEYCODES = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37,
    ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
  var proxy = document.createElement("input");
  proxy.type = "text";
  proxy.setAttribute("data-claraos-ui", "1");
  proxy.setAttribute("autocomplete", "off");
  proxy.style.cssText = "position:fixed;left:-1000px;top:0;opacity:0;height:1px;";
  document.documentElement.appendChild(proxy);
  proxy.addEventListener("input", function (ev) {
    if (ev.inputType === "insertText" || ev.inputType === "insertCompositionText") {
      if (ev.data) send("Input.insertText", { text: ev.data });
    } else if (ev.inputType === "deleteContentBackward") {
      sendKey("Backspace");
    }
    proxy.value = "";
  });
  proxy.addEventListener("keydown", function (ev) {
    if (KEYCODES[ev.key] && ev.key !== "Backspace") {
      ev.preventDefault();
      sendKey(ev.key);
    }
  });
  function sendKey(key) {
    var code = KEYCODES[key];
    send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: code, key: key });
    send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: code, key: key });
  }

  // ── Clipboard/share helpers (run on the phone side) ──────────────────
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
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.className = ""; }, 2200);
  }
  function copyToPhone(text, label) {
    if (!text) { toast("Nichts zu kopieren"); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(label || "Kopiert");
      }, function () {
        toast("Zwischenablage blockiert — bitte im Browser erlauben");
      });
    } else {
      toast("Zwischenablage nicht verfügbar");
    }
  }
  function shareFromPhone(data) {
    if (navigator.share) {
      navigator.share(data).catch(function () { /* cancelled */ });
    } else {
      copyToPhone(data.url || data.text, "Link kopiert (Teilen nicht verfügbar)");
    }
  }

  // ── UI scaffold ──────────────────────────────────────────────────────
  var ICONS = {
    back: '<svg viewBox="0 0 24 24"><path d="M15.5 4.5 8 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    forward: '<svg viewBox="0 0 24 24"><path d="M8.5 4.5 16 12l-7.5 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    reload: '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M17.2 3.4v3.9h-3.9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    menu: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5.2" r="1.9" fill="currentColor"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/><circle cx="12" cy="18.8" r="1.9" fill="currentColor"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="5.5" y="10.5" width="13" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    keyboard: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6.5 10.5h1M10 10.5h1M13.5 10.5h1M17 10.5h.5M6.5 14.5h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    home: '<svg viewBox="0 0 24 24"><path d="m4.5 11 7.5-7 7.5 7M6.5 10v9.5h11V10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    share: '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="5.5" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="18.5" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="m8 11 7.5-4.4M8 13l7.5 4.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    history: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5.5 7.5h13M9.5 7V5.5h5V7M7 7.5l.8 11h8.4l.8-11M10 10.5v5M14 10.5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    desktop: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 19h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4.5v-2M12 21.5v-2M19.5 12h2M2.5 12h2M17.3 6.7l1.4-1.4M5.3 18.7l1.4-1.4M17.3 17.3l1.4 1.4M5.3 5.3l1.4 1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 8.5v-3a1.5 1.5 0 0 0-1.5-1.5H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    newtab: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8.5v7M8.5 12h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    selectall: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2.4"/></svg>',
    paste: '<svg viewBox="0 0 24 24"><rect x="6" y="4.5" width="12" height="16" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.5 4.5h5v2.5h-5z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    cut: '<svg viewBox="0 0 24 24"><circle cx="6.5" cy="17" r="2.3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.5" cy="17" r="2.3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.3 15.4 18 4.5M15.7 15.4 6 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    openlink: '<svg viewBox="0 0 24 24"><path d="M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5V14M14 4.5h5.5V10M19 5 11.5 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    find: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15.5 15.5 4.5 4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v10.5M7.5 11 12 15.5 16.5 11M5 19h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    // Same sparkle as in the shell (packages/shell/src/Chat/icons.tsx).
    clara: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 13.5 8.5 20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5L12 2Z"/><path d="M19 14 19.8 17.2 23 18l-3.2.8L19 22l-.8-3.2L15 18l3.2-.8L19 14Z" opacity="0.85"/><path d="M5 14 5.7 16.7 8.5 17.5 5.7 18.3 5 21 4.3 18.3 1.5 17.5 4.3 16.7 5 14Z" opacity="0.6"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="m5.5 14.5 6.5-6.5 6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="m5.5 9.5 6.5 6.5 6.5-6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // ── Find in page ───────────────────────────────────────────
  var findBar = null, findInput = null;
  function doFind(backwards) {
    var q = (findInput && findInput.value || "").trim();
    if (!q) return;
    call("ClaraOS.findInPage", { query: q, backwards: !!backwards })
      .then(function (r) {
        if (!((r && r.result) || {}).found) toast("Keine Treffer");
      });
  }
  function showFindBar() {
    closeAllOverlays();
    if (!findBar) {
      findBar = el("div", "");
      findBar.id = "claraos-findbar";
      findInput = el("input", "claraos-findinput");
      findInput.type = "text";
      findInput.placeholder = "Auf Seite suchen";
      findInput.setAttribute("autocomplete", "off");
      findInput.setAttribute("enterkeyhint", "search");
      findInput.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") doFind(false);
        if (ev.key === "Escape") hideFindBar();
      });
      // Live search while typing (like Chrome), deliberately via the input event:
      // the IME search key goes through the hardware-key path, which does NOT
      // reach our overlay inputs on real devices; the input event (IME
      // commitText) arrives reliably.
      var liveTimer = null;
      findInput.addEventListener("input", function () {
        clearTimeout(liveTimer);
        liveTimer = setTimeout(function () {
          if (!findInput.value.trim()) return;
          call("ClaraOS.clearSelection").then(function () { doFind(false); });
        }, 350);
      });
      var up = iconBtn("up", "Vorheriger Treffer");
      up.addEventListener("click", function () { doFind(true); });
      var down = iconBtn("down", "Nächster Treffer");
      down.addEventListener("click", function () { doFind(false); });
      var x = iconBtn("close", "Suche schließen");
      x.addEventListener("click", hideFindBar);
      findBar.appendChild(findInput);
      findBar.appendChild(up);
      findBar.appendChild(down);
      findBar.appendChild(x);
      document.body.appendChild(findBar);
    }
    findBar.classList.add("open");
    findInput.value = "";
    focusOverlayInput(findInput, false);
  }
  function hideFindBar() {
    if (!findBar) return;
    findBar.classList.remove("open");
    findInput.blur();
    call("ClaraOS.clearSelection");
  }
  var currentUrl = "";
  function homeUrl() { return pref("home_url", DEFAULT_HOME); }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    e.setAttribute("data-claraos-ui", "1");
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function iconBtn(icon, label) {
    var b = el("button", "claraos-iconbtn", ICONS[icon]);
    b.setAttribute("aria-label", label);
    b.title = label;
    return b;
  }

  // ── Sheets (bottom-sheet framework in Chrome style) ──────────────────
  var backdrop = null;
  function closeAllOverlays() {
    closeMenu();
    if (backdrop) { backdrop.remove(); backdrop = null; }
  }
  function openSheet(build) {
    closeAllOverlays();
    backdrop = el("div", "claraos-backdrop");
    var sheet = el("div", "claraos-sheet");
    backdrop.appendChild(sheet);
    backdrop.addEventListener("click", function (ev) {
      if (ev.target === backdrop) closeAllOverlays();
    });
    build(sheet);
    document.body.appendChild(backdrop);
    return sheet;
  }
  function sheetHeader(sheet, title, subtitle) {
    var h = el("div", "claraos-sheet-head");
    h.appendChild(el("div", "claraos-sheet-title", "")).textContent = title || "";
    if (subtitle) {
      var s = el("div", "claraos-sheet-sub", "");
      s.textContent = subtitle;
      h.appendChild(s);
    }
    sheet.appendChild(h);
  }
  function sheetItem(sheet, icon, label, fn, extraCls) {
    var it = el("button", "claraos-sheet-item" + (extraCls ? " " + extraCls : ""),
      (icon ? ICONS[icon] : "") + "<span></span>");
    it.querySelector("span").textContent = label;
    it.addEventListener("click", function () {
      closeAllOverlays();
      fn && fn();
    });
    sheet.appendChild(it);
    return it;
  }

  // ── Context menu ─────────────────────────────────────────────────────
  function showContextSheet(elInfo, streamPoint) {
    var kind = elInfo.kind || "none";
    if (kind === "link") {
      openSheet(function (sheet) {
        sheetHeader(sheet, elInfo.label || "Link", elInfo.href);
        sheetItem(sheet, "openlink", "Link öffnen", function () {
          navigateTo(elInfo.href);
        });
        sheetItem(sheet, "newtab", "In neuem Tab öffnen", function () {
          call("ClaraOS.tabs.create", { url: elInfo.href }).then(afterTabChange);
        });
        sheetItem(sheet, "copy", "URL kopieren", function () {
          copyToPhone(elInfo.href);
        });
        if (elInfo.src) {
          sheetItem(sheet, "copy", "Bild-URL kopieren", function () {
            copyToPhone(elInfo.src);
          });
        }
        sheetItem(sheet, "share", "Link teilen", function () {
          shareFromPhone({ url: elInfo.href });
        });
      });
    } else if (kind === "image") {
      openSheet(function (sheet) {
        sheetHeader(sheet, "Bild", elInfo.src);
        sheetItem(sheet, "newtab", "Bild in neuem Tab öffnen", function () {
          call("ClaraOS.tabs.create", { url: elInfo.src }).then(afterTabChange);
        });
        sheetItem(sheet, "copy", "Bild-URL kopieren", function () {
          copyToPhone(elInfo.src);
        });
        sheetItem(sheet, "share", "Teilen", function () {
          shareFromPhone({ url: elInfo.src });
        });
      });
    } else if (kind === "input") {
      openSheet(function (sheet) {
        sheetHeader(sheet, "Eingabefeld");
        if (elInfo.selection) {
          sheetItem(sheet, "copy", "Kopieren", function () {
            copyToPhone(elInfo.selection);
          });
          sheetItem(sheet, "cut", "Ausschneiden", function () {
            copyToPhone(elInfo.selection, "Ausgeschnitten");
            call("ClaraOS.deleteSelection");
          });
        }
        sheetItem(sheet, "paste", "Einfügen", function () {
          if (!(navigator.clipboard && navigator.clipboard.readText)) {
            toast("Zwischenablage nicht verfügbar"); return;
          }
          navigator.clipboard.readText().then(function (text) {
            if (text) send("Input.insertText", { text: text });
            else toast("Zwischenablage ist leer");
          }, function () {
            toast("Zwischenablage blockiert — bitte im Browser erlauben");
          });
        });
        sheetItem(sheet, "selectall", "Alles auswählen", function () {
          call("ClaraOS.selectAll");
        });
      });
    } else if (kind === "text") {
      // Select the word under the finger (visible in the stream), then enter
      // selection mode: drag handles + floating toolbar (Chrome style).
      call("ClaraOS.selectWordAt", { x: streamPoint.x, y: streamPoint.y })
        .then(function (r) {
          var res = (r && r.result) || {};
          if (!res.ok) { lpFired = false; return; }
          startSelectionMode(res);
        });
    } else {
      lpFired = false; // nothing actionable: release the sequence
    }
  }

  // ── Selection mode: drag handles + floating toolbar ──
  // The selection LIVES in the stream; we draw handles/toolbar as an overlay at
  // the reported caret rects and extend it via the extendSelection probe.
  var selUi = null;      // {handleL, handleR, toolbar}
  var selActive = false; // a selection exists in the stream (UI may be hidden)
  function fromStream(sx, sy) { // stream CSS → client CSS (exact inverse)
    var b = streamBox();
    if (!b) return { x: sx, y: sy };
    return { x: b.left + sx * DSF * b.scale,
             y: b.top + sy * DSF * b.scale };
  }
  function buildSelUi() {
    if (selUi) return selUi;
    function mkHandle(edge) {
      var h = el("div", "claraos-selhandle " + edge);
      h.addEventListener("touchstart", function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        h.__drag = true;
      }, { passive: false });
      h.addEventListener("touchmove", function (ev) {
        if (!h.__drag) return;
        ev.preventDefault(); ev.stopPropagation();
        var t = ev.touches[0];
        if (!t) return;
        var now = Date.now();
        if (h.__last && now - h.__last < 60) return; // throttle probe rate
        h.__last = now;
        // The caret target is above the finger (the handle hangs below the line).
        var p = toStream(t.clientX, t.clientY - 28);
        call("ClaraOS.extendSelection", { x: p.x, y: p.y, edge: edge })
          .then(function (r) {
            var res = (r && r.result) || {};
            if (res.ok) updateSelUi(res);
          });
      }, { passive: false });
      h.addEventListener("touchend", function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        h.__drag = false;
        refreshSelection();
      }, { passive: false });
      return h;
    }
    var toolbar = el("div", "claraos-seltoolbar");
    [
      { icon: "copy", label: "Kopieren", fn: function () {
          call("ClaraOS.getSelection").then(function (r) {
            copyToPhone(((r && r.result) || {}).text || "");
            endSelectionMode(true);
          });
        } },
      { icon: "selectall", label: "Alles", fn: function () {
          call("ClaraOS.selectAll").then(function () {
            call("ClaraOS.selectionInfo").then(function (r) {
              var res = (r && r.result) || {};
              if (res.ok) updateSelUi(res);
            });
          });
        } },
      { icon: "share", label: "Teilen", fn: function () {
          call("ClaraOS.getSelection").then(function (r) {
            var text = ((r && r.result) || {}).text || "";
            endSelectionMode(true);
            if (text) shareFromPhone({ text: text });
          });
        } },
    ].forEach(function (b) {
      var btn = el("button", "claraos-seltool", ICONS[b.icon] + "<span></span>");
      btn.querySelector("span").textContent = b.label;
      btn.addEventListener("click", b.fn);
      toolbar.appendChild(btn);
    });
    selUi = { handleL: mkHandle("start"), handleR: mkHandle("end"), toolbar: toolbar };
    document.body.appendChild(selUi.handleL);
    document.body.appendChild(selUi.handleR);
    document.body.appendChild(selUi.toolbar);
    return selUi;
  }
  function updateSelUi(info) {
    var ui = buildSelUi();
    selActive = true;
    var ps = fromStream(info.start.x, info.start.y + info.start.h);
    var pe = fromStream(info.end.x, info.end.y + info.end.h);
    ui.handleL.style.display = "block";
    ui.handleR.style.display = "block";
    ui.handleL.style.left = ps.x + "px";
    ui.handleL.style.top = ps.y + "px";
    ui.handleR.style.left = pe.x + "px";
    ui.handleR.style.top = pe.y + "px";
    var barH = cfg.topBarHeight || 56;
    var pb = fromStream(info.bound.x + info.bound.w / 2, info.bound.y);
    ui.toolbar.style.display = "flex";
    var tw = ui.toolbar.offsetWidth || 220;
    var tx = Math.max(8, Math.min(window.innerWidth - tw - 8, pb.x - tw / 2));
    var ty = pb.y - 54;
    if (ty < barH + 6) { // no room above → place below the selection
      var pbot = fromStream(info.bound.x, info.bound.y + info.bound.h);
      ty = Math.min(window.innerHeight - 54, pbot.y + 34);
    }
    ui.toolbar.style.left = tx + "px";
    ui.toolbar.style.top = ty + "px";
  }
  function hideSelUi() {
    if (!selUi) return;
    selUi.handleL.style.display = "none";
    selUi.handleR.style.display = "none";
    selUi.toolbar.style.display = "none";
  }
  function endSelectionMode(clearInStream) {
    selActive = false;
    hideSelUi();
    if (clearInStream) call("ClaraOS.clearSelection");
  }
  function startSelectionMode(info) {
    closeAllOverlays();
    updateSelUi(info);
  }
  function refreshSelection() {
    if (!selActive) return;
    call("ClaraOS.selectionInfo").then(function (r) {
      var res = (r && r.result) || {};
      if (res.ok) updateSelUi(res);
      else endSelectionMode(false);
    });
  }

  // ── Tabs ─────────────────────────────────────────────────────────────
  var tabCountEl = null;
  function syncTabCount() {
    call("ClaraOS.tabs.list").then(function (r) {
      var tabs = (r && r.result) || [];
      if (tabCountEl && tabs.length) tabCountEl.textContent = String(tabs.length);
    });
  }
  function afterTabChange() {
    syncTabCount();
    scheduleUrlSync(800);
  }
  function showTabsSheet() {
    call("ClaraOS.tabs.list").then(function (r) {
      var tabs = (r && r.result) || [];
      openSheet(function (sheet) {
        sheet.classList.add("claraos-sheet-tabs");
        var head = el("div", "claraos-sheet-head claraos-tabs-head");
        var title = el("div", "claraos-sheet-title", "");
        title.textContent = "Tabs (" + tabs.length + ")";
        head.appendChild(title);
        var add = iconBtn("plus", "Neuer Tab");
        add.addEventListener("click", function () {
          closeAllOverlays();
          call("ClaraOS.tabs.create", { url: homeUrl() }).then(afterTabChange);
        });
        head.appendChild(add);
        sheet.appendChild(head);
        var grid = el("div", "claraos-tabgrid");
        sheet.appendChild(grid);
        tabs.forEach(function (tab) {
          var card = el("div", "claraos-tabcard" + (tab.active ? " active" : ""));
          var row = el("div", "claraos-tabcard-row");
          var name = el("div", "claraos-tabcard-title", "");
          name.textContent = tab.title || tab.url || "Tab";
          var x = el("button", "claraos-tabcard-close", ICONS.close);
          x.addEventListener("click", function (ev) {
            ev.stopPropagation();
            call("ClaraOS.tabs.close", { id: tab.id }).then(function () {
              closeAllOverlays();
              showTabsSheet();
              afterTabChange();
            });
          });
          row.appendChild(name);
          row.appendChild(x);
          card.appendChild(row);
          var thumb = el("div", "claraos-tabcard-thumb");
          card.appendChild(thumb);
          call("ClaraOS.tabs.thumb", { id: tab.id }, 10000).then(function (tr) {
            var data = ((tr && tr.result) || {}).data;
            if (data) {
              var img = document.createElement("img");
              img.setAttribute("data-claraos-ui", "1");
              img.src = "data:image/jpeg;base64," + data;
              thumb.appendChild(img);
            }
          });
          card.addEventListener("click", function () {
            closeAllOverlays();
            call("ClaraOS.tabs.activate", { id: tab.id }).then(afterTabChange);
          });
          grid.appendChild(card);
        });
      });
    });
  }

  // ── Open Clara chat ────────────────────
  // The shell understands the deep link `?chat=1` (useBootDeepLink) and opens
  // the Clara chat with it: ClaraOverlay on mobile, the start-menu chat on desktop.
  // New tab so the browser stream keeps running.
  var SHELL_URL = cfg.shellUrl || "https://home." + location.hostname.replace(/^[^.]+\./, "");
  function openClara() {
    window.open(SHELL_URL + "/?chat=1", "_blank", "noopener");
  }

  // ── Download pass-through: status sheet + toast for new items ────────
  // Downloads land in the container; the relay uploads them into the Files app
  // (Nextcloud, folder "Downloads/Clara Browser"). The client polls the status
  // with the 5 s sync and reports transitions as a toast.
  var dlLastSeq = 0;
  var dlTarget = "/Downloads/Clara Browser";
  function syncDownloads() {
    call("ClaraOS.downloads.recent").then(function (r) {
      var res = (r && r.result) || {};
      var list = res.downloads || [];
      if (res.target) dlTarget = res.target;
      var maxSeq = dlLastSeq;
      list.forEach(function (d) {
        if (d.seq > dlLastSeq) {
          if (d.state === "in Files") {
            // Name the recipient: the browser instance can be shared, so the
            // user should see WHOSE Files the download ended up in.
            toast("⬇ " + d.name + " → Files von " + (d.owner || "?"));
          } else if (d.state.indexOf("Fehler") === 0 ||
                     d.state.indexOf("zu groß") === 0) {
            toast("⬇ " + d.name + ": " + d.state);
          } else if (d.state === "läuft") {
            toast("⬇ Download: " + d.name);
          }
        }
        if (d.seq > maxSeq) maxSeq = d.seq;
      });
      dlLastSeq = maxSeq;
    });
  }
  function showDownloadsSheet() {
    call("ClaraOS.downloads.recent").then(function (r) {
      var res = (r && r.result) || {};
      var list = res.downloads || [];
      openSheet(function (sheet) {
        sheetHeader(sheet, "Downloads", "Ablage: Files → " + (res.target || dlTarget));
        if (!list.length) {
          sheetHeader(sheet, "", "Noch keine Downloads in dieser Sitzung.");
        }
        list.forEach(function (d) {
          var kb = d.bytes ? " · " + Math.max(1, Math.round(d.bytes / 1024)) + " kB" : "";
          var who = d.owner ? " · " + d.owner : "";
          sheetItem(sheet, "download", d.name + " — " + d.state + kb + who, function () {
            copyToPhone((res.target || dlTarget) + "/" + d.name, "Pfad kopiert");
          });
        });
      });
    });
  }

  // ── History / settings ───────────────────────────────────────────────
  function showHistorySheet() {
    call("Page.getNavigationHistory", {}).then(function (r) {
      var h = (r && r.result) || {};
      var entries = (h.entries || []).slice().reverse();
      openSheet(function (sheet) {
        sheetHeader(sheet, "Verlauf (dieser Tab)");
        if (!entries.length) sheetHeader(sheet, "", "leer");
        entries.slice(0, 25).forEach(function (e2) {
          var isCurrent = h.entries[h.currentIndex] &&
            h.entries[h.currentIndex].id === e2.id;
          var it = sheetItem(sheet, "history",
            (e2.title || e2.url || "").slice(0, 60) + (isCurrent ? "  ✓" : ""),
            function () {
              send("Page.navigateToHistoryEntry", { entryId: e2.id });
              scheduleUrlSync(1200);
            });
          it.title = e2.url || "";
        });
      });
    });
  }
  function showSettingsSheet() {
    openSheet(function (sheet) {
      sheetHeader(sheet, "Einstellungen");
      var engine = pref("search_engine", "ddg");
      Object.keys(SEARCH_ENGINES).forEach(function (key) {
        sheetItem(sheet, null,
          (key === engine ? "◉ " : "○ ") + "Suchmaschine: " + SEARCH_ENGINES[key].name,
          function () {
            setPref("search_engine", key);
            toast("Suchmaschine: " + SEARCH_ENGINES[key].name);
          });
      });
      sheetItem(sheet, "home", "Aktuelle Seite als Startseite", function () {
        if (currentUrl) {
          setPref("home_url", currentUrl);
          toast("Startseite gesetzt");
        }
      });
      sheetItem(sheet, "home", "Startseite zurücksetzen (DuckDuckGo)", function () {
        setPref("home_url", DEFAULT_HOME);
        toast("Startseite zurückgesetzt");
      });
      sheetItem(sheet, "trash", "Browserdaten löschen (Cookies+Cache)", function () {
        openSheet(function (confirm) {
          sheetHeader(confirm, "Cookies und Cache im Browser löschen?",
            "Du wirst überall abgemeldet.");
          sheetItem(confirm, "trash", "Ja, löschen", function () {
            call("ClaraOS.clearData", {}, 15000).then(function () {
              send("Page.reload", {});
              toast("Browserdaten gelöscht");
            });
          }, "danger");
          sheetItem(confirm, "close", "Abbrechen", function () { /* just close */ });
        });
      });
    });
  }

  // ── Top bar: [←] [URL pill] [tab box] [⋮] (Chrome layout) ────────────
  var bar, pill, pillHost, urlInput, menuEl;
  function buildBar() {
    bar = el("div", "");
    bar.id = "claraos-bar";

    var back = iconBtn("back", "Zurück");
    back.addEventListener("click", function () { historyStep(-1); });

    pill = el("div", "claraos-pill");
    pill.appendChild(el("span", "claraos-pill-lock", ICONS.lock));
    pillHost = el("span", "claraos-pill-host", "");
    pillHost.textContent = "Verbinde …";
    pill.appendChild(pillHost);
    pill.addEventListener("click", openUrlEdit);

    urlInput = el("input", "claraos-urlinput");
    urlInput.type = "text";
    urlInput.setAttribute("autocomplete", "off");
    urlInput.setAttribute("autocapitalize", "off");
    urlInput.setAttribute("autocorrect", "off");
    urlInput.setAttribute("spellcheck", "false");
    urlInput.setAttribute("enterkeyhint", "go");
    urlInput.placeholder = "Suchen oder URL eingeben";
    urlInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { navigateTo(urlInput.value); closeUrlEdit(); }
      if (ev.key === "Escape") closeUrlEdit();
    });
    urlInput.addEventListener("blur", function () {
      setTimeout(closeUrlEdit, 150);
    });

    var tabBtn = el("button", "claraos-tabbtn");
    tabBtn.setAttribute("aria-label", "Tabs");
    tabBtn.title = "Tabs";
    tabCountEl = el("span", "claraos-tabbtn-count", "1");
    tabBtn.appendChild(tabCountEl);
    tabBtn.addEventListener("click", showTabsSheet);

    var menuBtn = iconBtn("menu", "Menü");
    menuBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      toggleMenu();
    });

    bar.appendChild(back);
    bar.appendChild(pill);
    bar.appendChild(urlInput);
    bar.appendChild(tabBtn);
    bar.appendChild(menuBtn);

    menuEl = el("div", "");
    menuEl.id = "claraos-menu";
    [
      { icon: "clara", label: "Assistent fragen", fn: openClara },
      { icon: "newtab", label: "Neuer Tab", fn: function () {
          call("ClaraOS.tabs.create", { url: homeUrl() }).then(afterTabChange);
        } },
      { icon: "reload", label: "Neu laden", fn: function () {
          send("Page.reload", {});
          scheduleUrlSync(1500);
        } },
      { icon: "forward", label: "Vorwärts", fn: function () { historyStep(1); } },
      { icon: "share", label: "Teilen …", fn: function () {
          shareFromPhone({ url: currentUrl });
        } },
      { icon: "history", label: "Verlauf", fn: showHistorySheet },
      { icon: "find", label: "Auf Seite suchen", fn: showFindBar },
      { icon: "download", label: "Downloads", fn: showDownloadsSheet },
      { icon: "keyboard", label: "Tastatur einblenden", fn: function () { proxy.focus(); } },
      { icon: "desktop", label: "Desktopwebsite", fn: function () {
          desktopMode = !desktopMode;
          call("ClaraOS.setDesktopMode", { enabled: desktopMode }).then(function () {
            applyDeviceMetrics();
            toast(desktopMode ? "Desktop-Ansicht" : "Mobile Ansicht");
            scheduleUrlSync(1500);
          });
        } },
      { icon: "home", label: "Startseite", fn: function () { navigateTo(homeUrl()); } },
      { icon: "settings", label: "Einstellungen", fn: showSettingsSheet },
    ].forEach(function (item) {
      var mi = el("button", "claraos-menuitem",
        ICONS[item.icon] + "<span></span>");
      mi.querySelector("span").textContent = item.label;
      mi.addEventListener("click", function () { closeMenu(); item.fn(); });
      menuEl.appendChild(mi);
    });

    document.body.appendChild(bar);
    document.body.appendChild(menuEl);

    // Floating Clara button (as in the shell), bottom right and unobtrusive so
    // it does not cover the stream. Also available in the menu.
    // Inside the ClaraOS shell the Clara button already exists (MobileShell),
    // so do not add a second one there; only when opened directly in a browser.
    var inShell = false;
    try { inShell = window.parent && window.parent !== window; } catch (e) { inShell = true; }
    var claraFab = inShell ? null : el("button", "claraos-clarafab", ICONS.clara);
    if (claraFab) {
      claraFab.title = "Assistent fragen";
      claraFab.setAttribute("aria-label", "Assistent fragen");
      claraFab.addEventListener("click", openClara);
      document.body.appendChild(claraFab);
    }

    syncTabCount();
  }

  /* Focusing freshly shown overlay inputs is unreliable: otherwise the hidden
   * proxy keeps the IME connection and ALL keys end up in the stream. Hence:
   * blur the proxy, force a reflow, focus, and retry via rAF in case the
   * browser swallowed the first attempt (display:none→block in the same task). */
  function focusOverlayInput(input, selectAll) {
    proxy.blur();
    void input.offsetWidth; // reflow: the element must be visible before focus takes effect
    input.focus({ preventScroll: true });
    if (selectAll) input.select();
    requestAnimationFrame(function () {
      if (document.activeElement !== input) {
        input.focus({ preventScroll: true });
        if (selectAll) input.select();
      }
    });
  }
  function openUrlEdit() {
    closeAllOverlays();
    bar.classList.add("editing");
    urlInput.value = currentUrl;
    focusOverlayInput(urlInput, true);
  }
  function closeUrlEdit() { bar.classList.remove("editing"); }
  function toggleMenu() { menuEl.classList.toggle("open"); }
  function closeMenu() { if (menuEl) menuEl.classList.remove("open"); }

  function navigateTo(value) {
    var v = (value || "").trim();
    if (!v) return;
    var target;
    if (/^https?:\/\//i.test(v)) target = v;
    else if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(v)) target = "https://" + v;
    else {
      var eng = SEARCH_ENGINES[pref("search_engine", "ddg")] || SEARCH_ENGINES.ddg;
      target = eng.url.replace("%s", encodeURIComponent(v));
    }
    send("Page.navigate", { url: target });
    scheduleUrlSync(1500);
  }

  function historyStep(dir) {
    call("Page.getNavigationHistory", {}).then(function (r) {
      if (!r || !r.result) return;
      var h = r.result;
      var idx = h.currentIndex + dir;
      if (idx >= 0 && idx < h.entries.length) {
        send("Page.navigateToHistoryEntry", { entryId: h.entries[idx].id });
        scheduleUrlSync(1500);
      }
    });
  }

  function syncUrlPill() {
    call("Page.getNavigationHistory", {}).then(function (r) {
      if (!r || !r.result || !r.result.entries) return;
      var e2 = r.result.entries[r.result.currentIndex];
      if (!e2 || !e2.url) return;
      if (currentUrl && currentUrl !== e2.url && selActive) {
        // Page navigated → the selection no longer exists; handles/toolbar
        // would otherwise remain as a ghost overlay.
        endSelectionMode(false);
      }
      currentUrl = e2.url;
      var host = "";
      var secure = /^https:/i.test(e2.url);
      try { host = new URL(e2.url).host; } catch (er) { host = e2.url; }
      pillHost.textContent = host || e2.url;
      pill.classList.toggle("insecure", !secure);
    });
  }
  var urlSyncTimer = null;
  function scheduleUrlSync(delay) {
    clearTimeout(urlSyncTimer);
    urlSyncTimer = setTimeout(function () {
      syncUrlPill();
      syncTabCount();
    }, delay);
  }
  setInterval(function () { syncUrlPill(); syncTabCount(); syncDownloads(); }, 5000);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildBar);
  } else {
    buildBar();
  }
})();
