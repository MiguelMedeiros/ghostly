import { applySpeaker } from "./mediaDevices";

/*
 * How loud each person in a group call plays on this device, by their key: set from their tile, heard by you alone,
 * and kept for the next call with them until the app closes. 1 is as they send it, 0 mutes them for you.
 */

/** The loudest a person can be turned up to: twice as sent. */
export const VOLUME_MAX = 2;

/**
 * Whether someone can play here through a Web Audio gain, on the speaker you chose (`speaker`, undefined: the
 * default): a chosen one needs `AudioContext.setSinkId`, which Firefox and Safari don't have.
 */
export const gainPlays = (speaker?: string): boolean => typeof AudioContext === "function" && typeof MediaStream === "function"
  && (!speaker || typeof (AudioContext.prototype as { setSinkId?: unknown }).setSinkId === "function");

/** The loudest a person can be set to here, on `speaker`: past 1 only through a gain. */
export const volumeMaxOn = (speaker?: string): number => gainPlays(speaker) ? VOLUME_MAX : 1;

/** The Web Audio context everyone plays through on a speaker ("" the default), and how many gains use it. */
const contexts = new Map<string, { context: AudioContext; users: number }>();

/**
 * The context to play someone through a gain on `speaker`, one for everyone there: each context is a sound path of its
 * own (in Chromium ~1% of a core each, 24 people turned up took 6.5 s of CPU every 10 s with one each and 4.5 s with
 * one for all), and one started by a gesture starts them all. `release` gives it back; the last one closes it, unless
 * another gain took it in the same turn (a track replaced, a level moved past 100%). Throws where none can be made.
 */
export function callAudioContext(speaker?: string): { context: AudioContext; release: () => void } {
  const sink = speaker ?? "";
  let shared = contexts.get(sink);
  if (!shared || shared.context.state === "closed") {
    shared = { context: new AudioContext(), users: 0 };
    contexts.set(sink, shared);
    void applySpeaker(shared.context, speaker).catch(() => {});
  }
  const mine = shared;
  mine.users += 1;
  let released = false;
  return {
    context: mine.context,
    release: () => {
      if (released) return;
      released = true;
      mine.users -= 1;
      queueMicrotask(() => {
        if (mine.users > 0 || contexts.get(sink) !== mine) return;
        contexts.delete(sink);
        void mine.context.close().catch(() => {});
      });
    },
  };
}

/** Whether an <audio>'s own volume can be set from script: iOS ignores it, and reads back 1. */
export function elementTakesVolume(): boolean {
  const probe = document.createElement("audio");
  probe.volume = 0.5;
  return probe.volume === 0.5;
}

const volumes = new Map<string, number>();

/** The volume set for `identity`, or 1 when none was. */
export const volumeOf = (identity: string): number => volumes.get(identity) ?? 1;

/** Sets `identity`'s volume, kept between 0 and `VOLUME_MAX`; back at 1, nothing is kept. */
export function setVolumeOf(identity: string, volume: number): void {
  const kept = Number.isFinite(volume) ? Math.min(VOLUME_MAX, Math.max(0, volume)) : 1;
  if (kept === 1) volumes.delete(identity);
  else volumes.set(identity, kept);
}

/** Forgets every volume set; only tests call it. */
export function forgetVolumes(): void {
  volumes.clear();
}
