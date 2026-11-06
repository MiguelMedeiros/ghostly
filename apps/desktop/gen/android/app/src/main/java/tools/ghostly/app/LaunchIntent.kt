package tools.ghostly.app

import android.content.Intent

/**
 * Whether the intent an activity is made with was already taken by an earlier run. Android keeps the intent that
 * started the task (a share, a notification's tap, a sign-in's link) with the activity's record, which outlives the
 * process: when it ends the process in the background and the person comes back (from Recents or the icon), the
 * activity is made again, in a new process, with that same intent, and without the handled mark the earlier process put
 * on its own copy (GhostlyHostPlugin `take`). Such an activity comes back with its saved state (`savedInstanceState`),
 * or, when Android made the task's activity anew from Recents, with `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`. A new share
 * that comes then reaches the activity as a new intent (MainActivity `onNewIntent`), never as this one. Plain Kotlin,
 * so a JVM unit test reads it.
 */
object LaunchIntent {
  /** Whether the activity was made again (`restored`: it has saved state) or from Recents (the intent's `flags`). */
  fun takenBefore(restored: Boolean, flags: Int): Boolean =
    restored || (flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
}
