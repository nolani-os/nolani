/**
 * ClaraOS Auto-Bridge — universal drop-in injected by Caddy into EVERY app's
 * HTML (tier G). Superset of claraos-iframe.js:
 * carries the full postMessage protocol AND auto-registers a *generic* context
 * bridge if the app did not register its own.
 *
 * Effect: every iframe-app gets a Clara chat button (inlineClaraSupported flips
 * true because the bridge reports `ready`) + basic context (url/title/selection/
 * headings) for the inline chat — with zero per-app work.
 *
 * A per-app Tier-A adapter that calls `claraos.ready({...})` itself overrides
 * the generic registration (the deferred auto-register bails when `_config` is set).
 *
 * Injected by Caddy via the (claraos_bridge) snippet (replace-response) on every
 * app host. NOT served into the claraos shell origin itself.
 *
 * License: MIT (matches ClaraOS).
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;
  // Guard against double-injection (app already included claraos-iframe.js).
  if (window.claraos) return;

  let _windowId = null;
  let _config = null;
  let _ready = false;
  let _disposed = false;

  // Only the shell that embeds this app may drive the bridge, and context goes
  // only to it — any other page could frame the app as well. The script is
  // served by the shell, so its own origin names the trusted parent.
  const _shellOrigin = (function () {
    try {
      const src = document.currentScript && document.currentScript.src;
      const origin = src ? new URL(src).origin : null;
      // Served by the app's own host (proxy injection, inline copy) it names nothing.
      if (origin && origin !== window.location.origin) return origin;
    } catch (e) { /* fall back below */ }
    return null;
  })();

  function _fromShell(ev) {
    if (ev.source !== window.parent) return false;
    if (_shellOrigin) return ev.origin === _shellOrigin;
    try { return new URL(ev.origin).hostname.indexOf("home.") === 0; } catch (e) { return false; }
  }

  function send(type, extra) {
    if (_disposed || !window.parent) return;
    const msg = Object.assign({ type, windowId: _windowId }, extra || {});
    try {
      window.parent.postMessage(msg, _shellOrigin || "*");
    } catch (e) {
      // cross-origin frames may throw — non-fatal
    }
  }

  function reply(action, requestId, result, err) {
    send("claraos:action-result", {
      action: action,
      requestId: requestId,
      result: typeof result === "undefined" ? null : result,
      error: err ? String(err && err.message ? err.message : err) : undefined,
    });
  }

  function onMessage(ev) {
    if (!_fromShell(ev)) return;
    const data = ev.data;
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;
    if (!data.type.startsWith("claraos:")) return;

    if (data.type === "claraos:hello") {
      _windowId = data.windowId || _windowId;
      if (_config) {
        send("claraos:ready", {
          appId: _config.appId || "iframe-app",
          capabilities: _config.capabilities || [],
          context: _safeGetContext(),
        });
        _ready = true;
      }
      return;
    }

    if (data.type === "claraos:get-context") {
      send("claraos:context", { context: _safeGetContext() });
      return;
    }

    // ── Tour bridge: the shell tour highlights elements in this app.
    // Independent of _config — works in every injected app. The response is a
    // series of claraos:tour-rect ticks (viewport coordinates) until tour-clear
    // arrives; while the element is (still) missing, no tick is sent and the
    // shell stays with the frame spotlight (fallback by design).
    if (data.type === "claraos:tour-highlight") {
      _tourStart(String(data.selector || ""));
      return;
    }
    if (data.type === "claraos:tour-clear") {
      _tourStop();
      return;
    }

    if (data.type === "claraos:action") {
      const action = String(data.action || "");
      const args = data.args || {};
      const requestId = data.requestId;
      if (!_config || typeof _config.onAction !== "function") {
        reply(action, requestId, null, "no_handler");
        return;
      }
      let result;
      try {
        result = _config.onAction(action, args);
      } catch (err) {
        reply(action, requestId, null, err);
        return;
      }
      if (result && typeof result.then === "function") {
        result
          .then(function (r) { reply(action, requestId, r); })
          .catch(function (e) { reply(action, requestId, null, e); });
      } else {
        reply(action, requestId, result);
      }
      return;
    }
  }

  var _tourSelector = null;
  var _tourTimer = null;
  var _tourScrolled = false;

  function _tourStart(selector) {
    _tourStop();
    if (!selector) return;
    _tourSelector = selector;
    _tourScrolled = false;
    _tourTimer = window.setInterval(_tourTick, 400);
    _tourTick();
  }

  function _tourStop() {
    if (_tourTimer) window.clearInterval(_tourTimer);
    _tourTimer = null;
    _tourSelector = null;
  }

  function _tourTick() {
    if (!_tourSelector) return;
    var el = null;
    try {
      el = document.querySelector(_tourSelector);
    } catch (e) {
      _tourStop(); // broken selector — the shell stays with the frame fallback
      return;
    }
    if (!el) return; // the SPA may still be rendering — keep ticking
    if (!_tourScrolled) {
      _tourScrolled = true;
      try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { /* ignore */ }
    }
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    send("claraos:tour-rect", {
      selector: _tourSelector,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    });
  }

  function _safeGetContext() {
    if (!_config || typeof _config.getContext !== "function") return {};
    try {
      const c = _config.getContext();
      return c && typeof c === "object" ? c : {};
    } catch (err) {
      console.warn("[claraos] getContext threw", err);
      return {};
    }
  }

  const claraos = {
    ready: function (config) {
      _config = config || {};
      _ready = true;
      if (_windowId) {
        send("claraos:ready", {
          appId: _config.appId || "iframe-app",
          capabilities: _config.capabilities || [],
          context: _safeGetContext(),
        });
      }
    },
    notifyContextChanged: function (delta) {
      if (!_ready) return;
      const context = delta && typeof delta === "object" ? delta : _safeGetContext();
      send("claraos:context-changed", { context: context });
    },
    notify: function (message, title) {
      send("claraos:notify", { message: String(message || ""), title: String(title || "") });
    },
    dispose: function () {
      _disposed = true;
      _config = null;
      _ready = false;
      window.removeEventListener("message", onMessage);
    },
  };

  window.addEventListener("message", onMessage);
  window.claraos = claraos;

  // ── Redirect links into the Clara Browser ────────────────────────────────
  // Why: a link in an email belongs in the streamed Clara Browser — that is
  // where the third-party service sessions live. Without this it opens in the
  // companion (or not at all) and the user breaks out of ClaraOS.
  // Security: by default it lands in a PRIVATE session without logins; the
  // shell asks before an address opens in the signed-in browser.
  // Only hosts in LINK_CAPTURE_HOSTS intercept — the shell additionally checks
  // the origin; this is the first of two layers.
  var LINK_CAPTURE_HOSTS = ["mail"];   // subdomain prefix, e.g. mail.example.com

  function captureLinks() {
    return LINK_CAPTURE_HOSTS.some(function (p) {
      return location.hostname === p || location.hostname.indexOf(p + ".") === 0;
    });
  }

  function absenderRaten() {
    // Best effort: sender of the open email, so the shell can offer "trust this
    // sender". No match is harmless — then it simply asks every time.
    try {
      var sel = document.querySelector(
        "[data-sender], .sender-email, .message-from, a[href^='mailto:']");
      if (!sel) return "";
      var v = sel.getAttribute("data-sender")
        || (sel.getAttribute("href") || "").replace(/^mailto:/, "")
        || (sel.textContent || "");
      var m = String(v).match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      return m ? m[0].toLowerCase() : "";
    } catch (e) {
      return "";
    }
  }

  if (captureLinks()) {
    document.addEventListener("click", function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
      if (!a) return;
      var href = a.getAttribute("href") || "";
      if (!/^https?:\/\//i.test(href)) return;            // internal links untouched
      try {
        if (new URL(href).hostname === location.hostname) return;  // same app
      } catch (e) { return; }
      ev.preventDefault();
      ev.stopPropagation();
      send("claraos:open-external", { url: href, from: absenderRaten() });
    }, true);

    // intercept window.open — otherwise the native path wins before the shell steps in
    var _open = window.open;
    window.open = function (url) {
      if (url && /^https?:\/\//i.test(String(url))) {
        send("claraos:open-external", { url: String(url), from: absenderRaten() });
        return null;
      }
      return _open ? _open.apply(window, arguments) : null;
    };
  }

  // ── Tier A per-app adapters ──────────────────────────────────────────────
  // Opt-in registry: hosts for which a DOM adapter exists at
  // <shell-origin>/claraos-adapters/<hostname>.js (source:
  // packages/shell/public/claraos-adapters/, template _template.js). The
  // adapter calls claraos.ready({onAction: ...}) itself and thereby wins over
  // the tier G fallback below. Deliberately a LIST instead of blind 404
  // probing: no console noise and no extra request on the many hosts without
  // an adapter. New adapter = drop the file + add the host here
  // (+ /claraos-adapters/* must be in the shell's public paths in the reverse proxy).
  var TIER_A_HOSTS = [];
  if (TIER_A_HOSTS.indexOf(location.hostname) !== -1) {
    try {
      var autoSrc = (document.currentScript && document.currentScript.src) || "";
      var shellOrigin = autoSrc ? new URL(autoSrc).origin : "";
      if (shellOrigin) {
        var adapterTag = document.createElement("script");
        adapterTag.src = shellOrigin + "/claraos-adapters/" + location.hostname + ".js";
        adapterTag.async = true;
        adapterTag.onerror = function () { /* adapter missing → tier G stays */ };
        (document.head || document.documentElement).appendChild(adapterTag);
      }
    } catch (e) { /* ignore */ }
  }

  // ── Tier-G generic auto-register ──────────────────────────────────────────
  // Deferred so an app's own claraos.ready({...}) (Tier-A adapter loaded later)
  // wins. If after the tick nobody registered, install the generic bridge so
  // the app still gets a Clara button + read-only context.
  setTimeout(function () {
    if (_config) return; // app provided its own adapter — keep it
    claraos.ready({
      appId: (location.hostname.split(".")[0] || "iframe-app"),
      capabilities: ["read-context"],
      getContext: function () {
        var sel = "";
        try {
          sel = String(window.getSelection ? window.getSelection() : "").slice(0, 2000);
        } catch (e) { /* ignore */ }
        var heads = [];
        try {
          heads = Array.prototype.slice
            .call(document.querySelectorAll("h1,h2"))
            .map(function (h) { return (h.innerText || h.textContent || "").trim(); })
            .filter(Boolean)
            .slice(0, 12);
        } catch (e) { /* ignore */ }
        return {
          url: location.href,
          title: document.title,
          selection: sel,
          headings: heads,
        };
      },
    });
    // Keep context fresh across SPA soft-navigation.
    window.addEventListener("hashchange", function () { claraos.notifyContextChanged(); });
    try {
      var _ps = history.pushState;
      if (typeof _ps === "function") {
        history.pushState = function () {
          var r = _ps.apply(this, arguments);
          try { claraos.notifyContextChanged(); } catch (e) { /* ignore */ }
          return r;
        };
      }
    } catch (e) { /* ignore */ }
  }, 0);
})();
