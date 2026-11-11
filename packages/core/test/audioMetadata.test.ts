import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, EncodedPacketSink, FlacOutputFormat, Input, MkvOutputFormat, Mp3OutputFormat, Output } from "mediabunny";
import { NO_AUDIO_METADATA, audioMetadataPatches, withoutAudioMetadata } from "../src/audioMetadata";
import { MP3_FRAMES, FLAC_FRAMES, OPUS_PACKETS, PLACE, WAV_DATA, WEBM_BLOCK, apev2, hasPlace, id3v1, id3v2, oggCrc, taggedFlac, taggedM4a, taggedMp3, taggedOpus, taggedVorbis, taggedWav, taggedWebm } from "./support/audioFixtures";
// covers: files.audio.metadata

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const stripped = async (bytes: Uint8Array, mime: string) => bytesOf((await withoutAudioMetadata(new Blob([bytes as BlobPart]), mime))!);
const contains = (bytes: Uint8Array, part: Uint8Array) => Buffer.from(bytes).includes(Buffer.from(part));

/** What a player reads of an audio file: its duration and its sound's packets, byte for byte. */
async function played(bytes: Uint8Array) {
  const input = new Input({ source: new BlobSource(new Blob([bytes as BlobPart])), formats: ALL_FORMATS });
  const track = (await input.getPrimaryAudioTrack())!;
  const packets: number[][] = [];
  for await (const packet of new EncodedPacketSink(track).packets()) packets.push([...packet.data]);
  return { duration: await input.computeDuration(), codec: track.codec, rate: track.sampleRate, channels: track.numberOfChannels, packets };
}

/** An audio file of the e2e fixtures copied (not re-encoded) into `format`, with a title, a comment and a place. */
async function retagged(name: string, format: Mp3OutputFormat | FlacOutputFormat | MkvOutputFormat): Promise<Buffer> {
  const file = readFileSync(fileURLToPath(new URL(`../../../e2e/support/audio-fixtures/${name}`, import.meta.url)));
  const input = new Input({ source: new BlobSource(new Blob([file])), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format, target });
  const conversion = await Conversion.init({ input, output, copy: { mode: "forced", shiftTolerance: 1 }, tags: { title: `Recording at ${PLACE}`, comment: PLACE, raw: { LOCATION: PLACE } } });
  await conversion.execute();
  return Buffer.from(target.buffer!);
}

