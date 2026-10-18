import type { ComponentType } from "react";
import { useDeviceStore, useUIStore, type DeviceStore } from "@claraos/core";
import { NotificationPanel } from "../../Notifications/NotificationPanel";
import { QuickSettingsPanel } from "../QuickSettingsPanel";
import { VolumeTray } from "./VolumeTray";
import { ConnectivityTray } from "./ConnectivityTray";
import { PowerTray } from "./PowerTray";
import { ClaraWorkTray, ClaraWorkTrayIcon, useClaraWorkBadge, useClaraWorkVisible } from "./ClaraWorkTray";
import { VolumeGlyph, WifiGlyph, BatteryGlyph } from "./icons";

/**
 * Tray item registry: the system tray on the right is data instead of
 * hard-coded JSX. One entry = live glyph + popover + visibility.
 *
 * Visibility philosophy: controls only where caps cover them; indicators where
 * data exists (web battery). Volume is ALWAYS present (browser audio as
 * fallback). Clock and show-desktop deliberately stay in Taskbar.tsx — their
 * own look or hover-peek special behavior; a registry row would be a lie.
 *
 * Maintenance rule: `tourId` only for elements that are GUARANTEED to exist
 * (cap-gated buttons would break tour starts) — and keep every change here in
 * lockstep with Tour/anchors.ts.
 *
 * Configurability (deliberately deferred): if a "tray" settings module
 * arrives, `TRAY_ITEMS` additionally filters on `!hidden.includes(id)` — the
 * registry needs nothing more for that.
 */
export interface TrayItemDef {
  id: string;
  /** Sort order, gaps of 100 for later insertions. */
  order: number;
  title: string;
  TrayIcon: ComponentType;
  Popover: ComponentType<{ onClose: () => void }>;
  /** Hook — called in TrayButton (own component instance per item). */
  useBadge?: () => number;
  /** Visibility from device store state; missing = always visible. */
  visibleWhen?: (dev: DeviceStore) => boolean;
  /** Visibility from live data instead of device state — a hook, called in
   *  TrayButton (like `useBadge`). Missing = always visible. */
  useVisible?: () => boolean;
  ctxId?: string;
  tourId?: string;
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.34.4.63.73.8.3.16.65.2 1 .2H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>
  );
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
  );
}

function VolumeTrayIcon() {
  const audio = useDeviceStore((s) => s.audio);
  const pageVolume = useDeviceStore((s) => s.pageVolume);
  const level = audio ? audio.volume : pageVolume;
  const muted = audio ? audio.muted : pageVolume === 0;
  return <VolumeGlyph level={level} muted={muted} />;
}

function ConnectivityTrayIcon() {
  const wifi = useDeviceStore((s) => s.wifi);
  const btConnected = useDeviceStore((s) => (s.bluetooth?.connected.length ?? 0) > 0);
  return <WifiGlyph signal={wifi?.signal ?? null} off={wifi ? !wifi.enabled : false} btConnected={btConnected} />;
}

function PowerTrayIcon() {
  const battery = useDeviceStore((s) => s.battery);
  return <BatteryGlyph percent={battery?.percent ?? 0} charging={battery?.charging ?? false} />;
}

export const TRAY_ITEMS: TrayItemDef[] = [
  {
    id: "quick-settings",
    order: 100,
    title: "Schnelleinstellungen (Win+A)",
    TrayIcon: GearIcon,
    Popover: ({ onClose }) => <QuickSettingsPanel open onClose={onClose} />,
    ctxId: "tray-quick-settings",
    tourId: "tray-quick-settings", // always present -> safe for tours
  },
  {
    id: "volume",
    order: 200,
    title: "Lautstärke",
    TrayIcon: VolumeTrayIcon,
    Popover: VolumeTray,
    ctxId: "tray-volume", // always visible (browser audio fallback)
  },
  {
    id: "connectivity",
    order: 300,
    title: "Verbindungen",
    TrayIcon: ConnectivityTrayIcon,
    Popover: ConnectivityTray,
    visibleWhen: (dev) => dev.caps.includes("wifi") || dev.caps.includes("bluetooth"),
    ctxId: "tray-connectivity",
  },
  {
    id: "power",
    order: 400,
    title: "Energie",
    TrayIcon: PowerTrayIcon,
    Popover: PowerTray,
    // Cap OR web battery data (navigator.getBattery) — show where data exists
    visibleWhen: (dev) =>
      dev.caps.includes("battery") || dev.caps.includes("brightness") || dev.battery !== null,
    ctxId: "tray-power",
  },
  {
    id: "notifications",
    order: 500,
    title: "Benachrichtigungen",
    TrayIcon: BellIcon,
    Popover: ({ onClose }) => <NotificationPanel open onClose={onClose} />,
    useBadge: () =>
      useUIStore((s) => s.notifications.filter((n) => !n.read && n.countInBadge !== false).length),
    ctxId: "tray-bell",
  },
  {
    // Moved here from the middle of the start menu. The entry only appears
    // while Clara is actually working on something — not a permanent guest.
    id: "clara-work",
    order: 600,
    title: "Clara arbeitet",
    TrayIcon: ClaraWorkTrayIcon,
    Popover: ClaraWorkTray,
    useBadge: useClaraWorkBadge,
    useVisible: useClaraWorkVisible,
    ctxId: "tray-clara-work",
    // deliberately NO tourId: the button is not guaranteed to exist (see maintenance rule).
  },
];
