/*
 * One sound at a time. Sounds that come together (the app restarts and many chats and groups catch up at once, each
 * with its message, its cues and its "connected") never sound on top of one another:
 *
 * - A notice (anything the app hears about: a message, a mention, a coin, a cue, connected) holds the gate for
 *   `NOTICE_GAP_MS` after it starts. Another notice in that time is dropped, not queued: a late pile-up is as bad.
 * - Except right at the start: a more important notice that arrives within `TOGETHER_MS` of the one holding the gate
 *   takes its place (a mention over a message, a payment over a message). It stops the first one, which by then has
 *   most likely not been heard yet.
 * - A call's sounds (ring, ringback, hangup) are never dropped: they stop whatever sounds and hold the gate, and while a
 *   call rings no other sound plays.
 * - The interface's own sounds, played by a person's click (a card sliding or turning over, a spoiler, a delete, "Send
 *   real money", what I sent, a Settings preview), keep their own repeat rule (cues.ts REPEAT_MS) but never sound on top
 *   of a notice or a call: they are dropped while one holds the gate, and a notice that comes stops them. One replaces
 *   the other, so quick clicks do not stack either.
 */
import type { SoundName } from "./sounds";

export type SoundKind = "call" | "notice" | "interface";

/**
 * How long a notice holds the gate after it starts. The longest notice is 0.91 s ("connected"; most are 0.52 s, a
 * coin 0.73 s), so the next one never starts while one still sounds, and a burst is one sound with a short pause after.
 */
export const NOTICE_GAP_MS = 1_000;
/** Notices that arrive this close together came together: the more important one plays. */
export const TOGETHER_MS = 250;

const CALL: ReadonlySet<SoundName> = new Set<SoundName>(["ring", "ringback", "hangup"]);
const INTERFACE: ReadonlySet<SoundName> = new Set<SoundName>(["slide", "flip", "wallet", "spoiler", "deleted", "realmoney", "sent"]);

/** Which notice wins when they come together. Anything not named here is 2. */
const PRIORITY: Partial<Record<SoundName, number>> = {
  // A connection's ambient sounds.
  connected: 0, back: 0, switched: 0,
  message: 1,
  // Someone named me, or money moved.
  mention: 3, coin: 3, testcoins: 3, request: 3, paid: 3, confirmed: 3, failed: 3,
};

export function soundKind(name: SoundName): SoundKind {
  return CALL.has(name) ? "call" : INTERFACE.has(name) ? "interface" : "notice";
}

export const soundPriority = (name: SoundName): number => PRIORITY[name] ?? 2;

type Stop = () => void;

export class SoundGate {
  /** The notice or call sound that holds the gate, from `at`. */
  private held: { priority: number; at: number; stop: Stop } | undefined;
  /** The interface sound that may still sound. */
  private cue: Stop | undefined;

  /**
   * Whether `name` may start now. `stop` ends it, if a later sound takes its place; `ringing`: a call rings.
   * A sound let in is told back to the gate with `stopped` when it is stopped before its end.
   */
  admit(name: SoundName, stop: Stop, { now, ringing = false, kind = soundKind(name) }: { now: number; ringing?: boolean; kind?: SoundKind }): boolean {
    if (kind === "call") {
      this.silence();
      this.held = { priority: Infinity, at: now, stop };
      return true;
    }
    if (ringing) return false;
    const held = this.held && now - this.held.at < NOTICE_GAP_MS ? this.held : undefined;
    if (kind === "interface") {
      if (held) return false;
      this.cue?.();
      this.cue = stop;
      return true;
    }
    const priority = soundPriority(name);
    if (held && !(priority > held.priority && now - held.at < TOGETHER_MS)) return false;
    this.silence();
    this.held = { priority, at: now, stop };
    return true;
  }

  /** A sound was stopped before its end (taken over, muted, a call answered): it no longer holds the gate. */
  stopped(stop: Stop): void {
    if (this.held?.stop === stop) this.held = undefined;
    if (this.cue === stop) this.cue = undefined;
  }

  /** Stops what sounds now. */
  private silence(): void {
    const { held, cue } = this;
    held?.stop();
    cue?.();
    this.held = undefined;
    this.cue = undefined;
  }
}
