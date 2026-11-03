package de.claraos.companion.push;

import de.claraos.companion.BuildConfig;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicInteger;

import de.claraos.companion.ProvisioningClient;
import de.claraos.companion.ShellActivity;
import de.claraos.companion.vpn.CompanionTunnel;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Foreground service that keeps an ntfy WebSocket open through the app tunnel and
 * shows incoming messages as Android notifications (tap → ClaraOS shell).
 * Replaces the separate ntfy app.
 *
 * Two ways to start:
 *   1. From {@link ShellActivity} after the tunnel is up — with a ready {@code proxy_port} in the extras.
 *   2. Without extras, from {@link de.claraos.companion.boot.BootReceiver} (device reboot,
 *      self-update) or as a sticky restart by the system. Then the service reads the config
 *      from SharedPreferences and **brings the tunnel up itself**.
 *
 * Note: before 0.5.2 both hung on the activity: after a reboot not a single notification
 * arrived without starting the app by hand. In addition the sticky restart went nowhere —
 * with {@code intent == null} onStartCommand returned without ever connecting: the
 * persistent notification claimed "active" while no WebSocket was open at all.
 */
public class NtfyPushService extends Service {

    private static final String TAG = "ClaraNtfy";
    private static final String CHANNEL_ONGOING = "claraos_push_ongoing";
    private static final String CHANNEL_MESSAGES = "claraos_push_messages";
    private static final int FG_NOTIFICATION_ID = 1;

    public static final String EXTRA_SERVER = "ntfy_server";
    public static final String EXTRA_TOPIC = "ntfy_topic";
    public static final String EXTRA_AUTH = "ntfy_auth";   // ready-made Authorization header value, optional
    public static final String EXTRA_PROXY_PORT = "proxy_port";
    /**
     * Discard the existing connection and rebuild it with a fresh config.
     * Set on re-pairing: the service is already running then — with the OLD ntfy
     * token. Without this flag the start would be ignored and re-pairing would not
     * have changed push at all; exactly the bug you only notice days later.
     */
    public static final String EXTRA_FORCE_RECONNECT = "force_reconnect";

    /** Backoff for the tunnel setup: at boot there is often no network yet. */
    private static final long TUNNEL_RETRY_MIN_MS = 15_000L;
    private static final long TUNNEL_RETRY_MAX_MS = 300_000L;

    /**
     * Backoff for the WebSocket. IMPORTANT (measured on a real device): previously this
     * was a FIXED 5-second interval without a cap. As long as the server says no, that is
     * 720 connection attempts per hour and device — and since all tailnet devices may reach
     * ntfy behind the same SNAT address, they share one counter there. The subscription
     * limit filled up, ntfy answered 429, the app kept hammering: a self-sustaining state.
     * An emergency rate limit in the reverse proxy then locked out every freshly paired
     * device as well.
     * Therefore: double up to 5 minutes, and after a real rejection (HTTP status) do not
     * come back in less than a minute.
     */
    private static final long WS_RETRY_MIN_MS = 5_000L;
    private static final long WS_RETRY_MAX_MS = 300_000L;
    private static final long WS_RETRY_REJECTED_MS = 60_000L;

    private final AtomicInteger msgId = new AtomicInteger(1000);
    private OkHttpClient client;
    private WebSocket webSocket;
    private volatile boolean stopped = false;
    /** Prevents duplicate WebSockets when the shell starts while the service is already running. */
    private volatile boolean active = false;
    private volatile long tunnelRetryMs = TUNNEL_RETRY_MIN_MS;
    private volatile long wsRetryMs = WS_RETRY_MIN_MS;

