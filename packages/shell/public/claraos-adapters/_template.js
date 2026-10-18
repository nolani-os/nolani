/**
 * Tier A adapter TEMPLATE — NOT loaded automatically.
 *
 * A tier A adapter gives Clara real in-app verbs (DOM control) instead of only
 * the generic read context of the auto bridge. Only build one per app where it
 * adds concrete value (tier A is strictly on demand).
 *
 * Activating a new adapter (3 steps):
 *   1. Copy this file → claraos-adapters/<app-hostname>.js (e.g.
 *      paperless.example.com.js), implement the verbs with the app's REAL DOM
 *      selectors (verify in the browser DevTools of the running app!).
 *   2. Add the host name to TIER_A_HOSTS in claraos-iframe-auto.js.
 *   3. Add /claraos-adapters/* to the shell's public paths in the reverse proxy
 *      (@needs_auth not path …) — otherwise you get a 302 HTML page instead of
 *      the script (same pattern as claraos-iframe-auto.js itself).
 *
 * The adapter runs in the app context (loaded via <script> from the shell
 * origin, BEFORE the tier G setTimeout) and wins because it calls
 * claraos.ready() first.
 */
(function () {
  "use strict";
  if (!window.claraos || window.claraos.isReady && window.claraos.isReady()) return;

  window.claraos.ready({
    appId: location.hostname.split(".")[0],
    capabilities: ["read-context", "highlight_field", "fill_form", "open_record"],

    getContext: function () {
      return {
        url: location.href,
        title: document.title,
        // add app-specific state (active record, filters, ...)
      };
    },

    /**
     * Clara verbs. Returns any JSON-serializable result
     * (sent back to Clara as the tool response).
     */
    onAction: function (action, args) {
      switch (action) {
        case "open_record":
          // e.g. location.assign("/documents/" + args.id + "/details");
          return { ok: false, error: "open_record: Selektor/Route für diese App eintragen" };
        case "fill_form": {
          // e.g. fill the search field + fire an input event (SPA frameworks
          // listen to 'input', not to value assignment):
          // var el = document.querySelector("input[type=search]");
          // el.value = args.value; el.dispatchEvent(new Event("input", {bubbles: true}));
          return { ok: false, error: "fill_form: Selektor für diese App eintragen" };
        }
        case "highlight_field": {
          var el = args && args.selector ? document.querySelector(args.selector) : null;
          if (!el) return { ok: false, error: "Element nicht gefunden: " + (args && args.selector) };
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          var prev = el.style.outline;
          el.style.outline = "3px solid #7b9fff";
          setTimeout(function () { el.style.outline = prev; }, 2500);
          return { ok: true };
        }
        default:
          return { ok: false, error: "unbekanntes Verb: " + action };
      }
    },
  });
})();
