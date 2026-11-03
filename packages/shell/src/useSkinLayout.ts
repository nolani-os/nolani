import { useMemo } from "react";
import { useUIStore, type SkinManifest } from "@claraos/core";
import { resolveSkin } from "@claraos/skins";

export interface SkinLayout {
  taskbarPosition: "bottom" | "top" | "left" | "right";
  windowButtonsPosition: "right" | "left";
  startMenuStyle: "grid" | "list" | "dock";
  taskbarHeight: number;
  /** Separate bar at the top while the dock sits at the bottom. */
  menuBar: boolean;
  /** Search field next to the start button. */
  searchField: boolean;
  /** Look of the workspace overview. */
  overviewStyle: "taskview" | "mission" | "overview";
}

const DEFAULT_LAYOUT: SkinLayout = {
  taskbarPosition: "bottom",
  windowButtonsPosition: "right",
  startMenuStyle: "grid",
  taskbarHeight: 48,
  menuBar: false,
  searchField: false,
  overviewStyle: "overview",
};

/** Corporate branding of the active skin (logo + company name in the start
 *  button), undefined for the product skins. */
export function useSkinBrand(): SkinManifest["brand"] {
  const skinId = useUIStore((s) => s.skinId);
  return useMemo(() => resolveSkin(skinId)?.brand, [skinId]);
}

export function useSkinLayout(): SkinLayout {
  const skinId = useUIStore((s) => s.skinId);

  return useMemo(() => {
    const skin = resolveSkin(skinId);
    if (!skin) return DEFAULT_LAYOUT;
    return {
      taskbarPosition: skin.layout.taskbarPosition,
      windowButtonsPosition: skin.layout.windowButtonsPosition,
      startMenuStyle: skin.layout.startMenuStyle,
      taskbarHeight: skin.layout.taskbarHeight,
      menuBar: Boolean(skin.layout.menuBar) && skin.layout.startMenuStyle === "dock",
      searchField: Boolean(skin.layout.searchField),
      overviewStyle: skin.layout.overviewStyle ?? "overview",
    };
  }, [skinId]);
}
