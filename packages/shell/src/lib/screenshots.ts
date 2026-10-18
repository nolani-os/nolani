/**
 * Screenshot helpers — used by Phase 5 Win+Shift+S tool, but the API is
 * exposed already so other features (e.g. Alt+Tab thumbnails in Phase 3,
 * hover-thumbs in Phase 4) can share the same surface.
 *
 * Two capture strategies:
 *   1. captureRect(el, opts) — DOM-based, fast, works inside the tab.
 *      Used for window thumbnails and Alt+Tab previews. Phase 3 wires this
 *      up to html-to-image (added then). Until then, throws a friendly error.
 *   2. captureScreen() — getDisplayMedia, requires user permission, captures
 *      the actual screen (incl. browser chrome). For the screenshot tool.
 */

export interface CaptureRectOptions {
  /** Output max dimension. Default 320 px (suitable for thumbnails). */
  maxSize?: number;
  /** Output format. Default "image/png". */
  format?: "image/png" | "image/webp" | "image/jpeg";
  /** JPEG/WebP quality 0-1. */
  quality?: number;
}

/**
 * Capture a DOM element to a Blob via html-to-image. Returns null on any
 * failure (cross-origin iframe, SVG quirk, etc.) so callers can fall back
 * to a placeholder thumbnail without blowing up.
 */
export async function captureRect(
  element: HTMLElement,
  opts: CaptureRectOptions = {},
): Promise<Blob | null> {
  try {
    const { toBlob } = await import("html-to-image");
    const maxSize = opts.maxSize ?? 320;
    const { width, height } = element.getBoundingClientRect();
    const scale = Math.min(1, maxSize / Math.max(width, height));
    return await toBlob(element, {
      type: opts.format ?? "image/png",
      quality: opts.quality ?? 0.85,
      pixelRatio: scale,
      cacheBust: false,
    });
  } catch {
    return null;
  }
}

/** Same as captureRect, but returns a data URL for direct use as <img src=...>. */
export async function captureToDataUrl(
  element: HTMLElement,
  opts: CaptureRectOptions = {},
): Promise<string | null> {
  try {
    const { toPng } = await import("html-to-image");
    const maxSize = opts.maxSize ?? 320;
    const { width, height } = element.getBoundingClientRect();
    const scale = Math.min(1, maxSize / Math.max(width, height));
    return await toPng(element, { pixelRatio: scale, cacheBust: false });
  } catch {
    return null;
  }
}

/**
 * Capture a region of the visible screen via getDisplayMedia. Requires user
 * permission. Returns the captured Blob or throws on cancellation/error.
 */
export async function captureScreen(): Promise<Blob> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("getDisplayMedia not supported in this browser");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" } as MediaTrackConstraints,
    audio: false,
    // @ts-expect-error - non-standard but supported by Chromium for current-tab capture
    preferCurrentTab: true,
  });

  try {
    const track = stream.getVideoTracks()[0];
    // ImageCapture is the cleanest path; not available everywhere, fall back to canvas
    const ImageCaptureCtor = (window as unknown as { ImageCapture?: typeof ImageCapture }).ImageCapture;
    if (ImageCaptureCtor) {
      const ic = new ImageCaptureCtor(track);
      const bitmap = await ic.grabFrame();
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2D context unavailable");
      ctx.drawImage(bitmap, 0, 0);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (!blob) throw new Error("Canvas to blob failed");
      return blob;
    }

    // Canvas-via-video fallback
    const video = document.createElement("video");
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("Canvas to blob failed");
    return blob;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** Save a blob to a file via download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
