package tools.ghostly.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File
import kotlin.concurrent.thread

/**
 * Save a copy's document picker (`ACTION_CREATE_DOCUMENT`), which makes the document, under the file's name, as soon as
 * the person taps Save. Its answer came through Tauri's PluginManager, whose callback lives in memory only: when
 * Android ended the process while the picker was open, the answer reached the activity made again with no callback and
 * was dropped, and the document stayed there empty. Here the launcher has a fixed key, which Android's result registry
 * finds again in the new process, and the save it waits for is kept in the activity's saved state: that answer still
 * copies the file into the document, or removes the empty document and says so.
 */
object SavePicker {
  private const val KEY = "tools.ghostly.app.save"
  private const val STATE_PATH = "tools.ghostly.app.save.path"
  private const val STATE_NAME = "tools.ghostly.app.save.name"

  /** A save asked for: the stored file at `path`, offered under `name`. */
  class Save(val path: String, val name: String)

  private val slot = SaveSlot<Save>()
  /** Who hears the open picker's answer (the page's save command), while the process that opened it lives. */
  private var waiting: ((Save?, ActivityResult) -> Unit)? = null
  private var launcher: ActivityResultLauncher<Intent>? = null

  /** From MainActivity's onCreate, before it starts: the launcher, and the save a process Android ended kept. */
  fun register(activity: ComponentActivity, state: Bundle?) {
    val path = state?.getString(STATE_PATH)
    if (path != null) slot.take(Save(path, state.getString(STATE_NAME).orEmpty()))
    val context = activity.applicationContext
    launcher = activity.activityResultRegistry.register(KEY, activity, ActivityResultContracts.StartActivityForResult()) {
      answered(context, it)
    }
  }

  /** From MainActivity's onSaveInstanceState: the save whose picker is open, if one is. */
  fun keep(state: Bundle) {
    val save = slot.open ?: return
    state.putString(STATE_PATH, save.path)
    state.putString(STATE_NAME, save.name)
  }

  /**
   * Opens the picker for [save], [answer] hearing what the person chose. False, and nothing opened, while another
   * save's picker is open (SaveSlot): the open picker's answer stays its own.
   */
  fun open(save: Save, answer: (Save?, ActivityResult) -> Unit): Boolean {
    val launcher = launcher ?: throw IllegalStateException("No activity to open the picker from")
    if (!slot.take(save)) return false
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType("*/*")
      .putExtra(Intent.EXTRA_TITLE, save.name)
    waiting = answer
    try {
      launcher.launch(intent)
    } catch (e: Exception) {
      // No picker opened (none on this phone): no answer will free the slot.
      slot.answered()
      waiting = null
      throw e
    }
    return true
  }

  private fun answered(context: Context, result: ActivityResult) {
    val save = slot.answered()
    val answer = waiting
    waiting = null
    if (answer != null) return answer(save, result)
    // No one waits: Android ended the process while the picker was open, and the page that asked is gone.
    val target = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || target == null) return
    thread(name = "ghostly-save") {
      val resolver = context.contentResolver
      val saved = SaveCopy.restored(
        save?.let { File(it.path) },
        { resolver.openOutputStream(target, "wt") },
        { DocumentsContract.deleteDocument(resolver, target) },
      )
      if (!saved) {
        Handler(Looper.getMainLooper()).post { Toast.makeText(context, R.string.save_failed, Toast.LENGTH_LONG).show() }
      }
    }
  }
}
