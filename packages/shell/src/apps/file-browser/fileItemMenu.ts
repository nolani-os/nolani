/**
 * Per-file menu of the files app: ONE source for the Radix context menu
 * (desktop) and the ActionSheet (mobile). variant controls desktop-only
 * entries (desktop shortcut, shortcut hints).
 *
 * Grouped and with icons. Rarely used entries (archive, encrypt, versions,
 * print, shortcut) live under "More actions"; everyday actions stay on top.
 */
import { getBrand } from "@claraos/core";
import type { ReactNode } from "react";
import type { FileNode } from "@claraos/core";
import type { ContextMenuItem } from "../../components/WindowContextMenu";
import type { IconName } from "../../components/Icon";
import type { ViewerAppId } from "../../lib/fileTypeRouter";

/** "Open with…" entries, generated from the central router. */
export const OPEN_WITH_VIEWERS: { id: ViewerAppId; label: string }[] = [
  { id: "image-viewer", label: "Bildbetrachter" },
  { id: "pdf-viewer", label: "PDF-Viewer" },
  { id: "text-editor", label: "Text-Editor" },
  { id: "video-player", label: "Videoplayer" },
  { id: "office-viewer", label: "Office (Collabora)" },
  { id: "model-viewer", label: "3D-Viewer" },
];

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
  const deleteItem: ContextMenuItem = {
    // Dolphin pattern (DolphinRemoveAction): with Shift held, "move to
    // trash" becomes permanent deletion: one entry instead of two, and you
    // see before clicking what will happen.
    id: "delete",
    label: (ctx.trashEnabled && !ctx.shiftHeld ? "In Papierkorb verschieben" : "Endgültig löschen") + mal,
    icon: sym("trash"),
    ...(desktop ? { shortcut: ctx.shiftHeld ? "Umschalt+Entf" : "Entf" } : {}),
    variant: "destructive",
    onSelect: () => { void ctx.onDelete(node, ctx.shiftHeld === true); },
  };

  if (multi) {
    // Multi-selection: only what makes sense for a list; honest, rather than
    // entries that silently apply only to the clicked file.
    return [
      { id: "download", label: `Als ZIP herunterladen${mal}`, icon: sym("import"), onSelect: () => ctx.onDownload(node) },
      { id: "sep1", label: "---" },
      { id: "copy", label: `Kopieren${mal}`, icon: sym("copy"), ...(desktop ? { shortcut: "Strg+C" } : {}), onSelect: () => ctx.onCopy(node) },
      { id: "cut", label: `Ausschneiden${mal}`, icon: sym("scissors"), ...(desktop ? { shortcut: "Strg+X" } : {}), onSelect: () => ctx.onCut(node) },
      deleteItem,
    ];
  }

  // Rarely used: one level down
  const weitere: ContextMenuItem[] = [
    ...(!node.isDir && ctx.onPrint ? [{ id: "print", label: "Drucken …", onSelect: () => ctx.onPrint!(node) }] : []),
    { id: "archive", label: "Als ZIP archivieren", onSelect: () => ctx.onArchive(node) },
    ...(!node.isDir && node.name.toLowerCase().endsWith(".zip")
      ? [{ id: "extract", label: "Entpacken", onSelect: () => ctx.onExtract(node) }]
      : []),
    { id: "encrypt", label: "Verschlüsseln (AES-ZIP) …", onSelect: () => ctx.onEncrypt(node) },
    ...(!node.isDir && ctx.onVersions
      ? [{ id: "versions", label: "Frühere Versionen …", onSelect: () => ctx.onVersions!(node) }]
      : []),
    ...(desktop && ctx.onDesktopShortcut
      ? [{ id: "shortcut-desktop", label: "Auf Desktop verknüpfen", onSelect: () => ctx.onDesktopShortcut!(node) }]
      : []),
    ...(desktop && node.isDir && ctx.onAddToPlaces
      ? [{ id: "add-place", label: "Zu Orten hinzufügen", onSelect: () => ctx.onAddToPlaces!(node) }]
      : []),
  ];

  return [
    { id: "open", label: "Öffnen", icon: sym(node.isDir ? "folder" : "document"), onSelect: () => ctx.onOpen(node) },
    ...(!node.isDir
      ? [{
          id: "open-with",
          label: "Öffnen mit …",
          submenu: OPEN_WITH_VIEWERS.map((v) => ({
            id: `ow-${v.id}`,
            label: v.id === ctx.defaultApp ? `${v.label} (Standard)` : v.label,
            onSelect: () => ctx.onOpenWith(node, v.id),
          })),
        }]
      : []),
    ...(desktop && node.isDir && ctx.onOpenInNewTab
      ? [{ id: "open-tab", label: "In neuem Tab öffnen", onSelect: () => ctx.onOpenInNewTab!(node) }]
      : []),
    ...(desktop && node.isDir && ctx.onOpenInSplit
      ? [{ id: "open-split", label: "In geteilter Ansicht öffnen", onSelect: () => ctx.onOpenInSplit!(node) }]
      : []),
    { id: "sep1", label: "---" },
    { id: "copy", label: "Kopieren", icon: sym("copy"), ...(desktop ? { shortcut: "Strg+C" } : {}), onSelect: () => ctx.onCopy(node) },
    { id: "cut", label: "Ausschneiden", icon: sym("scissors"), ...(desktop ? { shortcut: "Strg+X" } : {}), onSelect: () => ctx.onCut(node) },
    ...(node.isDir && ctx.onPaste
      ? [{ id: "paste-into", label: "Hier hinein einfügen", icon: sym("import"), onSelect: () => ctx.onPaste!(node) }]
      : []),
    { id: "rename", label: "Umbenennen", icon: sym("pen"), ...(desktop ? { shortcut: "F2" } : {}), onSelect: () => ctx.onRename(node) },
    deleteItem,
    { id: "sep2", label: "---" },
    {
      id: "download",
      // Folders are delivered as ZIP
      label: node.isDir ? "Als ZIP herunterladen" : "Herunterladen",
      icon: sym("import"),
      onSelect: () => ctx.onDownload(node),
    },
    ...(ctx.onShare ? [{ id: "share", label: "Teilen …", icon: sym("share"), onSelect: () => ctx.onShare!(node) }] : []),
    ...(ctx.onToggleFavorite
      ? [{
          id: "favorite",
          label: ctx.isFavorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen",
          icon: sym("star"),
          onSelect: () => ctx.onToggleFavorite!(node),
        }]
      : []),
    ...(ctx.onClaraAnalyze
      ? [{ id: "clara", label: `Mit ${getBrand().assistant} analysieren`, icon: sym("sparkle"), onSelect: () => ctx.onClaraAnalyze!(node) }]
      : []),
    { id: "more", label: "Weitere Aktionen", icon: sym("more"), submenu: weitere },
    { id: "sep3", label: "---" },
    { id: "props", label: "Eigenschaften", icon: sym("gear"), onSelect: () => ctx.onProperties(node) },
  ];
}
