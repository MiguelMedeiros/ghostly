import { describe, expect, it } from "vitest";
import { NO_AUDIO_METADATA, withoutAudioMetadata } from "../src/audioMetadata";
import { NO_PICTURE_METADATA, withoutPictureMetadata } from "../src/pictureMetadata";
import { NO_VIDEO_METADATA, withoutVideoMetadata } from "../src/videoMetadata";
import { PLACE, apev2, hasPlace, id3v1, id3v2 } from "./support/audioFixtures";
// covers: files.audio.metadata, files.video.metadata, files.image.metadata

/**
 * The other audio, video and picture containers a phone, a camera, a recorder or a tagger writes, with a title, a date
 * or a place in them: each goes through the chain a file sent goes through (platform/services.ts and cli/src/files.ts
 * `sendable`) and leaves without them, its sound or frames untouched, or is refused; none goes as it was.
 */
const sent = async (bytes: Uint8Array, mime: string): Promise<Uint8Array> => {
  const source = new Blob([bytes as BlobPart], { type: mime });
  const out = await withoutPictureMetadata(source, mime) ?? await withoutVideoMetadata(source, mime) ?? await withoutAudioMetadata(source, mime) ?? source;
  return new Uint8Array(await out.arrayBuffer());
};
const contains = (bytes: Uint8Array, part: Uint8Array) => Buffer.from(bytes).includes(Buffer.from(part));
const utf16 = (s: string) => Buffer.from(s, "utf16le");

const latin = (s: string) => Buffer.from(s, "latin1");
const u16be = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const riff = (id: string, body: Buffer) => Buffer.concat([latin(id), u32le(body.length), body, Buffer.alloc(body.length & 1)]);
const list = (type: string, ...chunks: Buffer[]) => riff("LIST", Buffer.concat([latin(type), ...chunks]));
const iff = (id: string, body: Buffer) => Buffer.concat([latin(id), u32be(body.length), body, Buffer.alloc(body.length & 1)]);

// AVI: a dashcam's, with the place in its INFO list, a stream's name, its `IDIT` date and a GPS text stream.
const FRAME = Buffer.alloc(301, 0x5a), SOUND = Buffer.alloc(200, 0x3c);
const strh = (type: string) => riff("strh", Buffer.concat([latin(type), Buffer.alloc(52)]));
const avi = () => {
  const header = list("hdrl", riff("avih", Buffer.alloc(56, 1)),
    list("strl", strh("vids"), riff("strf", Buffer.alloc(40, 2)), riff("strn", latin(`Recording at ${PLACE}\0`))),
    list("strl", strh("auds"), riff("strf", Buffer.alloc(18, 3))),
    list("strl", strh("txts"), riff("strf", Buffer.alloc(4)), riff("strd", latin(PLACE))),
    riff("IDIT", latin("Fri Nov 13 10:00:00 2026\n\0")));
  const movi = list("movi", riff("00dc", FRAME), riff("01wb", SOUND), riff("02tx", latin(`GPS ${PLACE}`)), list("rec ", riff("00dc", FRAME)), riff("JUNK", latin(PLACE)));
  const index = riff("idx1", Buffer.alloc(64, 4));
  const first = riff("RIFF", Buffer.concat([latin("AVI "), header, list("INFO", riff("INAM", latin(`${PLACE}\0`))), movi, index]));
  const more = riff("RIFF", Buffer.concat([latin("AVIX"), list("movi", riff("00dc", FRAME), riff("02tx", latin(PLACE)))]));
  return Buffer.concat([first, more]);
};

// AIFF and AIFF-C: NAME, AUTH, ANNO, `(c) ` and an `ID3 ` chunk, around COMM and SSND.
const AIFF_SOUND = Buffer.alloc(500, 0x21);
const aiff = (form: "AIFF" | "AIFC") => {
  const body = Buffer.concat([latin(form), ...(form === "AIFC" ? [iff("FVER", u32be(0xa2805140))] : []), iff("COMM", Buffer.alloc(form === "AIFC" ? 24 : 18, 5)),
    iff("NAME", latin(`Recording at ${PLACE}`)), iff("AUTH", latin(PLACE)), iff("ANNO", latin(PLACE)), iff("(c) ", latin(PLACE)),
    iff("SSND", Buffer.concat([Buffer.alloc(8), AIFF_SOUND])), iff("ID3 ", id3v2())]);
  return iff("FORM", body);
};

