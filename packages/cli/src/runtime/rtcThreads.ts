/**
 * How long no WebRTC connection is open before libdatachannel's threads are let go. For tests,
 * `GHOSTLY_TEST_RTC_IDLE_MS=<ms>` sets it.
 */
export const RTC_IDLE_MS = Number(process.env.GHOSTLY_TEST_RTC_IDLE_MS) || 60_000;

/**
 * libdatachannel's threads (usrsctp's timer, a tick every 10 ms, and a pool of a thread per core) start with the
 * process's first WebRTC connection and stay for its life, every connection closed or not: a daemon whose contacts all
 * went away woke about 100 times a second for good. Every connection made here (a chat's data link, a call's) is
 * counted from its making to its close; once none has been open for `idleMs`, node-datachannel's `cleanup()` lets them
 * go, and the next connection starts them again. `cleanup()` closes every connection there is: it runs only with none
 * open, checked again once it has been loaded.
 */
export class RtcThreads {
  private open = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly cleanup: () => void | Promise<void>, private readonly idleMs = RTC_IDLE_MS) {}

  /** No connection is open. */
  get idle(): boolean {
    return this.open === 0;
  }

  /** A connection made: what to call once it is closed (once; more calls do nothing). */
  opened(): () => void {
    this.open++;
    clearTimeout(this.timer);
    this.timer = undefined;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      if (--this.open > 0) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.open === 0) void Promise.resolve(this.cleanup()).catch(() => { /* the threads stay, as before */ });
      }, this.idleMs);
      this.timer.unref?.();
    };
  }
}

/** The process's one count: the chats' connections and the calls' share libdatachannel's threads. */
export const rtcThreads = new RtcThreads(async () => {
  const ndc = (await import("node-datachannel")) as unknown as { cleanup?: () => void; default?: { cleanup(): void } };
  // A connection made while the module loaded keeps them.
  if (rtcThreads.idle) (ndc.cleanup ?? ndc.default!.cleanup)();
});
