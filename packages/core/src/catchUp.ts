/**
 * Frames of one catch-up answer in a slice, two slices at most not handled yet by the member's app: the next goes once
 * it handled the one before the last. An app holds 64 frames waiting at most before 2026-10-07 (more ends the session),
 * and a member back in a busy group was handed over a hundred at once (a private group's answer, WISP 902; a
 * community's, WISP 903: 258 from a full store).
 */
export const CATCH_UP_SLICE = 16;
/** Between two slices, when the member's app cannot say it handled one (`handled` resolves `false`). */
export const CATCH_UP_PAUSE_MS = 500;

/** What `CatchUpHooks.handled` says: handled, cannot tell (`false`), or not handled yet within its wait (`"late"`). */
export type CatchUpHandled = boolean | "late";

export interface CatchUpHooks<F> {
  /** One frame to the member: `false` when its edge did not take it, which ends the answer. */
  send(to: string, frame: F): boolean | void;
  /**
   * Resolves once the member's app handled every frame sent to it so far (it answers a ping in the order frames come),
   * or `false` when it cannot tell: the answer then waits `CATCH_UP_PAUSE_MS` between slices. `"late"`: the member's app
   * answers pings but has not handled them yet (a phone with a long history), and the answer asks again rather than
   * sending more. Absent: an answer goes all at once, as before 2026-10-07.
   */
  handled?(to: string): Promise<CatchUpHandled>;
  /** Whether the group still answers: an answer stops when it no longer does. */
  active(): boolean;
  /**
   * What names a frame that a newer answer leaves out while it is on its way (`handled` not resolved yet), or undefined
   * for one that always goes. Absent: a newer answer has every frame of its own.
   */
  key?(frame: F): string | undefined;
}

/**
 * Catch-up answers, a slice at a time (`CATCH_UP_SLICE`), with two slices at most not handled yet by the member's app
 * (`hooks.handled`): the next once it handled the one before the last, so the slices follow each other without a round
 * trip between them. All at once, a member back in a busy group was handed over a hundred frames on one session, and an
 * app that holds 64 waiting ended that session mid catch-up ("Session receive limit exceeded", 2026-10-07). The frames
 * and their order are what they were: only when they go changes.
 */
export class CatchUpAnswers<F> {
  /** Answers still going out, per member: what is left of each. */
  private going = new Map<string, F[]>();
  /**
   * Per member, the frames sent (`hooks.key`) whose `handled` has not resolved yet: still waiting in its app, which asks
   * again every 10 s while it handles 1 or 2 a second, and each answer sent the same ones again (200 missed went 1,009
   * times). Left out of a newer answer until handled; one handled and still missing (lost) goes in the next.
   */
  private onTheirWay = new Map<string, Set<string>>();

  constructor(private readonly hooks: CatchUpHooks<F>) {}

  /**
   * The first two slices go now, the rest without holding the group's other frames back. A newer answer to the same
   * member goes after what is left of the last, without the frames still queued there (the same objects: a store's)
   * nor those still on their way (`onTheirWay`); it took their place before, and left out what the member's `have`
   * said it held: a live frame of an author raises it above that author's frames still queued, which were lost for
   * good. A frame the edge did not take ends the answer (the member asks again when its edge opens).
   */
  handOut(to: string, frames: F[]): void {
    const handled = this.hooks.handled;
    if (!handled) { for (const frame of frames) this.hooks.send(to, frame); return; }
    const sent = this.onTheirWay.get(to), key = this.hooks.key;
    if (sent?.size && key) frames = frames.filter(frame => { const k = key(frame); return k === undefined || !sent.has(k); });
    const going = this.going.get(to);
    if (going) { const queued = new Set(going); going.push(...frames.filter(frame => !queued.has(frame))); return; }
    const rest = [...frames], told: Promise<CatchUpHandled>[] = [];
    const ask = () => handled(to).catch(() => false as const);
    // Late, from an app that answers pings: still handling, so it is asked again until it has (a pause there let a
    // member at 600 ms a frame hold 134 waiting, past the 64 an app before 2026-10-07 takes).
    const settled = async () => {
      let answer = await ask();
      while (answer === "late" && this.hooks.active()) answer = await ask();
      return answer;
    };
    const next = () => {
      const slice = this.sendSlice(to, rest);
      if (!slice) return false;
      // After the last slice, asked only to know when its frames are no longer on their way.
      const keys = key ? slice.map(key).filter((k): k is string => k !== undefined) : [];
      if (!rest.length && !keys.length) return true;
      const done = settled();
      if (keys.length) this.track(to, keys, done);
      if (rest.length) told.push(done);
      return true;
    };
    if (!next() || !next() || !rest.length) return;
    this.going.set(to, rest);
    void (async () => {
      try {
        while (rest.length) {
          const answer = await told.shift()!;
          if (!answer) await new Promise(resolve => setTimeout(resolve, CATCH_UP_PAUSE_MS));
          if (!this.hooks.active() || !next()) break;
        }
      } finally { this.going.delete(to); }
    })();
  }

  /** The next slice of `rest` to `to`, as sent: undefined, and nothing left, when the edge did not take one. */
  private sendSlice(to: string, rest: F[]): F[] | undefined {
    const slice = rest.splice(0, CATCH_UP_SLICE);
    for (const frame of slice) if (this.hooks.send(to, frame) === false) { rest.length = 0; return undefined; }
    return slice;
  }

  /** A slice's frames (`keys`) are on their way to `to` until `done`: its app handled them, or cannot say (`false`). */
  private track(to: string, keys: string[], done: Promise<CatchUpHandled>): void {
    let sent = this.onTheirWay.get(to);
    if (!sent) this.onTheirWay.set(to, (sent = new Set()));
    for (const k of keys) sent.add(k);
    void done.then(() => {
      for (const k of keys) sent.delete(k);
      if (!sent.size && this.onTheirWay.get(to) === sent) this.onTheirWay.delete(to);
    });
  }
}
