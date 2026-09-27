import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { voicePeaksOf } from "@ghostly/core";

/**
 * The waveform and length of a voice note sent from a file (`file send --voice`), measured as the apps measure their
 * own recordings (packages/core voice.ts `voicePeaksOf`, the recorder's meter) so the bars look the same. The sound is
 * decoded here, without native code: WAV by hand, Opus in WebM or Ogg and MP3 with the wasm decoders, anything
 * else (AAC in MP4, FLAC…) with `ffmpeg` when it is on the PATH.
 */

export interface Sound {
  /** One channel, -1 to 1: the channels averaged, as the recorder's analyser hears them. */
  mono: Float32Array;
  sampleRate: number;
}

export interface VoiceMeasure { duration: number; peaks: number[] }

/** Longer than any voice note (15 minutes) with room: a file past it is not decoded into memory. */
const MAX_BYTES = 256 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 120_000;

/** The waveform and length of the sound in `path`, or why they could not be read. */
export async function measureVoice(path: string): Promise<{ voice: VoiceMeasure } | { problem: string }> {
  let sound: Sound;
  try {
    sound = await decodeSound(path);
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  if (sound.mono.length === 0) return { problem: "no sound in it" };
  return { voice: { duration: Math.round((sound.mono.length / sound.sampleRate) * 1000), peaks: voicePeaksOf(sound.mono, sound.sampleRate) } };
}

export async function decodeSound(path: string): Promise<Sound> {
  const bytes = await readFile(path);
  if (bytes.length > MAX_BYTES) throw new Error("too large to decode");
  let own: Error | undefined;
  try {
    const sound = await decodeBytes(bytes);
    if (sound) return sound;
  } catch (error) {
    own = error instanceof Error ? error : new Error(String(error));
  }
  try {
    return await decodeWithFfmpeg(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(own ? `${own.message}; ${reason}` : reason);
  }
}

/** The sound in a file this module decodes itself, or null for a kind it leaves to ffmpeg. */
export async function decodeBytes(bytes: Uint8Array): Promise<Sound | null> {
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return decodeWav(bytes);
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const opus = demuxWebm(bytes);
    return opus ? decodeOpus(opus) : null;
  }
  if (ascii(bytes, 0, 4) === "OggS") {
    const opus = demuxOgg(bytes);
    return opus ? decodeOpus(opus) : null;
  }
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return decodeMp3(bytes);
  return null;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function mix(channels: Float32Array[], length: number): Float32Array {
  if (channels.length === 1) return channels[0]!.subarray(0, length);
  const mono = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i]! += channel[i]! / channels.length;
  return mono;
}

// ---------- WAV ----------

/** PCM (8, 16, 24 or 32 bit) or float (32 or 64 bit) WAV. A data chunk whose size is unknown (a pipe) runs to the end. */
export function decodeWav(bytes: Uint8Array): Sound {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = 0, channels = 0, sampleRate = 0, bits = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first two bytes.
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      if (!channels || !sampleRate || !bits) throw new Error("a WAV without its format");
      const end = size === 0 || size === 0xffffffff || body + size > bytes.length ? bytes.length : body + size;
      return { mono: wavSamples(view, body, end, format, channels, bits), sampleRate };
    }
    at = body + size + (size & 1);
  }
  throw new Error("a WAV without sound");
}

function wavSamples(view: DataView, from: number, to: number, format: number, channels: number, bits: number): Float32Array {
  const width = bits / 8;
  const read: ((at: number) => number) | undefined =
    format === 1 && bits === 8 ? (at) => (view.getUint8(at) - 128) / 128
    : format === 1 && bits === 16 ? (at) => view.getInt16(at, true) / 32768
    : format === 1 && bits === 24 ? (at) => (((view.getInt8(at + 2) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at)) / 8388608)
    : format === 1 && bits === 32 ? (at) => view.getInt32(at, true) / 2147483648
    : format === 3 && bits === 32 ? (at) => view.getFloat32(at, true)
    : format === 3 && bits === 64 ? (at) => view.getFloat64(at, true)
    : undefined;
  if (!read) throw new Error(`a WAV in a format not read here (${format}, ${bits} bit)`);
  const frames = Math.floor((to - from) / (width * channels));
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(from + (frame * channels + c) * width);
    mono[frame] = sum / channels;
  }
  return mono;
}

