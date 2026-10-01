import { CALL_SIGNAL_MAX_AGE_MS, parseCallSignal } from "./callSignal";

/**
 * Call signaling on a paired session (`calls/1`, WISP 601): the same compact signals a compatibility chat
 * keeps in its `_call` record, carried as one frame each on the authenticated session instead:
 *
 *     {"t":"paired-call","s":"<signal>"}
 *
 * The media is not on this session: it runs on a WebRTC connection of its own, whose DTLS fingerprint the
 * offer and answer carry, so whatever carries the chat (WebRTC, Iroh, HyperDHT) the media is bound to the
 * contact this session authenticated. Nothing about a call is ever published on the DHT.
 */
export const PAIRED_CALL_FRAME = "paired-call";

/** A compact offer with the eight candidates `parseCallSignal` accepts stays well under this. */
export const MAX_PAIRED_CALL_SIGNAL = 8192;

export interface PairedCallFrame { t: typeof PAIRED_CALL_FRAME; s: string }

/** The signal a `paired-call` frame carries, or null when it is not a fresh, well-formed one. */
export function parsePairedCallFrame(frame: Record<string, unknown>, now = Date.now()): string | null {
  const signal = frame.s;
  if (typeof signal !== "string" || signal.length > MAX_PAIRED_CALL_SIGNAL) return null;
  return parseCallSignal(signal, now) ? signal : null;
}

function signalKind(signal: string): unknown {
  try { return (JSON.parse(signal) as { t?: unknown }).t; } catch { return undefined; }
}

/**
 * This side's latest call signal. What could not go (the session dropped between two frames) goes on the
 * next session while it is still fresh, as the `_call` record of a compatibility chat is read on the next
 * poll; clearing it (after a hang-up, or a call that never started) means there is nothing left to say.
 */
export class PairedCalls {
  private latest: { signal: string; at: number } | null = null;
  /** When this side last said anything about a call, a clear included. */
  private saidAt = 0;
  /** The contact's latest signal on a session: its kind, and when it came. */
  private peer: { kind: unknown; at: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** A new signal to send (null clears it). Returns the frame to send now, if any. */
  set(signal: string | null): PairedCallFrame | null {
    this.saidAt = this.now();
    if (signal === null) { this.latest = null; return null; }
    if (signal.length > MAX_PAIRED_CALL_SIGNAL) throw new Error("Call signal too large");
    this.latest = { signal, at: this.saidAt };
    return { t: PAIRED_CALL_FRAME, s: signal };
  }

  /** A signal the contact sent (one `parsePairedCallFrame` took). */
  heard(signal: string): void {
    this.peer = { kind: signalKind(signal), at: this.now() };
  }

  /**
   * Whether a call is on, as the latest signal of either side says: an answer or a picture change, or an offer still
   * fresh enough to ring. A hang-up, a clear, or an offer nobody answered in time ends it. Read by kind, as `hangUp` is:
   * the media runs on a connection of its own, so an hour-long call shows nothing else on the session.
   */
  get on(): boolean {
    const own = { kind: this.latest ? signalKind(this.latest.signal) : "h", at: this.saidAt };
    const last = this.peer && this.peer.at > own.at ? this.peer : own;
    if (last.kind === "a" || last.kind === "v") return true;
    return last.kind === "o" && this.now() - last.at <= CALL_SIGNAL_MAX_AGE_MS;
  }

  /**
   * This app is going away: a call it placed or answered is hung up, as its person would (its latest signal an
   * offer, an answer, or a picture change, which only a call on sends). Returns the hang-up to send before the
   * goodbye, or null when no call of ours is on. Read by its kind, not its age: a call outlasts its offer's freshness.
   */
  hangUp(): PairedCallFrame | null {
    if (!this.latest) return null;
    let said: { t?: unknown; ts?: unknown };
    try { said = JSON.parse(this.latest.signal); } catch { return null; }
    if (said.t !== "o" && said.t !== "a" && said.t !== "v") return null;
    const ts = Math.max(this.now(), typeof said.ts === "number" ? said.ts + 1 : 0);
    return this.set(JSON.stringify({ t: "h", ts }));
  }

  /** On a new session that carries calls: the latest signal again, if it is still fresh enough to act on. */
  pending(): PairedCallFrame | null {
    if (!this.latest) return null;
    if (this.now() - this.latest.at > CALL_SIGNAL_MAX_AGE_MS) { this.latest = null; return null; }
    return { t: PAIRED_CALL_FRAME, s: this.latest.signal };
  }
}
