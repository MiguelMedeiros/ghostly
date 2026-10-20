import { spawn } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import { VOICE_LIMITS, VOICE_METER, downsamplePeaks, voiceLevel } from "@ghostly/core";

/**
 * The waveform and length of a voice note sent from a file (`file send --voice`), measured as the apps measure their
 * own recordings (packages/core voice.ts `voicePeaksOf`, the recorder's meter) so the bars look the same. The sound is
 * decoded here, without native code: WAV by hand, Opus in WebM or Ogg and MP3 with the wasm decoders, anything
 * else (AAC in MP4, FLAC…) with `ffmpeg` when it is on the PATH.
 *
 * The decoders hand their samples to a sink a piece at a time, and the meter (`VoiceMeter`) keeps only the
 * analyser's window of them: the whole sound decoded into memory first took 2.6 GiB for a 60-minute MP3, in the
 * daemon, only for it to be refused as longer than a voice note (agents#878). Decoding stops once the sound is longer
 * than a voice note may be. A WAV and an MP3 are read from the file in pieces, and a kind left to ffmpeg is not read
 * here at all: the whole file read first took +190 MiB for a 15-minute WAV (agents#1577).
 */

export interface Sound {
  /** One channel, -1 to 1: the channels averaged, as the recorder's analyser hears them. */
  mono: Float32Array;
  sampleRate: number;
}

export interface VoiceMeasure { duration: number; peaks: number[] }

/** Where a decoder puts what it decoded: `push` answers false once nothing more is wanted (the decoder stops). */
export interface SoundSink {
  start(sampleRate: number): void;
  push(channels: readonly Float32Array[], length: number): boolean;
}

/** Longer than any voice note (15 minutes) with room: a WebM or Ogg past it is not read (their demuxers hold it all). */
const MAX_BYTES = 256 * 1024 * 1024;
/** Read first to tell a file's kind; a WAV's header is looked for in up to `WAV_HEAD_MAX` (as in ffmpeg's output). */
const HEAD_BYTES = 64 * 1024;
const WAV_HEAD_MAX = 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 120_000;
/** Read past the longest voice note by this much, so its length is known to be too long (`parseVoiceMeta` allows 5 s). */
const PAST_LIMIT_MS = 6_000;

/**
 * The recorder's meter, run over the samples as they come (core `voiceLevelsOf`, reading for reading): the channels
 * averaged as `mix` does, a reading every `intervalMs` over the window that ends there, nothing kept but that window.
 */
export class VoiceMeter implements SoundSink {
  private rate = 0;
  private window = 1;
  private ring = new Float32Array(1);
  private count = 0;
  private step = 1;
  private nextEnd = 0;
  private limit = Infinity;
  private readonly levels: number[] = [];
  private readonly scratch: number[] = [];

  constructor(private readonly maxMs: number = VOICE_LIMITS.maxDurationMs + PAST_LIMIT_MS) {}

  start(sampleRate: number): void {
    if (this.rate) return;
    this.rate = sampleRate;
    this.window = Math.max(1, Math.round((VOICE_METER.window * sampleRate) / VOICE_METER.windowRate));
    this.ring = new Float32Array(this.window);
    this.nextEnd = this.endOf(1);
    this.limit = Math.ceil((this.maxMs * sampleRate) / 1000);
  }

  private endOf(step: number): number { return Math.round((step * VOICE_METER.intervalMs * this.rate) / 1000); }

  push(channels: readonly Float32Array[], length: number): boolean {
    if (!(this.rate > 0)) return false;
    const one = channels.length === 1 ? channels[0]! : null, n = channels.length;
    for (let i = 0; i < length; i++) {
      if (this.count >= this.limit) return false;
      let sample: number;
      if (one) sample = one[i]!;
      else {
        // As `mix` adds into a Float32Array: rounded to a float after each channel.
        sample = 0;
        for (let c = 0; c < n; c++) sample = Math.fround(sample + channels[c]![i]! / n);
      }
      this.ring[this.count % this.window] = sample;
      this.count++;
      while (this.count === this.nextEnd) {
        const from = Math.max(0, this.count - this.window);
        this.scratch.length = 0;
        for (let k = from; k < this.count; k++) this.scratch.push(this.ring[k % this.window]!);
        this.levels.push(voiceLevel(this.scratch));
        this.nextEnd = this.endOf(++this.step);
      }
    }
    return this.count < this.limit;
  }

  /** The length and waveform measured so far; null when no sound came. */
  result(): VoiceMeasure | null {
    if (!this.count || !(this.rate > 0)) return null;
    return { duration: Math.round((this.count / this.rate) * 1000), peaks: downsamplePeaks(this.levels, VOICE_LIMITS.bars) };
  }
}