    /**
     * Starts the service without extras if the device is set up and push is configured.
     * For callers without a tunnel/proxy port (BootReceiver). Returns whether it was started.
     */
    public static boolean startIfConfigured(Context ctx) {
        if (ProvisioningClient.getStoredControlUrl(ctx) == null) return false;
        if (ProvisioningClient.getStoredNtfyServer(ctx).isEmpty()) return false;
        if (ProvisioningClient.getStoredNtfyTopic(ctx).isEmpty()) return false;
        ctx.startForegroundService(new Intent(ctx, NtfyPushService.class));
        return true;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        startForeground(FG_NOTIFICATION_ID, ongoingNotification("Verbindung wird aufgebaut …"));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean force = intent != null && intent.getBooleanExtra(EXTRA_FORCE_RECONNECT, false);
        if (active && !force) return START_STICKY;   // already running — no second socket
        if (force) {
            Log.i(TAG, "Neu-Koppeln: bestehende Verbindung verwerfen");
            if (webSocket != null) {
                webSocket.cancel();
                webSocket = null;
            }
            active = false;
            wsRetryMs = WS_RETRY_MIN_MS;
        }

        String server = intent == null ? null : intent.getStringExtra(EXTRA_SERVER);
        String topic = intent == null ? null : intent.getStringExtra(EXTRA_TOPIC);
        String auth = intent == null ? null : intent.getStringExtra(EXTRA_AUTH);
        int proxyPort = intent == null ? 0 : intent.getIntExtra(EXTRA_PROXY_PORT, 0);

        // No/empty intent (boot, update, sticky restart) → config from the prefs.
        if (isBlank(server) || isBlank(topic)) {
            server = ProvisioningClient.getStoredNtfyServer(this);
            topic = ProvisioningClient.getStoredNtfyTopic(this);
            auth = ProvisioningClient.getStoredNtfyAuth(this);
        }
        if (isBlank(server) || isBlank(topic)) {
            Log.w(TAG, "missing ntfy config — stopping");
            stopSelf();
            return START_NOT_STICKY;
        }

        active = true;
        if (proxyPort > 0 || ProvisioningClient.isDirect(this)) {
            connect(server, topic, auth, proxyPort);   // direct setup: port 0 = no proxy
        } else {
            bringUpTunnelThenConnect(server, topic, auth);
        }
        return START_STICKY;
    }

    /**
     * Brings the app tunnel up itself (blocking, hence its own thread) and then connects.
     * After a device reboot the network is often not up yet → retry with growing intervals
     * instead of giving up the service. The user sees the state in the persistent notification.
     */
    private void bringUpTunnelThenConnect(String server, String topic, @Nullable String auth) {
        new Thread(() -> {
            String controlUrl = ProvisioningClient.getStoredControlUrl(this);
            if (controlUrl == null) {
                Log.w(TAG, "nicht eingerichtet — stopping");
                stopSelf();
                return;
            }
            while (!stopped) {
                try {
                    int port = CompanionTunnel.start(this, controlUrl, "",
                            CompanionTunnel.defaultHostname());
                    Log.i(TAG, "tunnel up (headless), proxy port " + port);
                    tunnelRetryMs = TUNNEL_RETRY_MIN_MS;
                    connect(server, topic, auth, port);
                    return;
                } catch (Exception e) {
                    Log.w(TAG, "tunnel start failed, retry in " + tunnelRetryMs + "ms: " + e.getMessage());
                    updateOngoing("Kein Netz – neuer Versuch läuft");
                    try {
                        Thread.sleep(tunnelRetryMs);
                    } catch (InterruptedException ie) {
                        return;
                    }
                    tunnelRetryMs = Math.min(tunnelRetryMs * 2, TUNNEL_RETRY_MAX_MS);
                }
            }
        }, "companion-push-tunnel").start();
    }

