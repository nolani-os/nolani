import { useUIStore } from "@claraos/core";
import { CalendarPopup } from "../CalendarPopup";
import { TRAY_ITEMS } from "./registry";

/**
 * Renders the active tray popover (exactly one, useUIStore.trayPopover).
 * The popovers position themselves (fixed above the taskbar) and bring
 * their own backdrop — the host only selects.
 * "calendar" is not a registry item (the clock stays in Taskbar.tsx),
 * but it uses the same exclusivity state.
 */
export function TrayPopoverHost() {
  const active = useUIStore((s) => s.trayPopover);
  const setTrayPopover = useUIStore((s) => s.setTrayPopover);
  const close = () => setTrayPopover(null);

  if (!active) return null;
  if (active === "calendar") return <CalendarPopup open onClose={close} />;
  const item = TRAY_ITEMS.find((i) => i.id === active);
  if (!item) return null;
  return <item.Popover onClose={close} />;
}
