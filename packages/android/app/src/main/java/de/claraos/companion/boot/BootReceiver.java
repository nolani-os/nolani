package de.claraos.companion.boot;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import de.claraos.companion.push.NtfyPushService;

/**
 * Starts the push service (and with it the app tunnel) without anyone opening the app.
 *
 * Why: up to 0.5.1 the tunnel and the ntfy WebSocket hung exclusively on
 * {@code ShellActivity.onCreate}. After a device reboot **not a single notification**
 * arrived until the user opened the app by hand — exactly when you look for yourself
 * anyway. A push channel that needs a manual start is no push channel.
 *
 * Two triggers:
 *   BOOT_COMPLETED      — after the device is unlocked (the app is NOT direct-boot
 *                         aware; before that SharedPreferences and tsnet state are
 *                         still encrypted and unreadable).
 *   MY_PACKAGE_REPLACED — after the self-update. The system kills the app in the process;
 *                         without this branch push would be silently dead after every update.
 *
 * Note: both broadcasts are exempt from the background-start restrictions for foreground
 * services — so the start is allowed, not a loophole.
 * IMPORTANT (targetSdk trap): from targetSdk 35 on, services of type {@code dataSync} may NO
 * longer be started from BOOT_COMPLETED. When raising targetSdk next, the service type must
 * move along, otherwise exactly this breaks again.
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "ClaraBoot";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        boolean started = NtfyPushService.startIfConfigured(ctx);
        Log.i(TAG, action + " → Push-Dienst " + (started ? "gestartet" : "uebersprungen (nicht eingerichtet)"));
    }
}
