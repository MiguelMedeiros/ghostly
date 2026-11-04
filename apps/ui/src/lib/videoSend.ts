/**
 * A video the receiver may not play is sent as H.264 MP4. An iPhone records HEVC in a `.mov`: Safari and the
 * Linux desktop app play it, Chromium (Android, Linux, Windows) shows a black player or only offers a download.
 * Before such a video goes, it is repackaged (`remux`: H.264 in a `.mov`, no re-encoding) or re-encoded to H.264
 * (`transcode`: HEVC, where this device's WebCodecs can decode it and encode H.264). Where it cannot be, it goes as
 * it is and the sender is told. The converter (`videoConvert`, mediabunny) is loaded only when a video is sent.
 */

/** What the converter found in the file: its container and its video track's codec (mediabunny's names). */
export interface VideoProbe {
  container: "mov" | "mp4" | "other";
  /** `avc` (H.264), `hevc`, `prores`…; null without a video track. */
  video: string | null;
  /** Pixels of the coded picture. */
  width: number;
  height: number;
}

/** Whether this device's WebCodecs can decode the video's codec and encode H.264 at its size. */
export interface VideoSupport {
  decode: boolean;
  encode: boolean;
}

export type VideoPlan =
  /** Plays wherever video plays: sent as it is. */
  | { kind: "keep" }
  /** H.264 in a `.mov`: its samples copied into an MP4. */
  | { kind: "remux" }
  /** Re-encoded to H.264 at this bitrate, the size and frame rate kept, the audio copied. */
  | { kind: "transcode"; bitrate: number }
  /** Needs converting, and this device cannot: sent as it is, and the sender is told. */
  | { kind: "asIs" };

/** About 8 Mbit/s at 1080p, by the picture's area, within 2-20 Mbit/s. */
export function transcodeBitrate(width: number, height: number): number {
  const scaled = (8_000_000 * width * height) / (1920 * 1080);
  return Math.round(Math.min(20_000_000, Math.max(2_000_000, Number.isFinite(scaled) ? scaled : 8_000_000)));
}

/** A video only re-encoding makes playable everywhere: HEVC in any container, anything but H.264 in a `.mov` (ProRes). */
export const needsTranscode = (probe: VideoProbe) =>
  probe.video !== null && probe.video !== "avc" && (probe.video === "hevc" || probe.container === "mov");

/** What to do with a video before it is sent. `support` is only asked for when it needs re-encoding. */
export function planVideo(probe: VideoProbe, support?: VideoSupport): VideoPlan {
  if (probe.video === "avc") return probe.container === "mov" ? { kind: "remux" } : { kind: "keep" };
  if (!needsTranscode(probe)) return { kind: "keep" };
  return support?.decode && support.encode ? { kind: "transcode", bitrate: transcodeBitrate(probe.width, probe.height) } : { kind: "asIs" };
}

const LOOKED_AT = /^video\/(quicktime|mp4|x-m4v)$/;
const LOOKED_AT_NAME = /\.(mov|qt|mp4|m4v)$/i;

/** Whether a file chosen to send is looked into: a QuickTime or MP4 video, by its type or, without one, its name. */
export function isConvertibleVideo(file: File): boolean {
  const type = file.type.split(";")[0]!.trim().toLowerCase();
  return LOOKED_AT.test(type) || (!type && LOOKED_AT_NAME.test(file.name));
}

/** `IMG_0001.MOV` → `IMG_0001.mp4`. */
export const mp4Name = (name: string) => `${name.replace(/\.[^./\\]{1,8}$/, "") || "video"}.mp4`;

export type PreparedVideo =
  /** Converted (`file` is an MP4) or left as it is because it needs nothing (`file` is the one chosen). */
  | { file: File; asIs?: undefined }
  /** It needed converting and this device could not: the chosen file goes, and the sender is told. */
  | { file: File; asIs: true };

export interface PrepareOptions {
  /** 0 to 1, while it converts. */
  onProgress?: (progress: number) => void;
  /** Aborting stops the conversion: `prepareVideo` then rejects with an `AbortError`. */
  signal?: AbortSignal;
}

/**
 * The file to send for a chosen video: an MP4 where it needed converting and could be, else the one chosen
 * (`asIs` where it needed converting and could not: no decoder, no encoder, the converter not loading, an error
 * midway). Rejects only when `signal` aborts it.
 */
export async function prepareVideo(file: File, options: PrepareOptions = {}): Promise<PreparedVideo> {
  if (!isConvertibleVideo(file)) return { file };
  const { signal } = options;
  let convert: typeof import("./videoConvert").convertVideo;
  try {
    ({ convertVideo: convert } = await import("./videoConvert"));
  } catch (error) {
    signal?.throwIfAborted();
    // Without the converter, a `.mov` may be one the receiver cannot play: said. An MP4 most likely plays.
    console.warn("[video] converter did not load", error);
    return /\.(mov|qt)$|quicktime/i.test(`${file.name} ${file.type}`) ? { file, asIs: true } : { file };
  }
  signal?.throwIfAborted();
  return convert(file, options);
}
