/**
 * A received recording taken apart into its frames and put back together before Web Audio decodes it. Web Audio
 * decodes a file whole, at its real length, and that length is the sender's to choose: a few megabytes at a very
 * low bitrate hold hours, gigabytes once decoded, whatever the voice description says. So the frames are read
 * out of the container here (AAC in MP4 or ADTS, Opus in WebM or Ogg), counted, and written into a plain stream
 * of those frames alone: the decoder is handed exactly what was counted, never the rest of the file. Anything
 * else, or more than `maxSeconds`, is null.
 */
export interface CountedRecording {
  blob: Blob;
  seconds: number;
}

/** Voices are mono or stereo; more channels only multiply what a decode holds. */
const MAX_CHANNELS = 2;

export function countedRecording(bytes: Uint8Array, maxSeconds: number): CountedRecording | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const limit = { seconds: maxSeconds };
  try {
    if (bytes.length >= 8 && fourcc(view, 4) === "ftyp") return aacStream(mp4Frames(view, limit));
    if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0) return aacStream(adtsFrames(view, limit));
    if (bytes.length >= 4 && view.getUint32(0) === 0x1a45dfa3) return opusStream(webmPackets(view, limit));
    if (bytes.length >= 4 && fourcc(view, 0) === "OggS") return opusStream(oggPackets(view, limit));
  } catch {
    // Cut short, malformed, or longer than allowed.
  }
  return null;
}

class Refused extends Error {}
function check(ok: boolean): asserts ok {
  if (!ok) throw new Refused();
}

