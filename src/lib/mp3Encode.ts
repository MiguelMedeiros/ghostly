import { Mp3Encoder } from "@breezystack/lamejs";

/**
 * A voice message as MP3, for players that know no Opus. One channel at 24 kHz and 64 kbit/s is plenty for a
 * voice (the recording itself is 32 kbit/s Opus). The encoder is LAME in JavaScript (@breezystack/lamejs,
 * LGPL-3.0, unmodified), which only the conversion worker (`voiceMp3.worker.ts`) loads.
 */
export const MP3_SAMPLE_RATE = 24_000;
export const MP3_KBPS = 64;

/** Samples handed to the encoder at a time: a whole number of frames (576 samples each at 24 kHz). */
const STEP = 576 * 20;

/** MP3 bytes of mono samples (-1…1) at `sampleRate`. */
export function encodeMp3(samples: Float32Array, sampleRate = MP3_SAMPLE_RATE, kbps = MP3_KBPS): Uint8Array<ArrayBuffer> {
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const parts: Uint8Array[] = [];
  const block = new Int16Array(STEP);
  for (let offset = 0; offset < samples.length; offset += STEP) {
    const count = Math.min(STEP, samples.length - offset);
    for (let i = 0; i < count; i++) {
      const sample = Math.max(-1, Math.min(1, samples[offset + i]!));
      block[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    const out = encoder.encodeBuffer(count === STEP ? block : block.subarray(0, count));
    if (out.length) parts.push(out.slice());
  }
  const last = encoder.flush();
  if (last.length) parts.push(last.slice());
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return bytes;
}
