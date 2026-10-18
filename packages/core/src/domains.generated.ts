// GENERATED — DO NOT EDIT BY HAND.
// Source: domains.yaml · regenerate with scripts/domains/gen.py

// The same frontend image runs in every installation. The domain is taken at
// runtime from the shell host (home.<domain>) — except for a host of the legacy
// domain, which falls back to the built-in value. No browser (tests) = built-in.
// Important: do NOT restrict this to the built-in domain — the open-source build
// carries a placeholder (example.com), and every cell has its own domain.
const _BUILD_BASE_DOMAIN = "example.com";
const _LEGACY = "";
function _laufzeitDomain(): string {
  try {
    const h = (globalThis as { location?: { hostname?: string } }).location?.hostname ?? "";
    const p = "home.";
    if (h.startsWith(p)) {
      const d = h.slice(p.length);
      if (d && !(_LEGACY && (d === _LEGACY || d.endsWith("." + _LEGACY)))) return d;
    }
  } catch {
    /* no window */
  }
  return _BUILD_BASE_DOMAIN;
}
export const BASE_DOMAIN = _laufzeitDomain();
export const LEGACY_DOMAIN = "";

export const APP_HOSTS: Record<string, string> = {
  "admin-view": "admin-view",
  "authentik": "auth",
  "claraos": "home",
  "collabora": "collabora",
  "element": "element",
  "element-call": "call",
  "jmap": "jmap",
  "litellm": "litellm",
  "matrix": "matrix",
  "nextcloud": "nextcloud",
  "ntfy": "push",
  "openwebui": "chat",
  "vaultwarden": "vault",
  "vikunja": "planner",
};

export const PENDING_HOSTS: Record<string, string> = {
};

export function host(app: string): string {
  if (app in APP_HOSTS) return `${APP_HOSTS[app]}.${BASE_DOMAIN}`;
  if (app in PENDING_HOSTS) return `${PENDING_HOSTS[app]}.${LEGACY_DOMAIN}`;
  throw new Error(`Unknown app ${app} — add it to domains.yaml`);
}

export function url(app: string, path = ""): string {
  return `https://${host(app)}${path}`;
}

export const SHELL_HOST = "home";
export function shellUrl(path = ""): string {
  return `https://${SHELL_HOST}.${BASE_DOMAIN}${path}`;
}

