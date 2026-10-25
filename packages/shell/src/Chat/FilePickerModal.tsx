/**
 * FilePickerModal — pick files from any ClaraOS-connected source
 * (local-upload is handled separately by `<input type="file">` in Composer).
 *
 * Uses `useFileStore` for source list + tree loading, fetches the chosen file
 * via `/api/claraos/files/v2/read` and resolves to native `File` objects so
 * the Composer can hand them straight to the existing file-upload pipeline.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useFileStore, type FileNode, type FileSourceInfo, useTranslation } from "@claraos/core";
import { XIcon } from "./icons";
import { FileTypeIcon } from "../components/FileTypeIcon";
import styles from "./FilePickerModal.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  onPick?: (files: File[]) => void;
  /** If set, only file REFS are returned (source/path/name) — without
   * loading contents. For links instead of uploads (e.g. planner task
   * attachments as cross-app links). onPick is ignored in that case. */
  onPickRefs?: (refs: PickedRef[]) => void;
  /** Optional MIME-prefix filter (e.g. "image/"). Empty = all. */
  mimePrefix?: string;
}

export interface PickedRef {
  source: string;
  path: string;
  name: string;
  size?: number;
}

const READ_API = "/api/claraos/files/v2";

// /read returns no content type. Without one an image is not sent as an image (vision)
// but uploaded as a document, where its bytes are read as text.
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  json: "application/json", html: "text/html",
};

async function fetchFile(source: string, path: string): Promise<File | null> {
  try {
    const url = `${READ_API}/read?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`;
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error(`read failed: ${resp.status}`);
    const data = await resp.json();
    const name = path.split("/").pop() || "file";
    let bytes: Uint8Array;
    if (data.encoding === "base64") {
      const bin = atob(data.content);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(data.content ?? "");
    }
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    return new File([bytes as BlobPart], name, { type: MIME_BY_EXT[ext] ?? "" });
  } catch (err) {
    console.error("FilePickerModal fetchFile failed", err);
    return null;
  }
}

export function FilePickerModal({ open, onClose, onPick, onPickRefs, mimePrefix }: Props) {
  const { t } = useTranslation("chat");
  const sources = useFileStore((s) => s.sources);
  const loadSources = useFileStore((s) => s.loadSources);
  const [activeSource, setActiveSource] = useState<string>("");
  const [path, setPath] = useState<string>("/");
  const [tree, setTree] = useState<FileNode | null>(null);
  const [selected, setSelected] = useState<PickedRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Load source list on first open
  useEffect(() => {
    if (open && sources.length === 0) loadSources().catch(() => undefined);
    if (open && !activeSource && sources.length) setActiveSource(sources[0].id);
  }, [open, sources, activeSource, loadSources]);

  // Load tree when source/path changes
  useEffect(() => {
    if (!open || !activeSource) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${READ_API}/tree?source=${encodeURIComponent(activeSource)}&path=${encodeURIComponent(path)}`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((data) => {
        if (!cancelled) setTree(data);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeSource, path]);

  const reset = useCallback(() => {
    setSelected([]);
    setPath("/");
    setTree(null);
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const confirm = useCallback(async () => {
    if (selected.length === 0) {
      close();
      return;
    }
    if (onPickRefs) {
      // References only — no content download
      onPickRefs(selected);
      close();
      return;
    }
    setBusy(true);
    try {
      const files = await Promise.all(
        selected.map((ref) => fetchFile(ref.source, ref.path)),
      );
      onPick?.(files.filter((f): f is File => f !== null));
    } finally {
      setBusy(false);
      close();
    }
  }, [selected, onPick, onPickRefs, close]);

  const sourceLabel = useMemo(() => {
    return (s: FileSourceInfo) => `${s.icon ?? ""} ${s.name}`.trim();
  }, []);

  if (!open) return null;

  const visibleChildren = (tree?.children ?? []).filter((node) => {
    if (node.isDir) return true;
    if (!mimePrefix) return true;
    // crude extension-based filter
    const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
    if (mimePrefix.startsWith("image/")) return ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);
    if (mimePrefix.startsWith("application/pdf")) return ext === "pdf";
    return true;
  });

  const isSelected = (node: FileNode) =>
    selected.some((s) => s.source === activeSource && s.path === node.path);

  const toggle = (node: FileNode) => {
    if (node.isDir) {
      setPath(node.path);
      return;
    }
    setSelected((prev) => {
      const idx = prev.findIndex((s) => s.source === activeSource && s.path === node.path);
      if (idx >= 0) return prev.filter((_, i) => i !== idx);
      return [...prev, { source: activeSource, path: node.path, name: node.name, size: node.size }];
    });
  };

  const goUp = () => {
    if (path === "/" || !path) return;
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    setPath(parts.length ? "/" + parts.join("/") : "/");
  };

  return (
    <div className={styles.overlay} onClick={close} role="dialog" aria-modal="true">
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} data-no-drag>
        <header className={styles.header}>
          <span className={styles.title}>{t("picker.title")}</span>
          <button type="button" className={styles.iconBtn} onClick={close} title={t("panel.close")}>
            <XIcon size={14} />
          </button>
        </header>

        <div className={styles.tabs}>
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`${styles.tab} ${activeSource === s.id ? styles.tabActive : ""} ${!s.connected ? styles.tabDisabled : ""}`}
              onClick={() => {
                setActiveSource(s.id);
                setPath("/");
              }}
              disabled={!s.connected}
            >
              {sourceLabel(s)}
            </button>
          ))}
          {sources.length === 0 && (
            <span className={styles.empty}>{t("picker.loadingSources")}</span>
          )}
        </div>

        <div className={styles.path}>
          <button type="button" className={styles.upBtn} onClick={goUp} disabled={path === "/"}>
            ↑
          </button>
          <code>{path}</code>
        </div>

        <div className={styles.tree}>
          {loading && <div className={styles.empty}>{t("picker.loading")}</div>}
          {!loading && visibleChildren.length === 0 && (
            <div className={styles.empty}>{t("picker.empty")}</div>
          )}
          {visibleChildren.map((node) => (
            <button
              key={node.path}
              type="button"
              className={`${styles.row} ${isSelected(node) ? styles.rowSelected : ""}`}
              onClick={() => toggle(node)}
              onDoubleClick={() => node.isDir && setPath(node.path)}
            >
              {!node.isDir && (
                <input
                  type="checkbox"
                  checked={isSelected(node)}
                  readOnly
                  className={styles.checkbox}
                />
              )}
              <span className={styles.rowIcon}>
                <FileTypeIcon name={node.name} isDir={node.isDir} px={18} />
              </span>
              <span className={styles.rowName}>{node.name}</span>
              {node.size != null && (
                <span className={styles.rowSize}>{formatSize(node.size)}</span>
              )}
            </button>
          ))}
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.btnSecondary} onClick={close}>
            {t("camera.cancel")}
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={confirm}
            disabled={busy || selected.length === 0}
          >
            {busy ? t("picker.busy") : selected.length ? t("picker.confirmCount", { count: selected.length }) : t("picker.confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
