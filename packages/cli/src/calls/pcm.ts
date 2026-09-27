/**
 * The audio a call hands to an outside program, and takes from it (WISP 11xx § Calls): raw PCM, signed 16-bit
 * little-endian, mono, at the call's rate, in frames of 20 ms. Opus runs at every one of these rates itself, so
 * nothing is resampled.
 */
export const FRAME_MS = 20;
export const CALL_RATES = [8000, 12000, 16000, 24000, 48000] as const;
export type CallRate = (typeof CALL_RATES)[number];
export const DEFAULT_RATE: CallRate = 48000;

export const frameSamples = (rate: CallRate): number => (rate * FRAME_MS) / 1000;
export const frameBytes = (rate: CallRate): number => frameSamples(rate) * 2;
export const bytesToMs = (rate: CallRate, bytes: number): number => Math.round((bytes / 2 / rate) * 1000);

export function isCallRate(value: unknown): value is CallRate {
  return CALL_RATES.includes(value as CallRate);
}

/** The most a program may queue ahead of the call: five minutes of speech. What goes past it is dropped. */
export const MAX_QUEUE_MS = 5 * 60_000;

/**
 * A partial frame waits this long for the rest of it before it is played padded with silence: a program writing at
 * real time, a little late, is not cut into gaps; a program that stopped mid-frame is still heard to its end.
 */
export const PARTIAL_WAIT_MS = 60;

/**
 * What the program wrote, waiting to be sent: taken one 20 ms frame per tick, silence when there is nothing, and
 * dropped whole by a flush (barge-in). The program may write any amount at any time, faster than real time too.
 */
export class PlaybackQueue {
  private chunks: Buffer[] = [];
  private head = 0;
  private length = 0;
  private lastPush = 0;
  private readonly frame: number;
  private readonly max: number;
  private readonly silence: Buffer;
  /** Bytes dropped because the queue was full, since the start. */
  dropped = 0;

  constructor(readonly rate: CallRate, private readonly now: () => number = Date.now, maxMs = MAX_QUEUE_MS) {
    this.frame = frameBytes(rate);
    // Whole samples only: an odd byte waits for its other half.
    this.max = Math.floor((rate * maxMs) / 1000) * 2;
    this.silence = Buffer.alloc(this.frame);
  }

  /** Adds what the program wrote. Returns the bytes it could not keep (the queue was full). */
  push(chunk: Buffer): number {
    if (!chunk.length) return 0;
    this.lastPush = this.now();
    const room = this.max - this.length;
    const kept = chunk.length <= room ? chunk : chunk.subarray(0, Math.max(0, room));
    const lost = chunk.length - kept.length;
    this.dropped += lost;
    if (kept.length) { this.chunks.push(Buffer.from(kept)); this.length += kept.length; }
    return lost;
  }

  /** Queued audio, in milliseconds (whole frames and a partial one). */
  get queuedMs(): number {
    return bytesToMs(this.rate, this.length - (this.length % 2));
  }

  /** One frame to send now, and whether it is the program's audio or silence. */
  next(): { frame: Buffer; silent: boolean } {
    if (this.length >= this.frame) return { frame: this.take(this.frame), silent: false };
    const whole = this.length - (this.length % 2);
    if (whole > 0 && this.now() - this.lastPush >= PARTIAL_WAIT_MS) {
      const frame = Buffer.alloc(this.frame);
      this.take(whole).copy(frame);
      return { frame, silent: false };
    }
    return { frame: this.silence, silent: true };
  }

  /** Drops everything queued; returns how much, in milliseconds. */
  flush(): number {
    const ms = this.queuedMs;
    this.chunks = [];
    this.head = 0;
    this.length = 0;
    return ms;
  }

  private take(bytes: number): Buffer {
    const out = Buffer.allocUnsafe(bytes);
    let filled = 0;
    while (filled < bytes) {
      const chunk = this.chunks[0];
      const n = Math.min(bytes - filled, chunk.length - this.head);
      chunk.copy(out, filled, this.head, this.head + n);
      filled += n;
      this.head += n;
      if (this.head === chunk.length) { this.chunks.shift(); this.head = 0; }
    }
    this.length -= bytes;
    return out;
  }
}
