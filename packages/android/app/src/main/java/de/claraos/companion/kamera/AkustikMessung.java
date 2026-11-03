package de.claraos.companion.kamera;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.util.Log;

/**
 * Distance measurement via sound — (nearly) inaudible.
 *
 * <p>Why at all: several paths via camera and radio were measured and ruled out.
 * Sound is the <b>only echo method on a phone</b> — it needs no counterpart, just
 * a surface that reflects. And only a single number is needed: the distance to
 * the table. Once that is known, the optics provide the scale.
 *
 * <h3>Why it is inaudible</h3>
 * The chirp runs from {@value #F_START} to {@value #F_ENDE} Hz. Adults hear
 * practically nothing above roughly 17 kHz; at 48 kHz sampling the limit of what
 * can be represented is 24 kHz. A band like 18–22 kHz uses the narrow strip in
 * between (see the band note below for why it was lowered).
 * <p>IMPORTANT, to be honest: <b>younger ears and dogs hear it.</b> Inaudible
 * means "for adults" here, not "for everyone".
 *
 * <h3>The trick that saves calibration</h3>
 * Note: the delay between "play" and "record" differs per device and is
 * unknown — measuring it would be a project of its own. But it cancels out by
 * itself: the <b>direct sound</b> from speaker to microphone always arrives
 * first and provides the zero point. Only the <b>distance between direct sound
 * and echo</b> is measured. That cancels out any latency.
 *
 * <h3>What is measured</h3>
 * The distance to the <b>nearest strongly reflecting surface</b> — table top
 * or plate rim, not necessarily the food. For the scale that is exactly
 * right: the plate lies in the plane that is to be measured.
 */
public final class AkustikMessung {

    private static final String TAG = "ClaraAkustik";

    public static final int RATE = 48000;
    // IMPORTANT: band lowered after subtracting the own profile only revealed
    // noise instead of a table echo.
    //
    // Note: the cause was physics, not code: **phone speakers roll off steeply
    // at high frequencies.** Compared to 1 kHz they are about 22 dB lower at
    // 18 kHz and about 34 dB lower at 22 kHz. The first chirp sat in the
    // speaker's weakest range of all — and an echo travels the path twice.
    //
    // 15.5–19.5 kHz gives about 12 dB more transmit power. IMPORTANT — the price:
    // at 15.5 kHz some adults still hear something. Only the user's ear can
    // answer whether that is the case — so the question belongs in the
    // instructions, not in an assumption.
    public static final int F_START = 15500;
    public static final int F_ENDE = 19500;
    /** Chirp length. Quadrupled: the time-bandwidth product determines the
     *  processing gain of the correlation, that is about 6 dB. */
    public static final int ZIRP_MS = 150;
    /** Listening time — chirp plus ample tail. */
    public static final int HOEREN_MS = 260;   // chirp 150 ms + tail
    /** Number of recordings averaged. Noise drops with the square root,
     *  another ~9 dB. Note: together with band and length about a factor of 20 —
     *  exactly what is needed when nothing was visible under the interferer. */
    public static final int MITTELUNG = 4;

    /** Speed of sound at 20 °C. 0.6 m/s per degree — 5 °C off means about
     *  3.5 mm error at 40 cm. */
    public static final double C_LUFT = 343.0;

    /**
     * IMPORTANT: the phone reverberates itself — found by testing.
     *
     * <p>No matter how far the device was held from the table, it showed 15–20 cm.
     * The peak about 45 samples after the direct sound is therefore <b>not an echo
     * from the table</b> but <b>structure-borne sound in the housing</b>: the speaker
     * excites the housing, and the microphone hears it via the detour through the
     * material — always at the same distance, because the path lies inside the device.
     *
     * <p>Note: the first reading ("four stable echoes, that's the room") was
     * therefore wrong. The stability taken as evidence was in truth the proof
     * against it: a room echo changes when you move the device. Housing
     * reverberation does not.
     *
     * <p>The remedy is not a larger dead zone — the reverberation has a tail that
     * would merely be shifted — but a <b>blank measurement</b>: record once in free
     * air, remember this own profile and subtract it from every later measurement.
     * What remains comes from outside. In radar engineering this is called clutter
     * suppression; here it is the same on a small scale.
     */
    private static double[] eigenprofil = null;

    /** Distance covered by the direct sound. The chirp has 4 kHz bandwidth,
     *  so its peak is about 0.25 ms wide; plus reverberation in the housing.
     *  Anything below cannot be separated from the direct sound. */
    private static final int TOTZONE_PROBEN = 24;   // ≈ 1.7 cm

    private AkustikMessung() {}

