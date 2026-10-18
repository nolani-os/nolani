import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { idbStorage } from "./persist";
import { useSettingsStore } from "./settings";

export interface ClipboardEntry {
  id: string;
  text: string;
  timestamp: number;
  source?: string;                    // optional label, e.g. "credentials", "files"
}

const MAX_ENTRIES_DEFAULT = 20;

/**
 * How many entries the history keeps — Settings → History.
 * 0 turns it off (then nothing is remembered at all, not merely hidden: a
 * history that secretly keeps recording would be deceptive).
 */
function historyLimit(): number {
  const v = useSettingsStore.getState().values["privacy-history"]?.clipboardHistorySize;
  return typeof v === "number" ? v : MAX_ENTRIES_DEFAULT;
}

export interface ClipboardStore {
  entries: ClipboardEntry[];
  add: (text: string, source?: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

let counter = 0;
const newId = () => `clip-${Date.now().toString(36)}-${++counter}`;

/**
 * Win+V-style clipboard history.
 *
 * The browser's Clipboard API only allows reading on user gesture, so we
 * append entries opportunistically — whenever the app explicitly copies
 * something via navigator.clipboard.writeText, the caller should also push
 * to this store. The Win+V overlay reads from `entries` and
 * writes back to the system clipboard on click.
 */
export const useClipboardStore = create<ClipboardStore>()(
  persist(
    (set) => ({
      entries: [],

      add: (text, source) => {
        const t = text.trim();
        if (!t) return;
        const limit = historyLimit();
        if (limit <= 0) {
          // History turned off: remember nothing and clear existing entries.
          set((s) => (s.entries.length ? { entries: [] } : s));
          return;
        }
        set((s) => {
          // Dedupe: if last entry is the same text, just bump timestamp
          const [first, ...rest] = s.entries;
          if (first && first.text === t) {
            return { entries: [{ ...first, timestamp: Date.now() }, ...rest] };
          }
          const next: ClipboardEntry = { id: newId(), text: t, timestamp: Date.now(), source };
          return { entries: [next, ...s.entries].slice(0, limit) };
        });
      },

      remove: (id) => set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),

      clear: () => set({ entries: [] }),
    }),
    {
      name: "claraos-clipboard",
      storage: createJSONStorage(() => idbStorage),
    },
  ),
);
