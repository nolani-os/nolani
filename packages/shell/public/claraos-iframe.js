/**
 * ClaraOS Iframe Bridge — drop-in helper for iframe-hosted apps that want
 * to participate in the unified Clara chat.
 *
 * Usage in your iframe-app's HTML/JS:
 *
 *     <script src="https://claraos.example.com/claraos-iframe.js"></script>
 *     <script>
 *       claraos.ready({
 *         appId: "nextcloud-files",
 *         capabilities: ["read-context", "open-file", "select-folder"],
 *         getContext: () => ({
 *           current_path: window.location.hash || "/",
 *           selected_file: window.localStorage.getItem("nc-selected") || null,
 *         }),
 *         onAction: async (action, args) => {
 *           if (action === "open_file") {
 *             window.location.hash = "#" + encodeURIComponent(args.path);
 *             return { ok: true };
 *           }
 *           throw new Error("unknown action: " + action);
 *         },
 *       });
 *
 *       // Optional: push context updates whenever the user changes something
 *       window.addEventListener("hashchange", () => claraos.notifyContextChanged());
 *     </script>
 *
 * The protocol is a small superset of postMessage — we add a `windowId`
 * round-trip so concurrent ClaraOS windows of the same app stay separated.
 *
 * License: MIT (matches ClaraOS).
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;

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
        const ctx = _safeGetContext();
        send("claraos:ready", {
          appId: _config.appId || "iframe-app",
          capabilities: _config.capabilities || [],
          context: ctx,
        });
        _ready = true;
      }
      return;
    }

    if (data.type === "claraos:get-context") {
      send("claraos:context", { context: _safeGetContext() });
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
    /**
     * Register the app with ClaraOS. Should be called as early as possible
     * after page load. The shell may have already sent the `hello` — we
     * answer it now if so.
     *
     * @param {object} config
     * @param {string} config.appId          Stable app id (matches manifest).
     * @param {string[]} [config.capabilities]
     * @param {() => object} [config.getContext]
     * @param {(action: string, args: object) => any} [config.onAction]
     */
    ready: function (config) {
      _config = config || {};
      _ready = true;
      // If we already received a hello, send the ready now.
      if (_windowId) {
        send("claraos:ready", {
          appId: _config.appId || "iframe-app",
          capabilities: _config.capabilities || [],
          context: _safeGetContext(),
        });
      }
    },

    /** Push a context update (delta) to the shell. Call whenever the
     * iframe-app's state changes (file selected, view switched, …). */
    notifyContextChanged: function (delta) {
      if (!_ready) return;
      const context = delta && typeof delta === "object" ? delta : _safeGetContext();
      send("claraos:context-changed", { context: context });
    },

    /** Show a toast notification in the ClaraOS shell. */
    notify: function (message, title) {
      send("claraos:notify", { message: String(message || ""), title: String(title || "") });
    },

    /** Stop responding to shell messages. */
    dispose: function () {
      _disposed = true;
      _config = null;
      _ready = false;
      window.removeEventListener("message", onMessage);
    },
  };

  window.addEventListener("message", onMessage);
  window.claraos = claraos;
})();
