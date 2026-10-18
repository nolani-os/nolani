/** Generated file — do NOT edit by hand. */
import type { ComponentType, SVGProps } from "react";
import S_settings from "./settings.svg?react";
import S_task_manager from "./task-manager.svg?react";
import S_user_admin from "./user-admin.svg?react";
import S_services_hub from "./services-hub.svg?react";
import S_files from "./files.svg?react";
import S_planner from "./planner.svg?react";
import S_knowledge from "./knowledge.svg?react";
import S_ideas from "./ideas.svg?react";
import S_kontakte from "./kontakte.svg?react";
import S_teams_workspace from "./teams-workspace.svg?react";
import S_image_viewer from "./image-viewer.svg?react";
import S_video_player from "./video-player.svg?react";
import S_pdf_viewer from "./pdf-viewer.svg?react";
import S_text_editor from "./text-editor.svg?react";
import S_office_viewer from "./office-viewer.svg?react";
import S_wrapp_container from "./wrapp-container.svg?react";

export type AppSymbolComponent = ComponentType<SVGProps<SVGSVGElement>>;
export const appSymbols: Record<string, AppSymbolComponent> = {
  "settings": S_settings,
  "task-manager": S_task_manager,
  "user-admin": S_user_admin,
  "services-hub": S_services_hub,
  "files": S_files,
  "planner": S_planner,
  "knowledge": S_knowledge,
  "ideas": S_ideas,
  "kontakte": S_kontakte,
  "teams-workspace": S_teams_workspace,
  "image-viewer": S_image_viewer,
  "video-player": S_video_player,
  "pdf-viewer": S_pdf_viewer,
  "text-editor": S_text_editor,
  "office-viewer": S_office_viewer,
  "wrapp-container": S_wrapp_container,
};

// Icons of this installation's own apps (optional ../heim).
const heimSymbols = import.meta.glob<{ heimAppSymbols?: Record<string, AppSymbolComponent> }>("../heim/index.ts", { eager: true });
Object.assign(appSymbols, Object.values(heimSymbols)[0]?.heimAppSymbols ?? {});

export function getAppSymbol(appId: string): AppSymbolComponent | null {
  return appSymbols[appId] ?? null;
}
