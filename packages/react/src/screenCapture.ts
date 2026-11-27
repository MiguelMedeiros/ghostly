import type { CallAudioMix } from "@ghostly/core";

/**
 * What a screen share asks the browser for: the picture, and the sound of what is shared, a tab's, or the whole
 * system's where the browser offers it (`systemAudio`, Chromium on Windows and ChromeOS). `restrictOwnAudio` keeps
 * this app's own playback, the call's voices, out of a system capture, so nobody hears themselves back. A browser
 * that captures no sound (Firefox, Safari, the Linux and macOS Desktop's webviews) gives the picture alone.
 */
export const SCREEN_WITH_SOUND: Readonly<DisplayMediaStreamOptions> = Object.freeze({
  video: true,
  audio: Object.freeze({ restrictOwnAudio: true } as MediaTrackConstraints),
  systemAudio: "include",
} as DisplayMediaStreamOptions);

/** The picture alone, for a browser that refuses to be asked for the sound at all. */
const SCREEN_ONLY: Readonly<DisplayMediaStreamOptions> = Object.freeze({ video: true, audio: false });

/**
 * Opens the browser's screen picker for a share with its sound (`SCREEN_WITH_SOUND`). A browser that will not take
 * the sound's options refuses at once, before any picker (a `TypeError`, `NotSupportedError` or an unmet constraint): it is asked again for
 * the picture alone, so a share never fails for its sound. Every other refusal (the picker closed, the system's
 * privacy setting) is thrown as it came, and the picker is not opened twice.
 */
export async function captureScreen(getDisplayMedia: (options: DisplayMediaStreamOptions) => Promise<MediaStream>): Promise<MediaStream> {
  try {
    return await getDisplayMedia(SCREEN_WITH_SOUND);
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name !== "TypeError" && name !== "NotSupportedError" && name !== "OverconstrainedError") throw error;
    return getDisplayMedia(SCREEN_ONLY);
  }
}

/**
 * The voice and a shared screen's sound as one track, through Web Audio, for a call with one audio section (the 1:1
 * call). A muted voice (`enabled` false) adds silence, so muting the microphone leaves the screen's sound going.
 * Throws where the page has no Web Audio.
 */
export function mixWithWebAudio(voice: MediaStreamTrack, sound: MediaStreamTrack): CallAudioMix {
  const context = new AudioContext();
  // Made after the picker, not in the click: a page without that click's activation may start it suspended.
  void context.resume().catch(() => {});
  const out = context.createMediaStreamDestination();
  const source = (track: MediaStreamTrack) => {
    const node = context.createMediaStreamSource(new MediaStream([track]));
    node.connect(out);
    return node;
  };
  let voiceNode = source(voice);
  const soundNode = source(sound);
  return {
    track: out.stream.getAudioTracks()[0],
    setVoice(next) {
      voiceNode.disconnect();
      voiceNode = source(next);
    },
    close() {
      voiceNode.disconnect();
      soundNode.disconnect();
      out.stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => {});
    },
  };
}
