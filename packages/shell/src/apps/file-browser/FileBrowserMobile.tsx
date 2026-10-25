/**
 * FileBrowserMobile: phone presentation of the files app.
 *
 * Same data/logic as desktop (useFileBrowserCore, useFileOps,
 * useArchiveOps, buildFileItemMenu); only the presentation is mobile.
 *
 * Follows the ClaraOS phone design language like planner, knowledge and
 * teams: large title + search pill, shared floating `Werkzeugleiste` (toolbar)
 * with FAB, `Leerzustand` (empty state) with an action, icons instead of
 * emoji. "Paste here" is visible when something is on the clipboard rather
 * than hidden behind "…".
 * No lasso, no drag&drop, no F2, no Radix context menu.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { regionLocale, useFileStore, useTranslation, type FileNode } from "@claraos/core";
import { ActionSheet } from "../../components/ActionSheet";
import { Button } from "../../components/Button";
import { Icon, iconFuerEmoji, type IconName } from "../../components/Icon";
import { BottomSheet } from "../../components/BottomSheet";
import { Werkzeugleiste } from "../../components/Werkzeugleiste";
import { Leerzustand } from "../../components/Leerzustand";
import type { ContextMenuItem } from "../../components/WindowContextMenu";
import { useDialogs } from "../../Chat/Dialogs";
import { useLongPress } from "../../Mobile/useLongPress";
import { resolveFileApp, fileExt, sniffIsText } from "../../lib/fileTypeRouter";
import { downloadFile, downloadMany } from "../../lib/downloadFile";
import { NEW_FILE_TEMPLATES, templateLabel } from "../../lib/newFileTemplates";
import { folderTypeName } from "../../lib/fileTypeMeta";
import { useFileBrowserCore } from "./useFileBrowserCore";
import { useArchiveOps } from "./useArchiveOps";
import { useFileOps } from "./useFileOps";
import { buildFileItemMenu } from "./fileItemMenu";
import { PrintDialog } from "./PrintDialog";
import { OpenWithDialog } from "./OpenWithDialog";
import { FileThumb } from "./FileThumb";
import { prepareItems } from "./listTransform";
import styles from "./FileBrowserMobile.module.css";

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

const sym = (name: IconName) => <Icon name={name} size={20} />;

/** Sections of the toolbar. */
type Bereich = "dateien" | "favoriten" | "papierkorb";

