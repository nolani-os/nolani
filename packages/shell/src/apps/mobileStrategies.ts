// Mobile strategy resolution for iframe apps.
//
// Header probe: the reverse proxy strips X-Frame-Options + CSP
// frame-ancestors for ALL proxied services, so header-wise every
// app is iframe-able on mobile exactly like on desktop. The only genuine
// blocker left is mixed-content HTTP (a service reachable only via http://).
//
// Strategies:
//   - iframe   : inline (default). Works for every responsive web app. Selkies/
//                KasmVNC desktop GUIs also embed inline; IframeApp forces
//                show_control_bar=true on mobile so touch input works.
//   - redirect : open a new top-level tab. Only for what truly can't embed
//                (mixed-content HTTP).
//   - choice   : mobile landing page offering BOTH "open inline in ClaraOS"
//                (iframe) and "open native app" (deep link). For apps with a
//                solid native Android app where the user may prefer either.
//   - deeplink : try native scheme, fall back to web tab (kept for backend
//                override; no hardcoded entries).
//
// Backend can override any app via AppManifest.mobileStrategy/deeplinkScheme.
import type { AppManifest } from "@claraos/core";

type Strategy = NonNullable<AppManifest["mobileStrategy"]>;

interface Override {
  strategy: Strategy;
  scheme?: string;
}

// Apps that genuinely can't be iframed on mobile -> force a new tab.
// HTTP-only origins -> mixed content inside the HTTPS ClaraOS shell. The
// product has none; optional site-specific entries may be listed in
// heim.config.ts.
const heimConfig = import.meta.glob<{ MOBILE_REDIRECT_APPS?: string[] }>("../heim.config.ts", { eager: true });
const REDIRECT_BLOCKLIST: Record<string, true> = Object.fromEntries(
  (Object.values(heimConfig)[0]?.MOBILE_REDIRECT_APPS ?? []).map((id) => [id, true as const]),
);

// Product decision: NO "choice" landing page any more — apps ALWAYS open
// inline in ClaraOS by default. The former CHOICE_NATIVE list
// (embedded apps that also have native mobile clients)
// has been removed; anyone who wants a native app can still
// re-enable it per app via a backend override (AppManifest.mobileStrategy=
// "choice"/"deeplink" + deeplinkScheme) — the rendering path remains.

export function resolveMobileStrategy(
  manifest: Pick<AppManifest, "id" | "mobileStrategy" | "deeplinkScheme" | "type">,
): Override {
  // Backend override wins
  if (manifest.mobileStrategy) {
    return { strategy: manifest.mobileStrategy, scheme: manifest.deeplinkScheme };
  }
  if (REDIRECT_BLOCKLIST[manifest.id]) return { strategy: "redirect" };
  // type "selkies" is routed directly in MobileShell (mobile-tuned browser
  // twin; a native tab would mix sessions with the private browser) — no
  // special case here any more.
  return { strategy: "iframe" };
}
