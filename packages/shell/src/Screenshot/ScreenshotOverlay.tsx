import { useCallback, useEffect, useRef, useState } from "react";
import { i18n, useUIStore, useClipboardStore, useWindowsStore, useTranslation } from "@claraos/core";
import { captureToDataUrl, downloadBlob } from "../lib/screenshots";
import styles from "./ScreenshotOverlay.module.css";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Win+Shift+S overlay. Listens for the global `claraos-screenshot` event,
 * shows a fullscreen crosshair, lets the user drag a rectangle, then
 * captures only that rectangle (not the entire viewport) by html-to-image-ing
 * a wrapper div sized to that rect.
 *
 * Result modal offers three actions: copy data-URL string to clipboard
 * (best browsers can paste it back as image), download as PNG, or open in
 * the image-viewer app via a blob:// URL.
 */
export function ScreenshotOverlay() {
  const { t } = useTranslation("shell");
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);

  // Open on global event
  useEffect(() => {
    const handler = () => {
      setOpen(true);
      setRect(null);
      setStart(null);
      setCaptured(null);
    };
    window.addEventListener("claraos-screenshot", handler);
    return () => window.removeEventListener("claraos-screenshot", handler);
  }, []);

  // Esc cancels
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        setCaptured(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (captured) return;
    setStart({ x: e.clientX, y: e.clientY });
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  }, [captured]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!start || captured) return;
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    const w = Math.abs(e.clientX - start.x);
    const h = Math.abs(e.clientY - start.y);
    setRect({ x, y, w, h });
  }, [start, captured]);

  const onMouseUp = useCallback(async () => {
    if (!rect || rect.w < 8 || rect.h < 8) {
      setStart(null);
      setRect(null);
      return;
    }
    setStart(null);

    // Hide our own overlay during capture so it isn't part of the screenshot.
    // display:none (not visibility:hidden) — html-to-image otherwise paints
    // it as transparent pixels because the element still occupies space.
    const prevDisplay = overlayRef.current?.style.display ?? "";
    if (overlayRef.current) overlayRef.current.style.display = "none";

    // Yield one frame so the layout actually updates before capture starts
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    // html-to-image captures the body. We then crop to the selected rect via canvas.
    const fullDataUrl = await captureToDataUrl(document.body, { maxSize: 4096 });

    if (overlayRef.current) overlayRef.current.style.display = prevDisplay;

    if (!fullDataUrl) {
      setCaptured("error");
      return;
    }

    // Crop to the selected rect on a canvas
    const cropped = await cropDataUrl(fullDataUrl, rect, document.body.scrollWidth, document.body.scrollHeight);
    setCaptured(cropped);
  }, [rect]);

  const handleCopyText = useCallback(async () => {
    if (!captured || captured === "error") return;
    try {
      await navigator.clipboard.writeText(captured);
      useClipboardStore.getState().add(captured, "screenshot");
      useUIStore.getState().addNotification({
        title: i18n.t("shell:screenshot.copiedTitle"),
        body: i18n.t("shell:screenshot.copied"),
        icon: "📷",
      });
    } catch {
      // The clipboard refuses depending on context (no user gesture, no
      // secure origin). Previously the window simply closed — the screenshot
      // appeared to be copied but was not.
      useUIStore.getState().addNotification({
        title: i18n.t("shell:screenshot.copyFailedTitle"),
        body: i18n.t("shell:screenshot.copyFailed"),
        icon: "⚠️",
      });
    }
    closeAll();
  }, [captured]);

  const handleDownload = useCallback(async () => {
    if (!captured || captured === "error") return;
    const res = await fetch(captured);
    const blob = await res.blob();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBlob(blob, `screenshot-${ts}.png`);
    closeAll();
  }, [captured]);

  const handleOpenInViewer = useCallback(() => {
    if (!captured || captured === "error") return;
    useWindowsStore.getState().openWindow("image-viewer", {
      title: i18n.t("shell:screenshot.viewerTitle"),
      width: 800,
      height: 600,
    });
    // Pass the data URL via a transient global; image-viewer apps that opt
    // in can pick it up. For now, also copy to clipboard as a side-effect
    // so the user can paste it themselves.
    (window as unknown as { __claraosLastScreenshot?: string }).__claraosLastScreenshot = captured;
    closeAll();
  }, [captured]);

  const closeAll = () => {
    setOpen(false);
    setCaptured(null);
    setRect(null);
    setStart(null);
  };

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className={styles.overlay}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      role="dialog"
      aria-label={t("screenshot.toolLabel")}
    >
      {!captured && (
        <>
          <div className={styles.dim} />
          {rect && (
            <div
              className={styles.selection}
              style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            />
          )}
          {!rect && (
            <div className={styles.hint}>
              {t("screenshot.hint")}
            </div>
          )}
        </>
      )}
      {captured === "error" && (
        <div className={`aeroWidget ${styles.result}`}>
          <h3>{t("screenshot.failedTitle")}</h3>
          <p>{t("screenshot.failed")}</p>
          <button onClick={closeAll}>{t("screenshot.close")}</button>
        </div>
      )}
      {captured && captured !== "error" && (
        <div className={`aeroWidget ${styles.result}`} onMouseDown={(e) => e.stopPropagation()}>
          <img src={captured} alt={t("screenshot.preview")} className={styles.preview} />
          <div className={styles.actions}>
            <button onClick={handleCopyText}>{t("screenshot.copyAsText")}</button>
            <button onClick={handleDownload}>{t("screenshot.download")}</button>
            <button onClick={handleOpenInViewer}>{t("screenshot.openInViewer")}</button>
            <button className={styles.cancel} onClick={closeAll}>{t("screenshot.discard")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Crop a base-64 data URL to the given screen rect, accounting for the
 * fact that html-to-image returns the body at its full document size.
 */
async function cropDataUrl(dataUrl: string, rect: Rect, _docW: number, _docH: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      // Map viewport rect → image coords. html-to-image renders the document,
      // so accounting for scroll position is enough.
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      canvas.width = rect.w;
      canvas.height = rect.h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, rect.x + scrollX, rect.y + scrollY, rect.w, rect.h, 0, 0, rect.w, rect.h);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
