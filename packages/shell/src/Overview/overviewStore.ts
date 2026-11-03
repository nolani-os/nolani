/**
 * Workspace overview state — session-only, no persistence, no dependency
 * (a tiny external store on useSyncExternalStore).
 *
 * The overview does not draw thumbnails: the real window elements zoom out
 * to the slots computed here (Window.tsx animates its inner element with
 * the slot's dx/dy/scale), so an iframe keeps playing while it shrinks. The
 * hit layer in Overview.tsx draws labels and close buttons on top.
 */
import { useSyncExternalStore } from "react";

export interface OverviewSlot {
  /** translate from the window's own position, in desktop-area pixels */
  dx: number;
  dy: number;
  scale: number;
  /** the slot's box in desktop-area pixels, for the hit layer */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverviewState {
  open: boolean;
  /** minimized windows take part (Task View, Overview) — Mission Control hides them */
  showMinimized: boolean;
  slots: Record<string, OverviewSlot>;
  filter: string;
}

let state: OverviewState = { open: false, showMinimized: true, slots: {}, filter: "" };
const listeners = new Set<() => void>();

function setState(patch: Partial<OverviewState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const overviewActions = {
  openOverview: (showMinimized: boolean) => setState({ open: true, showMinimized, filter: "" }),
  closeOverview: () => setState({ open: false, slots: {}, filter: "" }),
  setSlots: (slots: Record<string, OverviewSlot>) => setState({ slots }),
  setFilter: (filter: string) => setState({ filter }),
};

export function getOverviewState(): OverviewState {
  return state;
}

/** Subscribe to a slice; the selector must return a stable value for an
 *  unchanged state (fields of the state object are). */
export function useOverviewStore<T>(selector: (s: OverviewState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export function toggleOverview(showMinimized = true): void {
  if (state.open) overviewActions.closeOverview();
  else overviewActions.openOverview(showMinimized);
}
