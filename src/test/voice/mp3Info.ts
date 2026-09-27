/**
 * What an MP3 file says about itself, frame by frame: tests read it to know the encoder wrote a real file.
 * Only Layer III, the only layer written here. An ID3v2 tag at the start is skipped.
 */
export interface Mp3Info {
  frames: number;
  /** Every frame's channel mode is mono. */
  mono: boolean;
  sampleRate: number;
  /** kbit/s of the first frame. */
  bitrate: number;
  /** MPEG-1 frames hold 1152 samples, MPEG-2 and 2.5 (under 32 kHz) 576. */
  durationMs: number;
}

const RATES: Record<number, number[]> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] };
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Throws on the first byte that is not a frame header where one should start. */
export function mp3Info(bytes: Uint8Array): Mp3Info {
  let at = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    at = 10 + (((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f));
  }
  let frames = 0, samples = 0, mono = true, sampleRate = 0, bitrate = 0;
  while (at + 4 <= bytes.length) {
    const [b0, b1, b2, b3] = [bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!];
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) throw new Error(`No frame sync at byte ${at}`);
    const version = (b1 >> 3) & 3;
    if (version === 1 || !RATES[version]) throw new Error(`Reserved MPEG version at byte ${at}`);
    if (((b1 >> 1) & 3) !== 1) throw new Error(`Not Layer III at byte ${at}`);
    const rate = RATES[version]![(b2 >> 2) & 3];
    const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[b2 >> 4];
    if (!rate || !kbps) throw new Error(`Bad rate or bitrate at byte ${at}`);
    const perFrame = version === 3 ? 1152 : 576;
    const length = Math.floor((perFrame / 8) * kbps * 1000 / rate) + ((b2 >> 1) & 1);
    if (at + length > bytes.length) throw new Error(`Frame at byte ${at} is cut short`);
    if (!sampleRate) { sampleRate = rate; bitrate = kbps; }
    if (rate !== sampleRate) throw new Error(`Sample rate changes at byte ${at}`);
    if ((b3 >> 6) !== 3) mono = false;
    frames++;
    samples += perFrame;
    at += length;
  }
  if (!frames) throw new Error("No frames");
  return { frames, mono, sampleRate, bitrate, durationMs: (samples / sampleRate) * 1000 };
}
