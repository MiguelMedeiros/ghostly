import { getPrefix } from "./storage";

/**
 * What the voice messages on screen share: only one plays at a time, the next one from
 * the same sender follows on its own, a single speed applies to all of them, and a
 * received one stays marked unplayed until it has been listened to.
 */
interface Player {
  play(): void;
  pause(): void;
}

const players = new Map<string, Player>();
let playing: string | null = null;

/**
 * A player on screen. Unregistering does not end its turn: a player registers again whenever
 * its callbacks change (after its first play, say) and is still the one playing. It hands
 * the turn back itself (`releasePlayback`) when it stops or leaves the screen.
 */
export function registerVoicePlayer(id: string, player: Player): () => void {
  players.set(id, player);
  return () => {
    if (players.get(id) === player) players.delete(id);
  };
}

/** This one starts: whichever was playing stops. */
export function claimPlayback(id: string): void {
  if (playing && playing !== id) players.get(playing)?.pause();
  playing = id;
}

export function releasePlayback(id: string): void {
  if (playing === id) playing = null;
}

/**
 * The message after this one, when it is a voice message from the same sender, starts.
 * "After" is the next row on screen: anything else in between (a text, a payment, a group
 * event) breaks the run, as it does in WhatsApp. Only a line about the connection
 * (`data-voice-passes`) is not part of the conversation, so the run goes on past it.
 * In a group the same sender is the same member (the row's `data-member`), not any other one.
 */
export function playNextVoice(element: HTMLElement | null): boolean {
  const row = element?.closest("[data-message-row]");
  const sender = element?.getAttribute("data-voice-sender");
  if (!row || !sender) return false;
  let next = row.nextElementSibling;
  while (next?.hasAttribute("data-voice-passes")) next = next.nextElementSibling;
  if (!next?.hasAttribute("data-message-row") || next.getAttribute("data-member") !== row.getAttribute("data-member")) return false;
  const player = next.querySelector<HTMLElement>("[data-voice-player]");
  const id = player?.getAttribute("data-voice-player");
  if (!player || !id || player.getAttribute("data-voice-sender") !== sender) return false;
  const target = players.get(id);
  if (!target) return false;
  target.play();
  return true;
}

export const VOICE_RATES = [1, 1.5, 2] as const;
export type VoiceRate = (typeof VOICE_RATES)[number];

const RATE_KEY = "ghostly-voice-rate";
const rateListeners = new Set<(rate: VoiceRate) => void>();

export function voiceRate(): VoiceRate {
  try {
    const stored = Number(localStorage.getItem(RATE_KEY));
    return (VOICE_RATES as readonly number[]).includes(stored) ? (stored as VoiceRate) : 1;
  } catch {
    return 1;
  }
}

/** 1× → 1.5× → 2× → 1×, for every voice message at once, and remembered on this device for the next one. */
export function nextVoiceRate(): VoiceRate {
  const rate = VOICE_RATES[(VOICE_RATES.indexOf(voiceRate()) + 1) % VOICE_RATES.length]!;
  try { localStorage.setItem(RATE_KEY, String(rate)); } catch { /* the speed just is not remembered */ }
  for (const listener of rateListeners) listener(rate);
  return rate;
}

export function onVoiceRate(listener: (rate: VoiceRate) => void): () => void {
  rateListeners.add(listener);
  return () => rateListeners.delete(listener);
}

/**
 * Plays `audio` at `rate` with the voice at its own pitch, not a chipmunk's. The default rate is set too:
 * loading another source (the decoded WAV fallback) puts `playbackRate` back to it. WebKit before
 * `preservesPitch` knew only the prefixed name; an engine with neither just plays faster.
 */
export function applyVoiceRate(audio: HTMLMediaElement, rate: number): void {
  const media = audio as HTMLMediaElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean };
  media.preservesPitch = true;
  media.webkitPreservesPitch = true;
  media.defaultPlaybackRate = rate;
  media.playbackRate = rate;
}

/** The speed as the pill shows it, in `locale`'s decimals ("1.5×" in English, "1,5×" in Portuguese) and the digits the clock uses. */
export function formatVoiceRate(rate: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2, numberingSystem: "latn" }).format(rate)}×`;
}

/** Played marks are this profile's own: newest last, the oldest forgotten past this many. */
const MAX_PLAYED = 2000;
const playedKey = () => `${getPrefix()}voice_played`;

function playedIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(playedKey()) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function isVoicePlayed(fileId: string): boolean {
  return playedIds().includes(fileId);
}

export function markVoicePlayed(fileId: string): void {
  const ids = playedIds();
  if (ids.includes(fileId)) return;
  ids.push(fileId);
  try { localStorage.setItem(playedKey(), JSON.stringify(ids.slice(-MAX_PLAYED))); } catch { /* shown as played until the page reloads */ }
}