const fourcc = (view: DataView, at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
const slice = (view: DataView, at: number, length: number) => {
  check(length >= 0 && at + length <= view.byteLength);
  return new Uint8Array(view.buffer, view.byteOffset + at, length);
};

// AAC ---------------------------------------------------------------------------------------------------------

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** What an ADTS header carries: the object type (1-4, LC is 2), the rate's index and the channels. */
interface AacConfig { profile: number; rate: number; channels: number }
interface AacFrames { config: AacConfig; frames: Uint8Array[] }

function aacConfig(profile: number, rate: number, channels: number): AacConfig {
  check(profile >= 1 && profile <= 4 && rate < AAC_RATES.length && channels >= 1 && channels <= MAX_CHANNELS);
  return { profile, rate, channels };
}

/** Each AAC frame is 1024 samples (with SBR, 2048 at twice the rate: the same time). */
function counter(limit: { seconds: number }, config: AacConfig) {
  const perFrame = 1024 / AAC_RATES[config.rate]!;
  let frames = 0;
  return () => check(++frames * perFrame <= limit.seconds);
}

function aacStream({ config, frames }: AacFrames): CountedRecording {
  check(frames.length > 0);
  const out = new Uint8Array(frames.reduce((sum, frame) => sum + 7 + frame.length, 0));
  let at = 0;
  for (const frame of frames) {
    const length = 7 + frame.length;
    check(length < 1 << 13);
    out.set([0xff, 0xf1, ((config.profile - 1) << 6) | (config.rate << 2) | (config.channels >> 2), ((config.channels & 3) << 6) | (length >> 11), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc], at);
    out.set(frame, at + 7);
    at += length;
  }
  return { blob: new Blob([out], { type: "audio/aac" }), seconds: (frames.length * 1024) / AAC_RATES[config.rate]! };
}

function adtsFrames(view: DataView, limit: { seconds: number }): AacFrames {
  let config: AacConfig | undefined;
  let count: (() => void) | undefined;
  const frames: Uint8Array[] = [];
  for (let at = 0; at < view.byteLength;) {
    const b1 = view.getUint8(at + 1), b2 = view.getUint8(at + 2), b3 = view.getUint8(at + 3);
    check(view.getUint8(at) === 0xff && (b1 & 0xf6) === 0xf0);
    const head = b1 & 1 ? 7 : 9;
    const length = ((b3 & 3) << 11) | (view.getUint8(at + 4) << 3) | (view.getUint8(at + 5) >> 5);
    check((view.getUint8(at + 6) & 3) === 0 && length > head);
    const frame = aacConfig((b2 >> 6) + 1, (b2 >> 2) & 15, ((b2 & 1) << 2) | (b3 >> 6));
    if (!config) { config = frame; count = counter(limit, config); }
    check(frame.profile === config.profile && frame.rate === config.rate && frame.channels === config.channels);
    count!();
    frames.push(slice(view, at + head, length - head));
    at += length;
  }
  check(config !== undefined);
  return { config: config!, frames };
}

interface Box { type: string; start: number; end: number; at: number }

function boxes(view: DataView, from: number, to: number): Box[] {
  const found: Box[] = [];
  for (let at = from; at < to;) {
    check(to - at >= 8);
    let size = view.getUint32(at), head = 8;
    if (size === 1) { size = Number(view.getBigUint64(at + 8)); head = 16; }
    else if (size === 0) size = to - at;
    check(size >= head && at + size <= to);
    found.push({ type: fourcc(view, at + 4), start: at + head, end: at + size, at });
    at += size;
  }
  return found;
}

function only(view: DataView, parent: Box, type: string): Box {
  const found = boxes(view, parent.start, parent.end).filter((box) => box.type === type);
  check(found.length === 1);
  return found[0]!;
}

/** The AudioSpecificConfig in an `mp4a` entry's `esds`, as an ADTS header would say it. */
function mp4aConfig(view: DataView, stsd: Box): AacConfig {
  check(view.getUint32(stsd.start + 4) === 1);
  const [entry] = boxes(view, stsd.start + 8, stsd.end);
  check(entry?.type === "mp4a");
  const version = view.getUint16(entry!.start + 8);
  check(version <= 1);
  const children = boxes(view, entry!.start + 28 + version * 16, entry!.end);
  const wave = children.find((box) => box.type === "wave");
  const esds = (wave ? boxes(view, wave.start, wave.end) : children).find((box) => box.type === "esds");
  check(esds !== undefined);
  const descriptor = (at: number, end: number, tag: number) => {
    check(view.getUint8(at) === tag);
    let size = 0, i = at + 1;
    for (let n = 0; n < 4; n++) {
      const b = view.getUint8(i++);
      size = (size << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    check(i + size <= end);
    return { start: i, end: i + size };
  };
  const es = descriptor(esds!.start + 4, esds!.end, 0x03);
  const flags = view.getUint8(es.start + 2);
  let at = es.start + 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + view.getUint8(at);
  if (flags & 0x20) at += 2;
  const decoder = descriptor(at, es.end, 0x04);
  check([0x40, 0x66, 0x67, 0x68].includes(view.getUint8(decoder.start)));
  const info = descriptor(decoder.start + 13, decoder.end, 0x05);
  // audioObjectType (5), samplingFrequencyIndex (4), channelConfiguration (4); explicit SBR/PS names the core after.
  let bits = 0, have = 0, at2 = info.start;
  const read = (n: number) => {
    while (have < n) { check(at2 < info.end); bits = ((bits << 8) | view.getUint8(at2++)) & 0xffffff; have += 8; }
    have -= n;
    return (bits >> have) & ((1 << n) - 1);
  };
  let type = read(5);
  const rate = read(4);
  const channels = read(4);
  if (type === 5 || type === 29) {
    check(read(4) !== 15);
    type = read(5);
  }
  check(read(1) === 0); // 960-sample frames: not something ADTS can say
  return aacConfig(type, rate, channels);
}

function mp4Frames(view: DataView, limit: { seconds: number }): AacFrames {
  const top = boxes(view, 0, view.byteLength);
  const moovs = top.filter((box) => box.type === "moov");
  check(moovs.length === 1);
  const moov = moovs[0]!;
  const trak = only(view, moov, "trak");
  const stbl = only(view, only(view, only(view, trak, "mdia"), "minf"), "stbl");
  const config = mp4aConfig(view, only(view, stbl, "stsd"));
  const count = counter(limit, config);
  const frames: Uint8Array[] = [];
  const take = (at: number, size: number) => { count(); frames.push(slice(view, at, size)); };

  // Samples stored in the movie itself.
  const inStbl = boxes(view, stbl.start, stbl.end);
  const stsz = inStbl.find((box) => box.type === "stsz");
  const samples = stsz ? view.getUint32(stsz.start + 8) : 0;
  if (samples > 0) {
    const fixed = view.getUint32(stsz!.start + 4);
    const sizeOf = (i: number) => fixed || view.getUint32(stsz!.start + 12 + i * 4);
    const stsc = only(view, stbl, "stsc");
    const offsets = inStbl.find((box) => box.type === "stco" || box.type === "co64");
    check(offsets !== undefined);
    const wide = offsets!.type === "co64";
    const chunks = view.getUint32(offsets!.start + 4);
    const runs = view.getUint32(stsc.start + 4);
    let sample = 0;
    for (let run = 0; run < runs && sample < samples; run++) {
      const entry = stsc.start + 8 + run * 12;
      const first = view.getUint32(entry), perChunk = view.getUint32(entry + 4);
      const last = run + 1 < runs ? view.getUint32(entry + 12) - 1 : chunks;
      // Every chunk takes a sample, so the count bounds this loop too.
      check(first >= 1 && last <= chunks && perChunk > 0);
      for (let chunk = first; chunk <= last && sample < samples; chunk++) {
        let at = wide ? Number(view.getBigUint64(offsets!.start + 8 + (chunk - 1) * 8)) : view.getUint32(offsets!.start + 8 + (chunk - 1) * 4);
        for (let i = 0; i < perChunk && sample < samples; i++, sample++) {
          const size = sizeOf(sample);
          take(at, size);
          at += size;
        }
      }
    }
    check(sample === samples);
  }

  // Samples in fragments (what MediaRecorder writes).
  const mvex = boxes(view, moov.start, moov.end).find((box) => box.type === "mvex");
  const trex = mvex && boxes(view, mvex.start, mvex.end).find((box) => box.type === "trex");
  const trexSize = trex ? view.getUint32(trex.start + 16) : 0;
  for (const moof of top.filter((box) => box.type === "moof")) {
    for (const traf of boxes(view, moof.start, moof.end).filter((box) => box.type === "traf")) {
      const tfhd = only(view, traf, "tfhd");
      const tfhdFlags = view.getUint32(tfhd.start) & 0xffffff;
      let at = tfhd.start + 8;
      let base = moof.at;
      if (tfhdFlags & 0x1) { base = Number(view.getBigUint64(at)); at += 8; }
      if (tfhdFlags & 0x2) at += 4;
      if (tfhdFlags & 0x8) at += 4;
      const defaultSize = tfhdFlags & 0x10 ? view.getUint32(at) : trexSize;
      let next = base;
      for (const trun of boxes(view, traf.start, traf.end).filter((box) => box.type === "trun")) {
        const flags = view.getUint32(trun.start) & 0xffffff;
        const n = view.getUint32(trun.start + 4);
        let field = trun.start + 8;
        if (flags & 0x1) { next = base + view.getInt32(field); field += 4; }
        if (flags & 0x4) field += 4;
        for (let i = 0; i < n; i++) {
          if (flags & 0x100) field += 4;
          const size = flags & 0x200 ? view.getUint32(field) : defaultSize;
          if (flags & 0x200) field += 4;
          if (flags & 0x400) field += 4;
          if (flags & 0x800) field += 4;
          check(field <= trun.end);
          take(next, size);
          next += size;
        }
      }
    }
  }
  return { config, frames };
}

// Opus --------------------------------------------------------------------------------------------------------

interface OpusPackets { head: Uint8Array; packets: Uint8Array[] }

/** OpusHead, as RFC 7845 has it: one or two channels, the plain mapping. */
function opusHead(head: Uint8Array): Uint8Array {
  check(head.length >= 19 && String.fromCharCode(...head.subarray(0, 8)) === "OpusHead");
  check(head[8]! >> 4 === 0 && head[9]! >= 1 && head[9]! <= MAX_CHANNELS && head[18] === 0);
  return head.slice(0, 19);
}

/** A packet's samples at 48 kHz, from its TOC byte (RFC 6716 §3.1), or 0 when it is not a packet. */
export function opusSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!, config = toc >> 3, code = toc & 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3]! : config < 16 ? (config & 1 ? 960 : 480) : [120, 240, 480, 960][config & 3]!;
  const frames = code === 0 ? 1 : code < 3 ? 2 : packet.length > 1 ? packet[1]! & 0x3f : 0;
  return frames > 0 && frame * frames <= 5760 ? frame * frames : 0;
}

function opusCounter(limit: { seconds: number }) {
  let samples = 0;
  const packets: Uint8Array[] = [];
  return {
    packets,
    add(packet: Uint8Array) {
      const n = opusSamples(packet);
      if (!n) return;
      samples += n;
      check(samples / 48_000 <= limit.seconds);
      packets.push(packet);
    },
  };
}

/** An EBML number at `at`: an ID keeps its marker bits, a size does not; an unknown size is -1. */
function vint(view: DataView, at: number, id = false): { value: number; length: number } {
  const first = view.getUint8(at);
  check(first !== 0);
  const length = Math.clz32(first) - 23;
  let value = id ? first : first & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const b = view.getUint8(at + i);
    value = value * 256 + b;
    unknown &&= b === 0xff;
  }
  return { value: !id && unknown ? -1 : value, length };
}

