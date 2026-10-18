/**
 * QuickSettings — quick settings of the mobile shade, version 2.
 *
 * Layout modelled on Android 16 / One UI 8, not guessed: header (account ·
 * edit layout · settings · reload) -> sliders as pills -> tiles in a 4-column
 * grid: LARGE tiles (2 columns, icon in a circle + name + state) for things
 * with state, SMALL ones (1 column, icon only) for plain toggles.
 * Active = accent surface with dark icon, inactive = surface 2.
 *
 * Warning: version 1 had 0 × `var(--`: light mode and accent color never
 * arrived here, and the icons were emoji (different on each device vendor and
 * desktop, colored, not themeable). Now tokens only and our own icon set.
 *
 * The device logic (Companion bridge, caps, server-side DND, account value
 * uiScale) is unchanged — only the presentation is new.
 *
 * Important: everything that owns finger drags (sliders) carries
 * data-qs-control — the shade's close and switch gestures leave such
 * elements alone.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  useUIStore,
  useWindowsStore,
  useVoiceStore,
  useMobilePrefs,
  useSettingsStore,
  useDeviceStore,
  isDndActive,
  dndRemainingLabel,
  dndUntilFor,
  getNativeDevice,
  type DevicePanel,
} from "@claraos/core";
import { COMPANION_APK_URL, IS_COMPANION } from "../OnboardingInstallPrompt";
import { Icon, type IconName } from "../components/Icon";
import { IconButton } from "../components/Button";
import { ActionSheet } from "../components/ActionSheet";
import styles from "./QuickSettings.module.css";

/* Android browser/PWA (but not already the Companion app): offer the native app. */
const OFFER_ANDROID_APP = /Android/i.test(navigator.userAgent) && !IS_COMPANION;

