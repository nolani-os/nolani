import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { idbStorage } from "./persist";

export interface AppCenterStore {
  // Filter state
  showThirdParty: boolean;
  searchQuery: string;
  expandedCategories: string[];

  // Actions
  setShowThirdParty: (show: boolean) => void;
  setSearchQuery: (q: string) => void;
  toggleCategory: (cat: string) => void;

  // Pinned favorites (shared between taskbar + startmenu)
  pinnedAppIds: string[];
  pinApp: (appId: string) => void;
  unpinApp: (appId: string) => void;
  isPinned: (appId: string) => boolean;
}

export const useAppCenterStore = create<AppCenterStore>()(
  persist(
    (set, get) => ({
  showThirdParty: true,
  searchQuery: "",
  expandedCategories: ["productivity", "system", "engineering", "services", "finance"],

  setShowThirdParty: (show) => set({ showThirdParty: show }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  toggleCategory: (cat) =>
    set((s) => ({
      expandedCategories: s.expandedCategories.includes(cat)
        ? s.expandedCategories.filter((c) => c !== cat)
        : [...s.expandedCategories, cat],
    })),

  pinnedAppIds: ["settings", "files"],
  pinApp: (appId) =>
    set((s) => ({
      pinnedAppIds: s.pinnedAppIds.includes(appId) ? s.pinnedAppIds : [...s.pinnedAppIds, appId],
    })),
  unpinApp: (appId) =>
    set((s) => ({ pinnedAppIds: s.pinnedAppIds.filter((id) => id !== appId) })),
  isPinned: (appId) => get().pinnedAppIds.includes(appId),
    }),
    {
      name: "claraos-appcenter",
      storage: createJSONStorage(() => idbStorage),
      // Only the pins survive reloads — filter/search are deliberately session state.
      // Server sync (UserPrefs.pinned_apps) is handled by useStateSync.ts.
      partialize: (state) => ({ pinnedAppIds: state.pinnedAppIds }),
    },
  ),
);
