import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BlobSource, BufferTarget, Conversion, EncodedPacketSink, Input, MP4, MovOutputFormat, Mp4OutputFormat, Output, QTFF } from "mediabunny";
import { NO_VIDEO_METADATA, withoutVideoMetadata } from "../src/videoMetadata";
import { H264_MP4, PLACE, box, hasPlace, metadataTrack, withMovie, xyzUdta } from "./support/videoFixtures";
// covers: files.video.metadata

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** The fixture repackaged with `moov` last: a .MOV with its place in `moov/meta` keys (as an iPhone writes it), or an MP4. */
async function repack(mov: boolean): Promise<Buffer> {
  const input = new Input({ source: new BlobSource(new Blob([H264_MP4])), formats: [MP4, QTFF] });
  const target = new BufferTarget();
  const output = new Output({ format: mov ? new MovOutputFormat({ fastStart: false }) : new Mp4OutputFormat({ fastStart: false }), target });
  const conversion = await Conversion.init({ input, output, ...(mov ? { tags: { raw: { "com.apple.quicktime.location.ISO6709": PLACE } } } : {}) });
  await conversion.execute();
  return Buffer.from(target.buffer!);
}

/** What a player reads of a video: its duration, and its video track's frames, byte for byte. */
async function played(bytes: Uint8Array) {
  const input = new Input({ source: new BlobSource(new Blob([bytes as BlobPart])), formats: [MP4, QTFF] });
  const track = (await input.getPrimaryVideoTrack())!;
  const frames: { timestamp: number; data: number[] }[] = [];
  for await (const packet of new EncodedPacketSink(track).packets()) frames.push({ timestamp: packet.timestamp, data: [...packet.data] });
  return { duration: await input.computeDuration(), codec: track.codec, width: track.codedWidth, height: track.codedHeight, frames };
}

