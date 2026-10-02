/**
 * Whether this device's own clock seems to be off, and by how much, so the app can say so where people look at the
 * connection (the chat's connection panel, Settings → Network): "This device's clock seems to be off by about 2 minutes.
 * Chats may be slow to connect."
 *
 * Ghostly dates what it publishes by this device's clock, and several of its checks hold a contact's dates against
 * it. A clock a few minutes off makes chats and groups slow to connect, or never connect with apps that have not been
 * updated, and nothing on screen says why. The app cannot set the clock; it can notice and say.
 *
 * What it hears (`ClockWatch`), each as "this clock minus theirs is between `low` and `high`":
 * - a **server**: the `Date` header of an HTTP answer (a Pkarr relay's), a time to the second read between the moment
 *   the request went out and the moment its answer came. Where a browser may not read that header of another origin,
 *   there is none.
 * - a **contact**: the time of a contact's packet that came between two close reads of its record. Its own clock dated
 *   it, and this device knows within seconds when it was published.
 *
 * The rule, on purpose slow to say yes, and never on one contact's word (it is as likely that contact's clock):
 * - a source says "off" only when everything it allows is more than `CLOCK_OFF_MS` on one side;
 * - two servers that both say so, the same way, are enough: servers keep time;
 * - else one server and a contact that say so, with no contact saying otherwise;
 * - else three contacts that say so, the same way, and at least three for each one that does not.
 * The amount is the middle of what the sources that say so give (the servers', when two do). Evidence older than
 * `CLOCK_EVIDENCE_MS` says nothing: a clock that was set right is believed at the next answer, and the note goes away.
 */
/** A clock closer than this to the others' is not said to be off: a minute is what apps up to 1.0.2 allow at their strictest. */
export const CLOCK_OFF_MS = 60_000;
/** Evidence older than this says nothing about the clock now. */
export const CLOCK_EVIDENCE_MS = 30 * 60_000;
/** Contacts that must say so when no server does. */
export const CLOCK_PEERS = 3;
/** Servers that are enough by themselves. */
export const CLOCK_SERVERS = 2;
/** A contact's packet says something only when the two reads around it were this close. */
export const CLOCK_PEER_READ_GAP_MS = 15_000;
/** Sources kept of each kind: a profile has a few relays, and may have hundreds of contacts. */
const KEPT = 64;

export interface ClockSample { low: number; high: number; at: number }

/** -1: everything the sample allows is behind by more than `CLOCK_OFF_MS`; 1: ahead; 0: it does not say. */
const says = (sample: ClockSample): -1 | 0 | 1 => (sample.low > CLOCK_OFF_MS ? 1 : sample.high < -CLOCK_OFF_MS ? -1 : 0);
const middle = (values: number[]): number => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; };

/**
 * The rule alone: how far this clock is from the others' (ms, positive when it is ahead) when the samples fresh at
 * `now` say it is clearly off, else null.
 */
export function clockOffset(servers: ReadonlyMap<string, ClockSample>, peers: ReadonlyMap<string, ClockSample>, now: number): number | null {
  const fresh = (samples: ReadonlyMap<string, ClockSample>) => [...samples.values()].filter(s => now - s.at < CLOCK_EVIDENCE_MS);
  const s = fresh(servers), p = fresh(peers);
  const mid = (sample: ClockSample) => (sample.low + sample.high) / 2;
  for (const way of [1, -1] as const) {
    const serversOff = s.filter(x => says(x) === way), peersOff = p.filter(x => says(x) === way);
    const serversNot = s.length - serversOff.length, peersNot = p.length - peersOff.length;
    if (serversOff.length >= CLOCK_SERVERS && serversNot === 0) return Math.round(middle(serversOff.map(mid)));
    // A server that does not say so, when one could be read, outweighs any number of contacts.
    if (serversNot > 0) continue;
    if (serversOff.length === 1 && peersOff.length >= 1 && peersNot === 0) return Math.round(middle([...serversOff, ...peersOff].map(mid)));
    if (peersOff.length >= CLOCK_PEERS && peersOff.length >= 3 * peersNot) return Math.round(middle(peersOff.map(mid)));
  }
  return null;
}

export class ClockWatch {
  private readonly servers = new Map<string, ClockSample>();
  private readonly peers = new Map<string, ClockSample>();
  private was: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `onChange`: what `offset` says changed (it appeared, went away, or moved by a minute). */
  constructor(private readonly onChange: (offset: number | null) => void = () => {}, private readonly now: () => number = Date.now) {}

  /**
   * A server's time: `date` (ms, to the second) from an answer to a request that went out at `sent` and came back at
   * `received`, both by this clock.
   */
  server(source: string, date: number, sent: number, received: number): void {
    if (!Number.isFinite(date) || date <= 0 || received < sent) return;
    // The answer was made somewhere between the two, at a server time between `date` and the end of that second.
    this.keep(this.servers, source, { low: sent - date - 999, high: received - date, at: this.now() });
  }

  /**
   * A contact's packet, dated `packetAt` by its clock, that came between this device's reads of its record at
   * `readBefore` and `readAt` (this clock). Says nothing when the two reads were far apart.
   */
  peer(peer: string, packetAt: number, readBefore: number, readAt: number): void {
    if (!(readBefore > 0) || readAt < readBefore || readAt - readBefore > CLOCK_PEER_READ_GAP_MS || !Number.isFinite(packetAt)) return;
    this.keep(this.peers, peer, { low: readBefore - packetAt, high: readAt - packetAt, at: this.now() });
  }

  private keep(samples: Map<string, ClockSample>, source: string, sample: ClockSample): void {
    samples.delete(source);
    samples.set(source, sample);
    if (samples.size > KEPT) samples.delete(samples.keys().next().value!);
    this.settle();
  }

  /** This clock minus the others', in ms (positive: ahead), when it is clearly off; else null. */
  get offset(): number | null { return clockOffset(this.servers, this.peers, this.now()); }

  /** The clock was set, or the evidence is of another time: nothing is known until the next answers. */
  reset(): void {
    this.servers.clear();
    this.peers.clear();
    this.settle();
  }

  /** Stops the timer that lets the evidence age out. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private settle(): void {
    this.close();
    for (const samples of [this.servers, this.peers]) for (const [source, sample] of samples) if (this.now() - sample.at >= CLOCK_EVIDENCE_MS) samples.delete(source);
    const offset = this.offset;
    if (offset !== null) {
      // Looked at again when the oldest evidence ages out: what is left may no longer be enough.
      const oldest = Math.min(...[...this.servers.values(), ...this.peers.values()].map(s => s.at));
      this.timer = setTimeout(() => this.settle(), Math.max(1_000, oldest + CLOCK_EVIDENCE_MS - this.now()));
      (this.timer as { unref?: () => void }).unref?.();
    }
    // Told again only when it would read differently: the note says minutes.
    const reads = (value: number | null) => (value === null ? null : Math.round(value / 60_000));
    if (reads(offset) === reads(this.was)) return;
    this.was = offset;
    this.onChange(offset);
  }
}
