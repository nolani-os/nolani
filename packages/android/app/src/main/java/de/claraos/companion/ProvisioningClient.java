package de.claraos.companion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Provisioning: invite token (same `/i/<token>` as the setup assistant portal)
 * → backend `POST /onboarding/app-provision` (pattern + rate limit of onboarding_public.py)
 * → returns shell URL, coordination server (e.g. Headscale) control URL, short-TTL
 *   pre-auth key, display name.
 *
 * Note: the shell URL is NEVER hard-coded — it comes from this response and is persisted.
 */
public final class ProvisioningClient {

    private static final String PREFS = "claraos.companion.provisioning";
    private static final String KEY_SHELL_URL = "shell_url";
    private static final String KEY_CONTROL_URL = "control_url";
    private static final String KEY_DISPLAY_NAME = "display_name";
    private static final String KEY_NTFY_SERVER = "ntfy_server";
    private static final String KEY_NTFY_TOPIC = "ntfy_topic";
    private static final String KEY_NTFY_AUTH = "ntfy_auth";
    // Upload engine: optional per-user service credentials (config-gated like ntfy).
    private static final String KEY_IMMICH_URL = "immich_url";
    private static final String KEY_IMMICH_KEY = "immich_api_key";
    private static final String KEY_PAPERLESS_URL = "paperless_url";
    private static final String KEY_PAPERLESS_TOKEN = "paperless_token";

    /* Public onboarding host (no tunnel needed — this is how the app GETS the tunnel).
     *
     * IMPORTANT: it must be reachable from the internet. A pairing host restricted to
     * LAN/tailnet answers 403 from outside, so a new device on mobile data could NOT
     * be set up — exactly the situation of a new user: phone not yet in the tailnet,
     * and not on the home Wi-Fi either. The app then only showed "Failed: HTTP 403".
     *
     * The pairing server is the deliberately public entry point: only
     * `/api/claraos/onboarding/*` and `/downloads/*` need to be exposed there. After
     * provisioning everything runs through the app tunnel anyway; the shell URL
     * comes from the response.
     */
    /** Pairing server of this build variant; empty in the generic build. */
    public static final String DEFAULT_BACKEND = BuildConfig.DEFAULT_BACKEND;
    private static final String PROVISION_PATH = "/api/claraos/onboarding/app-provision";

    private ProvisioningClient() {}

    /** Persisted shell URL from an earlier provisioning, or null if not set up yet. */
    public static String getStoredShellUrl(Context ctx) {
        return prefs(ctx).getString(KEY_SHELL_URL, null);
    }

    public static String getStoredControlUrl(Context ctx) {
        return prefs(ctx).getString(KEY_CONTROL_URL, null);
    }

    // ── Direct mode (external cell) ─────────────────────────────────────────────
    //
    // A cell (e.g. demo.claraos.de) is publicly reachable and has no tailnet.
    // There the app loads the shell DIRECTLY, without the embedded tunnel; login is
    // done by Authentik in the WebView. Marker: stored shell URL with an EMPTY
    // control URL. Tunnel setups are unaffected — they always have a control URL.

    /** Variant with a fixed domain (home build): only servers under it, the same trust
     *  boundary as the trusted hosts in ShellActivity — otherwise a crafted connect link
     *  to a foreign domain would get microphone, camera and the device bridge.
     *  Empty (generic build): any https server; trust is then bound to the domain the
     *  user connected to ({@link #getStoredShellDomain}). */
    static final String DIRECT_DOMAIN = BuildConfig.DIRECT_DOMAIN;

    /** Control server used when the user asks for a tunnel but names none. */
    public static final String DEFAULT_CONTROL_URL = "https://controlplane.tailscale.com";

    /** Set up in direct mode (without tunnel)? */
    public static boolean isDirect(Context ctx) {
        String c = getStoredControlUrl(ctx);
        return getStoredShellUrl(ctx) != null && c != null && c.isEmpty();
    }

