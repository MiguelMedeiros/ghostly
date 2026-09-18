import { concatBytes, utf8Decode, utf8Encode } from "./bytes";

/**
 * Minimal DNS wire codec for Pkarr packets. Ghostly only ever publishes TXT
 * records, so only TXT is encoded. Decoding skips every other record type and
 * understands name compression, which the Rust client (simple-dns) emits.
 */
export interface TxtRecord {
  /** Fully qualified name, e.g. `_msgs.<z32 public key>` */
  name: string;
  value: string;
  ttl: number;
}

const TYPE_TXT = 16;
const CLASS_IN = 1;
const FLAGS_REPLY = 0x8000;
const MAX_CHARACTER_STRING = 255;
const MAX_POINTER_OFFSET = 0x3fff;

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u8(v: number): void {
    this.push(Uint8Array.of(v & 0xff));
  }

  u16(v: number): void {
    this.push(Uint8Array.of((v >>> 8) & 0xff, v & 0xff));
  }

  u32(v: number): void {
    this.push(Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff));
  }

  bytes(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

function writeName(writer: Writer, name: string, suffixOffsets: Map<string, number>): void {
  const labels = name.split(".").filter((l) => l.length > 0);
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    const pointer = suffixOffsets.get(suffix);
    if (pointer !== undefined) {
      writer.u16(0xc000 | pointer);
      return;
    }
    if (writer.length <= MAX_POINTER_OFFSET) suffixOffsets.set(suffix, writer.length);
    const label = utf8Encode(labels[i]);
    if (label.length > 63) throw new Error(`DNS label too long: ${labels[i]}`);
    writer.u8(label.length);
    writer.push(label);
  }
  writer.u8(0);
}

export function encodeTxtPacket(records: TxtRecord[]): Uint8Array {
  const writer = new Writer();
  writer.u16(0);
  writer.u16(FLAGS_REPLY);
  writer.u16(0);
  writer.u16(records.length);
  writer.u16(0);
  writer.u16(0);

  const suffixOffsets = new Map<string, number>();
  for (const record of records) {
    writeName(writer, record.name, suffixOffsets);
    writer.u16(TYPE_TXT);
    writer.u16(CLASS_IN);
    writer.u32(record.ttl);

    const value = utf8Encode(record.value);
    const strings: Uint8Array[] = [];
    for (let i = 0; i < value.length || i === 0; i += MAX_CHARACTER_STRING) {
      const chunk = value.subarray(i, i + MAX_CHARACTER_STRING);
      strings.push(Uint8Array.of(chunk.length), chunk);
    }
    const rdata = concatBytes(...strings);
    writer.u16(rdata.length);
    writer.push(rdata);
  }
  return writer.bytes();
}

function readName(data: Uint8Array, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = start;
  let next = -1;
  let jumps = 0;

  for (;;) {
    if (pos >= data.length) throw new Error("DNS name out of bounds");
    const len = data[pos];
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= data.length) throw new Error("DNS pointer out of bounds");
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | data[pos + 1];
      if (++jumps > 32) throw new Error("DNS name has too many compression pointers");
      continue;
    }
    if (len & 0xc0) throw new Error("Unsupported DNS label type");
    pos += 1;
    if (len === 0) break;
    if (pos + len > data.length) throw new Error("DNS label out of bounds");
    labels.push(utf8Decode(data.subarray(pos, pos + len)));
    pos += len;
  }

  return { name: labels.join("."), next: next < 0 ? pos : next };
}

export function decodeTxtPacket(data: Uint8Array): TxtRecord[] {
  if (data.length < 12) throw new Error("DNS packet too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const questions = view.getUint16(4);
  const answers = view.getUint16(6);

  let pos = 12;
  for (let i = 0; i < questions; i++) {
    pos = readName(data, pos).next + 4;
  }

  const records: TxtRecord[] = [];
  for (let i = 0; i < answers; i++) {
    const { name, next } = readName(data, pos);
    pos = next;
    if (pos + 10 > data.length) throw new Error("DNS record out of bounds");
    const type = view.getUint16(pos);
    const ttl = view.getUint32(pos + 4);
    const rdLength = view.getUint16(pos + 8);
    pos += 10;
    const end = pos + rdLength;
    if (end > data.length) throw new Error("DNS rdata out of bounds");

    if (type === TYPE_TXT) {
      const parts: Uint8Array[] = [];
      let p = pos;
      while (p < end) {
        const len = data[p];
        if (p + 1 + len > end) throw new Error("DNS character-string out of bounds");
        parts.push(data.subarray(p + 1, p + 1 + len));
        p += 1 + len;
      }
      try {
        records.push({ name, value: utf8Decode(concatBytes(...parts)), ttl });
      } catch {
        // not valid UTF-8, not one of ours
      }
    }
    pos = end;
  }
  return records;
}
