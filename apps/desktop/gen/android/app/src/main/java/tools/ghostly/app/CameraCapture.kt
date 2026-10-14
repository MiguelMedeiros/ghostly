package tools.ghostly.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.provider.MediaStore
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Where the composer's Camera puts a photo: the app's private cache (`cache/camera`), which no other app, USB or adb
 * reads. wry's own capture wrote each one to `Android/data/<app>/files/Pictures` and never removed it.
 */
object CameraFiles {
  const val FOLDER = "camera"

  fun folder(cacheDir: File): File = File(cacheDir, FOLDER)

  /** A new, empty file for one photo; the name is the one wry gave (`JPEG_<date>_<n>.jpg`), which the page sends. */
  fun create(cacheDir: File, now: Date = Date()): File {
    val folder = folder(cacheDir).apply { mkdirs() }
    val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(now)
    return File.createTempFile("JPEG_${stamp}_", ".jpg", folder)
  }

  /**
   * Every photo a previous start left. The page reads a photo only when it sends it, so one on the sheet stays while
   * the page lives; at the next start no page holds any.
   */
  fun sweep(cacheDir: File) {
    folder(cacheDir).deleteRecursively()
  }

  /** A file input that asks for a photo from the camera (`capture`, accepting images and no video), which [CameraChromeClient] takes. */
  fun takesPhoto(capture: Boolean, acceptTypes: Array<String>): Boolean =
    capture && "image/*" in acceptTypes && "video/*" !in acceptTypes
}

/**
 * wry's WebChromeClient, with the camera's photo taken here, into [CameraFiles]: a cancelled or empty capture leaves
 * nothing. Everything else goes to wry's client: each method it overrides (wry 0.57's `RustWebChromeClient`) is passed
 * on, so a wry update that overrides another needs it added here.
 */
class CameraChromeClient(private val activity: WryActivity,private val wry: WebChromeClient) : WebChromeClient() {
  override fun onShowFileChooser(
    webView: WebView,
    filePathCallback: ValueCallback<Array<Uri?>?>,
    fileChooserParams: FileChooserParams,
  ): Boolean {
    if (!CameraFiles.takesPhoto(fileChooserParams.isCaptureEnabled, fileChooserParams.acceptTypes)) {
      return wry.onShowFileChooser(webView, filePathCallback, fileChooserParams)
    }
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      capture(filePathCallback, fileChooserParams)
    } else {
      // The manifest asks for CAMERA, so Android refuses ACTION_IMAGE_CAPTURE until it is granted.
      activity.requestPermissions(arrayOf(Manifest.permission.CAMERA)) { granted ->
        if (granted == true) capture(filePathCallback, fileChooserParams) else filePathCallback.onReceiveValue(null)
      }
    }
    return true
  }

  private fun capture(callback: ValueCallback<Array<Uri?>?>, params: FileChooserParams) {
    val file = try {
      CameraFiles.create(activity.cacheDir)
    } catch (e: Exception) {
      return pick(callback, params)
    }
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
      .putExtra(MediaStore.EXTRA_OUTPUT, uri)
      .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
      activity.launchActivityForResult(intent) { result ->
        if (result?.resultCode == Activity.RESULT_OK && file.length() > 0) {
          callback.onReceiveValue(arrayOf(uri))
        } else {
          file.delete()
          callback.onReceiveValue(null)
        }
      }
    } catch (e: ActivityNotFoundException) {
      // No camera app: a photo from the files instead, as wry did.
      file.delete()
      pick(callback, params)
    }
  }

  private fun pick(callback: ValueCallback<Array<Uri?>?>, params: FileChooserParams) {
    try {
      activity.launchActivityForResult(params.createIntent()) { result ->
        callback.onReceiveValue(FileChooserParams.parseResult(result?.resultCode ?: 0, result?.data))
      }
    } catch (e: ActivityNotFoundException) {
      callback.onReceiveValue(null)
    }
  }

  override fun onShowCustomView(view: View, callback: CustomViewCallback) = wry.onShowCustomView(view, callback)

  override fun onHideCustomView() = wry.onHideCustomView()

  override fun onPermissionRequest(request: PermissionRequest) = wry.onPermissionRequest(request)

  override fun getDefaultVideoPoster(): Bitmap? = wry.defaultVideoPoster

  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean =
    wry.onJsAlert(view, url, message, result)

  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean =
    wry.onJsConfirm(view, url, message, result)

  override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String, result: JsPromptResult): Boolean =
    wry.onJsPrompt(view, url, message, defaultValue, result)

  override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
    wry.onGeolocationPermissionsShowPrompt(origin, callback)

  override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = wry.onConsoleMessage(consoleMessage)

  override fun onReceivedTitle(view: WebView, title: String) = wry.onReceivedTitle(view, title)
}
