import { useCallback } from "react";
import { useUIStore } from "@claraos/core";
import type { WidgetProps } from "./registry";
import { ClaraChatPanel } from "../Chat";
import styles from "./Widgets.module.css";

export default function ClaraQuickWidget(_: WidgetProps) {
  const toggleStartMenu = useUIStore((s) => s.toggleStartMenu);
  const startMenuOpen = useUIStore((s) => s.startMenuOpen);

  const expand = useCallback(() => {
    if (!startMenuOpen) toggleStartMenu();
  }, [startMenuOpen, toggleStartMenu]);

  return (
    // No data-no-drag on the wrapper: the panel itself blocks dragging
    // (its own data-no-drag), so the padding edge and the frame grip bar
    // remain usable as drag areas.
    <div className={styles.cq}>
      <ClaraChatPanel variant="quick" onExpand={expand} />
    </div>
  );
}
