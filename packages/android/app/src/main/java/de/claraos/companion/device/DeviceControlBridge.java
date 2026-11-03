package de.claraos.companion.device;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.ContentObserver;
import android.media.AudioManager;
import android.net.Uri;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.StatFs;
import android.provider.Settings;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Device backend of the Android companion — contract: protocol/control-api.md,
 * section "Android companion". Same DeviceState JSON as clarad (snake_case!),
 * so the shell side (device/bridge.ts) stays identical.
 *
 * OS limits (Android ≥10): an app can no longer toggle Wi-Fi/BT — openPanel()
 * exists for that. Writing brightness only after the WRITE_SETTINGS grant
 * (requestWriteSettings() opens the system dialog).
 *
 * Events: coalesced per section for ≥500 ms (like the desktop daemon), dispatched
 * as a CustomEvent via evaluateJavascript. All values go through org.json —
 * SSIDs are radio input and must never go raw into an eval string.
 */
public final class DeviceControlBridge {

    private static final String TAG = "ClaraDevice";
    private static final long COALESCE_MS = 500;
    private static final long VOLUME_POLL_MS = 3000;

    private final Context ctx;
    private final WebView webView;
    private final String shellOrigin;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager audio;

    /** Sections with an unreported change (coalescing buffer, main thread only). */
    private final Map<String, JSONObject> dirty = new HashMap<>();
    private boolean flushScheduled = false;
    private int lastPolledVolume = -1;
    /** -2 = never read (0/1 = off/on, -1 = state not determinable). */
    private int lastPolledBt = -2;
    private int lastPolledMic = -2;
    private boolean btQuelleGemeldet = false;
    private BroadcastReceiver batteryReceiver, wifiReceiver, btReceiver;
    private ContentObserver brightnessObserver;

    /** @param shellOrigin only a top page of this origin gets change events (null: none) */
    public DeviceControlBridge(Context ctx, WebView webView, String shellOrigin) {
        this.shellOrigin = shellOrigin;
        this.ctx = ctx.getApplicationContext();
        this.webView = webView;
        this.audio = (AudioManager) this.ctx.getSystemService(Context.AUDIO_SERVICE);
    }

    // ── State JSON (synchronous, wrapped into promises by the JS shim) ─────────

    /** Full snapshot incl. fine-grained caps — structure like clarad's DeviceState. */
    public String stateJson() {
        try {
            JSONObject st = new JSONObject();
            JSONArray caps = new JSONArray();

            JSONObject a = audioState();
            if (a != null) { st.put("audio", a); caps.put("audio"); caps.put("audio.set"); }

            JSONObject b = brightnessState();
            if (b != null) {
                st.put("brightness", b);
                caps.put("brightness");
                if (Settings.System.canWrite(ctx)) caps.put("brightness.set");
            }

            JSONObject bat = batteryState();
            if (bat != null) { st.put("battery", bat); caps.put("battery"); }

            JSONArray mounts = storageState();
            if (mounts != null) { st.put("storage", mounts); caps.put("storage"); }

            JSONObject w = wifiState();
            if (w != null) { st.put("wifi", w); caps.put("wifi"); }

            JSONObject bt = bluetoothState();
            if (bt != null) { st.put("bluetooth", bt); caps.put("bluetooth"); }

            JSONObject mic = micState();
            if (mic != null) { st.put("mic", mic); caps.put("mic"); caps.put("mic.set"); }

            st.put("caps", caps);
            return st.toString();
        } catch (Exception e) {
            Log.e(TAG, "stateJson failed", e);
            return "{\"caps\":[]}";
        }
    }