    /**
     * "example.org", "home.example.org" or a full URL → shell URL
     * {@code https://home.<domain>/}. null if the address is not https, is no host name,
     * or (home build) is not under {@link #DIRECT_DOMAIN}.
     */
    public static String normalizeDirectServer(String input) {
        if (input == null) return null;
        String s = input.trim().toLowerCase(java.util.Locale.ROOT);
        if (s.isEmpty()) return null;
        if (s.startsWith("http://")) return null;            // never unencrypted
        if (s.startsWith("https://")) s = s.substring(8);
        int cut = s.indexOf('/');
        if (cut >= 0) s = s.substring(0, cut);
        if (s.contains(":") || s.contains("@") || !s.matches("[a-z0-9.-]+")) return null;
        if (!isHostName(s)) return null;
        if (!s.startsWith("home.")) s = "home." + s;
        String domain = s.substring("home.".length());
        if (!DIRECT_DOMAIN.isEmpty()
                && !(domain.equals(DIRECT_DOMAIN) || domain.endsWith("." + DIRECT_DOMAIN))) {
            return null;
        }
        return "https://" + s + "/";
    }

    /** A DNS name with at least two labels — no bare IP address, no empty labels. */
    static boolean isHostName(String s) {
        if (s.matches("[0-9.]+")) return false;
        String[] labels = s.split("\\.", -1);
        if (labels.length < 2) return false;
        for (String l : labels) {
            if (l.isEmpty() || l.length() > 63 || l.startsWith("-") || l.endsWith("-")) return false;
        }
        return true;
    }