// CAF: its `info` strings (title, recorded date, place), its data to the end of the file.
const CAF_SOUND = Buffer.alloc(400, 0x42);
const caf = () => {
  const chunk = (type: string, body: Buffer, size = BigInt(body.length)) => { const b = Buffer.alloc(12); b.write(type, 0, "latin1"); b.writeBigInt64BE(size, 4); return Buffer.concat([b, body]); };
  const info = Buffer.concat([u32be(2), latin(`title\0Recording at ${PLACE}\0location\0${PLACE}\0`)]);
  return Buffer.concat([latin("caff"), u16be(1), u16be(0), chunk("desc", Buffer.alloc(32, 6)), chunk("info", info), chunk("data", Buffer.concat([u32be(0), CAF_SOUND]), -1n)]);
};

// WavPack: a block whose RIFF header (kept for a lossless restore) has the source WAV's INFO list, APEv2 and ID3v1 after it.
const WV_BITSTREAM = Buffer.alloc(240, 0x77);
const wavpack = () => {
  const wavHeader = Buffer.concat([latin("RIFF"), u32le(100), latin("WAVE"), list("INFO", riff("INAM", latin(`${PLACE}\0`)))]);
  const sub = (id: number, body: Buffer) => body.length / 2 > 255
    ? Buffer.concat([Buffer.from([id | 0x80, (body.length / 2) & 255, (body.length / 2) >> 8, 0]), body])
    : Buffer.concat([Buffer.from([id, body.length / 2]), body]);
  const subs = Buffer.concat([sub(0x21, wavHeader), sub(0x0a, WV_BITSTREAM)]);
  const block = Buffer.concat([latin("wvpk"), u32le(24 + subs.length), Buffer.from([0x10, 0x04, 0, 0]), Buffer.alloc(20), subs]);
  return Buffer.concat([block, apev2(), id3v1()]);
};

// TTA: an APEv2 tag after it (and an ID3v2 tag before it, as some taggers write).
const TTA_FRAMES = Buffer.alloc(320, 0x13);
const tta = (id3 = false) => Buffer.concat([...(id3 ? [id3v2()] : []), latin("TTA1"), Buffer.alloc(18, 1), TTA_FRAMES, apev2()]);

// Sun AU: its annotation the place.
const AU_SOUND = Buffer.alloc(256, 0x61);
const au = () => {
  const annotation = latin(`Recording at ${PLACE}\0\0\0\0`.padEnd(48, "\0"));
  return Buffer.concat([latin(".snd"), u32be(24 + annotation.length), u32be(AU_SOUND.length), u32be(2), u32be(8000), u32be(1), annotation, AU_SOUND]);
};

// The containers refused: an ASF (WMA, WMV) with a Content Description, an FLV with onMetaData, transport streams,
// JPEG XL and JPEG 2000 in their boxes.
const ASF_GUID = Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex");
const asf = () => Buffer.concat([ASF_GUID, Buffer.alloc(14), utf16(`Recording at ${PLACE}`)]);
const flv = () => Buffer.concat([latin("FLV"), Buffer.from([1, 5, 0, 0, 0, 9]), Buffer.alloc(4), Buffer.from([0x12]), Buffer.alloc(10), latin(`onMetaData title ${PLACE}`)]);
const ts = (packet: 188 | 192) => Buffer.concat(Array.from({ length: 4 }, (_, i) => {
  const p = Buffer.alloc(packet, 0xff);
  Buffer.from([0x47, 0x40, 0x11, 0x10]).copy(p, packet - 188);
  if (i === 1) latin(`Service ${PLACE}`).copy(p, packet - 188 + 8);
  return p;
}));
const signature = (type: string) => Buffer.concat([u32be(12), latin(type), Buffer.from([0x0d, 0x0a, 0x87, 0x0a])]);
const jxl = () => Buffer.concat([signature("JXL "), u32be(20), latin("ftyp"), latin("jxl "), u32be(0), latin("jxl "), u32be(8 + 4 + PLACE.length), latin("Exif"), u32be(0), latin(PLACE), u32be(16), latin("jxlc"), Buffer.from([0xff, 0x0a]), Buffer.alloc(6)]);
const jp2 = () => Buffer.concat([signature("jP  "), u32be(20), latin("ftyp"), latin("jp2 "), u32be(0), latin("jp2 "), u32be(8 + PLACE.length), latin("xml "), latin(PLACE)]);

