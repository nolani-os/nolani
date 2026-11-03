package de.claraos.companion.kamera;

import android.content.Context;
import android.graphics.Rect;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.util.Size;
import android.util.SizeF;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reads out what this device's cameras know about themselves.
 *
 * <p>Why this is a class of its own: the decision about true-to-scale meal
 * capture as a whole hinges on <b>a single byte</b> —
 * {@code LENS_INFO_FOCUS_DISTANCE_CALIBRATION}. If it says {@code CALIBRATED},
 * the focus distance is a real distance measurement, and the scale of a
 * photo can be computed:
 *
 * <pre>mm per pixel = (focus distance × sensor width) / (focal length × image width)</pre>
 *
 * <p>Then no reference object, no marker and no ritual at the table is needed.
 * If it says {@code UNCALIBRATED}, the whole path is dead and several days of
 * work are saved.
 *
 * <p>IMPORTANT: {@code adb shell dumpsys media.camera} does <b>not</b> reveal
 * this — it lists only the keys, not the values. Only an app on the device can
 * answer the question. That is what this class is for.
 *
 * <p>Read-only: no camera is opened, no image is captured.
 */
public final class KameraBefund {

    /** The example scale is computed at this distance — typical hand-to-plate
     *  distance when photographing a meal. */
    private static final double BEISPIEL_ABSTAND_M = 0.40;

    private KameraBefund() {}

    private static String kalibrierung(Integer wert) {
        if (wert == null) return "unbekannt";
        switch (wert) {
            case CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_UNCALIBRATED:
                return "UNCALIBRATED";
            case CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_APPROXIMATE:
                return "APPROXIMATE";
            case CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_CALIBRATED:
                return "CALIBRATED";
            default:
                return "unbekannt(" + wert + ")";
        }
    }

    /**
     * Scale in millimeters per pixel at a given distance.
     *
     * <p>Note: this is the intercept theorem, not an estimate: at focal length f
     * the sensor width images a section of width {@code d × s / f}. Divided by
     * the pixel count this gives the edge length of one pixel in the object
     * plane.
     */
    static Double mmProPixel(double abstandM, Float brennweiteMm,
                             SizeF sensorMm, Size bildPx) {
        if (brennweiteMm == null || sensorMm == null || bildPx == null) return null;
        if (brennweiteMm <= 0 || sensorMm.getWidth() <= 0 || bildPx.getWidth() <= 0) return null;
        double sichtfeldMm = abstandM * 1000.0 * sensorMm.getWidth() / brennweiteMm;
        return sichtfeldMm / bildPx.getWidth();
    }

    private static Size groessteJpeg(CameraCharacteristics c) {
        StreamConfigurationMap map =
                c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        if (map == null) return null;
        Size[] groessen = map.getOutputSizes(android.graphics.ImageFormat.JPEG);
        if (groessen == null || groessen.length == 0) return null;
        Size beste = groessen[0];
        for (Size s : groessen) {
            if ((long) s.getWidth() * s.getHeight() > (long) beste.getWidth() * beste.getHeight()) {
                beste = s;
            }
        }
        return beste;
    }

    // JSONArray.put(double) throws on NaN/Infinity — hence declared.
    private static JSONArray arr(float[] werte) throws JSONException {
        JSONArray a = new JSONArray();
        for (float f : werte) a.put(f);
        return a;
    }

    private static String bezug(int wert) {
        switch (wert) {
            case CameraCharacteristics.LENS_POSE_REFERENCE_PRIMARY_CAMERA:
                return "PRIMARY_CAMERA";
            case CameraCharacteristics.LENS_POSE_REFERENCE_GYROSCOPE:
                return "GYROSCOPE";
            case CameraCharacteristics.LENS_POSE_REFERENCE_UNDEFINED:
                return "UNDEFINED";
            default:
                return "sonstiges(" + wert + ")";
        }
    }

