package de.claraos.companion.push;

import android.content.Context;
import android.util.Log;
import android.webkit.CookieManager;

import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import de.claraos.companion.ProvisioningClient;
import de.claraos.companion.vpn.CompanionTunnel;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Fetches a fresh ntfy credential when the stored one is no longer valid.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Up to 0.5.6 the app stored its ntfy credential <b>once at pairing</b> and <b>never</b>
 * renewed it. ntfy issued tokens with a 72-hour lifetime — so three days after pairing
 * the server answered {@code 401} permanently, and the only fix was re-pairing. It was
 * only visible as "server rejects (HTTP 401)" in the persistent notification, while the
 * web UI kept working (it renews server-side by itself) — so the outage was well hidden.
 *
 * Note — <b>how we authenticate</b>: with the ClaraOS session the app already has for
 * loading the shell. The cookies live in the WebView's {@link CookieManager} and are
 * readable process-wide, so also from this background service. Deliberately NO second
 * secret on the device and no new trust path on the server: whoever may load the shell
 * may also fetch their own push credential — nothing more.
 *
 * Note — <b>why this also heals an already dead device</b>: the session lasts 14 days
 * and survives an app restart. A device with a dead token still has it — unlike a second
 * secret that would only have been distributed at pairing and would be missing on exactly
 * the devices you want to rescue.
 *
 * IMPORTANT: the call goes <b>through the app tunnel</b> (the shell URL may only be
 * reachable in the tailnet), so it needs the proxy port of the running tunnel.
 */
public final class PushCredentialRefresher {

    private static final String TAG = "ClaraNtfy";
    private static final String PFAD = "/api/claraos/ntfy/device-token";

    /**
     * Minimum interval between two renewal attempts. Without it a device whose
     * session has expired as well would ask again on every WebSocket failure — the
     * same self-amplification that has already exhausted the subscription limit
     * before.
     */
    private static final long MIN_ABSTAND_MS = TimeUnit.MINUTES.toMillis(10);

    private static volatile long letzterVersuch = 0L;

    private PushCredentialRefresher() {}

    /**
     * Tries once to fetch and store a fresh credential.
     *
     * @return the new Authorization header, or {@code null} if it did not work
     *         (no network, session expired, server says no). The caller then keeps its
     *         previous flow — a failure here must not break anything.
     */
    @Nullable
    public static synchronized String erneuere(Context ctx, int proxyPort) {
        long jetzt = System.currentTimeMillis();
        if (jetzt - letzterVersuch < MIN_ABSTAND_MS) {
            Log.i(TAG, "Erneuerung übersprungen (Mindestabstand noch nicht erreicht)");
            return null;
        }
        letzterVersuch = jetzt;

        String shellUrl = ProvisioningClient.getStoredShellUrl(ctx);
        if (shellUrl == null || shellUrl.isEmpty()) {
            Log.w(TAG, "Erneuerung nicht möglich — keine Shell-URL gespeichert");
            return null;
        }
        String basis = shellUrl.endsWith("/") ? shellUrl.substring(0, shellUrl.length() - 1) : shellUrl;
        String url = basis + PFAD + "?device=" + android.net.Uri.encode(CompanionTunnel.defaultHostname());

        String cookies = CookieManager.getInstance().getCookie(basis);
        if (cookies == null || cookies.isEmpty()) {
            Log.w(TAG, "Erneuerung nicht möglich — keine Sitzung (App einmal öffnen)");
            return null;
        }

        try {
            OkHttpClient client = CompanionTunnel.tunneledClient(proxyPort);
            Request req = new Request.Builder().url(url).header("Cookie", cookies).build();
            try (Response res = client.newCall(req).execute()) {
                if (!res.isSuccessful()) {
                    // 302 to the login page = session expired. That is a different case
                    // from "server broken" and should not count as an error.
                    Log.w(TAG, "Erneuerung abgelehnt: HTTP " + res.code());
                    return null;
                }
                okhttp3.ResponseBody body = res.body();
                if (body == null) return null;
                JSONObject o = new JSONObject(body.string());
                String auth = o.optString("auth", "");
                if (auth.isEmpty()) {
                    Log.w(TAG, "Erneuerung lieferte keinen Zugang");
                    return null;
                }
                ProvisioningClient.storeNtfyAuth(ctx, auth);
                // A direct setup learns server and topic only here (it was never
                // provisioned). Never overwrite them with empty values.
                String server = o.optString("ntfy_server", "");
                String topic = o.optString("ntfy_topic", "");
                if (!server.isEmpty() && !topic.isEmpty()) {
                    ProvisioningClient.storeNtfyServerTopic(ctx, server, topic);
                }
                Log.i(TAG, "Push-Zugang erneuert");
                return auth;
            }
        } catch (Exception e) {
            Log.w(TAG, "Erneuerung fehlgeschlagen: " + e.getMessage());
            return null;
        }
    }

    /** After a successful connection: the next failure may renew immediately. */
    public static void zuruecksetzen() {
        letzterVersuch = 0L;
    }
}
