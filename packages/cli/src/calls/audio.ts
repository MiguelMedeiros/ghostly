import { FRAME_MS, frameBytes, frameSamples, PlaybackQueue, type CallRate } from "./pcm";
import { isRtcp, parseRtp, ReorderBuffer, RtpWriter } from "./rtp";

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
  private talking = false;
  private stopped = false;
  /** Frames sent and received, for `call list`. */
  sent = 0;
  received = 0;

  constructor(private readonly options: CallAudioOptions) {
    const now = options.now ?? Date.now;
    this.queue = new PlaybackQueue(options.rate, now);
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
  }

  /** Handles one packet from the track. Exposed for tests. */
  receive(packet: Buffer): void {
    if (this.stopped || isRtcp(packet)) return;
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
      // After a stall (a busy event loop), frames are not sent in a burst to catch up: the clock starts again.
      const late = now() - due;
      if (late > 5 * FRAME_MS) { this.startedAt = now(); this.ticks = 0; } else this.ticks++;
      this.tick();
      this.schedule();
    }, Math.max(0, due - now()));
  }
}
