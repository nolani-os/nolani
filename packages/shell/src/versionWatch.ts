import { getBrand } from "@claraos/core";
// Version watch — the shell notices by itself when a new build has been
// deployed, and fetches it.
//
// WHY THIS EXISTS:
// After a frontend rebuild, a phone could show the old build for days. The
// frontend's access log showed the device had only fetched `icon-192.png` and
// `favicon.svg` since the rebuild — no `index.html`, not a single JS bundle.
// The deployment was fine; the client simply never requested it.
// The root cause is in the companion app: `ShellActivity.java` calls
// `webView.loadUrl(...)` only in `onCreate` (cold start) and for a deep link.
// No reload on resume, no pull-to-refresh, no version check. As long as the
// process lives, the WebView keeps the old page — indefinitely.
//
// Deliberately HERE instead of in Java: an Android fix would need a new APK
// that users must install first — until then the bug would persist. This check
// works in the companion WebView just like in any browser and in the desktop
// companion, and it ships automatically with the next deployment.
//
// Important, and above everything else: NEVER reload unprompted if something
// could be lost. A watcher that throws away half-typed text is worse than the
// stale build it fixes.

/** Name of the main bundle, e.g. "/assets/index-Ddj-vXj7-1789460659483.js". */
const BUENDEL_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** Minimum interval between two checks — resumes can follow each other quickly. */
const PRUEF_ABSTAND_MS = 30_000;
/** Interval while the UI is visible (a desktop stays open for days). */
const TURNUS_MS = 30 * 60 * 1000;
/** First check only once startup has finished. */
const ERSTE_PRUEFUNG_MS = 60_000;
/** Marker against reload loops in case the new build still does not arrive. */
const SCHLEIFEN_KEY = "claraos:versionWatch:geladenFuer";

let laufend = false;
let letztePruefung = 0;
let gemeldet: string | null = null;
let leiste: HTMLElement | null = null;

/** The bundle that is running NOW. `null` = dev server (`/src/main.tsx`). */
function laufendesBuendel(): string | null {
  const s = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="/assets/index-"]',
  );
  const treffer = s?.getAttribute("src")?.match(BUENDEL_RE);
  return treffer ? treffer[0] : null;
}

/** The bundle the server is serving NOW. `null` = cannot be determined. */
async function ausgeliefertesBuendel(): Promise<string | null> {
  try {
    // Important: `redirect: "manual"` — with an expired proxy session the
    // reverse proxy answers with a 302 to the identity provider; without this
    // we would get a bare CORS error. This way the case arrives as
    // `opaqueredirect` and we simply do nothing.
    // (sessionGuard does not touch this call — it only wraps `/api/`.)
    const r = await fetch("/index.html", { cache: "no-store", redirect: "manual" });
    if (!r.ok || r.type === "opaqueredirect") return null;
    const treffer = (await r.text()).match(BUENDEL_RE);
    return treffer ? treffer[0] : null;
  } catch {
    return null; // offline, tunnel down, server restarting — none of these is a reason to act
  }
}

/**
 * May we reload without asking?
 *
 * Important: when in doubt, NO. Every check here stands for work a reload
 * would destroy, and none of them is hypothetical.
 */
function gefahrlos(): { ok: true } | { ok: false; grund: string } {
  // A third-party app in an iframe: what is typed into its forms is invisible
  // from outside (cross-origin). A reload would throw it away.
  if (document.querySelector("iframe")) return { ok: false, grund: "App offen" };

  // Half-typed text — composer, search field, editor.
  const felder = document.querySelectorAll<HTMLElement>(
    'textarea, input[type="text"], input[type="search"], input:not([type]), [contenteditable="true"]',
  );
  for (const f of felder) {
    const wert =
      f instanceof HTMLTextAreaElement || f instanceof HTMLInputElement
        ? f.value
        : f.textContent ?? "";
    if (wert.trim()) return { ok: false, grund: "ungesendeter Text" };
  }

  // Clara is working: the activity card carries its phase in the DOM, the
  // mobile sheet its `data-streamt`. Both indicators exist anyway — so this
  // watcher needs no direct wiring into the chat.
  if (document.querySelector('[data-claraos-activity-card]:not([data-phase="done"])'))
    return { ok: false, grund: `${getBrand().assistant} arbeitet` };
  if (document.querySelector('[data-streamt="true"]')) return { ok: false, grund: "Antwort läuft" };

  // Ongoing playback (video, music, text-to-speech).
  for (const m of document.querySelectorAll("video, audio")) {
    if (!(m as HTMLMediaElement).paused) return { ok: false, grund: "Wiedergabe läuft" };
  }
  return { ok: true };
}

