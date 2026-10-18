import { create } from "zustand";
import type { MarkerPayload } from "../types";

/**
 * Global marker-mode store. ChatPanel toggles `mode='picking'` when the user
 * clicks the 📍 pin button; per-app drivers (image viewer, iframe apps via
 * postMessage) react to the mode flip and capture a selection. The selection
 * is then `setPinned()` and shown as a region-chip in the chat input until
 * either sent (next user message attaches it) or cleared.
 *
 * Iframe drivers without a MarkerJS instance of their own post a
 * raw snapshot via `requestMarkup()`. The shell mounts a top-level
 * MarkerOverlayModal that picks up `pendingMarkup` and lets the user
 * annotate before pinning.
 */
export interface PendingMarkup {
  /** Raw PNG snapshot as base64 (no data: prefix). */
  snapshotB64: string;
  /** Base meta to merge into the final BboxImgMarker (appId, objectUri). */
  base: Pick<MarkerPayload, "appId"> & { objectUri?: string };
}

export interface MarkerStore {
  mode: "idle" | "picking";
  pinned: MarkerPayload | null;
  pendingMarkup: PendingMarkup | null;

  startPicking: () => void;
  cancelPicking: () => void;
  setPinned: (payload: MarkerPayload) => void;
  /** Open the markup modal with a raw snapshot — used by iframe drivers. */
  requestMarkup: (req: PendingMarkup) => void;
  clearPendingMarkup: () => void;
  clear: () => void;
}

export const useMarkerStore = create<MarkerStore>((set) => ({
  mode: "idle",
  pinned: null,
  pendingMarkup: null,

  startPicking: () => set({ mode: "picking" }),
  cancelPicking: () => set({ mode: "idle", pendingMarkup: null }),
  setPinned: (payload) => set({ pinned: payload, mode: "idle", pendingMarkup: null }),
  requestMarkup: (req) => set({ pendingMarkup: req }),
  clearPendingMarkup: () => set({ pendingMarkup: null, mode: "idle" }),
  clear: () => set({ pinned: null, mode: "idle", pendingMarkup: null }),
}));