    /**
     * Control server for the optional tunnel: https URL, or empty for
     * {@link #DEFAULT_CONTROL_URL}. Returns the URL without trailing slash, or null.
     */
    public static String normalizeControlUrl(String input) {
        String s = input == null ? "" : input.trim();
        if (s.isEmpty()) return DEFAULT_CONTROL_URL;
        if (!s.toLowerCase(java.util.Locale.ROOT).startsWith("https://")) s = "https://" + s;
        try {
            java.net.URI u = new java.net.URI(s);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null
                    || u.getUserInfo() != null || !isHostName(u.getHost().toLowerCase(java.util.Locale.ROOT))) {
                return null;
            }
        } catch (java.net.URISyntaxException e) {
            return null;
        }
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    /**
     * Domain of the stored shell: its host without a leading {@code home.}
     * ({@code https://home.example.org/} → {@code example.org}), or null if not set up.
     */
    @androidx.annotation.Nullable
    /**
     * Web origin of a URL as the WebView reports it ("https://host[:port]"), or null
     * for anything but http/https with a host. Used to bind the native bridge.
     */
    public static String originOf(String url) {
        if (url == null) return null;
        java.net.URI u;
        try {
            u = new java.net.URI(url.trim());
        } catch (java.net.URISyntaxException e) {
            return null;
        }
        String scheme = u.getScheme();
        String host = u.getHost();
        if (scheme == null || host == null) return null;
        scheme = scheme.toLowerCase(java.util.Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        int port = u.getPort();
        boolean defaultPort = port == -1
                || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
        return scheme + "://" + host.toLowerCase(java.util.Locale.ROOT)
                + (defaultPort ? "" : ":" + port);
    }

    public static String getStoredShellDomain(Context ctx) {
        String url = getStoredShellUrl(ctx);
        if (url == null) return null;
        String host = android.net.Uri.parse(url).getHost();
        if (host == null || host.isEmpty()) return null;
        host = host.toLowerCase(java.util.Locale.ROOT);
        return host.startsWith("home.") ? host.substring("home.".length()) : host;
    }

    /** Store a self-configured tunnel setup: shell reached through the tunnel. */
    public static void storeTunnel(Context ctx, String shellUrl, String controlUrl) {
        storeDirect(ctx, shellUrl);
        prefs(ctx).edit().putString(KEY_CONTROL_URL, controlUrl).apply();
    }

    private static final String KEY_DEVICE_CONTROL = "device_control";

    /**
     * May the shell change this device's settings (volume, brightness, Wi-Fi,
     * Bluetooth)? The user's answer, else the build variant's default.
     */
    public static boolean isDeviceControlAllowed(Context ctx) {
        return prefs(ctx).getBoolean(KEY_DEVICE_CONTROL, BuildConfig.DEVICE_CONTROL_DEFAULT);
    }

    public static void setDeviceControlAllowed(Context ctx, boolean allowed) {
        prefs(ctx).edit().putBoolean(KEY_DEVICE_CONTROL, allowed).apply();
    }

    /** Store direct mode. There are no push/upload credentials there → cleared. */
    public static void storeDirect(Context ctx, String shellUrl) {
        prefs(ctx).edit()
                // a new server has to ask again before it may change device settings
                .remove(KEY_DEVICE_CONTROL)
                .putString(KEY_SHELL_URL, shellUrl)
                .putString(KEY_CONTROL_URL, "")
                .putString(KEY_DISPLAY_NAME, "")
                .putString(KEY_NTFY_SERVER, "")
                .putString(KEY_NTFY_TOPIC, "")
                .putString(KEY_NTFY_AUTH, "")
                .putString(KEY_IMMICH_URL, "")
                .putString(KEY_IMMICH_KEY, "")
                .putString(KEY_PAPERLESS_URL, "")
                .putString(KEY_PAPERLESS_TOKEN, "")
                .apply();
    }

    /** Result of a successful provisioning. */
    public static final class Result {
        public final String shellUrl;
        public final String controlUrl;
        public final String preauthKey;   // short TTL, single use — do NOT persist
        public final String displayName;
        // Optional ntfy push config (empty while no per-user topic/app password is provided):
        public final String ntfyServer;   // host without scheme, e.g. push.example.org
        public final String ntfyTopic;
        public final String ntfyAuth;     // ready-made Authorization header value (Basic/Bearer)
        public Result(String shellUrl, String controlUrl, String preauthKey, String displayName,
                      String ntfyServer, String ntfyTopic, String ntfyAuth) {
            this.shellUrl = shellUrl;
            this.controlUrl = controlUrl;
            this.preauthKey = preauthKey;
            this.displayName = displayName;
            this.ntfyServer = ntfyServer;
            this.ntfyTopic = ntfyTopic;
            this.ntfyAuth = ntfyAuth;
        }
        public boolean hasNtfy() {
            return ntfyServer != null && !ntfyServer.isEmpty()
                    && ntfyTopic != null && !ntfyTopic.isEmpty();
        }
    }

    /**
     * `POST {backend}/api/claraos/onboarding/app-provision` with {token, device_name}.
     * Response: {shell_url, server_url (control), auth_key, display_name}. Persists
     * shell_url/control_url/display_name (NOT the auth_key) and returns the Result.
     * IMPORTANT: blocking (network) → do not call on the main thread.
     */
    public static Result provision(Context ctx, String backendBaseUrl, String inviteToken,
                                   String deviceName) throws Exception {
        String base = (backendBaseUrl == null || backendBaseUrl.isEmpty()) ? DEFAULT_BACKEND : backendBaseUrl;
        if (base.isEmpty()) throw new IllegalStateException("no pairing server configured");
        JSONObject req = new JSONObject()
                .put("token", inviteToken)
                .put("device_name", deviceName == null ? "" : deviceName);

        HttpURLConnection conn = (HttpURLConnection) new URL(base + PROVISION_PATH).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Accept", "application/json");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setDoOutput(true);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(req.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String bodyStr = is == null ? "" : new String(readAll(is), StandardCharsets.UTF_8);
            if (code != 200) {
                String msg = "";
                try { msg = new JSONObject(bodyStr).optString("detail", ""); } catch (Exception ignore) {}
                throw new ProvisioningException(code, msg.isEmpty() ? ("HTTP " + code) : msg);
            }
            JSONObject res = new JSONObject(bodyStr);
            Result r = new Result(
                    res.getString("shell_url"),
                    res.getString("server_url"),
                    res.getString("auth_key"),
                    res.optString("display_name", ""),
                    res.optString("ntfy_server", ""),
                    res.optString("ntfy_topic", ""),
                    res.optString("ntfy_auth", ""));
            persist(ctx, r);
            // Persist upload credentials separately (only needed by worker/share target, not in Result).
            prefs(ctx).edit()
                    .putString(KEY_IMMICH_URL, res.optString("immich_url", ""))
                    .putString(KEY_IMMICH_KEY, res.optString("immich_api_key", ""))
                    .putString(KEY_PAPERLESS_URL, res.optString("paperless_url", ""))
                    .putString(KEY_PAPERLESS_TOKEN, res.optString("paperless_token", ""))
                    .apply();
            return r;
        } finally {
            conn.disconnect();
        }
    }