    /**
     * Sets a section. Returns the new section as JSON; throws on an unknown
     * section/invalid input (the shim turns that into a promise rejection).
     * wifi/bluetooth deliberately refuse (OS limit) — the UI uses openPanel.
     */
    public String set(String section, String payloadJson) throws Exception {
        JSONObject p = new JSONObject(payloadJson == null ? "{}" : payloadJson);
        switch (section) {
            case "audio": {
                if (p.has("volume")) {
                    int v = p.getInt("volume");
                    if (v < 0 || v > 100) throw new IllegalArgumentException("volume ausserhalb 0..100");
                    int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                    audio.setStreamVolume(AudioManager.STREAM_MUSIC,
                            Math.round(v * max / 100f), 0);
                }
                if (p.has("muted")) {
                    audio.adjustStreamVolume(AudioManager.STREAM_MUSIC,
                            p.getBoolean("muted") ? AudioManager.ADJUST_MUTE
                                                  : AudioManager.ADJUST_UNMUTE, 0);
                }
                markDirtyLater("audio");
                JSONObject a = audioState();
                return a == null ? "{}" : a.toString();
            }
            case "brightness": {
                if (!Settings.System.canWrite(ctx))
                    throw new SecurityException("WRITE_SETTINGS fehlt — requestPermission('brightness')");
                int lvl = p.getInt("level");
                if (lvl < 0 || lvl > 100) throw new IllegalArgumentException("level ausserhalb 0..100");
                // Switch to manual first, otherwise adaptive brightness overrides immediately.
                Settings.System.putInt(ctx.getContentResolver(),
                        Settings.System.SCREEN_BRIGHTNESS_MODE,
                        Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL);
                Settings.System.putInt(ctx.getContentResolver(),
                        Settings.System.SCREEN_BRIGHTNESS, Math.round(lvl * 255 / 100f));
                markDirtyLater("brightness");
                JSONObject b = brightnessState();
                return b == null ? "{}" : b.toString();
            }
            case "mic": {
                if (audio == null) throw new UnsupportedOperationException("kein AudioManager");
                boolean m = p.getBoolean("muted");
                audio.setMicrophoneMute(m);
                markDirtyLater("mic");
                JSONObject o = micState();
                return o == null ? "{}" : o.toString();
            }
            case "wifi":
            case "bluetooth":
                throw new UnsupportedOperationException(
                        "Android erlaubt Apps kein " + section + "-Schalten — openPanel nutzen");
            default:
                throw new IllegalArgumentException("unbekannte Sektion: " + section);
        }
    }