function neuLaden(ziel: string): void {
  try {
    sessionStorage.setItem(SCHLEIFEN_KEY, ziel);
  } catch { /* no storage — then without loop protection */ }
  location.reload();
}

/** Unobtrusive bar: a tap reloads, the ✕ postpones until the next build. */
function leisteZeigen(ziel: string, grund: string): void {
  if (leiste) return;
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.dataset.claraosVersionshinweis = "true";
  // Important: at the TOP, not the bottom. At the bottom edge it would sit
  // right over the input field on phones — and the most common reason for not
  // reloading is unsent text, which requires exactly that field. On desktop
  // it would cover the taskbar. At the top both stay free.
  el.style.cssText = [
    "position:fixed", "left:12px", "right:12px", "z-index:2147483000",
    "top:calc(12px + env(safe-area-inset-top, 0px))",
    "max-width:560px", "margin:0 auto",
    "display:flex", "align-items:center", "gap:10px",
    "padding:10px 12px", "border-radius:12px",
    "background:var(--bg-window-solid, #0c1426)",
    "border:1px solid rgba(147,197,253,0.22)",
    "box-shadow:0 8px 28px rgba(0,0,0,0.45)",
    "color:var(--color-text, #f2f6ff)",
    "font:500 0.875rem/1.3 system-ui, sans-serif",
  ].join(";");

  const text = document.createElement("span");
  text.style.cssText = "flex:1;min-width:0";
  // Include the reason: otherwise the bar looks like an ad rather than an
  // explanation ("why doesn't it just reload?").
  // Keep it short: the longer the sentence, the more lines, the more it covers.
  text.textContent = `Neuer Stand verfügbar — ${grund}`;

  const knopf = document.createElement("button");
  knopf.type = "button";
  knopf.textContent = "Jetzt laden";
  knopf.style.cssText = [
    "flex:0 0 auto", "padding:8px 14px", "border-radius:10px", "cursor:pointer",
    "border:1px solid rgba(56,189,248,0.5)", "background:rgba(56,189,248,0.18)",
    "color:inherit", "font:inherit", "min-height:40px",
  ].join(";");
  knopf.addEventListener("click", () => neuLaden(ziel));

  const zu = document.createElement("button");
  zu.type = "button";
  zu.setAttribute("aria-label", "Später");
  zu.textContent = "✕";
  zu.style.cssText = [
    "flex:0 0 auto", "width:40px", "height:40px", "border-radius:50%", "cursor:pointer",
    "border:1px solid rgba(147,197,253,0.18)", "background:transparent",
    "color:inherit", "font:inherit",
  ].join(";");
  zu.addEventListener("click", () => { el.remove(); leiste = null; });

  el.append(text, knopf, zu);
  document.body.appendChild(el);
  leiste = el;
}

async function pruefen(): Promise<void> {
  const jetzt = Date.now();
  if (jetzt - letztePruefung < PRUEF_ABSTAND_MS) return;
  letztePruefung = jetzt;

  const laeuft = laufendesBuendel();
  if (!laeuft) return; // dev server: there is no bundle to compare
  const dort = await ausgeliefertesBuendel();
  if (!dort || dort === laeuft) return;

  // Loop protection: if we already reloaded once for exactly this build and
  // are still running the old one, a second attempt will not help — a cache
  // is to blame, and the user should see that instead of being stuck in a
  // reload loop.
  let schonVersucht = false;
  try {
    schonVersucht = sessionStorage.getItem(SCHLEIFEN_KEY) === dort;
  } catch { /* ignore */ }

  if (gemeldet === dort && leiste) return;
  gemeldet = dort;

  const lage = gefahrlos();
  if (lage.ok && !schonVersucht) {
    neuLaden(dort);
    return;
  }
  // Order of reasons: first what the user can act on ("unsent text" → send or
  // discard it). Loop protection is an internal detail and must not hide the
  // concrete reason.
  leisteZeigen(dort, !lage.ok ? lage.grund : "schon einmal versucht");
}

/** Starts the watcher. Call once from `main.tsx`. */
export function installVersionWatch(): void {
  if (laufend) return;
  laufend = true;

  // The most important trigger: the app returns from the background. This is
  // exactly where the companion WebView does nothing on its own.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void pruefen();
  });
  // A desktop window stays visible for days — there only the interval helps.
  window.setInterval(() => { if (document.visibilityState === "visible") void pruefen(); }, TURNUS_MS);
  window.setTimeout(() => { void pruefen(); }, ERSTE_PRUEFUNG_MS);
}

/** For tests only: check immediately without waiting for the interval. */
export function versionJetztPruefen(): Promise<void> {
  letztePruefung = 0;
  return pruefen();
}