/** Every sample, kept: the whole sound in memory (tests and comparisons; `measureVoice` never does this). */
class Collector implements SoundSink {
  rate = 0;
  private readonly parts: Float32Array[] = [];
  start(sampleRate: number): void { this.rate ||= sampleRate; }
  push(channels: readonly Float32Array[], length: number): boolean {
    this.parts.push(mix(channels, length).slice());
    return true;
  }
  sound(): Sound {
    const mono = new Float32Array(this.parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of this.parts) { mono.set(part, at); at += part.length; }
    return { mono, sampleRate: this.rate };
  }
}

/**
 * The waveform and length of the sound in `path`, or why they could not be read. A sound longer than a voice note may
 * be is read only a little past that length: its duration says it is too long, and the send is refused for it.
 */
export async function measureVoice(path: string): Promise<{ voice: VoiceMeasure } | { problem: string }> {
  const meter = new VoiceMeter();
  try {
    await streamSound(path, meter);
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  const voice = meter.result();
  return voice ? { voice } : { problem: "no sound in it" };
}

/** The whole sound in `path`, in memory. */
export async function decodeSound(path: string): Promise<Sound> {
  const collector = new Collector();
  await streamSound(path, collector);
  return collector.sound();
}

/** Decodes the sound in `path` into `sink`, by this module's decoders or else ffmpeg. */
export async function streamSound(path: string, sink: SoundSink): Promise<void> {
  let own: Error | undefined;
  try {
    if (await streamFile(path, sink)) return;
  } catch (error) {
    own = error instanceof Error ? error : new Error(String(error));
  }
  try {
    await streamFfmpeg(path, sink);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(own ? `${own.message}; ${reason}` : reason, { cause: error });
  }
}

/** The sound in a file this module decodes itself, or null for a kind it leaves to ffmpeg. */
export async function decodeBytes(bytes: Uint8Array): Promise<Sound | null> {
  const collector = new Collector();
  return (await streamBytes(bytes, collector)) ? collector.sound() : null;
}

type Kind = "wav" | "webm" | "ogg" | "mp3" | null;

/** The kind of sound a file's first bytes say it is, of those this module decodes itself. */
function kindOf(head: Uint8Array): Kind {
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") return "wav";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
  if (ascii(head, 0, 4) === "OggS") return "ogg";
  if (ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)) return "mp3";
  return null;
}

/** Feeds `sink` the sound of a kind this module decodes itself; false for a kind it leaves to ffmpeg. */
async function streamBytes(bytes: Uint8Array, sink: SoundSink): Promise<boolean> {
  const kind = kindOf(bytes);
  if (kind === "wav") { streamWav(bytes, sink); return true; }
  if (kind === "mp3") { await streamMp3(slices(bytes, MP3_PIECE), sink); return true; }
  return kind ? streamOpusOf(kind, bytes, sink) : false;
}

/** As `streamBytes`, reading the file only as far as its decoder goes; a kind left to ffmpeg is not read past its head. */
async function streamFile(path: string, sink: SoundSink): Promise<boolean> {
  const file = await open(path);
  try {
    const { size } = await file.stat();
    const kind = kindOf(await readAt(file, 0, Math.min(size, 12)));
    if (kind === "wav") { await streamWavFile(file, size, sink); return true; }
    if (kind === "mp3") { await streamMp3(piecesOf(file, size, MP3_PIECE), sink); return true; }
    if (!kind) return false;
    if (size > MAX_BYTES) throw new Error("too large to decode");
    return streamOpusOf(kind, await file.readFile(), sink);
  } finally {
    await file.close();
  }
}

async function streamOpusOf(kind: "webm" | "ogg", bytes: Uint8Array, sink: SoundSink): Promise<boolean> {
  const opus = kind === "webm" ? demuxWebm(bytes) : demuxOgg(bytes);
  if (!opus) return false;
  await streamOpus(opus, sink);
  return true;
}

/** Up to `length` bytes of the file from `at` (fewer at its end), into `into` when given. */
async function readAt(file: FileHandle, at: number, length: number, into = Buffer.allocUnsafe(length)): Promise<Buffer> {
  let got = 0;
  while (got < length) {
    const { bytesRead } = await file.read(into, got, length - got, at + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return into.subarray(0, got);
}

function* slices(bytes: Uint8Array, piece: number): Generator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += piece) yield bytes.subarray(at, at + piece);
}

/** The file in pieces of `piece` bytes, each read into the same buffer once the one before is used. */
async function* piecesOf(file: FileHandle, size: number, piece: number): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.allocUnsafe(piece);
  for (let at = 0; at < size; at += piece) {
    const bytes = await readAt(file, at, Math.min(piece, size - at), buffer);
    if (!bytes.length) return;
    yield bytes;
  }
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function mix(channels: readonly Float32Array[], length: number): Float32Array {
  if (channels.length === 1) return channels[0]!.subarray(0, length);
  const mono = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i]! += channel[i]! / channels.length;
  return mono;
}

