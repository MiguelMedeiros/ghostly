/**
 * A growing wait with a cap, for whatever a wallet asks about again until it gets an answer: a Cashu melt or swap whose
 * mint does not answer or keeps it pending, restored ecash at a mint that cannot say what is spent, a Lightning card's
 * payment its source keeps pending or cannot be reached about. Asked at a fixed pace, each of these knocked on a dead
 * mint or source every 15 to 60 s for as long as the app ran.
 *
 * Each key is asked at `firstMs` while it is `fast` (a request may still land, the payment is new), then twice as late
 * after every ask with no answer, up to `capMs`. The pace lives in memory: an app start asks at once, and so does a
 * caller that knows something changed (it `forget`s the key, or asks whatever the pace says).
 */
export class AskBackoff<K = string> {
  private readonly paces = new Map<K, { at: number; wait: number }>();

  constructor(private readonly firstMs: number, private readonly capMs: number) {}

  /** Whether `key` may be asked now: never asked in this run, or its time came. */
  due(key: K, now: number): boolean {
    const pace = this.paces.get(key);
    return !pace || now >= pace.at;
  }

  /** When `key` is asked next; `now` if it never was in this run. */
  at(key: K, now: number): number {
    return this.paces.get(key)?.at ?? now;
  }

  /**
   * `key` was asked and gave no answer (unreachable, an error, still pending). The next ask waits `firstMs` while
   * `fast`, else twice the last wait, up to `capMs`. Returns that wait.
   */
  missed(key: K, now: number, fast = false): number {
    const last = this.paces.get(key)?.wait;
    const wait = fast || last === undefined ? this.firstMs : Math.min(last * 2, this.capMs);
    this.paces.set(key, { at: now + wait, wait });
    return wait;
  }

  /** `key` answered, or is gone: its next ask is due at once. */
  forget(key: K): void {
    this.paces.delete(key);
  }

  /** Forgets every key but these (the ones still open). */
  keepOnly(keys: ReadonlySet<K>): void {
    for (const key of this.paces.keys()) if (!keys.has(key)) this.paces.delete(key);
  }
}
