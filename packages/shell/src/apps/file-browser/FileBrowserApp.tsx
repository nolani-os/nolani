/**
 * Files app: device switch. Desktop keeps the classic layout
 * (sidebar/toolbar/context menus/lasso/DnD), mobile gets its own
 * Google-Files-like presentation. Both share useFileBrowserCore
 * (store/navigation/open routing) and buildFileItemMenu.
 *
 * The default export stays stable; registry.ts lazy-imports this file.
 */
import { useIsMobile } from "../../Mobile/useIsMobile";
import FileBrowserDesktop from "./FileBrowserDesktop";
import FileBrowserMobile from "./FileBrowserMobile";

export default function FileBrowserApp({ windowId }: { windowId: string }) {
  const isMobile = useIsMobile();
  return isMobile
    ? <FileBrowserMobile windowId={windowId} />
    : <FileBrowserDesktop windowId={windowId} />;
}
