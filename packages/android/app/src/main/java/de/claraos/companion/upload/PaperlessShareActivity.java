package de.claraos.companion.upload;

import de.claraos.companion.BuildConfig;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Log;
import android.widget.Toast;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

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
 * Share target "Send to ClaraOS": receives shared files/images/PDFs and uploads them
 * through the app tunnel to Paperless (`POST /api/documents/post_document/`).
 * No-op with a hint if no Paperless config is provisioned.
 */
public class PaperlessShareActivity extends Activity {

    private static final String TAG = "ClaraShare";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        List<Uri> uris = extractUris(getIntent(), getPackageName());
        if (uris.isEmpty()) {
            finish();
            return;
        }
        String paperless = trimSlash(ProvisioningClient.getStoredPaperlessUrl(this));
        String token = ProvisioningClient.getStoredPaperlessToken(this);
        String control = ProvisioningClient.getStoredControlUrlOrEmpty(this);
        if (paperless.isEmpty() || token.isEmpty() || control.isEmpty()) {
            Toast.makeText(this, BuildConfig.BRAND + ": Paperless noch nicht eingerichtet.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        Toast.makeText(this, "An Paperless senden …", Toast.LENGTH_SHORT).show();
        final List<Uri> toSend = uris;
        new Thread(() -> {
            int ok = 0, fail = 0;
            try {
                int port = CompanionTunnel.start(this, control, "", hostname());
                OkHttpClient client = CompanionTunnel.tunneledClient(port);
                for (Uri u : toSend) {
                    try {
                        if (uploadToPaperless(client, u, paperless, token)) ok++; else fail++;
                    } catch (Exception e) {
                        fail++;
                        Log.w(TAG, "paperless upload failed: " + e.getMessage());
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "tunnel/upload error: " + e.getMessage());
                fail = toSend.size();
            }
            final int fOk = ok, fFail = fail;
            runOnUiThread(() -> {
                Toast.makeText(this,
                        fFail == 0 ? (fOk + " an Paperless gesendet.")
                                : ("Paperless: " + fOk + " ok, " + fFail + " fehlgeschlagen."),
                        Toast.LENGTH_LONG).show();
                finish();
            });
        }, "paperless-share").start();
    }

    private boolean uploadToPaperless(OkHttpClient client, Uri uri, String paperless, String token)
            throws Exception {
        ContentResolver cr = getContentResolver();
        String name = displayName(cr, uri);
        String mime = cr.getType(uri);
        RequestBody fileBody = streamBody(cr, uri, mime == null ? "application/octet-stream" : mime);
        return PaperlessUploader.upload(client, paperless, token, fileBody, name);
    }

    private RequestBody streamBody(ContentResolver cr, Uri uri, String mime) {
        MediaType type = MediaType.parse(mime);
        return new RequestBody() {
            @Override
            public MediaType contentType() {
                return type;
            }

            @Override
            public void writeTo(BufferedSink sink) throws java.io.IOException {
                try (InputStream in = cr.openInputStream(uri)) {
                    if (in == null) throw new java.io.IOException("cannot open " + uri);
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) sink.write(buf, 0, n);
                }
            }
        };
    }

    private static List<Uri> extractUris(Intent intent, String ownPackage) {
        List<Uri> out = new ArrayList<>();
        if (intent == null) return out;
        String action = intent.getAction();
        List<Uri> in = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) in.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> us = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (us != null) in.addAll(us);
        }
        for (Uri u : in) {
            if (isSharedContent(u.getScheme(), u.getAuthority(), ownPackage)) out.add(u);
            else android.util.Log.w("PaperlessShare", "share ignored: " + u.getScheme() + "://" + u.getAuthority());
        }
        return out;
    }

    /**
     * Only content another app shares with us: a content:// URI of a foreign
     * provider. file:// or our own provider would be read with THIS app's rights —
     * a sending app could otherwise upload our private files (credentials).
     */
    static boolean isSharedContent(String scheme, String authority, String ownPackage) {
        if (!"content".equals(scheme)) return false;
        return authority != null && !authority.equals(ownPackage)
                && !authority.startsWith(ownPackage + ".");
    }

    private static String displayName(ContentResolver cr, Uri uri) {
        try (android.database.Cursor c = cr.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) {
                    String n = c.getString(i);
                    if (n != null) return n;
                }
            }
        } catch (Exception ignore) {
        }
        return "dokument";
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
