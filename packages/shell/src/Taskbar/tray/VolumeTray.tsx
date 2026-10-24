import { useEffect } from "react";
import { useDeviceStore, useTranslation, type TFunction } from "@claraos/core";
import { VolumeGlyph, MicGlyph } from "./icons";
import styles from "./TrayPopover.module.css";

/**
 * Volume flyout. Layers from top to bottom:
 *  - choose output device (cap audio.devices) — headphones <-> speakers
 *  - system volume (cap audio.set): master slider + mute
 *  - microphone (cap mic): mute button + input level, own device selectable
 *  - "Browser audio": page volume — works everywhere, even without
 *    Companion (same localStorage key as before)
 *
 * Important: each layer depends on its own cap: a computer without a
 * microphone shows no dead microphone row, a browser without Companion only
 * shows "Browser audio".
 */
export function VolumeTray({ onClose }: { onClose: () => void }) {
  const audio = useDeviceStore((s) => s.audio);
  const mic = useDeviceStore((s) => s.mic);
  const privacy = useDeviceStore((s) => s.privacy);
  const caps = useDeviceStore((s) => s.caps);
  const hasSet = caps.includes("audio.set");
  const hasDevices = caps.includes("audio.devices");
  const canPickDevice = caps.includes("audio.devices.set");
  const hasMic = caps.includes("mic");
  const hasPrivacy = caps.includes("privacy");
  const canSetMic = caps.includes("mic.set");
  const audioDevices = useDeviceStore((s) => s.audioDevices);
  const setVolume = useDeviceStore((s) => s.setVolume);
  const setMuted = useDeviceStore((s) => s.setMuted);
  const setMicMuted = useDeviceStore((s) => s.setMicMuted);
  const setMicVolume = useDeviceStore((s) => s.setMicVolume);
  const loadAudioDevices = useDeviceStore((s) => s.loadAudioDevices);
  const setDefaultAudioDevice = useDeviceStore((s) => s.setDefaultAudioDevice);
  const pageVolume = useDeviceStore((s) => s.pageVolume);
  const setPageVolume = useDeviceStore((s) => s.setPageVolume);
  const refresh = useDeviceStore((s) => s.refresh);
  const { t } = useTranslation("shell");

  // Fetch the device list only on open — it costs a pactl call and only
  // changes when someone plugs in a cable.
  useEffect(() => {
    if (hasDevices) void loadAudioDevices();
  }, [hasDevices, loadAudioDevices]);

  const picker = (kind: "sink" | "source", label: string) => {
    const list = audioDevices.filter((d) => d.kind === kind);
    if (list.length < 2) return null; // a single option is no choice
    const current = list.find((d) => d.default)?.id ?? "";
    return (
      <select
        className={styles.select}
        value={current}
        disabled={!canPickDevice}
        aria-label={label}
        data-audio-picker={kind}
        onChange={(e) => void setDefaultAudioDevice(kind, e.target.value)}
      >
        {list.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>
    );
  };

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={`aeroWidget ${styles.panel}`} role="dialog" aria-label={t("tray.volume.title")}
        data-tray-popover="volume">
        <div className={styles.header}>
          <span className={styles.title}>{t("tray.volume.title")}</span>
        </div>

        {audio && hasSet && (
          <section className={styles.section}>
            <div className={styles.sectionLabel}>
              {audio.sink ? t("tray.volume.systemDevice", { device: audio.sink }) : t("tray.volume.system")}
            </div>
            {picker("sink", t("tray.volume.output"))}
            <div className={styles.row}>
              <button
                className={`${styles.iconBtn} ${audio.muted ? styles.iconBtnActive : ""}`}
                onClick={() => setMuted(!audio.muted)}
                title={audio.muted ? t("tray.volume.unmute") : t("tray.volume.mute")}
                aria-pressed={audio.muted}
              >
                <VolumeGlyph level={audio.volume} muted={audio.muted} />
              </button>
              <input
                type="range" min={0} max={100} value={audio.volume}
                className={styles.slider}
                onChange={(e) => setVolume(Number(e.target.value))}
                // drag end: reconcile with the real value after the echo window
                onPointerUp={() => setTimeout(() => void refresh(), 500)}
                aria-label={t("tray.volume.systemVolume")}
              />
              <span className={styles.value}>{audio.volume}%</span>
            </div>
          </section>
        )}

        {mic && hasMic && (
          <section className={styles.section}>
            <div className={styles.sectionLabel}>
              {mic.source ? t("tray.volume.micDevice", { device: mic.source }) : t("tray.volume.mic")}
            </div>
            {picker("source", t("tray.volume.input"))}
            <div className={styles.row}>
              <button
                className={`${styles.iconBtn} ${mic.muted ? styles.iconBtnActive : ""}`}
                onClick={() => setMicMuted(!mic.muted)}
                disabled={!canSetMic}
                title={mic.muted ? t("tray.volume.micOn") : t("tray.volume.micMute")}
                aria-pressed={mic.muted}
                data-mic-toggle
              >
                <MicGlyph muted={mic.muted} />
              </button>
              {mic.volume !== null && (
                <>
                  <input
                    type="range" min={0} max={100} value={mic.volume}
                    className={styles.slider}
                    disabled={!canSetMic}
                    onChange={(e) => setMicVolume(Number(e.target.value))}
                    onPointerUp={() => setTimeout(() => void refresh(), 500)}
                    aria-label={t("tray.volume.inputLevel")}
                    data-mic-slider
                  />
                  <span className={styles.value}>{mic.volume}%</span>
                </>
              )}
            </div>
          </section>
        )}

        {hasPrivacy && (privacy?.mic?.in_use || privacy?.camera?.in_use) && (
          <section className={styles.section}>
            <div className={styles.sectionLabel}>{t("tray.volume.inUse")}</div>
            {privacy?.mic?.in_use && (
              <div className={styles.row} data-privacy="mic">
                <span aria-hidden="true"><MicGlyph muted={false} /></span>
                <span>{inUseText(t, t("tray.volume.mic"), privacy.mic.apps)}</span>
              </div>
            )}
            {privacy?.camera?.in_use && (
              <div className={styles.row} data-privacy="camera">
                <span aria-hidden="true">📷</span>
                <span>{inUseText(t, t("tray.volume.camera"), privacy.camera.apps)}</span>
              </div>
            )}
          </section>
        )}

        <section className={styles.section}>
          <div className={styles.sectionLabel}>{t("tray.volume.browserAudio")}</div>
          <div className={styles.row}>
            <span aria-hidden="true"><VolumeGlyph level={pageVolume} muted={pageVolume === 0} /></span>
            <input
              type="range" min={0} max={100} value={pageVolume}
              className={styles.slider}
              onChange={(e) => setPageVolume(Number(e.target.value))}
              aria-label={t("tray.volume.browserVolume")}
            />
            <span className={styles.value}>{pageVolume}%</span>
          </div>
          {!hasSet && (
            <div className={styles.muted}>
              {t("tray.volume.needsCompanion")}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * Sentence for the privacy row. Windows names the programs accessing the
 * device, other platforms may only report "yes, something is accessing it" —
 * then we keep the short sentence instead of empty parentheses.
 */
function inUseText(t: TFunction, was: string, apps?: string[]): string {
  if (!apps || apps.length === 0) return t("tray.volume.inUseBy.none", { what: was });
  if (apps.length <= 2) return t("tray.volume.inUseBy.apps", { what: was, apps: apps.join(", ") });
  return t("tray.volume.inUseBy.more", {
    what: was, apps: apps.slice(0, 2).join(", "), count: apps.length - 2,
  });
}
