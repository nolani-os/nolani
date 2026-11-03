package de.claraos.companion;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import de.claraos.companion.device.DeviceControlBridge;
import de.claraos.companion.push.NtfyPushService;
import de.claraos.companion.push.PushCredentialRefresher;
import de.claraos.companion.update.SelfUpdateManager;
import de.claraos.companion.update.UpdateCheckWorker;
import de.claraos.companion.upload.UploadScheduler;
import de.claraos.companion.vpn.CompanionTunnel;

/**
 * Entry activity. Two paths:
 *  - not set up yet → onboarding (invite token → {@link ProvisioningClient});
 *  - set up → bring up the app tunnel, route the WebView through the tunnel proxy, load the shell.
 *
 * IMPORTANT (network prerequisite): the WebView traffic runs through the app's own
 * tsnet tunnel (see {@link CompanionTunnel} / README "Architecture").
 */
public class ShellActivity extends AppCompatActivity {

    private static final String TAG = "ClaraShell";

    // Only these hosts get mic/camera (voice input). The shell URL itself comes from provisioning.
    private static final String[] TRUSTED_HOST_SUFFIXES = BuildConfig.TRUSTED_HOST_SUFFIXES;
    private static final int REQ_PERMS = 1;
    private static final int REQ_FILE_CHOOSER = 2;
    private static final int REQ_NOTIFICATIONS = 3;

    private WebView webView;
    /** Target of the running camera capture (ACTION_IMAGE_CAPTURE returns no `data`). */
    private Uri aufnahmeZiel;
    private DeviceControlBridge deviceControl;
    private ValueCallback<Uri[]> pendingFileChooser;
    private PermissionRequest pendingWebPermissionRequest;

    /**
     * Random per process. Our own notifications put it into the intent that opens a
     * page; ShellActivity is exported (launcher, links), so any other app could send
     * it an https URL — without this value that URL is not loaded.
     */
    public static final String LINK_NONCE = java.util.UUID.randomUUID().toString();
    public static final String EXTRA_LINK_NONCE = "de.claraos.companion.LINK_NONCE";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        enterImmersiveMode();
        ensureNotificationPermission();

