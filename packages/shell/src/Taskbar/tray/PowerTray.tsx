import { useDeviceStore } from "@claraos/core";
import { BatteryGlyph, BrightnessGlyph } from "./icons";
import styles from "./TrayPopover.module.css";

/**
 * Power flyout — KDE convention "Battery & Brightness":
 * battery level (Companion: UPower/GetSystemPowerStatus; browser fallback:
 * navigator.getBattery) + brightness slider when the brightness.set cap exists.
 */
export function PowerTray({ onClose }: { onClose: () => void }) {
  const battery = useDeviceStore((s) => s.battery);
  const brightness = useDeviceStore((s) => s.brightness);
  const canSetBrightness = useDeviceStore((s) => s.caps.includes("brightness.set"));
  const setBrightness = useDeviceStore((s) => s.setBrightness);
  const refresh = useDeviceStore((s) => s.refresh);

  const timeLabel =
    battery?.timeToEmptyMin && !battery.charging
      ? `noch ~${Math.floor(battery.timeToEmptyMin / 60)}:${String(battery.timeToEmptyMin % 60).padStart(2, "0")} h`
      : null;

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={`aeroWidget ${styles.panel}`} role="dialog" aria-label="Energie"
        data-tray-popover="power">
        <div className={styles.header}>
          <span className={styles.title}>Energie</span>
        </div>

        {battery && (
          <section className={styles.section}>
            <div className={styles.row}>
              <BatteryGlyph percent={battery.percent} charging={battery.charging} />
              <span className={styles.rowGrow}>
                Akku {battery.percent}% {battery.charging ? "— lädt" : ""}
              </span>
              {timeLabel && <span className={styles.muted}>{timeLabel}</span>}
            </div>
            {battery.devices.map((d) => (
              <div key={d.name} className={styles.row}>
                <span className={styles.muted} aria-hidden="true">•</span>
                <span className={styles.rowGrow}>{d.name}</span>
                <span className={styles.value}>{d.percent}%</span>
              </div>
            ))}
          </section>
        )}

        {brightness !== null && canSetBrightness && (
          <section className={styles.section}>
            <div className={styles.sectionLabel}>Bildschirmhelligkeit</div>
            <div className={styles.row}>
              <BrightnessGlyph />
              <input
                type="range" min={0} max={100} value={brightness}
                className={styles.slider}
                onChange={(e) => setBrightness(Number(e.target.value))}
                onPointerUp={() => setTimeout(() => void refresh(), 500)}
                aria-label="Bildschirmhelligkeit"
              />
              <span className={styles.value}>{brightness}%</span>
            </div>
          </section>
        )}

        {!battery && brightness === null && (
          <section className={styles.section}>
            <div className={styles.muted}>
              Keine Energie-Daten verfügbar. Akku-Anzeige und Helligkeit liefert
              die ClaraOS-Companion-App.
            </div>
          </section>
        )}
      </div>
    </>
  );
}
