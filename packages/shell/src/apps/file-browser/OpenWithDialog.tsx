/**
 * "Open with…" dialog: appears on double-click for file types without a
 * matching viewer (instead of a silent fallback to the files app).
 * "Always open with this app" writes an ext→app override into the
 * per-user prefs (store.setOpenWithOverride).
 */
import { useState } from "react";
import { useFileStore, useTranslation, type FileNode } from "@claraos/core";
import { FileTypeIcon } from "../../components/FileTypeIcon";
import { fileExt, type ViewerAppId } from "../../lib/fileTypeRouter";
import { OPEN_WITH_VIEWERS } from "./fileItemMenu";
import { downloadFile } from "../../lib/downloadFile";
import styles from "./FileBrowserApp.module.css";

export interface OpenWithDialogProps {
  node: FileNode;
  source: string;
  onPick: (viewerId: ViewerAppId) => void;
  onClose: () => void;
}

export function OpenWithDialog({ node, source, onPick, onClose }: OpenWithDialogProps) {
  const setOpenWithOverride = useFileStore((s) => s.setOpenWithOverride);
  const [always, setAlways] = useState(false);
  const { t } = useTranslation("files");
  const ext = fileExt(node.name);

  const pick = (viewerId: ViewerAppId) => {
    if (always && ext) setOpenWithOverride(ext, viewerId);
    onPick(viewerId);
    onClose();
  };

  return (
    <div className={styles.renameOverlay} onClick={onClose}>
      <div className={styles.openWithBox} onClick={(e) => e.stopPropagation()}>
        <div className={styles.openWithHeader}>
          <FileTypeIcon name={node.name} px={28} />
          <div>
            <div className={styles.openWithTitle}>{t("openWith.title", { name: node.name })}</div>
            <div className={styles.openWithSub}>{t("openWith.noDefault")}</div>
          </div>
        </div>
        <div className={styles.openWithList}>
          {/* For binary formats without a viewer (psd, apk, iso …) downloading
              is almost always what is meant, so it comes first */}
          <button
            className={styles.openWithItem}
            onClick={() => { void downloadFile(source, node.path, node.name); onClose(); }}
          >
            {t("actions.download")}
          </button>
          {OPEN_WITH_VIEWERS.map((v) => (
            <button key={v.id} className={styles.openWithItem} onClick={() => pick(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        {ext && (
          <label className={styles.openWithAlways}>
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            {t("openWith.always", { ext })}
          </label>
        )}
        <div className={styles.renameActions}>
          <button onClick={onClose}>{t("actions.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