// ---------- WAV ----------

/** PCM (8, 16, 24 or 32 bit) or float (32 or 64 bit) WAV. A data chunk whose size is unknown (a pipe) runs to the end. */
export function decodeWav(bytes: Uint8Array): Sound {
  const collector = new Collector();
  streamWav(bytes, collector);
  return collector.sound();
}

/** The format of a WAV and where its samples are; null while its header is not all there. */
function wavHeader(bytes: Uint8Array): { format: number; channels: number; sampleRate: number; bits: number; from: number; to: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = 0, channels = 0, sampleRate = 0, bits = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (body + 16 > bytes.length) return null;
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first two bytes.
      if (format === 0xfffe && size >= 26) { if (body + 26 > bytes.length) return null; format = view.getUint16(body + 24, true); }
    } else if (id === "data") {
      if (!channels || !sampleRate || !bits) throw new Error("a WAV without its format");
      const to = size === 0 || size === 0xffffffff ? Infinity : body + size;
      return { format, channels, sampleRate, bits, from: body, to };
    }
    at = body + size + (size & 1);
  }
  return null;
}

/** How a WAV's sample is read, or undefined for a format not read here. */
function sampleReader(view: DataView, format: number, bits: number): ((at: number) => number) | undefined {
  return format === 1 && bits === 8 ? (at) => (view.getUint8(at) - 128) / 128
    : format === 1 && bits === 16 ? (at) => view.getInt16(at, true) / 32768
    : format === 1 && bits === 24 ? (at) => (((view.getInt8(at + 2) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at)) / 8388608)
    : format === 1 && bits === 32 ? (at) => view.getInt32(at, true) / 2147483648
    : format === 3 && bits === 32 ? (at) => view.getFloat32(at, true)
    : format === 3 && bits === 64 ? (at) => view.getFloat64(at, true)
    : undefined;
}

/** Frames of a channel each pushed at a time: few enough to keep nothing large, many enough for few calls. */
const PIECE_FRAMES = 4096;

function streamWav(bytes: Uint8Array, sink: SoundSink): void {
  const header = wavHeader(bytes);
  if (!header) throw new Error("a WAV without sound");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = sampleReader(view, header.format, header.bits);
  if (!read) throw new Error(`a WAV in a format not read here (${header.format}, ${header.bits} bit)`);
  sink.start(header.sampleRate);
  pushWavFrames(view, header.from, Math.min(bytes.length, header.to), header.channels, header.bits / 8, read, sink);
}

/** As `streamWav`, reading the file a piece of frames at a time until the sink wants no more. */
async function streamWavFile(file: FileHandle, size: number, sink: SoundSink): Promise<void> {
  let header: ReturnType<typeof wavHeader> = null;
  for (let length = HEAD_BYTES; !header; length *= 2) {
    header = wavHeader(await readAt(file, 0, Math.min(size, length)));
    if (length >= size || length >= WAV_HEAD_MAX) break;
  }
  if (!header) throw new Error("a WAV without sound");
  const { format, bits, channels } = header;
  if (!sampleReader(new DataView(new ArrayBuffer(0)), format, bits)) throw new Error(`a WAV in a format not read here (${format}, ${bits} bit)`);
  sink.start(header.sampleRate);
  const frame = (bits / 8) * channels, end = Math.min(size, header.to);
  const buffer = Buffer.allocUnsafe(PIECE_FRAMES * frame);
  for (let at = header.from; at + frame <= end;) {
    const bytes = await readAt(file, at, Math.min(buffer.length, end - at), buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pushed = pushWavFrames(view, 0, bytes.length, channels, bits / 8, sampleReader(view, format, bits)!, sink);
    if (!pushed.more || !pushed.at) return;
    at += pushed.at;
  }
}

/** The whole frames between `from` and `to`, as the channels' samples; the byte where it stopped (a frame cut off). */
function pushWavFrames(view: DataView, from: number, to: number, channels: number, width: number, read: (at: number) => number, sink: SoundSink): { at: number; more: boolean } {
  const frame = width * channels;
  const parts = Array.from({ length: channels }, () => new Float32Array(PIECE_FRAMES));
  let at = from;
  while (at + frame <= to) {
    const count = Math.min(PIECE_FRAMES, Math.floor((to - at) / frame));
    for (let f = 0; f < count; f++) for (let c = 0; c < channels; c++) parts[c]![f] = read(at + (f * channels + c) * width);
    at += count * frame;
    if (!sink.push(parts, count)) return { at, more: false };
  }
  return { at, more: true };
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
  const collector = new Collector();
  await streamOpus(stream, collector);
  return collector.sound();
}

/** Opus frames decoded at a time: about 2 s of sound at 20 ms a frame. */
const OPUS_BATCH = 100;

async function streamOpus(stream: OpusStream, sink: SoundSink): Promise<void> {
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
    // Ogg says where the sound ends; the rest of the last frame is padding.
    let left = stream.endGranule !== undefined && stream.endGranule > preSkip ? stream.endGranule - preSkip : Infinity;
    for (let at = 0; at < stream.frames.length && left > 0; at += OPUS_BATCH) {
      const decoded = decoder.decodeFrames(stream.frames.slice(at, at + OPUS_BATCH));
      if (!decoded.samplesDecoded) continue;
      sink.start(decoded.sampleRate);
      const length = Math.min(decoded.samplesDecoded, left);
      left -= length;
      if (!sink.push(decoded.channelData, length)) return;
    }
  } finally {
    decoder.free();
  }
}

