/**
 * Companion device bridge — TS side of the contract in
 * packages/desktop/protocol/control-api.md (section "Bridge contract").
 *
 * `window.ClaraOSNative` is injected by the companion apps (desktop:
 * BRIDGE_JS in main.rs; Android follows with the same contract). Two-step
 * negotiation: `caps` on the bridge object = whether this companion VERSION
 * supports device control at all; `DeviceState.caps` = what this DEVICE can
 * actually do (differs per OS/probe). Old installations without `caps` get
 * no device tiles — `shutdown` stays usable.
 */

/** Fine-grained device caps (DeviceState.caps). Reading and setting are separate. */
export type DeviceCap =
  | "audio" | "audio.set"
  | "brightness" | "brightness.set"
  | "wifi" | "wifi.set" | "wifi.connect"
  | "bluetooth" | "bluetooth.set" | "bluetooth.connect"
  | "mic" | "mic.set"
  | "audio.devices" | "audio.devices.set"
  | "battery" | "storage" | "displays"
  | "privacy";

export interface BridgeAudio { volume: number; muted: boolean; sink?: string }
export interface BridgeBrightness { level: number }
export interface BridgeBattery {
  percent: number;
  charging: boolean;
  time_to_empty_min: number;
  devices?: { name: string; percent: number }[];
}
export interface BridgeMount {
  mount: string; label?: string; total_gb: number; free_gb: number; removable: boolean;
}
export interface BridgeWifi { enabled: boolean; connected?: string; signal?: number }
export interface BridgeBluetooth {
  enabled: boolean;
  connected?: { address: string; name: string }[];
}
/** The DEVICE's microphone (not just the page's). volume/source only on Linux. */
export interface BridgeMic { muted: boolean; volume?: number; source?: string }
/**
 * Privacy indicator: who is accessing the microphone/camera RIGHT NOW?
 * `apps` carries display names, not paths, and is absent when nobody is
 * accessing. A section is missing entirely if the device does not track it
 * (desktop without a camera) — the UI then shows no row for it.
 */
export interface BridgePrivacyUse { in_use: boolean; apps?: string[] }
export interface BridgePrivacy { mic?: BridgePrivacyUse; camera?: BridgePrivacyUse }

/** An output or input device (GET audio/devices). */
export interface BridgeAudioDevice {
  id: string; name: string; kind: "sink" | "source"; default: boolean;
}
export interface BridgeWifiNetwork { ssid: string; signal: number; secured: boolean; known: boolean }
export interface BridgeBtDevice { address: string; name: string; connected: boolean; paired: boolean }

export interface BridgeDeviceState {
  caps: DeviceCap[];
  audio?: BridgeAudio;
  privacy?: BridgePrivacy;
  brightness?: BridgeBrightness;
  battery?: BridgeBattery;
  storage?: BridgeMount[];
  wifi?: BridgeWifi;
  bluetooth?: BridgeBluetooth;
  mic?: BridgeMic;
}

/** System panels the Android companion can open (allowlist in the Java code). */
export type DevicePanel =
  | "wifi" | "internet" | "volume" | "bluetooth" | "display"
  // Apps may not toggle hotspot/tethering (reserved for the system/carrier)
  // — there is only a jump to the panel here, no toggle.
  | "tethering" | "privacy";

export interface ClaraOSNativeDevice {
  getState(): Promise<BridgeDeviceState>;
  set(section: "audio" | "brightness" | "wifi" | "bluetooth" | "mic" | "audio/default",
      payload: Record<string, unknown>): Promise<unknown>;
  get(section: "wifi/networks" | "bluetooth/devices" | "audio/devices"): Promise<unknown>;
  connect(section: "wifi" | "bluetooth", payload: Record<string, unknown>): Promise<{ ok: boolean }>;
  /** Android-only (feature detection): open the system UI — since Android 10
   *  apps may no longer toggle Wi-Fi/BT themselves; the jump replaces the toggle. */
  openPanel?(panel: DevicePanel): void;
  /** Android-only: request a system permission (v1 only "brightness" → WRITE_SETTINGS). */
  requestPermission?(section: "brightness"): Promise<{ granted: boolean }>;
}

export interface ClaraOSNativeBridge {
  version?: string;
  caps?: string[];
  shutdown?: () => void;
  device?: ClaraOSNativeDevice;
  scanDocument?: () => void; // existing Android API
}

/** DOM event for live changes (Tauri: SSE device.changed → w.eval). */
export const DEVICE_EVENT = "claraos:device-changed";
export interface DeviceEventDetail { section: string; state: unknown }

/**
 * Returns the companion's device API — or null (plain browser, old companion,
 * legacy Android). Every access is defensive: the bridge is injected by an
 * init script and may be partial.
 */
export function getNativeDevice(): ClaraOSNativeDevice | null {
  try {
    const native = (window as unknown as { ClaraOSNative?: ClaraOSNativeBridge }).ClaraOSNative;
    if (!native?.caps?.includes("device-control-v1")) return null;
    return native.device ?? null;
  } catch {
    return null;
  }
}