describe("withoutAudioMetadata", () => {
  it("an MP3's ID3v2, APEv2 and ID3v1 tags go, the file the same size and its frames untouched", async () => {
    const mp3 = taggedMp3();
    expect(hasPlace(mp3)).toBe(true);
    for (const mime of ["audio/mpeg", "audio/mp3", "", "application/octet-stream"]) {
      const out = await stripped(mp3, mime);
      expect(hasPlace(out), mime).toBe(false);
      expect(out.length).toBe(mp3.length);
      expect(contains(out, MP3_FRAMES)).toBe(true);
      // An empty ID3v2 tag of padding where it was, and an ID3v1 that names nothing.
      expect(Buffer.from(out.subarray(0, 3)).toString("latin1")).toBe("ID3");
      expect(out.subarray(10, id3v2().length).every((b) => b === 0)).toBe(true);
      expect(Buffer.from(out.subarray(-128, -125)).toString("latin1")).toBe("TAG");
      expect(await played(out)).toEqual(await played(mp3));
    }
  });

  it("an MP3 a tagger wrote goes without its title, comment and place, and plays as it did", async () => {
    const mp3 = await retagged("ghost-tune.mp3", new Mp3OutputFormat());
    expect(hasPlace(mp3)).toBe(true);
    const out = await stripped(mp3, "audio/mpeg");
    expect(hasPlace(out)).toBe(false);
    expect(out.length).toBe(mp3.length);
    expect(await played(out)).toEqual(await played(mp3));
  });

  it("a FLAC's Vorbis comment and picture become padding, its stream info and frames kept", async () => {
    for (const flac of [taggedFlac(), await retagged("ghost-tune.flac", new FlacOutputFormat())]) {
      expect(hasPlace(flac)).toBe(true);
      const out = await stripped(flac, "audio/flac");
      expect(hasPlace(out)).toBe(false);
      expect(out.length).toBe(flac.length);
      expect(await played(out)).toEqual(await played(flac));
    }
    expect(contains(await stripped(taggedFlac(), "audio/flac"), FLAC_FRAMES)).toBe(true);
  });

  it("an Ogg Opus or Vorbis file goes without its comments, each page it changed with its checksum made again", async () => {
    for (const ogg of [taggedOpus(), taggedVorbis()]) {
      expect(hasPlace(ogg)).toBe(true);
      const out = Buffer.from(await stripped(ogg, "audio/ogg"));
      expect(hasPlace(out)).toBe(false);
      expect(out.length).toBe(ogg.length);
      for (const packet of OPUS_PACKETS) expect(out.includes(packet)).toBe(true);
      // Every page's checksum is right.
      for (let at = 0; at < out.length;) {
        const segments = out[at + 26]!, size = 27 + segments + out.subarray(at + 27, at + 27 + segments).reduce((sum, b) => sum + b, 0);
        const page = Buffer.from(out.subarray(at, at + size));
        const crc = page.readUInt32LE(22);
        page.writeUInt32LE(0, 22);
        expect(oggCrc(page)).toBe(crc);
        at += size;
      }
      // The vendor (the encoder's name) kept, no comment after it.
      expect(out.includes("libopus 1.5") || out.includes("reference libFLAC")).toBe(true);
      expect(out.includes("TITLE=")).toBe(false);
    }
  });

  it("a WAV's INFO list and ID3 chunk become JUNK, its fmt and data kept", async () => {
    const wav = taggedWav();
    const out = await stripped(wav, "audio/wav");
    expect(hasPlace(out)).toBe(false);
    expect(out.length).toBe(wav.length);
    expect(contains(out, WAV_DATA)).toBe(true);
    expect(Buffer.from(out).toString("latin1")).not.toMatch(/LIST|id3 /);
  });

  it("a WebM or Matroska file goes without its title, date, track names and tags, its clusters untouched", async () => {
    const webm = taggedWebm();
    expect(hasPlace(webm)).toBe(true);
    for (const mime of ["audio/webm", "video/webm", ""]) {
      const out = await stripped(webm, mime);
      expect(hasPlace(out)).toBe(false);
      expect(out.length).toBe(webm.length);
      expect(contains(out, Buffer.concat([Buffer.from([0xa3, 0x01, 0, 0, 0, 0, 0, 0x01, 0x30]), WEBM_BLOCK]))).toBe(true);
      // Its muxer's name zeroed with the rest: "Lavf" is no more.
      expect(Buffer.from(out).includes(Buffer.from("Lavf"))).toBe(false);
    }
    const mkv = await retagged("ghost-tune.mp3", new MkvOutputFormat());
    expect(hasPlace(mkv)).toBe(true);
    const out = await stripped(mkv, "audio/x-matroska");
    expect(hasPlace(out)).toBe(false);
    expect(out.length).toBe(mkv.length);
    expect(await played(out)).toEqual(await played(mkv));
  });

  it("an M4A goes without its udta, however it is typed", async () => {
    const m4a = taggedM4a();
    for (const mime of ["audio/mp4", "audio/x-m4a", "", "application/octet-stream"]) {
      const out = await stripped(m4a, mime);
      expect(hasPlace(out), mime).toBe(false);
      expect(out.length).toBe(m4a.length);
    }
  });

  it("its patches are what withoutAudioMetadata changes, for a file read from storage", async () => {
    for (const file of [taggedMp3(), taggedFlac(), taggedOpus(), taggedWav(), taggedWebm(), taggedM4a()]) {
      const patches = (await audioMetadataPatches({ size: file.length, read: async (offset, length) => file.subarray(offset, offset + length) }, ""))!;
      const out = Buffer.from(file);
      for (const { start, end, bytes } of patches) {
        if (bytes) out.set(bytes, start);
        else out.fill(0, start, end);
      }
      expect(out).toEqual(Buffer.from(await stripped(file, "")));
    }
  });

  it("a file whose tags cannot be removed is refused, never sent as it was", async () => {
    const bad = [
      // An ID3v2 tag that runs past the file.
      Buffer.concat([id3v2().subarray(0, 40)]),
      // An APEv2 footer whose tag starts before the file.
      Buffer.concat([MP3_FRAMES.subarray(0, 10), apev2().subarray(-32)]),
      // A FLAC block past the file.
      taggedFlac().subarray(0, 60),
      // An Ogg page cut, and a comment header whose vendor runs past it.
      taggedOpus().subarray(0, 100),
      (() => { const b = Buffer.from(taggedOpus()); b.writeUInt32LE(1 << 20, b.indexOf("OpusTags") + 8); return b; })(),
      // A WAV chunk past the file, a WebM's Tags past it.
      taggedWav().subarray(0, 60),
      taggedWebm().subarray(0, taggedWebm().length - 10),
    ];
    for (const file of bad) await expect(withoutAudioMetadata(new Blob([file as BlobPart]), "audio/mpeg"), `${file.subarray(0, 4).toString("latin1")} ${file.length}`).rejects.toThrow(NO_AUDIO_METADATA);
  });

  it("any other file goes as it is: text, an MP3 with no tags, a stream of frames", async () => {
    expect(await withoutAudioMetadata(new Blob([`hello ${PLACE}`]), "text/plain")).toBeUndefined();
    expect(await withoutAudioMetadata(new Blob(["ID3 is a tag format"]), "text/plain")).toBeUndefined();
    expect(await withoutAudioMetadata(new Blob([MP3_FRAMES]), "audio/mpeg")).toBeUndefined();
    expect(await withoutAudioMetadata(new Blob([]), "audio/mpeg")).toBeUndefined();
    // An ID3v1 alone still goes, emptied.
    expect(hasPlace(await stripped(Buffer.concat([MP3_FRAMES, id3v1()]), "audio/mpeg"))).toBe(false);
  });
});
