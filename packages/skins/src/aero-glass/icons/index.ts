import type { ComponentType, SVGProps } from "react";

// Each *.svg?react import yields a ready-to-render React component
// (vite-plugin-svgr). Gradients defined inside the SVGs are preserved.
import Settings from "./settings.svg?react";
import Files from "./files.svg?react";
import TextEditor from "./text-editor.svg?react";
import PdfViewer from "./pdf-viewer.svg?react";
import ImageViewer from "./image-viewer.svg?react";
import VideoPlayer from "./video-player.svg?react";
import Weather from "./weather.svg?react";
import UserAdmin from "./user-admin.svg?react";
import TeamsWorkspace from "./teams-workspace.svg?react";
import Clara from "./clara.svg?react";
// External brand icons
import Nextcloud from "./nextcloud.svg?react";
import Vaultwarden from "./vaultwarden.svg?react";
import Mastodon from "./mastodon.svg?react";
import Peertube from "./peertube.svg?react";
import Element from "./element.svg?react";
import Immich from "./immich.svg?react";
import Paperless from "./paperless.svg?react";
import OpenWebui from "./open-webui.svg?react";
import SelkiesBrowser from "./selkies-browser.svg?react";
import NextcloudTalk from "./nextcloud-talk.svg?react";
import NextcloudMail from "./nextcloud-mail.svg?react";

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** Map appId → React component. Used by AppIcon when the active skin is "aero-glass". */
export const aeroGlassIcons: Record<string, IconComponent> = {
  // Internal apps (registry.ts)
  settings: Settings,
  files: Files,
  "text-editor": TextEditor,
  "pdf-viewer": PdfViewer,
  "image-viewer": ImageViewer,
  "video-player": VideoPlayer,
  weather: Weather,
  "user-admin": UserAdmin,
  "teams-workspace": TeamsWorkspace,
  clara: Clara,
  // External / SaaS apps (app_seeds.py)
  nextcloud: Nextcloud,
  vaultwarden: Vaultwarden,
  mastodon: Mastodon,
  peertube: Peertube,
  element: Element,
  immich: Immich,
  paperless: Paperless,
  "open-webui": OpenWebui,
  "selkies-browser": SelkiesBrowser,
  "nextcloud-talk": NextcloudTalk,
  "nextcloud-mail": NextcloudMail,
  "bulwark-mail": NextcloudMail,
};

// Icons of this installation's own apps (optional ../heim).
const heimIcons = import.meta.glob<{ heimAeroGlassIcons?: Record<string, IconComponent> }>("../../heim/index.ts", { eager: true });
Object.assign(aeroGlassIcons, Object.values(heimIcons)[0]?.heimAeroGlassIcons ?? {});
