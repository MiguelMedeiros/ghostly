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
