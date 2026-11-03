package de.claraos.companion.update;

import de.claraos.companion.BuildConfig;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.Worker;
import androidx.work.WorkManager;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

import de.claraos.companion.ShellActivity;

/**
 * Daily update check in the background.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Up to 0.5.3 the check hung exclusively on the app's **cold start**. The
 * "at most every 6 hours" was only a minimum interval, not a schedule — nothing
 * checked on its own. A device whose app process simply keeps running (for days
 * on some phones) therefore NEVER looked and stayed on an old version without
 * anyone noticing.
 *
 * The worker runs headless: since 0.5.3 {@link SelfUpdateManager} fetches manifest
 * and APK from the build variant's public backend — no session, no tunnel. So the check
 * also works when pairing is broken; i.e. exactly when an update is needed most.
 *
 * Note: NOTHING is installed here. Android does not allow a silent install without
 * device management — rightly so. The worker only notifies; tapping leads into the
 * app and there into the usual flow.
 *
 * IMPORTANT: deliberately NO download in the background: the APK is 66 MB. It is
 * only downloaded after the tap — then the user also sees whether they are on Wi-Fi.
 */
public class UpdateCheckWorker extends Worker {

    private static final String TAG = "ClaraUpdate";
    private static final String WORK_NAME = "claraos-update-check";
    private static final String CHANNEL_UPDATE = "claraos_update";
    private static final int NOTIFICATION_ID = 4711;

    public UpdateCheckWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    /** Schedule once; KEEP so that an app start does not keep resetting the rhythm. */
    public static void schedule(Context ctx) {
        PeriodicWorkRequest daily = new PeriodicWorkRequest.Builder(
                UpdateCheckWorker.class, 1, TimeUnit.DAYS)
                .setConstraints(new Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build())
                .build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, daily);
    }

    @NonNull
    @Override
    public Result doWork() {
        // interactive=false: a worker has no UI for a dialog — the result
        // becomes a notification.
        int available = SelfUpdateManager.checkBlocking(getApplicationContext(), false);
        if (available > 0) {
            Log.i(TAG, "Hintergrundprüfung: Version " + available + " verfügbar");
            notifyUpdate(getApplicationContext(), available);
        }
        return Result.success();   // fail-silent: never end with failure, otherwise backoff spiral
    }

    private void notifyUpdate(Context ctx, int versionCode) {
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL_UPDATE, BuildConfig.BRAND + "-Updates", NotificationManager.IMPORTANCE_DEFAULT));
        }
        PendingIntent open = PendingIntent.getActivity(ctx, 0,
                new Intent(ctx, ShellActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(ctx, CHANNEL_UPDATE)
                .setContentTitle(BuildConfig.BRAND + "-Update verfügbar")
                .setContentText("Zum Installieren tippen (Download am besten im WLAN).")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setAutoCancel(true)
                .setContentIntent(open)
                .build();
        nm.notify(NOTIFICATION_ID, n);
    }
}
