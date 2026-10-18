import { useMemo } from "react";
import { useUIStore } from "@claraos/core";
import { availableSkins } from "@claraos/skins";

export interface SkinLayout {
  taskbarPosition: "bottom" | "top" | "left" | "right";
  windowButtonsPosition: "right" | "left";
  startMenuStyle: "grid" | "list" | "dock";
  taskbarHeight: number;
}

const DEFAULT_LAYOUT: SkinLayout = {
  taskbarPosition: "bottom",
  windowButtonsPosition: "right",
  startMenuStyle: "grid",
  taskbarHeight: 48,
};

export function useSkinLayout(): SkinLayout {
  const skinId = useUIStore((s) => s.skinId);

  return useMemo(() => {
    const skin = availableSkins.find((s) => s.id === skinId);
    if (!skin) return DEFAULT_LAYOUT;
    return {
      taskbarPosition: skin.layout.taskbarPosition,
      windowButtonsPosition: skin.layout.windowButtonsPosition,
      startMenuStyle: skin.layout.startMenuStyle,
      taskbarHeight: skin.layout.taskbarHeight,
    };
  }, [skinId]);
}
