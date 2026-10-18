/**
 * Toggle pointer-events on all iframes during drag/resize.
 * Without this, iframes steal mouse events and break drag behavior.
 * Pattern from daedalOS: useRnd.ts:15-19
 */
export function setIframeCapture(enable: boolean): void {
  document.querySelectorAll("iframe").forEach((iframe) => {
    (iframe as HTMLIFrameElement).style.pointerEvents = enable ? "auto" : "none";
  });
}
