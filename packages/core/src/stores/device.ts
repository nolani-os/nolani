import { create } from "zustand";
import {
  getNativeDevice,
  DEVICE_EVENT,
  type BridgeDeviceState,
  type BridgeMount,
  type BridgeWifiNetwork,
  type BridgeBtDevice,
  type BridgeAudioDevice,
  type BridgePrivacy,
  type DeviceCap,
  type DeviceEventDetail,
} from "../device/bridge";

/**
 * Device state of the LOCAL device (Quick Settings).
 *
 * Sources, depending on the environment:
 *  - Companion bridge (window.ClaraOSNative.device) → real system values
 *  - Web facts as graceful degradation: navigator.getBattery (Chromium),
 *    online/offline, page volume (localStorage "claraos-volume")
 *
 * Important — slider discipline:
 *  - Write optimistically (store immediately), IPC trailing-debounced (120 ms)
 *    — a 20-step drag must not produce 20 IPC calls.
 *  - Echo suppression: after a local write, incoming events for the same
 *    section are dropped for 400 ms — otherwise an event carrying a stale
 *    value yanks the slider back mid-drag.
 * Both mechanisms live outside React and are covered by E2E tests
 * (tray_quick_settings_e2e).
 *
 * Deliberately NOT persisted: everything here is live device state.
 */

export interface DeviceAudio { volume: number; muted: boolean; sink?: string }
export interface DeviceBattery {
  percent: number;
  charging: boolean;
  timeToEmptyMin: number | null;
  devices: { name: string; percent: number }[];
}
export interface DeviceMount {
  mount: string; label: string; totalGb: number; freeGb: number; removable: boolean;
}
export interface DeviceWifi { enabled: boolean; connected: string | null; signal: number | null }
export interface DeviceBluetooth { enabled: boolean; connected: { address: string; name: string }[] }
/** The DEVICE's microphone (Android: device-wide mute, not just the page). */
export interface DeviceMic { muted: boolean; volume: number | null; source: string | null }

export interface DeviceStore {
  /** A companion with device control is present (coarse negotiation step). */
  bridgeAvailable: boolean;
  /** Fine-grained caps of THIS device (empty in a plain browser). */
  caps: DeviceCap[];
  ready: boolean;
  online: boolean;

  pageVolume: number;
  audio: DeviceAudio | null;
  brightness: number | null;
  battery: DeviceBattery | null;
  storage: DeviceMount[] | null;
  wifi: DeviceWifi | null;
  bluetooth: DeviceBluetooth | null;
  mic: DeviceMic | null;
  privacy: BridgePrivacy | null;
  wifiNetworks: BridgeWifiNetwork[];
  btDevices: BridgeBtDevice[];
  audioDevices: BridgeAudioDevice[];
  scanning: boolean;

  init: () => void;
  refresh: () => Promise<void>;
  hasCap: (c: DeviceCap) => boolean;

  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setBrightness: (v: number) => void;
  setPageVolume: (v: number) => void;
  setWifiEnabled: (on: boolean) => void;
  connectWifi: (ssid: string, psk?: string) => Promise<{ ok: boolean; error?: string }>;
  scanWifi: () => Promise<void>;
  setBluetoothEnabled: (on: boolean) => void;
  setMicMuted: (m: boolean) => void;
  setMicVolume: (v: number) => void;
  loadAudioDevices: () => Promise<void>;
  setDefaultAudioDevice: (kind: "sink" | "source", id: string) => Promise<void>;
  connectBt: (address: string, disconnect?: boolean) => Promise<{ ok: boolean; error?: string }>;
  loadBtDevices: () => Promise<void>;
}

// ── Debounce/echo machinery (outside React, unit-testable) ──────────────────

const ECHO_WINDOW_MS = 400;
const DEBOUNCE_MS = 120;

const localWriteTs: Record<string, number> = {};
const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const pendingPayload: Record<string, Record<string, unknown>> = {};

/** Records the local write time — incoming events for the section are dropped
 *  within the echo window. Exported for E2E/unit tests. */
export function noteLocalWrite(section: string, now = Date.now()): void {
  localWriteTs[section] = now;
}

export function isEchoSuppressed(section: string, now = Date.now()): boolean {
  return now - (localWriteTs[section] ?? 0) < ECHO_WINDOW_MS;
}

function debouncedSet(section: "audio" | "brightness" | "mic", payload: Record<string, unknown>): void {
  noteLocalWrite(section);
  pendingPayload[section] = { ...pendingPayload[section], ...payload };
  if (debounceTimers[section]) clearTimeout(debounceTimers[section]);
  debounceTimers[section] = setTimeout(() => {
    const body = pendingPayload[section];
    delete pendingPayload[section];
    noteLocalWrite(section); // echo window starts at the actual IPC call
    getNativeDevice()?.set(section, body).catch(() => {
      // transient — the next refresh() fetches the truth
    });
  }, DEBOUNCE_MS);
}

