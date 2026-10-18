/**
 * In-app viewfinder.
 *
 * Important: **why this is needed after all.**
 * An earlier design dismissed `getUserMedia` as "viewfinder quality only" and
 * relied on the native camera instead (`<input capture>`). Two things about
 * that were wrong:
 *
 *   1. Warning: **in the INSTALLED app, `capture` only opens the gallery.**
 *      In the browser the same code works — in the WebAPK it does not. A
 *      capture path that fails exactly where the app is used daily is no
 *      capture path at all.
 *   2. **The quality claim no longer holds.** `ImageCapture.takePhoto()`
 *      delivers the **full sensor resolution**, not the viewfinder frame. What
 *      is missing is computational photography (HDR, night mode) — irrelevant
 *      for documents, receipts and barcodes, relevant for holiday photos. So
 *      the system camera remains available as an option.
 *
 * Side benefit: a live image is what makes the app a camera in the first
 * place — before, half the screen was empty.
 */

export interface SucherStart {
  stream: MediaStream;
  /** What the camera actually delivers — not what we asked for. */
  breite: number;
  hoehe: number;
}

/** Highest sensible request; the camera gives what it can. */
// Important: the viewfinder doesn't need 4K — the live image is only displayed
// and sampled for the 256 px probe. The capture comes from `takePhoto()` and is
// independent of it. A smaller stream saves battery and starts faster.
const WUNSCH = { width: { ideal: 1920 }, height: { ideal: 1080 } };

export function sucherMoeglich(): boolean {
  return !!navigator.mediaDevices?.getUserMedia;
}

/** Is the app running as an installed app (not in a browser tab)? */
export function alsAppInstalliert(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches
    || window.matchMedia?.("(display-mode: fullscreen)").matches
    || (navigator as { standalone?: boolean }).standalone === true;
}

/**
 * Starts the rear camera. Throws with a readable message if that fails —
 * the system camera then remains as a fallback.
 */
export async function starteSucher(): Promise<SucherStart> {
  if (!sucherMoeglich()) throw new Error("Dieser Browser kann keine Kamera öffnen.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, ...WUNSCH },
      audio: false,
    });
  } catch (e) {
    const name = (e as { name?: string }).name || "";
    if (name === "NotAllowedError") throw new Error("Kamerazugriff wurde abgelehnt.");
    if (name === "NotFoundError") throw new Error("Keine Kamera gefunden.");
    throw new Error("Kamera lässt sich nicht öffnen.");
  }
  const spur = stream.getVideoTracks()[0];
  const s = spur?.getSettings?.() || {};
  return { stream, breite: s.width || 0, hoehe: s.height || 0 };
}

/** Close the camera cleanly — otherwise the indicator light stays on. */
export function beendeSucher(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

interface FotoBereich { min?: number; max?: number; step?: number }
interface FotoKoennen { imageWidth?: FotoBereich; imageHeight?: FotoBereich }
interface ImageCaptureLike {
  takePhoto(einstellungen?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>;
  getPhotoCapabilities?(): Promise<FotoKoennen>;
}

/**
 * Take a picture. Uses the best available path:
 *   1. `ImageCapture.takePhoto()` — **full sensor resolution**
 *   2. otherwise the video frame drawn onto a canvas (still up to 4K)
 */
export async function ausloesen(
  stream: MediaStream, videoEl: HTMLVideoElement | null,
): Promise<Blob> {
  const spur = stream.getVideoTracks()[0];
  const Ctor = (globalThis as Record<string, unknown>).ImageCapture as
    | (new (t: MediaStreamTrack) => ImageCaptureLike) | undefined;

  if (typeof Ctor === "function" && spur) {
    const ic = new Ctor(spur);

    // Warning: **without settings, `takePhoto()` often only uses the resolution
    // of the viewfinder frame** — not that of the sensor, so a document can end
    // up well below the needed density. The standard for receipts is
    // **300 dpi**; below that, recognition of the price column degrades sharply,
    // even with a modern recogniser.
    //
    // Important: hence the maximum is requested explicitly. More is not better,
    // by the way: the literature measures **worse** results at 1200 dpi than at
    // 300, because noise grows with resolution. The goal is to reach 300, not to
    // exceed it.
    let gross: { imageWidth?: number; imageHeight?: number } | undefined;
    try {
      const koennen = await ic.getPhotoCapabilities?.();
      const b = koennen?.imageWidth?.max;
      const h = koennen?.imageHeight?.max;
      if (b && h) gross = { imageWidth: b, imageHeight: h };
    } catch {
      // No `getPhotoCapabilities` — fall back to the defaults.
    }

    // Important: two attempts: first with maximum, then without. Some devices
    // report capabilities that they reject when taking the picture — a photo at
    // default resolution is still better than none.
    for (const einstellung of [gross, undefined]) {
      if (einstellung === undefined && gross === undefined) continue;
      try {
        const foto = await ic.takePhoto(einstellung);
        if (foto && foto.size > 0) return foto;
      } catch {
        // continue with the next attempt
      }
    }
  }

  if (!videoEl || !videoEl.videoWidth) throw new Error("Kein Bild vom Sucher.");
  const c = document.createElement("canvas");
  c.width = videoEl.videoWidth;
  c.height = videoEl.videoHeight;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Kein Bild vom Sucher.");
  ctx.drawImage(videoEl, 0, 0);
  const blob: Blob | null = await new Promise((res) =>
    c.toBlob((b) => res(b), "image/jpeg", 0.95));
  if (!blob) throw new Error("Aufnahme fehlgeschlagen.");
  return blob;
}

/**
 * Does the camera have a torch that can be switched?
 *
 * Important: in poor light this is the only remedy available in the browser
 * at all — the device controls exposure and gain itself. Native scanner apps
 * offer a flash button for exactly that reason.
 *
 * Warning: not every device supports it, and `getCapabilities` is missing
 * entirely in some browsers. Then there is simply no button — better than a
 * button that does nothing.
 */
export function leuchteMoeglich(stream: MediaStream | null): boolean {
  const spur = stream?.getVideoTracks()[0];
  const koennen = spur?.getCapabilities?.() as { torch?: boolean } | undefined;
  return !!koennen?.torch;
}

/** Torch on or off. Returns whether it worked. */
export async function leuchte(stream: MediaStream | null, an: boolean): Promise<boolean> {
  const spur = stream?.getVideoTracks()[0];
  if (!spur) return false;
  try {
    // `torch` is not in the standard types, but has been the usual spelling in
    // Chromium for years.
    await spur.applyConstraints(
      { advanced: [{ torch: an }] } as unknown as MediaTrackConstraints);
    return true;
  } catch {
    return false;
  }
}