// ---------- Opus (WebM, Ogg) ----------

export interface OpusStream {
  /** The OpusHead (RFC 7845): channels, pre-skip, channel mapping. */
  head: Uint8Array | null;
  channels: number;
  frames: Uint8Array[];
  /** Ogg's last granule position: where the sound really ends (the last frame is padded). */
  endGranule?: number;
}

/** A variable-length number in EBML: its length in bytes and value (the marker bit kept for ids, dropped for sizes). */
function vint(bytes: Uint8Array, at: number, keepMarker: boolean): { length: number; value: number; unknown: boolean } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i]!;
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { length, value, unknown: !keepMarker && allOnes };
}

/** Elements whose children are read: EBML Segment, Tracks, TrackEntry, Audio, Cluster, BlockGroup. */
const WEBM_PARENTS = new Set([0x18538067, 0x1654ae6b, 0xae, 0xe1, 0x1f43b675, 0xa0]);

/**
 * The Opus track of a WebM (Matroska) file. It reads the file in order, stepping into the elements that hold what it
 * needs rather than jumping by their sizes: MediaRecorder writes the Segment and every Cluster with an unknown size.
 */
export function demuxWebm(bytes: Uint8Array): OpusStream | null {
  interface Track { number: number; codec: string; head: Uint8Array | null; channels: number }
  const tracks: Track[] = [];
  const blocks: { track: number; data: Uint8Array }[] = [];
  let at = 0;
  while (at < bytes.length) {
    const id = vint(bytes, at, true);
    if (!id) break;
    const size = vint(bytes, at + id.length, false);
    if (!size) break;
    const body = at + id.length + size.length;
    if (WEBM_PARENTS.has(id.value)) {
      if (id.value === 0xae) tracks.push({ number: 0, codec: "", head: null, channels: 0 });
      at = body;
      continue;
    }
    if (size.unknown) break;
    const end = Math.min(bytes.length, body + size.value);
    const data = bytes.subarray(body, end);
    const track = tracks.at(-1);
    if (id.value === 0xd7 && track) track.number = uint(data);
    else if (id.value === 0x86 && track) track.codec = ascii(data, 0, data.length);
    else if (id.value === 0x63a2 && track) track.head = data;
    else if (id.value === 0x9f && track) track.channels = uint(data);
    else if (id.value === 0xa3 || id.value === 0xa1) {
      const number = vint(data, 0, false);
      if (number) for (const frame of laced(data, number.length)) blocks.push({ track: number.value, data: frame });
    }
    at = end;
  }
  const opus = tracks.find((t) => t.codec === "A_OPUS");
  if (!opus) return null;
  return { head: opus.head, channels: opus.channels || 1, frames: blocks.filter((b) => b.track === opus.number).map((b) => b.data) };
}

function uint(data: Uint8Array): number {
  let value = 0;
  for (const byte of data) value = value * 256 + byte;
  return value;
}

/** The frames in a (Simple)Block after its track number: one, or several laced (Xiph, fixed-size or EBML). */
function laced(data: Uint8Array, at: number): Uint8Array[] {
  const flags = data[at + 2]!;
  let pos = at + 3;
  const lacing = (flags >> 1) & 3;
  if (lacing === 0) return [data.subarray(pos)];
  const count = data[pos++]! + 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    for (let i = 0; i < count - 1; i++) {
      let size = 0;
      for (let byte = 255; byte === 255; size += byte) byte = data[pos++]!;
      sizes.push(size);
    }
  } else if (lacing === 3) {
    const first = vint(data, pos, false)!;
    pos += first.length;
    sizes.push(first.value);
    for (let i = 1; i < count - 1; i++) {
      const delta = vint(data, pos, false)!;
      pos += delta.length;
      // A signed difference from the size before: the value less half its range.
      sizes.push(sizes[i - 1]! + delta.value - (2 ** (7 * delta.length - 1) - 1));
    }
  } else {
    const each = Math.floor((data.length - pos) / count);
    for (let i = 0; i < count - 1; i++) sizes.push(each);
  }
  sizes.push(data.length - pos - sizes.reduce((a, b) => a + b, 0));
  const frames: Uint8Array[] = [];
  for (const size of sizes) { frames.push(data.subarray(pos, pos + size)); pos += size; }
  return frames;
}

