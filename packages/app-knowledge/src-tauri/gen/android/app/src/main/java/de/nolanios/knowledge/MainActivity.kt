package de.nolanios.knowledge

import android.content.ContentValues
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge to edge draws the web view under the status and navigation bars, and the
    // Android web view reports no safe-area insets to CSS. Pad the content by the
    // system bars (and the keyboard while it is open) so nothing hides behind them.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // The app only ever shows its own bundled page (web links open in the system
    // browser), so this bridge is not reachable from foreign content.
    webView.addJavascriptInterface(Downloads(), "NolaniDownloads")
  }

  /** Saves a file the user exported into the public "Download" folder, where any
   *  file manager finds it (the app's own storage is hidden on current Android). */
  inner class Downloads {
    @JavascriptInterface
    fun save(name: String, mime: String, base64: String): String {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        throw IllegalStateException("needs Android 10 or newer")
      }
      val clean = name.replace(Regex("[/\\\\:\\p{Cntrl}]"), "_").trim().trimStart('.').ifEmpty { "download" }
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, clean)
        put(MediaStore.Downloads.MIME_TYPE, mime.ifEmpty { "application/octet-stream" })
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val resolver = contentResolver
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("could not create the file")
      resolver.openOutputStream(uri).use { out ->
        out ?: throw IllegalStateException("could not open the file")
        out.write(Base64.decode(base64, Base64.DEFAULT))
      }
      values.clear()
      values.put(MediaStore.Downloads.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      // MediaStore may rename on a clash ("name (1).zip"): report the real name
      resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null).use { c ->
        if (c != null && c.moveToFirst()) return "Download/" + c.getString(0)
      }
      return "Download/$clean"
    }
  }
}