// ---------- MP3 ----------

export async function decodeMp3(bytes: Uint8Array): Promise<Sound> {
  const collector = new Collector();
  await streamMp3(slices(bytes, MP3_PIECE), collector);
  return collector.sound();
}

/** MP3 bytes handed to the decoder at a time: about 16 s of a 128 kbit/s file. */
const MP3_PIECE = 256 * 1024;

/** The MP3 in `pieces`, decoded one at a time (the decoder copies each in before the next is asked for). */
async function streamMp3(pieces: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, sink: SoundSink): Promise<void> {
  const { MPEGDecoder } = await import("mpg123-decoder");
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    let any = false;
    for await (const piece of pieces) {
      const decoded = decoder.decode(piece);
      if (!decoded.samplesDecoded) continue;
      any = true;
      sink.start(decoded.sampleRate);
      if (!sink.push(decoded.channelData, decoded.samplesDecoded)) return;
    }
    if (!any) throw new Error("no MP3 frames in it");
  } finally {
    decoder.free();
  }
}

// ---------- ffmpeg ----------

/** Anything ffmpeg reads, as a float WAV on its output (the channels kept, so they are averaged as above). */
export async function decodeWithFfmpeg(path: string, command = process.env.GHOSTLY_FFMPEG || "ffmpeg"): Promise<Sound> {
  const collector = new Collector();
  await streamFfmpeg(path, collector, command);
  return collector.sound();
}

/**
 * Anything ffmpeg reads, into `sink` as its WAV output comes: nothing kept but a frame cut between two pieces. Once
 * the sink wants no more, ffmpeg is stopped.
 */
export function streamFfmpeg(path: string, sink: SoundSink, command = process.env.GHOSTLY_FFMPEG || "ffmpeg"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-v", "error", "-nostdin", "-i", path, "-vn", "-f", "wav", "-c:a", "pcm_f32le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "", pending: Buffer = Buffer.alloc(0), header: ReturnType<typeof wavHeader> = null, done = false, failed: Error | null = null;
    let read: ((at: number) => number) | undefined, left = Infinity;
    const timer = setTimeout(() => child.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    const stop = () => { done = true; child.stdout.removeAllListeners("data"); child.kill("SIGKILL"); };
    child.stdout.on("data", (chunk: Buffer) => {
      if (done) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      try {
        if (!header) {
          if (pending.length < 12) return;
          if (ascii(pending, 0, 4) !== "RIFF" || ascii(pending, 8, 4) !== "WAVE") throw new Error("ffmpeg gave no WAV");
          header = wavHeader(pending);
          if (!header) { if (pending.length > 1024 * 1024) throw new Error("a WAV without sound"); return; }
          const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
          if (!sampleReader(view, header.format, header.bits)) throw new Error(`a WAV in a format not read here (${header.format}, ${header.bits} bit)`);
          sink.start(header.sampleRate);
          left = header.to === Infinity ? Infinity : header.to - header.from;
          pending = pending.subarray(header.from);
        }
        const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
        read = sampleReader(view, header.format, header.bits)!;
        const to = Math.min(pending.length, left);
        const { at, more } = pushWavFrames(view, 0, to, header.channels, header.bits / 8, read, sink);
        if (left !== Infinity) left -= at;
        pending = Buffer.from(pending.subarray(at));
        if (!more || left <= 0) stop();
      } catch (error) {
        failed = error instanceof Error ? error : new Error(String(error));
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { if (errors.length < 2000) errors += chunk.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(error.code === "ENOENT" ? "no decoder here for this kind of audio (install ffmpeg to read it)" : `ffmpeg: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) { reject(failed); return; }
      // Stopped here because the sink had what it wanted: not a failure of ffmpeg's.
      if (done && header) { resolve(); return; }
      if (code !== 0) { reject(new Error(`ffmpeg could not read it${errors.trim() ? `: ${errors.trim().split("\n")[0]}` : ""}`)); return; }
      if (!header) { reject(new Error("a WAV without sound")); return; }
      resolve();
    });
  });
}
