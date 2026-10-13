package tools.ghostly.app

import java.util.TreeSet

/**
 * The order of shares from other apps (GhostlyHostPlugin `shared`). Each is numbered as it arrives (its folder's name),
 * but overtakes the shares before it only once it has something for the page: a file copied whole, a text or a title.
 * Then an older share still copying stops and is never handed over. A share that ends up with nothing (its one file
 * too big, a stream that cannot be opened) never stops one before it. An older share that ends with something while a
 * newer one is still undecided waits: dropped when the newer one gets something, handed over when it ends with
 * nothing, never before. What a share is never handed goes to `drop`. Plain Kotlin, so a JVM unit test reads it.
 */
class ShareTurns<T>(private val start: Long, private val drop: (T) -> Unit) {
  private var arrived = start
  /** The newest share that has something: every share before it stops. */
  private var newest = start
  /** Shares that arrived and neither have something nor ended with nothing yet. */
  private val undecided = TreeSet<Long>()
  /** The newest share with something, ended, while a newer share is still undecided: its number and what it has. */
  private var waiting: Pair<Long, T>? = null

  /** The number of a share that arrives now: after every share before it. */
  @Synchronized
  fun arrive(): Long {
    arrived += 1
    undecided.add(arrived)
    return arrived
  }

  /** The newest number given so far (the start, before any share). */
  @Synchronized
  fun last(): Long = arrived

  /** The share has something for the page: the shares before it stop, and one that waits is dropped. */
  @Synchronized
  fun has(share: Long) {
    undecided.remove(share)
    if (share > newest) newest = share
    val (number, what) = waiting ?: return
    if (number < newest) {
      waiting = null
      drop(what)
    }
  }

  /** Whether no newer share has something yet: the share goes on copying. */
  @Synchronized
  fun going(share: Long): Boolean = newest <= share

  /** Whether the share is the newest with something and no newer share is still undecided: the one handed over. */
  @Synchronized
  fun latest(share: Long): Boolean = share > start && newest == share && undecided.higher(share) == null

  /**
   * The share ended with `what` for the page: what to hand over now (`what`), or null when it waits for a newer share
   * still undecided, or is dropped as a newer share has something.
   */
  @Synchronized
  fun ready(share: Long, what: T): T? {
    has(share)
    if (latest(share)) return what
    if (newest == share) waiting = share to what else drop(what)
    return null
  }

  /** The share ended with nothing: what an older share that waited for it has, when that is to be handed over now. */
  @Synchronized
  fun nothing(share: Long): T? {
    undecided.remove(share)
    val (number, what) = waiting ?: return null
    if (!latest(number)) return null
    waiting = null
    return what
  }
}
