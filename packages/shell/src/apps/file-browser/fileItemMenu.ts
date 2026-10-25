/**
 * Per-file menu of the files app: ONE source for the Radix context menu
 * (desktop) and the ActionSheet (mobile). variant controls desktop-only
 * entries (desktop shortcut, shortcut hints).
 *
 * Grouped and with icons. Rarely used entries (archive, encrypt, versions,
 * print, shortcut) live under "More actions"; everyday actions stay on top.
 */
import { i18n } from "@claraos/core";
import type { ReactNode } from "react";
import type { FileNode } from "@claraos/core";
import type { ContextMenuItem } from "../../components/WindowContextMenu";
import type { IconName } from "../../components/Icon";
import type { ViewerAppId } from "../../lib/fileTypeRouter";

/** Translate at call time (never at module load: the language can change). */
function tr(key: string, opts?: Record<string, unknown>): string {
  return i18n.t(`files:${key}`, opts);
}

const VIEWER_IDS: ViewerAppId[] = [
  "image-viewer", "pdf-viewer", "text-editor", "video-player", "office-viewer", "model-viewer",
];

/** "Open with…" entries, generated from the central router.
 *  `label` is a getter, so it is always in the current UI language. */
export const OPEN_WITH_VIEWERS: { readonly id: ViewerAppId; readonly label: string }[] = VIEWER_IDS.map((id) => ({
  id,
  get label() { return tr(`viewers.${id}`); },
}));

export interface FileMenuCtx {
  variant: "desktop" | "mobile";
  /** Draws a menu icon. Passed in from the view so that this file stays
   *  loadable without React/an icon set (test/mobile.smoke.mjs). */
  symbol?: (name: IconName) => ReactNode;
  /** How many entries the action applies to (multi-selection).
   *  >1: count in the label, single-item actions (rename, open with …) hidden. */
  count?: number;
  /** Folder + non-empty clipboard only: "paste into here". */
  onPaste?: (node: FileNode) => void;
  /** Default app of the file (null for folders/unknown) for the "(default)" marker. */
  defaultApp: string | null;
  /** true (Nextcloud): delete moves to the trash, and the label says so. */
  trashEnabled?: boolean;
  onOpen: (node: FileNode) => void;
  onOpenWith: (node: FileNode, viewerId: ViewerAppId) => void;
  onClaraAnalyze?: (node: FileNode) => void;
  onDownload: (node: FileNode) => void;
  onArchive: (node: FileNode) => void;
  onExtract: (node: FileNode) => void;
  onEncrypt: (node: FileNode) => void;
  /** Desktop only: put a .lnk.json on the ClaraOS desktop. */
  onDesktopShortcut?: (node: FileNode) => void;
  /** Desktop only: open folder in a new tab (Dolphin tabRequested). */
  onOpenInNewTab?: (node: FileNode) => void;
  /** Desktop only: open folder in the second pane (Dolphin Open in Split View). */
  onOpenInSplit?: (node: FileNode) => void;
  /** Desktop only: add folder to the places panel (KFilePlaces Add to Places). */
  onAddToPlaces?: (node: FileNode) => void;
  /** Nextcloud: set/remove star (oc:favorite). */
  onToggleFavorite?: (node: FileNode) => void;
  isFavorite?: boolean;
  /** Print: only set when the household has a printer. */
  onPrint?: (node: FileNode) => void;
  onCopy: (node: FileNode) => void;
  onCut: (node: FileNode) => void;
  onRename: (node: FileNode) => void;
  onDelete: (node: FileNode, permanent?: boolean) => void | Promise<void>;
  /** Shift pressed? Turns "trash" into permanent deletion. */
  shiftHeld?: boolean;
  /** Only set for Nextcloud sources; SFTP cannot do links. */
  onShare?: (node: FileNode) => void;
  /** Nextcloud files: "Previous versions" dialog (NC versions DAV). */
  onVersions?: (node: FileNode) => void;
  onProperties: (node: FileNode) => void;
}