describe("the other containers a file is sent in", () => {
  it("an AVI goes without its INFO list, its date, its streams' names and data, and its GPS stream's text; its frames and sound untouched", async () => {
    const file = avi();
    expect(hasPlace(file)).toBe(true);
    for (const mime of ["video/x-msvideo", "video/avi", ""]) {
      const out = await sent(file, mime);
      expect(hasPlace(out), mime).toBe(false);
      expect(contains(out, latin("Fri Nov 13")), mime).toBe(false);
      expect(out.length).toBe(file.length);
      expect(contains(out, Buffer.concat([latin("00dc"), u32le(FRAME.length), FRAME]))).toBe(true);
      expect(contains(out, Buffer.concat([latin("01wb"), u32le(SOUND.length), SOUND]))).toBe(true);
      for (const kept of ["avih", "strh", "strf", "movi", "idx1", "AVIX"]) expect(contains(out, latin(kept)), kept).toBe(true);
      for (const gone of ["strn", "strd", "IDIT", "INFO", "INAM"]) expect(contains(out, latin(gone)), gone).toBe(false);
    }
  });

  it("an AIFF and an AIFF-C go without NAME, AUTH, ANNO, (c) and their ID3 chunk, their sound untouched", async () => {
    for (const form of ["AIFF", "AIFC"] as const) {
      const file = aiff(form);
      expect(hasPlace(file)).toBe(true);
      const out = await sent(file, "audio/aiff");
      expect(hasPlace(out), form).toBe(false);
      expect(out.length).toBe(file.length);
      expect(contains(out, AIFF_SOUND)).toBe(true);
      for (const kept of ["COMM", "SSND"]) expect(contains(out, latin(kept)), kept).toBe(true);
      for (const gone of ["NAME", "AUTH", "ANNO", "(c) ", "ID3 "]) expect(contains(out, latin(gone)), gone).toBe(false);
    }
  });

  it("a CAF goes without its info chunk, its data to the end of the file untouched", async () => {
    const file = caf();
    expect(hasPlace(file)).toBe(true);
    const out = await sent(file, "audio/x-caf");
    expect(hasPlace(out)).toBe(false);
    expect(out.length).toBe(file.length);
    expect(contains(out, CAF_SOUND)).toBe(true);
    expect(contains(out, latin("info"))).toBe(false);
  });

  it("a WavPack goes without its APEv2 and ID3v1 tags and the source WAV's INFO list, its bitstream untouched", async () => {
    const file = wavpack();
    expect(hasPlace(file)).toBe(true);
    const out = await sent(file, "audio/x-wavpack");
    expect(hasPlace(out)).toBe(false);
    expect(out.length).toBe(file.length);
    expect(contains(out, WV_BITSTREAM)).toBe(true);
  });

  it("a TTA goes without its APEv2 and ID3v2 tags, its frames untouched", async () => {
    for (const file of [tta(), tta(true)]) {
      expect(hasPlace(file)).toBe(true);
      const out = await sent(file, "audio/x-tta");
      expect(hasPlace(out)).toBe(false);
      expect(out.length).toBe(file.length);
      expect(contains(out, Buffer.concat([latin("TTA1"), Buffer.alloc(18, 1), TTA_FRAMES]))).toBe(true);
    }
  });

  it("a Sun AU goes without its annotation, its sound untouched", async () => {
    const file = au();
    const out = await sent(file, "audio/basic");
    expect(hasPlace(out)).toBe(false);
    expect(out.length).toBe(file.length);
    expect(Buffer.from(out.subarray(0, 24)).equals(file.subarray(0, 24))).toBe(true);
    expect(contains(out, AU_SOUND)).toBe(true);
  });

  it("an ASF (WMA, WMV), an FLV and a transport stream are refused, never sent with their title or place", async () => {
    await expect(sent(asf(), "audio/x-ms-wma")).rejects.toThrow(NO_AUDIO_METADATA);
    await expect(sent(asf(), "video/x-ms-wmv")).rejects.toThrow(NO_VIDEO_METADATA);
    await expect(sent(asf(), "")).rejects.toThrow(NO_VIDEO_METADATA);
    await expect(sent(flv(), "video/x-flv")).rejects.toThrow(NO_VIDEO_METADATA);
    await expect(sent(ts(188), "video/mp2t")).rejects.toThrow(NO_VIDEO_METADATA);
    await expect(sent(ts(192), "")).rejects.toThrow(NO_VIDEO_METADATA);
  });

  it("a JPEG XL and a JPEG 2000 in their boxes are refused, never sent with their Exif or XMP", async () => {
    for (const [file, mime] of [[jxl(), "image/jxl"], [jxl(), ""], [jp2(), "image/jp2"]] as const) {
      await expect(sent(file, mime)).rejects.toThrow(NO_PICTURE_METADATA);
    }
  });

  it("a file that is none of them still goes as it is", async () => {
    for (const file of [latin("G".repeat(1000)), latin(`.sn not a sound ${PLACE}`), Buffer.concat([latin("RIFF"), u32le(4), latin("ACON")])]) {
      expect(Buffer.from(await sent(file, "application/octet-stream")).equals(file)).toBe(true);
    }
  });
});
