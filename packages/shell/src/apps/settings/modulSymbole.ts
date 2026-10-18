/** Settings sidebar tiles: one icon per module from our own icon set, the
 *  color comes from the section — the same family as the desktop icon tiles
 *  (AppKachel), so sidebar, start menu and app center share one visual
 *  language. Unknown modules fall back to a gear + section color; nothing
 *  stays empty. */
import type { IconName } from "../../components/Icon";

const BEREICH: Record<string, string> = {
  appearance: "#7b5cff",
  workspace: "#2a6fd6",
  personalization: "#e0416b",
  privacy: "#6fd3ff",
  "language-time": "#56637a",
  connections: "#1b7a45",
  system: "#8c99b2",
};

const MODUL: Record<string, IconName> = {
  __quick__: "sun",
  appearance: "pen",
  personalization: "image",
  "workspace-behavior": "recents",
  shortcuts: "textSize",
  notifications: "bell",
  terminal: "terminal",
  files: "folder",
  "default-apps": "cube",
  "region-formats": "calendar",
  session: "history",
  "privacy-history": "history",
  "clara-memory": "sparkle",
  credentials: "lock",
  "app-connections": "link",
  "agent-keys": "lock",
  "mobile-push": "android",
  federation: "share",
  about: "comment",
};

export function modulPlaettchen(modulId: string, kategorieId?: string): { icon: IconName; farbe: string } {
  return {
    icon: MODUL[modulId] ?? "gear",
    farbe: modulId === "__quick__" ? "#6fd3ff" : (BEREICH[kategorieId ?? ""] ?? "#56637a"),
  };
}