describe("withoutVideoMetadata", () => {
  it("an MP4's udta ©xyz goes, the file the same size and its frames untouched", async () => {
    const mp4 = withMovie(H264_MP4, [xyzUdta()]);
    expect(hasPlace(mp4)).toBe(true);
    const out = await bytesOf((await withoutVideoMetadata(new Blob([mp4]), "video/mp4"))!);
    expect(hasPlace(out)).toBe(false);
    expect(out.length).toBe(mp4.length);
    expect(await played(out)).toEqual(await played(mp4));
    expect((await played(out)).frames.length).toBeGreaterThan(0);
  });

  it("the e2e's VP9 MP4 goes playable, the same size", async () => {
    const vp9 = readFileSync(fileURLToPath(new URL("../../../e2e/support/video-fixtures/ghosts.mp4", import.meta.url)));
    const out = await bytesOf((await withoutVideoMetadata(new Blob([vp9]), "video/mp4"))!);
    expect(out.length).toBe(vp9.length);
    expect(await played(out)).toEqual(await played(vp9));
  });

  it("a .MOV's keys location (com.apple.quicktime.location.ISO6709) and its udta ©xyz go", async () => {
    const mov = withMovie(await repack(true), [xyzUdta()]);
    expect(hasPlace(mov)).toBe(true);
    const out = await bytesOf((await withoutVideoMetadata(new Blob([mov]), "video/quicktime"))!);
    expect(hasPlace(out)).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from("com.apple.quicktime.location", "latin1"))).toBe(false);
    expect(out.length).toBe(mov.length);
    expect(await played(out)).toEqual(await played(mov));
    const tags = await new Input({ source: new BlobSource(new Blob([out as BlobPart])), formats: [MP4, QTFF] }).getMetadataTags();
    expect(tags.raw ?? {}).toEqual({});
  });

  it("a metadata track's samples are zeroed where they are; the track itself and every other byte stay", async () => {
    const sample = Buffer.from(`location ${PLACE} motion`, "latin1");
    const mp4 = withMovie(H264_MP4, [], sample);
    expect(hasPlace(mp4)).toBe(true);
    const out = await bytesOf((await withoutVideoMetadata(new Blob([mp4]), "video/mp4"))!);
    expect(hasPlace(out)).toBe(false);
    expect(out.length).toBe(mp4.length);
    // Only that sample changed (and the fixture's own udta, its encoder's tag), to zeros.
    const zeroed = await bytesOf((await withoutVideoMetadata(new Blob([withMovie(H264_MP4, [], Buffer.alloc(sample.length))]), "video/mp4"))!);
    expect(Buffer.from(out).equals(zeroed)).toBe(true);
    expect(await played(out)).toEqual(await played(mp4));
  });

  it("a file typed as one without a type, or one in any other name, is stripped by its bytes", async () => {
    const mp4 = withMovie(H264_MP4, [xyzUdta()]);
    for (const mime of ["", "application/octet-stream", "video/webm"]) expect(hasPlace(await bytesOf((await withoutVideoMetadata(new Blob([mp4]), mime))!))).toBe(false);
  });

  it("zeros after the last box (a recorder's padding) go as zeros, whatever is in them", async () => {
    const mp4 = withMovie(H264_MP4, [xyzUdta()]);
    for (const tail of [Buffer.alloc(3 * 1024 * 1024), Buffer.concat([Buffer.alloc(8), Buffer.from(PLACE, "latin1")])]) {
      const padded = Buffer.concat([mp4, tail]);
      const out = await bytesOf((await withoutVideoMetadata(new Blob([padded]), "video/mp4"))!);
      expect(hasPlace(out)).toBe(false);
      expect(out.length).toBe(padded.length);
      expect(out.subarray(mp4.length).every((b) => b === 0)).toBe(true);
      expect(await played(out)).toEqual(await played(mp4));
    }
  });

  it("a video with nothing left to remove goes the same: the fixture's encoder tag (udta/meta/ilst) went the first time", async () => {
    const once = await bytesOf((await withoutVideoMetadata(new Blob([H264_MP4]), "video/mp4"))!);
    expect(Buffer.from(once).includes(Buffer.from("ilst", "latin1"))).toBe(false);
    expect(Buffer.from(once).subarray(1036).equals(H264_MP4.subarray(1036))).toBe(true);
    const twice = await bytesOf((await withoutVideoMetadata(new Blob([once as BlobPart]), "video/mp4"))!);
    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
  });

  it("is refused, never sent as it was, when its metadata cannot be removed", async () => {
    const mp4 = withMovie(H264_MP4, [xyzUdta()]);
    const moov = mp4.indexOf(Buffer.from("moov", "latin1")) - 4;
    const bad: [Uint8Array, string][] = [
      // Cut inside a box.
      [mp4.subarray(0, mp4.length - 10), "video/mp4"],
      [mp4.subarray(0, moov + 100), "video/mp4"],
      // A box at the top this does not know.
      [Buffer.concat([mp4, box("junk", Buffer.from(PLACE, "latin1"))]), "video/mp4"],
      // A compressed movie header, a box it does not know in it.
      [withMovie(H264_MP4, [box("cmov", Buffer.from(PLACE, "latin1"))]), "video/quicktime"],
      // Typed as a video, and not one.
      [Buffer.from(`not a movie ${PLACE}`, "latin1"), "video/mp4"],
      [Buffer.from(`not a movie ${PLACE}`, "latin1"), "video/quicktime"],
      // No movie header at all.
      [Buffer.concat([H264_MP4.subarray(0, 32), box("mdat", Buffer.from(PLACE, "latin1"))]), "video/mp4"],
    ];
    for (const [bytes, mime] of bad) await expect(withoutVideoMetadata(new Blob([bytes as BlobPart]), mime), `${mime} ${bytes.length}`).rejects.toThrow(NO_VIDEO_METADATA);
  });

  it("any other file goes as it is: text, a picture (pictureMetadata.ts's), audio without a video track", async () => {
    expect(await withoutVideoMetadata(new Blob([`hello ${PLACE}`]), "text/plain")).toBeUndefined();
    const heic = box("ftyp", Buffer.from("heic\0\0\0\0mif1heic", "latin1"));
    expect(await withoutVideoMetadata(new Blob([heic]), "image/heic")).toBeUndefined();
    // An M4A: a movie with a sound track alone, its tags kept.
    const head = box("ftyp", Buffer.from("M4A \0\0\0\0M4A isom", "latin1"));
    const moov = (offset: number) => box("moov", box("mvhd", Buffer.alloc(100)), metadataTrack(offset, 4, "soun"), xyzUdta());
    const m4a = Buffer.concat([head, moov(head.length + moov(0).length + 8), box("mdat", Buffer.from("aac!", "latin1"))]);
    expect(await withoutVideoMetadata(new Blob([m4a]), "audio/mp4")).toBeUndefined();
    // Typed as a video, it is one: stripped.
    expect(hasPlace(await bytesOf((await withoutVideoMetadata(new Blob([m4a]), "video/mp4"))!))).toBe(false);
  });
});
