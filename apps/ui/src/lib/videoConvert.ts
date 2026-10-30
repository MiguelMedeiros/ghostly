import {
  BlobSource, canEncodeVideo, Conversion, ConversionCanceledError, Input, MP4, Mp4OutputFormat, Output, QTFF, Quality,
  StreamTarget, type StreamTargetChunk,
} from "mediabunny";
import { mp4Name, planVideo, needsTranscode, type PrepareOptions, type PreparedVideo, type VideoProbe } from "./videoSend";

/**
 * The converter behind `prepareVideo`, loaded only when a video is sent (mediabunny, MPL-2.0). Reads the chosen file
 * a slice at a time (`BlobSource`), copies or re-encodes one sample at a time through WebCodecs, and writes the MP4
 * into `Blob` parts as it goes: the decoded video is never held whole, only the converted file's bytes.
 */

/**
 * The MP4 as it is written: parts in order, a write back into one already written (the `mdat` size, once known)
 * replacing that range. Blob parts may live outside the page's heap (Chromium keeps large ones on disk).
 */
export class BlobParts {
  private parts: { at: number; blob: Blob }[] = [];
  private end = 0;

  write(at: number, data: Uint8Array) {
    const blob = new Blob([data.slice()]);
    const until = at + data.byteLength;
    if (at >= this.end) {
      this.parts.push({ at, blob });
    } else {
      const kept: { at: number; blob: Blob }[] = [];
      for (const part of this.parts) {
        const partEnd = part.at + part.blob.size;
        if (partEnd <= at || part.at >= until) { kept.push(part); continue; }
        if (part.at < at) kept.push({ at: part.at, blob: part.blob.slice(0, at - part.at) });
        if (partEnd > until) kept.push({ at: until, blob: part.blob.slice(until - part.at) });
      }
      kept.push({ at, blob });
      this.parts = kept.sort((a, b) => a.at - b.at);
    }
    this.end = Math.max(this.end, until);
  }

  file(name: string): File {
    return new File(this.parts.map((part) => part.blob), name, { type: "video/mp4" });
  }
}

const abortError = () => new DOMException("The conversion was stopped.", "AbortError");

/** The file to send for a chosen QuickTime or MP4 video (see `prepareVideo`). */
export async function convertVideo(file: File, { onProgress, signal }: PrepareOptions = {}): Promise<PreparedVideo> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF] });
  let conversion: Conversion | undefined;
  const stop = () => { void conversion?.cancel(); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    let probe: VideoProbe;
    let track: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>;
    try {
      const format = await input.getFormat();
      track = await input.getPrimaryVideoTrack();
      probe = {
        container: format.mimeType === "video/quicktime" ? "mov" : format.mimeType === "video/mp4" ? "mp4" : "other",
        video: track?.codec ?? (track ? "unknown" : null),
        width: track?.codedWidth ?? 0,
        height: track?.codedHeight ?? 0,
      };
    } catch (error) {
      // Not a file it reads: a `.mov` may be one the receiver cannot play, an MP4 most likely plays.
      console.warn("[video] could not read", error);
      return /\.(mov|qt)$|quicktime/i.test(`${file.name} ${file.type}`) ? { file, asIs: true } : { file };
    }
    signal?.throwIfAborted();

    const support = needsTranscode(probe) && track
      ? {
        decode: await track.canDecode().catch(() => false),
        encode: await canEncodeVideo("avc", { width: probe.width, height: probe.height }).catch(() => false),
      }
      : undefined;
    const plan = planVideo(probe, support);
    signal?.throwIfAborted();
    if (plan.kind === "keep") return { file };
    if (plan.kind === "asIs") return { file, asIs: true };

    const written = new BlobParts();
    const target = new StreamTarget(new WritableStream<StreamTargetChunk>({ write: (chunk) => written.write(chunk.position, chunk.data) }), { chunked: true, chunkSize: 4 * 1024 * 1024 });
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const audio = await input.getPrimaryAudioTrack();
    conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      // The audio is copied as it is (an iPhone's AAC): Chromium on Linux has no AAC encoder.
      video: plan.kind === "transcode" ? { codec: "avc", quality: new Quality({ bitrate: plan.bitrate }), forceTranscode: true } : {},
      showWarnings: false,
    });
    // A track it would drop (audio it cannot copy nor encode) is a worse video than the original.
    const kept = conversion.utilizedTracks;
    if (!conversion.isValid || (track && !kept.includes(track)) || (audio && !kept.includes(audio))) {
      console.warn("[video] cannot convert", conversion.discardedTracks.map((d) => `${d.track.type} ${d.reason}`));
      return { file, asIs: true };
    }
    if (signal?.aborted) throw abortError();
    if (onProgress) conversion.onProgress = (progress) => onProgress(progress);
    await conversion.execute();
    return { file: written.file(mp4Name(file.name)) };
  } catch (error) {
    if (signal?.aborted || error instanceof ConversionCanceledError) throw abortError();
    // An error midway (a decoder that said yes and then failed, a broken sample): the original goes.
    console.warn("[video] conversion failed", error);
    return { file, asIs: true };
  } finally {
    signal?.removeEventListener("abort", stop);
    input.dispose();
  }
}