    /** Carries a user-readable error message (detail) plus the HTTP status. */
    public static final class ProvisioningException extends Exception {
        public final int status;
        public ProvisioningException(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    private static byte[] readAll(InputStream is) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) != -1) out.write(buf, 0, n);
        return out.toByteArray();
    }

    static void persist(Context ctx, Result r) {
        prefs(ctx).edit()
                .putString(KEY_SHELL_URL, r.shellUrl)
                .putString(KEY_CONTROL_URL, r.controlUrl)
                .putString(KEY_DISPLAY_NAME, r.displayName)
                .putString(KEY_NTFY_SERVER, r.ntfyServer)
                .putString(KEY_NTFY_TOPIC, r.ntfyTopic)
                .putString(KEY_NTFY_AUTH, r.ntfyAuth)
                .apply();
    }

    public static String getStoredNtfyServer(Context ctx) {
        return prefs(ctx).getString(KEY_NTFY_SERVER, "");
    }

    public static String getStoredNtfyTopic(Context ctx) {
        return prefs(ctx).getString(KEY_NTFY_TOPIC, "");
    }

    public static String getStoredNtfyAuth(Context ctx) {
        return prefs(ctx).getString(KEY_NTFY_AUTH, "");
    }

    /**
     * Replace only the ntfy credential, without repeating the whole provisioning.
     *
     * IMPORTANT: previously {@link #persist} was the ONLY place that wrote
     * {@code ntfy_auth} — i.e. only at pairing. An expired credential could therefore
     * never be healed and disabled push permanently.
     * See {@link de.claraos.companion.push.PushCredentialRefresher}.
     */
    public static void storeNtfyAuth(Context ctx, String auth) {
        prefs(ctx).edit().putString(KEY_NTFY_AUTH, auth).apply();
    }

    /** Push server and topic (from /ntfy/device-token in a direct setup). */
    public static void storeNtfyServerTopic(Context ctx, String server, String topic) {
        prefs(ctx).edit().putString(KEY_NTFY_SERVER, server).putString(KEY_NTFY_TOPIC, topic).apply();
    }

    public static String getStoredImmichUrl(Context ctx) {
        return prefs(ctx).getString(KEY_IMMICH_URL, "");
    }

    public static String getStoredImmichKey(Context ctx) {
        return prefs(ctx).getString(KEY_IMMICH_KEY, "");
    }

    public static String getStoredControlUrlOrEmpty(Context ctx) {
        String c = getStoredControlUrl(ctx);
        return c == null ? "" : c;
    }

    public static String getStoredPaperlessUrl(Context ctx) {
        return prefs(ctx).getString(KEY_PAPERLESS_URL, "");
    }

    public static String getStoredPaperlessToken(Context ctx) {
        return prefs(ctx).getString(KEY_PAPERLESS_TOKEN, "");
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
