package de.claraos.companion.upload;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.pdf.PdfDocument;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;

import de.claraos.companion.ProvisioningClient;
import de.claraos.companion.vpn.CompanionTunnel;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.RequestBody;

/**
 * In-app document scanner (CameraX, no Play Services → works on de-Googled Android):
 * capture several pages → merge into one PDF → through the app tunnel to Paperless.
 * Started via the JS bridge from the shell (ClaraOSNative.scanDocument()).
 */
public class DocumentScanActivity extends AppCompatActivity {

    private static final String TAG = "ClaraScan";
    private static final int REQ_CAMERA = 10;
    private static final int MAX_DIM = 1754; // ~A4 at 150 dpi → keep the PDF compact

    private PreviewView previewView;
    private TextView counter;
    private ImageCapture imageCapture;
    private final List<File> pages = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Without a Paperless config, don't even start scanning.
        if (ProvisioningClient.getStoredPaperlessUrl(this).isEmpty()
                || ProvisioningClient.getStoredPaperlessToken(this).isEmpty()) {
            Toast.makeText(this, "Paperless noch nicht eingerichtet.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        setContentView(buildUi());

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        } else {
            startCamera();
        }
    }

    private View buildUi() {
        FrameLayout root = new FrameLayout(this);
        previewView = new PreviewView(this);
        root.addView(previewView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        counter = new TextView(this);
        counter.setText("0 Seiten");
        counter.setTextColor(Color.WHITE);
        counter.setPadding(24, 24, 24, 24);
        FrameLayout.LayoutParams cp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        cp.gravity = Gravity.TOP | Gravity.START;
        root.addView(counter, cp);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(24, 24, 24, 48);
        Button capture = new Button(this);
        capture.setText("Aufnehmen");
        capture.setOnClickListener(v -> capture());
        Button done = new Button(this);
        done.setText("Fertig & senden");
        done.setOnClickListener(v -> finishAndUpload());
        LinearLayout.LayoutParams w = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(capture, w);
        bar.addView(done, new LinearLayout.LayoutParams(w.width, w.height, w.weight));
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        bp.gravity = Gravity.BOTTOM;
        root.addView(bar, bp);
        return root;
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                ProcessCameraProvider provider = future.get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                imageCapture = new ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                        .build();
                provider.unbindAll();
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA,
                        preview, imageCapture);
            } catch (Exception e) {
                Log.e(TAG, "camera init failed", e);
                Toast.makeText(this, "Kamera-Fehler: " + e.getMessage(), Toast.LENGTH_LONG).show();
                finish();
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void capture() {
        if (imageCapture == null) return;
        File out = new File(getCacheDir(), "scan_" + System.identityHashCode(new Object()) + "_"
                + pages.size() + ".jpg");
        ImageCapture.OutputFileOptions opts =
                new ImageCapture.OutputFileOptions.Builder(out).build();
        imageCapture.takePicture(opts, ContextCompat.getMainExecutor(this),
                new ImageCapture.OnImageSavedCallback() {
                    @Override
                    public void onImageSaved(@NonNull ImageCapture.OutputFileResults results) {
                        pages.add(out);
                        counter.setText(pages.size() + (pages.size() == 1 ? " Seite" : " Seiten"));
                    }

                    @Override
                    public void onError(@NonNull ImageCaptureException e) {
                        Log.w(TAG, "capture failed", e);
                        Toast.makeText(DocumentScanActivity.this,
                                "Aufnahme fehlgeschlagen", Toast.LENGTH_SHORT).show();
                    }
                });
    }

    private void finishAndUpload() {
        if (pages.isEmpty()) {
            Toast.makeText(this, "Erst mindestens eine Seite aufnehmen.", Toast.LENGTH_SHORT).show();
            return;
        }
        Toast.makeText(this, "PDF wird erstellt & gesendet …", Toast.LENGTH_SHORT).show();
        final List<File> toSend = new ArrayList<>(pages);
        new Thread(() -> {
            boolean ok = false;
            File pdf = null;
            try {
                pdf = buildPdf(toSend);
                String paperless = ProvisioningClient.getStoredPaperlessUrl(this);
                String token = ProvisioningClient.getStoredPaperlessToken(this);
                String control = ProvisioningClient.getStoredControlUrlOrEmpty(this);
                int port = CompanionTunnel.start(this, control, "", hostname());
                OkHttpClient client = CompanionTunnel.tunneledClient(port);
                RequestBody fileBody = RequestBody.create(pdf, MediaType.parse("application/pdf"));
                ok = PaperlessUploader.upload(client, paperless, token, fileBody, "Scan.pdf");
            } catch (Exception e) {
                Log.w(TAG, "scan upload failed", e);
            } finally {
                if (pdf != null) //noinspection ResultOfMethodCallIgnored
                    pdf.delete();
                for (File f : toSend) //noinspection ResultOfMethodCallIgnored
                    f.delete();
            }
            final boolean fOk = ok;
            runOnUiThread(() -> {
                Toast.makeText(this, fOk ? "An Paperless gesendet." : "Senden fehlgeschlagen.",
                        Toast.LENGTH_LONG).show();
                finish();
            });
        }, "scan-upload").start();
    }

    /** Merges the captured JPEGs into a multi-page PDF (downscaled). */
    private File buildPdf(List<File> jpegs) throws Exception {
        PdfDocument doc = new PdfDocument();
        try {
            int page = 1;
            for (File jpg : jpegs) {
                Bitmap bmp = decodeScaled(jpg, MAX_DIM);
                if (bmp == null) continue;
                PdfDocument.PageInfo info = new PdfDocument.PageInfo.Builder(
                        bmp.getWidth(), bmp.getHeight(), page++).create();
                PdfDocument.Page p = doc.startPage(info);
                Canvas canvas = p.getCanvas();
                canvas.drawColor(Color.WHITE);
                canvas.drawBitmap(bmp, 0, 0, null);
                doc.finishPage(p);
                bmp.recycle();
            }
            File out = new File(getCacheDir(), "scan.pdf");
            try (FileOutputStream fos = new FileOutputStream(out)) {
                doc.writeTo(fos);
            }
            return out;
        } finally {
            doc.close();
        }
    }

    private static Bitmap decodeScaled(File f, int maxDim) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getAbsolutePath(), bounds);
        int sample = 1;
        int larger = Math.max(bounds.outWidth, bounds.outHeight);
        while (larger / sample > maxDim) sample *= 2;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inSampleSize = sample;
        return BitmapFactory.decodeFile(f.getAbsolutePath(), o);
    }

    @Override
    public void onRequestPermissionsResult(int code, @NonNull String[] perms, @NonNull int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code == REQ_CAMERA) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) {
                startCamera();
            } else {
                Toast.makeText(this, "Kamera-Berechtigung nötig.", Toast.LENGTH_LONG).show();
                finish();
            }
        }
    }

    private String hostname() {
        // The single source of the tunnel hostname — a differing copy would register
        // the device a second time.
        return de.claraos.companion.vpn.CompanionTunnel.defaultHostname();
    }
}
