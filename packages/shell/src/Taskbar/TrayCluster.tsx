import { useMemo } from "react";
import { useDeviceStore } from "@claraos/core";
import { TRAY_ITEMS } from "./tray/registry";
import { TrayButton } from "./tray/TrayButton";

/**
 * The system tray's buttons (registry order, device-state visibility) —
 * shared by the Taskbar and the Orchard menu bar. The surrounding element
 * (clock, show-desktop) stays with the surface; this renders only the
 * buttons so the parent decides spacing and size.
 */
export function TrayCluster() {
  // Tray visibility depends on device state (caps/web battery) — the store
  // is the only subscription source, visibleWhen receives the snapshot.
  const deviceState = useDeviceStore();
  const visibleTrayItems = useMemo(
    () =>
      TRAY_ITEMS.filter((i) => !i.visibleWhen || i.visibleWhen(deviceState)).sort(
        (a, b) => a.order - b.order,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceState.caps, deviceState.battery, deviceState.bridgeAvailable],
  );

  return (
    <>
      {visibleTrayItems.map((item) => (
        <TrayButton key={item.id} item={item} />
      ))}
    </>
  );
}
