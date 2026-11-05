import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BlobSource, BufferTarget, Conversion, EncodedPacketSink, Input, MP4, MovOutputFormat, Mp4OutputFormat, Output, QTFF } from "mediabunny";
import { NO_VIDEO_METADATA, videoMetadataPatches, withoutVideoMetadata } from "../src/videoMetadata";
import { H264_MP4, PLACE, box, hasPlace, headerTimes, metadataTrack, withFirst, withMovie, withTrack, xyzUdta } from "./support/videoFixtures";
// covers: files.video.metadata

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/**
 * The fixture repackaged with `moov` last (or fragmented): a .MOV with its place in `moov/meta` keys (as an iPhone
 * writes it), or an MP4. Its movie and track headers say it was made now, as a recorder's do.
 */
async function repack(mov: boolean, fastStart: false | "fragmented" = false): Promise<Buffer> {
  const input = new Input({ source: new BlobSource(new Blob([H264_MP4])), formats: [MP4, QTFF] });
  const target = new BufferTarget();
  const output = new Output({ format: mov ? new MovOutputFormat({ fastStart }) : new Mp4OutputFormat({ fastStart }), target });
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

  it("the times it was recorded go: mvhd, every tkhd and every mdhd, 32-bit and 64-bit, in place", async () => {
    // A recorder writes when it recorded (seconds since 1904): 2026 fits in 32 bits (version 0), 2050 does not (version 1).
    for (const [when, version] of [["2026-11-04T02:33:13Z", 0], ["2050-01-01T00:00:00Z", 1]] as const) {
      for (const [mov, fastStart] of [[false, false], [true, false], [false, "fragmented"]] as const) {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(when));
        const video = await repack(mov, fastStart).finally(() => vi.useRealTimers());
        const recorded = Date.parse(when) / 1000 + 2082844800;
        const before = headerTimes(video);
        expect(before.map((h) => h.type).sort()).toEqual(["mdhd", "mvhd", "tkhd"]);
        for (const h of before) expect(h, `${when} ${mov} ${fastStart}`).toEqual({ type: h.type, version, created: recorded, modified: recorded });
        const out = Buffer.from(await bytesOf((await withoutVideoMetadata(new Blob([video as BlobPart]), mov ? "video/quicktime" : "video/mp4"))!));
        for (const h of headerTimes(out)) expect(h, `${when} ${mov} ${fastStart}`).toEqual({ type: h.type, version, created: 0, modified: 0 });
        expect(out.length).toBe(video.length);
        expect(await played(out)).toEqual(await played(video));
      }
    }
  });

  it("a timecode track's start (a camera's time of day) is zeroed; a fragment's wall-clock time (prft) goes", async () => {
    const at = Buffer.alloc(4);
    at.writeUInt32BE((14 * 3600 + 23 * 60 + 5) * 25);
    const timed = withMovie(H264_MP4, [], at, "tmcd");
    const out = await bytesOf((await withoutVideoMetadata(new Blob([timed]), "video/quicktime"))!);
    const zeroed = await bytesOf((await withoutVideoMetadata(new Blob([withMovie(H264_MP4, [], Buffer.alloc(4), "tmcd")]), "video/quicktime"))!);
    expect(Buffer.from(out).equals(zeroed)).toBe(true);
    expect(out.subarray(-4).every((b) => b === 0)).toBe(true);
    expect(await played(out)).toEqual(await played(timed));

    const ntp = Buffer.from("e8a1b2c3d4e5f607", "hex");
    const prft = box("prft", Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), ntp, Buffer.alloc(4));
    const live = Buffer.concat([H264_MP4, prft]);
    const sent = Buffer.from(await bytesOf((await withoutVideoMetadata(new Blob([live]), "video/mp4"))!));
    expect(sent.length).toBe(live.length);
    expect(sent.includes(ntp)).toBe(false);
    expect(sent.subarray(H264_MP4.length + 4, H264_MP4.length + 8).toString("latin1")).toBe("free");
  });

  it("free, skip and wide boxes already in the file go as zeros after their header, at the top, in moov and in a track", async () => {
    const held = (type: string) => box(type, Buffer.from(`old udta: ${PLACE} iPhone 17 Pro`, "latin1"));
    for (const type of ["free", "skip", "wide"]) {
      const files = [
        Buffer.concat([H264_MP4, held(type)]),
        withMovie(H264_MP4, [held(type)]),
        withTrack(H264_MP4, [held(type)]),
        Buffer.concat([await repack(false, "fragmented"), held(type)]),
      ];
      for (const video of files) {
        expect(hasPlace(video)).toBe(true);
        const out = Buffer.from(await bytesOf((await withoutVideoMetadata(new Blob([video]), "video/mp4"))!));
        expect(hasPlace(out), type).toBe(false);
        expect(out.length).toBe(video.length);
        // The box stays where it was, its type kept, its body zeros.
        const at = video.indexOf(held(type));
        expect(out.subarray(at, at + 8).equals(held(type).subarray(0, 8))).toBe(true);
        expect(out.subarray(at + 8, at + held(type).length).every((b) => b === 0)).toBe(true);
        expect(await played(out)).toEqual(await played(video));
      }
    }
  });

  it("the names in a track's handler (hdlr) and its encoder's in the sample description (compressorname) go, the handler type kept", async () => {
    for (const video of [H264_MP4, await repack(true)]) {
      const out = Buffer.from(await bytesOf((await withoutVideoMetadata(new Blob([video as BlobPart]), "video/quicktime"))!));
      for (const name of ["VideoHandler", "Lavc62.11.100 libx264", "Core Media", "Handler"]) expect(out.includes(Buffer.from(name, "latin1")), name).toBe(false);
      expect(out.length).toBe(video.length);
      expect(await played(out)).toEqual(await played(video));
      const input = new Input({ source: new BlobSource(new Blob([out as BlobPart])), formats: [MP4, QTFF] });
      expect((await input.getPrimaryVideoTrack())?.type).toBe("video");
    }
    expect(H264_MP4.includes(Buffer.from("VideoHandler", "latin1")) && H264_MP4.includes(Buffer.from("Lavc62.11.100 libx264", "latin1"))).toBe(true);
  });

  it("a movie whose first box is a uuid, a preview (pnot, PICT) or a udta is stripped, by its bytes too", async () => {
    const tool = box("uuid", Buffer.from("0123456789abcdef", "latin1"), Buffer.from(PLACE, "latin1"));
    const preview = Buffer.concat([box("pnot", Buffer.from("e8a1b2c3", "hex"), Buffer.alloc(2), Buffer.from("PICT", "latin1"), Buffer.from([0, 1])), box("PICT", Buffer.from(PLACE, "latin1"))]);
    // The movie as it goes without them, they made `free` boxes of their sizes, zeroed.
    const stripped = Buffer.from(await bytesOf((await withoutVideoMetadata(new Blob([H264_MP4]), "video/mp4"))!));
    const freed = (first: Buffer) => {
      const out = Buffer.alloc(first.length);
      for (let at = 0; at < first.length; at += first.readUInt32BE(at)) {
        out.writeUInt32BE(first.readUInt32BE(at), at);
        out.write("free", at + 4, "latin1");
      }
      return out;
    };
    for (const first of [tool, preview, xyzUdta()]) {
      const video = withFirst(H264_MP4, first);
      for (const mime of ["", "application/octet-stream", "video/mp4", "video/quicktime"]) {
        const out = Buffer.from(await bytesOf((await withoutVideoMetadata(new Blob([video]), mime))!));
        expect(hasPlace(out), mime).toBe(false);
        expect(out.equals(withFirst(stripped, freed(first)))).toBe(true);
      }
    }
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

  it("any bytes after the last whole box (1 to 7 zeros, a phone's trailer) go as zeros, the size kept", async () => {
    const mp4 = withMovie(H264_MP4, [xyzUdta()]);
    const trailer = Buffer.from(`SEFT trailer ${PLACE}`, "latin1");
    for (const tail of [Buffer.alloc(1), Buffer.alloc(7), Buffer.alloc(100), trailer, Buffer.from(PLACE.slice(0, 5), "latin1")]) {
      const padded = Buffer.concat([mp4, tail]);
      const out = await bytesOf((await withoutVideoMetadata(new Blob([padded]), "video/mp4"))!);
      expect(hasPlace(out), `${tail.length}`).toBe(false);
      expect(out.length).toBe(padded.length);
      expect(Buffer.from(out.subarray(0, mp4.length)).equals(await bytesOf((await withoutVideoMetadata(new Blob([mp4]), "video/mp4"))!))).toBe(true);
      expect(out.subarray(mp4.length).every((b) => b === 0)).toBe(true);
      expect(await played(out)).toEqual(await played(mp4));
    }
  });

  it("a top-level box this does not know (Samsung's sefd, a GPS track's gps0) is emptied into free", async () => {
    const mp4 = withMovie(H264_MP4, [xyzUdta()]);
    for (const type of ["sefd", "gps0", "junk"]) {
      const extra = box(type, Buffer.from(`SEFT ${PLACE}`, "latin1"));
      const file = Buffer.concat([mp4, extra]);
      const out = await bytesOf((await withoutVideoMetadata(new Blob([file]), "video/mp4"))!);
      expect(hasPlace(out), type).toBe(false);
      expect(out.length).toBe(file.length);
      expect(Buffer.from(out.subarray(mp4.length)).equals(box("free", Buffer.alloc(extra.length - 8)))).toBe(true);
      expect(await played(out)).toEqual(await played(mp4));
    }
  });

  it("a video is refused when its samples are where a box it empties or its trailer is", async () => {
    // The fixture's chunks moved into a `sefd` box, or into bytes after its last box (an `mdat` cut short).
    const top = (file: Buffer) => {
      const found: [string, number, number][] = [];
      for (let at = 0; at < file.length; at += file.readUInt32BE(at)) found.push([file.toString("latin1", at + 4, at + 8), at, at + file.readUInt32BE(at)]);
      return found;
    };
    const mdat = top(H264_MP4).find(([type]) => type === "mdat")!;
    const renamed = Buffer.from(H264_MP4);
    renamed.write("sefd", mdat[1] + 4, "latin1");
    const cut = Buffer.from(H264_MP4.subarray(0, mdat[2] - 1));
    // Or into a `free` box, whose body goes as zeros.
    const space = Buffer.from(H264_MP4);
    space.write("free", mdat[1] + 4, "latin1");
    for (const file of [renamed, cut, space]) await expect(withoutVideoMetadata(new Blob([file]), "video/mp4")).rejects.toThrow(NO_VIDEO_METADATA);
  });

  it("a fragmented video is refused when a fragment's samples are where a box it empties or its trailer is", async () => {
    const fragmented = await repack(false, "fragmented");
    const top = (file: Buffer) => {
      const found: [string, number, number][] = [];
      for (let at = 0; at < file.length; at += file.readUInt32BE(at)) found.push([file.toString("latin1", at + 4, at + 8), at, at + file.readUInt32BE(at)]);
      return found;
    };
    const mdats = top(fragmented).filter(([type]) => type === "mdat");
    expect(mdats.length).toBeGreaterThan(0);
    // It goes, its frames as they were.
    const out = await bytesOf((await withoutVideoMetadata(new Blob([fragmented as BlobPart]), "video/mp4"))!);
    expect(await played(out)).toEqual(await played(fragmented));
    // A fragment's `mdat` made a box it empties (one it does not know, or space), or cut short into a trailer.
    const renamed = (type: string) => {
      const file = Buffer.from(fragmented);
      file.write(type, mdats[mdats.length - 1]![1] + 4, "latin1");
      return file;
    };
    const cut = Buffer.from(fragmented.subarray(0, mdats[mdats.length - 1]![2] - 1));
    for (const file of [renamed("sefd"), renamed("free"), renamed("skip"), cut]) await expect(withoutVideoMetadata(new Blob([file]), "video/mp4")).rejects.toThrow(NO_VIDEO_METADATA);

    // A fragment whose run starts at its track fragment's own base offset, its samples of the size `trex` says.
    const u32 = (n: number) => Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
    const head = box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1"));
    const moov = (offset: number) => box("moov", box("mvhd", Buffer.alloc(100)), metadataTrack(offset, 4, "soun"),
      box("mvex", box("trex", u32(0), u32(1), u32(1), u32(0), u32(6), u32(0))));
    const mdat = box("mdat", Buffer.from("aac!frame1frame2", "latin1"));
    const moof = (base: number) => box("moof", box("mfhd", u32(0), u32(1)), box("traf", box("tfhd", u32(1), u32(1), u32(0), u32(base)), box("trun", u32(0), u32(2))));
    const sefd = box("sefd", Buffer.from(`frame1frame2 ${PLACE}`, "latin1"));
    const at = head.length + moov(0).length;
    const file = (base: number) => Buffer.concat([head, moov(at + 8), mdat, moof(base), sefd]);
    const inMdat = file(at + 12), inSefd = file(at + mdat.length + moof(0).length + 8);
    expect(hasPlace(await bytesOf((await withoutVideoMetadata(new Blob([inMdat]), "video/mp4"))!))).toBe(false);
    await expect(withoutVideoMetadata(new Blob([inSefd]), "video/mp4")).rejects.toThrow(NO_VIDEO_METADATA);
  });

  it("a fragmented video with a box it empties in each fragment is checked once per fragment, not against every other fragment", async () => {
    // A live encoder's recording: a `prft` (when the fragment was made) before each of 16,000 fragments, two samples each.
    const u32 = (n: number) => Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
    const head = box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1"));
    const moov = box("moov", box("mvhd", Buffer.alloc(100)), metadataTrack(0, 4, "soun"), box("mvex", box("trex", u32(0), u32(1), u32(1), u32(0), u32(6), u32(0))));
    const mdat = box("mdat", Buffer.from("frame1frame2", "latin1"));
    // Its run starts past the `moof` (the base is the `moof`'s start), at its `mdat`'s samples.
    const moof = (n: number, offset: number) => box("moof", box("mfhd", u32(0), u32(n)), box("traf", box("tfhd", u32(0x20000), u32(1)), box("trun", u32(1), u32(2), u32(offset))));
    const recording = (prft: boolean) => Buffer.concat([head, moov, ...Array.from({ length: 16_000 }, (_, i) => [
      ...prft ? [box("prft", u32(0), u32(1), Buffer.alloc(8), u32(0))] : [], moof(i + 1, moof(0, 0).length + 8), mdat]).flat()]);
    // Read from memory, so the time is the walk's and the checks', not a Blob's reads.
    const cpu = async (file: Buffer) => {
      const prfts = file.includes(Buffer.from("prft", "latin1")) ? 16_000 : 0;
      const before = process.cpuUsage();
      const patches = await videoMetadataPatches({ size: file.length, read: async (offset, length) => new Uint8Array(file.subarray(offset, offset + length)) }, "video/mp4");
      const used = process.cpuUsage(before);
      // Each `prft` made `free`, its body zeros, the 16,000 `moof`s as they were.
      expect(patches!.filter((patch) => !patch.bytes).length).toBe(prfts);
      return used.user + used.system;
    };
    // The same video without them: the `prft`s cost about what the fragments do, not fragments x fragments. Each run
    // warmed up, the best of three: at most twice as long with them (each is two more reads), seventeen times before.
    const plainFile = recording(false), timedFile = recording(true);
    const best = async (file: Buffer) => {
      let least = Infinity;
      for (let run = 0; run < 3; run++) least = Math.min(least, await cpu(file));
      return least;
    };
    await cpu(plainFile);
    await cpu(timedFile);
    const plain = await best(plainFile), timed = await best(timedFile);
    expect(timed / plain, `${timed} µs with a prft per fragment, ${plain} µs without`).toBeLessThan(5);
  }, 120_000);

  it("a fragmented video's boxes are read a window at a time, not one read per box header and one per moof", async () => {
    // A read from a Blob costs about the same whatever its size (half a millisecond in Chromium): what counts is how many.
    const u32 = (n: number) => Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
    const head = box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1"));
    const moov = box("moov", box("mvhd", Buffer.alloc(100)), metadataTrack(0, 4, "soun"), box("mvex", box("trex", u32(0), u32(1), u32(1), u32(0), u32(6), u32(0))));
    const prft = box("prft", u32(0), u32(1), Buffer.alloc(8), u32(0));
    // Its run starts past the `moof` (the base is the `moof`'s start), at its `mdat`'s samples.
    const moof = (n: number, sample: number, offset: number) => box("moof", box("mfhd", u32(0), u32(n)), box("traf", box("tfhd", u32(0x20010), u32(1), u32(sample)), box("trun", u32(1), u32(2), u32(offset))));
    /** `fragments` fragments of two samples of `sample` bytes, each after a `prft`. */
    const recording = (fragments: number, sample: number) => Buffer.concat([head, moov, ...Array.from({ length: fragments }, (_, i) => [
      prft, moof(i + 1, sample, moof(0, 0, 0).length + 8), box("mdat", Buffer.alloc(sample * 2, i & 255))]).flat()]);
    const reads = async (file: Buffer, fragments: number) => {
      let count = 0;
      const patches = (await videoMetadataPatches({ size: file.length, read: async (offset, length) => { count++; return Uint8Array.from(file.subarray(offset, offset + length)); } }, "video/mp4"))!;
      // Each `prft` made `free` (its header rewritten, its body zeros), each `moof` as it was, byte for byte.
      expect(patches.filter((patch) => !patch.bytes).length).toBe(fragments);
      expect(patches.filter((patch) => patch.bytes && Buffer.from(patch.bytes).subarray(4, 8).toString("latin1") === "free").length).toBe(fragments);
      const moofs = patches.filter((patch) => patch.bytes && Buffer.from(patch.bytes).subarray(4, 8).toString("latin1") === "moof");
      expect(moofs.length).toBe(fragments);
      for (const patch of moofs) expect(Buffer.from(patch.bytes!).equals(file.subarray(patch.start, patch.end))).toBe(true);
      return count;
    };
    // A low-latency recording, a frame per fragment: many fragments share a read (five reads per fragment before).
    expect(await reads(recording(1_000, 6), 1_000)).toBeLessThan(100);
    // Fragments of 100 KB: one read for a fragment's three headers and its `moof`, one for its `prft` and `moof` again
    // when they are emptied and copied (five before).
    expect(await reads(recording(40, 50_000), 40)).toBeLessThanOrEqual(2 * 40 + 4);
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
      // A compressed movie header, a box it does not know in it.
      [withMovie(H264_MP4, [box("cmov", Buffer.from(PLACE, "latin1"))]), "video/quicktime"],
      // Typed as a video, and not one.
      [Buffer.from(`not a movie ${PLACE}`, "latin1"), "video/mp4"],
      [Buffer.from(`not a movie ${PLACE}`, "latin1"), "video/quicktime"],
      // No movie header at all.
      [Buffer.concat([H264_MP4.subarray(0, 32), box("mdat", Buffer.from(PLACE, "latin1"))]), "video/mp4"],
      // Untyped, made of boxes and without a movie header: a box it does not know, or bytes that are no box.
      [Buffer.concat([xyzUdta(), box("sefd", Buffer.from(PLACE, "latin1"))]), ""],
      [Buffer.concat([xyzUdta(), Buffer.from(PLACE.slice(0, 5), "latin1")]), ""],
      // A fragmented movie with a metadata track (its samples in fragments are not looked for).
      [withMovie(await repack(false, "fragmented"), [], Buffer.from(PLACE, "latin1")), "video/mp4"],
    ];
    for (const [bytes, mime] of bad) await expect(withoutVideoMetadata(new Blob([bytes as BlobPart]), mime), `${mime} ${bytes.length}`).rejects.toThrow(NO_VIDEO_METADATA);
  });

  it("any other file goes as it is: text, a picture (pictureMetadata.ts's), audio without a video track", async () => {
    expect(await withoutVideoMetadata(new Blob([`hello ${PLACE}`]), "text/plain")).toBeUndefined();
    const heic = box("ftyp", Buffer.from("heic\0\0\0\0mif1heic", "latin1"));
    expect(await withoutVideoMetadata(new Blob([heic]), "image/heic")).toBeUndefined();
    // A stream's segment without a movie header, untyped.
    const segment = Buffer.concat([box("styp", Buffer.from("msdh\0\0\0\0msdhmsix", "latin1")), box("moof", box("mfhd", Buffer.alloc(8))), box("mdat", Buffer.from("data", "latin1"))]);
    expect(await withoutVideoMetadata(new Blob([segment]), "")).toBeUndefined();
    // An M4A: a movie with a sound track alone, its tags kept.
    const head = box("ftyp", Buffer.from("M4A \0\0\0\0M4A isom", "latin1"));
    const moov = (offset: number) => box("moov", box("mvhd", Buffer.alloc(100)), metadataTrack(offset, 4, "soun"), xyzUdta());
    const m4a = Buffer.concat([head, moov(head.length + moov(0).length + 8), box("mdat", Buffer.from("aac!", "latin1"))]);
    expect(await withoutVideoMetadata(new Blob([m4a]), "audio/mp4")).toBeUndefined();
    // Typed as a video, it is one: stripped.
    expect(hasPlace(await bytesOf((await withoutVideoMetadata(new Blob([m4a]), "video/mp4"))!))).toBe(false);
  });
});
