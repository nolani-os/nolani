import { useEffect, useState } from "react";
import { useMarkerStore } from "@claraos/core";
import MarkerOverlay, { computeBboxFromState } from "./MarkerOverlay";

/**
 * Top-level modal that listens to `useMarkerStore.pendingMarkup` and opens
 * a fullscreen MarkerOverlay over the supplied snapshot. Used by iframe
 * drivers that don't host MarkerJS themselves: they post a raw
 * snapshot to the shell, which then routes it through this modal so the
 * user gets the same Pinsel/Pfeil/Text/Bbox toolbar as Image-Viewer.
 */
export default function MarkerOverlayModal() {
  const pendingMarkup = useMarkerStore((s) => s.pendingMarkup);
  const setPinned = useMarkerStore((s) => s.setPinned);
  const clearPendingMarkup = useMarkerStore((s) => s.clearPendingMarkup);
  const [blob, setBlob] = useState<Blob | null>(null);

  useEffect(() => {
    if (!pendingMarkup) {
      setBlob(null);
      return;
    }
    const bin = atob(pendingMarkup.snapshotB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    setBlob(new Blob([bytes], { type: "image/png" }));
  }, [pendingMarkup]);

  if (!pendingMarkup || !blob) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100000,
        background: "rgba(0,0,0,0.85)",
      }}
    >
      <MarkerOverlay
        imageBlob={blob}
        onConfirm={(annotatedDataUrl, state) => {
          const b64 = annotatedDataUrl.split(",", 2)[1] ?? "";
          const bboxPx = computeBboxFromState(state);
          setPinned({
            kind: "bbox-img",
            appId: pendingMarkup.base.appId,
            objectUri: pendingMarkup.base.objectUri,
            snapshotB64: b64,
            capturedAt: new Date().toISOString(),
            ...(bboxPx ? { bboxPx } : {}),
          });
        }}
        onCancel={clearPendingMarkup}
      />
    </div>
  );
}
