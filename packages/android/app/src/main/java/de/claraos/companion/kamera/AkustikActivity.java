package de.claraos.companion.kamera;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;

/**
 * Continuous distance measurement via (nearly) inaudible sound.
 *
 * <p>Purpose: answer the one open question — <b>does the measured distance match
 * the ruler, and does the same distance give the same result?</b>
 * Only then is it worth building the chirp into meal capture.
 *
 * <p>Usage: hold the phone flat above a table top and read the value. The
 * screen stays on. The tone is in the high band (see {@link AkustikMessung}) and
 * barely perceptible for adult ears.
 *
 * <p>Note: not just the value is shown, but the <b>spread of the last
 * measurements</b>. A number alone says nothing — a method that jumps by
 * centimeters at an unchanged distance is useless, even if the mean is right.
 */
public class AkustikActivity extends Activity {

    public static final String TAG = "ClaraAkustik";
    private static final int PAUSE_MS = 150;   // each measurement now runs several recordings
    private static final int VERLAUF = 8;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Deque<Double> letzte = new ArrayDeque<>();
    private TextView gross, klein, verlauf, kandidaten;
    private Button leerKnopf;
    private volatile boolean laeuft = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setTitle("Schall-Abstand");
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackgroundColor(Color.parseColor("#101314"));
        l.setPadding(40, 80, 40, 40);
        l.setGravity(Gravity.CENTER_HORIZONTAL);

        gross = new TextView(this);
        gross.setTextSize(56f);
        gross.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        gross.setTextColor(Color.parseColor("#63C795"));
        gross.setText("…");
        l.addView(gross);

        klein = new TextView(this);
        klein.setTextSize(15f);
        klein.setTextColor(Color.parseColor("#96A0A1"));
        klein.setPadding(0, 24, 0, 24);
        klein.setGravity(Gravity.CENTER);
        klein.setText("Telefon flach über den Tisch halten.\n"
                + "Ton: 15,5–19,5 kHz. Hörst du etwas? Bitte melden.");
        l.addView(klein);

        verlauf = new TextView(this);
        verlauf.setTextSize(13f);
        verlauf.setTypeface(Typeface.MONOSPACE);
        verlauf.setTextColor(Color.parseColor("#E9ECEC"));
        verlauf.setTextIsSelectable(true);
        l.addView(verlauf);

        // Note: the candidate list belongs on screen, not just in the log:
        // testing showed that the strongest peak is the phone's housing. Whether
        // ANY peak follows the distance can only be seen when all are shown.
        kandidaten = new TextView(this);
        kandidaten.setTextSize(12f);
        kandidaten.setTypeface(Typeface.MONOSPACE);
        kandidaten.setTextColor(Color.parseColor("#D6A44F"));
        kandidaten.setPadding(0, 28, 0, 20);
        kandidaten.setTextIsSelectable(true);
        l.addView(kandidaten);

        leerKnopf = new Button(this);
        leerKnopf.setAllCaps(false);
        leerKnopf.setText("Leermessung — Telefon frei in die Luft halten");
        leerKnopf.setOnClickListener(v -> leermessung());
        l.addView(leerKnopf);

        setContentView(l);

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1);
        }
    }

    /**
     * Records the device's own profile.
     *
     * <p>IMPORTANT: found by testing: the display stayed at 15–20 cm no matter
     * how far the phone was held away. So the strongest peak comes from the
     * housing itself, not from the table. What is recorded here counts as
     * "belongs to the device" from now on and is subtracted.
     */
    private void leermessung() {
        leerKnopf.setEnabled(false);
        leerKnopf.setText("misst … Telefon frei halten");
        boolean warLaeuft = laeuft;
        laeuft = false;
        new Thread(() -> {
            try { Thread.sleep(400); } catch (InterruptedException ignored) {}
            String s = AkustikMessung.eigenprofilAufnehmen(6);
            Log.w(TAG, "Leermessung: " + s);
            handler.post(() -> {
                leerKnopf.setEnabled(true);
                leerKnopf.setText(AkustikMessung.hatEigenprofil()
                        ? "Eigenprofil aktiv — erneut aufnehmen"
                        : "Leermessung — Telefon frei in die Luft halten");
                letzte.clear();
                klein.setText(s);
                if (warLaeuft) { laeuft = false; starten(); }
            });
        }, "leermessung").start();
    }

    @Override protected void onResume() { super.onResume(); starten(); }
    @Override protected void onPause() { laeuft = false; super.onPause(); }

    @Override
    public void onRequestPermissionsResult(int c, String[] p, int[] e) {
        super.onRequestPermissionsResult(c, p, e);
        starten();
    }

    private void starten() {
        if (laeuft) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            gross.setText("!");
            klein.setText("Mikrofon-Berechtigung fehlt.");
            return;
        }
        laeuft = true;
        new Thread(this::schleife, "akustik").start();
    }

    private void schleife() {
        while (laeuft) {
            AkustikMessung.Ergebnis r = AkustikMessung.messen();
            Log.w(TAG, r.toString());
            handler.post(() -> zeigen(r));
            try { Thread.sleep(PAUSE_MS); } catch (InterruptedException e) { return; }
        }
    }

    private void zeigen(AkustikMessung.Ergebnis r) {
        if (!r.ok()) {
            gross.setText("—");
            gross.setTextColor(Color.parseColor("#E0857A"));
            klein.setText(r.fehler);
            return;
        }
        gross.setTextColor(Color.parseColor("#63C795"));
        gross.setText(String.format(Locale.GERMANY, "%.1f cm", r.abstandM * 100));

        letzte.addLast(r.abstandM);
        while (letzte.size() > VERLAUF) letzte.removeFirst();

        double min = Double.MAX_VALUE, max = -Double.MAX_VALUE, summe = 0;
        for (double d : letzte) { min = Math.min(min, d); max = Math.max(max, d); summe += d; }
        double mittel = summe / letzte.size();

        // Note: the spread is the real statement: it tells whether the value
        // can be trusted. A mean without a spread promises an accuracy it
        // does not prove.
        klein.setText(String.format(Locale.GERMANY,
                "Mittel %.1f cm · Spanne %.1f cm über %d Messungen\nGüte %.1f",
                mittel * 100, (max - min) * 100, letzte.size(), r.guete));

        StringBuilder sb = new StringBuilder();
        for (double d : letzte) sb.append(String.format(Locale.GERMANY, "%.1f  ", d * 100));
        verlauf.setText(sb.toString().trim());
        kandidaten.setText(r.kandidaten.replace(") ", ")\n"));
    }
}
