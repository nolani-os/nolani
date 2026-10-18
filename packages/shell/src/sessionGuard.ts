// Session guard: heals expired Authentik forward_auth sessions by itself.
//
// Problem: when the proxy session expires, the reverse proxy answers every API
// XHR with a 302 to the identity provider (e.g. auth.example.com). fetch()
// follows cross-origin, Authentik sends no CORS headers → a bare
// `TypeError: Failed to fetch` in every error bar, and nothing ever reconnects
// (WS reconnects loop against the dead session).
//
// Solution: window.fetch is wrapped for same-origin /api/* calls and run with
// `redirect: "manual"`. An expired login then arrives unambiguously as
// `opaqueredirect` (distinguishable from a real network outage) and triggers
// EXACTLY ONE silent re-auth: an invisible iframe navigates to a protected
// endpoint, may follow the 302 (top-level navigation inside the frame),
// completes the OIDC dance with zero clicks (the Authentik session lives as long
// as the browser) and thereby renews the proxy cookie. The original request is
// then retried once. If that fails → ONE guarded full reload (max. 1/minute).
//
// No call-site changes needed: all raw fetch("/api/…") calls in the shell go
// through this wrapper automatically. WebSockets/SSE benefit indirectly: once
// any fetch has renewed the session, their reconnects work again.

const PROBE_PATH = "/api/claraos/me";
const RELOAD_GUARD_KEY = "claraos:sessionGuard:lastReload";
const REAUTH_TIMEOUT_MS = 8000;
const HIDDEN_PROBE_MIN_MS = 5 * 60 * 1000; // probe after ≥5 min of tab sleep

const origFetch = window.fetch.bind(window);
let reauthPromise: Promise<boolean> | null = null;
let hiddenSince = 0;

function isApiRequest(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url;
  return url.startsWith("/api/") || url.startsWith(`${location.origin}/api/`);
}

function sessionGone(res: Response): boolean {
  // opaqueredirect = proxy/Authentik 302 (status is always 0 in that case);
  // 401 = the API itself considers us logged out.
  return res.type === "opaqueredirect" || res.status === 401;
}

/** Silent re-auth via an invisible iframe. true = session restored. */
function silentReauth(): Promise<boolean> {
  if (reauthPromise) return reauthPromise; // single-flight
  reauthPromise = new Promise<boolean>((resolve) => {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    frame.setAttribute("aria-hidden", "true");
    let settled = false;

    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      frame.remove();
      try {
        const probe = await origFetch(PROBE_PATH, { redirect: "manual" });
        resolve(probe.type !== "opaqueredirect" && probe.ok);
      } catch {
        resolve(false);
      }
    };

    const timer = setTimeout(finish, REAUTH_TIMEOUT_MS);
    // load also fires for the cross-origin intermediate steps; contentWindow is
    // only accessible once the frame has landed same-origin again (JSON from /me)
    // — but we verify via a probe fetch anyway, not via the frame content.
    frame.addEventListener("load", () => {
      try {
        // back on same-origin? Then the OIDC dance is complete.
        if (frame.contentWindow?.location.origin === location.origin) void finish();
      } catch {
        /* still cross-origin (Authentik) — keep waiting */
      }
    });
    frame.src = PROBE_PATH;
    document.body.appendChild(frame);
  }).finally(() => {
    reauthPromise = null;
  });
  return reauthPromise;
}

function guardedReload(): void {
  const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || "0");
  if (Date.now() - last < 60_000) return; // prevent reload loops
  sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  window.location.reload();
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!isApiRequest(input)) return origFetch(input, init);

  const res = await origFetch(input, { ...init, redirect: "manual" });
  if (!sessionGone(res)) return res;

  const healed = await silentReauth();
  if (healed) {
    const retry = await origFetch(input, { ...init, redirect: "manual" });
    if (!sessionGone(retry)) return retry;
  }
  // Silent healing failed → let a top-level navigation follow the 302.
  guardedReload();
  throw new TypeError("Sitzung abgelaufen — Anmeldung wird erneuert …");
}) as typeof window.fetch;

// After suspend/resume or a long tab sleep, check proactively BEFORE widgets
// and WS reconnects run into a dead session.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenSince = Date.now();
    return;
  }
  if (hiddenSince && Date.now() - hiddenSince >= HIDDEN_PROBE_MIN_MS) {
    void window.fetch(PROBE_PATH).catch(() => undefined);
  }
  hiddenSince = 0;
});

export {};
