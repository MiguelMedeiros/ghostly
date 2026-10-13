package tools.ghostly.app

import java.util.concurrent.atomic.AtomicLong

/**
 * The order of shares from other apps (GhostlyHostPlugin `shared`). Each is numbered as it arrives (its folder's name),
 * but overtakes the shares before it only once it has something for the page: a file copied whole, a text or a title.
 * Then an older share still copying stops and is never handed over. A share that ends up with nothing (its one file
 * too big, a stream that cannot be opened) never stops one before it. Plain Kotlin, so a JVM unit test reads it.
 */
class ShareTurns(start: Long) {
  private val arrived = AtomicLong(start)
  /** The newest share that has something: every share before it stops. */
  private val newest = AtomicLong(start)

  /** The number of a share that arrives now: after every share before it. */
  fun arrive(): Long = arrived.incrementAndGet()

  /** The newest number given so far (the start, before any share). */
  fun last(): Long = arrived.get()

  /** The share has something for the page: the shares before it stop. */
  fun has(share: Long) {
    while (true) {
      val now = newest.get()
      if (now >= share || newest.compareAndSet(now, share)) return
    }
  }

  /** Whether no newer share has something yet: the share goes on copying. */
  fun going(share: Long): Boolean = newest.get() <= share

  /** Whether the share is the newest with something: the one handed over. */
  fun latest(share: Long): Boolean = newest.get() == share
}
