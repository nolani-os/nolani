import { useEffect, useState } from "react";
import { useWindowsStore, useUIStore, useVoiceStore, useAppRegistryStore, getBrand, regionLocale, useTranslation } from "@claraos/core";
import { WorkspaceSwitcher } from "../Taskbar/WorkspaceSwitcher";
import { TrayCluster } from "../Taskbar/TrayCluster";
import { TrayPopoverHost } from "../Taskbar/tray/TrayPopoverHost";
import { useSkinBrand } from "../useSkinLayout";
import ClaraMark from "../Mobile/clara-c.svg?react";
import styles from "./MenuBar.module.css";

/**
 * The thin bar at the top of a two-bar skin (Orchard): start button, name of
 * the focused app, microphone and workspaces on the left; tray and clock on
 * the right. The apps themselves live in the Dock. Rendered only when the
 * skin layout sets `menuBar` (useSkinLayout).
 */
export function MenuBar() {
  const windows = useWindowsStore((s) => s.windows);
  const focusedWindowId = useWindowsStore((s) => s.focusedWindowId);
  const toggleStartMenu = useUIStore((s) => s.toggleStartMenu);
  const startMenuOpen = useUIStore((s) => s.startMenuOpen);
  const setTrayPopover = useUIStore((s) => s.setTrayPopover);
  const recording = useVoiceStore((s) => s.recording);
  const { t } = useTranslation("shell");
  const brand = useSkinBrand();

  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 10000);
    setTime(new Date());
    return () => clearInterval(timer);
  }, []);

  // Name of the focused app — the product name when no window has focus
  const focused = focusedWindowId ? windows[focusedWindowId] : undefined;
  const focusedApp = focused && !focused.minimized
    ? useAppRegistryStore.getState().getApp(focused.appId)?.name ?? focused.title
    : getBrand().product;

  // Fullscreen: the bar steps aside like the taskbar does (Win+Down brings it back).
  const anyFullscreen = Object.values(windows).some((w) => w.fullscreen && !w.minimized);
  if (anyFullscreen) return null;

  const locale = regionLocale();

  return (
    <>
      <div className={styles.bar} data-shell-part="menu-bar">
        <button
          className={`${styles.claraBtn} ${brand ? styles.brandBtn : ""} ${startMenuOpen ? styles.claraActive : ""}`}
          onClick={() => toggleStartMenu()}
          title={brand ? (brand.tagline ? `${brand.name} — ${brand.tagline}` : brand.name) : t("taskbar.clara")}
          data-tour="taskbar-clara"
          data-shell-part="start-button"
        >
          {brand ? (
            <>
              <img src={brand.logo} alt="" className={styles.brandLogo} draggable={false} />
              <span className={styles.brandName}>{brand.name}</span>
            </>
          ) : (
            <ClaraMark className={styles.claraMark} />
          )}
        </button>

        <span className={styles.appName} data-shell-part="menu-bar-app">{focusedApp}</span>

        <button
          className={`${styles.iconBtn} ${recording ? styles.micRecording : ""}`}
          title={t("taskbar.voice")}
          data-tour="taskbar-voice"
          onClick={() => {
            const vs = useVoiceStore.getState();
            if (vs.active) { vs.clearTranscript(); }
            else { vs.startListening(); }
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={recording ? "#ff3b30" : "currentColor"} strokeWidth="1.5">
            <rect x="5" y="1" width="6" height="9" rx="3" />
            <path d="M3 7a5 5 0 0 0 10 0" />
            <line x1="8" y1="12" x2="8" y2="15" />
            <line x1="5" y1="15" x2="11" y2="15" />
          </svg>
        </button>

        <span className={styles.workspaces}><WorkspaceSwitcher /></span>

        <span className={styles.spacer} />

        <div className={styles.tray} data-shell-part="menu-bar-tray" data-tour="taskbar-tray">
          <TrayCluster />
          <button className={styles.clock} onClick={() => setTrayPopover("calendar")} data-ctx="tray-clock">
            {time.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })}
            {" "}
            {time.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
          </button>
        </div>
      </div>

      <TrayPopoverHost />
    </>
  );
}