const SEGMENT_LEVEL = new Set([0x1f43b675, 0x1c53bb6b, 0x1254c367, 0x1654ae6b, 0x1549a966, 0x114d9b74, 0x1043a770, 0x1941a469]);

/** The children of an element from `from` to `to`; an unknown size runs to the next element of the segment's level. */
function elements(view: DataView, from: number, to: number, nested = false): { id: number; start: number; end: number }[] {
  const found: { id: number; start: number; end: number }[] = [];
  for (let at = from; at < to;) {
    const id = vint(view, at, true);
    if (nested && SEGMENT_LEVEL.has(id.value)) break;
    const size = vint(view, at + id.length);
    const start = at + id.length + size.length;
    let end = size.value < 0 ? to : start + size.value;
    if (size.value < 0 && id.value === 0x1f43b675) end = start + elements(view, start, to, true).reduce((sum, e) => Math.max(sum, e.end - start), 0);
    check(end <= to);
    found.push({ id: id.value, start, end });
    at = end;
  }
  return found;
}

function webmPackets(view: DataView, limit: { seconds: number }): OpusPackets {
  const segments = elements(view, 0, view.byteLength).filter((e) => e.id === 0x18538067);
  check(segments.length === 1);
  const level = elements(view, segments[0]!.start, segments[0]!.end);
  const tracks = level.filter((e) => e.id === 0x1654ae6b).flatMap((e) => elements(view, e.start, e.end).filter((t) => t.id === 0xae));
  check(tracks.length === 1);
  const fields = elements(view, tracks[0]!.start, tracks[0]!.end);
  const field = (id: number) => fields.find((e) => e.id === id);
  const number = field(0xd7), codec = field(0x86), priv = field(0x63a2);
  check(number !== undefined && codec !== undefined && priv !== undefined);
  check(String.fromCharCode(...slice(view, codec!.start, codec!.end - codec!.start)) === "A_OPUS");
  const track = slice(view, number!.start, number!.end - number!.start).reduce((n, b) => n * 256 + b, 0);
  const head = opusHead(slice(view, priv!.start, priv!.end - priv!.start));
  const counted = opusCounter(limit);
  const block = (start: number, end: number) => {
    const number = vint(view, start);
    const at = start + number.length;
    if (number.value !== track) return;
    check((view.getUint8(at + 2) & 0x06) === 0); // laced blocks: not what a recorder writes
    counted.add(slice(view, at + 3, end - at - 3));
  };
  for (const cluster of level.filter((e) => e.id === 0x1f43b675)) {
    for (const child of elements(view, cluster.start, cluster.end, true)) {
      if (child.id === 0xa3) block(child.start, child.end);
      else if (child.id === 0xa0) for (const inner of elements(view, child.start, child.end)) if (inner.id === 0xa1) block(inner.start, inner.end);
    }
  }
  return { head, packets: counted.packets };
}

