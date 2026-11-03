package de.claraos.companion.update;

import de.claraos.companion.BuildConfig;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;

import de.claraos.companion.ProvisioningClient;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Self-update via our own distribution (download-only, no store).
 *
 * Note: three things were changed fundamentally after a device ran an old version
 * for days without anyone noticing:
 *
 * 1. **Public source instead of the shell origin.** Previously the manifest sat behind
 *    the login and was fetched with the WebView cookies — but the check ran BEFORE the
 *    app had logged in. Missing session ⇒ 302 ⇒ silent abort. Now manifest and APK
 *    come from the build variant's public backend ({@code DEFAULT_BACKEND}); both are
 *    public there anyway (exact path + own rate limit). The content is only the
 *    version number — which is in the publicly downloadable APK anyway.
 * 2. **Without the tunnel.** Deliberately a direct client, no tunnel proxy: a broken
 *    tunnel is exactly the situation in which an update is needed most. The update
 *    path must not depend on what it is supposed to repair.
 * 3. **The response is sanity-checked.** Twice a catch-all route delivered the SPA
 *    HTML with HTTP 200 as the "file" — without an error code. Therefore: check
 *    Content-Type AND content and log the suspicious case loudly instead of booking
 *    it as "no update".
 *
 * Stays fail-silent: a failure must never impair the app. But it now leaves a
 * trace with a reason.
 */
public final class SelfUpdateManager {

    private static final String TAG = "ClaraUpdate";
    private static final String PREFS = "claraos.companion.update";
    private static final String KEY_LAST_CHECK = "last_check_ms";
    private static final String KEY_LAST_OK = "last_success_ms";
    private static final String KEY_LAST_RESULT = "last_result";
    private static final long CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000; // minimum interval

    /** Public source — the same as for provisioning. */
    private static final String MANIFEST_PATH = "/downloads/companion-version.json";
    private static final String APK_PATH = "/downloads/claraos-companion.apk";

    private SelfUpdateManager() {}

    /**
     * Trigger a check. Call it AFTER the shell has loaded: before that the call
     * competes with the tunnel setup, and historically that was exactly the moment
     * the check was least reliable.
     * Runs in a background thread itself.
     */
    public static void check(Activity activity) {
        new Thread(() -> checkBlocking(activity, true), "companion-update-check").start();
    }

    /**
     * @param interactive true = show a dialog for a new version (app is open).
     *                    false = only report whether there is something new (background run).
     * @return versionCode of the available version, or 0 if none/error.
     */
    public static int checkBlocking(Context ctx, boolean interactive) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            long last = p.getLong(KEY_LAST_CHECK, 0L);
            if (System.currentTimeMillis() - last < CHECK_INTERVAL_MS) {
                Log.i(TAG, "Prüfung übersprungen: Mindestabstand noch nicht erreicht");
                return 0;
            }
            p.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply();

            String base = ProvisioningClient.DEFAULT_BACKEND;
            if (base.isEmpty()) {
                Log.i(TAG, "no update server in this build variant");
                return 0;
            }
            OkHttpClient client = new OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(20, TimeUnit.SECONDS)
                    .followRedirects(false)   // a redirect is always an error here
                    .build();

            String body;
            String contentType;
            try (Response resp = client.newCall(
                    new Request.Builder().url(base + MANIFEST_PATH).build()).execute()) {
                if (resp.code() != 200 || resp.body() == null) {
                    note(p, "HTTP " + resp.code());
                    Log.w(TAG, "Manifest nicht abrufbar: HTTP " + resp.code());
                    return 0;
                }
                contentType = resp.header("Content-Type", "");
                body = resp.body().string();
            }

            // IMPORTANT: the catch-all trap: 200 + HTML instead of the file, without an error code.
            if (looksLikeHtml(contentType, body)) {
                note(p, "HTML statt JSON");
                Log.e(TAG, "Manifest liefert HTML statt JSON — Auslieferung/Routing prüfen "
                        + "(Content-Type: " + contentType + ")");
                return 0;
            }

            JSONObject v = new JSONObject(body);
            int remoteCode = v.getInt("versionCode");
            String remoteName = v.optString("versionName", String.valueOf(remoteCode));
            String apkUrl = v.optString("url", base + APK_PATH);
            int localCode = currentVersionCode(ctx);

            p.edit().putLong(KEY_LAST_OK, System.currentTimeMillis()).apply();
            if (remoteCode <= localCode) {
                note(p, "aktuell (" + localCode + ")");
                return 0;
            }

            Log.i(TAG, "Update verfügbar: " + localCode + " -> " + remoteCode);
            note(p, "Update " + remoteName + " verfügbar");
            if (interactive && ctx instanceof Activity) {
                Activity a = (Activity) ctx;
                a.runOnUiThread(() -> new AlertDialog.Builder(a)
                        .setTitle(BuildConfig.BRAND + "-Update verfügbar")
                        .setMessage("Version " + remoteName + " ist bereit. Jetzt laden und installieren?")
                        .setPositiveButton("Installieren", (d, w) ->
                                downloadAndInstallAsync(a, client, apkUrl))
                        .setNegativeButton("Später", null)
                        .show());
            }
            return remoteCode;
        } catch (Exception e) {
            note(p, e.getClass().getSimpleName());
            Log.w(TAG, "Update-Prüfung fehlgeschlagen: " + e.getMessage());
            return 0;
        }
    }

    /** Detects the "catch-all serves the start page" trap. */
    private static boolean looksLikeHtml(String contentType, String body) {
        if (contentType != null && contentType.toLowerCase().contains("html")) return true;
        String head = body.trim();
        return head.startsWith("<");
    }

    /** Record the last outcome — basis for making it visible. */
    private static void note(SharedPreferences p, String result) {
        p.edit().putString(KEY_LAST_RESULT, result).apply();
    }

    /** For display/diagnostics: what was the result of the last check? */
    public static String lastResult(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_LAST_RESULT, "noch nie geprüft");
    }

    static void downloadAndInstallAsync(Activity activity, OkHttpClient client, String apkUrl) {
        Toast.makeText(activity, "Update wird geladen …", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                File dir = new File(activity.getCacheDir(), "updates");
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File apk = new File(dir, "claraos-companion.apk");
                try (Response resp = client.newCall(
                        new Request.Builder().url(apkUrl).build()).execute()) {
                    if (resp.code() != 200 || resp.body() == null) {
                        throw new IllegalStateException("http " + resp.code());
                    }
                    String ct = resp.header("Content-Type", "");
                    if (ct != null && ct.toLowerCase().contains("html")) {
                        // Better abort here than hand the system installer 953 bytes
                        // of HTML as an "app" (a pattern seen before).
                        throw new IllegalStateException("Server lieferte HTML statt APK");
                    }
                    try (InputStream in = resp.body().byteStream();
                         FileOutputStream out = new FileOutputStream(apk)) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    }
                }
                Uri uri = FileProvider.getUriForFile(
                        activity, activity.getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                // If "Install unknown apps" is missing for this app, the system
                // installer leads to the settings itself — no custom code needed.
                // Android itself enforces the matching signing key on install.
                activity.startActivity(install);
            } catch (Exception e) {
                Log.e(TAG, "Update-Download fehlgeschlagen", e);
                activity.runOnUiThread(() -> Toast.makeText(activity,
                        "Update fehlgeschlagen: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }, "companion-update").start();
    }

    @SuppressWarnings("deprecation") // getLongVersionCode only from API 28, minSdk is 26
    private static int currentVersionCode(Context ctx) {
        try {
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return Integer.MAX_VALUE; // when in doubt NEVER offer an "update" to itself
        }
    }
}