function readStoredPageVolume(): number {
  try {
    const stored = Number(localStorage.getItem("claraos-volume") ?? "75");
    return Number.isFinite(stored) ? Math.min(100, Math.max(0, stored)) : 75;
  } catch {
    return 75;
  }
}

function mapMounts(raw: BridgeMount[] | undefined): DeviceMount[] {
  return (raw ?? []).map((m) => ({
    mount: m.mount,
    label: m.label ?? m.mount,
    totalGb: m.total_gb,
    freeGb: m.free_gb,
    removable: m.removable,
  }));
}

function applyBridgeState(st: BridgeDeviceState, set: (p: Partial<DeviceStore>) => void): void {
  set({
    caps: st.caps ?? [],
    audio: st.audio ? { volume: st.audio.volume, muted: st.audio.muted, sink: st.audio.sink } : null,
    brightness: st.brightness ? st.brightness.level : null,
    battery: st.battery
      ? {
          percent: st.battery.percent,
          charging: st.battery.charging,
          timeToEmptyMin: st.battery.time_to_empty_min || null,
          devices: st.battery.devices ?? [],
        }
      : null,
    storage: st.storage ? mapMounts(st.storage) : null,
    wifi: st.wifi
      ? { enabled: st.wifi.enabled, connected: st.wifi.connected ?? null, signal: st.wifi.signal ?? null }
      : null,
    bluetooth: st.bluetooth
      ? { enabled: st.bluetooth.enabled, connected: st.bluetooth.connected ?? [] }
      : null,
    privacy: st.privacy ?? null,
    mic: st.mic
      ? { muted: st.mic.muted, volume: st.mic.volume ?? null, source: st.mic.source ?? null }
      : null,
  });
}

let initialized = false;

