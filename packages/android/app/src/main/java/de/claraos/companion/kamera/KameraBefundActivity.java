package de.claraos.companion.kamera;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.camera.core.CameraSelector;
import androidx.camera.extensions.ExtensionMode;
import androidx.camera.extensions.ExtensionsManager;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Shows the camera report and writes it to the log.
 *
 * <p>Purpose: answer the one question true-to-scale meal capture hinges
 * on — is this device's focus distance metrically reliable?
 *
 * <p>Note: deliberately a standalone activity and <b>no</b> change to
 * {@code ShellActivity}: a one-off measurement should not touch running code.
 * The bridge to the web UI only comes once it is clear it pays off.
 *
 * <p>Start from outside:
 * <pre>adb shell am start -n PACKAGE.debug/de.claraos.companion.kamera.KameraBefundActivity</pre>
 * The result is then also in {@code logcat -s ClaraKameraBefund}.
 */
public class KameraBefundActivity extends Activity {

    public static final String TAG = "ClaraKameraBefund";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("Kamera-Befund");

        String text;
        try {
            JSONObject befund = KameraBefund.erheben(this);
            // IMPORTANT: log ONE line per camera: logcat truncates long
            // lines, and a truncated report is worse than none — you
            // don't notice it.
            Log.w(TAG, "Gerät: " + befund.optString("geraet")
                    + " | Android " + befund.optString("android"));
            Log.w(TAG, "BESTE KALIBRIERUNG: " + befund.optString("beste_kalibrierung"));
            Log.w(TAG, "URTEIL: " + befund.optString("urteil"));
            Log.w(TAG, "GLEICHZEITIG: " + befund.opt("gleichzeitig_moegliche_kombinationen"));
            Log.w(TAG, "BASISLINIEN: " + befund.opt("basislinien")
                    + " | stereo_moeglich=" + befund.opt("stereo_moeglich"));
            JSONArray ks = befund.optJSONArray("kameras");
            for (int i = 0; ks != null && i < ks.length(); i++) {
                Log.w(TAG, "Kamera " + i + ": " + ks.optJSONObject(i));
            }
            text = lesbar(befund);
            erweiterungenPruefen();
        } catch (Exception e) {
            Log.e(TAG, "Befund fehlgeschlagen", e);
            text = "Befund fehlgeschlagen:\n" + e;
        }

        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTypeface(Typeface.MONOSPACE);
        tv.setTextSize(12f);
        tv.setPadding(28, 28, 28, 48);
        tv.setTextIsSelectable(true);
        tv.setTextColor(Color.parseColor("#E9ECEC"));
        tv.setGravity(Gravity.START);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Color.parseColor("#101314"));
        sv.addView(tv);
        setContentView(sv);
    }

    /**
     * Queries the vendor extensions (portrait, HDR, night).
     *
     * <p>Note — the reason: some devices ship {@code com.android.cameraextensions}
     * and vendor camera services even on hardened Android builds. If the vendor
     * offers {@code BOKEH} to a third-party app, the device computes a depth
     * estimate — and the only question left is whether it comes out as a file.
     *
     * <p>Runs asynchronously; the result is in the log, not on screen.
     */
    private void erweiterungenPruefen() {
        try {
            var providerZukunft = ProcessCameraProvider.getInstance(this);
            providerZukunft.addListener(() -> {
                try {
                    ProcessCameraProvider provider = providerZukunft.get();
                    var extZukunft = ExtensionsManager.getInstanceAsync(this, provider);
                    extZukunft.addListener(() -> {
                        try {
                            ExtensionsManager em = extZukunft.get();
                            int[] modi = {ExtensionMode.BOKEH, ExtensionMode.HDR,
                                          ExtensionMode.NIGHT, ExtensionMode.FACE_RETOUCH,
                                          ExtensionMode.AUTO};
                            String[] namen = {"BOKEH (Portrait)", "HDR", "NIGHT",
                                              "FACE_RETOUCH", "AUTO"};
                            StringBuilder sb = new StringBuilder();
                            for (int i = 0; i < modi.length; i++) {
                                boolean da = em.isExtensionAvailable(
                                        CameraSelector.DEFAULT_BACK_CAMERA, modi[i]);
                                sb.append(namen[i]).append('=').append(da).append("  ");
                            }
                            Log.w(TAG, "ERWEITERUNGEN (hinten): " + sb);
                        } catch (Throwable e) {
                            Log.w(TAG, "ERWEITERUNGEN: nicht abfragbar — " + e);
                        }
                    }, ContextCompat.getMainExecutor(this));
                } catch (Throwable e) {
                    Log.w(TAG, "ERWEITERUNGEN: kein Kameraanbieter — " + e);
                }
            }, ContextCompat.getMainExecutor(this));
        } catch (Throwable e) {
            Log.w(TAG, "ERWEITERUNGEN: Abfrage fehlgeschlagen — " + e);
        }
    }

    /** For the eye on the phone — the machine-readable version is in the log. */
    private static String lesbar(JSONObject b) {
        StringBuilder s = new StringBuilder();
        s.append(b.optString("geraet")).append("  ·  Android ")
         .append(b.optString("android")).append("\n\n");
        s.append("BESTE KALIBRIERUNG\n  ")
         .append(b.optString("beste_kalibrierung")).append("\n\n");
        s.append(b.optString("urteil")).append("\n");
        s.append("\n────────────────────────────\n");
        JSONArray ks = b.optJSONArray("kameras");
        for (int i = 0; ks != null && i < ks.length(); i++) {
            JSONObject k = ks.optJSONObject(i);
            if (k == null) continue;
            s.append("\nKamera ").append(k.optString("id"))
             .append(" (").append(k.optString("richtung")).append(")\n");
            zeile(s, "Fokus-Kalibrierung", k.optString("fokusdistanz_kalibrierung"));
            zeile(s, "Naheinstellgrenze", k.isNull("naheinstellgrenze_m") ? "—"
                    : String.format("%.3f m", k.optDouble("naheinstellgrenze_m")));
            zeile(s, "Brennweiten", k.optString("brennweiten_mm"));
            zeile(s, "Sensor", k.optString("sensor_mm") + " mm");
            zeile(s, "Größtes JPEG", k.optString("groesstes_jpeg"));
            zeile(s, "Tiefe / RAW / manuell",
                    k.optBoolean("kann_tiefe") + " / " + k.optBoolean("kann_raw")
                            + " / " + k.optBoolean("kann_manuell"));
            if (!k.isNull("mm_je_pixel_bei_40cm")) {
                zeile(s, "mm je Pixel @40cm",
                        String.format("%.4f", k.optDouble("mm_je_pixel_bei_40cm")));
                zeile(s, "Bildbreite @40cm",
                        String.format("%.0f mm", k.optDouble("bildbreite_bei_40cm_mm")));
            }
        }
        return s.toString();
    }

    private static void zeile(StringBuilder s, String name, String wert) {
        s.append("  ").append(String.format("%-22s", name)).append(wert).append('\n');
    }
}
