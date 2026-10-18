// Per-app bar colours for the mobile shell: while an app is open, the
// (otherwise transparent) ClaraOS status bar and bottom nav adopt the app's
// own colours — top = the app's header colour, bottom = its content/footer
// background — so the bars read as part of the app (Android edge-to-edge
// look). Apps run in cross-origin iframes, so their real pixels cannot be
// sampled; this curated map is the reliable source. Unknown apps fall back
// to the neutral dark shell tone.

export interface BarColors {
  top: string;
  bottom: string;
}

export const DEFAULT_BAR: BarColors = { top: "#101624", bottom: "#101624" };

const NC = { top: "#0082c9", bottom: "#ffffff" }; // Nextcloud family
const DARK = (c: string): BarColors => ({ top: c, bottom: c });

const COLORS: Record<string, BarColors> = {
  // Nextcloud family — blue header, light content
  "nextcloud": NC,
  // "files": no Nextcloud blue any more — the Files app uses the skin colors
  "nextcloud-mail": NC,
  "bulwark-mail": NC,
  "nextcloud-calendar": NC,
  "nextcloud-contacts": NC,
  "nextcloud-talk": NC,
  "nextcloud-deck": NC,
  "nextcloud-appointments": NC,
  "nextcloud-markdown": NC,
  "nextcloud-writer": { top: "#f5f5f5", bottom: "#ffffff" },   // Collabora UI
  "nextcloud-calc": { top: "#f5f5f5", bottom: "#ffffff" },
  "nextcloud-impress": { top: "#f5f5f5", bottom: "#ffffff" },
  "nextcloud-drawio": { top: "#ffffff", bottom: "#ffffff" },

  // Dark-UI apps
  "planner": DARK("#0f172a"),
  "open-webui": DARK("#0f1117"),
  "mastodon": DARK("#191b22"),
  "element": DARK("#15191e"),
  "selkies-browser": DARK("#202124"),
  "peertube": DARK("#111111"),

  // Light-UI apps with branded headers
  "immich": { top: "#4250af", bottom: "#ffffff" },
  "paperless": { top: "#17541f", bottom: "#f5f5f5" },
  "vaultwarden": { top: "#175ddc", bottom: "#ffffff" },
  "authentik": { top: "#1a1b1e", bottom: "#f2f2f2" },
  "litellm": { top: "#ffffff", bottom: "#ffffff" },
};

// Colours of this installation's own apps (heim.config.ts).
const heimConfig = import.meta.glob<{ APP_BAR_COLORS?: Record<string, BarColors> }>("../heim.config.ts", { eager: true });
Object.assign(COLORS, Object.values(heimConfig)[0]?.APP_BAR_COLORS ?? {});

/** Bar colours for an app id (neutral dark default for unknown apps). */
export function appBarColors(appId: string | undefined | null): BarColors {
  return (appId && COLORS[appId]) || DEFAULT_BAR;
}

/** Legible foreground (icons/text) for a given bar background. */
export function barFg(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return "#ffffff";
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? "#1c2430" : "#ffffff";
}