export const useDeviceStore = create<DeviceStore>()((set, get) => ({
  bridgeAvailable: false,
  caps: [],
  ready: false,
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  pageVolume: readStoredPageVolume(),
  audio: null,
  brightness: null,
  battery: null,
  storage: null,
  wifi: null,
  bluetooth: null,
  mic: null,
  privacy: null,
  wifiNetworks: [],
  audioDevices: [],
  btDevices: [],
  scanning: false,

  init: () => {
    if (initialized) return;
    initialized = true;

    const native = getNativeDevice();
    set({ bridgeAvailable: native !== null });

    window.addEventListener("online", () => set({ online: true }));
    window.addEventListener("offline", () => set({ online: false }));

    if (native) {
      // Live events from the daemon (coalesced >=500 ms, contract in control-api.md)
      window.addEventListener(DEVICE_EVENT, (e) => {
        const detail = (e as CustomEvent<DeviceEventDetail>).detail;
        if (!detail?.section) return;
        if (isEchoSuppressed(detail.section)) return; // do not yank the slider back
        const s = detail.state as never;
        switch (detail.section) {
          case "audio":
            set({ audio: s });
            break;
          case "brightness":
            set({ brightness: (s as { level: number }).level });
            break;
          case "battery": {
            const b = s as DeviceBattery & { time_to_empty_min?: number };
            set({
              battery: {
                percent: b.percent,
                charging: b.charging,
                timeToEmptyMin: b.time_to_empty_min || null,
                devices: b.devices ?? [],
              },
            });
            break;
          }
          case "storage":
            set({ storage: mapMounts(s as BridgeMount[]) });
            break;
          case "wifi":
            set({ wifi: s });
            break;
          case "bluetooth":
            set({ bluetooth: s });
            break;
          case "privacy":
            set({ privacy: s as BridgePrivacy });
            break;
          case "mic":
            set({ mic: s });
            break;
        }
      });
      void get().refresh();
      // Safety net: if events get lost (daemon restart), a low-frequency poll
      // brings back the truth.
      setInterval(() => void get().refresh(), 30_000);
    } else {
      // Web degradation: battery indicator where the browser provides it (Chromium).
      // Deliberately WITHOUT the "battery" cap — caps remain the companion's truth;
      // the UI shows indicators when data exists, and controls only with caps.
      type BatteryManager = {
        level: number; charging: boolean;
        addEventListener: (t: string, fn: () => void) => void;
      };
      const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
      nav.getBattery?.().then((bm) => {
        const apply = () =>
          set({
            battery: {
              percent: Math.round(bm.level * 100),
              charging: bm.charging,
              timeToEmptyMin: null,
              devices: [],
            },
          });
        apply();
        bm.addEventListener("levelchange", apply);
        bm.addEventListener("chargingchange", apply);
      }).catch(() => {});
    }
    set({ ready: true });
  },

  refresh: async () => {
    const native = getNativeDevice();
    if (!native) return;
    try {
      const st = await native.getState();
      applyBridgeState(st, set);
    } catch {
      // Daemon unreachable → keep the last values; tiles show their disabled
      // state via bridgeAvailable/caps.
    }
  },

  hasCap: (c) => get().caps.includes(c),

  setVolume: (v) => {
    const clamped = Math.min(100, Math.max(0, Math.round(v)));
    const cur = get().audio;
    set({ audio: { ...(cur ?? { muted: false }), volume: clamped } });
    debouncedSet("audio", { volume: clamped });
  },

  setMuted: (m) => {
    const cur = get().audio;
    set({ audio: { ...(cur ?? { volume: 50 }), muted: m } });
    debouncedSet("audio", { muted: m });
  },

  setBrightness: (v) => {
    const clamped = Math.min(100, Math.max(0, Math.round(v)));
    set({ brightness: clamped });
    debouncedSet("brightness", { level: clamped });
  },

  setPageVolume: (v) => {
    const clamped = Math.min(100, Math.max(0, Math.round(v)));
    set({ pageVolume: clamped });
    try {
      localStorage.setItem("claraos-volume", String(clamped));
    } catch { /* storage full/blocked — the runtime value still applies */ }
  },

  setWifiEnabled: (on) => {
    const cur = get().wifi;
    set({ wifi: { ...(cur ?? { connected: null, signal: null }), enabled: on } });
    noteLocalWrite("wifi");
    getNativeDevice()?.set("wifi", { enabled: on }).catch(() => void get().refresh());
  },

  connectWifi: async (ssid, psk) => {
    const native = getNativeDevice();
    if (!native) return { ok: false, error: "keine Companion" };
    try {
      await native.connect("wifi", psk ? { ssid, psk } : { ssid });
      void get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  scanWifi: async () => {
    const native = getNativeDevice();
    if (!native) return;
    set({ scanning: true });
    try {
      const nets = (await native.get("wifi/networks")) as BridgeWifiNetwork[];
      set({ wifiNetworks: Array.isArray(nets) ? nets : [] });
    } catch { /* scan failed — keep the old list */ }
    set({ scanning: false });
  },

  // The level is dragged => debounce as with volume. Muting, by contrast, is a
  // single click: set optimistically so the tile flips immediately, and sent
  // out directly without debounce.
  setMicVolume: (v) => {
    const cur = get().mic;
    set({ mic: { muted: cur?.muted ?? false, volume: v, source: cur?.source ?? null } });
    debouncedSet("mic", { volume: v });
  },

  loadAudioDevices: async () => {
    const native = getNativeDevice();
    if (!native) return;
    try {
      const list = (await native.get("audio/devices")) as BridgeAudioDevice[];
      set({ audioDevices: Array.isArray(list) ? list : [] });
    } catch {
      set({ audioDevices: [] });
    }
  },

  setDefaultAudioDevice: async (kind, id) => {
    const native = getNativeDevice();
    if (!native) return;
    noteLocalWrite("audio");
    try {
      await native.set("audio/default", kind === "sink" ? { sink: id } : { source: id });
    } finally {
      // Switching changes volume AND microphone — re-read both instead of
      // trusting the optimistic display.
      await get().refresh();
      await get().loadAudioDevices();
    }
  },

  setMicMuted: (m) => {
    const cur = get().mic;
    set({ mic: { muted: m, volume: cur?.volume ?? null, source: cur?.source ?? null } });
    noteLocalWrite("mic");
    getNativeDevice()?.set("mic", { muted: m }).catch(() => void get().refresh());
  },

  setBluetoothEnabled: (on) => {
    const cur = get().bluetooth;
    set({ bluetooth: { ...(cur ?? { connected: [] }), enabled: on } });
    noteLocalWrite("bluetooth");
    getNativeDevice()?.set("bluetooth", { enabled: on }).catch(() => void get().refresh());
  },

  loadBtDevices: async () => {
    const native = getNativeDevice();
    if (!native) return;
    try {
      const devs = (await native.get("bluetooth/devices")) as BridgeBtDevice[];
      set({ btDevices: Array.isArray(devs) ? devs : [] });
    } catch { /* keep the list */ }
  },

  connectBt: async (address, disconnect) => {
    const native = getNativeDevice();
    if (!native) return { ok: false, error: "keine Companion" };
    try {
      await native.connect("bluetooth", disconnect ? { address, disconnect: true } : { address });
      try {
        const devs = (await native.get("bluetooth/devices")) as BridgeBtDevice[];
        set({ btDevices: Array.isArray(devs) ? devs : [] });
      } catch { /* list is stale — refresh() below corrects the rest */ }
      void get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
}));