        String shellUrl = ProvisioningClient.getStoredShellUrl(this);
        String controlUrl = ProvisioningClient.getStoredControlUrl(this);
        // Note: an invitation link counts ALSO on an already paired device.
        // Previously it was discarded here — re-pairing then only worked via "clear
        // app data", which throws away the tailnet key too: the device shows up as a
        // NEW node, the netmap changes and running connections on other apps break.
        // With this branch the node stays, only the credentials are renewed — the way
        // out of a dead ntfy token.
        if (shellUrl != null && controlUrl != null) {
            // Cold start when set up: build the WebView, then bring the tunnel up + load.
            // If the start comes from a push notification, its click URL
            // (`…/?app=…&do=…`) is the intent data — that is loaded, not the stored
            // start page. Previously it was silently discarded here.
            buildWebView();
            String ziel = shellDeepLinkFromIntent(getIntent());
            if (controlUrl.isEmpty()) {
                loadDirect(ziel != null ? ziel : shellUrl);   // cell: no tunnel
            } else {
                bringUpTunnelThenLoad(ziel != null ? ziel : shellUrl, controlUrl);
            }
            askBeforeRepairing();
        } else {
            showOnboarding();
        }
    }

    // ── Onboarding ───────────────────────────────────────────────────────────

    /**
     * A pairing link reached an already paired device (from a website, a message or
     * another app). It never switches by itself: the user sees the current and the
     * new server and decides; the setup screen then still needs its own tap.
     */
    private void askBeforeRepairing() {
        String link = serverFromIntent();
        boolean invite = tokenFromIntent() != null;
        if (link == null && !invite) return;
        String current = ProvisioningClient.getStoredShellDomain(this);
        String message = invite
                ? "Ein Einladungslink möchte die Zugangsdaten dieses Geräts erneuern."
                : "Ein Link möchte dieses Gerät mit " + Uri.parse(link).getHost() + " verbinden.";
        if (current != null) message += "\n\nDerzeit verbunden mit: " + current;
        new android.app.AlertDialog.Builder(this)
                .setTitle("Neu koppeln?")
                .setMessage(message)
                .setPositiveButton("Weiter", (d, w) -> showOnboarding())
                .setNegativeButton("Abbrechen", (d, w) -> setIntent(new Intent()))
                .show();
    }

    /** Token from a claraos://provision?token=… link (builds with a pairing server), otherwise null. */
    private String tokenFromIntent() {
        if (ProvisioningClient.DEFAULT_BACKEND.isEmpty()) return null;
        Uri data = getIntent() != null ? getIntent().getData() : null;
        if (data == null || !BuildConfig.LINK_SCHEME.equals(data.getScheme())) return null;
        String t = data.getQueryParameter("token");
        return (t == null || t.trim().isEmpty()) ? null : t.trim();
    }

    /**
     * Server from a claraos://connect?server=… link (external cell), already
     * normalized and checked against {@link ProvisioningClient#DIRECT_DOMAIN} — otherwise null.
     */
    @Nullable
    private String serverFromIntent() {
        Uri data = getIntent() != null ? getIntent().getData() : null;
        if (data == null || !BuildConfig.LINK_SCHEME.equals(data.getScheme())
                || !"connect".equals(data.getHost())) {
            return null;
        }
        return ProvisioningClient.normalizeDirectServer(data.getQueryParameter("server"));
    }

    /**
     * https target from a push notification (NtfyPushService sets the click URL as
     * intent data plus {@link #LINK_NONCE}). Only from our own notifications, only
     * https, only trusted hosts — otherwise null.
     */
    @Nullable
    private String shellDeepLinkFromIntent(@Nullable Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data == null) return null;
        if (!LINK_NONCE.equals(intent.getStringExtra(EXTRA_LINK_NONCE))) return null;
        if (!"https".equals(data.getScheme())) return null;
        String host = data.getHost();
        if (host == null || !isTrustedHost(host)) return null;
        return data.toString();
    }

    /**
     * The app is already running (launchMode singleTask) and a push is tapped —
     * previously the intent arrived nowhere, the app was only brought to the front. Now
     * the shell loads the notification's target; the boot deep link (`?app=…&do=…`) does the rest.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (serverFromIntent() != null || tokenFromIntent() != null) {
            if (ProvisioningClient.getStoredControlUrl(this) != null) askBeforeRepairing();
            else showOnboarding();             // still in setup: just fill in the link
            return;
        }
        String ziel = shellDeepLinkFromIntent(intent);
        if (ziel != null && webView != null) {
            Log.i(TAG, "push deep link -> " + ziel);
            webView.loadUrl(ziel);
        }
    }

    private void showOnboarding() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);

        boolean alreadyPaired = ProvisioningClient.getStoredControlUrl(this) != null;

        TextView title = new TextView(this);
        title.setText(BuildConfig.BRAND + (alreadyPaired ? " neu koppeln" : " einrichten"));
        title.setTextSize(22);
        title.setPadding(0, 0, 0, pad);

        TextView hint = new TextView(this);
        hint.setText(alreadyPaired
                ? "Erneuert die Zugangsdaten dieses Geräts. Nichts geht verloren — "
                  + "das Gerät bleibt dasselbe und muss nicht neu ins Netz aufgenommen werden."
                : "Gib den Einladungscode aus deinem Einladungslink ein.");
        hint.setPadding(0, 0, 0, pad);

        EditText tokenField = new EditText(this);
        tokenField.setHint("Einladungscode");
        tokenField.setSingleLine(true);

        Button submit = new Button(this);
        submit.setText(alreadyPaired ? "Neu koppeln" : "Verbinden");

        // Invitation (pairing server of the build variant). The generic build has none:
        // there the user connects by address below.
        boolean hasPairingServer = !ProvisioningClient.DEFAULT_BACKEND.isEmpty();
        root.addView(title);
        if (hasPairingServer) {
            root.addView(hint);
            root.addView(tokenField);
            root.addView(submit);
        }

        // Direct: publicly reachable server, no invitation needed — the shell handles
        // login itself. Optionally through a tunnel the user configures (any
        // Tailscale-compatible coordination server + auth key).
        TextView directHint = new TextView(this);
        directHint.setText(hasPairingServer
                ? "Oder direkt mit einer öffentlichen " + BuildConfig.BRAND + "-Instanz verbinden:"
                : "Adresse deines " + BuildConfig.BRAND + "-Servers:");
        directHint.setPadding(0, hasPairingServer ? pad * 2 : 0, 0, pad / 2);
        EditText serverField = new EditText(this);
        serverField.setHint(hasPairingServer ? "Server-Adresse, z. B. demo.claraos.de"
                                             : "Server-Adresse, z. B. example.org");
        serverField.setSingleLine(true);
        android.widget.CheckBox viaTunnel = new android.widget.CheckBox(this);
        viaTunnel.setText("Über einen Tunnel verbinden (Tailscale/Headscale)");
        EditText controlField = new EditText(this);
        controlField.setHint("Koordinationsserver (leer = Tailscale)");
        controlField.setSingleLine(true);
        EditText authKeyField = new EditText(this);
        authKeyField.setHint("Auth-Key");
        authKeyField.setSingleLine(true);
        authKeyField.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        controlField.setVisibility(View.GONE);
        authKeyField.setVisibility(View.GONE);
        viaTunnel.setOnCheckedChangeListener((b, on) -> {
            controlField.setVisibility(on ? View.VISIBLE : View.GONE);
            authKeyField.setVisibility(on ? View.VISIBLE : View.GONE);
        });
        Button direct = new Button(this);
        direct.setText(hasPairingServer ? "Direkt verbinden" : "Verbinden");
        root.addView(directHint);
        root.addView(serverField);
        root.addView(viaTunnel);
        root.addView(controlField);
        root.addView(authKeyField);
        root.addView(direct);
        setContentView(root);

        direct.setOnClickListener(v -> {
            String url = ProvisioningClient.normalizeDirectServer(serverField.getText().toString());
            if (url == null) {
                Toast.makeText(this, ProvisioningClient.DIRECT_DOMAIN.isEmpty()
                        ? "Bitte eine gültige https-Adresse eingeben (z. B. example.org)."
                        : "Nur https-Adressen unter " + ProvisioningClient.DIRECT_DOMAIN
                          + " sind möglich.", Toast.LENGTH_LONG).show();
                return;
            }
            if (!viaTunnel.isChecked()) {
                ProvisioningClient.storeDirect(this, url);
                buildWebView();
                loadDirect(url);
                return;
            }
            String control = ProvisioningClient.normalizeControlUrl(controlField.getText().toString());
            String authKey = authKeyField.getText().toString().trim();
            if (control == null) {
                Toast.makeText(this, "Koordinationsserver: bitte eine https-Adresse eingeben.",
                        Toast.LENGTH_LONG).show();
                return;
            }
            if (authKey.isEmpty()) {
                Toast.makeText(this, "Bitte den Auth-Key eingeben.", Toast.LENGTH_LONG).show();
                return;
            }
            direct.setEnabled(false);
            direct.setText("Verbinde …");
            new Thread(() -> {
                try {
                    int proxyPort = CompanionTunnel.start(this, control, authKey, hostname());
                    // Stored only once the tunnel is up — a typo must not leave a dead setup.
                    ProvisioningClient.storeTunnel(this, url, control);
                    onTunnelUp(proxyPort, true);
                    runOnUiThread(() -> {
                        buildWebView();
                        CompanionTunnel.routeWebViewThroughProxy(
                                proxyPort, ContextCompat.getMainExecutor(this), () -> webView.loadUrl(url));
                    });
                } catch (Exception e) {
                    Log.e(TAG, "tunnel setup failed", e);
                    runOnUiThread(() -> {
                        direct.setEnabled(true);
                        direct.setText(hasPairingServer ? "Direkt verbinden" : "Verbinden");
                        Toast.makeText(this, "Tunnel fehlgeschlagen: " + e.getMessage(),
                                Toast.LENGTH_LONG).show();
                    });
                }
            }, "companion-tunnel-setup").start();
        });

        String linkServer = serverFromIntent();
        if (linkServer != null) {
            serverField.setText(linkServer);
            // Only a not-yet-paired device of the home build connects without asking: its
            // links can only point into its own domain. The generic build accepts any
            // server, so a link only fills in the address — connecting takes a tap.
            // A device in a tunnel setup never switches silently via a link either.
            if (!alreadyPaired && !ProvisioningClient.DIRECT_DOMAIN.isEmpty()) direct.performClick();
        }

        // App opened via claraos://provision?token=… → fill in the code and start right away.
        String linkToken = tokenFromIntent();
        if (linkToken != null) {
            tokenField.setText(linkToken);
            hint.setText(alreadyPaired
                    ? "Einladung erkannt — tippe auf „Neu koppeln“, um die Zugangsdaten zu erneuern."
                    : "Einladung erkannt — Einrichtung läuft …");
        }

        submit.setOnClickListener(v -> {
            String token = tokenField.getText().toString().trim();
            if (token.isEmpty()) {
                Toast.makeText(this, "Bitte Einladungscode eingeben.", Toast.LENGTH_SHORT).show();
                return;
            }
            submit.setEnabled(false);
            submit.setText("Verbinde …");
            new Thread(() -> {
                try {
                    String device = android.os.Build.MODEL;
                    ProvisioningClient.Result r = ProvisioningClient.provision(
                            this, ProvisioningClient.DEFAULT_BACKEND, token, device);
                    // Bring the tunnel up right away with the fresh pre-auth key, then the shell.
                    int proxyPort = CompanionTunnel.start(this, r.controlUrl, r.preauthKey, hostname());
                    // On re-pairing the push service may already be running — with the old
                    // token. Hence force a reconnect here instead of skipping it.
                    onTunnelUp(proxyPort, true);
                    runOnUiThread(() -> {
                        buildWebView(); // tunnel already running here → only proxy + load
                        CompanionTunnel.routeWebViewThroughProxy(
                                proxyPort, ContextCompat.getMainExecutor(this), () -> webView.loadUrl(r.shellUrl));
                    });
                } catch (Exception e) {
                    Log.e(TAG, "provision/connect failed", e);
                    runOnUiThread(() -> {
                        submit.setEnabled(true);
                        submit.setText("Verbinden");
                        Toast.makeText(this, "Fehlgeschlagen: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    });
                }
            }, "companion-provision").start();
        });

        // Deep link on a fresh device → no tapping needed. A paired device re-pairs only
        // on the user's tap (askBeforeRepairing showed the servers first).
        if (linkToken != null && hasPairingServer && !alreadyPaired) submit.performClick();
    }

    // ── Full screen ───────────────────────────────────────────────────────────
    // Hide status and navigation bars; a swipe from the edge shows them briefly
    // (standard immersive UX). Deliberately WITHOUT setDecorFitsSystemWindows(false):
    // the layout stays "fitted" so the keyboard keeps shrinking the WebView via
    // adjustResize instead of covering the chat input field.
    private void enterImmersiveMode() {
        WindowInsetsControllerCompat c =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // After dialogs/task switches Android shows the bars again → hide them again.
        if (hasFocus) enterImmersiveMode();
    }

    // ── Set-up path: WebView + tunnel ─────────────────────────────────────────

    private void buildWebView() {
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // voice TTS without an extra tap
        s.setUserAgentString(s.getUserAgentString() + " ClaraOSCompanion/" + versionName());

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);

        // Native bridge (contract: control-api.md "Android companion"): document
        // scanner + device control, reachable ONLY from the paired shell origin's
        // top frame. Deliberately no addJavascriptInterface: that object lands in
        // every frame, including foreign iframes the shell embeds.
        String shellOrigin = ProvisioningClient.originOf(ProvisioningClient.getStoredShellUrl(this));
        deviceControl = new DeviceControlBridge(this, webView, shellOrigin);
        installBridge(shellOrigin);
        deviceControl.startWatching();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String host = req.getUrl().getHost();
                if (host != null && isTrustedHost(host)) {
                    return false; // keep shell + Authentik in the WebView
                }
                openExternally(req.getUrl()); // foreign links open in the browser
                return true;
            }

            /** The tunnel proxy's challenge (407) — answered only for our own proxy. */
            @Override
            public void onReceivedHttpAuthRequest(WebView view, android.webkit.HttpAuthHandler handler,
                                                  String host, String realm) {
                String[] cred = CompanionTunnel.proxyCredentialsFor(host, realm);
                // useHttpAuthUsernamePassword() is false once the proxy rejected an
                // answer for this request — then stop instead of asking forever.
                if (cred != null && handler.useHttpAuthUsernamePassword()) {
                    handler.proceed(cred[0], cred[1]);
                } else {
                    super.onReceivedHttpAuthRequest(view, handler, host, realm);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "page finished " + url);
                CookieManager.getInstance().flush();
                // Update check only HERE. Previously it ran right after the
                // tunnel came up — before anything was loaded, competing with
                // the connection setup. The 6 h minimum interval lives in the
                // manager, so triggering it several times is harmless.
                SelfUpdateManager.check(ShellActivity.this);
                maybeSetUpDirectPush(url);
            }

            /**
             * Without this method Android kills the whole app as soon as the WebView's
             * renderer dies. On some devices a PDF in an iframe took the renderer down
             * (Android WebView has no PDF viewer) — and since the shell restores open
             * windows on start, the app then crashed on EVERY start. Now: rebuild the
             * WebView and after a real crash load the shell in safe start (without
             * saved windows). If the system only killed the renderer for memory, it
             * reloads normally.
             */
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Log.e(TAG, "renderer gone, didCrash=" + detail.didCrash());
                webViewNeuAufbauen(view, detail.didCrash());
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                String origin = request.getOrigin().getHost();
                if (origin == null || !isTrustedHost(origin)) {
                    request.deny();
                    return;
                }
                List<String> needed = missingRuntimePerms(request.getResources());
                if (needed.isEmpty()) {
                    request.grant(request.getResources());
                } else {
                    pendingWebPermissionRequest = request;
                    requestPermissions(needed.toArray(new String[0]), REQ_PERMS);
                }
            }

            /**
             * IMPORTANT: the camera used to be missing here.
             *
             * `<input type="file" accept="image/*" capture="environment">` means:
             * the user wants to CAPTURE, not pick. `params.createIntent()` does NOT
             * carry that intent — it always builds a picker intent. The query meant
             * for this is `isCaptureEnabled()`. Result on the device: tapping
             * "Camera" in the chat opened a file picker dialog.
             *
             * Note: strictly additive: the picker intent stays the BASE intent of
             * the chooser. If anything goes wrong in the camera branch (no folder,
             * no camera app, FileProvider error), everything falls back to exactly
             * the previous behavior — never to less.
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
                pendingFileChooser = callback;
                aufnahmeZiel = null;
                try {
                    Intent start = params.createIntent();
                    Intent aufnahme = kameraIntent(params);
                    if (aufnahme != null) {
                        Intent chooser = Intent.createChooser(start, "Foto");
                        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{aufnahme});
                        start = chooser;
                    }
                    startActivityForResult(start, REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    Log.w(TAG, "Dateiauswahl fehlgeschlagen", e);
                    pendingFileChooser = null;
                    aufnahmeZiel = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });

        // The WebView does not download by itself → hand over to DownloadManager (with session cookie).
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            // Only https downloads from the paired system get the session cookie and land
            // silently in Downloads; anything else (a foreign frame) goes to the browser.
            Uri src = Uri.parse(url);
            if (!"https".equals(src.getScheme()) || src.getHost() == null
                    || !isTrustedHost(src.getHost())) {
                openExternally(src);
                return;
            }
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setMimeType(mimeType);
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null) req.addRequestHeader("Cookie", cookies);
                req.addRequestHeader("User-Agent", userAgent);
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                req.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                dm.enqueue(req);
                Toast.makeText(this, "Download: " + fileName, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Log.e(TAG, "download failed", e);
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack();
                else finish();
            }
        });
    }

    /** Hands a link to another app: web, mail and phone only; never crashes on a missing app. */
    private void openExternally(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null) return;
        switch (scheme.toLowerCase(java.util.Locale.ROOT)) {
            case "https": case "http": case "mailto": case "tel": break;
            default:
                Log.w(TAG, "link scheme not opened: " + scheme);
                return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri)
                    .addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (android.content.ActivityNotFoundException e) {
            Toast.makeText(this, "Keine App für diesen Link", Toast.LENGTH_SHORT).show();
        }
    }

    /** Times of the last renderer crashes — brake against a rebuild loop. */
    private final ArrayList<Long> rendererAbstuerze = new ArrayList<>();

    private void webViewNeuAufbauen(WebView tot, boolean absturz) {
        String zuletzt = tot.getUrl();
        if (deviceControl != null) deviceControl.stopWatching();
        tot.destroy();
        webView = null;

        long jetzt = SystemClock.elapsedRealtime();
        rendererAbstuerze.removeIf(t -> jetzt - t > 120_000);
        rendererAbstuerze.add(jetzt);
        if (rendererAbstuerze.size() > 3) {
            // If it keeps crashing even in safe start, rebuilding does not help —
            // better stop and say so than flicker endlessly.
            TextView t = new TextView(this);
            t.setText("Die Ansicht ist mehrfach abgestürzt. Bitte die App schließen und neu öffnen.");
            t.setGravity(Gravity.CENTER);
            t.setPadding(48, 48, 48, 48);
            setContentView(t);
            return;
        }

        buildWebView();
        String shellUrl = ProvisioningClient.getStoredShellUrl(this);
        String ziel;
        if (absturz || zuletzt == null) {
            ziel = Uri.parse(shellUrl).buildUpon()
                    .appendQueryParameter("sicherer_start", "1").build().toString();
            Toast.makeText(this, "Ansicht abgestürzt — neu geladen, offene Fenster geschlossen",
                    Toast.LENGTH_LONG).show();
        } else {
            ziel = zuletzt;
        }
        Log.i(TAG, "webview rebuilt -> " + ziel);
        webView.loadUrl(ziel);
    }

    /**
     * Direct mode (external cell): load the shell without a tunnel. No push (the cell
     * has no ntfy), no photo uploads — only the daily update check.
     */
    private void loadDirect(String url) {
        UpdateCheckWorker.schedule(this);
        maybeStartPush(0, false);   // no-op until push credentials were fetched once
        webView.loadUrl(url);
    }

    /**
     * Brings up the app's own tailnet tunnel (background thread), routes the WebView
     * through its local proxy and THEN loads the shell. Empty authKey → persisted state.
     */
    private void bringUpTunnelThenLoad(String shellUrl, String controlUrl) {
        new Thread(() -> {
            try {
                int proxyPort = CompanionTunnel.start(this, controlUrl, "", hostname());
                onTunnelUp(proxyPort);
                runOnUiThread(() -> CompanionTunnel.routeWebViewThroughProxy(
                        proxyPort, ContextCompat.getMainExecutor(this), () -> webView.loadUrl(shellUrl)));
            } catch (Exception e) {
                Log.e(TAG, "tunnel start failed", e);
                runOnUiThread(() -> Toast.makeText(
                        this, "Verbindung fehlgeschlagen: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }, "companion-tunnel").start();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private String hostname() {
        return CompanionTunnel.defaultHostname();
    }

    /**
     * One bridge request from the shell: {id, m, a:[...]} → {id, ok, data|error}.
     * Runs on the UI thread. Errors travel as {ok:false} because the shim turns
     * them into promise rejections.
     */
    private void onBridgeMessage(String shellOrigin, WebMessageCompat message,
                                 Uri sourceOrigin, boolean isMainFrame,
                                 JavaScriptReplyProxy reply) {
        // The origin rule already limits injection; check again per message, and
        // refuse subframes even of the same origin (the shell never calls from one).
        if (!isMainFrame || sourceOrigin == null
                || !shellOrigin.equals(sourceOrigin.toString())) {
            Log.w(TAG, "bridge call refused from " + sourceOrigin + " main=" + isMainFrame);
            return;
        }
        int id = 0;
        JSONObject res = new JSONObject();
        try {
            JSONObject req = new JSONObject(String.valueOf(message.getData()));
            id = req.optInt("id");
            JSONArray args = req.optJSONArray("a");
            if (args == null) args = new JSONArray();
            Object data = dispatchBridge(req.optString("m"), args);
            res.put("id", id).put("ok", true).put("data", data);
        } catch (Exception e) {
            try {
                res = new JSONObject().put("id", id).put("ok", false)
                        .put("error", String.valueOf(e.getMessage()));
            } catch (Exception impossible) {
                return;
            }
        }
        reply.postMessage(res.toString());
    }

    private Object dispatchBridge(String method, JSONArray args) throws Exception {
        switch (method) {
            case "scanDocument":
                startActivity(new Intent(this,
                        de.claraos.companion.upload.DocumentScanActivity.class));
                return JSONObject.NULL;
            case "state":
                return new JSONObject(deviceControl.stateJson());
            case "canWriteSettings":
                return deviceControl.canWriteSettings();
            case "set":
                requireDeviceControl();
                return new JSONObject(deviceControl.set(args.getString(0), args.getString(1)));
            case "openPanel":
                requireDeviceControl();
                deviceControl.openPanel(args.getString(0));
                return JSONObject.NULL;
            case "requestWriteSettings":
                requireDeviceControl();
                deviceControl.requestWriteSettings();
                return JSONObject.NULL;
            default:
                throw new IllegalArgumentException("unbekannte Funktion");
        }
    }

    private void requireDeviceControl() {
        if (!deviceControlAllowed()) throw new SecurityException("Gerätesteuerung nicht erlaubt");
    }

    /** "Not now" for the rest of this run — no second dialog on every tap. */
    private volatile boolean deviceControlDeclined = false;
    private volatile boolean deviceConsentShowing = false;

    /**
     * Gate for every CHANGING device call from the shell. Reading the state stays
     * open (the shell needs it to draw its controls). Not allowed yet → ask once
     * natively, naming the server; the call itself is refused either way and the
     * user simply taps again after allowing.
     */
    private boolean deviceControlAllowed() {
        if (ProvisioningClient.isDeviceControlAllowed(this)) return true;
        if (!deviceControlDeclined && !deviceConsentShowing) {
            deviceConsentShowing = true;
            String domain = ProvisioningClient.getStoredShellDomain(this);
            runOnUiThread(() -> new android.app.AlertDialog.Builder(this)
                    .setTitle("Gerätesteuerung erlauben?")
                    .setMessage((domain != null ? domain : "Der Server")
                            + " möchte Einstellungen dieses Geräts ändern: Lautstärke, "
                            + "Helligkeit, WLAN, Bluetooth.")
                    .setPositiveButton("Erlauben", (d, w) ->
                            ProvisioningClient.setDeviceControlAllowed(this, true))
                    .setNegativeButton("Nicht erlauben", (d, w) -> deviceControlDeclined = true)
                    .setOnDismissListener(d -> deviceConsentShowing = false)
                    .show());
        }
        return false;
    }

    /** Name of the message port the shim takes over; never used by the shell itself. */
    private static final String BRIDGE_PORT = "ClaraOSBridgePort";

    /**
     * Builds the contract-compliant window.ClaraOSNative (promises) on top of a
     * WebMessageListener port. Both the port and the shim exist only in frames of
     * the paired shell origin; without the WebView features (very old WebView) or
     * without a paired origin there is no bridge and the shell degrades as with
     * old companions.
     */
    private void installBridge(String shellOrigin) {
        if (shellOrigin == null
                || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Log.w(TAG, "no native bridge (origin=" + shellOrigin + ")");
            return;
        }
        Set<String> origins = Collections.singleton(shellOrigin);
        WebViewCompat.addWebMessageListener(webView, BRIDGE_PORT, origins,
                (view, message, sourceOrigin, isMainFrame, reply) ->
                        onBridgeMessage(shellOrigin, message, sourceOrigin, isMainFrame, reply));
        String shim =
            "(function(){" +
            "if(window.top!==window)return;" +
            "var port=window." + BRIDGE_PORT + "; if(!port) return;" +
            "var seq=0,pending={};" +
            "port.onmessage=function(ev){var r;try{r=JSON.parse(ev.data);}catch(e){return;}" +
              "var p=pending[r.id];if(!p)return;delete pending[r.id];" +
              "if(r.ok)p.res(r.data);else p.rej(new Error(r.error||'Fehler'));};" +
            "function call(m,a){return new Promise(function(res,rej){" +
              "var id=++seq;pending[id]={res:res,rej:rej};" +
              "port.postMessage(JSON.stringify({id:id,m:m,a:a||[]}));});}" +
            "function quiet(p){p.catch(function(){});}" +
            "window.ClaraOSNative={" +
              "version:" + JSONObject.quote(versionName()) + "," +
              "caps:['device-control-v1','scan-document']," +
              "scanDocument:function(){quiet(call('scanDocument'));}," +
              "device:{" +
                "getState:function(){return call('state');}," +
                "set:function(section,payload){" +
                  "return call('set',[String(section),JSON.stringify(payload||{})]);}," +
                "get:function(){return Promise.reject(new Error('auf Android nicht verfügbar'));}," +
                "connect:function(){return Promise.reject(new Error('auf Android nicht verfügbar'));}," +
                "openPanel:function(name){quiet(call('openPanel',[String(name)]));}," +
                "requestPermission:function(section){" +
                  "if(section!=='brightness')return Promise.resolve({granted:false});" +
                  "return call('requestWriteSettings').then(function(){" +
                    "return new Promise(function(res){" +
                      "function once(){if(document.visibilityState==='visible'){" +
                        "document.removeEventListener('visibilitychange',once);" +
                        "setTimeout(function(){call('canWriteSettings').then(" +
                          "function(g){res({granted:!!g});},function(){res({granted:false});});},300);}}" +
                      "document.addEventListener('visibilitychange',once);});}," +
                    "function(){return {granted:false};});}" +
              "}};" +
            "})();";
        WebViewCompat.addDocumentStartJavaScript(webView, shim, origins);
    }

    /** After tunnel up: start background services (photo sync + ntfy push), each config-gated. */
    private void onTunnelUp(int proxyPort) {
        onTunnelUp(proxyPort, false);
    }

    /** @param forcePush discard the existing ntfy connection (after re-pairing). */
    private void onTunnelUp(int proxyPort, boolean forcePush) {
        UploadScheduler.schedule(this);        // photo→Immich (no-op without Immich config)
        maybeStartPush(proxyPort, forcePush);  // ntfy push (no-op without ntfy config)
        UpdateCheckWorker.schedule(this);      // daily update check
        // Note: the update check itself NO longer runs here but in
        // onPageFinished — here it ran before the shell's first load and
        // failed because the session was still missing.
    }

    /**
     * Starts the ntfy push foreground service through the app tunnel — but only if
     * provisioning delivered an ntfy config (per-user topic/app password). Without a
     * per-user ntfy provisioning, push simply stays off (no error).
     */
    private void maybeStartPush(int proxyPort, boolean force) {
        String server = ProvisioningClient.getStoredNtfyServer(this);
        String topic = ProvisioningClient.getStoredNtfyTopic(this);
        if (server.isEmpty() || topic.isEmpty()) return;
        Intent i = new Intent(this, NtfyPushService.class)
                .putExtra(NtfyPushService.EXTRA_SERVER, server)
                .putExtra(NtfyPushService.EXTRA_TOPIC, topic)
                .putExtra(NtfyPushService.EXTRA_AUTH, ProvisioningClient.getStoredNtfyAuth(this))
                .putExtra(NtfyPushService.EXTRA_PROXY_PORT, proxyPort)
                .putExtra(NtfyPushService.EXTRA_FORCE_RECONNECT, force);
        startForegroundService(i);
    }

    /**
     * Direct setup (no invitation, so no push credentials from provisioning): once the
     * shell itself has loaded — i.e. the user is signed in — fetch this device's push
     * credentials with the session and start the push service. Only on the shell host
     * (not on the login pages), only while none are stored, at most every 10 minutes
     * (the refresher's own limit). A server without push answers 404 — then nothing.
     */
    private void maybeSetUpDirectPush(String url) {
        if (!ProvisioningClient.isDirect(this)) return;
        if (!ProvisioningClient.getStoredNtfyTopic(this).isEmpty()) return;
        String shellUrl = ProvisioningClient.getStoredShellUrl(this);
        Uri page = Uri.parse(url);
        if (shellUrl == null || page.getHost() == null
                || !page.getHost().equalsIgnoreCase(Uri.parse(shellUrl).getHost())) {
            return;
        }
        new Thread(() -> {
            if (PushCredentialRefresher.erneuere(this, 0) != null) {
                Log.i(TAG, "direct setup: push credentials fetched");
                runOnUiThread(() -> maybeStartPush(0, true));
            }
        }, "companion-direct-push").start();
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    /**
     * Hosts that get microphone, camera, push targets and the device bridge: the build
     * variant's fixed suffixes plus the domain this device connected to (and its
     * subdomains, where the shell's apps live). Nothing else.
     */
    private boolean isTrustedHost(String host) {
        host = host.toLowerCase(java.util.Locale.ROOT);
        for (String suffix : TRUSTED_HOST_SUFFIXES) {
            if (host.endsWith(suffix)) return true;
        }
        String d = ProvisioningClient.getStoredShellDomain(this);
        return d != null && (host.equals(d) || host.endsWith("." + d));
    }

    private List<String> missingRuntimePerms(String[] webResources) {
        List<String> needed = new ArrayList<>();
        for (String res : webResources) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.RECORD_AUDIO);
            }
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                    && checkSelfPermission(Manifest.permission.CAMERA)
                    != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.CAMERA);
            }
        }
        return needed;
    }

    /**
     * Requests the notification permission (Android 13+ runtime permission).
     *
     * IMPORTANT (found on a real device): the permission was only in the manifest and
     * was NEVER requested — {@code POST_NOTIFICATIONS: granted=false}. The push service ran,
     * the WebSocket was connected, incoming messages were silently discarded by the system.
     * A push channel you cannot see is no push channel; and the bug is invisible from
     * outside, because server-side everything looks like success (ntfy: HTTP 200).
     */
    private void ensureNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) return;   // granted automatically before 13
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_NOTIFICATIONS) return;   // denial is allowed — only push is lost then
        if (code == REQ_PERMS && pendingWebPermissionRequest != null) {
            PermissionRequest req = pendingWebPermissionRequest;
            pendingWebPermissionRequest = null;
            if (missingRuntimePerms(req.getResources()).isEmpty()) req.grant(req.getResources());
            else req.deny();
        }
    }

    /**
     * Camera intent for `<input capture>` — or null if it is not possible here.
     * Every failure returns null; the caller then uses the plain picker intent,
     * i.e. exactly the previous behavior.
     */
    @Nullable
    private Intent kameraIntent(WebChromeClient.FileChooserParams params) {
        try {
            if (!params.isCaptureEnabled()) return null;
            String[] typen = params.getAcceptTypes();
            boolean bild = (typen == null || typen.length == 0);
            if (typen != null) {
                for (String typ : typen) {
                    if (typ != null && typ.toLowerCase().contains("image")) bild = true;
                }
            }
            if (!bild) return null;   // video/audio capture stays as before
            File ordner = new File(getCacheDir(), "aufnahmen");
            if (!ordner.isDirectory() && !ordner.mkdirs()) return null;
            File ziel = new File(ordner, "aufnahme-" + System.currentTimeMillis() + ".jpg");
            Uri uri = FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", ziel);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            // Note: since Android 11 `resolveActivity` only answers if the intent is
            // declared in the manifest under <queries> — otherwise the app does not
            // see the camera app although it exists. The entry is in the manifest.
            if (i.resolveActivity(getPackageManager()) == null) return null;
            aufnahmeZiel = uri;
            return i;
        } catch (Exception e) {
            Log.w(TAG, "Kamera-Intent nicht moeglich", e);
            return null;
        }
    }

    @Override
    protected void onActivityResult(int code, int resultCode, Intent data) {
        if (code == REQ_FILE_CHOOSER && pendingFileChooser != null) {
            Uri[] ergebnis = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            // Note: ACTION_IMAGE_CAPTURE returns NO `data` — the image is at the
            // URI we passed ourselves. Without this branch null would come back
            // and the page would read "cancelled" although a photo exists.
            if (ergebnis == null && resultCode == RESULT_OK && aufnahmeZiel != null) {
                ergebnis = new Uri[]{aufnahmeZiel};
            }
            aufnahmeZiel = null;
            pendingFileChooser.onReceiveValue(ergebnis);
            pendingFileChooser = null;
            return;
        }
        super.onActivityResult(code, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (deviceControl != null) deviceControl.stopWatching();
        if (webView != null) CookieManager.getInstance().flush();
        super.onDestroy();
    }
}
