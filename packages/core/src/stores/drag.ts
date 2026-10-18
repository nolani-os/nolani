import { create } from "zustand";
import type { DraggedItem } from "../types";

/**
 * Global drag-state store for cross-surface drag&drop.
 *
 * Foundation: any surface can call `startDrag(item)` when the user
 * begins dragging something draggable (file, app, window). Drop targets read
 * `current` (or subscribe to it) and ack the drop. The Shell-level dispatcher
 * routes the active drag to whichever zone the cursor is over.
 */
export interface DragStore {
  current: DraggedItem | null;
  hoveredZone: string | null;

  startDrag: (item: DraggedItem) => void;
  endDrag: () => void;
  setOver: (zoneId: string | null) => void;
}

export const useDragStore = create<DragStore>((set) => ({
  current: null,
  hoveredZone: null,

  startDrag: (item) => set({ current: item, hoveredZone: null }),
  endDrag: () => set({ current: null, hoveredZone: null }),
  setOver: (zoneId) => set({ hoveredZone: zoneId }),
}));
