/**
 * FileThumb: real preview thumbnail in the icon views of the files app.
 *
 * Uses the existing Nextcloud preview proxy (GET /api/claraos/widgets/
 * photo, per-user auth, Cache-Control set); no new backend.
 * Only for the Nextcloud source and preview-capable categories (image/PDF/
 * video); everything else (and any error) falls back to FileTypeIcon.
 * Lazy via a shared IntersectionObserver: huge folders only load the
 * visible previews.
 */
import { useEffect, useRef, useState } from "react";
import { FileTypeIcon } from "../../components/FileTypeIcon";
import { getFileTypeInfo } from "../../lib/fileTypeMeta";
import styles from "./FileBrowserApp.module.css";

const PREVIEWABLE = new Set(["image", "pdf", "video"]);

/** 404 memo: prevents repeated requests for files without a preview. */
const failCache = new Set<string>();

// One observer for all thumbs; callbacks registered per element.
const visibilityCallbacks = new WeakMap<Element, () => void>();
let sharedObserver: IntersectionObserver | null = null;
function observeOnce(el: Element, cb: () => void) {
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visibilityCallbacks.get(entry.target)?.();
          visibilityCallbacks.delete(entry.target);
          sharedObserver!.unobserve(entry.target);
        }
      }
    }, { rootMargin: "200px" });
  }
  visibilityCallbacks.set(el, cb);
  sharedObserver.observe(el);
  return () => {
    visibilityCallbacks.delete(el);
    sharedObserver?.unobserve(el);
  };
}

export interface FileThumbProps {
  source: string;
  path: string;
  name: string;
  isDir: boolean;
  px: number;
}

export function FileThumb({ source, path, name, isDir, px }: FileThumbProps) {
  const holderRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  const category = isDir ? null : getFileTypeInfo(name).category;
  const eligible = !isDir && source === "nextcloud"
    && category !== null && PREVIEWABLE.has(category) && !failCache.has(path);

  useEffect(() => {
    if (!eligible || visible) return;
    const el = holderRef.current;
    if (!el) return;
    return observeOnce(el, () => setVisible(true));
  }, [eligible, visible]);

  if (!eligible || failed) {
    return <FileTypeIcon name={name} isDir={isDir} px={px} />;
  }

  // Preview resolution: display px × DPR × 2 (zoom headroom), API limits 64-2048
  const req = Math.min(2048, Math.max(64, Math.round(px * (window.devicePixelRatio || 1) * 2)));

  return (
    <span ref={holderRef} className={styles.thumbHolder} style={{ width: px, height: px }}>
      {visible ? (
        <img
          className={styles.thumb}
          src={`/api/claraos/widgets/photo?path=${encodeURIComponent(path)}&x=${req}&y=${req}`}
          alt={name}
          loading="lazy"
          onError={() => { failCache.add(path); setFailed(true); }}
        />
      ) : (
        <FileTypeIcon name={name} isDir={isDir} px={px} />
      )}
    </span>
  );
}
