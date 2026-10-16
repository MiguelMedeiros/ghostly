import { createContext, useContext, useSyncExternalStore } from "react";
import { claimMediaSession, mediaSessionPosition, mediaSessionState, releaseMediaSession } from "./mediaSession";
import { applyVoiceRate, claimPlayback, onVoiceRate, pausePlaying, registerVoicePlayer, releasePlayback } from "./voicePlayback";

/*
 * The app's one player for what plays on away from its bubble. A voice message or an audio file plays in its bubble;
 * when the bubble leaves the screen while it plays (another chat, another page, the chat list), its element is handed
 * here and plays on, with the now-playing bar (NowPlayingBar). Back in its chat, the bubble takes it back as it is.
 * Each message also keeps where it stopped, for this session: paused or left part-way, it starts again from there.
 */

/** The chat a bubble is in: what the bar names, and where its tap goes. */
export interface PlayingChat {
  path: string;
  name: string;
  /** A chat with one contact: what they send is named as the chat names them, once. */
  contact?: boolean;
}

/** Who sent it, for the bar: "You", the contact as their chat names them, or the member. */
export const playingFrom = (mine: boolean, you: string, sender: string, chat: PlayingChat | undefined) =>
  mine ? you : chat?.contact ? chat.name : sender;
export const NowPlayingChat = createContext<PlayingChat | undefined>(undefined);
export const usePlayingChat = () => useContext(NowPlayingChat);

export interface Track {
  /** The file. */
  id: string;
  kind: "voice" | "audio";
  /** "Voice message", or the audio file's name. */
  title: string;
  /** Who sent it, as the bubble names them ("You", the contact, the member). */
  from: string;
  chat?: PlayingChat;
  messageId?: string;
  /** Seconds; 0 while the element has not said. */
  duration: number;
}

/** What a bubble hands over: the element playing, and how to let go of what it plays from (URLs, a stream, the speaker it follows). */
export interface Handed extends Track {
  audio: HTMLAudioElement;
  release(): void;
}

export interface NowPlaying extends Track {
  playing: boolean;
  /** Seconds. */
  position: number;
}

let held: { handed: Handed; dispose(): void } | null = null;
let shown: NowPlaying | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

const positions = new Map<string, { at: number; duration: number }>();

/** Where `id` stopped, kept for this session; one at its end, or at the start, keeps nothing. */
export function rememberPosition(id: string, at: number, duration: number): void {
  if (at > 0.05 && (!(duration > 0) || at < duration - 0.05)) positions.set(id, { at, duration });
  else positions.delete(id);
}

export const rememberedPosition = (id: string): { at: number; duration: number } | undefined => positions.get(id);

/** Played to its end: it starts from the beginning next time. */
export function forgetPosition(id: string): void {
  positions.delete(id);
}

const durationOf = (handed: Handed) =>
  handed.duration > 0 ? handed.duration : Number.isFinite(handed.audio.duration) ? handed.audio.duration : 0;

/** Lets go of the one held, as it is: playing or not, it is gone from here. */
function end(): void {
  if (!held) return;
  const { handed, dispose } = held;
  held = null;
  shown = null;
  dispose();
  handed.release();
  releasePlayback(handed.id);
  releaseMediaSession(handed.id);
  emit();
}

/**
 * A bubble leaving the screen while `handed.audio` plays: it plays on from here, with the bar. Only one at a time: one
 * held before is stopped. The system's media controls now drive this one.
 */
export function holdPlayback(handed: Handed): void {
  if (held) stopHeld();
  const { audio, id } = handed;
  const listening = new AbortController();
  const { signal } = listening;
  const track: Track = { id, kind: handed.kind, title: handed.title, from: handed.from, chat: handed.chat, messageId: handed.messageId, duration: handed.duration };
  const show = () => {
    shown = { ...track, duration: durationOf(handed), playing: !audio.paused && !audio.ended, position: audio.currentTime };
    emit();
  };
  audio.addEventListener("timeupdate", () => { mediaSessionPosition(id, audio.currentTime, durationOf(handed), audio.playbackRate); show(); }, { signal });
  audio.addEventListener("play", () => { mediaSessionState(id, "playing"); show(); }, { signal });
  audio.addEventListener("pause", () => { mediaSessionState(id, "paused"); show(); }, { signal });
  audio.addEventListener("ended", () => { forgetPosition(id); end(); }, { signal });
  audio.addEventListener("error", () => end(), { signal });
  const stopRate = onVoiceRate((rate) => applyVoiceRate(audio, rate));
  // Another voice message, audio file or video starting stops this one (lib/voicePlayback.ts).
  const unregister = registerVoicePlayer(id, { play: resumeHeld, pause: stopHeld });
  claimPlayback(id);
  held = { handed, dispose: () => { listening.abort(); stopRate(); unregister(); } };
  claimMediaSession(id, {
    title: handed.title,
    artist: handed.from,
    play: resumeHeld,
    pause: pauseHeld,
    seekTo: (at) => { audio.currentTime = Math.max(0, Math.min(durationOf(handed) || at, at)); },
  });
  mediaSessionPosition(id, audio.currentTime, durationOf(handed), audio.playbackRate);
  show();
}

/** The bubble of `id` is back on screen: it takes its element back, playing or paused as it is, and the bar goes. */
export function takePlayback(id: string): Handed | null {
  if (held?.handed.id !== id) return null;
  const { handed, dispose } = held;
  held = null;
  shown = null;
  dispose();
  emit();
  return handed;
}

export function pauseHeld(): void {
  held?.handed.audio.pause();
}

export function resumeHeld(): void {
  if (!held) return;
  const { audio, id } = held.handed;
  claimPlayback(id);
  audio.play().catch(() => {});
}

/** The bar's close, or another one starting: it stops, and starts from here next time. */
export function stopHeld(): void {
  if (!held) return;
  const { audio, id } = held.handed;
  audio.pause();
  rememberPosition(id, audio.currentTime, durationOf(held.handed));
  end();
}

/** A call starts: whatever plays pauses, held here or in its bubble. */
export function pauseForCall(): void {
  if (held) pauseHeld();
  else pausePlaying();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** What plays away from its bubble, for the bar: null when nothing does. */
export const useNowPlaying = (): NowPlaying | null => useSyncExternalStore(subscribe, () => shown);

/** Forgets everything (tests). */
export function resetNowPlaying(): void {
  end();
  positions.clear();
}