/** The first Opus stream of an Ogg file: its packets put back together from the pages' segments. */
export function demuxOgg(bytes: Uint8Array): OpusStream | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let serial: number | undefined;
  let head: Uint8Array | null = null;
  const frames: Uint8Array[] = [];
  let packet: Uint8Array[] = [];
  let endGranule: number | undefined;
  let at = 0;
  while (at + 27 <= bytes.length && ascii(bytes, at, 4) === "OggS") {
    const segments = bytes[at + 26]!;
    const table = bytes.subarray(at + 27, at + 27 + segments);
    let pos = at + 27 + segments;
    const pageSerial = view.getUint32(at + 14, true);
    const granule = Number(view.getBigInt64(at + 6, true));
    const mine = serial === undefined ? ascii(bytes, pos, 8) === "OpusHead" : pageSerial === serial;
    if (mine) {
      serial = pageSerial;
      if (granule >= 0) endGranule = granule;
      for (const size of table) {
        packet.push(bytes.subarray(pos, pos + size));
        pos += size;
        if (size < 255) {
          const whole = packet.length === 1 ? packet[0]! : Buffer.concat(packet);
          packet = [];
          if (!head) head = whole;
          else if (ascii(whole, 0, 8) !== "OpusTags") frames.push(whole);
        }
      }
    } else pos += table.reduce((a, b) => a + b, 0);
    at = pos;
  }
  if (!head) return null;
  return { head, channels: head[9] ?? 1, frames, endGranule };
}

export async function decodeOpus(stream: OpusStream): Promise<Sound> {
  const { OpusDecoder } = await import("opus-decoder");
  const head = stream.head && ascii(stream.head, 0, 8) === "OpusHead" ? stream.head : null;
  const channels = head ? head[9]! : Math.max(1, stream.channels);
  const preSkip = head ? head[10]! | (head[11]! << 8) : 0;
  const family = head ? head[18]! : 0;
  const mapping = family !== 0 && head
    ? { streamCount: head[19]!, coupledStreamCount: head[20]!, channelMappingTable: [...head.subarray(21, 21 + channels)] }
    : { streamCount: 1, coupledStreamCount: channels - 1, channelMappingTable: channels === 1 ? [0] : [0, 1] };
  const decoder = new OpusDecoder({ channels, preSkip, ...mapping });
  await decoder.ready;
  try {
    const decoded = decoder.decodeFrames(stream.frames);
    let length = decoded.samplesDecoded;
    // Ogg says where the sound ends; the rest of the last frame is padding.
    if (stream.endGranule !== undefined && stream.endGranule > preSkip) length = Math.min(length, stream.endGranule - preSkip);
    return { mono: mix(decoded.channelData, length), sampleRate: decoded.sampleRate };
  } finally {
    decoder.free();
  }
}

// ---------- MP3 ----------

export async function decodeMp3(bytes: Uint8Array): Promise<Sound> {
  const { MPEGDecoder } = await import("mpg123-decoder");
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const decoded = decoder.decode(bytes);
    if (!decoded.samplesDecoded) throw new Error("no MP3 frames in it");
    return { mono: mix(decoded.channelData, decoded.samplesDecoded), sampleRate: decoded.sampleRate };
  } finally {
    decoder.free();
  }
}

// ---------- ffmpeg ----------

/** Anything ffmpeg reads, as a float WAV on its output (the channels kept, so they are averaged as above). */
export function decodeWithFfmpeg(path: string, command = process.env.GHOSTLY_FFMPEG || "ffmpeg"): Promise<Sound> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-v", "error", "-nostdin", "-i", path, "-vn", "-f", "wav", "-c:a", "pcm_f32le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0, errors = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES * 2) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (errors.length < 2000) errors += chunk.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(error.code === "ENOENT" ? "no decoder here for this kind of audio (install ffmpeg to read it)" : `ffmpeg: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`ffmpeg could not read it${errors.trim() ? `: ${errors.trim().split("\n")[0]}` : ""}`)); return; }
      try { resolve(decodeWav(Buffer.concat(chunks))); } catch (error) { reject(error); }
    });
  });
}
