package de.claraos.companion.upload;

import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Shared Paperless upload (share target + document scan), through the app tunnel. */
public final class PaperlessUploader {

    private PaperlessUploader() {}

    public static boolean upload(OkHttpClient client, String paperlessUrl, String token,
                                 RequestBody fileBody, String name) throws Exception {
        String base = paperlessUrl.endsWith("/")
                ? paperlessUrl.substring(0, paperlessUrl.length() - 1) : paperlessUrl;
        MultipartBody body = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("document", name, fileBody)
                .build();
        Request req = new Request.Builder()
                .url(base + "/api/documents/post_document/")
                .header("Authorization", "Token " + token)
                .post(body)
                .build();
        try (Response resp = client.newCall(req).execute()) {
            return resp.isSuccessful();
        }
    }
}
