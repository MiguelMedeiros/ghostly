import { COMMUNITY_TOPOLOGY, type Hub } from "@ghostly/core";

/**
 * A hub dates its beacon entry by its own clock, and a reader judges it by its own. A hub's time closer than this to
 * what this app saw is taken as written; past it the two clocks differ, and the entry is read in this app's time
 * (`HubClocks.inMyTime`). Half as long again as a hub's pace: what an entry may trail a reading by, between two clocks
 * that agree.
 */
const HUB_CLOCK_SLACK_MS = COMMUNITY_TOPOLOGY.beaconEveryMs * 1.5;
/** A hub's clock is remembered this long after its entry was last in the beacon. */
const HUB_CLOCK_KEPT_MS = 10 * 60_000;

/**
 * Each hub's clock as its beacon entry showed it (WISP 903 · Group Community § Topology, Clocks that differ; the mesh's
 * hubs read their beacon the same way, WISP 902 · Group Mesh § Hubs). Held against mine as it is, a hub whose clock is
 * a minute and a half from mine never looks fresh (its entry is "stale", or "not come yet"): a member saw no hub and a
 * hub with such a clock was no hub to anyone. So a hub's clock is learned from its entry: when the entry moved between
 * two readings of mine at most `readGapMs` apart, it was written between them, and what it says the time was then,
 * against my own (the middle of the two readings), is how far the two clocks are apart. An entry of a clock further
 * than `HUB_CLOCK_SLACK_MS` from mine is moved by that much (its `since` with it); one closer, or one not seen to move
 * yet, is taken as written. An entry that stops moving ages by my clock like any other.
 *
 * `readGapMs`: half of it is the most a learned difference is off by, so it stays under twice the slack (clocks that
 * agree are never moved).
 */
export class HubClocks {
  /** Per hub: the time it last said (`said`, its own clock), how far my clock is from it (`ahead`, ms: positive when mine is ahead), when last in the beacon. */
  private readonly clocks = new Map<string, { said: number; ahead?: number; at: number }>();
  /** My last reading that got an answer. */
  private seenAt = 0;

  constructor(private readonly me: () => string, private readonly readGapMs: number) {}

  /** A reading of the beacon (`read`, as the hubs wrote it) in my time, and what it says of each hub's clock. */
  inMyTime(read: Hub[], now: number): Hub[] {
    const gap = now - this.seenAt, me = this.me();
    for (const h of read) {
      if (h.key === me) continue;
      const known = this.clocks.get(h.key);
      // Moved since I last looked: written within `gap`, about half of it ago for all I know.
      const moved = !!known && h.ts > known.said && this.seenAt > 0 && gap <= this.readGapMs;
      this.clocks.set(h.key, { said: Math.max(h.ts, known?.said ?? 0), ahead: moved ? now - gap / 2 - h.ts : known?.ahead, at: now });
    }
    for (const [key, clock] of this.clocks) if (now - clock.at > HUB_CLOCK_KEPT_MS) this.clocks.delete(key);
    this.seenAt = now;
    return read.map(h => this.moved(h, this.ahead(h.key)));
  }

  /** How far my clock is ahead of a hub's (ms, negative when behind), when the two differ; 0 when they agree or nothing says. */
  ahead(hub: string): number {
    const ahead = hub === this.me() ? 0 : this.clocks.get(hub)?.ahead ?? 0;
    return Math.abs(ahead) > HUB_CLOCK_SLACK_MS ? Math.round(ahead) : 0;
  }

  /** Entries in my time, as each hub wrote them: what goes back into the beacon, so no hub's entry is dated by another's clock. */
  asWritten(hubs: Hub[]): Hub[] { return hubs.map(h => this.moved(h, -this.ahead(h.key))); }

  /** A hub's clock known otherwise (the commit that let me in, signed a moment ago by its clock): until its entry is seen to move. */
  learn(hub: string, ahead: number, now: number): void { this.clocks.set(hub, { said: 0, ahead, at: now }); }

  /** The next reading is of another beacon (a commit moved it): it says nothing of a move. What is known of each clock stays. */
  restart(): void { this.seenAt = 0; }

  private moved(h: Hub, by: number): Hub { return by ? { ...h, ts: h.ts + by, ...(h.since !== undefined && { since: h.since + by }) } : h; }
}
