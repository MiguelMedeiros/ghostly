/**
 * How loud each side of a call is, for a call whose sound the page cannot hear: Ghostly Desktop on Linux keeps it
 * in Rust, which reads the levels there (desktop/nativeCalls.ts). A `LevelSource` gives `heard` the level, 0 to 1
 * as `voiceLevel` gives it, now and at each change; what it returns stops it.
 */
export type LevelSource = (heard: (level: number) => void) => () => void;

/** The two sides of the call a microphone's track is sent on: that microphone, and the peer's sound. */
export interface CallLevels { own: LevelSource; peer: LevelSource }

const levels = new WeakMap<MediaStreamTrack, CallLevels>();

/** Says where the levels of the call `track` is sent on are read. */
export function setCallLevels(track: MediaStreamTrack, of: CallLevels): void {
  levels.set(track, of);
}

/** Where the levels of the call `stream` (ours) is sent on are read, when the page cannot measure them itself. */
export function callLevels(stream: MediaStream | null): CallLevels | undefined {
  for (const track of stream?.getAudioTracks() ?? []) {
    const of = levels.get(track);
    if (of) return of;
  }
  return undefined;
}
