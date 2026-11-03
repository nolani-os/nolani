package de.claraos.companion.upload;

import android.content.Context;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

import de.claraos.companion.ProvisioningClient;

/**
 * Schedules the automatic photo sync to Immich (periodic + once immediately)
 * as soon as the tunnel is up. No-op if no Immich config is provisioned.
 */
public final class UploadScheduler {

    private static final String WORK_PERIODIC = "claraos-immich-sync";
    private static final String WORK_NOW = "claraos-immich-sync-now";

    private UploadScheduler() {}

    public static void schedule(Context ctx) {
        if (ProvisioningClient.getStoredImmichUrl(ctx).isEmpty()
                || ProvisioningClient.getStoredImmichKey(ctx).isEmpty()) {
            return; // not provisioned → no photo sync
        }
        Constraints net = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();

        PeriodicWorkRequest periodic = new PeriodicWorkRequest.Builder(
                ImmichUploadWorker.class, 6, TimeUnit.HOURS)
                .setConstraints(net)
                .build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_PERIODIC, ExistingPeriodicWorkPolicy.KEEP, periodic);

        // Once now (the tunnel just came up):
        OneTimeWorkRequest now = new OneTimeWorkRequest.Builder(ImmichUploadWorker.class)
                .setConstraints(net)
                .build();
        WorkManager.getInstance(ctx).enqueueUniqueWork(
                WORK_NOW, ExistingWorkPolicy.REPLACE, now);
    }
}