export function buildFileItemMenu(node: FileNode, ctx: FileMenuCtx): ContextMenuItem[] {
  const sym = (name: IconName): ReactNode => ctx.symbol?.(name);
  const desktop = ctx.variant === "desktop";
  const n = ctx.count ?? 1;
  const multi = n > 1;
  const mal = multi ? ` (${n})` : "";
  const ctrl = tr("keys.ctrl");
  const del = tr("keys.del");
  const deleteItem: ContextMenuItem = {
    // Dolphin pattern (DolphinRemoveAction): with Shift held, "move to
    // trash" becomes permanent deletion: one entry instead of two, and you
    // see before clicking what will happen.
    id: "delete",
    label: (ctx.trashEnabled && !ctx.shiftHeld ? tr("actions.moveToTrash") : tr("actions.deletePermanently")) + mal,
    icon: sym("trash"),
    ...(desktop ? { shortcut: ctx.shiftHeld ? `${tr("keys.shift")}+${del}` : del } : {}),
    variant: "destructive",
    onSelect: () => { void ctx.onDelete(node, ctx.shiftHeld === true); },
  };

  if (multi) {
    // Multi-selection: only what makes sense for a list; honest, rather than
    // entries that silently apply only to the clicked file.
    return [
      { id: "download", label: `${tr("menu.downloadZip")}${mal}`, icon: sym("import"), onSelect: () => ctx.onDownload(node) },
      { id: "sep1", label: "---" },
      { id: "copy", label: `${tr("actions.copy")}${mal}`, icon: sym("copy"), ...(desktop ? { shortcut: `${ctrl}+C` } : {}), onSelect: () => ctx.onCopy(node) },
      { id: "cut", label: `${tr("actions.cut")}${mal}`, icon: sym("scissors"), ...(desktop ? { shortcut: `${ctrl}+X` } : {}), onSelect: () => ctx.onCut(node) },
      deleteItem,
    ];
  }

  // Rarely used: one level down
  const weitere: ContextMenuItem[] = [
    ...(!node.isDir && ctx.onPrint ? [{ id: "print", label: tr("menu.print"), onSelect: () => ctx.onPrint!(node) }] : []),
    { id: "archive", label: tr("menu.archive"), onSelect: () => ctx.onArchive(node) },
    ...(!node.isDir && node.name.toLowerCase().endsWith(".zip")
      ? [{ id: "extract", label: tr("actions.extract"), onSelect: () => ctx.onExtract(node) }]
      : []),
    { id: "encrypt", label: tr("menu.encrypt"), onSelect: () => ctx.onEncrypt(node) },
    ...(!node.isDir && ctx.onVersions
      ? [{ id: "versions", label: tr("menu.versions"), onSelect: () => ctx.onVersions!(node) }]
      : []),
    ...(desktop && ctx.onDesktopShortcut
      ? [{ id: "shortcut-desktop", label: tr("menu.desktopShortcut"), onSelect: () => ctx.onDesktopShortcut!(node) }]
      : []),
    ...(desktop && node.isDir && ctx.onAddToPlaces
      ? [{ id: "add-place", label: tr("menu.addToPlaces"), onSelect: () => ctx.onAddToPlaces!(node) }]
      : []),
  ];

  return [
    { id: "open", label: tr("menu.open"), icon: sym(node.isDir ? "folder" : "document"), onSelect: () => ctx.onOpen(node) },
    ...(!node.isDir
      ? [{
          id: "open-with",
          label: tr("menu.openWith"),
          submenu: OPEN_WITH_VIEWERS.map((v) => ({
            id: `ow-${v.id}`,
            label: v.id === ctx.defaultApp ? tr("menu.defaultApp", { label: v.label }) : v.label,
            onSelect: () => ctx.onOpenWith(node, v.id),
          })),
        }]
      : []),
    ...(desktop && node.isDir && ctx.onOpenInNewTab
      ? [{ id: "open-tab", label: tr("menu.openInNewTab"), onSelect: () => ctx.onOpenInNewTab!(node) }]
      : []),
    ...(desktop && node.isDir && ctx.onOpenInSplit
      ? [{ id: "open-split", label: tr("menu.openInSplit"), onSelect: () => ctx.onOpenInSplit!(node) }]
      : []),
    { id: "sep1", label: "---" },
    { id: "copy", label: tr("actions.copy"), icon: sym("copy"), ...(desktop ? { shortcut: `${ctrl}+C` } : {}), onSelect: () => ctx.onCopy(node) },
    { id: "cut", label: tr("actions.cut"), icon: sym("scissors"), ...(desktop ? { shortcut: `${ctrl}+X` } : {}), onSelect: () => ctx.onCut(node) },
    ...(node.isDir && ctx.onPaste
      ? [{ id: "paste-into", label: tr("menu.pasteInto"), icon: sym("import"), onSelect: () => ctx.onPaste!(node) }]
      : []),
    { id: "rename", label: tr("actions.rename"), icon: sym("pen"), ...(desktop ? { shortcut: "F2" } : {}), onSelect: () => ctx.onRename(node) },
    deleteItem,
    { id: "sep2", label: "---" },
    {
      id: "download",
      // Folders are delivered as ZIP
      label: node.isDir ? tr("menu.downloadZip") : tr("actions.download"),
      icon: sym("import"),
      onSelect: () => ctx.onDownload(node),
    },
    ...(ctx.onShare ? [{ id: "share", label: tr("menu.share"), icon: sym("share"), onSelect: () => ctx.onShare!(node) }] : []),
    ...(ctx.onToggleFavorite
      ? [{
          id: "favorite",
          label: ctx.isFavorite ? tr("menu.removeFavorite") : tr("menu.addFavorite"),
          icon: sym("star"),
          onSelect: () => ctx.onToggleFavorite!(node),
        }]
      : []),
    ...(ctx.onClaraAnalyze
      ? [{ id: "clara", label: tr("menu.analyze"), icon: sym("sparkle"), onSelect: () => ctx.onClaraAnalyze!(node) }]
      : []),
    { id: "more", label: tr("menu.moreActions"), icon: sym("more"), submenu: weitere },
    { id: "sep3", label: "---" },
    { id: "props", label: tr("actions.properties"), icon: sym("gear"), onSelect: () => ctx.onProperties(node) },
  ];
}