export default function FileBrowserMobile({ windowId }: { windowId: string }) {
  const {
    sources, activeSource, currentPath, tree, loading, error,
    selectedFiles, clipboard,
    sortKey, sortDir, dirsFirst, showHidden, groupBy, filterQuery,
    openWithOverrides,
    loadSources, loadTree,
    setSort, toggleHidden, setFilterQuery,
    searchResults, searchLoading, searchRecursive, clearSearch,
    trashItems, trashLoading, loadTrash, closeTrash, restoreTrashItem, purgeTrashItem, emptyTrash,
    selectFile, setSelection, clearSelection, setClipboard, clearClipboard, createFolder,
    renameFile,
    handleNavigate, handleOpen, openWith,
    createFromTemplate: createFromTemplateCore,
  } = useFileBrowserCore(windowId);
  const { t } = useTranslation("files");
  const favorites = useFileStore((s) => s.favorites);
  const loadFavorites = useFileStore((s) => s.loadFavorites);
  const setFavorite = useFileStore((s) => s.setFavorite);

  const { dialogHost, confirmDlg, promptDlg, alertDlg, chooseDlg } = useDialogs();
  const ops = useFileOps({ alertDlg, chooseDlg });
  const { archiveItem, encryptItem, extractItem } = useArchiveOps({
    activeSource, currentPath, promptDlg, alertDlg,
  });

  const [bereich, setBereich] = useState<Bereich>("dateien");
  const [selectionMode, setSelectionMode] = useState(false);
  const [sourceSheetOpen, setSourceSheetOpen] = useState(false);
  const [actionSheet, setActionSheet] = useState<{ title?: string; items: ContextMenuItem[] } | null>(null);
  const [openWithNode, setOpenWithNode] = useState<FileNode | null>(null);
  // Print: menu entry only when the household has a printer; same dialog
  // as on desktop, it is narrow enough for phones.
  const [printNode, setPrintNode] = useState<FileNode | null>(null);
  const [hasPrinter, setHasPrinter] = useState(false);
  useEffect(() => {
    let alive = true;
    void fetch("/api/claraos/printing/printers", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { printers: [] }))
      .then((d) => { if (alive) setHasPrinter((d.printers ?? []).length > 0); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const [gridView, setGridView] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const groups = prepareItems(tree?.children, {
    sortKey, sortDir, dirsFirst, showHidden, groupBy, filterQuery,
  });
  const items = groups.flatMap((g) => g.items);
  const allPaths = items.map((it) => it.path);
  const sourceInfo = sources.find((s) => s.id === activeSource);
  const isNc = activeSource === "nextcloud";
  const breadcrumbs = currentPath.split("/").filter(Boolean);
  const ordnerName = breadcrumbs.length > 0
    ? decodeURIComponent(breadcrumbs[breadcrumbs.length - 1])
    : (sourceInfo?.name ?? t("app.title"));
  const favSet = new Set((favorites ?? []).map((f) => f.path));

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    clearSelection();
  }, [clearSelection]);

  const wechsleBereich = useCallback((b: Bereich) => {
    exitSelection();
    // Favorites and trash only exist in Nextcloud; actions in them must not
    // land on an SFTP device that happens to be open
    if (b !== "dateien" && activeSource !== "nextcloud") handleNavigate("nextcloud", "/");
    setBereich(b);
    if (b === "papierkorb") void loadTrash();
    else closeTrash();
    if (b === "favoriten") void loadFavorites();
  }, [exitSelection, loadTrash, closeTrash, loadFavorites, activeSource, handleNavigate]);

  // Open with zip/unknown handling (counterpart of desktop openNode)
  const openNode = useCallback((node: FileNode) => {
    if (node.isDir) { handleOpen(node); return; }
    const src = node.source || activeSource;
    if (fileExt(node.name) === "zip" && src === "nextcloud") {
      void confirmDlg(t("confirm.extractHere", { name: node.name }), t("actions.extract")).then((ok) => {
        if (ok) void extractItem(node);
      });
      return;
    }
    const appId = resolveFileApp(node.name, openWithOverrides);
    if (appId) { openWith(node, appId); return; }
    if (!fileExt(node.name)) {
      void sniffIsText(src, node.path).then((txt) => (txt ? openWith(node, "text-editor") : setOpenWithNode(node)));
      return;
    }
    setOpenWithNode(node);
  }, [handleOpen, activeSource, confirmDlg, extractItem, openWithOverrides, openWith, t]);

  const showItemSheet = useCallback((node: FileNode) => {
    setActionSheet({
      title: node.name,
      items: buildFileItemMenu(node, {
        variant: "mobile",
        symbol: (name) => <Icon name={name} size={16} />,
        defaultApp: node.isDir ? null : resolveFileApp(node.name, openWithOverrides),
        trashEnabled: isNc,
        onOpen: openNode,
        onOpenWith: (n, viewerId) => openWith(n, viewerId),
        onDownload: (n) => { void downloadFile(activeSource, n.path, n.name); },
        onPrint: hasPrinter ? (n) => { setActionSheet(null); setPrintNode(n); } : undefined,
        onArchive: (n) => { void archiveItem(n); },
        onExtract: (n) => { void extractItem(n); },
        onEncrypt: (n) => { void encryptItem(n); },
        onCopy: (n) => setClipboard("copy", activeSource, [n.path]),
        onCut: (n) => setClipboard("cut", activeSource, [n.path]),
        onPaste: clipboard && node.isDir ? (n) => { void ops.paste(activeSource, n.path); } : undefined,
        onToggleFavorite: isNc ? (n) => { void setFavorite(n.path, !favSet.has(n.path)); } : undefined,
        isFavorite: favSet.has(node.path),
        onRename: (n) => {
          void promptDlg(t("rename.prompt", { name: n.name }), n.name).then((v) => {
            if (v && v.trim() && v.trim() !== n.name) void renameFile(activeSource, n.path, v.trim());
          });
        },
        onDelete: async (n) => {
          const msg = isNc
            ? t("confirm.trashOne", { name: n.name })
            : t("confirm.deleteOneNoTrash", { name: n.name });
          if (await confirmDlg(msg, isNc ? t("actions.move") : t("actions.delete"))) {
            await ops.remove(activeSource, [n.path]);
          }
        },
        onProperties: (n) => {
          void alertDlg(t("details.text", {
            name: n.name,
            path: n.path,
            size: formatSize(n.size) || "—",
            modified: n.modified ? new Date(n.modified).toLocaleString(regionLocale()) : "—",
          }));
        },
      }),
    });
  }, [openWithOverrides, isNc, openNode, openWith, activeSource, archiveItem, extractItem,
      encryptItem, setClipboard, promptDlg, renameFile, confirmDlg, ops, alertDlg,
      hasPrinter, clipboard, setFavorite, favSet, t]);

  const deleteSelected = useCallback(async () => {
    const msg = isNc
      ? t("confirm.trashMany", { count: selectedFiles.length })
      : t("confirm.deleteManyNoTrash", { count: selectedFiles.length });
    if (!(await confirmDlg(msg, isNc ? t("actions.move") : t("actions.delete")))) return;
    await ops.remove(activeSource, selectedFiles);
    exitSelection();
  }, [isNc, selectedFiles, confirmDlg, ops, activeSource, exitSelection, t]);

  const goUp = useCallback(() => {
    const parent = "/" + breadcrumbs.slice(0, -1).join("/");
    if (breadcrumbs.length > 0) handleNavigate(activeSource, parent === "//" ? "/" : parent);
  }, [breadcrumbs, handleNavigate, activeSource]);

  const mehrItems: ContextMenuItem[] = [
    { id: "sources", label: t("sidebar.switchSource"), icon: sym("devices"), onSelect: () => setSourceSheetOpen(true) },
    { id: "refresh", label: t("actions.refresh"), icon: sym("reload"), onSelect: () => loadTree(activeSource, currentPath || "/") },
    { id: "view", label: gridView ? t("view.asList") : t("view.asGrid"), icon: sym(gridView ? "list" : "image"), onSelect: () => setGridView(!gridView) },
    { id: "hidden", label: t("view.hiddenFiles"), checked: showHidden, onSelect: () => toggleHidden() },
    {
      id: "sort", label: t("sort.by"), icon: sym("arrowUp"),
      submenu: [
        { id: "s-name", label: t("sort.name"), checked: sortKey === "name", onSelect: () => setSort("name") },
        { id: "s-mod", label: t("sort.modified"), checked: sortKey === "modified", onSelect: () => setSort("modified") },
        { id: "s-size", label: t("sort.size"), checked: sortKey === "size", onSelect: () => setSort("size") },
        { id: "s-type", label: t("sort.type"), checked: sortKey === "type", onSelect: () => setSort("type") },
        { id: "sep", label: "---" },
        { id: "s-asc", label: t("sort.asc"), checked: sortDir === "asc", onSelect: () => setSort(sortKey, "asc") },
        { id: "s-desc", label: t("sort.desc"), checked: sortDir === "desc", onSelect: () => setSort(sortKey, "desc") },
      ],
    },
  ];

  const neuItems: ContextMenuItem[] = [
    {
      id: "new-folder", label: t("new.folder"), icon: sym("folder"),
      onSelect: () => {
        void promptDlg(t("new.folderPrompt")).then((name) => {
          if (name?.trim()) void createFolder(activeSource, currentPath.replace(/\/$/, "") + "/" + name.trim());
        });
      },
    },
    { id: "upload", label: t("actions.uploadFiles"), icon: sym("export"), onSelect: () => fileInputRef.current?.click() },
    {
      id: "new-file", label: t("new.file"), icon: sym("document"),
      submenu: NEW_FILE_TEMPLATES.map((tpl) => ({
        id: `tpl-${tpl.ext}`,
        label: `${templateLabel(tpl)} (${tpl.ext})`,
        onSelect: () => {
          void createFromTemplateCore(tpl.ext).then((created) => {
            if (created) {
              void promptDlg(t("new.fileNamePrompt"), created.name).then((v) => {
                if (v && v.trim() && v.trim() !== created.name) void renameFile(activeSource, created.path, v.trim());
              });
            }
          });
        },
      })),
    },
  ];

  // ── Header ──────────────────────────────────────────────────────────
  const kopfTitel = bereich === "favoriten" ? t("sections.favorites") : bereich === "papierkorb" ? t("sections.trash") : ordnerName;
  const kopfSymbol: IconName = bereich === "favoriten" ? "star" : bereich === "papierkorb" ? "trash"
    : breadcrumbs.length ? "folder" : "cloud";
  const kopfSub = bereich === "favoriten"
    ? t("mobile.starred", { count: favorites?.length ?? 0 })
    : bereich === "papierkorb"
      ? t("trash.restorable", { count: trashItems?.length ?? 0 })
      : `${sourceInfo?.name ?? activeSource}${!loading && !error ? ` · ${t("count.items", { count: items.length })}` : ""}`;

  const suchtRekursiv = searchLoading || searchResults !== null;

  return (
    <div className={styles.root}>
      {selectionMode ? (
        <header className={styles.auswahlKopf}>
          <button className={styles.kopfKnopf} aria-label={t("mobile.endSelection")} onClick={exitSelection}>
            <Icon name="close" size={22} />
          </button>
          <span className={styles.auswahlTitel}>{t("count.selected", { count: selectedFiles.length })}</span>
          <button className={styles.textKnopf} onClick={() => setSelection(allPaths)}>{t("mobile.all")}</button>
        </header>
      ) : (
        <header className={styles.kopf}>
          <div className={styles.titelZeile}>
            {bereich === "dateien" && breadcrumbs.length > 0 && (
              <button className={styles.kopfKnopf} aria-label={t("mobile.parentFolder")} onClick={goUp}>
                <Icon name="back" size={22} />
              </button>
            )}
            <h2 className={styles.titel}>
              <Icon name={kopfSymbol} size={22} />
              <span className={styles.titelText}>{kopfTitel}</span>
            </h2>
          </div>
          <span className={styles.untertitel}>{kopfSub}</span>
          {bereich === "dateien" && (
            <div className={styles.suchPille}>
              <Icon name="search" size={18} />
              <input
                type="search"
                enterKeyHint="search"
                value={filterQuery}
                placeholder={t("search.in", { name: ordnerName })}
                aria-label={t("search.label")}
                onChange={(e) => { setFilterQuery(e.target.value); if (!e.target.value) clearSearch(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filterQuery.trim()) { e.preventDefault(); void searchRecursive(filterQuery); }
                }}
              />
              {filterQuery && (
                <button className={styles.suchLeeren} aria-label={t("search.clear")}
                        onClick={() => { setFilterQuery(""); clearSearch(); }}>
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
          )}
        </header>
      )}

      {/* Path chips (horizontally scrollable), only in the folder view */}
      {bereich === "dateien" && !suchtRekursiv && breadcrumbs.length > 0 && (
        <div className={styles.chips}>
          <button className={styles.chip} onClick={() => handleNavigate(activeSource, sourceInfo?.default_path ?? "/")}>
            {sourceInfo?.name ?? activeSource}
          </button>
          {breadcrumbs.map((seg, i) => (
            <button
              key={i}
              className={styles.chip}
              onClick={() => handleNavigate(activeSource, "/" + breadcrumbs.slice(0, i + 1).join("/"))}
            >
              {decodeURIComponent(seg)}
            </button>
          ))}
        </div>
      )}

      {bereich === "dateien" && tree?.note && <div className={styles.noteBanner}>{tree.note}</div>}

      {/* Content */}
      <div className={styles.listArea}>
        {bereich === "favoriten" ? (
          favorites === null ? (
            <div className={styles.emptyState}>{t("status.loadingMobile")}</div>
          ) : favorites.length === 0 ? (
            <Leerzustand symbol={<Icon name="star" size={32} />} titel={t("empty.noFavorites")}
                         hinweis={t("empty.noFavoritesHint")} />
          ) : (
            <div className={styles.list}>
              {favorites.map((f) => (
                <MobileFileRow
                  key={f.path} node={f} source="nextcloud" grid={false} selected={false} selectionMode={false}
                  meta={f.path.replace(/\/[^/]*$/, "") || "/"}
                  onTap={() => {
                    if (f.isDir) { setBereich("dateien"); handleNavigate("nextcloud", f.path); }
                    else openNode({ ...f, source: "nextcloud" } as FileNode);
                  }}
                  onLongPress={() => {}}
                  onMore={() => showItemSheet(f)}
                />
              ))}
            </div>
          )
        ) : bereich === "papierkorb" ? (
          trashLoading ? (
            <div className={styles.emptyState}>{t("status.loadingMobile")}</div>
          ) : (trashItems ?? []).length === 0 ? (
            <Leerzustand symbol={<Icon name="trash" size={32} />} titel={t("empty.trash")}
                         hinweis={t("empty.trashHint")} />
          ) : (
            <>
              <div className={styles.korbLeiste}>
                <Button stufe="text" groesse="s" icon="trash" onClick={() => {
                  void confirmDlg(t("confirm.emptyTrash", { count: (trashItems ?? []).length }), t("actions.emptyConfirm"))
                    .then((ok) => { if (ok) void emptyTrash(); });
                }}>{t("actions.emptyTrash")}</Button>
              </div>
              <div className={styles.list}>
                {(trashItems ?? []).map((it) => (
                  <MobileFileRow
                    key={it.trashPath}
                    node={{ name: it.name, path: it.trashPath, isDir: it.isDir, size: it.size } as FileNode}
                    source="trash" grid={false} selected={false} selectionMode={false}
                    meta={t("trash.from", { folder: "/" + (it.originalPath || "").split("/").slice(0, -1).join("/").replace(/^\//, "") })
                      + (it.deletedAt ? ` · ${new Date(it.deletedAt * 1000).toLocaleDateString(regionLocale())}` : "")}
                    onTap={() => setActionSheet({
                      title: it.name,
                      items: [
                        { id: "restore", label: t("actions.restore"), icon: sym("restore"), onSelect: () => { void restoreTrashItem(it.trashPath); } },
                        {
                          id: "purge", label: t("actions.deletePermanently"), icon: sym("trash"), variant: "destructive",
                          onSelect: () => {
                            void confirmDlg(t("confirm.purge", { name: it.name }), t("actions.deletePermanently"))
                              .then((ok) => { if (ok) void purgeTrashItem(it.trashPath); });
                          },
                        },
                      ],
                    })}
                    onLongPress={() => {}}
                    onMore={() => {}}
                    hideMore
                  />
                ))}
              </div>
            </>
          )
        ) : suchtRekursiv ? (
          searchLoading ? (
            <div className={styles.emptyState}>{t("search.searchingMobile")}</div>
          ) : (searchResults ?? []).length === 0 ? (
            <Leerzustand symbol={<Icon name="search" size={32} />} titel={t("empty.noHits")}
                         aktionen={[{ label: t("search.clear"), onClick: () => { setFilterQuery(""); clearSearch(); } }]} />
          ) : (
            <div className={styles.list}>
              {(searchResults ?? []).map((n) => (
                <MobileFileRow
                  key={`${n.source}:${n.path}`} node={n} source={activeSource} grid={false}
                  selected={false} selectionMode={false}
                  meta={n.path.replace(/\/[^/]*$/, "") || "/"}
                  onTap={() => { if (n.isDir) { setFilterQuery(""); clearSearch(); } openNode(n); }}
                  onLongPress={() => {}}
                  onMore={() => showItemSheet(n)}
                />
              ))}
            </div>
          )
        ) : loading ? (
          <div className={styles.emptyState}>{t("status.loadingMobile")}</div>
        ) : error ? (
          <div className={styles.errorPanel}>
            <div className={styles.errorIcon}><Icon name={error.code === "device_offline" ? "devices" : "warning"} size={40} /></div>
            <div className={styles.errorTitle}>
              {error.code === "device_offline"
                ? error.status === "sshd_down"
                  ? t("errors.sshdDownShort", { device: error.device ?? ordnerName })
                  : t("errors.offlineShort", { device: error.device ?? ordnerName })
                : t("errors.loadFolder")}
            </div>
            <Button stufe="tonal" icon="reload"
                    onClick={() => { void loadSources(true).then(() => loadTree(activeSource, currentPath || "/")); }}>
              {t("actions.retry")}
            </Button>
          </div>
        ) : items.length === 0 ? (
          filterQuery ? (
            <Leerzustand symbol={<Icon name="search" size={32} />} titel={t("empty.nothingFound")}
                         hinweis={t("empty.nothingFoundHint")}
                         aktionen={[{ label: t("empty.searchSubfolders"), onClick: () => { void searchRecursive(filterQuery); } }]} />
          ) : (
            <Leerzustand
              symbol={<Icon name="folder" size={32} />}
              titel={t("empty.folder")}
              aktionen={[
                { label: t("actions.uploadFiles"), onClick: () => fileInputRef.current?.click() },
                ...(clipboard ? [{ label: t("actions.pasteHere"), onClick: () => { void ops.paste(activeSource, currentPath || "/"); } }] : []),
              ]}
            />
          )
        ) : (
          <div className={gridView ? styles.grid : styles.list}>
            {items.map((node) => (
              <MobileFileRow
                key={node.path}
                node={node}
                source={activeSource}
                grid={gridView}
                selected={selectedFiles.includes(node.path)}
                cut={clipboard?.action === "cut" && clipboard.source === activeSource && clipboard.paths.includes(node.path)}
                selectionMode={selectionMode}
                onTap={() => {
                  if (selectionMode) selectFile(node.path, "toggle");
                  else openNode(node);
                }}
                onLongPress={() => {
                  if (!selectionMode) {
                    setSelectionMode(true);
                    selectFile(node.path, "single", allPaths);
                  }
                }}
                onMore={() => showItemSheet(node)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Clipboard bar: you SEE that something is ready to paste */}
      {clipboard && !selectionMode && bereich === "dateien" && (
        <div className={styles.ablage} role="status">
          <Icon name={clipboard.action === "cut" ? "scissors" : "copy"} size={18} />
          <span className={styles.ablageText}>
            {t(clipboard.action === "cut" ? "clipboard.cut" : "clipboard.copied", { count: clipboard.paths.length })}
          </span>
          <button className={styles.ablageKnopf} onClick={() => { void ops.paste(activeSource, currentPath || "/"); }}>
            {t("actions.pasteHere")}
          </button>
          <button className={styles.kopfKnopf} aria-label={t("clipboard.clear")} onClick={clearClipboard}>
            <Icon name="close" size={18} />
          </button>
        </div>
      )}

      {ops.upload && (
        <div className={styles.uploadToast} role="status">
          <span className={styles.uploadName}>
            {ops.upload.count > 1
              ? t("upload.mobileCount", { index: ops.upload.index + 1, total: ops.upload.count, name: ops.upload.name })
              : t("upload.mobile", { name: ops.upload.name })}
          </span>
          <span className={styles.uploadBar}><span style={{ width: `${Math.round(ops.upload.fraction * 100)}%` }} /></span>
        </div>
      )}

      {/* Bottom: selection actions or sections + FAB, both via the shared toolbar */}
      {selectionMode ? (
        <Werkzeugleiste
          eintraege={[
            { key: "copy", label: t("actions.copy"), icon: "copy",
              onClick: () => { setClipboard("copy", activeSource, selectedFiles); exitSelection(); } },
            { key: "cut", label: t("actions.cut"), icon: "scissors",
              onClick: () => { setClipboard("cut", activeSource, selectedFiles); exitSelection(); } },
            { key: "download", label: t("actions.download"), icon: "import",
              onClick: () => { downloadMany(activeSource, selectedFiles); exitSelection(); } },
            { key: "delete", label: t("actions.delete"), icon: "trash", onClick: () => { void deleteSelected(); } },
          ]}
        />
      ) : (
        <Werkzeugleiste
          eintraege={[
            { key: "dateien", label: t("sections.files"), icon: "folder", active: bereich === "dateien",
              onClick: () => (bereich === "dateien" ? handleNavigate(activeSource, sourceInfo?.default_path ?? "/") : wechsleBereich("dateien")) },
            ...(isNc || bereich !== "dateien" ? [
              { key: "favoriten", label: t("sections.favorites"), icon: "star" as IconName, active: bereich === "favoriten",
                onClick: () => wechsleBereich("favoriten") },
              { key: "papierkorb", label: t("sections.trash"), icon: "trash" as IconName, active: bereich === "papierkorb",
                onClick: () => wechsleBereich("papierkorb") },
            ] : []),
            { key: "quellen", label: t("sections.sources"), icon: "devices", onClick: () => setSourceSheetOpen(true) },
            { key: "mehr", label: t("sections.more"), icon: "more", onClick: () => setActionSheet({ title: t("view.title"), items: mehrItems }) },
          ]}
          fab={bereich === "dateien" ? { label: t("new.fab"), onClick: () => setActionSheet({ title: t("new.title"), items: neuItems }) } : undefined}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          // Streamed, without a 10 MB limit, with progress and conflict prompt
          if (files.length) void ops.uploadFiles(files, activeSource, currentPath || "/");
        }}
      />

      {/* Sources sheet */}
      <BottomSheet open={sourceSheetOpen} onClose={() => setSourceSheetOpen(false)} title={t("sections.sources")}>
        {sources.map((src) => (
          <button
            key={src.id}
            className={styles.sourceRow}
            onClick={() => {
              setSourceSheetOpen(false);
              wechsleBereich("dateien");
              handleNavigate(src.id, src.default_path ?? "/");
            }}
          >
            <span className={styles.sourceIcon}>
              <Icon name={iconFuerEmoji(src.icon) ?? (src.type === "nextcloud" ? "cloud" : "devices")} size={20} />
            </span>
            <span className={styles.sourceName}>{src.name}</span>
            <span
              className={`${styles.sourceDot} ${src.connected ? styles.dotOnline : styles.dotOffline}`}
              title={src.connected ? t("source.online")
                : src.status === "kein_zugang" ? t("source.noAccess")
                : src.status === "sshd_down" ? t("source.sshOff") : t("source.offline")}
            />
          </button>
        ))}
      </BottomSheet>

      <ActionSheet
        open={actionSheet !== null}
        onClose={() => setActionSheet(null)}
        title={actionSheet?.title}
        items={actionSheet?.items ?? []}
      />

      {openWithNode && (
        <OpenWithDialog
          node={openWithNode}
          source={openWithNode.source || activeSource}
          onPick={(viewerId) => openWith(openWithNode, viewerId)}
          onClose={() => setOpenWithNode(null)}
        />
      )}

      {printNode && (
        <PrintDialog
          path={printNode.path}
          name={printNode.name}
          source={printNode.source || activeSource}
          onClose={() => setPrintNode(null)}
        />
      )}

      {dialogHost}
    </div>
  );
}

// ─── Row/tile with tap/long-press ─────────────────────

function MobileFileRow({ node, source, grid, selected, selectionMode, cut, meta, hideMore, onTap, onLongPress, onMore }: {
  node: FileNode; source: string; grid: boolean; selected: boolean; selectionMode: boolean;
  /** Cut (dimmed). */
  cut?: boolean;
  /** Replaces "size · date" (search/favorites: the folder; trash: origin). */
  meta?: string;
  hideMore?: boolean;
  onTap: () => void; onLongPress: () => void; onMore: () => void;
}) {
  const press = useLongPress({ onTap, onLongPress });
  const { t } = useTranslation("files");
  const thumbSource = source === "trash" ? "" : (node.source ?? source);
  // A selection made from outside (Clara's navigate_files) must be on screen:
  // in the phone split view the list is short and the marked file sat below
  // the fold. Not in selection mode — there the user taps the row themselves.
  const zeile = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && !selectionMode) zeile.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected, selectionMode]);

  if (grid) {
    return (
      <div className={`${styles.card} ${selected ? styles.rowSelected : ""} ${cut ? styles.rowCut : ""}`} ref={zeile} {...press}>
        <FileThumb source={thumbSource} path={node.path} name={node.name} isDir={node.isDir} px={48} />
        <span className={styles.cardName}>{node.name}</span>
        {selectionMode && <span className={`${styles.rowCheck} ${styles.cardCheck}`} data-an={selected ? "ja" : undefined}>{selected && <Icon name="check" size={16} />}</span>}
      </div>
    );
  }

  return (
    <div className={`${styles.row} ${selected ? styles.rowSelected : ""} ${cut ? styles.rowCut : ""}`} ref={zeile} {...press}>
      <FileThumb source={thumbSource} path={node.path} name={node.name} isDir={node.isDir} px={40} />
      <span className={styles.rowText}>
        <span className={styles.rowName}>{node.name}</span>
        <span className={styles.rowMeta}>
          {meta ?? (
            <>
              {node.isDir ? folderTypeName() : formatSize(node.size)}
              {node.modified ? ` · ${new Date(node.modified).toLocaleDateString(regionLocale())}` : ""}
            </>
          )}
        </span>
      </span>
      {selectionMode ? (
        <span className={styles.rowCheck} data-an={selected ? "ja" : undefined}>{selected && <Icon name="check" size={16} />}</span>
      ) : !hideMore && (
        <button
          className={styles.mehrKnopf}
          aria-label={t("actions.more")}
          onClick={(e) => { e.stopPropagation(); onMore(); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Icon name="more" size={20} />
        </button>
      )}
    </div>
  );
}
