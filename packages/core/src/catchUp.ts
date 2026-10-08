/**
 * Frames of one catch-up answer in a slice, two slices at most not handled yet by the member's app: the next goes once
 * it handled the one before the last. An app holds 64 frames waiting at most before 2026-10-07 (more ends the session),
 * and a member back in a busy group was handed over a hundred at once (a private group's answer, WISP 902; a
 * community's, WISP 903: 258 from a full store).
 */
export const CATCH_UP_SLICE = 16;
/** Between two slices, when the member's app cannot say it handled one (`handled` resolves `false`). */
export const CATCH_UP_PAUSE_MS = 500;

export interface CatchUpHooks<F> {
  /** One frame to the member: `false` when its edge did not take it, which ends the answer. */
  send(to: string, frame: F): boolean | void;
  /**
   * Resolves once the member's app handled every frame sent to it so far (it answers a ping in the order frames come),
   * or `false` when it cannot tell: the answer then waits `CATCH_UP_PAUSE_MS` between slices. Absent: an answer goes
   * all at once, as before 2026-10-07.
   */
  handled?(to: string): Promise<boolean>;
  /** Whether the group still answers: an answer stops when it no longer does. */
  active(): boolean;
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

  constructor(private readonly hooks: CatchUpHooks<F>) {}

  /**
   * The first two slices go now, the rest without holding the group's other frames back. A newer answer to the same
   * member takes the place of what is left of the last; a frame the edge did not take ends it (the member asks again
   * when its edge opens).
   */
  handOut(to: string, frames: F[]): void {
    const handled = this.hooks.handled;
    if (!handled) { for (const frame of frames) this.hooks.send(to, frame); return; }
    const going = this.going.get(to);
    if (going) { going.splice(0, going.length, ...frames); return; }
    const rest = [...frames], told: Promise<boolean>[] = [];
    const next = () => {
      if (!this.sendSlice(to, rest)) return false;
      if (rest.length) told.push(handled(to).catch(() => false));
      return true;
    };
    if (!next() || !next() || !rest.length) return;
    this.going.set(to, rest);
    void (async () => {
      try {
        while (rest.length) {
          if (!await told.shift()!) await new Promise(resolve => setTimeout(resolve, CATCH_UP_PAUSE_MS));
          if (!this.hooks.active() || !next()) break;
        }
      } finally { this.going.delete(to); }
    })();
  }

  /** The next slice of `rest` to `to`: false, and nothing left, when the edge did not take one. */
  private sendSlice(to: string, rest: F[]): boolean {
    for (const frame of rest.splice(0, CATCH_UP_SLICE)) if (this.hooks.send(to, frame) === false) { rest.length = 0; return false; }
    return true;
  }
}
