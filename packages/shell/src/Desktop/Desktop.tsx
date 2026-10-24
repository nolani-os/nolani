import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useWindowsStore, useUIStore, useWorkspaceStore, useDragStore, useTranslation } from "@claraos/core";
import { DesktopIcons, DESKTOP_ROOT, type DesktopIconsRef } from "./DesktopIcons";
import { DesktopWidgets } from "./DesktopWidgets";
import { WidgetGallery } from "./WidgetGallery";
import { widgetManifests } from "../widgets/registry";
import { FileTypeIcon } from "../components/FileTypeIcon";
import { NEW_FILE_TEMPLATES, templateLabel } from "../lib/newFileTemplates";
import { skinScenes } from "../skinScenes";
import styles from "./Desktop.module.css";

export function Desktop() {
  const { t } = useTranslation("desktop");
  const openWindow = useWindowsStore((s) => s.openWindow);
  const closeStartMenu = useUIStore((s) => s.closeStartMenu);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const setSkin = useUIStore((s) => s.setSkin);
  const skinId = useUIStore((s) => s.skinId);
  // Animated scene of the active skin (if any) behind the icons, plus its overlay.
  const SkinScene = skinScenes[skinId]?.Scene;
  const SkinOverlay = skinScenes[skinId]?.Overlay;
  const addWidget = useWorkspaceStore((s) => s.addWidget);
  const iconsRef = useRef<DesktopIconsRef>(null);
  const [widgetGalleryOpen, setWidgetGalleryOpen] = useState(false);

  // Cache of group-folder names for the current user. Drag-from-FilesApp into
  // /Desktop defaults to a shortcut (instead of a Move) when the source path
  // starts with one of these names — Move into /Desktop usually fails on GFs
  // because the user doesn't own them.
  const [groupFolders, setGroupFolders] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/claraos/files/v2/group-folders")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: string[]) => setGroupFolders(Array.isArray(list) ? list : []))
      .catch(() => setGroupFolders([]));
  }, []);

  const isGroupFolderPath = useCallback(
    (path: string) => {
      if (!groupFolders.length) return false;
      const top = path.replace(/^\/+/, "").split("/")[0];
      return top ? groupFolders.includes(top) : false;
    },
    [groupFolders],
  );

  // Drop-from-Files-app onto Desktop. Modifier-driven, Windows-style:
  //   default     → Move into /Desktop
  //   Alt         → create persistent .lnk.json shortcut
  //   Ctrl        → Copy into /Desktop
  //   GF-source   → forced to Shortcut (Move would fail on read-only GFs)
  const handleDesktopDrop = useCallback(async (e: React.DragEvent) => {
    const item = useDragStore.getState().current;
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();

    const altKey = e.altKey;
    const ctrlKey = e.ctrlKey || e.metaKey;

    type Op = "move" | "copy" | "shortcut";
    const paths: { path: string; name: string; isDir: boolean; source: string }[] = [];
    if (item.type === "file") {
      paths.push({
        path: item.path,
        name: item.name,
        isDir: item.isDir,
        source: item.source ?? "nextcloud",
      });
    } else if (item.type === "files") {
      for (const p of item.paths) {
        const name = p.split("/").filter(Boolean).pop() ?? p;
        paths.push({ path: p, name, isDir: false, source: item.source ?? "nextcloud" });
      }
    }
    useDragStore.getState().endDrag();

    if (paths.length === 0) return;

    for (const entry of paths) {
      // Skip drops of items already inside /Desktop (no-op)
      if (entry.path === DESKTOP_ROOT || entry.path.startsWith(`${DESKTOP_ROOT}/`)) continue;

      let op: Op;
      if (altKey) op = "shortcut";
      else if (ctrlKey) op = "copy";
      else if (isGroupFolderPath(entry.path)) op = "shortcut";
      else op = "move";

      try {
        if (op === "move") {
          await fetch("/api/claraos/files/v2/move", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              src_source: entry.source,
              src_path: entry.path,
              dst_source: "nextcloud",
              dst_path: `${DESKTOP_ROOT}/${entry.name}`,
              // Dropping has no confirmation prompt — items with the same name are kept
              on_conflict: "rename",
            }),
          });
        } else if (op === "copy") {
          await fetch("/api/claraos/files/v2/copy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              src_source: entry.source,
              src_path: entry.path,
              dst_source: "nextcloud",
              dst_path: DESKTOP_ROOT,
              on_conflict: "rename",
            }),
          });
        } else {
          await fetch("/api/claraos/files/v2/shortcut", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              target: entry.path,
              target_source: entry.source,
              target_type: entry.isDir ? "folder" : "file",
              name: entry.name,
            }),
          });
        }
      } catch (err) {
        console.error(`Desktop drop ${op} failed`, entry, err);
      }
    }

    iconsRef.current?.refresh();
  }, [isGroupFolderPath]);

  const handleDesktopDragOver = useCallback((e: React.DragEvent) => {
    if (useDragStore.getState().current) {
      e.preventDefault();
      // Reflect the operation in the cursor: link (shortcut), copy, or move.
      if (e.altKey) e.dataTransfer.dropEffect = "link";
      else if (e.ctrlKey || e.metaKey) e.dataTransfer.dropEffect = "copy";
      else {
        const cur = useDragStore.getState().current;
        const path = cur && (cur.type === "file" ? cur.path : cur.type === "files" ? cur.paths[0] : "");
        e.dataTransfer.dropEffect = path && isGroupFolderPath(path) ? "link" : "move";
      }
    }
  }, [isGroupFolderPath]);

  const handleDesktopClick = useCallback(() => {
    closeStartMenu();
    // Deselect all desktop icons when clicking empty area
    iconsRef.current?.clearSelection();
  }, [closeStartMenu]);

  const handleToggleTheme = useCallback(() => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
    setSkin(newTheme === "light" ? "windows11-light" : "windows11-dark");
  }, [setTheme, setSkin, theme]);

  const handleAddWidget = useCallback(
    (type: string) => {
      const m = widgetManifests[type];
      if (!m) return;
      // Find the first free spot in the 90px grid instead of stacking everything at (0,0).
      const CELL = 90;
      const cols = Math.max(m.defaultSize.w, Math.floor(window.innerWidth / CELL));
      const rows = Math.max(m.defaultSize.h, Math.floor((window.innerHeight - 56) / CELL));
      const existing = (useWorkspaceStore.getState().getActive().widgets ?? []).map((w) => {
        const wm = widgetManifests[w.type];
        return {
          col: w.gridCol,
          row: w.gridRow,
          w: w.gridW || wm?.defaultSize.w || 3,
          h: w.gridH || wm?.defaultSize.h || 2,
        };
      });
      const overlaps = (col: number, row: number) =>
        existing.some(
          (r) =>
            col < r.col + r.w && col + m.defaultSize.w > r.col &&
            row < r.row + r.h && row + m.defaultSize.h > r.row,
        );
      let gridCol = 0;
      let gridRow = 0;
      outer: for (let row = 0; row <= rows - m.defaultSize.h; row++) {
        for (let col = 0; col <= cols - m.defaultSize.w; col++) {
          if (!overlaps(col, row)) {
            gridCol = col;
            gridRow = row;
            break outer;
          }
        }
      }
      addWidget({
        type,
        gridCol,
        gridRow,
        gridW: m.defaultSize.w,
        gridH: m.defaultSize.h,
      });
    },
    [addWidget],
  );

  const handleNewFolder = useCallback(() => iconsRef.current?.startCreatingFolder(), []);
  const handleNewFile = useCallback((ext: string) => iconsRef.current?.startCreatingFile(ext), []);
  const handleRefresh = useCallback(() => iconsRef.current?.refresh(), []);
  const handleSort = useCallback((mode: "name" | "type" | "modified") => iconsRef.current?.sortBy(mode), []);
  const handlePersonalize = useCallback(() => {
    openWindow("settings", { title: t("desktop.menu.settings"), width: 680, height: 520 });
    // SettingsApp listens for this event to focus the personalization tab
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("claraos-settings-tab", { detail: { tab: "personalization" } }),
      );
    }, 50);
  }, [openWindow, t]);

  // F5 globally refreshes the desktop file tree
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F5" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        iconsRef.current?.refresh();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={styles.desktop}
          onClick={handleDesktopClick}
          onDragOver={handleDesktopDragOver}
          onDrop={handleDesktopDrop}
        >
          <div className={styles.wallpaper} data-shell-part="wallpaper" />
          {SkinScene && (
            <Suspense fallback={null}>
              <SkinScene />
            </Suspense>
          )}
          <DesktopIcons ref={iconsRef} />
          <DesktopWidgets />
          {SkinOverlay && (
            <Suspense fallback={null}>
              <SkinOverlay />
            </Suspense>
          )}
        </div>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.contextMenu}>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={styles.contextItem}>
              {t("desktop.menu.new")}
              <span style={{ marginLeft: "auto" }}>›</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className={styles.contextMenu}>
                <ContextMenu.Item className={styles.contextItem} onSelect={handleNewFolder}>
                  <FileTypeIcon isDir px={15} /> {t("desktop.menu.folder")}
                </ContextMenu.Item>
                <ContextMenu.Separator className={styles.contextSeparator} />
                {NEW_FILE_TEMPLATES.map((tpl) => (
                  <ContextMenu.Item
                    key={tpl.ext}
                    className={styles.contextItem}
                    onSelect={() => handleNewFile(tpl.ext)}
                  >
                    <FileTypeIcon name={`neu${tpl.ext}`} px={15} /> {templateLabel(tpl)} ({tpl.ext})
                  </ContextMenu.Item>
                ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={styles.contextItem}>
              {t("desktop.menu.sortBy")}
              <span style={{ marginLeft: "auto" }}>›</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className={styles.contextMenu}>
                <ContextMenu.Item className={styles.contextItem} onSelect={() => handleSort("name")}>
                  {t("desktop.menu.sortName")}
                </ContextMenu.Item>
                <ContextMenu.Item className={styles.contextItem} onSelect={() => handleSort("type")}>
                  {t("desktop.menu.sortType")}
                </ContextMenu.Item>
                <ContextMenu.Item className={styles.contextItem} onSelect={() => handleSort("modified")}>
                  {t("desktop.menu.sortModified")}
                </ContextMenu.Item>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item className={styles.contextItem} onSelect={handleRefresh}>
            {t("desktop.menu.refresh")}
            <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 11 }}>F5</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className={styles.contextSeparator} />
          <ContextMenu.Item className={styles.contextItem} onSelect={() => openWindow("settings", { title: t("desktop.menu.settings"), width: 680, height: 520 })}>
            {t("desktop.menu.settings")}
          </ContextMenu.Item>
          <ContextMenu.Item className={styles.contextItem} onSelect={handlePersonalize}>
            {t("desktop.menu.personalize")}
          </ContextMenu.Item>
          <ContextMenu.Separator className={styles.contextSeparator} />
          <ContextMenu.Item className={styles.contextItem} onSelect={handleToggleTheme}>
            {theme === "dark" ? t("desktop.menu.lightTheme") : t("desktop.menu.darkTheme")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextItem}
            onSelect={() => setWidgetGalleryOpen(true)}
          >
            {t("desktop.menu.widgets")}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>

      <WidgetGallery
        open={widgetGalleryOpen}
        onAdd={handleAddWidget}
        onClose={() => setWidgetGalleryOpen(false)}
      />
    </ContextMenu.Root>
  );
}