    /** Distance between two cameras in millimeters — the baseline of the stereo computation. */
    static Double basislinieMm(float[] a, float[] b) {
        if (a == null || b == null || a.length < 3 || b.length < 3) return null;
        double dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz) * 1000.0;
    }

    private static String formatName(int f) {
        switch (f) {
            case android.graphics.ImageFormat.JPEG: return "JPEG";
            case android.graphics.ImageFormat.YUV_420_888: return "YUV_420_888";
            case android.graphics.ImageFormat.PRIVATE: return "PRIVATE";
            case android.graphics.ImageFormat.RAW_SENSOR: return "RAW_SENSOR";
            case android.graphics.ImageFormat.DEPTH16: return "DEPTH16 ★";
            case android.graphics.ImageFormat.DEPTH_POINT_CLOUD: return "DEPTH_POINT_CLOUD ★";
            case android.graphics.ImageFormat.DEPTH_JPEG: return "DEPTH_JPEG ★★";
            case android.graphics.ImageFormat.HEIC: return "HEIC";
            case android.graphics.ImageFormat.JPEG_R: return "JPEG_R";
            default: return "0x" + Integer.toHexString(f);
        }
    }

    private static boolean kann(int[] faehigkeiten, int gesucht) {
        if (faehigkeiten == null) return false;
        for (int f : faehigkeiten) if (f == gesucht) return true;
        return false;
    }

    /** Complete report on all cameras of the device. */
    public static JSONObject erheben(Context ctx)
            throws CameraAccessException, JSONException {
        CameraManager cm = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
        JSONObject befund = new JSONObject();
        JSONArray kameras = new JSONArray();

        String beste = "keine";
        java.util.List<String> ids = new java.util.ArrayList<>();
        for (String id : cm.getCameraIdList()) ids.add(id);

        // IMPORTANT: `getCameraIdList()` returns only the LOGICAL cameras. On a
        // first run on a test phone that was exactly two — although the device
        // has ultra-wide, wide and tele, and although `dumpsys` reports
        // `depthIsExclusive` on other cameras. The minimum focus came back as
        // `null`, which cannot be for a camera with autofocus.
        // Note: the interesting values hang on the PHYSICAL cameras behind them.
        // Without them the verdict on the focus distance would have been made
        // on half the knowledge.
        java.util.Set<String> logisch = new java.util.HashSet<>(ids);
        for (String id : new java.util.ArrayList<>(ids)) {
            try {
                for (String phys : cm.getCameraCharacteristics(id).getPhysicalCameraIds()) {
                    if (!ids.contains(phys)) ids.add(phys);
                }
            } catch (Throwable ignored) { /* older devices do not know this */ }
        }

        for (String id : ids) {
            CameraCharacteristics c = cm.getCameraCharacteristics(id);
            JSONObject k = new JSONObject();

            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            k.put("id", id);
            k.put("art", logisch.contains(id) ? "logisch" : "physisch");
            k.put("richtung", facing == null ? "?"
                    : facing == CameraCharacteristics.LENS_FACING_BACK ? "hinten"
                    : facing == CameraCharacteristics.LENS_FACING_FRONT ? "vorne" : "extern");

            // Note: the decisive value.
            String kal = kalibrierung(
                    c.get(CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION));
            k.put("fokusdistanz_kalibrierung", kal);
            if ("CALIBRATED".equals(kal)) beste = "CALIBRATED";
            else if ("APPROXIMATE".equals(kal) && !"CALIBRATED".equals(beste)) beste = "APPROXIMATE";
            else if (!"CALIBRATED".equals(beste) && !"APPROXIMATE".equals(beste)) beste = kal;

            Float minFokus = c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
            k.put("min_fokus_dioptrien", minFokus == null ? JSONObject.NULL : minFokus);
            // Diopters → meters. 0 means "fixed focus, infinity".
            k.put("naheinstellgrenze_m", (minFokus == null || minFokus == 0f)
                    ? JSONObject.NULL : 1.0f / minFokus);
            Float hyper = c.get(CameraCharacteristics.LENS_INFO_HYPERFOCAL_DISTANCE);
            k.put("hyperfokal_dioptrien", hyper == null ? JSONObject.NULL : hyper);

            float[] brennweiten = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
            JSONArray bw = new JSONArray();
            if (brennweiten != null) for (float f : brennweiten) bw.put(f);
            k.put("brennweiten_mm", bw);

            SizeF sensor = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
            k.put("sensor_mm", sensor == null ? JSONObject.NULL
                    : sensor.getWidth() + " x " + sensor.getHeight());
            Size pixel = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE);
            k.put("sensor_px", pixel == null ? JSONObject.NULL
                    : pixel.getWidth() + " x " + pixel.getHeight());

            Size jpeg = groessteJpeg(c);
            k.put("groesstes_jpeg", jpeg == null ? JSONObject.NULL
                    : jpeg.getWidth() + " x " + jpeg.getHeight());

            // Note: don't just query the capability, list the output formats
            // actually offered. DEPTH_JPEG (0x69656963) is the format in which
            // Android delivers the depth map INSIDE the JPEG — if it were
            // available here, depth would be readable without privileged
            // access.
            StreamConfigurationMap smap =
                    c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            JSONArray formate = new JSONArray();
            if (smap != null) {
                for (int f : smap.getOutputFormats()) formate.put(formatName(f));
            }
            k.put("ausgabeformate", formate);

            int[] faehig = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
            k.put("kann_tiefe", kann(faehig,
                    CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_DEPTH_OUTPUT));
            k.put("kann_raw", kann(faehig,
                    CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_RAW));
            k.put("kann_manuell", kann(faehig,
                    CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR));

            // What one pixel measures in reality at 40 cm — the number that
            // shows whether the resolution suffices for volume estimation.
            Double mmPx = (brennweiten != null && brennweiten.length > 0)
                    ? mmProPixel(BEISPIEL_ABSTAND_M, brennweiten[0], sensor, jpeg) : null;
            k.put("mm_je_pixel_bei_40cm", mmPx == null ? JSONObject.NULL : mmPx);
            if (mmPx != null) {
                k.put("bildbreite_bei_40cm_mm", mmPx * (jpeg != null ? jpeg.getWidth() : 0));
            }

            // Note — the actual reason for the second pass:
            // on devices with several cameras behind one logical camera,
            // Android reports the **mounting position of each physical camera
            // in METERS** (`LENS_POSE_TRANSLATION`) plus focal point and
            // distortion. If these fields are filled, the distance between two
            // cameras is known — and with it stereo triangulation with
            // **absolute scale**, without focus distance, reference object or ARCore.
            float[] pose = c.get(CameraCharacteristics.LENS_POSE_TRANSLATION);
            k.put("pose_translation_m", pose == null ? JSONObject.NULL : arr(pose));
            float[] rot = c.get(CameraCharacteristics.LENS_POSE_ROTATION);
            k.put("pose_rotation", rot == null ? JSONObject.NULL : arr(rot));
            Integer ref = c.get(CameraCharacteristics.LENS_POSE_REFERENCE);
            k.put("pose_bezug", ref == null ? JSONObject.NULL : bezug(ref));
            float[] intr = c.get(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION);
            k.put("intrinsics_fx_fy_cx_cy_s", intr == null ? JSONObject.NULL : arr(intr));
            float[] verz = c.get(CameraCharacteristics.LENS_DISTORTION);
            k.put("verzeichnung", verz == null ? JSONObject.NULL : arr(verz));
            Integer sync = c.get(CameraCharacteristics.LOGICAL_MULTI_CAMERA_SENSOR_SYNC_TYPE);
            k.put("sensor_sync", sync == null ? JSONObject.NULL
                    : sync == CameraCharacteristics.LOGICAL_MULTI_CAMERA_SENSOR_SYNC_TYPE_CALIBRATED
                      ? "CALIBRATED" : "APPROXIMATE");
            k.put("ist_logische_multikamera", kann(faehig,
                    CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA));

            Rect aktiv = c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
            k.put("aktives_feld", aktiv == null ? JSONObject.NULL : aktiv.toShortString());

            kameras.put(k);
        }

        // Baselines between all rear cameras — the number that decides
        // stereo with absolute scale.
        JSONArray basis = new JSONArray();
        for (int i = 0; i < kameras.length(); i++) {
            for (int j = i + 1; j < kameras.length(); j++) {
                JSONObject a = kameras.getJSONObject(i), b = kameras.getJSONObject(j);
                if (!"hinten".equals(a.optString("richtung"))
                        || !"hinten".equals(b.optString("richtung"))) continue;
                float[] pa = auslesen(a.opt("pose_translation_m"));
                float[] pb = auslesen(b.opt("pose_translation_m"));
                Double mm = basislinieMm(pa, pb);
                if (mm != null && mm > 0.5) {
                    basis.put(new JSONObject()
                            .put("von", a.optString("id")).put("nach", b.optString("id"))
                            .put("basislinie_mm", Math.round(mm * 100) / 100.0));
                }
            }
        }
        // Note — last open question: can two cameras run SIMULTANEOUSLY?
        // Only then is stereo on a plate practical — one after the other, any
        // hand movement between the shots would distort the baseline.
        JSONArray gleichzeitig = new JSONArray();
        try {
            for (java.util.Set<String> kombi : cm.getConcurrentCameraIds()) {
                gleichzeitig.put(new JSONArray(new java.util.ArrayList<>(kombi)));
            }
        } catch (Throwable e) {
            gleichzeitig.put("nicht abfragbar: " + e.getClass().getSimpleName());
        }
        befund.put("gleichzeitig_moegliche_kombinationen", gleichzeitig);

        befund.put("basislinien", basis);
        befund.put("stereo_moeglich", basis.length() > 0);

        befund.put("kameras", kameras);
        befund.put("beste_kalibrierung", beste);
        befund.put("urteil", urteil(beste));
        befund.put("geraet", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
        befund.put("android", android.os.Build.VERSION.RELEASE);
        return befund;
    }

    private static float[] auslesen(Object o) {
        if (!(o instanceof JSONArray)) return null;
        JSONArray a = (JSONArray) o;
        if (a.length() < 3) return null;
        return new float[]{(float) a.optDouble(0), (float) a.optDouble(1),
                (float) a.optDouble(2)};
    }

    /** What the report means — in plain words, so it does not need to be
     *  interpreted first. */
    static String urteil(String kalibrierung) {
        switch (kalibrierung) {
            case "CALIBRATED":
                return "Die Fokusdistanz ist metrisch belastbar. Der Maßstab eines "
                        + "Fotos lässt sich ausrechnen — ohne Referenzobjekt. P2 lohnt sich.";
            case "APPROXIMATE":
                return "Die Fokusdistanz ist grob. Als Plausibilitätsprüfung "
                        + "brauchbar, als alleiniger Maßstab nicht. Ein Referenzobjekt "
                        + "bleibt nötig.";
            case "UNCALIBRATED":
                return "Die Fokusdistanz ist bedeutungslos. Der optische Weg ist tot; "
                        + "es bleibt beim Referenzobjekt im Bild.";
            default:
                return "Keine Angabe gefunden — wie UNCALIBRATED behandeln.";
        }
    }
}
