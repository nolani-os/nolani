/* ClaraOS desktop overlay.
 *
 * WHY SO LITTLE: on the desktop the streamed Chromium runs WITHOUT kiosk mode
 * and brings its OWN tab strip, address bar, find (Ctrl+F), history and
 * context menu, all visible in the picture and fully usable. A tab/URL bar of
 * our own would only duplicate that. So this overlay keeps exactly what the
 * streamed browser CANNOT do:
 *   1. Clara button: access to the Clara chat from inside the browser.
 *   2. Downloads: the hand-over to the Files app (otherwise the file stays in
 *      the container). Toast on arrival + list on click.
 * The mobile dashboard keeps its full bar: there Chromium runs in kiosk mode
 * and has no UI of its own.
 */
(function () {
  "use strict";
  var cfg = window.CLARAOS_CONFIG || {};
  if (cfg.mode !== "desktop-chrome") return;

  var SHELL_URL = cfg.shellUrl || "https://home." + location.hostname.replace(/^[^.]+\./, "");

  // ── Relay connection (download status only) ──────────────────────────
  var ws = null, msgId = 0, pending = {};
  var wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host + "/claraos-cdp";
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = syncDownloads;
    ws.onclose = function () { setTimeout(connect, 1500); };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* ignore */ } };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
    };
  }
  function call(method, params, timeoutMs) {
    return new Promise(function (resolve) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve(null);
      var id = ++msgId;
      pending[id] = resolve;
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(function () { delete pending[id]; resolve(null); }, timeoutMs || 8000);
    });
  }
  connect();

  var ICONS = {
    // Sparkle exactly as in the shell (packages/shell/src/Chat/icons.tsx),
    // so the button looks the same as in the other apps.
    clara: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 13.5 8.5 20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5L12 2Z"/><path d="M19 14 19.8 17.2 23 18l-3.2.8L19 22l-.8-3.2L15 18l3.2-.8L19 14Z" opacity="0.85"/><path d="M5 14 5.7 16.7 8.5 17.5 5.7 18.3 5 21 4.3 18.3 1.5 17.5 4.3 16.7 5 14Z" opacity="0.6"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v10.5M7.5 11 12 15.5 16.5 11M5 19h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    e.setAttribute("data-claraos-ui", "1");
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function toast(text) {
    var t = document.getElementById("claraos-toast");
    if (!t) {
      t = el("div", "");
      t.id = "claraos-toast";
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.className = "visible";
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = ""; }, 2600);
  }
  function copyToLocal(text, label) {
    if (!text || !(navigator.clipboard && navigator.clipboard.writeText)) return;
    navigator.clipboard.writeText(text).then(function () { toast(label || "Kopiert"); },
      function () { toast("Zwischenablage blockiert"); });
  }

  // ── Open the Clara chat ───────────────────────────
  // The shell understands the deep link `?chat=1` (useBootDeepLink) and opens
  // the Clara chat with it, on desktop and mobile. New tab, so the browser
  // stream stays in place.
  function openClara() {
    window.open(SHELL_URL + "/?chat=1", "_blank", "noopener");
  }

  // ── Downloads sheet ──────────────────────────────────────────────────
  var backdrop = null;
  function closeSheet() {
    if (backdrop) { backdrop.remove(); backdrop = null; }
  }
  var dlLastSeq = 0, dlTarget = "/Downloads/Clara Browser";
  function syncDownloads() {
    call("ClaraOS.downloads.recent").then(function (r) {
      var res = (r && r.result) || {};
      var list = res.downloads || [];
      if (res.target) dlTarget = res.target;
      var maxSeq = dlLastSeq;
      list.forEach(function (d) {
        if (d.seq > dlLastSeq) {
          if (d.state === "in Files") toast("⬇ " + d.name + " → Files von " + (d.owner || "?"));
          else if (d.state.indexOf("Fehler") === 0 || d.state.indexOf("zu groß") === 0) {
            toast("⬇ " + d.name + ": " + d.state);
          } else if (d.state === "läuft") toast("⬇ Download: " + d.name);
        }
        if (d.seq > maxSeq) maxSeq = d.seq;
      });
      dlLastSeq = maxSeq;
    });
  }
  function showDownloads() {
    call("ClaraOS.downloads.recent").then(function (r) {
      var res = (r && r.result) || {};
      var list = res.downloads || [];
      closeSheet();
      backdrop = el("div", "claraos-backdrop claraos-backdrop-center");
      var sheet = el("div", "claraos-sheet claraos-sheet-desktop");
      backdrop.appendChild(sheet);
      backdrop.addEventListener("click", function (ev) {
        if (ev.target === backdrop) closeSheet();
      });
      var head = el("div", "claraos-sheet-head");
      head.appendChild(el("div", "claraos-sheet-title", "")).textContent = "Downloads";
      var sub = el("div", "claraos-sheet-sub", "");
      sub.textContent = "Landen automatisch in Files → " + (res.target || dlTarget);
      head.appendChild(sub);
      sheet.appendChild(head);
      if (!list.length) {
        var empty = el("div", "claraos-sheet-sub", "");
        empty.style.padding = "4px 20px 12px";
        empty.textContent = "Noch keine Downloads in dieser Sitzung.";
        sheet.appendChild(empty);
      }
      list.forEach(function (d) {
        var kb = d.bytes ? " · " + Math.max(1, Math.round(d.bytes / 1024)) + " kB" : "";
        var it = el("button", "claraos-sheet-item",
          ICONS.download + "<span></span>");
        it.querySelector("span").textContent = d.name + " — " + d.state + kb +
          (d.owner ? " · " + d.owner : "");
        it.addEventListener("click", function () {
          closeSheet();
          copyToLocal((res.target || dlTarget) + "/" + d.name, "Pfad kopiert");
        });
        sheet.appendChild(it);
      });
      document.body.appendChild(backdrop);
    });
  }

  // ── Floating buttons (bottom right, unobtrusive) ─────────────────────
  function build() {
    var dock = el("div", "");
    dock.id = "claraos-dock";

    // Inside the ClaraOS shell the window already has a Clara button in its
    // title bar (Window.tsx, NATIVE_CLARA_APPS), so do not show a second one.
    // It only appears when opened directly (own tab/phone), then in the same
    // look as in the shell: pill, sparkle, label "Clara".
    var inShell = false;
    try { inShell = window.parent && window.parent !== window; } catch (e) { inShell = true; }
    var clara = null;
    if (!inShell) {
      clara = el("button", "claraos-clarapill",
        ICONS.clara + "<span>Assistent</span>");
      clara.title = "Mit dem Assistenten reden";
      clara.setAttribute("aria-label", "Assistent fragen");
      clara.addEventListener("click", openClara);
    }

    var dl = el("button", "claraos-dockbtn", ICONS.download);
    dl.title = "Downloads (gehen in die Files-App)";
    dl.setAttribute("aria-label", "Downloads");
    dl.addEventListener("click", showDownloads);

    dock.appendChild(dl);
    if (clara) dock.appendChild(clara);
    document.body.appendChild(dock);

    setInterval(syncDownloads, 5000);
    syncDownloads();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