function oggPackets(view: DataView, limit: { seconds: number }): OpusPackets {
  let serial: number | undefined;
  let open: Uint8Array[] = [];
  const counted = opusCounter(limit);
  let head: Uint8Array | undefined, seen = 0;
  const done = (packet: Uint8Array) => {
    if (seen === 0) head = opusHead(packet);
    else if (seen > 1) counted.add(packet);
    seen++;
  };
  for (let at = 0; at < view.byteLength;) {
    check(fourcc(view, at) === "OggS" && view.getUint8(at + 4) === 0);
    const pageSerial = view.getUint32(at + 14, true);
    check(serial === undefined || serial === pageSerial);
    serial = pageSerial;
    const segments = view.getUint8(at + 26);
    let data = at + 27 + segments;
    for (let i = 0; i < segments; i++) {
      const lacing = view.getUint8(at + 27 + i);
      open.push(slice(view, data, lacing));
      data += lacing;
      if (lacing < 255) {
        const packet = new Uint8Array(open.reduce((sum, part) => sum + part.length, 0));
        let p = 0;
        for (const part of open) { packet.set(part, p); p += part.length; }
        open = [];
        done(packet);
      }
    }
    at = data;
  }
  check(head !== undefined);
  return { head: head!, packets: counted.packets };
}

