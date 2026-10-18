import { useEffect, useState } from "react";
import { useDeviceStore } from "@claraos/core";
import { WifiGlyph, BluetoothGlyph } from "./icons";
import styles from "./TrayPopover.module.css";

/**
 * Connectivity flyout: Wi-Fi + Bluetooth in ONE popover (modelled on the KDE
 * network applet, 360 px). Sections only appear with the matching capability —
 * those are provided by Companion 0.5.x; the UI is prepared for them and
 * tested end-to-end against the bridge mock.
 *
 * Deliberately NOT here (v1): WPA-Enterprise, hidden SSIDs, pairing PINs —
 * for those the footer points to the device's system settings.
 */
export function ConnectivityTray({ onClose }: { onClose: () => void }) {
  const wifi = useDeviceStore((s) => s.wifi);
  const bluetooth = useDeviceStore((s) => s.bluetooth);
  const caps = useDeviceStore((s) => s.caps);
  const wifiNetworks = useDeviceStore((s) => s.wifiNetworks);
  const btDevices = useDeviceStore((s) => s.btDevices);
  const scanning = useDeviceStore((s) => s.scanning);
  const setWifiEnabled = useDeviceStore((s) => s.setWifiEnabled);
  const connectWifi = useDeviceStore((s) => s.connectWifi);
  const scanWifi = useDeviceStore((s) => s.scanWifi);
  const setBluetoothEnabled = useDeviceStore((s) => s.setBluetoothEnabled);
  const connectBt = useDeviceStore((s) => s.connectBt);
  const loadBtDevices = useDeviceStore((s) => s.loadBtDevices);

  const hasWifi = caps.includes("wifi");
  const hasBt = caps.includes("bluetooth");
  const [pskFor, setPskFor] = useState<string | null>(null);
  const [psk, setPsk] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // On open: trigger a Wi-Fi scan + load paired Bluetooth devices
  useEffect(() => {
    if (hasWifi && wifi?.enabled) void scanWifi();
    if (hasBt && bluetooth?.enabled) void loadBtDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasWifi, hasBt, wifi?.enabled, bluetooth?.enabled]);

  const doConnect = async (ssid: string, needsPsk: boolean, known: boolean) => {
    setError(null);
    if (needsPsk && !known) {
      setPskFor(ssid);
      setPsk("");
      return;
    }
    setBusy(true);
    const res = await connectWifi(ssid);
    setBusy(false);
    if (!res.ok) setError(res.error ?? "Verbindung fehlgeschlagen");
  };

  const submitPsk = async () => {
    if (!pskFor || !psk) return;
    setBusy(true);
    const res = await connectWifi(pskFor, psk);
    setBusy(false);
    if (res.ok) {
      setPskFor(null);
      setPsk("");
    } else {
      setError(res.error ?? "Verbindung fehlgeschlagen");
    }
  };

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={`aeroWidget ${styles.panel}`} role="dialog" aria-label="Verbindungen"
        data-tray-popover="connectivity">
        <div className={styles.header}>
          <span className={styles.title}>Verbindungen</span>
        </div>

        {hasWifi && wifi && (
          <section className={styles.section}>
            <div className={styles.row}>
              <WifiGlyph signal={wifi.signal} off={!wifi.enabled} />
              <span className={styles.rowGrow}>
                WLAN{wifi.connected ? ` — ${wifi.connected}` : ""}
              </span>
              {caps.includes("wifi.set") && (
                <button
                  className={`${styles.toggle} ${wifi.enabled ? styles.toggleOn : ""}`}
                  onClick={() => setWifiEnabled(!wifi.enabled)}
                  role="switch" aria-checked={wifi.enabled} aria-label="WLAN an/aus"
                />
              )}
            </div>
            {wifi.enabled && (
              <>
                {scanning && wifiNetworks.length === 0 && (
                  <div className={styles.muted}>Suche Netzwerke…</div>
                )}
                {wifiNetworks.map((n) => (
                  <div key={n.ssid}>
                    <button
                      className={`${styles.listBtn} ${n.ssid === wifi.connected ? styles.listBtnActive : ""}`}
                      onClick={() => void doConnect(n.ssid, n.secured, n.known)}
                      disabled={busy || !caps.includes("wifi.connect") || n.ssid === wifi.connected}
                    >
                      <WifiGlyph signal={n.signal} />
                      <span className={styles.rowGrow}>{n.ssid}</span>
                      {n.secured && <span aria-label="gesichert">🔒</span>}
                    </button>
                    {pskFor === n.ssid && (
                      <div className={styles.pskForm}>
                        <input
                          type="password" className={styles.pskInput} value={psk}
                          onChange={(e) => setPsk(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") void submitPsk(); }}
                          placeholder="WLAN-Passwort" autoFocus
                        />
                        <button className={styles.pskBtn} onClick={() => void submitPsk()} disabled={busy || !psk}>
                          Verbinden
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </section>
        )}

        {hasBt && bluetooth && (
          <section className={styles.section}>
            <div className={styles.row}>
              <BluetoothGlyph off={!bluetooth.enabled} />
              <span className={styles.rowGrow}>Bluetooth</span>
              {caps.includes("bluetooth.set") && (
                <button
                  className={`${styles.toggle} ${bluetooth.enabled ? styles.toggleOn : ""}`}
                  onClick={() => setBluetoothEnabled(!bluetooth.enabled)}
                  role="switch" aria-checked={bluetooth.enabled} aria-label="Bluetooth an/aus"
                />
              )}
            </div>
            {bluetooth.enabled && btDevices.map((d) => (
              <button
                key={d.address}
                className={`${styles.listBtn} ${d.connected ? styles.listBtnActive : ""}`}
                onClick={() => void connectBt(d.address, d.connected)}
                disabled={busy || !caps.includes("bluetooth.connect")}
                title={d.connected ? "Trennen" : "Verbinden"}
              >
                <BluetoothGlyph />
                <span className={styles.rowGrow}>{d.name}</span>
                {d.connected && <span className={styles.muted}>verbunden</span>}
              </button>
            ))}
          </section>
        )}

        {error && <div className={styles.error}>{error}</div>}

        {!hasWifi && !hasBt && (
          <section className={styles.section}>
            <div className={styles.muted}>
              WLAN- und Bluetooth-Steuerung liefert die ClaraOS-Companion-App.
            </div>
          </section>
        )}
      </div>
    </>
  );
}