    /** Open the system UI — the Android substitute for wifi/bt toggles. Allowlist! */
    public void openPanel(String name) {
        Intent i;
        switch (name == null ? "" : name) {
            case "wifi": i = new Intent(Settings.Panel.ACTION_WIFI); break;
            case "internet": i = new Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY); break;
            case "volume": i = new Intent(Settings.Panel.ACTION_VOLUME); break;
            case "bluetooth": i = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS); break;
            case "display": i = new Intent(Settings.ACTION_DISPLAY_SETTINGS); break;
            case "tethering":
                // An app cannot toggle the hotspot (reserved for the system/
                // carrier) — only a jump into settings is possible. The direct
                // page is named differently per vendor, hence a try with a
                // fallback to the network overview.
                i = new Intent().setClassName("com.android.settings",
                        "com.android.settings.TetherSettings");
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(i);
                    return;
                } catch (Exception ignored) {
                    i = new Intent(Settings.ACTION_WIRELESS_SETTINGS);
                }
                break;
            case "privacy": i = new Intent(Settings.ACTION_PRIVACY_SETTINGS); break;
            default:
                Log.w(TAG, "openPanel: unbekanntes Panel " + name);
                return;
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (Exception e) {
            Log.e(TAG, "openPanel " + name + " failed", e);
        }
    }

    /** Trigger the WRITE_SETTINGS grant (brightness). The shim checks granted after returning. */
    public void requestWriteSettings() {
        Intent i = new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS,
                Uri.parse("package:" + ctx.getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (Exception e) {
            Log.e(TAG, "requestWriteSettings failed", e);
        }
    }

    public boolean canWriteSettings() {
        return Settings.System.canWrite(ctx);
    }

    // ── Sections ──────────────────────────────────────────────────────────────

    private JSONObject audioState() {
        try {
            int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            int cur = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
            JSONObject o = new JSONObject();
            o.put("volume", max > 0 ? Math.round(cur * 100f / max) : 0);
            o.put("muted", audio.isStreamMute(AudioManager.STREAM_MUSIC));
            o.put("sink", "Medien");
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    private JSONObject brightnessState() {
        try {
            // 0..255 is the documented range; some vendors use more —
            // then we clamp to 100 instead of scaling wrongly.
            int raw = Settings.System.getInt(ctx.getContentResolver(),
                    Settings.System.SCREEN_BRIGHTNESS);
            JSONObject o = new JSONObject();
            o.put("level", Math.min(100, Math.round(raw * 100 / 255f)));
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    private JSONObject batteryState() {
        try {
            BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
            int pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            if (pct <= 0) return null;
            Intent sticky = ctx.registerReceiver(null,
                    new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            int status = sticky == null ? -1
                    : sticky.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING
                    || status == BatteryManager.BATTERY_STATUS_FULL;
            JSONObject o = new JSONObject();
            o.put("percent", pct);
            o.put("charging", charging);
            o.put("time_to_empty_min", 0);
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    private JSONArray storageState() {
        try {
            StatFs fs = new StatFs(Environment.getDataDirectory().getPath());
            double totalGb = fs.getTotalBytes() / 1e9;
            double freeGb = fs.getAvailableBytes() / 1e9;
            JSONObject o = new JSONObject();
            o.put("mount", "/data");
            o.put("label", "Gerätespeicher");
            o.put("total_gb", Math.round(totalGb * 10) / 10.0);
            o.put("free_gb", Math.round(freeGb * 10) / 10.0);
            o.put("removable", false);
            return new JSONArray().put(o);
        } catch (Exception e) {
            return null;
        }
    }

    private JSONObject wifiState() {
        try {
            WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return null;
            JSONObject o = new JSONObject();
            o.put("enabled", wm.isWifiEnabled());
            // SSID needs location permission + location enabled — degrades silently.
            try {
                WifiInfo info = wm.getConnectionInfo();
                String ssid = info == null ? null : info.getSSID();
                if (ssid != null && !"<unknown ssid>".equals(ssid)) {
                    o.put("connected", ssid.replaceAll("^\"|\"$", ""));
                    // RSSI −100..−55 dBm → 0..100 % (rough, like Android quick settings)
                    int pctSignal = Math.max(0, Math.min(100, 2 * (info.getRssi() + 100)));
                    o.put("signal", pctSignal);
                }
            } catch (Exception ignored) { /* display without SSID */ }
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * IMPORTANT: this section used to disappear silently on every modern device.
     *
     * `BluetoothAdapter.isEnabled()` requires the runtime permission
     * BLUETOOTH_CONNECT from API 31 on. The manifest only declared the legacy
     * permission BLUETOOTH with maxSdkVersion=30 — so on current devices the
     * app has NO Bluetooth permission at all. The SecurityException ended up
     * in the catch, the cap vanished, and the BT tile was invisible. Confirmed
     * on a device: `dumpsys package` lists only ACCESS_WIFI_STATE.
     *
     * The state now comes from `Settings.Global.bluetooth_on` — the switch
     * the system persists itself. Reading it needs no permission, and for a
     * status tile that jumps into the system UI on tap anyway, that is
     * entirely sufficient.
     *
     * Note: BLUETOOTH_CONNECT is deliberately NOT requested: it is a
     * "Nearby devices" runtime prompt and would only yield device names the
     * mobile UI does not show today. If a device list is added later, the
     * prompt moves behind requestPermission("bluetooth") — like the brightness.
     */
    private JSONObject bluetoothState() {
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter ad = bm == null ? null : bm.getAdapter();
        if (ad == null) return null; // no BT radio in the device → cap rightly missing

        Boolean enabled = null;
        String quelle = "Adapter";
        // If the permission is present after all (legacy Android ≤30 or a
        // later extension), the adapter is the more accurate source.
        try {
            enabled = ad.isEnabled();
        } catch (SecurityException ignored) {
            // expected on API 31+ without BLUETOOTH_CONNECT
        } catch (Exception ignored) {
        }
        if (enabled == null) {
            quelle = "Settings.Global";
            int v = Settings.Global.getInt(ctx.getContentResolver(), "bluetooth_on", -1);
            if (v < 0) return null;
            enabled = v == 1;
        }
        // Log once per app start WHICH source answered. Without this line it
        // is impossible to tell from outside whether the section is missing or
        // silently runs on the fallback path — exactly this invisibility hid
        // the bug for months.
        if (!btQuelleGemeldet) {
            btQuelleGemeldet = true;
            Log.i(TAG, "Bluetooth-Zustand aus " + quelle + ": " + enabled);
        }
        try {
            JSONObject o = new JSONObject();
            o.put("enabled", enabled);
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /** State value for the poll comparison (-1 = unknown). */
    private int bluetoothEnabledFlag() {
        JSONObject o = bluetoothState();
        return o == null ? -1 : (o.optBoolean("enabled") ? 1 : 0);
    }

    /**
     * Microphone mute — device-wide, not just for this app
     * (`MODIFY_AUDIO_SETTINGS` in the manifest). That is exactly what you
     * expect from a mic tile: it should cut off the microphone, not just
     * mute ClaraOS.
     */
    private JSONObject micState() {
        try {
            if (audio == null) return null;
            JSONObject o = new JSONObject();
            o.put("muted", audio.isMicrophoneMute());
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    private int micMutedFlag() {
        JSONObject o = micState();
        return o == null ? -1 : (o.optBoolean("muted") ? 1 : 0);
    }

    // ── Live events (receiver/observer → coalesced CustomEvent dispatch) ─────

    /** Call in onResume/after building the WebView. Idempotent. */
    public void startWatching() {
        if (batteryReceiver != null) return;

        batteryReceiver = receiver(() -> markDirty("battery"));
        ctx.registerReceiver(batteryReceiver, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));

        wifiReceiver = receiver(() -> markDirty("wifi"));
        IntentFilter wf = new IntentFilter(WifiManager.WIFI_STATE_CHANGED_ACTION);
        wf.addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION);
        ctx.registerReceiver(wifiReceiver, wf);

        // Kept for legacy Android (≤30), where the broadcast still arrives.
        // From API 31 on it is silent without BLUETOOTH_CONNECT — the
        // runnable below polls the state instead.
        btReceiver = receiver(() -> markDirty("bluetooth"));
        ctx.registerReceiver(btReceiver, new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED));

        brightnessObserver = new ContentObserver(main) {
            @Override public void onChange(boolean selfChange) { markDirty("brightness"); }
        };
        ctx.getContentResolver().registerContentObserver(
                Settings.System.getUriFor(Settings.System.SCREEN_BRIGHTNESS),
                false, brightnessObserver);

        // Volume has no public broadcast → 3 s poll with diff
        // (same pattern as clarad's wpctl poller).
        main.postDelayed(volumePoll, VOLUME_POLL_MS);
    }

    public void stopWatching() {
        try { if (batteryReceiver != null) ctx.unregisterReceiver(batteryReceiver); } catch (Exception ignored) {}
        try { if (wifiReceiver != null) ctx.unregisterReceiver(wifiReceiver); } catch (Exception ignored) {}
        try { if (btReceiver != null) ctx.unregisterReceiver(btReceiver); } catch (Exception ignored) {}
        if (brightnessObserver != null)
            ctx.getContentResolver().unregisterContentObserver(brightnessObserver);
        batteryReceiver = wifiReceiver = btReceiver = null;
        brightnessObserver = null;
        main.removeCallbacks(volumePoll);
    }

    private final Runnable volumePoll = new Runnable() {
        @Override public void run() {
            try {
                int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                int pct = max > 0
                        ? Math.round(audio.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max)
                        : 0;
                if (lastPolledVolume != -1 && pct != lastPolledVolume) markDirty("audio");
                lastPolledVolume = pct;
            } catch (Exception ignored) {}
            // Note: Bluetooth must be polled too: the broadcast
            // ACTION_STATE_CHANGED is only delivered WITH BLUETOOTH_CONNECT
            // from API 31 on. Without this diff the tile would stay at the
            // state from opening — the receiver never fires there.
            try {
                int bt = bluetoothEnabledFlag();
                if (lastPolledBt != -2 && bt != lastPolledBt) markDirty("bluetooth");
                lastPolledBt = bt;
            } catch (Exception ignored) {}
            // Mic mute has no broadcast either; it can change from outside
            // (telephony, system tile) and must then be reflected in the
            // shade.
            try {
                int mic = micMutedFlag();
                if (lastPolledMic != -2 && mic != lastPolledMic) markDirty("mic");
                lastPolledMic = mic;
            } catch (Exception ignored) {}
            main.postDelayed(this, VOLUME_POLL_MS);
        }
    };

    private BroadcastReceiver receiver(Runnable onChange) {
        return new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) { onChange.run(); }
        };
    }

    private void markDirty(String section) {
        main.post(() -> {
            JSONObject state = sectionState(section);
            if (state == null) return;
            dirty.put(section, state);
            if (!flushScheduled) {
                flushScheduled = true;
                main.postDelayed(this::flushDirty, COALESCE_MS);
            }
        });
    }

    /** After our own sets: report the change only AFTER coalescing (shell's echo window). */
    private void markDirtyLater(String section) {
        markDirty(section);
    }

    private void flushDirty() {
        flushScheduled = false;
        if (dirty.isEmpty()) return;
        Map<String, JSONObject> batch = new HashMap<>(dirty);
        dirty.clear();
        // Device state (Wi-Fi name, battery …) only goes to the paired shell, never to
        // another page that happens to be loaded in the WebView.
        String page = webView.getUrl();
        if (shellOrigin == null || page == null
                || !shellOrigin.equals(de.claraos.companion.ProvisioningClient.originOf(page))) {
            return;
        }
        for (Map.Entry<String, JSONObject> e : batch.entrySet()) {
            try {
                JSONObject detail = new JSONObject();
                detail.put("section", e.getKey());
                detail.put("state", e.getValue());
                // org.json has encoded it — the string is eval-safe.
                webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('claraos:device-changed',{detail:"
                                + detail + "}))", null);
            } catch (Exception ex) {
                Log.e(TAG, "event dispatch failed", ex);
            }
        }
    }

    private JSONObject sectionState(String section) {
        switch (section) {
            case "audio": return audioState();
            case "brightness": return brightnessState();
            case "battery": return batteryState();
            case "wifi": return wifiState();
            case "bluetooth": return bluetoothState();
            case "mic": return micState();
            default: return null;
        }
    }
}
