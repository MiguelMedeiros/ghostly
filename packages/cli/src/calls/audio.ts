import { FRAME_MS, frameBytes, frameSamples, PlaybackQueue, type CallRate } from "./pcm";
import { isRtcp, parseRtp, ReorderBuffer, RtpWriter } from "./rtp";

/** The longest stall of the sender whose frames are still sent after it (see `catchUp`). */
export const MAX_CATCH_UP_MS = 1000;

/** An Opus encoder or decoder at one rate, mono (opusscript's shape). */
export interface OpusCodec {
  encode(pcm: Buffer, frameSize: number): Buffer;
  decode(packet: Buffer): Buffer;
  delete?(): void;
}

/** The call's audio lane: RTP packets out, and every packet (RTP and RTCP) that comes in. */
export interface RtpTrack {
  send(packet: Buffer): void;
  onPacket(listener: (packet: Buffer) => void): void;
}

export interface CallAudioOptions {
  rate: CallRate;
  /** What the call's SDP gives Opus. */
  payloadType: number;
  ssrc: number;
  track: RtpTrack;
  encoder: OpusCodec;
  decoder: OpusCodec;
  /** A 20 ms frame of the contact's audio, decoded. */
  onFrame(frame: Buffer): void;
  /** What the program wrote, to send (the call's own, kept from before the media existed); a new one if none. */
  queue?: PlaybackQueue;
  now?: () => number;
}

/**
 * One call's audio: every 20 ms a frame from the queue (the program's audio, or silence) is encoded and sent; what
 * comes in is put back in order, decoded, and handed on in 20 ms frames as soon as it is. Nothing waits on a clock
 * but the sending side, so the audio adds at most a frame of delay each way inside the CLI.
 */
export class CallAudio {
  readonly queue: PlaybackQueue;
  private readonly writer: RtpWriter;
  private readonly reorder = new ReorderBuffer();
  private readonly frame: number;
  private readonly samples: number;
  private readonly silence: Buffer;
  private pending: Buffer = Buffer.alloc(0);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private ticks = 0;
  /** What was left in the queue after the last frame sent: the program's audio written ahead of the call. */
  private ahead = 0;
  /** After a stall that was not replayed: how much of its audio is still to drop, down to what queue, and until when. */
  private owed = 0;
  private kept = 0;
  private owedUntil = 0;
  private talking = false;
  private stopped = false;
  /** Frames sent and received, for `call list`. */
  sent = 0;
  received = 0;
  /** When the last packet, RTP or RTCP, came from the contact (Date.now(); 0: none yet), for the call's watch. */
  heardAt = 0;

  constructor(private readonly options: CallAudioOptions) {
    const now = options.now ?? Date.now;
    this.queue = options.queue ?? new PlaybackQueue(options.rate, now);
    this.writer = new RtpWriter(options.ssrc, options.payloadType);
    this.frame = frameBytes(options.rate);
    this.samples = frameSamples(options.rate);
    this.silence = Buffer.alloc(this.frame);
    options.track.onPacket((packet) => this.receive(packet));
  }

  /** Starts sending, a frame every 20 ms from now on. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.startedAt = (this.options.now ?? Date.now)();
    this.ticks = 0;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.options.encoder.delete?.();
    this.options.decoder.delete?.();
  }

  /** Sends the frame that is due now. Exposed for tests, which drive the clock themselves. */
  tick(): void {
    if (this.stopped) return;
    const { frame, silent } = this.queue.next();
    let payload: Buffer;
    try { payload = this.options.encoder.encode(frame, this.samples); } catch { return; }
    // A talkspurt starts at the first sound after silence (RFC 3551 § 4.1).
    const marker = !silent && !this.talking;
    this.talking = !silent;
    this.options.track.send(this.writer.packet(payload, marker));
    this.sent++;
    this.ahead = this.queue.queuedMs;
  }

  /** Handles one packet from the track. Exposed for tests. */
  receive(packet: Buffer): void {
    if (this.stopped) return;
    this.heardAt = (this.options.now ?? Date.now)();
    if (isRtcp(packet)) return;
    const rtp = parseRtp(packet);
    if (!rtp || rtp.payloadType !== this.options.payloadType) return;
    for (const item of this.reorder.push(rtp)) {
      let pcm: Buffer;
      if ("lost" in item) pcm = this.silence;
      else {
        try { pcm = this.options.decoder.decode(item.payload); } catch { pcm = this.silence; }
      }
      this.emit(pcm);
    }
  }

  /** Hands decoded audio on in 20 ms frames, whatever the contact's packet length (10, 20, 40 or 60 ms). */
  private emit(pcm: Buffer): void {
    let data = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
    while (data.length >= this.frame) {
      this.options.onFrame(Buffer.from(data.subarray(0, this.frame)));
      this.received++;
      data = data.subarray(this.frame);
    }
    this.pending = Buffer.from(data);
  }

  private schedule(): void {
    const now = this.options.now ?? Date.now;
    const due = this.startedAt + (this.ticks + 1) * FRAME_MS;
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      if (now() - due < FRAME_MS) { this.ticks++; this.drop(); this.tick(); this.schedule(); return; }
      // Late (a busy event loop: a file going out, a journal fsync, a Pkarr publish): what the program wrote meanwhile
      // is still in its socket, read after the timers of this turn, so the frames wait for that.
      setImmediate(() => {
        if (this.stopped) return;
        this.catchUp(now() - due);
        this.schedule();
      });
    }, Math.max(0, due - now()));
  }

  /**
   * Meets the clock again after the loop was busy: every frame that is due goes out at once, so a loop that turns
   * slower than a frame for a while (every 40 ms under a large file) keeps up, and a program writing at real time
   * stays there. The contact's jitter buffer takes the short burst. A stall past MAX_CATCH_UP_MS is not replayed: the
   * clock starts again and what the program wrote during it is dropped, or it would be heard that much late for the
   * rest of the call.
   */
  private catchUp(late: number): void {
    const now = this.options.now ?? Date.now;
    if (late > MAX_CATCH_UP_MS) {
      this.owed = late;
      this.kept = this.ahead;
      this.owedUntil = now() + MAX_CATCH_UP_MS;
      this.startedAt = now();
      this.ticks = 0;
      this.drop();
      this.tick();
      return;
    }
    do { this.ticks++; this.drop(); this.tick(); } while (this.startedAt + (this.ticks + 1) * FRAME_MS <= now());
  }

  /**
   * Drops the audio of a stall that was not replayed, as it is read: a long one does not fit the program's socket, so
   * the rest of it comes over the next turns. What was queued before the stall (a clip written ahead) is kept.
   */
  private drop(): void {
    if (this.owed <= 0) return;
    if ((this.options.now ?? Date.now)() > this.owedUntil) { this.owed = 0; return; }
    this.owed -= this.queue.skip(Math.min(this.owed, this.queue.queuedMs - this.kept));
  }
}