/** The packets as a WebM of one Opus track, which every engine's Web Audio reads. */
function opusStream({ head, packets }: OpusPackets): CountedRecording {
  check(packets.length > 0);
  const size = (n: number) => { const out = new Uint8Array(8); out[0] = 0x01; for (let i = 7, v = n; i > 0; i--, v = Math.floor(v / 256)) out[i] = v & 0xff; return out; };
  const el = (id: number[], ...parts: Uint8Array[]) => {
    const body = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(id.length + 8 + body);
    out.set(id);
    out.set(size(body), id.length);
    let at = id.length + 8;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  };
  const uint = (id: number[], n: number) => el(id, new Uint8Array([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]));
  const text = (id: number[], s: string) => el(id, new TextEncoder().encode(s));
  const rate = new Uint8Array(8);
  new DataView(rate.buffer).setFloat64(0, 48_000);
  const clusters: Uint8Array[] = [];
  let samples = 0, start = 0, blocks: Uint8Array[] = [];
  const close = () => { if (blocks.length) clusters.push(el([0x1f, 0x43, 0xb6, 0x75], uint([0xe7], start), ...blocks)); blocks = []; };
  for (const packet of packets) {
    const ms = Math.floor(samples / 48);
    if (ms - start > 30_000 || !blocks.length) { close(); start = ms; }
    const at = ms - start;
    blocks.push(el([0xa3], new Uint8Array([0x81, (at >> 8) & 0xff, at & 0xff, 0x80]), packet));
    samples += opusSamples(packet);
  }
  close();
  const header = el([0x1a, 0x45, 0xdf, 0xa3], uint([0x42, 0x86], 1), uint([0x42, 0xf7], 1), uint([0x42, 0xf2], 4), uint([0x42, 0xf3], 8), text([0x42, 0x82], "webm"), uint([0x42, 0x87], 2), uint([0x42, 0x85], 2));
  const info = el([0x15, 0x49, 0xa9, 0x66], uint([0x2a, 0xd7, 0xb1], 1_000_000));
  const track = el([0xae], uint([0xd7], 1), uint([0x73, 0xc5], 1), uint([0x83], 2), text([0x86], "A_OPUS"), el([0x63, 0xa2], head), el([0xe1], el([0xb5], rate), uint([0x9f], head[9]!)));
  const segment = el([0x18, 0x53, 0x80, 0x67], info, el([0x16, 0x54, 0xae, 0x6b], track), ...clusters);
  return { blob: new Blob([header, segment], { type: "audio/webm" }), seconds: samples / 48_000 };
}
