package de.claraos.companion.vpn;

import de.claraos.companion.BuildConfig;
import android.content.Context;
import android.util.Log;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

import java.io.File;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.util.concurrent.Executor;

import claratsnet.Claratsnet;
import claratsnet.Node;
import okhttp3.OkHttpClient;

/**
 * Brings up the app's own tailnet tunnel (embedded tsnet, no system VpnService)
 * and routes the WebView traffic through this tunnel via a local HTTP proxy. The
 * proxy wants a random per-run password (all apps share 127.0.0.1); the WebView
 * answers its challenge in ShellActivity, OkHttp via {@link #tunneledClient}.
 *
 * This gives the WebView network access + MagicDNS resolution of internal shell names —
 * independent of any always-on VPN on the device (see README "Architecture").
 *
 * IMPORTANT: start() blocks (network) → do NOT call it on the main thread.
 */
public final class CompanionTunnel {

    private static final String TAG = "ClaraTunnel";
    private static Node node;
    /** Credentials of the running proxy; only ever in this process's memory. */
    private static volatile String proxyUser = "";
    private static volatile String proxyPassword = "";

    private CompanionTunnel() {}

    /**
     * Device name under which the node appears on the coordination server.
     *
     * Note: lives here instead of in ShellActivity because since 0.5.2 the push service
     * also brings the tunnel up (start after reboot, without anyone opening the app).
     * Two copies of the same formula would be a trap: with a differing name the node
     * would show up as a second entry in the tailnet.
     */
    public static String defaultHostname() {
        // Prefix = the variant's brand ("nolani-…", at home "claraos-…" as before).
        return BuildConfig.BRAND.toLowerCase(java.util.Locale.ROOT) + "-"
                + android.os.Build.MODEL.replaceAll("[^A-Za-z0-9-]", "-");
    }

    /**
     * Starts the tunnel and the local HTTP proxy. Returns the proxy port.
     * authKey is only needed the first time (then persisted state); may be empty afterwards.
     */
    public static synchronized int start(Context ctx, String controlUrl, String authKey,
                                         String hostname) throws Exception {
        if (node == null) {
            File stateDir = new File(ctx.getFilesDir(), "tsnet");
            if (!stateDir.exists() && !stateDir.mkdirs()) {
                throw new IllegalStateException("tsnet state dir nicht anlegbar: " + stateDir);
            }
            Claratsnet.setResolverAddr(BuildConfig.TAILNET_RESOLVER);
            node = Claratsnet.newNode(stateDir.getAbsolutePath(), controlUrl, hostname,
                    new AndroidInterfaceProvider());
        }
        node.startWithAuthKey(authKey == null ? "" : authKey);
        int port = (int) node.startProxy();
        proxyUser = node.proxyUser();
        proxyPassword = node.proxyPassword();
        Log.i(TAG, "tunnel up, proxy on 127.0.0.1:" + port);
        return port;
    }

    /**
     * Sets the proxy to 127.0.0.1:port for all WebViews in the process.
     * localhost must be excluded from the proxy, otherwise the proxy loops onto itself.
     */
    public static void routeWebViewThroughProxy(int port, Executor executor, Runnable onApplied) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            throw new UnsupportedOperationException("WebView PROXY_OVERRIDE nicht unterstützt");
        }
        ProxyConfig config = new ProxyConfig.Builder()
                .addProxyRule("http://127.0.0.1:" + port)
                .addDirect()                 // Fallback
                .bypassSimpleHostnames()
                .removeImplicitRules()
                .build();
        ProxyController.getInstance().setProxyOverride(config, executor, onApplied);
    }

    /**
     * Answer for the WebView's proxy challenge (onReceivedHttpAuthRequest): only for
     * our own proxy on 127.0.0.1 and its realm, otherwise null. A web page cannot
     * fake this pair — pages never load from 127.0.0.1 (cleartext is off).
     */
    public static String[] proxyCredentialsFor(String host, String realm) {
        if (!"127.0.0.1".equals(host) || !"companion".equals(realm)) return null;
        if (proxyPassword.isEmpty()) return null;
        return new String[]{proxyUser, proxyPassword};
    }

    /**
     * HTTP client through the app tunnel's proxy (for native modules: ntfy push,
     * uploads) — or, with {@code proxyPort <= 0} (direct setup without tunnel), a
     * plain client.
     */
    public static OkHttpClient tunneledClient(int proxyPort) {
        OkHttpClient.Builder b = new OkHttpClient.Builder()
                .pingInterval(java.time.Duration.ofSeconds(45)); // keep the ntfy WS alive
        if (proxyPort > 0) {
            b.proxy(new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", proxyPort)));
            b.proxyAuthenticator((route, response) -> {
                if (response.request().header("Proxy-Authorization") != null) return null; // wrong → give up
                return response.request().newBuilder()
                        .header("Proxy-Authorization",
                                okhttp3.Credentials.basic(proxyUser, proxyPassword))
                        .build();
            });
        }
        return b.build();
    }

    public static synchronized void stop() {
        if (node != null) {
            try {
                node.close();
            } catch (Exception e) {
                Log.w(TAG, "close failed", e);
            }
            node = null;
            proxyUser = "";
            proxyPassword = "";
        }
    }
}