    private void connect(String server, String topic, @Nullable String auth, int proxyPort) {
        // ntfy WebSocket endpoint. server = host (without scheme), e.g. "push.example.org".
        String url = "wss://" + server + "/" + topic + "/ws";
        client = CompanionTunnel.tunneledClient(proxyPort);
        Request.Builder rb = new Request.Builder().url(url);
        if (auth != null && !auth.isEmpty()) rb.header("Authorization", auth);
        Request req = rb.build();
        Log.i(TAG, "connecting ntfy WS " + url + " via proxy 127.0.0.1:" + proxyPort);
        webSocket = client.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                wsRetryMs = WS_RETRY_MIN_MS;   // connected → reset backoff
                PushCredentialRefresher.zuruecksetzen();
                updateOngoing("Push-Benachrichtigungen aktiv");
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                handleNtfyMessage(text);
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, @Nullable Response response) {
                int code = response == null ? 0 : response.code();
                Log.w(TAG, "ntfy WS failure: " + t.getMessage() + (code > 0 ? " (HTTP " + code + ")" : ""));
                if (stopped) return;

                // Note: for ntfy, 401 means "authentication does not match" — i.e. the
                // credential expired or was revoked (403 would be "missing rights"). Right
                // here the app used to keep hammering with a dead credential forever.
                // Now it fetches a fresh one ONCE and reconnects with it; if that fails,
                // everything continues as before.
                if (code == 401) {
                    String frisch = PushCredentialRefresher.erneuere(NtfyPushService.this, proxyPort);
                    if (frisch != null && !frisch.equals(auth)) {
                        updateOngoing("Zugang erneuert – verbinde neu");
                        wsRetryMs = WS_RETRY_MIN_MS;
                        if (webSocket != null) {
                            webSocket.cancel();
                            webSocket = null;
                        }
                        connect(server, topic, frisch, proxyPort);
                        return;
                    }
                }

                // A rejection with an HTTP status is an answer from the server, not a network
                // glitch — retrying quickly achieves nothing and makes it worse (429).
                if (code >= 400) wsRetryMs = Math.max(wsRetryMs, WS_RETRY_REJECTED_MS);
                updateOngoing(meldungFuer(code));
                scheduleReconnect(server, topic, auth, proxyPort);
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                if (!stopped) scheduleReconnect(server, topic, auth, proxyPort);
            }
        });
    }

    private void scheduleReconnect(String server, String topic, @Nullable String auth, int proxyPort) {
        long delay = wsRetryMs;
        wsRetryMs = Math.min(wsRetryMs * 2, WS_RETRY_MAX_MS);
        // Clean up the old socket before opening a new one — otherwise half-open
        // subscriptions pile up on the server side and hit the limit (see above).
        if (webSocket != null) {
            webSocket.cancel();
            webSocket = null;
        }
        Log.i(TAG, "ntfy reconnect in " + delay + "ms");
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            if (!stopped) connect(server, topic, auth, proxyPort);
        }, delay);
    }

    private void handleNtfyMessage(String text) {
        try {
            JSONObject o = new JSONObject(text);
            String event = o.optString("event");
            if (!"message".equals(event)) return; // ignore open/keepalive/poll_request
            String title = o.optString("title", BuildConfig.BRAND);
            String message = o.optString("message", "");
            String click = o.optString("click", null); // optional deep link into the shell
            postMessageNotification(title, message, click);
        } catch (Exception e) {
            Log.w(TAG, "parse ntfy message failed", e);
        }
    }

    private void postMessageNotification(String title, String message, @Nullable String click) {
        Intent open = new Intent(this, ShellActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (click != null && !click.isEmpty()) {
            open.setData(android.net.Uri.parse(click));
            open.putExtra(ShellActivity.EXTRA_LINK_NONCE, ShellActivity.LINK_NONCE);
        }
        PendingIntent pi = PendingIntent.getActivity(this, msgId.get(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new Notification.Builder(this, CHANNEL_MESSAGES)
                .setContentTitle(title)
                .setContentText(message)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
        nm().notify(msgId.incrementAndGet(), n);
    }

    /**
     * Tells the user what is going on — and where possible, what they can do.
     *
     * Note: previously every error showed "server rejects (HTTP 401)". True, but
     * useless: the user could not infer that the push credential had expired and the
     * app had to be opened once. A status display that only repeats the status code
     * shifts the diagnosis onto the user.
     */
    private static String meldungFuer(int code) {
        if (code == 401) return "Zugang abgelaufen – bitte die App einmal öffnen";
        if (code == 403) return "Keine Berechtigung für diese Meldungen";
        if (code == 429) return "Server bremst gerade – neuer Versuch später";
        if (code >= 500) return "Server hat gerade ein Problem – neuer Versuch später";
        if (code >= 400) return "Server lehnt ab (HTTP " + code + ") – neuer Versuch später";
        return "Verbindung unterbrochen – wird erneut versucht";
    }

    /** Keep the persistent notification honest — it is the service's only status indicator. */
    private void updateOngoing(String text) {
        try {
            nm().notify(FG_NOTIFICATION_ID, ongoingNotification(text));
        } catch (Exception e) {
            Log.w(TAG, "ongoing notification update failed", e);
        }
    }

    private Notification ongoingNotification(String text) {
        return new Notification.Builder(this, CHANNEL_ONGOING)
                .setContentTitle(BuildConfig.BRAND)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setOngoing(true)
                .build();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm().createNotificationChannel(new NotificationChannel(
                    CHANNEL_ONGOING, BuildConfig.BRAND + " Push-Dienst", NotificationManager.IMPORTANCE_MIN));
            nm().createNotificationChannel(new NotificationChannel(
                    CHANNEL_MESSAGES, BuildConfig.BRAND + " Benachrichtigungen", NotificationManager.IMPORTANCE_HIGH));
        }
    }

    private NotificationManager nm() {
        return (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    }

    private static boolean isBlank(@Nullable String s) {
        return s == null || s.isEmpty();
    }

    @Override
    public void onDestroy() {
        stopped = true;
        active = false;
        if (webSocket != null) webSocket.close(1000, "service stop");
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
