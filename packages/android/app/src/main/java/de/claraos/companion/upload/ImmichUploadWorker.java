package de.claraos.companion.upload;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

import de.claraos.companion.ProvisioningClient;
import de.claraos.companion.vpn.CompanionTunnel;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;

/**
 * Automatically uploads new camera photos to Immich — through the app tunnel.
 * Dedup: Immich discards duplicates by deviceAssetId+deviceId; in addition the worker
 * remembers the DATE_ADDED cursor so it only looks at new items.
 *
 * Only runs if provisioning delivered an Immich URL + API key (config-gated).
 */
public class ImmichUploadWorker extends Worker {

    private static final String TAG = "ClaraUpload";
    private static final String PREFS = "claraos.companion.upload";
    private static final String KEY_CURSOR = "immich_date_added_cursor";

    public ImmichUploadWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        String immich = trimSlash(ProvisioningClient.getStoredImmichUrl(ctx));
        String apiKey = ProvisioningClient.getStoredImmichKey(ctx);
        String control = ProvisioningClient.getStoredControlUrlOrEmpty(ctx);
        if (immich.isEmpty() || apiKey.isEmpty() || control.isEmpty()) {
            return Result.success(); // not (fully) provisioned → nothing to do
        }

        final int proxyPort;
        try {
            proxyPort = CompanionTunnel.start(ctx, control, "", hostname());
        } catch (Exception e) {
            Log.w(TAG, "tunnel not up, retry later: " + e.getMessage());
            return Result.retry();
        }
        OkHttpClient client = CompanionTunnel.tunneledClient(proxyPort);

        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long cursor = p.getLong(KEY_CURSOR, 0L);
        long newCursor = cursor;
        String deviceId = androidId(ctx);

        String[] proj = {
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.MIME_TYPE,
                MediaStore.Images.Media.DATE_ADDED,
                MediaStore.Images.Media.DATE_MODIFIED,
        };
        // DATE_ADDED is in seconds.
        String sel = MediaStore.Images.Media.DATE_ADDED + " > ?";
        String[] args = {String.valueOf(cursor)};
        String order = MediaStore.Images.Media.DATE_ADDED + " ASC";

        ContentResolver cr = ctx.getContentResolver();
        int uploaded = 0, dup = 0, failed = 0;
        try (Cursor c = cr.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, proj, sel, args, order)) {
            if (c == null) return Result.success();
            int iId = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
            int iName = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME);
            int iMime = c.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE);
            int iAdded = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED);
            int iMod = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED);
            while (c.moveToNext()) {
                long id = c.getLong(iId);
                long added = c.getLong(iAdded);
                Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
                try {
                    int status = uploadOne(client, cr, uri, immich, apiKey, deviceId,
                            "android-" + id,
                            c.getString(iName), c.getString(iMime),
                            iso(added * 1000L), iso(c.getLong(iMod) * 1000L));
                    if (status == 1) uploaded++;
                    else if (status == 2) dup++;
                    else failed++;
                    // only advance the cursor if processed successfully (upload OR duplicate)
                    if (status != 0 && added > newCursor) newCursor = added;
                } catch (Exception e) {
                    failed++;
                    Log.w(TAG, "upload failed id=" + id + ": " + e.getMessage());
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "MediaStore query failed", e);
            return Result.retry();
        }

        if (newCursor > cursor) p.edit().putLong(KEY_CURSOR, newCursor).apply();
        Log.i(TAG, "immich sync: uploaded=" + uploaded + " dup=" + dup + " failed=" + failed);
        return failed > 0 ? Result.retry() : Result.success();
    }

    /** @return 1=uploaded, 2=duplicate, 0=failed */
    private int uploadOne(OkHttpClient client, ContentResolver cr, Uri uri, String immich,
                          String apiKey, String deviceId, String deviceAssetId,
                          String name, String mime, String createdAt, String modifiedAt)
            throws Exception {
        RequestBody assetBody = streamBody(cr, uri, mime == null ? "application/octet-stream" : mime);
        MultipartBody body = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("deviceAssetId", deviceAssetId)
                .addFormDataPart("deviceId", deviceId)
                .addFormDataPart("fileCreatedAt", createdAt)
                .addFormDataPart("fileModifiedAt", modifiedAt)
                .addFormDataPart("isFavorite", "false")
                .addFormDataPart("assetData", name == null ? "photo" : name, assetBody)
                .build();
        Request req = new Request.Builder()
                .url(immich + "/api/assets")
                .header("x-api-key", apiKey)
                .header("Accept", "application/json")
                .post(body)
                .build();
        try (Response resp = client.newCall(req).execute()) {
            if (!resp.isSuccessful()) {
                Log.w(TAG, "immich HTTP " + resp.code() + " for " + deviceAssetId);
                return 0;
            }
            String rb = resp.body() != null ? resp.body().string() : "";
            // Immich: {"id":..,"status":"created"|"duplicate"}
            return rb.contains("\"duplicate\"") ? 2 : 1;
        }
    }

    /** Streams the file from the ContentResolver without reading it fully into memory. */
    private RequestBody streamBody(ContentResolver cr, Uri uri, String mime) {
        MediaType type = MediaType.parse(mime);
        return new RequestBody() {
            @Override
            public MediaType contentType() {
                return type;
            }

            @Override
            public void writeTo(@NonNull BufferedSink sink) throws java.io.IOException {
                try (InputStream in = cr.openInputStream(uri)) {
                    if (in == null) throw new java.io.IOException("cannot open " + uri);
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) sink.write(buf, 0, n);
                }
            }
        };
    }

    private static String iso(long epochMillis) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(epochMillis));
    }

    private static String androidId(Context ctx) {
        String id = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ANDROID_ID);
        return "claraos-companion-" + (id == null ? "unknown" : id);
    }

    private static String hostname() {
        // The single source of the tunnel hostname — a differing copy would register
        // the device a second time.
        return de.claraos.companion.vpn.CompanionTunnel.defaultHostname();
    }

    private static String trimSlash(String s) {
        if (s == null) return "";
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }
}
