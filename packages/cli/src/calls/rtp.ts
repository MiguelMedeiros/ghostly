import { randomBytes } from "node:crypto";

/**
 * RTP for a call's Opus audio (RFC 3550, RFC 7587): libdatachannel runs ICE, DTLS and SRTP, and hands this side
 * plain RTP packets each way. The RTP clock of Opus is 48 kHz whatever the audio's own rate.
 */
export const OPUS_CLOCK = 48_000;
/** RTP timestamp ticks in one 20 ms frame. */
export const TICKS_PER_FRAME = (OPUS_CLOCK * 20) / 1000;

export interface RtpPacket { payloadType: number; marker: boolean; sequence: number; timestamp: number; ssrc: number; payload: Buffer }

/** Whether a packet on the muxed port is RTCP (RFC 5761 § 4: its second byte is 192-223), not RTP. */
export function isRtcp(packet: Buffer): boolean {
  return packet.length >= 2 && packet[1] >= 192 && packet[1] <= 223;
}

/** Reads an RTP packet: CSRCs, a header extension and padding are stepped over. Null for anything malformed. */
export function parseRtp(packet: Buffer): RtpPacket | null {
  if (packet.length < 12 || packet[0] >> 6 !== 2 || isRtcp(packet)) return null;
  let offset = 12 + (packet[0] & 0x0f) * 4;
  if (packet[0] & 0x10) {
    if (packet.length < offset + 4) return null;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  let end = packet.length;
  if (packet[0] & 0x20) {
    const padding = packet[packet.length - 1];
    if (padding === 0) return null;
    end -= padding;
  }
  if (end < offset) return null;
  return {
    payloadType: packet[1] & 0x7f,
    marker: (packet[1] & 0x80) !== 0,
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payload: packet.subarray(offset, end),
  };
}

/** Numbers this side's packets: one SSRC, a sequence and a timestamp from random starts. */
export class RtpWriter {
  private sequence = randomBytes(2).readUInt16BE(0);
  private timestamp = randomBytes(4).readUInt32BE(0);

  constructor(readonly ssrc: number, readonly payloadType: number) {}

  /** The next frame's packet. `marker` starts a talkspurt (the first sound after silence). */
  packet(payload: Buffer, marker = false): Buffer {
    const header = Buffer.allocUnsafe(12);
    header[0] = 0x80;
    header[1] = (marker ? 0x80 : 0) | (this.payloadType & 0x7f);
    header.writeUInt16BE(this.sequence, 2);
    header.writeUInt32BE(this.timestamp, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + TICKS_PER_FRAME) >>> 0;
    return Buffer.concat([header, payload]);
  }
}

/** What the reorder buffer gives out: a packet's payload to decode, or a frame that never came. */
export type Playout = { payload: Buffer } | { lost: true };

/** The most silence a gap in the packets becomes. */
const MAX_LOST_FRAMES = 3;

/** Sequence numbers compared across the 16-bit wrap: positive when `a` comes after `b`. */
export function sequenceDelta(a: number, b: number): number {
  const d = (a - b) & 0xffff;
  return d >= 0x8000 ? d - 0x10000 : d;
}

/**
 * Puts packets back in order, holding at most `depth` of them for one that is late: a lost packet costs one frame
 * of silence (40 ms of waiting at most), a duplicate or a packet that came too late is dropped, and a new stream (its
 * SSRC changed, or its sequence jumped) starts over.
 */
export class ReorderBuffer {
  private expected: number | null = null;
  private ssrc: number | null = null;
  private readonly held = new Map<number, Buffer>();

  constructor(private readonly depth = 2) {}

  push(packet: RtpPacket): Playout[] {
    if (this.ssrc !== packet.ssrc || this.expected === null || Math.abs(sequenceDelta(packet.sequence, this.expected)) > 1000) {
      this.ssrc = packet.ssrc;
      this.expected = packet.sequence;
      this.held.clear();
    }
    const ahead = sequenceDelta(packet.sequence, this.expected);
    if (ahead < 0 || this.held.has(packet.sequence)) return [];
    this.held.set(packet.sequence, packet.payload);
    const out: Playout[] = [];
    this.release(out);
    // Still waiting for one that is late: once too many wait behind it, the gap is given up for lost. A long gap
    // (the network stalled) is not replayed as that much silence: a few frames of it mark the break.
    while (this.held.size > this.depth) {
      const next = [...this.held.keys()].reduce((a, b) => (sequenceDelta(a, b) < 0 ? a : b));
      const gap = sequenceDelta(next, this.expected);
      for (let i = 0; i < Math.min(gap, MAX_LOST_FRAMES); i++) out.push({ lost: true });
      this.expected = next;
      this.release(out);
    }
    return out;
  }

  private release(out: Playout[]): void {
    for (;;) {
      const payload = this.held.get(this.expected!);
      if (!payload) return;
      this.held.delete(this.expected!);
      out.push({ payload });
      this.expected = (this.expected! + 1) & 0xffff;
    }
  }
}