    /** Linear chirp with soft edges. */
    static short[] zirp() {
        int n = RATE * ZIRP_MS / 1000;
        short[] s = new short[n];
        double k = (double) (F_ENDE - F_START) / (n / (double) RATE);
        for (int i = 0; i < n; i++) {
            double t = i / (double) RATE;
            double phase = 2 * Math.PI * (F_START * t + 0.5 * k * t * t);
            // Hann window: without soft edges it clicks audibly, and the click lies
            // in the audible range — it would defeat the inaudibility.
            double fenster = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1.0)));
            s[i] = (short) (Short.MAX_VALUE * 0.9 * fenster * Math.sin(phase));
        }
        return s;
    }

    /**
     * Cross-correlation of the recording with the chirp.
     *
     * <p>Computed naively — with a 40 ms template and a 200 ms recording that is
     * about 18 million multiplications, i.e. fractions of a second. An FFT would
     * be faster and harder to read; for one measurement per meal it is not worth it.
     */
    static double[] korrelation(short[] aufnahme, short[] vorlage) {
        return korrelation(aufnahme, vorlage, 0, Math.max(0, aufnahme.length - vorlage.length), 1);
    }

    /**
     * Cross-correlation over a section, optionally decimated.
     *
     * <p>IMPORTANT: became necessary when the chirp grew from 40 to 150 ms: the
     * naive computation costs template × window multiplications — 18 million
     * became 86 million per recording, times eight recordings. The app simply
     * stopped delivering a result.
     *
     * <p>Note: hence it is computed in two stages: first coarsely with every
     * fourth value to find the direct sound, then finely only around it. The
     * result is the same at a twentieth of the cost. An FFT would be even
     * faster — and much harder to read.
     */
    static double[] korrelation(short[] aufnahme, short[] vorlage,
                                int von, int bis, int schritt) {
        int m = vorlage.length;
        int ende = Math.min(bis, aufnahme.length - m);
        double[] out = new double[Math.max(0, aufnahme.length - m)];
        for (int i = Math.max(0, von); i < ende; i++) {
            double summe = 0;
            for (int j = 0; j < m; j += schritt) summe += aufnahme[i + j] * (double) vorlage[j];
            out[i] = Math.abs(summe);
        }
        return out;
    }

    /** Window after the direct sound that is computed finely — 12.5 ms ≈ 2.1 m. */
    private static final int FEIN_FENSTER = 600;

    /**
     * Two-stage: find the direct sound coarsely, then compute finely around it.
     * Returns the profile aligned to the direct sound (index 0 = direct sound).
     */
    static double[] profilVon(short[] aufnahme, short[] vorlage) {
        double[] grob = korrelation(aufnahme, vorlage, 0,
                aufnahme.length - vorlage.length, 4);
        int direkt = spitze(grob, 0, grob.length);
        if (direkt < 0) return null;
        double[] fein = korrelation(aufnahme, vorlage,
                Math.max(0, direkt - 8), direkt + FEIN_FENSTER, 1);
        int genau = spitze(fein, Math.max(0, direkt - 8), direkt + 12);
        if (genau < 0) return null;
        int laenge = Math.min(FEIN_FENSTER, fein.length - genau);
        if (laenge <= TOTZONE_PROBEN) return null;
        double[] p = new double[laenge];
        System.arraycopy(fein, genau, p, 0, laenge);
        return p;
    }

    static int spitze(double[] k, int von, int bis) {
        int best = -1;
        double wert = 0;
        for (int i = Math.max(0, von); i < Math.min(k.length, bis); i++) {
            if (k[i] > wert) { wert = k[i]; best = i; }
        }
        return best;
    }

    /**
     * Refines a peak to fractions of a sample.
     *
     * <p>Note: one sample corresponds to 7 mm of path, i.e. 3.5 mm of distance.
     * Without this refinement that would be the resolution limit — with it, the
     * limit is lower. A parabola is fitted through the peak and its two neighbors.
     */
    static double genauer(double[] k, int i) {
        if (i <= 0 || i >= k.length - 1) return i;
        double a = k[i - 1], b = k[i], c = k[i + 1];
        double nenner = a - 2 * b + c;
        return nenner == 0 ? i : i + 0.5 * (a - c) / nenner;
    }

    /** Result of a measurement. */
    public static final class Ergebnis {
        public final double abstandM;
        public final double guete;        // echo peak divided by noise
        public final int direktProbe;
        public final int echoProbe;
        public final String fehler;
        /** The strongest candidates as text — the actual diagnostic value.
         *  Only when it is visible WHICH peak follows the distance can one
         *  say whether any does at all. */
        public String kandidaten = "";

        Ergebnis(double abstandM, double guete, int d, int e, String fehler) {
            this.abstandM = abstandM; this.guete = guete;
            this.direktProbe = d; this.echoProbe = e; this.fehler = fehler;
        }

        public boolean ok() { return fehler == null; }

        @Override public String toString() {
            return ok() ? String.format("%.3f m (Güte %.1f, Proben %d→%d)",
                                        abstandM, guete, direktProbe, echoProbe)
                        : "— " + fehler;
        }
    }

    /**
     * Distance from an averaged profile aligned to the direct sound.
     * Index 0 is the direct sound. Pure, without audio — hence testable.
     */
    static Ergebnis ausProfil(double[] profil, int aufnahmen) {
        double[] k = profil.clone();
        if (eigenprofil != null) {
            for (int i = 0; i < Math.min(k.length, eigenprofil.length); i++) {
                k[i] = Math.max(0, k[i] - eigenprofil[i]);
            }
        }
        int echo = spitze(k, TOTZONE_PROBEN, k.length);
        if (echo < 0) return new Ergebnis(0, 0, 0, -1, "Kein Echo gefunden");

        double s = 0; int z = 0;
        for (int i = TOTZONE_PROBEN; i < k.length; i++) {
            if (Math.abs(i - echo) > TOTZONE_PROBEN) { s += k[i]; z++; }
        }
        double rauschen = z > 0 ? s / z : 1e-12;
        double guete = rauschen > 0 ? k[echo] / rauschen : 0;

        StringBuilder d = new StringBuilder();
        double[] kopie = k.clone();
        for (int n = 0; n < 5; n++) {
            int i = spitze(kopie, TOTZONE_PROBEN, kopie.length);
            if (i < 0 || kopie[i] <= 0) break;
            d.append(String.format(java.util.Locale.GERMANY, "%.1fcm %.0fx  ",
                    i / (double) RATE * C_LUFT * 50, kopie[i] / rauschen));
            for (int j = Math.max(0, i - TOTZONE_PROBEN);
                 j < Math.min(kopie.length, i + TOTZONE_PROBEN); j++) kopie[j] = 0;
        }

        double weg = genauer(k, echo) / RATE * C_LUFT;
        Ergebnis r = new Ergebnis(weg / 2.0, guete, 0, echo, null);
        r.kandidaten = d.toString().trim() + "   (" + aufnahmen + " Aufn.)";
        return r;
    }

    /** Compute the distance from the recording. Pure, without audio — hence testable. */
    static Ergebnis auswerten(short[] aufnahme, short[] vorlage) {
        if (aufnahme == null || aufnahme.length < vorlage.length * 2) {
            return new Ergebnis(0, 0, -1, -1, "Aufnahme zu kurz");
        }
        double[] k = korrelation(aufnahme, vorlage);
        int direkt = spitze(k, 0, k.length);
        if (direkt < 0) return new Ergebnis(0, 0, -1, -1, "Kein Direktschall gefunden");

        // Note: subtract the own profile, scaled to the height of THIS direct sound.
        // Volume varies between measurements; without scaling a residue would
        // remain that looks like an echo.
        if (eigenprofil != null) {
            double hoehe = k[direkt];
            for (int i = 0; i < k.length; i++) {
                int rel = i - direkt;
                if (rel >= 0 && rel < eigenprofil.length) {
                    k[i] = Math.max(0, k[i] - eigenprofil[rel] * hoehe);
                }
            }
        }

        int echo = spitze(k, direkt + TOTZONE_PROBEN, k.length);
        if (echo < 0) return new Ergebnis(0, 0, direkt, -1, "Kein Echo gefunden");

        // Noise measure: mean of the correlation away from both peaks.
        double summe = 0; int zahl = 0;
        for (int i = 0; i < k.length; i++) {
            if (Math.abs(i - direkt) > TOTZONE_PROBEN && Math.abs(i - echo) > TOTZONE_PROBEN) {
                summe += k[i]; zahl++;
            }
        }
        double rauschen = zahl > 0 ? summe / zahl : 1;
        double guete = rauschen > 0 ? k[echo] / rauschen : 0;

        // IMPORTANT — diagnostics, because the first run was suspicious: the peak
        // was every time at **exactly 48 samples** after the direct sound — only
        // eight samples past the dead-zone limit. That can be a real echo
        // (17.2 cm to the table top) or the tail of the direct sound, which then
        // just sticks at the edge of the dead zone. From outside the two cannot be
        // told apart — hence the strongest candidates are logged as well.
        StringBuilder d = new StringBuilder();
        double[] kopie = k.clone();
        for (int n = 0; n < 5; n++) {
            int i = spitze(kopie, direkt + TOTZONE_PROBEN, kopie.length);
            if (i < 0) break;
            double cm = (i - direkt) / (double) RATE * C_LUFT * 50;
            d.append(String.format(java.util.Locale.GERMANY,
                    "+%d(%.1fcm,%.0fx) ", i - direkt, cm, kopie[i] / rauschen));
            for (int j = Math.max(0, i - TOTZONE_PROBEN);
                 j < Math.min(kopie.length, i + TOTZONE_PROBEN); j++) kopie[j] = 0;
        }
        Log.w(TAG, "Kandidaten: " + d);

        double proben = genauer(k, echo) - genauer(k, direkt);
        double weg = proben / RATE * C_LUFT;      // round trip
        Ergebnis r = new Ergebnis(weg / 2.0, guete, direkt, echo, null);
        r.kandidaten = d.toString().trim();
        return r;
    }

    /** Is an own profile stored? */
    public static boolean hatEigenprofil() { return eigenprofil != null; }

    public static void eigenprofilVergessen() { eigenprofil = null; }

    /**
     * Records the own profile — **nothing** may be within range while doing so.
     *
     * <p>IMPORTANT: the user must hold the phone in the air, away from table, wall
     * and body. Anything that reflects meanwhile will be subtracted as
     * "does not belong" from then on and becomes invisible.
     *
     * <p>Averaged over several recordings so that individual noises do not
     * end up permanently in the profile.
     */
    public static String eigenprofilAufnehmen(int wiederholungen) {
        short[] vorlage = zirp();
        double[] summe = null;
        int gueltig = 0;
        for (int n = 0; n < Math.max(1, wiederholungen); n++) {
            short[] auf = aufnehmen(vorlage);
            if (auf == null) continue;
            double[] k = profilVon(auf, vorlage);
            if (k == null || k[0] <= 0) continue;
            if (summe == null) summe = new double[k.length];
            for (int i = 0; i < Math.min(k.length, summe.length); i++) {
                summe[i] += k[i] / k[0];                   // normalized to the direct sound
            }
            gueltig++;
        }
        if (summe == null || gueltig == 0) return "Leermessung fehlgeschlagen";
        for (int i = 0; i < summe.length; i++) summe[i] /= gueltig;
        eigenprofil = summe;
        return "Eigenprofil aus " + gueltig + " Aufnahmen gespeichert";
    }

    /** Perform one measurement. Needs RECORD_AUDIO. */
    public static Ergebnis messen() {
        return messen(MITTELUNG);
    }

    /**
     * Several recordings, aligned at their direct sound and averaged.
     *
     * <p>Note: alignment is needed because recording and playback do not start
     * in sync — the direct sound lands at a different position in each
     * recording. Without alignment, averaging would smear everything instead
     * of reinforcing it.
     */
    public static Ergebnis messen(int wiederholungen) {
        short[] vorlage = zirp();
        double[] summe = null;
        int laenge = 0, gueltig = 0;
        for (int n = 0; n < Math.max(1, wiederholungen); n++) {
            short[] auf = aufnehmen(vorlage);
            if (auf == null) continue;
            double[] k = profilVon(auf, vorlage);
            if (k == null || k[0] <= 0) continue;
            if (summe == null) { laenge = k.length; summe = new double[laenge]; }
            for (int i = 0; i < Math.min(laenge, k.length); i++) {
                summe[i] += k[i] / k[0];                    // normalized to the direct sound
            }
            gueltig++;
        }
        if (summe == null || gueltig == 0) {
            return new Ergebnis(0, 0, -1, -1, "Keine verwertbare Aufnahme");
        }
        for (int i = 0; i < summe.length; i++) summe[i] /= gueltig;
        return ausProfil(summe, gueltig);
    }

    /** Play the chirp and listen at the same time. Null on failure. */
    private static short[] aufnehmen(short[] vorlage) {
        int proben = RATE * HOEREN_MS / 1000;
        short[] auf = new short[proben];

        int minPuffer = AudioRecord.getMinBufferSize(RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord rec = null;
        AudioTrack tra = null;
        try {
            // IMPORTANT: UNPROCESSED is mandatory: MIC and VOICE_RECOGNITION add
            // noise suppression and automatic gain, and both destroy exactly
            // what is measured here — a short, weak echo right after a loud
            // direct sound.
            rec = new AudioRecord(MediaRecorder.AudioSource.UNPROCESSED, RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(minPuffer, proben * 2));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                return null;
            }
            tra = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(RATE)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(vorlage.length * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC).build();
            tra.write(vorlage, 0, vorlage.length);

            rec.startRecording();
            tra.play();
            int gelesen = 0;
            while (gelesen < proben) {
                int n = rec.read(auf, gelesen, proben - gelesen);
                if (n <= 0) break;
                gelesen += n;
            }
            rec.stop();
            if (gelesen < proben) {
                short[] kurz = new short[gelesen];
                System.arraycopy(auf, 0, kurz, 0, gelesen);
                auf = kurz;
            }
        } catch (Exception e) {
            Log.e(TAG, "Aufnahme fehlgeschlagen", e);
            return null;
        } finally {
            if (rec != null) rec.release();
            if (tra != null) { tra.stop(); tra.release(); }
        }
        return auf;
    }
}
