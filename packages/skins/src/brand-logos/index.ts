import type { ComponentType, SVGProps } from "react";

import L_authentik from "./authentik.svg?react";
import L_element from "./element.svg?react";
import L_files from "./files.svg?react";
import L_image_viewer from "./image-viewer.svg?react";
import L_immich from "./immich.svg?react";
import L_litellm from "./litellm.svg?react";
import L_mastodon from "./mastodon.svg?react";
import L_nextcloud_appointments from "./nextcloud-appointments.svg?react";
import L_nextcloud_calc from "./nextcloud-calc.svg?react";
import L_nextcloud_calendar from "./nextcloud-calendar.svg?react";
import L_nextcloud_contacts from "./nextcloud-contacts.svg?react";
import L_nextcloud_deck from "./nextcloud-deck.svg?react";
import L_nextcloud_drawio from "./nextcloud-drawio.svg?react";
import L_nextcloud_impress from "./nextcloud-impress.svg?react";
import L_nextcloud_mail from "./nextcloud-mail.svg?react";
import L_nextcloud_markdown from "./nextcloud-markdown.svg?react";
import L_nextcloud_talk from "./nextcloud-talk.svg?react";
import L_nextcloud_writer from "./nextcloud-writer.svg?react";
import L_nextcloud from "./nextcloud.svg?react";
import L_open_webui from "./open-webui.svg?react";
import L_paperless from "./paperless.svg?react";
import L_pdf_viewer from "./pdf-viewer.svg?react";
import L_peertube from "./peertube.svg?react";
import L_selkies_browser from "./selkies-browser.svg?react";
import L_settings from "./settings.svg?react";
import L_task_manager from "./task-manager.svg?react";
import L_teams_workspace from "./teams-workspace.svg?react";
import L_text_editor from "./text-editor.svg?react";
import L_user_admin from "./user-admin.svg?react";
import L_vaultwarden from "./vaultwarden.svg?react";
import L_video_player from "./video-player.svg?react";

export type BrandLogoComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** Brand logos (dashboard-icons, MIT) + white mono glyphs for generic apps. */
export const brandLogos: Record<string, BrandLogoComponent> = {
  "authentik": L_authentik,
  "element": L_element,
  "files": L_files,
  "image-viewer": L_image_viewer,
  "immich": L_immich,
  "litellm": L_litellm,
  "mastodon": L_mastodon,
  "nextcloud-appointments": L_nextcloud_appointments,
  "nextcloud-calc": L_nextcloud_calc,
  "nextcloud-calendar": L_nextcloud_calendar,
  "nextcloud-contacts": L_nextcloud_contacts,
  "nextcloud-deck": L_nextcloud_deck,
  "nextcloud-drawio": L_nextcloud_drawio,
  "nextcloud-impress": L_nextcloud_impress,
  "nextcloud-mail": L_nextcloud_mail,
  // Bulwark webmail: reuse the generic envelope logo
  "bulwark-mail": L_nextcloud_mail,
  "nextcloud-markdown": L_nextcloud_markdown,
  "nextcloud-talk": L_nextcloud_talk,
  "nextcloud-writer": L_nextcloud_writer,
  "nextcloud": L_nextcloud,
  "open-webui": L_open_webui,
  "paperless": L_paperless,
  "pdf-viewer": L_pdf_viewer,
  "peertube": L_peertube,
  "selkies-browser": L_selkies_browser,
  "settings": L_settings,
  "task-manager": L_task_manager,
  "teams-workspace": L_teams_workspace,
  "text-editor": L_text_editor,
  "user-admin": L_user_admin,
  "vaultwarden": L_vaultwarden,
  "video-player": L_video_player,
};

// Icons of this installation's own apps (optional ../heim).
const heimLogos = import.meta.glob<{ heimBrandLogos?: Record<string, BrandLogoComponent> }>("../heim/index.ts", { eager: true });
Object.assign(brandLogos, Object.values(heimLogos)[0]?.heimBrandLogos ?? {});

export function getBrandLogo(appId: string): BrandLogoComponent | null {
  return brandLogos[appId] ?? null;
}

/** Apps rendered as a clean white mono glyph directly on the dark glass bead
 *  (NO bright tile). Colourful brand logos keep the light squircle tile. */
export const PLATELESS_ICONS = new Set<string>([
  "settings",
  "files",
  "selkies-browser",
  "text-editor",
  "task-manager",
  "pdf-viewer",
  "image-viewer",
  "video-player",
  "user-admin",
  "teams-workspace",
  "nextcloud-appointments",
  "nextcloud-writer",
  "nextcloud-calc",
  "nextcloud-impress",
]);

// Apps of this installation (optional ../heim).
const heimPlateless = import.meta.glob<{ heimPlatelessIcons?: string[] }>("../heim/index.ts", { eager: true });
for (const id of Object.values(heimPlateless)[0]?.heimPlatelessIcons ?? []) PLATELESS_ICONS.add(id);

/** Brand colour as tile background. On the desktop the logo fills a 22 %
 *  squircle tile in its brand colour — instead of sitting shrunk on a small
 *  plate inside the navy bead. Derived from the SVGs (most common saturated
 *  colour) and corrected by hand where the logo is multi-coloured or white.
 *  ClaraOS's own apps are NOT listed here: they get their two-tone gradient
 *  from `AppKachel.tsx`. */
export const BRAND_BG: Record<string, string> = {
  "authentik": "#fd4b2d",
  "element": "#0dbd8b",
  "immich": "#1e1e2e",
  "litellm": "#2563eb",
  "mastodon": "#6364ff",
  "nextcloud": "#0082c9",
  "nextcloud-appointments": "#0082c9",
  "nextcloud-calc": "#0082c9",
  "nextcloud-calendar": "#0082c9",
  "nextcloud-contacts": "#0082c9",
  "nextcloud-deck": "#0082c9",
  "nextcloud-drawio": "#f08705",
  "nextcloud-impress": "#0082c9",
  "nextcloud-mail": "#0082c9",
  "nextcloud-markdown": "#004caf",
  "nextcloud-talk": "#0082c9",
  "nextcloud-writer": "#0082c9",
  "open-webui": "#0f1729",
  "paperless": "#17541f",
  "peertube": "#f1680d",
  "vaultwarden": "#175ddc",
};

// Icons of this installation's own apps (optional ../heim).
const heimBg = import.meta.glob<{ heimBrandBg?: Record<string, string> }>("../heim/index.ts", { eager: true });
Object.assign(BRAND_BG, Object.values(heimBg)[0]?.heimBrandBg ?? {});