/** Large tile: 2 columns, name + state. Small: icon only, name as title. */
function Tile({
  icon, label, sub, active, gross, disabled, testId, onClick,
}: {
  icon: IconName; label: string; sub?: string; active: boolean; gross?: boolean;
  disabled?: boolean; testId: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.tile} ${gross ? styles.tileGross : ""} ${active ? styles.tileAn : ""}`}
      onClick={onClick}
      disabled={disabled}
      data-qs-tile={testId}
      aria-pressed={active}
      aria-label={gross ? undefined : label}
      title={gross ? undefined : (sub ? `${label} · ${sub}` : label)}
    >
      <span className={styles.kreis}><Icon name={icon} size={24} /></span>
      {gross && (
        <span className={styles.text}>
          <span className={styles.name}>{label}</span>
          {sub ? <span className={styles.zustand}>{sub}</span> : null}
        </span>
      )}
    </button>
  );
}

/** Slider as a pill (Android look): the native <input type=range> sits
 *  invisibly on top and remains the control — keyboard, screen reader and
 *  touch stay native; only the drawing is ours. */
function Regler({
  icon, value, label, testId, onChange, disabled, children,
}: {
  icon: IconName; value: number; label: string; testId: string;
  onChange: (v: number) => void; disabled?: boolean; children?: ReactNode;
}) {
  return (
    <div className={styles.regler} data-qs-control data-dunkel={value < 14 ? "ja" : undefined}
         style={{ ["--wert" as string]: `${value}%` }}>
      <span className={styles.reglerFuellung} aria-hidden="true" />
      <span className={styles.reglerGriff} aria-hidden="true" />
      <span className={styles.reglerSymbol} aria-hidden="true"><Icon name={icon} size={22} /></span>
      {children}
      <input
        type="range" min={0} max={100} value={value}
        className={styles.reglerInput}
        data-qs-slider={testId}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}

/** The browser may refuse fullscreen (no user gesture, policy of the
 *  embedding frame). Previously the toggle then appeared to do nothing. */
function meldeVollbild() {
  useUIStore.getState().addNotification({
    title: "Vollbild nicht möglich",
    body: "Der Browser hat den Wechsel abgelehnt.",
    icon: "⚠️",
  });
}

export function QuickSettings({ onResetDock }: { onResetDock: () => void }) {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const muted = useVoiceStore((s) => s.muted);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const haptics = useMobilePrefs((s) => s.haptics);
  const toggleHaptics = useMobilePrefs((s) => s.toggleHaptics);
  const shadeAufbau = useMobilePrefs((s) => s.shadeAufbau);
  const setShadeAufbau = useMobilePrefs((s) => s.setShadeAufbau);
  const [aufbauOffen, setAufbauOffen] = useState(false);

  // ── Device (Companion bridge; empty in a plain browser) ──────────────────
  const caps = useDeviceStore((s) => s.caps);
  const hasCap = useDeviceStore((s) => s.hasCap);
  const audio = useDeviceStore((s) => s.audio);
  const brightness = useDeviceStore((s) => s.brightness);
  const battery = useDeviceStore((s) => s.battery);
  const wifi = useDeviceStore((s) => s.wifi);
  const bluetooth = useDeviceStore((s) => s.bluetooth);
  const mic = useDeviceStore((s) => s.mic);
  const pageVolume = useDeviceStore((s) => s.pageVolume);
  const setVolume = useDeviceStore((s) => s.setVolume);
  const setBrightness = useDeviceStore((s) => s.setBrightness);
  const setPageVolume = useDeviceStore((s) => s.setPageVolume);
  const setWifiEnabled = useDeviceStore((s) => s.setWifiEnabled);
  const setBluetoothEnabled = useDeviceStore((s) => s.setBluetoothEnabled);
  const setMicMuted = useDeviceStore((s) => s.setMicMuted);
  const refresh = useDeviceStore((s) => s.refresh);

  // ── Do not disturb = server state (like the desktop QuickSettingsPanel) ──
  const notifValues = useSettingsStore((s) => s.values["notifications"]);
  const putSetting = useSettingsStore((s) => s.apply);
  const setDraft = useSettingsStore((s) => s.setDraft);

  /* Important: font size is ONE value, stored on the account — settings module
   * `appearance`, key `uiScale`, the same as the desktop "interface size"
   * slider. Two writers to documentElement.style.fontSize used to switch
   * each other off. */
  const uiScale = useSettingsStore(
    (s) => (s.values["appearance"]?.uiScale as number | undefined) ?? 100,
  );
  const stelleSchrift = useCallback(
    (prozent: number) => {
      const wert = Math.min(150, Math.max(80, Math.round(prozent / 5) * 5));
      if (wert === uiScale) return;
      setDraft("appearance", "uiScale", wert);
      void putSetting("appearance");
    },
    [uiScale, setDraft, putSetting],
  );
  const dndUntil = typeof notifValues?.dndUntil === "number" ? notifValues.dndUntil : 0;
  const dndPolicy = { dndUntil, criticalInDnd: true, lowPriorityPopups: true,
                      lowPriorityHistory: false, apps: {} };
  const dndOn = isDndActive(dndPolicy);
  const toggleDnd = useCallback(async () => {
    // One tap as in Android's QS: on = "until I turn it off", off = immediately.
    const until = dndOn ? 0 : dndUntilFor(0);
    setDraft("notifications", "dndUntil", until);
    await putSetting("notifications");
  }, [dndOn, setDraft, putSetting]);

  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== "undefined" && !!document.fullscreenElement,
  );
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFullscreen = useCallback(() => {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else void document.documentElement.requestFullscreen?.().catch(meldeVollbild);
    } catch { meldeVollbild(); }
  }, []);

  // Android Companion: apps can no longer toggle Wi-Fi/BT -> open the system
  // panel. Desktop caps (wifi.set) toggle directly. Feature detection instead
  // of guessing the platform.
  const openPanel = useCallback((panel: DevicePanel) => {
    const dev = getNativeDevice();
    if (dev?.openPanel) { dev.openPanel(panel); return true; }
    return false;
  }, []);
  const canOpenPanels = !!getNativeDevice()?.openPanel;

  const onWifiTile = useCallback(() => {
    if (openPanel("internet")) return;
    if (hasCap("wifi.set") && wifi) setWifiEnabled(!wifi.enabled);
  }, [openPanel, hasCap, wifi, setWifiEnabled]);
  const onMicTile = useCallback(() => {
    if (mic) setMicMuted(!mic.muted);
  }, [mic, setMicMuted]);
  const onBtTile = useCallback(() => {
    if (openPanel("bluetooth")) return;
    if (hasCap("bluetooth.set") && bluetooth) setBluetoothEnabled(!bluetooth.enabled);
  }, [openPanel, hasCap, bluetooth, setBluetoothEnabled]);

  // Brightness: slider only with the set cap. On Android without permission
  // the row shows the "Allow" button instead (WRITE_SETTINGS system dialog).
  const canSetBrightness = hasCap("brightness.set");
  const canRequestBrightness = !canSetBrightness && hasCap("brightness")
    && !!getNativeDevice()?.requestPermission;
  const requestBrightness = useCallback(async () => {
    const dev = getNativeDevice();
    if (!dev?.requestPermission) return;
    try {
      await dev.requestPermission("brightness");
      void refresh();
    } catch { /* dialog cancelled */ }
  }, [refresh]);

  // Volume: real system volume with audio.set (Companion), otherwise the page
  // volume (PWA reality).
  const systemVolume = hasCap("audio.set");
  const volumeValue = systemVolume ? (audio?.volume ?? 50) : pageVolume;
  const onVolumeChange = useCallback((v: number) => {
    if (systemVolume) setVolume(v);
    else setPageVolume(v);
  }, [systemVolume, setVolume, setPageVolume]);

  const oeffneEinstellungen = useCallback(() => {
    useWindowsStore.getState().openWindow("settings");
  }, []);

  const hatWifi = caps.includes("wifi") && !!wifi;
  const hatBt = caps.includes("bluetooth") && !!bluetooth;
  const datum = new Date().toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" });

  return (
    <div className={styles.panel} data-qs-root>
      {/* ── Header: account · layout · settings · reload ── */}
      <div className={styles.kopf}>
        <span className={styles.konto} aria-hidden="true" />
        <span className={styles.datum}>{datum}</span>
        <span className={styles.kopfAktionen}>
          <IconButton label="Aufbau der Shade ändern" icon="pen" groesse="s"
                      data-qs-tile="aufbau" onClick={() => setAufbauOffen(true)} />
          <IconButton label="Einstellungen öffnen" icon="gear" groesse="s"
                      data-qs-tile="settings" onClick={oeffneEinstellungen} />
          <IconButton label="ClaraOS neu laden" icon="reload" groesse="s"
                      data-qs-tile="reload" onClick={() => window.location.reload()} />
        </span>
      </div>

      {/* ── Sliders ── */}
      {hasCap("brightness") && (
        canSetBrightness ? (
          <Regler icon="sun" value={brightness ?? 50} label="Helligkeit" testId="brightness"
                  onChange={setBrightness} />
        ) : (
          <button type="button" className={styles.freigabe} onClick={requestBrightness}
                  disabled={!canRequestBrightness} data-qs-tile="brightness-perm" data-qs-control>
            <Icon name="sun" size={20} /> Helligkeitssteuerung erlauben
          </button>
        )
      )}
      <Regler icon={volumeValue === 0 ? "volumeOff" : "volume"} value={volumeValue}
              label={systemVolume ? "Lautstärke" : "Medien-Lautstärke"}
              testId={systemVolume ? "volume" : "media"} onChange={onVolumeChange}>
        <span className={styles.reglerWert}>{volumeValue} %</span>
      </Regler>

      {/* ── Tiles: first ALL large ones (with state), then all small ones — so
          rows fill up instead of an orphan standing next to two gaps ── */}
      <div className={styles.tiles}>
        {hatWifi ? (
          <Tile gross icon="wifi" label="WLAN"
                sub={wifi!.connected ?? (wifi!.enabled ? "An" : "Aus")}
                active={wifi!.enabled} testId="wifi" onClick={onWifiTile} />
        ) : (
          <Tile gross icon={dndOn ? "dnd" : "bell"} label="Nicht stören"
                sub={dndOn ? dndRemainingLabel(dndPolicy) : "Aus"}
                active={dndOn} testId="dnd" onClick={() => void toggleDnd()} />
        )}
        {hatBt ? (
          <Tile gross icon="bluetooth" label="Bluetooth"
                sub={bluetooth!.enabled ? "An" : "Aus"}
                active={bluetooth!.enabled} testId="bluetooth" onClick={onBtTile} />
        ) : (
          <Tile gross icon={theme === "dark" ? "moon" : "sun"}
                label={theme === "dark" ? "Dunkel" : "Hell"}
                sub={theme === "dark" ? "Dunkles Design" : "Helles Design"}
                active={theme === "dark"} testId="theme"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")} />
        )}
        <Tile gross icon="devices" label="Geräte-Hub" sub="Zuhause"
              active={false} testId="devices"
              onClick={() => useWindowsStore.getState().openWindow("geraete")} />
        {canOpenPanels ? (
          <Tile gross icon="hotspot" label="Hotspot" sub="System" active={false}
                testId="tethering" onClick={() => openPanel("tethering")} />
        ) : battery ? (
          <Tile gross icon="battery" label="Akku"
                sub={`${battery.percent} %${battery.charging ? " · lädt" : ""}`}
                active={battery.charging} testId="battery" onClick={() => { /* display only */ }} />
        ) : (
          <Tile gross icon="comment" label="Feedback" sub="An den Admin" active={false} testId="feedback"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("claraos-open-feedback", {
                    detail: { source: "quicksettings" },
                  }))} />
        )}

        {hatWifi && (
          <Tile icon={dndOn ? "dnd" : "bell"} label={dndOn ? `Nicht stören · ${dndRemainingLabel(dndPolicy)}` : "Nicht stören"}
                active={dndOn} testId="dnd" onClick={() => void toggleDnd()} />
        )}
        {hatBt && (
          <Tile icon={theme === "dark" ? "moon" : "sun"} label={theme === "dark" ? "Dunkel" : "Hell"}
                active={theme === "dark"} testId="theme"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")} />
        )}
        <Tile icon={muted ? "volumeOff" : "volume"} label={muted ? "Clara-Stimme stumm" : "Clara-Stimme"}
              active={!muted} testId="voice" onClick={toggleMute} />
        <Tile icon="vibrate" label="Haptik" active={haptics} testId="haptics" onClick={toggleHaptics} />
        {caps.includes("mic.set") && mic && (
          <Tile icon="mic" label={mic.muted ? "Mikrofon stumm" : "Mikrofon"}
                active={!mic.muted} testId="mic" onClick={onMicTile} />
        )}
        <Tile icon="fullscreen" label="Vollbild" active={isFullscreen}
              testId="fullscreen" onClick={toggleFullscreen} />
        <Tile icon="camera" label="Kamera" active={false} testId="kamera"
              onClick={() => useWindowsStore.getState().openWindow("kamera")} />
        {(canOpenPanels || battery) && (
          <Tile icon="comment" label="Feedback" active={false} testId="feedback"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("claraos-open-feedback", {
                    detail: { source: "quicksettings" },
                  }))} />
        )}
        <Tile icon="restore" label="Dock zurücksetzen" active={false}
              testId="dock-reset" onClick={onResetDock} />
        {OFFER_ANDROID_APP && (
          <Tile icon="android" label="Android-App laden" active={false} testId="get-app"
                onClick={() => window.location.assign(COMPANION_APK_URL)} />
        )}
      </div>

      {/* Font size — writes the SAME account value as the desktop
          "interface size" slider (see stelleSchrift above). */}
      <div className={styles.schrift}>
        <span className={styles.schriftLabel}>
          <Icon name="textSize" size={22} />
          <span>Schrift {uiScale} %</span>
        </span>
        <span className={styles.schriftKnoepfe}>
          <button type="button" className={styles.schriftKnopf} onClick={() => stelleSchrift(uiScale - 5)} aria-label="Schrift kleiner">A−</button>
          <button type="button" className={styles.schriftKnopf} onClick={() => stelleSchrift(uiScale + 5)} aria-label="Schrift größer">A+</button>
        </span>
      </div>

      <ActionSheet
        open={aufbauOffen}
        onClose={() => setAufbauOffen(false)}
        title="Aufbau der Shade"
        items={[
          { id: "getrennt", label: `${shadeAufbau === "getrennt" ? "● " : "○ "}Getrennt — links Benachrichtigungen, rechts Einstellungen`,
            onSelect: () => setShadeAufbau("getrennt") },
          { id: "kombiniert", label: `${shadeAufbau === "kombiniert" ? "● " : "○ "}Kombiniert — alles in einem Panel`,
            onSelect: () => setShadeAufbau("kombiniert") },
        ]}
      />
    </div>
  );
}
